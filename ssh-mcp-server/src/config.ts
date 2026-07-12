import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * SFTP transfer policy. Defaults are fail-closed: both directions off until
 * explicitly enabled. When enabled, prefer remoteAllow + localRoot.
 */
export const TransfersSchema = z
  .object({
    uploadEnabled: z
      .boolean()
      .optional()
      .describe("Allow ssh_upload (default false)"),
    downloadEnabled: z
      .boolean()
      .optional()
      .describe("Allow ssh_download (default false)"),
    remoteAllow: z
      .array(z.string())
      .optional()
      .describe("Regexes; remote path must match one if non-empty"),
    remoteDeny: z
      .array(z.string())
      .optional()
      .describe("Regexes; remote path matching any is blocked"),
    localRoot: z
      .string()
      .optional()
      .describe(
        "If set, local_path must resolve under this directory (jail)"
      ),
  })
  .strict();

/**
 * A single named SSH target. Auth is either a password or a private key path.
 * Per-connection allow lists override the global ones when present.
 * Deny lists always merge (global ∪ connection ∪ built-ins).
 */
export const ConnectionSchema = z
  .object({
    host: z.string().min(1).describe("Hostname or IP of the remote server"),
    port: z.number().int().min(1).max(65535).default(22),
    username: z.string().min(1).describe("SSH username"),
    password: z.string().optional().describe("Password auth (prefer a key)"),
    privateKeyPath: z
      .string()
      .optional()
      .describe("Path to a private key file for key-based auth"),
    passphrase: z
      .string()
      .optional()
      .describe("Passphrase for the private key, if encrypted"),
    /** SHA256 host key fingerprint, e.g. "SHA256:abcd..." from ssh-keygen -lf */
    hostFingerprint: z
      .string()
      .optional()
      .describe("Expected SSH host key fingerprint (SHA256:...)"),
    /** If true (default when hostFingerprint set), refuse connect on mismatch */
    strictHostKeyChecking: z.boolean().optional(),
    // Regex strings. A command must match at least one allow entry (if any are
    // defined) and must match no deny entry.
    allow: z.array(z.string()).optional().describe("Allowlist regexes"),
    deny: z.array(z.string()).optional().describe("Extra denylist regexes (merged with global)"),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Per-command timeout override"),
    transfers: TransfersSchema.optional().describe(
      "Per-connection SFTP policy (overrides global transfers)"
    ),
  })
  .strict()
  .refine((c) => c.password || c.privateKeyPath, {
    message: "Each connection needs either 'password' or 'privateKeyPath'",
  });

export const ConfigSchema = z
  .object({
    defaultConnection: z.string().optional(),
    defaultTimeoutMs: z.number().int().positive().default(30_000),
    // Global lists applied when a connection doesn't define its own allow.
    allow: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    /** Merge built-in catastrophic deny patterns (default true). */
    includeBuiltinDeny: z.boolean().default(true),
    /**
     * Append-only JSONL audit path. Empty/absent = audit off.
     * Example: "~/.local/state/ssh-mcp/audit.jsonl"
     * Never logs passwords, keys, host addresses, or command stdout/stderr.
     */
    auditLogPath: z
      .string()
      .optional()
      .describe("Path for append-only JSONL audit log (omit to disable)"),
    transfers: TransfersSchema.optional(),
    connections: z.record(z.string(), ConnectionSchema),
  })
  .strict();

export type TransfersConfig = z.infer<typeof TransfersSchema>;
export type Connection = z.infer<typeof ConnectionSchema>;
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Load and validate config from a JSON file. Throws a readable error if the
 * file is missing or malformed so the agent gets an actionable message.
 */
export function loadConfig(path: string): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `Could not read config file at '${path}'. Pass --config <path> or set SSH_MCP_CONFIG.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Config at '${path}' is not valid JSON: ${(e as Error).message}`
    );
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Config validation failed:\n${result.error.issues
        .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n")}`
    );
  }
  return result.data;
}
