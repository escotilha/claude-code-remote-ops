import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AuditLog, expandAuditPath, type AuditEvent } from "./audit.js";

describe("expandAuditPath", () => {
  it("expands ~ and ~/", () => {
    const home = process.env.HOME || "";
    assert.equal(expandAuditPath("~/state/audit.jsonl"), `${home}/state/audit.jsonl`);
    if (home) {
      assert.equal(expandAuditPath("~"), home);
    }
  });

  it("leaves absolute paths alone", () => {
    assert.equal(expandAuditPath("/var/log/ssh-mcp.jsonl"), "/var/log/ssh-mcp.jsonl");
  });
});

describe("AuditLog", () => {
  it("is disabled when path is empty or missing", () => {
    const lines: string[] = [];
    const append = (_p: string, line: string) => {
      lines.push(line);
    };
    assert.equal(new AuditLog(undefined, append).enabled, false);
    assert.equal(new AuditLog("  ", append).enabled, false);
    new AuditLog(undefined, append).record({
      tool: "ssh_execute",
      durationMs: 1,
      command: "uptime",
    });
    assert.equal(lines.length, 0);
  });

  it("appends one JSON line per record", () => {
    const lines: string[] = [];
    let writtenPath = "";
    const log = new AuditLog("/tmp/test-audit.jsonl", (p, line) => {
      writtenPath = p;
      lines.push(line);
    });
    assert.equal(log.enabled, true);
    log.record({
      tool: "ssh_execute",
      connection: "prod",
      gateAllowed: true,
      command: "uptime",
      exitCode: 0,
      timedOut: false,
      durationMs: 42,
      ts: "2026-07-12T00:00:00.000Z",
    });
    assert.equal(writtenPath, "/tmp/test-audit.jsonl");
    assert.equal(lines.length, 1);
    assert.ok(lines[0].endsWith("\n"));
    const parsed = JSON.parse(lines[0]) as AuditEvent;
    assert.equal(parsed.tool, "ssh_execute");
    assert.equal(parsed.connection, "prod");
    assert.equal(parsed.gateAllowed, true);
    assert.equal(parsed.command, "uptime");
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.durationMs, 42);
    assert.equal(parsed.ts, "2026-07-12T00:00:00.000Z");
  });

  it("records gate denials without exit codes", () => {
    const lines: string[] = [];
    const log = new AuditLog("/tmp/a.jsonl", (_p, line) => lines.push(line));
    log.record({
      tool: "ssh_execute",
      connection: "prod",
      gateAllowed: false,
      gateReason: "Command blocked by deny rule",
      command: "rm -rf /",
      durationMs: 1,
      ts: "2026-07-12T00:00:01.000Z",
    });
    const parsed = JSON.parse(lines[0]) as AuditEvent;
    assert.equal(parsed.gateAllowed, false);
    assert.match(parsed.gateReason ?? "", /deny/);
    assert.equal(parsed.exitCode, undefined);
  });

  it("records transfer events with paths only", () => {
    const lines: string[] = [];
    const log = new AuditLog("/tmp/a.jsonl", (_p, line) => lines.push(line));
    log.record({
      tool: "ssh_download",
      connection: "prod",
      gateAllowed: true,
      localPath: "/tmp/agent-transfers/app.log",
      remotePath: "/var/log/app.log",
      ok: true,
      durationMs: 10,
      ts: "2026-07-12T00:00:02.000Z",
    });
    const parsed = JSON.parse(lines[0]) as AuditEvent;
    assert.equal(parsed.tool, "ssh_download");
    assert.equal(parsed.localPath, "/tmp/agent-transfers/app.log");
    assert.equal(parsed.remotePath, "/var/log/app.log");
    assert.equal(parsed.ok, true);
    // No secret-bearing fields should appear as keys we care about
    assert.equal("password" in parsed, false);
    assert.equal("privateKeyPath" in parsed, false);
    assert.equal("stdout" in parsed, false);
  });

  it("swallows append errors (never throws)", () => {
    const log = new AuditLog("/tmp/a.jsonl", () => {
      throw new Error("disk full");
    });
    assert.doesNotThrow(() =>
      log.record({ tool: "ssh_list_connections", durationMs: 0 })
    );
  });

  it("expands ~ in configured path", () => {
    let seen = "";
    const home = process.env.HOME || "";
    const log = new AuditLog("~/audit.jsonl", (p) => {
      seen = p;
    });
    log.record({ tool: "ssh_list_connections", durationMs: 0 });
    assert.equal(seen, `${home}/audit.jsonl`);
  });
});
