#!/usr/bin/env node
// grok-proxy — minimal schema-normalizing proxy for Claude Code -> api.x.ai
//
// xAI's Anthropic-compatible endpoint enforces strict JSON-Schema validation:
// a tool input_schema whose `required` is missing/null gets a 400
// ("/required: null is not of type \"array\""). Claude Code emits some built-in
// tool schemas without `required`, so pointing ANTHROPIC_BASE_URL straight at
// https://api.x.ai dies on the first request — masked by the fallbackModel
// chain as "Model not found: claude-sonnet-4-6" (see memory
// mistake_xai_anthropic_endpoint_strict_tool_schema_400).
//
// This proxy buffers each JSON request, normalizes every object schema node to
// carry a `required` array, forwards to api.x.ai, and streams the response
// back (SSE included). Auth headers pass through untouched — no key stored.
//
// Zero dependencies; 127.0.0.1 only. Started/stopped by tools/grok.
// Upstream 4xx/5xx bodies are logged to stderr (schema paths, not prompts).

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

// Claude Code sends messages with role "system" inside the messages array
// (system-reminders); Anthropic tolerates this, xAI 400s ("Invalid message
// role."). Merge such content into the preceding user turn to preserve
// position, or hoist it into the top-level `system` field when there is none.
function toBlocks(content) {
  return typeof content === "string" ? [{ type: "text", text: content }] : content || [];
}

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

// ToolSearch results contain `tool_reference` blocks — an Anthropic-proprietary
// content type xAI's deserializer rejects (422, "did not match any variant of
// untagged enum MessageContent"). The CLI expands referenced tool schemas
// client-side, so a plain-text stand-in preserves the information for the model.
function normalizeBlockList(list) {
  if (!Array.isArray(list)) return list;
  return list.map((b) =>
    b && b.type === "tool_reference"
      ? { type: "text", text: `[tool_reference: ${b.tool_name}]` }
      : b
  );
}

function normalizeBlockTypes(body) {
  if (!Array.isArray(body.messages)) return;
  for (const m of body.messages) {
    m.content = normalizeBlockList(m.content);
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === "tool_result") b.content = normalizeBlockList(b.content);
    }
  }
}

function patchBody(raw) {
  try {
    const body = JSON.parse(raw);
    if (Array.isArray(body.tools)) {
      for (const t of body.tools) if (t && t.input_schema) normalizeSchema(t.input_schema);
    }
    normalizeMessages(body);
    normalizeBlockTypes(body);
    return JSON.stringify(body);
  } catch { return raw; } // non-JSON: forward untouched
}

function sanitize(headers) {
  const h = { ...headers };
  for (const k of ["transfer-encoding", "content-length", "connection", "keep-alive"]) delete h[k];
  return h;
}

// On upstream 4xx, log the request's structural shape (roles/models/content
// block types — never prompt text) so validation failures are diagnosable.
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
            if (ur.statusCode < 500 && body && [400, 413, 422].includes(ur.statusCode)) {
              console.error(`[grok-proxy]   request shape: ${shapeOf(body)}`);
              // Full body may contain prompts — only dump when explicitly requested.
              if (process.env.GROK_PROXY_DUMP === "1") {
                import("node:fs").then((fs) => {
                  const p = `/tmp/grok-proxy-fail-${Date.now()}.json`;
                  fs.writeFileSync(p, body, { mode: 0o600 });
                  console.error(`[grok-proxy]   rejected body captured: ${p}`);
                }).catch(() => {});
              }
            }
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
