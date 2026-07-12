# ssh-mcp-server

An MCP server that lets an LLM agent run commands and move files on remote hosts
over SSH. Credentials live in a config file on the machine running the server —
they are never exposed to the model. Commands and transfers are screened against
allow/deny rules **before** anything connects.

## Tools

| Tool | What it does | Destructive |
|------|--------------|-------------|
| `ssh_list_connections` | List configured connection **names** and flags (no host/key leak) | no |
| `ssh_execute` | Run a shell command; returns stdout/stderr/exit code | gated |
| `ssh_upload` | Send a local file to the host via SFTP | **off by default** |
| `ssh_download` | Pull a remote file to the local machine via SFTP | **off by default** |

## Install

```bash
npm install
npm run build
npm test          # unit tests for the security gate
```

## Configure

Create a JSON config (see `ssh-config.example.json`), or generate one:

```bash
bash setup-vps.sh <ssh-alias>           # readonly (default)
bash setup-vps.sh <ssh-alias> ops       # template mutations — edit paths first
```

The setup script writes `~/.config/ssh-mcp/<alias>.json` (`chmod 600`), pins the
host key fingerprint when `ssh-keyscan` works, enables **download only** under
`/var/log/` into `~/agent-transfers/<alias>/`, and leaves **upload disabled**.

Minimal example:

```json
{
  "defaultConnection": "prod",
  "defaultTimeoutMs": 30000,
  "includeBuiltinDeny": true,
  "allow": ["^ls ", "^df -h$", "^uptime$", "^systemctl status "],
  "deny": ["shutdown", "reboot", "mkfs"],
  "transfers": {
    "uploadEnabled": false,
    "downloadEnabled": true,
    "remoteAllow": ["^/var/log/"],
    "localRoot": "/home/you/agent-transfers/prod"
  },
  "connections": {
    "prod": {
      "host": "10.0.0.5",
      "port": 22,
      "username": "deploy",
      "privateKeyPath": "/home/you/.ssh/id_ed25519",
      "hostFingerprint": "SHA256:…",
      "strictHostKeyChecking": true
    }
  }
}
```

### Command policy

- `allow` / `deny` are **regular expressions** matched against the raw command.
- **Deny always wins**, and is the **union** of: global `deny` + per-connection
  `deny` + built-in catastrophic patterns (unless `includeBuiltinDeny: false`).
- If an `allow` list is non-empty, the command must match at least one entry.
- **Shell metacharacters** (`; | & \` $ ( ) < >` and newlines) are **rejected**
  whenever an allow list is active — so `uptime && rm -rf /` cannot sneak past
  `^uptime`.
- Invalid deny regexes **fail closed** (block the command).
- Empty allow list means “anything not denied” — the server warns at startup.

### Transfer policy

- Both upload and download are **disabled** unless
  `transfers.uploadEnabled` / `transfers.downloadEnabled` is `true`.
- `remoteAllow` / `remoteDeny` gate remote paths; `..` is always rejected.
- `localRoot` jails local paths (recommended).

### Host keys

Set `hostFingerprint` (from `ssh-keyscan host | ssh-keygen -lf -`) and
`strictHostKeyChecking: true` to refuse MITM. Without a fingerprint the server
warns and (unless strict is forced) connects like classic ssh2.

## Wire it to a client

Claude Code:

```bash
claude mcp add -s user --transport stdio ssh-mcp -- \
  node /absolute/path/to/ssh-mcp-server/dist/index.js \
  --config /absolute/path/to/ssh-config.json
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

## Debug

```bash
npx @modelcontextprotocol/inspector node dist/index.js --config ./ssh-config.json
```

### Audit log

Set `auditLogPath` to an append-only JSONL file (setup enables
`~/.local/state/ssh-mcp/audit.jsonl` by default). Each tool call records
timestamp, connection **name**, gate decision, command or paths, exit code /
duration — never passwords, keys, host addresses, or stdout/stderr.

Details and logrotate snippet: [`../docs/audit-log.md`](../docs/audit-log.md).

## Security notes

- The agent operates at the SSH user's privilege level. Use a **least-privilege
  account** per environment, not root.
- Allow/deny rules are a **guardrail**, not a full sandbox. Keep allow lists
  tight; do not rely on deny alone.
- Keep the config file readable only by the user running the server
  (`chmod 600`). Prefer key auth over inline passwords.
- Treat the audit log as sensitive (command strings / paths). Mode `0600`.
- There is no built-in rate limiting. Run it on a trusted machine.
- See `../docs/PR-PLAN.md` for the hardening roadmap (CI, packaging, …).

## Extending

Natural next steps, each isolated to one module:

- **Interactive sessions**: tmux/shell-channel tool (current exec is request/response).
- **Reverse-tunnel mode**: for NATed/outbound-only hosts.
