# ssh-mcp-server — what it does

An MCP (Model Context Protocol) server that gives an AI agent **guard-railed hands on
remote machines over SSH**. The agent gets four tools; the server owns the credentials
and screens every command **and transfer** before anything touches the wire.

## The four tools

| Tool | What it does | Risk class |
|------|--------------|------------|
| `ssh_list_connections` | List connection **names** and flags (no host/key) | read-only |
| `ssh_execute` | Run a shell command; returns stdout / stderr / exit code | gated by allow/deny + shell-meta rules |
| `ssh_upload` | Push a local file via SFTP | **disabled unless opted in** + path rules |
| `ssh_download` | Pull a remote file via SFTP | **disabled unless opted in** + path rules |

## The security model (the actual point of it)

1. **Credentials never reach the model.** Host, user, port, private-key path, and
   host fingerprint live in a JSON config on the machine *running* the server
   (`chmod 600`, outside any git repo). `ssh_list_connections` returns names and
   capability flags only — nothing to leak into a transcript.

2. **Every command is screened before connecting.**
   - `deny` — always wins. Config deny ∪ connection deny ∪ **built-in** catastrophic
     patterns (`rm -r/-f`, `dd`, `mkfs`, shutdown, firewall teardown, killing SSH, …).
     Malformed deny regexes **fail closed**.
   - `allow` — if present, a command must match at least one entry. Absent/empty
     means "anything not denied" (startup warning).
   - **Shell metacharacters** (`;|&$\`()<>` / newlines) are rejected when an allow
     list is active, so composition cannot stretch `^uptime` into a destructive chain.

3. **SFTP is fail-closed.** Upload/download require explicit
   `transfers.*Enabled`, optional `remoteAllow`/`remoteDeny`, and preferably a
   `localRoot` jail. The setup **readonly** profile enables download of `/var/log/*`
   only and leaves upload off.

4. **Host key pinning.** `hostFingerprint` + `strictHostKeyChecking` refuse MITM.
   `setup-vps.sh` captures a fingerprint via `ssh-keyscan` when it can.

5. **Profiles make intent explicit.** `readonly` vs `ops` (template) is chosen when
   you wire the server — not mid-session by the model.

6. **Timeouts on everything** (default 30s) — a hung remote command can't wedge the agent.

7. **Optional audit log** — append-only JSONL (`auditLogPath`) records gate decisions,
   commands/paths, and exit codes without keys, hosts, or stdout. See
   [audit-log.md](./audit-log.md).

## How to wire it

```
Claude Code (or any MCP client)
   └── stdio → node dist/index.js --config ~/.config/ssh-mcp/<alias>.json
                  └── SSH (key) → user@host
```

```bash
cd ssh-mcp-server
npm install && npm test
bash setup-vps.sh <ssh-alias>          # readonly
# claude mcp add … (printed by the script)
```

Widen later: `bash setup-vps.sh <alias> ops`, then **edit** service names and paths
in the generated config so they match your host (the public ops profile is a template).

## Why this beats "just give the agent a terminal with ssh"

A raw `ssh` in a shell tool means the agent's *entire* command string runs remotely,
policy enforced only by hope. Here the policy is structural: deny/allow and transfer
rules run in a process the agent cannot edit, credentials stay outside the agent's
reach, and the read-only default means a confused session can inspect logs but cannot
upload binaries or chain `uptime && destroy`. Widening access is a deliberate,
human-initiated config change.

## Verify the gate

```bash
cd ssh-mcp-server && npm test
```

Roadmap (audit log, CI, packaging): see [PR-PLAN.md](./PR-PLAN.md).
