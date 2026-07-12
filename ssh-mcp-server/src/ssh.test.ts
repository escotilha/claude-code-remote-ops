import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fingerprintsMatch, hostKeySha256Base64 } from "./ssh.js";

describe("host key fingerprints", () => {
  it("computes SHA256 base64 of a key blob", () => {
    const key = Buffer.from("test-host-key-material");
    const b64 = hostKeySha256Base64(key);
    const expected = createHash("sha256").update(key).digest("base64");
    assert.equal(b64, expected);
  });

  it("matches SHA256: prefix and bare base64", () => {
    const key = Buffer.from("abc");
    const b64 = hostKeySha256Base64(key);
    assert.equal(fingerprintsMatch(`SHA256:${b64}`, b64), true);
    assert.equal(fingerprintsMatch(b64, b64), true);
    assert.equal(fingerprintsMatch("SHA256:nope", b64), false);
  });

  it("matches hex digest form", () => {
    const key = Buffer.from("abc");
    const b64 = hostKeySha256Base64(key);
    const hex = createHash("sha256").update(key).digest("hex");
    assert.equal(fingerprintsMatch(hex, b64), true);
    assert.equal(fingerprintsMatch(`SHA256:${hex}`, b64), true);
  });
});
