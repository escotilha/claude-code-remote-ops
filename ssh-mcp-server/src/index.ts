#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, type Config, type Connection } from "./config.js";
import { checkCommand } from "./security.js";
import { SshPool } from "./ssh.js";

const CHARACTER_LIMIT = 30_000;

function getConfigPath(): string {
  const argIdx = process.argv.indexOf("--config");
  if (argIdx !== -1 && process.argv[argIdx + 1]) return process.argv[argIdx + 1];
  if (process.env.SSH_MCP_CONFIG) return process.env.SSH_MCP_CONFIG;
  throw new Error(
    "No config provided. Use --config <path> or set SSH_MCP_CONFIG."
  );
}

function resolveConnection(
  config: Config,
  name: string | undefined
): { name: string; conn: Connection } {
  const key = name ?? config.defaultConnection;
  if (!key) {
    throw new Error(
      `No connection specified and no defaultConnection set. Known: ${Object.keys(
        config.connections
      ).join(", ")}`
    );
  }
  const conn = config.connections[key];
  if (!conn) {
    throw new Error(
      `Unknown connection '${key}'. Known: ${Object.keys(config.connections).join(", ")}`
    );
  }
  return { name: key, conn };
}

function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n...[truncated ${text.length - CHARACTER_LIMIT} chars]`
  );
}

async function main(): Promise<void> {
  const config = loadConfig(getConfigPath());
  const pool = new SshPool();

  // Warn (on stderr, not stdout, so we don't corrupt the stdio protocol) when a
  // connection has no allow list and no global allow list.
  if (config.allow.length === 0) {
    for (const [name, conn] of Object.entries(config.connections)) {
      if (!conn.allow || conn.allow.length === 0) {
        console.error(
          `[ssh-mcp] WARNING: connection '${name}' has no allow list; any non-denied command can run.`
        );
      }
    }
  }

  const server = new McpServer({
    name: "ssh-mcp-server",
    version: "1.0.0",
  });

  server.registerTool(
    "ssh_list_connections",
    {
      title: "List SSH Connections",
      description:
        "List the named SSH connections defined in the server config. Returns each connection's name, host, port, username, auth method, and whether an allow list is set. Does not connect to anything.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const list = Object.entries(config.connections).map(([name, c]) => ({
        name,
        host: c.host,
        port: c.port,
        username: c.username,
        auth: c.privateKeyPath ? "key" : "password",
        hasAllowList: (c.allow ?? config.allow).length > 0,
        isDefault: name === config.defaultConnection,
      }));
      const output = { count: list.length, connections: list };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );

  server.registerTool(
    "ssh_execute",
    {
      title: "Execute Remote Command",
      description: `Run a shell command on a remote host over SSH and return stdout, stderr, and the exit code.

The command is checked against the connection's allow/deny rules before running. If it violates a rule the tool returns an error and does NOT connect.

Args:
  - command (string): The shell command to run on the remote host.
  - connection (string, optional): Name of the configured connection. Falls back to the server's default connection.
  - timeout_ms (number, optional): Max time to wait before aborting the command.

Returns JSON:
  { "stdout": string, "stderr": string, "code": number|null, "signal": string|null, "timedOut": boolean }

Notes:
  - A null exit code with timedOut=true means the command was aborted.
  - This runs at the SSH user's privilege level. Prefer least-privilege accounts.`,
      inputSchema: {
        command: z.string().min(1).describe("Shell command to run remotely"),
        connection: z
          .string()
          .optional()
          .describe("Named connection; defaults to server default"),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Command timeout in ms"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ command, connection, timeout_ms }) => {
      try {
        const { name, conn } = resolveConnection(config, connection);
        const gate = checkCommand(command, config, conn);
        if (!gate.allowed) {
          return { content: [{ type: "text", text: `Error: ${gate.reason}` }] };
        }
        const timeout =
          timeout_ms ?? conn.timeoutMs ?? config.defaultTimeoutMs;
        const result = await pool.exec(name, conn, command, timeout);
        const output = { ...result, stdout: truncate(result.stdout), stderr: truncate(result.stderr) };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
        };
      }
    }
  );

  const transferInput = {
    connection: z
      .string()
      .optional()
      .describe("Named connection; defaults to server default"),
    local_path: z.string().min(1).describe("Absolute path on the local machine"),
    remote_path: z.string().min(1).describe("Absolute path on the remote host"),
  };

  server.registerTool(
    "ssh_upload",
    {
      title: "Upload File via SFTP",
      description:
        "Upload a local file to the remote host over SFTP. Args: local_path (source on this machine), remote_path (destination on the server), connection (optional). Overwrites the remote file if it exists.",
      inputSchema: transferInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ connection, local_path, remote_path }) => {
      try {
        const { name, conn } = resolveConnection(config, connection);
        await pool.transfer(name, conn, "upload", local_path, remote_path);
        const output = { ok: true, local_path, remote_path };
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
        };
      }
    }
  );

  server.registerTool(
    "ssh_download",
    {
      title: "Download File via SFTP",
      description:
        "Download a file from the remote host to the local machine over SFTP. Args: remote_path (source on the server), local_path (destination on this machine), connection (optional).",
      inputSchema: transferInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ connection, local_path, remote_path }) => {
      try {
        const { name, conn } = resolveConnection(config, connection);
        await pool.transfer(name, conn, "download", local_path, remote_path);
        const output = { ok: true, remote_path, local_path };
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
        };
      }
    }
  );

  const cleanup = () => {
    pool.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[ssh-mcp] server ready on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
