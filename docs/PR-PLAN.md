# PR plan — harden claude-code-remote-ops

Concrete checklist derived from the 2026-07-12 review. Work in **priority order**; each PR should stay reviewable in one sitting.

## Ship order

| # | PR | Scope | Status |
|---|-----|--------|--------|
| 1 | **P0 security** | Gate SFTP, shell-meta reject, deny merge + fail-closed, host key, tests | **This PR** (`harden/p0-security`) |
| 2 | **Audit log** | Append-only JSONL for every tool call | Next |
| 3 | **Docs / OSS packaging** | Full English README, GitHub description/topics, SMOKE-TEST paths, SECURITY.md | Next |
| 4 | **Grok proxy hardening** | No default body dumps, port health, Linux key path, model env | Next |
| 5 | **CI** | `npm ci && npm test` on push; pin critical deps | With #2 or #3 |

---

## PR1 — P0 security (current)

### Goals

Make the code match the marketing: *readonly cannot change state; allow lists cannot be composed around; credentials stay off-transcript*.

### Checklist

- [x] **SFTP fail-closed** — `uploadEnabled` / `downloadEnabled` default off; setup enables download only under `/var/log/` + `localRoot` jail
- [x] **Path rules** — `remoteAllow`, `remoteDeny`, reject `..`, absolute remote paths
- [x] **Shell metacharacters** — reject `;|&$\`()<>` / newlines when allow list is active
- [x] **Deny merge** — global ∪ connection ∪ built-ins; connection can never wipe global deny
- [x] **Deny parse fail-closed** — invalid deny regex blocks the command
- [x] **Host fingerprint** — optional `hostFingerprint` + `strictHostKeyChecking`; setup runs `ssh-keyscan` when possible
- [x] **list_connections** — no host/port/username leakage
- [x] **isError: true** on gated tool failures
- [x] **Unit tests** — `security.test.ts`, `ssh.test.ts` via `node:test`
- [x] **setup-vps.sh** — generic ops template, least-privilege user default, transfer root
- [x] **Example config + README notes**

### Verify

```bash
cd ssh-mcp-server && npm test
```

### Risk / migration

Existing configs without `transfers` **lose** SFTP until they opt in. Existing configs without fingerprints keep working (warning on stderr). Add `transfers` / `hostFingerprint` via re-running `setup-vps.sh` or hand-edit.

---

## PR2 — Audit log

### Checklist

- [ ] Config: `auditLogPath` (default off, or `~/.local/state/ssh-mcp/audit.jsonl`)
- [ ] Append one JSON line per `ssh_execute` / upload / download: time, connection name, tool, command or paths, gate allowed?, exit code, duration ms
- [ ] Never log private key material or passwords
- [ ] Unit test: mock fs append
- [ ] Document rotation (logrotate snippet)

---

## PR3 — Docs & packaging

### Checklist

- [ ] Full **English README** (parity with PT) or `README.en.md` linked from root
- [ ] Fix `SMOKE-TEST.md` to use **this repo** paths only (no `~/.claude-setup/...`)
- [ ] `SECURITY.md` — threat model, what the gate does / does not do, report path
- [ ] Root `.gitignore`
- [ ] GitHub: description, topics (`mcp`, `ssh`, `claude-code`, `xai`, `security`)
- [ ] Soften or align “agent only knows the nickname” with list_connections output
- [ ] Generic architecture diagram (agent → stdio MCP → SSH → host)

---

## PR4 — Grok proxy

### Checklist

- [ ] Full body dump only when `GROK_PROXY_DUMP=1`
- [ ] Health/version response on `GET /health` (or refuse non-Anthropic paths quietly)
- [ ] Launcher: detect foreign process on port (not just `nc -z`)
- [ ] Linux: read `~/.config/xai/key` if Keychain miss
- [ ] Model IDs from env / optional `~/.config/grok/models.env`
- [ ] Doc: point at `grok/grok-proxy.mjs` as source of truth (drop stale embedded copy drift)

---

## PR5 — CI

### Checklist

- [ ] GitHub Actions: Node 20, `npm ci`, `npm test` under `ssh-mcp-server/`
- [ ] Optional: `npm audit --omit=dev` (warn)
- [ ] Status badge in README

---

## Out of scope (later)

- Interactive tmux sessions
- Reverse-tunnel mode
- HTTP MCP transport (explicit non-goal in CLAUDE.md)
- npm publish of `@escotilha/ssh-mcp-server`
- Human-in-the-loop confirm for ops mutations
