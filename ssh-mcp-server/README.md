# ssh-mcp-server

An MCP server that lets an LLM agent run commands and move files on remote hosts
over SSH. Credentials live in a config file on the machine running the server —
they are never exposed to the model. Commands are screened against allow/deny
rules before anything connects.

## Tools

| Tool | What it does | Destructive |
|------|--------------|-------------|
| `ssh_list_connections` | List configured connections (no connect) | no |
| `ssh_execute` | Run a shell command; returns stdout/stderr/exit code | yes |
| `ssh_upload` | Send a local file to the host via SFTP | yes |
| `ssh_download` | Pull a remote file to the local machine via SFTP | no |

## Install

```bash
npm install
npm run build
```

## Configure

Create a JSON config (e.g. `ssh-config.json`):

```json
{
  "defaultConnection": "prod",
  "defaultTimeoutMs": 30000,
  "allow": ["^ls", "^df", "^cat ", "^systemctl status", "^docker ps"],
  "deny": ["rm -rf", "shutdown", "reboot", "mkfs", "dd if="],
  "connections": {
    "prod": {
      "host": "10.0.0.5",
      "port": 22,
      "username": "deploy",
      "privateKeyPath": "/home/you/.ssh/id_ed25519"
    },
    "staging": {
      "host": "staging.internal",
      "username": "deploy",
      "password": "…",
      "allow": ["^"],
      "timeoutMs": 60000
    }
  }
}
```

- `allow` / `deny` are arrays of **regular expressions** matched against the raw
  command string. A command must match no `deny` rule, and — if an `allow` list
  exists — at least one `allow` rule.
- Per-connection `allow`/`deny`/`timeoutMs` override the global values.
- An empty/absent allow list means "anything not denied" — the server prints a
  warning at startup when that's the case.
- Auth is `privateKeyPath` (preferred, with optional `passphrase`) or `password`.

## Wire it to a client

Claude Code:

```bash
claude mcp add --transport stdio ssh-mcp -- \
  node /absolute/path/to/ssh-mcp-server/dist/index.js --config /absolute/path/to/ssh-config.json
```

Claude Desktop / Cursor (`mcpServers` block):

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": [
        "/absolute/path/to/ssh-mcp-server/dist/index.js",
        "--config",
        "/absolute/path/to/ssh-config.json"
      ]
    }
  }
}
```

The config path can also come from the `SSH_MCP_CONFIG` env var instead of
`--config`.

Any MCP-capable client works — the server speaks plain stdio MCP, so a custom
agent loop (e.g. driving a different model) points its MCP client at the same
command.

## Debug

```bash
npx @modelcontextprotocol/inspector node dist/index.js --config ./ssh-config.json
```

## Security notes

- The agent operates at the SSH user's privilege level. Use a **least-privilege
  account** per environment, not root.
- Allow/deny rules are a guardrail, not a sandbox. Treat the allow list as the
  real boundary; keep it as tight as the tasks allow.
- Keep the config file readable only by the user running the server
  (`chmod 600`). Prefer key auth over inline passwords.
- There is no built-in rate limiting. Run it on a trusted machine.

## Extending

Natural next steps, each isolated to one module:

- **Interactive sessions**: add a tmux/shell-channel tool in `ssh.ts` for
  long-running or interactive processes (the current exec is request/response).
- **Reverse-tunnel mode**: for NATed/outbound-only hosts, have the remote dial
  back and connect through the exposed local port.
- **Audit log**: append every `ssh_execute` (connection, command, exit code) to
  a file for a reviewable trail.
