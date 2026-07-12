import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkCommand,
  checkTransfer,
  effectiveDeny,
  BUILTIN_DENY,
} from "./security.js";
import type { Config, Connection } from "./config.js";

function cfg(
  partial: Partial<Config> & { connections?: Config["connections"] } = {}
): Config {
  return {
    defaultTimeoutMs: 30_000,
    allow: partial.allow ?? [],
    deny: partial.deny ?? [],
    includeBuiltinDeny: partial.includeBuiltinDeny ?? false,
    transfers: partial.transfers,
    defaultConnection: partial.defaultConnection,
    connections: partial.connections ?? {
      t: {
        host: "10.0.0.1",
        port: 22,
        username: "deploy",
        privateKeyPath: "/tmp/id",
      },
    },
  };
}

function conn(partial: Partial<Connection> = {}): Connection {
  return {
    host: "10.0.0.1",
    port: 22,
    username: "deploy",
    privateKeyPath: "/tmp/id",
    ...partial,
  };
}

describe("checkCommand", () => {
  it("allows a command matching the allow list", () => {
    const c = cfg({ allow: ["^uptime$"] });
    assert.equal(checkCommand("uptime", c, conn()).allowed, true);
  });

  it("blocks a command matching no allow rule", () => {
    const c = cfg({ allow: ["^uptime$"] });
    const r = checkCommand("cat /etc/passwd", c, conn());
    assert.equal(r.allowed, false);
    assert.match(r.reason ?? "", /no allow rule/);
  });

  it("deny wins over allow", () => {
    const c = cfg({
      allow: ["^rm "],
      deny: ["rm -rf"],
      includeBuiltinDeny: false,
    });
    const r = checkCommand("rm -rf /tmp/x", c, conn());
    assert.equal(r.allowed, false);
    assert.match(r.reason ?? "", /deny rule/);
  });

  it("blocks shell composition that would bypass allow prefixes", () => {
    const c = cfg({ allow: ["^uptime"] });
    for (const cmd of [
      "uptime && rm -rf /",
      "uptime; cat /etc/shadow",
      "uptime | tee /tmp/x",
      "uptime `id`",
      "uptime $(whoami)",
      "uptime > /tmp/out",
      "uptime\ncat /etc/passwd",
    ]) {
      const r = checkCommand(cmd, c, conn());
      assert.equal(r.allowed, false, `should block: ${JSON.stringify(cmd)}`);
      assert.match(r.reason ?? "", /metacharacters/);
    }
  });

  it("still allows simple commands with args and quotes", () => {
    const c = cfg({ allow: ["^journalctl "] });
    assert.equal(
      checkCommand('journalctl -u alice --since "1 hour ago"', c, conn())
        .allowed,
      true
    );
  });

  it("malformed deny pattern fails closed", () => {
    const c = cfg({
      allow: ["^uptime$"],
      deny: ["[invalid"],
      includeBuiltinDeny: false,
    });
    const r = checkCommand("uptime", c, conn());
    assert.equal(r.allowed, false);
    assert.match(r.reason ?? "", /not a valid regex|fail-closed/);
  });

  it("malformed allow pattern does not match (command blocked if only that rule)", () => {
    const c = cfg({ allow: ["[invalid"], includeBuiltinDeny: false });
    const r = checkCommand("uptime", c, conn());
    assert.equal(r.allowed, false);
  });

  it("empty command is blocked", () => {
    const c = cfg({ allow: ["^"] });
    assert.equal(checkCommand("   ", c, conn()).allowed, false);
  });

  it("merges connection deny with global deny (never replaces)", () => {
    const c = cfg({
      deny: ["shutdown"],
      includeBuiltinDeny: false,
      allow: [".*"],
    });
    const co = conn({ deny: [] }); // empty must NOT wipe global
    assert.equal(checkCommand("shutdown -h now", c, co).allowed, false);

    const co2 = conn({ deny: ["reboot"] });
    assert.equal(checkCommand("shutdown now", c, co2).allowed, false);
    assert.equal(checkCommand("reboot", c, co2).allowed, false);
  });

  it("includes built-in deny by default", () => {
    const c = cfg({ allow: [".*"], includeBuiltinDeny: true });
    assert.equal(checkCommand("rm -rf /tmp/x", c, conn()).allowed, false);
    assert.equal(checkCommand("dd if=/dev/zero of=/dev/sda", c, conn()).allowed, false);
    assert.ok(BUILTIN_DENY.length > 0);
  });

  it("connection allow replaces global allow", () => {
    const c = cfg({ allow: ["^uptime$"] });
    const co = conn({ allow: ["^df -h$"] });
    assert.equal(checkCommand("uptime", c, co).allowed, false);
    assert.equal(checkCommand("df -h", c, co).allowed, true);
  });
});

describe("effectiveDeny", () => {
  it("unions global, connection, and builtins", () => {
    const c = cfg({ deny: ["a"], includeBuiltinDeny: true });
    const d = effectiveDeny(c, conn({ deny: ["b"] }));
    assert.ok(d.includes("a"));
    assert.ok(d.includes("b"));
    assert.ok(d.length > 2);
  });
});

describe("checkTransfer", () => {
  it("disables upload by default", () => {
    const c = cfg();
    const r = checkTransfer(
      "upload",
      "/tmp/x",
      "/var/log/x",
      c,
      conn()
    );
    assert.equal(r.allowed, false);
    assert.match(r.reason ?? "", /disabled/);
  });

  it("disables download by default", () => {
    const c = cfg();
    const r = checkTransfer(
      "download",
      "/tmp/x",
      "/var/log/x",
      c,
      conn()
    );
    assert.equal(r.allowed, false);
  });

  it("allows download when enabled and path matches remoteAllow", () => {
    const c = cfg({
      transfers: {
        downloadEnabled: true,
        remoteAllow: ["^/var/log/"],
        localRoot: "/tmp/agent-transfers",
      },
    });
    const r = checkTransfer(
      "download",
      "/tmp/agent-transfers/app.log",
      "/var/log/app.log",
      c,
      conn()
    );
    assert.equal(r.allowed, true, r.reason);
  });

  it("blocks download outside remoteAllow", () => {
    const c = cfg({
      transfers: {
        downloadEnabled: true,
        remoteAllow: ["^/var/log/"],
        localRoot: "/tmp/agent-transfers",
      },
    });
    const r = checkTransfer(
      "download",
      "/tmp/agent-transfers/env",
      "/opt/app/.env",
      c,
      conn()
    );
    assert.equal(r.allowed, false);
    assert.match(r.reason ?? "", /remoteAllow/);
  });

  it("blocks path traversal in remote path", () => {
    const c = cfg({
      transfers: {
        downloadEnabled: true,
        remoteAllow: ["^/var/log/"],
        localRoot: "/tmp/agent-transfers",
      },
    });
    const r = checkTransfer(
      "download",
      "/tmp/agent-transfers/x",
      "/var/log/../../etc/passwd",
      c,
      conn()
    );
    assert.equal(r.allowed, false);
  });

  it("enforces localRoot jail", () => {
    const c = cfg({
      transfers: {
        downloadEnabled: true,
        remoteAllow: ["^/var/log/"],
        localRoot: "/tmp/agent-transfers",
      },
    });
    const r = checkTransfer(
      "download",
      "/etc/passwd",
      "/var/log/app.log",
      c,
      conn()
    );
    assert.equal(r.allowed, false);
    assert.match(r.reason ?? "", /localRoot/);
  });

  it("honors remoteDeny", () => {
    const c = cfg({
      transfers: {
        downloadEnabled: true,
        remoteAllow: ["^/"],
        remoteDeny: ["\\.env$"],
        localRoot: "/tmp/agent-transfers",
      },
    });
    const r = checkTransfer(
      "download",
      "/tmp/agent-transfers/x",
      "/opt/app/.env",
      c,
      conn()
    );
    assert.equal(r.allowed, false);
    assert.match(r.reason ?? "", /remoteDeny/);
  });

  it("per-connection transfers override global", () => {
    const c = cfg({
      transfers: { downloadEnabled: false },
    });
    const co = conn({
      transfers: {
        downloadEnabled: true,
        remoteAllow: ["^/var/log/"],
        localRoot: "/tmp/agent-transfers",
      },
    });
    assert.equal(
      checkTransfer(
        "download",
        "/tmp/agent-transfers/a",
        "/var/log/a",
        c,
        co
      ).allowed,
      true
    );
  });
});
