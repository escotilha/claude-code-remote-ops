# ssh-mcp-server — what it does

An MCP (Model Context Protocol) server that gives an AI agent **guard-railed hands on
remote machines over SSH**. The agent gets four tools; the server owns the credentials
and screens every command before anything touches the wire.

## The four tools

| Tool | What it does | Risk class |
|------|--------------|------------|
| `ssh_list_connections` | List configured hosts (no connection made) | read-only |
| `ssh_execute` | Run a shell command; returns stdout / stderr / exit code | gated by allow/deny |
| `ssh_upload` | Push a local file to the host via SFTP | write |
| `ssh_download` | Pull a remote file to the local machine via SFTP | read |

## The security model (the actual point of it)

1. **Credentials never reach the model.** Host, user, port, and private-key path live
   in a JSON config on the machine *running* the server (`chmod 600`, outside any git
   repo). The agent only ever names a connection ("vps-root"); it never sees or
   handles the key. Nothing to leak into a transcript.

2. **Every command is screened before connecting.** Two regex lists:
   - `deny` — always wins, non-negotiable. Ships with the catastrophic classes:
     `rm -rf`, `shutdown`/`reboot`/`poweroff`, `mkfs`, `dd if=`, firewall teardown
     (`ufw reset|disable`), killing SSH itself (`systemctl stop|disable|mask ssh`),
     recursive `chmod`/`chown`, writes into `/etc`.
   - `allow` — if present, a command must match at least one entry. Absent/empty
     means "anything not denied" (the server warns loudly at startup in that mode).
   - Both are overridable per connection; a global default applies otherwise.

3. **Profiles make intent explicit.** The setup script generates either a
   **readonly** profile (status, logs, disk, uptime, service health — diagnosis
   without side effects) or an **ops** profile (deploy/restart verbs added). You
   choose the blast radius when you wire it, not in the heat of a session.

4. **Timeouts on everything** (default 30s, per-connection override) — a hung remote
   command can't wedge the agent.

## How it's wired here (this deployment)

```
Claude Code session (Mac Mini)
   └── stdio → node dist/index.js --config ~/.config/ssh-mcp/vps-root.json
                  └── SSH (ed25519 key) over Tailscale → root@<tailscale-ip>
                                                          (VPS "<vps-hostname>")
```

- Registered at **user scope** (`claude mcp add -s user`), so the tools load in every
  Claude Code session on the Mini automatically — including sessions spawned from a
  phone via the remote-control server.
- Current profile: **readonly**. Allow-list: `systemctl status/is-active`,
  `journalctl`, `tail`/`cat` of `/var/log`, `ls`, `df -h`, `free -m`, `uptime`,
  `tailscale status`, `ufw status`, `docker ps`.
- To widen for deploy/restart work: `bash setup-vps.sh vps-root ops` regenerates the
  config with the ops profile. The deny list stays in force either way.
- The setup script (`setup-vps.sh`) is idempotent: resolves connection details from
  `ssh -G <alias>` (so your `~/.ssh/config` stays the single source of truth),
  pre-flights the key, builds the server, writes the config outside the repo, and
  prints the one-line `claude mcp add` registration.

## Why this beats "just give the agent a terminal with ssh"

A raw `ssh` in a shell tool means the agent's *entire* command string runs remotely,
policy enforced only by hope. Here the policy is structural: the deny list is applied
by the server process the agent cannot modify, the credentials are physically outside
the agent's reach, and the read-only default means a confused or compromised session
can look at logs but cannot change state. Widening access is a deliberate,
human-initiated regeneration — not something the model can talk itself into.

*Written 2026-07-12. Server source: `~/.claude-setup/mcp-servers/ssh-mcp-server`
(TypeScript, compiled to `dist/`; zero runtime coupling to the agent).*
