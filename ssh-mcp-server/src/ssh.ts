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
 * Maintains one live ssh2 Client per named connection and reuses it across
 * tool calls. Connections are opened lazily on first use.
 */
export class SshPool {
  private clients = new Map<string, Client>();

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
    return auth;
  }

  private connect(name: string, conn: Connection): Promise<Client> {
    const existing = this.clients.get(name);
    if (existing) return Promise.resolve(existing);

    return new Promise<Client>((resolve, reject) => {
      const client = new Client();
      client
        .on("ready", () => {
          this.clients.set(name, client);
          resolve(client);
        })
        .on("error", (err) => {
          this.clients.delete(name);
          reject(new Error(`SSH connection to '${name}' failed: ${err.message}`));
        })
        .on("close", () => {
          this.clients.delete(name);
        })
        .connect(this.buildAuth(conn));
    });
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
          stream.close();
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
  }
}
