# CLAUDE.md

Guidance for Claude Code working in this repository. Read this first.

## What this is

A **stdio** MCP server (TypeScript, `@modelcontextprotocol/sdk`, `ssh2`) that lets
an agent run commands and transfer files on remote hosts over SSH. Credentials
live in a config file on the machine running the server and never reach the model.
Commands are screened against allow/deny regex lists before any connection opens.

Four tools: `ssh_list_connections`, `ssh_execute`, `ssh_upload`, `ssh_download`.

## Fixed decisions — do not change without being asked

- **Transport stays stdio.** Do NOT add an HTTP/streamable transport. An
  internet-reachable endpoint that runs shell commands is a top-tier attack
  target; reachability for remote agents is solved with a reverse tunnel, not by
  exposing the exec endpoint.
- **Exec is request/response.** Do NOT switch to an interactive tmux/shell model
  unless a task explicitly requires answering mid-command prompts, watching a
  streaming process, or persisting shell state across calls.
- **The allow list is the real security boundary**, not the model's judgment.
  Keep it as tight as the task allows. Deny list is a backstop, not the primary
  control.

## Build and verify

```bash
npm install
npm run build          # tsc -> dist/ ; must complete with no errors
```

Then confirm it works with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js --config ./ssh-config.json
```

A change is "done" only when: `npm run build` is clean, the four tools appear in
the Inspector, and a denied command (e.g. `rm -rf /tmp/x`) returns an error
*without* attempting a connection.

## Testing against a real host

- Use a **disposable VM** and a **least-privilege account** (never root, never
  production) for any loop that actually connects.
- The config used for testing must live **outside this repo** and be passed with
  `--config /abs/path`. Never hardcode a host or key path into source.

## Never commit

- SSH private keys, passwords, or any real `ssh-config.json`.
- `node_modules/` or `dist/` is fine to ignore; `dist/` is a build artifact.
- Before committing, check `git status` for stray credentials or config files.

## Project layout

- `src/config.ts` — load + Zod-validate the JSON config
- `src/security.ts` — allow/deny gate (`checkCommand` / `checkTransfer`)
- `src/audit.ts` — optional append-only JSONL audit (`auditLogPath`)
- `src/ssh.ts` — connection pool, exec, SFTP
- `src/index.ts` — tool registration + stdio transport
- `README.md` — setup, client wiring, extension points

## Security invariants (do not weaken)

- **Deny is a union** (global ∪ connection ∪ builtins). Never let connection-level
  deny replace/wipe global deny.
- **Invalid deny regexes fail closed** (block). Invalid allow regexes simply do not match.
- When an allow list is active, **reject shell metacharacters** so composition cannot
  bypass prefix allows.
- **SFTP is fail-closed** (`uploadEnabled`/`downloadEnabled` default false). Path
  rules live in `transfers`; gate in `checkTransfer` before `pool.transfer`.
- Tool failures that are policy blocks should return **`isError: true`**.
- Audit log must never record passwords, key material, host/user, or stdout/stderr.

## When adding features

Do them one at a time, each isolated to the relevant module, each followed by
`npm test` + Inspector check before moving on. Next steps: packaging/docs (PR3),
then (only if a task demands it) interactive sessions or reverse-tunnel mode.
See `../docs/PR-PLAN.md`.
