# Claude Code remote-ops bundle

🇧🇷 [Versão em português (página principal): README.md](README.md)

Built 2026-07-12 on a Mac Mini; security hardenings in `docs/PR-PLAN.md`.

## Pieces

- **`ssh-mcp-server/`** — MCP server (TypeScript) giving an agent SSH hands with
  structural guardrails: credentials never reach the model; command allow/deny
  (+ shell-metacharacter reject); SFTP fail-closed with path rules; optional
  host-key pinning.  
  `cd ssh-mcp-server && npm install && npm test && bash setup-vps.sh <ssh-alias>`
- **`grok/`** — `grok-proxy.mjs` (localhost schema normalizer for api.x.ai) +
  `grok` launcher (Keychain key, model-tier map, full Claude Code session).
- **`docs/`** — security model, Grok debugging writeup, and the PR roadmap.

## Security defaults (ssh-mcp)

| Control | Default |
|---------|---------|
| Command profile | **readonly** (status/logs/disk/uptime) |
| Shell `; && \| $()` chains | **blocked** when allow list is set |
| SFTP upload | **off** |
| SFTP download | `/var/log/*` only → `~/agent-transfers/<alias>/` |
| Host key | pinned when `ssh-keyscan` works |

Host names/IPs in docs are placeholders. No keys or live configs in the repo.

