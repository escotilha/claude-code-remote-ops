import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "ssh2";
import type { Connection } from "./config.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  timedOut: boolean;
}

/**
 * Normalize fingerprints for comparison.
 * Accepts "SHA256:base64", "SHA256:hex", or bare base64/hex of the SHA256 digest.
 */
export function fingerprintsMatch(
  expected: string,
  actualSha256Base64: string
): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .replace(/^SHA256:/i, "")
      .replace(/[=+\s]/g, "")
      .toLowerCase();

  const exp = norm(expected);
  const actB64 = norm(actualSha256Base64);
  if (exp === actB64) return true;

  // Also compare hex form of the same digest
  try {
    const actHex = Buffer.from(actualSha256Base64, "base64")
      .toString("hex")
      .toLowerCase();
    if (exp === actHex) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function hostKeySha256Base64(key: Buffer): string {
  return createHash("sha256").update(key).digest("base64");
}

/**
 * Maintains one live ssh2 Client per named connection and reuses it across
 * tool calls. Connections are opened lazily on first use.
 */
export class SshPool {
  private clients = new Map<string, Client>();
  private connecting = new Map<string, Promise<Client>>();

  private buildAuth(conn: Connection) {
    const auth: Record<string, unknown> = {
      host: conn.host,
      port: conn.port,
      username: conn.username,
      // Keep the TCP session alive between agent calls.
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      readyTimeout: 20_000,
    };
    if (conn.privateKeyPath) {
      auth.privateKey = readFileSync(conn.privateKeyPath);
      if (conn.passphrase) auth.passphrase = conn.passphrase;
    } else if (conn.password) {
      auth.password = conn.password;
    }

    const fingerprint = conn.hostFingerprint;
    const strict =
      conn.strictHostKeyChecking ?? (fingerprint ? true : false);

    if (fingerprint || strict) {
      auth.hostVerifier = (key: Buffer) => {
        const actual = hostKeySha256Base64(key);
        if (!fingerprint) {
          // strict without fingerprint: reject (misconfiguration)
          return false;
        }
        return fingerprintsMatch(fingerprint, actual);
      };
    }

    return auth;
  }

  private connect(name: string, conn: Connection): Promise<Client> {
    const existing = this.clients.get(name);
    if (existing) return Promise.resolve(existing);

    const inflight = this.connecting.get(name);
    if (inflight) return inflight;

    const promise = new Promise<Client>((resolve, reject) => {
      if (
        (conn.strictHostKeyChecking ?? false) &&
        !conn.hostFingerprint
      ) {
        reject(
          new Error(
            `SSH connection to '${name}' refused: strictHostKeyChecking is on but hostFingerprint is missing. ` +
              `Run: ssh-keyscan -p ${conn.port} ${conn.host} | ssh-keygen -lf -`
          )
        );
        return;
      }

      const client = new Client();
      client
        .on("ready", () => {
          this.clients.set(name, client);
          this.connecting.delete(name);
          resolve(client);
        })
        .on("error", (err) => {
          this.clients.delete(name);
          this.connecting.delete(name);
          const hint =
            conn.hostFingerprint &&
            /Host key verification|verification failed|host key/i.test(
              err.message
            )
              ? ` (host key mismatch? expected ${conn.hostFingerprint})`
              : "";
          reject(
            new Error(
              `SSH connection to '${name}' failed: ${err.message}${hint}`
            )
          );
        })
        .on("close", () => {
          this.clients.delete(name);
        })
        .connect(this.buildAuth(conn) as Parameters<Client["connect"]>[0]);
    });

    this.connecting.set(name, promise);
    return promise;
  }

  async exec(
    name: string,
    conn: Connection,
    command: string,
    timeoutMs: number
  ): Promise<ExecResult> {
    const client = await this.connect(name, conn);

    return new Promise<ExecResult>((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) return reject(err);

        let stdout = "";
        let stderr = "";
        let finished = false;

        const timer = setTimeout(() => {
          if (finished) return;
          finished = true;
          try {
            stream.close();
          } catch {
            /* ignore */
          }
          resolve({ stdout, stderr, code: null, signal: null, timedOut: true });
        }, timeoutMs);

        stream
          .on("close", (code: number | null, signal: string | null) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            resolve({ stdout, stderr, code, signal, timedOut: false });
          })
          .on("data", (d: Buffer) => {
            stdout += d.toString("utf8");
          });
        stream.stderr.on("data", (d: Buffer) => {
          stderr += d.toString("utf8");
        });
      });
    });
  }

  async transfer(
    name: string,
    conn: Connection,
    direction: "upload" | "download",
    localPath: string,
    remotePath: string
  ): Promise<void> {
    const client = await this.connect(name, conn);
    return new Promise<void>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(err);
        const done = (e: Error | null | undefined) =>
          e ? reject(e) : resolve();
        if (direction === "upload") {
          sftp.fastPut(localPath, remotePath, done);
        } else {
          sftp.fastGet(remotePath, localPath, done);
        }
      });
    });
  }

  closeAll(): void {
    for (const client of this.clients.values()) client.end();
    this.clients.clear();
    this.connecting.clear();
  }
}
