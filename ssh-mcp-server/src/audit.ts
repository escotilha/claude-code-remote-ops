import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";

export type AuditTool =
  | "ssh_execute"
  | "ssh_upload"
  | "ssh_download"
  | "ssh_list_connections";

/**
 * One JSONL record per tool invocation. Never includes passwords, private keys,
 * passphrases, host addresses, or command stdout/stderr (those may hold secrets).
 */
export interface AuditEvent {
  ts: string;
  tool: AuditTool;
  /** Named connection only — never host/user/key paths. */
  connection?: string;
  gateAllowed?: boolean;
  /** Short gate failure reason (policy text only). */
  gateReason?: string;
  /** Remote command string for ssh_execute (may still be sensitive — operator choice to enable audit). */
  command?: string;
  localPath?: string;
  remotePath?: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  ok?: boolean;
  durationMs: number;
  /** Non-secret error message (connection failure, I/O, etc.). */
  error?: string;
}

export type AuditAppendFn = (path: string, line: string) => void;

export function expandAuditPath(p: string): string {
  if (p === "~") return process.env.HOME || p;
  if (p.startsWith("~/")) {
    return `${process.env.HOME || ""}${p.slice(1)}`;
  }
  return p;
}

/**
 * Default filesystem append: create parent dirs, append one line, ensure 0600.
 * Injected in tests.
 */
export function defaultAuditAppend(path: string, line: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const created = !existsSync(path);
  appendFileSync(path, line, { encoding: "utf8" });
  if (created) {
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best-effort on platforms that ignore mode */
    }
  }
}

/**
 * Append-only JSONL audit trail. Disabled when path is undefined/empty.
 * Write failures are logged to stderr and never throw into the tool path.
 */
export class AuditLog {
  readonly path: string | undefined;
  private readonly append: AuditAppendFn;

  constructor(path: string | undefined, append: AuditAppendFn = defaultAuditAppend) {
    this.path = path?.trim() ? expandAuditPath(path.trim()) : undefined;
    this.append = append;
  }

  get enabled(): boolean {
    return Boolean(this.path);
  }

  record(event: Omit<AuditEvent, "ts"> & { ts?: string }): void {
    if (!this.path) return;

    const line =
      JSON.stringify({
        ts: event.ts ?? new Date().toISOString(),
        tool: event.tool,
        ...(event.connection !== undefined
          ? { connection: event.connection }
          : {}),
        ...(event.gateAllowed !== undefined
          ? { gateAllowed: event.gateAllowed }
          : {}),
        ...(event.gateReason !== undefined
          ? { gateReason: event.gateReason }
          : {}),
        ...(event.command !== undefined ? { command: event.command } : {}),
        ...(event.localPath !== undefined
          ? { localPath: event.localPath }
          : {}),
        ...(event.remotePath !== undefined
          ? { remotePath: event.remotePath }
          : {}),
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
        ...(event.signal !== undefined ? { signal: event.signal } : {}),
        ...(event.timedOut !== undefined ? { timedOut: event.timedOut } : {}),
        ...(event.ok !== undefined ? { ok: event.ok } : {}),
        durationMs: event.durationMs,
        ...(event.error !== undefined ? { error: event.error } : {}),
      }) + "\n";

    try {
      this.append(this.path, line);
    } catch (e) {
      console.error(
        `[ssh-mcp] audit log write failed (${this.path}): ${(e as Error).message}`
      );
    }
  }
}
