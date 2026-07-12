# Running Claude Code on xAI Grok (and why it breaks out of the box)

xAI's API speaks the Anthropic Messages format (`https://api.x.ai/v1/messages`), so in
theory you can point Claude Code at it and use Grok as the backend:

```bash
export ANTHROPIC_BASE_URL="https://api.x.ai"
export ANTHROPIC_AUTH_TOKEN="$XAI_API_KEY"
export ANTHROPIC_MODEL="grok-4.20-0309-reasoning"
claude
```

In practice the session dies instantly with a **red-herring error**:

```
API Error: 400 {"code":"invalid-argument","error":"Model not found: claude-sonnet-4-6"}
```

That model name has nothing to do with the problem. What actually happens:

1. **xAI's request validator is stricter than Anthropic's.** It rejects two things
   Claude Code routinely sends:
   - Tool definitions whose `input_schema` has no `required` array
     (`/required: null is not of type "array"`).
   - Messages with `role: "system"` inside the `messages` array (Claude Code injects
     system-reminders this way; Anthropic tolerates it, xAI returns
     `Invalid message role.`).
2. The first request 400s, so the CLI silently walks its **fallbackModel chain**
   (`claude-opus-4-8 → claude-sonnet-4-7 → claude-sonnet-4-6`) — none of which exist
   on xAI — and surfaces only the *last* failure. Hence "Model not found:
   claude-sonnet-4-6".

(Z.AI's GLM and Moonshot's Kimi endpoints don't have this problem — they tolerate or
auto-map whatever Claude Code sends, so plain env-var launchers work there.)

## The fix: a ~100-line schema-normalizing proxy

A zero-dependency Node proxy on localhost that repairs both violations on every
request and forwards to api.x.ai. Streaming (SSE), prompt caching, beta headers, and
auth headers pass through untouched — your key never leaves the request headers, and
nothing is logged except error statuses and request *shape* (roles/models/block
types, never prompt text).

### `grok-proxy.mjs`

```js
#!/usr/bin/env node
// grok-proxy — schema-normalizing proxy for Claude Code -> api.x.ai
// Fixes: (1) tool input_schemas missing a `required` array;
//        (2) role:"system" messages inside the messages array.
// Zero dependencies; listens on 127.0.0.1 only.

import http from "node:http";
import https from "node:https";

const PORT = Number(process.env.GROK_PROXY_PORT || 8317);
const UPSTREAM = new URL(process.env.GROK_UPSTREAM || "https://api.x.ai");

function normalizeSchema(node) {
  if (Array.isArray(node)) { node.forEach(normalizeSchema); return; }
  if (!node || typeof node !== "object") return;
  const isObjSchema = node.type === "object" ||
    (Array.isArray(node.type) && node.type.includes("object")) ||
    node.properties !== undefined;
  if (isObjSchema && !Array.isArray(node.required)) node.required = [];
  for (const v of Object.values(node)) normalizeSchema(v);
}

function toBlocks(content) {
  return typeof content === "string" ? [{ type: "text", text: content }] : content || [];
}

// Merge system-role messages into the preceding user turn (preserves position),
// or hoist them into the top-level `system` field when there is no user turn yet.
function normalizeMessages(body) {
  if (!Array.isArray(body.messages)) return;
  const out = [];
  for (const m of body.messages) {
    if (m && m.role !== "user" && m.role !== "assistant") {
      const blocks = toBlocks(m.content);
      const prev = out[out.length - 1];
      if (prev && prev.role === "user") {
        prev.content = [...toBlocks(prev.content), ...blocks];
      } else {
        body.system = [
          ...toBlocks(body.system),
          ...blocks.map((b) => (b.type === "text" ? b : { type: "text", text: JSON.stringify(b) })),
        ];
      }
    } else out.push(m);
  }
  body.messages = out;
}

function patchBody(raw) {
  try {
    const body = JSON.parse(raw);
    if (Array.isArray(body.tools)) {
      for (const t of body.tools) if (t && t.input_schema) normalizeSchema(t.input_schema);
    }
    normalizeMessages(body);
    return JSON.stringify(body);
  } catch { return raw; } // non-JSON: forward untouched
}

function sanitize(headers) {
  const h = { ...headers };
  for (const k of ["transfer-encoding", "content-length", "connection", "keep-alive"]) delete h[k];
  return h;
}

// Log request shape (roles/models/block types — never prompt text) on upstream 4xx.
function shapeOf(raw) {
  try {
    const b = JSON.parse(raw);
    const msgs = (b.messages || []).map((m) =>
      `${m.role}[${Array.isArray(m.content) ? m.content.map((c) => c.type).join(",") : typeof m.content}]`
    );
    return `model=${b.model} stream=${b.stream} msgs=${msgs.join(" | ")}`;
  } catch { return "(unparseable)"; }
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw.length ? patchBody(raw) : "";
    const headers = { ...req.headers, host: UPSTREAM.host };
    delete headers["content-length"];
    delete headers["accept-encoding"]; // keep upstream responses uncompressed (loggable)
    if (body) headers["content-length"] = Buffer.byteLength(body);

    const up = https.request(
      { hostname: UPSTREAM.hostname, port: 443, path: req.url, method: req.method, headers },
      (ur) => {
        if (ur.statusCode >= 400) {
          const ec = [];
          ur.on("data", (c) => ec.push(c));
          ur.on("end", () => {
            const errBody = Buffer.concat(ec);
            console.error(`[grok-proxy] ${req.method} ${req.url} -> ${ur.statusCode}: ${errBody.toString().slice(0, 500)}`);
            if (ur.statusCode < 500) console.error(`[grok-proxy]   request shape: ${shapeOf(body)}`);
            res.writeHead(ur.statusCode, sanitize(ur.headers));
            res.end(errBody);
          });
          return;
        }
        res.writeHead(ur.statusCode, sanitize(ur.headers));
        ur.pipe(res);
      }
    );
    up.on("error", (e) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `grok-proxy upstream: ${e.message}` } }));
    });
    up.end(body);
  });
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`[grok-proxy] listening on 127.0.0.1:${PORT} -> ${UPSTREAM.origin}`)
);
```

### `grok` (launcher)

Launches a fresh Claude Code session on a Grok backend. Reads the API key from the
macOS Keychain at runtime (adapt the `KEY=` line for Linux — e.g. `pass` or an env
var). Starts the proxy if it isn't running, reuses one that is, and stops its own on
exit. The env overrides live only in this process — your normal `claude` sessions
are untouched.

```bash
#!/usr/bin/env bash
# grok — launch a fresh Claude Code session backed by xAI Grok.
# Usage:  grok [any claude flags/args]

set -uo pipefail

KEY="$(security find-generic-password -s "xai-api-key" -a "$USER" -w 2>/dev/null)"
if [ -z "$KEY" ]; then
  echo "grok: no xAI key in Keychain (service 'xai-api-key', account $USER)." >&2
  echo "Store it once with:" >&2
  echo "  security add-generic-password -U -s \"xai-api-key\" -a \"\$USER\" -w" >&2
  exit 4
fi

PROXY_PORT="${GROK_PROXY_PORT:-8317}"
if ! nc -z 127.0.0.1 "$PROXY_PORT" 2>/dev/null; then
  GROK_PROXY_PORT="$PROXY_PORT" node "$(dirname "$0")/grok-proxy.mjs" >>/tmp/grok-proxy.log 2>&1 &
  PROXY_PID=$!
  trap '[ -n "${PROXY_PID:-}" ] && kill "$PROXY_PID" 2>/dev/null' EXIT
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    nc -z 127.0.0.1 "$PROXY_PORT" 2>/dev/null && break
    sleep 0.2
  done
  if ! nc -z 127.0.0.1 "$PROXY_PORT" 2>/dev/null; then
    echo "grok: proxy failed to start (see /tmp/grok-proxy.log)" >&2
    exit 5
  fi
fi

export ANTHROPIC_BASE_URL="http://127.0.0.1:$PROXY_PORT"
export ANTHROPIC_AUTH_TOKEN="$KEY"
export API_TIMEOUT_MS="3000000"
# A non-first-party base URL disables MCP tool search by default; restore it.
export ENABLE_TOOL_SEARCH="true"

# xAI does NOT auto-route claude-* model names — explicit mapping is required.
export ANTHROPIC_MODEL="grok-4.20-0309-reasoning"
export ANTHROPIC_DEFAULT_OPUS_MODEL="grok-4.20-0309-reasoning"
export ANTHROPIC_DEFAULT_SONNET_MODEL="grok-4.20-0309-reasoning"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="grok-4.20-0309-non-reasoning"
export ANTHROPIC_SMALL_FAST_MODEL="grok-4.20-0309-non-reasoning"

# No exec: the EXIT trap must fire afterward to stop the proxy we started.
claude "$@"
exit $?
```

## Install

```bash
mkdir -p ~/bin && cd ~/bin
# save grok-proxy.mjs and grok side by side
chmod +x grok
security add-generic-password -U -s "xai-api-key" -a "$USER" -w   # paste your xAI key
grok -p "Reply with exactly: ok"   # smoke test
```

## Debugging tips

- If a session errors, read `/tmp/grok-proxy.log` — it records each upstream 4xx
  **and the request's structural shape**, so the next strictness mismatch is a
  one-run diagnosis.
- General lesson for any non-Anthropic backend under Claude Code: when you see
  `Model not found: claude-*`, don't believe the model name — the first request was
  rejected for its *shape* and you're looking at the CLI's fallback chain dying.
  Reproduce with a curl that matches the real request (tools + cache_control + beta
  headers), not a minimal message.

Tested 2026-07-12 with Claude Code + `grok-4.20` (works end to end: streaming,
tools, prompt caching). MIT — do whatever you want with it.
