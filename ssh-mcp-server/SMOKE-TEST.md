# ssh-mcp-server — smoke test & allow-list profiles

Quick reference for bringing this server up on a machine that already reaches the
target over SSH (e.g. the Mini → VPS `vps-root` over Tailscale), and
verifying it end-to-end.

## 1. Install / regenerate config

Run on the machine with working SSH to the target:

```bash
cd ~/.claude-setup && git pull
bash mcp-servers/ssh-mcp-server/setup-vps.sh vps-root            # read-only (default)
# or, when you need service/deploy control:
bash mcp-servers/ssh-mcp-server/setup-vps.sh vps-root ops        # ops profile
```

The script resolves host/user/port/key from `ssh -G vps-root`, does a pre-flight
connect, builds, and writes `~/.config/ssh-mcp/vps-root.json` (chmod 600, outside
the repo). It prints the `claude mcp add -s user …` line to register it.

## 2. Smoke test (paste into a FRESH Claude session on that machine)

MCP servers load at session start — start a new session rather than `/mcp`
reloading, so the `ssh_*` tools are present.

```
The ssh-mcp server is registered at user scope; config at
~/.config/ssh-mcp/vps-root.json. Please:
  1. ssh_list_connections  — confirm "vps-root" is listed.
  2. ssh_execute "uptime" on vps-root — report raw output.
  3. ssh_execute "systemctl is-active alice" on vps-root.
Report each result and whether the connection succeeded.
```

**Green =** an `uptime` load-average line and `active`. That proves the full path:
this machine → ssh2 → `root@<tailscale-ip>`, with the allow/deny gate in front.

Troubleshooting:
- *Tools absent* → session started before registration; restart the session.
- *Auth/passphrase error* → load the key into `ssh-agent`, or add `"passphrase"`
  to the connection in `~/.config/ssh-mcp/vps-root.json`.

## 3. Allow-list profiles

`readonly` (default) — observability only, no state changes:

- `systemctl status|is-active`, `journalctl`, `tail -n N /var/log/…`
- `ls`, `cat /var/log/…`, `df -h`, `free -m`, `uptime`
- `tailscale status`, `ufw status`, `docker ps`

`ops` — everything in `readonly` **plus** tightly-scoped mutations:

- `systemctl restart|start|stop alice[.service]`
- `systemctl restart|status claudia|paperclip[.service]`
- `bash /opt/claudia/scripts/vps-autoupdate.sh`  (the rollback-safe deploy)
- `touch|rm /opt/claudia/KILLSWITCH`

> Verify the `/opt/claudia` paths match your box before relying on the ops tier.

**Deny list always wins** (both profiles): `rm -rf`, `shutdown`, `reboot`,
`poweroff`, `halt`, `mkfs`, `dd if=`, `ufw reset`, `ufw disable`,
`systemctl stop|disable|mask ssh`, `> /etc`, `chmod -R`, `chown -R`.
The `ssh` and `ufw` denies exist specifically to prevent a repeat of the
2026-07-06 SSH lockout.

Non-sanctioned commands (e.g. `systemctl restart nginx`, `cat /opt/claudia/.env`)
match no allow rule and are blocked — secrets stay unreadable.
