# ssh-mcp audit log

Append-only **JSON Lines** trail of every tool call the server handles. Intended
for post-incident review and routine ops accountability — not for shipping to
the model.

## Enable

In the JSON config:

```json
{
  "auditLogPath": "~/.local/state/ssh-mcp/audit.jsonl"
}
```

- **Absent or empty** → audit off (no files written).
- `setup-vps.sh` enables it by default at  
  `$HOME/.local/state/ssh-mcp/audit.jsonl`  
  (override with `SSH_MCP_AUDIT_LOG=/path`).
- Parent directories are created with mode `0700`; the log file with `0600` on first write.
- On startup the server prints: `[ssh-mcp] audit log: <resolved path>` on stderr.

## What is logged

One JSON object per line, fields only when relevant:

| Field | Meaning |
|-------|---------|
| `ts` | ISO-8601 UTC timestamp |
| `tool` | `ssh_execute` \| `ssh_upload` \| `ssh_download` \| `ssh_list_connections` |
| `connection` | **Name** only (never host / user / key path) |
| `gateAllowed` | Whether the allow/deny (or transfer) gate passed |
| `gateReason` | Short policy message when blocked |
| `command` | Remote command string (`ssh_execute`) |
| `localPath` / `remotePath` | Transfer paths |
| `exitCode` / `signal` / `timedOut` | Exec outcome |
| `ok` | Transfer success flag |
| `durationMs` | Wall time for the tool handler |
| `error` | Non-secret failure message (e.g. connection error) |

## What is never logged

- Passwords, private keys, passphrases, key paths  
- Hostnames, IPs, ports, usernames  
- Command **stdout / stderr** (may contain secrets from logs or env dumps)  
- Full config blobs  

Operators should still treat the log as sensitive: **command strings and remote
paths can themselves be confidential** (e.g. `cat /var/log/app` is benign;
custom allow entries might not be). Restrict filesystem ACLs accordingly.

## Example lines

```json
{"ts":"2026-07-12T21:00:00.000Z","tool":"ssh_execute","connection":"prod","gateAllowed":true,"command":"uptime","exitCode":0,"timedOut":false,"durationMs":180}
{"ts":"2026-07-12T21:00:01.000Z","tool":"ssh_execute","connection":"prod","gateAllowed":false,"gateReason":"Command blocked: shell metacharacters…","command":"uptime && rm -rf /","durationMs":1}
{"ts":"2026-07-12T21:00:02.000Z","tool":"ssh_download","connection":"prod","gateAllowed":true,"localPath":"/home/you/agent-transfers/prod/app.log","remotePath":"/var/log/app.log","ok":true,"durationMs":40}
```

## Inspection

```bash
# last 20 events
tail -n 20 ~/.local/state/ssh-mcp/audit.jsonl

# only denials
grep '"gateAllowed":false' ~/.local/state/ssh-mcp/audit.jsonl

# pretty-print one line
tail -n 1 ~/.local/state/ssh-mcp/audit.jsonl | jq .
```

## Rotation (logrotate)

Example `/etc/logrotate.d/ssh-mcp` (adjust user/path):

```
/home/YOU/.local/state/ssh-mcp/audit.jsonl {
    weekly
    rotate 12
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    create 0600 YOU YOU
}
```

`copytruncate` avoids needing a signal to the MCP process (stdio servers are
often restarted with each Claude session anyway). For a long-lived process,
`copytruncate` is the simplest option; alternatively use `postrotate` only if
you add a reopen signal later.

macOS without logrotate: a weekly `launchd` job that renames the file is enough:

```bash
# e.g. in crontab
0 3 * * 0 mv -f "$HOME/.local/state/ssh-mcp/audit.jsonl" \
  "$HOME/.local/state/ssh-mcp/audit-$(date +\%Y\%m\%d).jsonl" 2>/dev/null || true
```

New events recreate `audit.jsonl` automatically.
