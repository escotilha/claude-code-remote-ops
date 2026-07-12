# ssh-mcp-server — smoke test & allow-list profiles

Quick reference for bringing this server up on a machine that already reaches the
target over SSH, and verifying it end-to-end.

## 1. Install / regenerate config

From a clone of **this** repository:

```bash
cd /path/to/claude-code-remote-ops/ssh-mcp-server
npm install && npm test
bash setup-vps.sh <ssh-alias>            # read-only (default)
# or, when you need service/deploy control (edit paths afterward):
bash setup-vps.sh <ssh-alias> ops
```

The script resolves host/user/port/key from `ssh -G <alias>`, captures a host
fingerprint when possible, builds, and writes `~/.config/ssh-mcp/<alias>.json`
(chmod 600, outside the repo). It prints the `claude mcp add -s user …` line.

## 2. Smoke test (paste into a FRESH Claude session)

MCP servers load at session start — start a new session rather than `/mcp`
reloading, so the `ssh_*` tools are present.

```
The ssh-mcp server is registered at user scope. Please:
  1. ssh_list_connections — confirm the alias is listed (names/flags only).
  2. ssh_execute "uptime" on that connection — report raw output.
  3. ssh_execute "uptime && echo pwned" — must be blocked (shell metacharacters).
  4. ssh_execute "rm -rf /tmp/x" — must be blocked by deny.
  5. ssh_upload any file — must be blocked (upload disabled in readonly).
Report each result.
```

**Green =** an `uptime` load-average line; the composition and `rm -rf` attempts
fail with `Error:`; upload is disabled. That proves the full path:
this machine → gate → ssh2 → remote user, with allow/deny and SFTP policy in front.

Troubleshooting:
- *Tools absent* → session started before registration; restart the session.
- *Auth/passphrase error* → load the key into `ssh-agent`, or add `"passphrase"`
  to the connection in `~/.config/ssh-mcp/<alias>.json`.
- *Host key* → re-run setup or set `hostFingerprint` from
  `ssh-keyscan -p PORT HOST | ssh-keygen -lf -`.

## 3. Allow-list profiles

`readonly` (default) — observability only, no state changes:

- `systemctl status|is-active`, `journalctl`, `tail -n N /var/log/…`
- `ls`, `cat /var/log/…`, `df -h`, `free -m`, `uptime`
- `tailscale status`, `ufw status`, `docker ps`
- SFTP: **download** `/var/log/*` only into `~/agent-transfers/<alias>/`; **upload off**

`ops` / `ops-template` — everything in `readonly` **plus** generic mutation patterns
(edit before production):

- `systemctl restart|start|stop <unit>`
- `bash /opt/YOUR_APP/scripts/deploy.sh`
- `touch|rm /opt/YOUR_APP/KILLSWITCH`

> Replace `YOUR_APP` and tighten unit-name patterns for your box.

**Deny list always wins** (merged with built-ins): recursive/force `rm`,
`shutdown`/`reboot`, `mkfs`, `dd`, `ufw reset|disable`,
`systemctl stop|disable|mask ssh`, recursive `chmod`/`chown`, writes into `/etc`.

Non-sanctioned commands match no allow rule and are blocked. Shell pipelines and
`&&` / `;` chains are blocked whenever an allow list is active.
