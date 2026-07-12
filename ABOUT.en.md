# Claude Code remote-ops bundle

🇧🇷 [Versão em português (página principal): README.md](README.md)

Built 2026-07-12 on a Mac Mini. Contents:

- `docs/ssh-mcp-server.md` — what the SSH MCP server does and the security model.
- `docs/claude-code-on-grok.md` — full writeup: running Claude Code on xAI Grok,
  the two validation quirks that break it, and the proxy fix.
- `ssh-mcp-server/` — complete server source (TypeScript). `npm install && npm run
  build`, then `bash setup-vps.sh <ssh-alias>` wires it to a host from your
  ~/.ssh/config. Read-only command allow-list by default.
- `grok/grok-proxy.mjs` — zero-dep localhost proxy that makes Claude Code work
  against api.x.ai (fixes tool-schema `required` + system-role messages).
- `grok/grok` — launcher: starts the proxy, maps model tiers, launches a fresh
  Claude Code session on Grok. macOS Keychain for the key; adapt the KEY= line
  for Linux.

Host names/IPs in docs are redacted placeholders. No keys or configs included —
credentials always live outside this bundle.
