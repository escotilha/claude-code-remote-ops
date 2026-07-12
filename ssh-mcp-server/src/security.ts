import { resolve, relative, isAbsolute, normalize } from "node:path";
import type { Config, Connection, TransfersConfig } from "./config.js";

export interface GateResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Characters / sequences that turn a single argv-style command into a shell
 * script. When an allow list is active we reject these so `^uptime` cannot be
 * stretched into `uptime && rm -rf /`.
 *
 * Quotes and spaces are allowed (e.g. journalctl --since "1 hour ago").
 */
const SHELL_META = /[;|&`$()<>\n\r]|\n/;

/** Expanded catastrophic patterns — used as the built-in deny baseline merge. */
export const BUILTIN_DENY: string[] = [
  // recursive / force removals (plain `rm path` still allowed if on allow list)
  String.raw`\brm\s+-[a-zA-Z]*r`,
  String.raw`\brm\s+-[a-zA-Z]*f`,
  String.raw`\brm\s+--recursive\b`,
  String.raw`\brm\s+--force\b`,
  String.raw`\b(shutdown|reboot|poweroff|halt)\b`,
  String.raw`\bmkfs\b`,
  String.raw`\bdd\b`,
  String.raw`\bufw\s+(reset|disable)\b`,
  String.raw`systemctl\s+(stop|disable|mask)\s+ssh`,
  String.raw`>\s*/etc`,
  String.raw`\bchmod\s+-R\b`,
  String.raw`\bchown\s+-R\b`,
];

/**
 * Effective allow/deny for a connection.
 * - allow: connection-level replaces global when set (wider/narrower per host OK)
 * - deny: always global ∪ connection ∪ optional built-ins (never replace)
 */
export function effectiveAllow(
  config: Config,
  connection: Connection
): string[] {
  return connection.allow ?? config.allow;
}

export function effectiveDeny(
  config: Config,
  connection: Connection
): string[] {
  const merged = [
    ...(config.deny ?? []),
    ...(connection.deny ?? []),
    ...(config.includeBuiltinDeny === false ? [] : BUILTIN_DENY),
  ];
  return [...new Set(merged)];
}

/**
 * Decide whether a command may run against a given connection.
 *
 * Rules:
 *   1. If an allow list is active and the command contains shell metacharacters
 *      -> blocked (prevents composition bypasses).
 *   2. If any deny regex matches -> blocked (malformed deny patterns fail closed).
 *   3. If an allow list exists and nothing matches the full command -> blocked.
 *   4. Otherwise -> allowed.
 *
 * An empty allow list means "allow anything not denied". That's convenient but
 * risky, so the server warns at startup when no allow list is configured.
 */
export function checkCommand(
  command: string,
  config: Config,
  connection: Connection
): GateResult {
  const allow = effectiveAllow(config, connection);
  const deny = effectiveDeny(config, connection);
  const trimmed = command.trim();

  if (!trimmed) {
    return { allowed: false, reason: "Empty command." };
  }

  if (allow.length > 0 && SHELL_META.test(trimmed)) {
    return {
      allowed: false,
      reason:
        "Command blocked: shell metacharacters (; | & ` $ ( ) < > newlines) " +
        "are not allowed when an allow list is active. Run one simple command at a time.",
    };
  }

  for (const pattern of deny) {
    const m = safeMatch(pattern, trimmed, /* failClosed */ true);
    if (m === "error") {
      return {
        allowed: false,
        reason: `Command blocked: deny rule /${pattern}/ is not a valid regex (fail-closed). Fix the config.`,
      };
    }
    if (m === true) {
      return {
        allowed: false,
        reason: `Command blocked by deny rule /${pattern}/. Adjust the command or update the config.`,
      };
    }
  }

  if (allow.length > 0) {
    let anyError = false;
    const ok = allow.some((pattern) => {
      const m = safeMatch(pattern, trimmed, /* failClosed */ false);
      if (m === "error") {
        anyError = true;
        return false;
      }
      return m === true;
    });
    if (!ok) {
      return {
        allowed: false,
        reason: anyError
          ? `Command not permitted: one or more allow rules are invalid regexes, and no valid rule matched.`
          : `Command not permitted: it matches no allow rule. Allowed patterns: ${allow
              .map((p) => `/${p}/`)
              .join(", ")}`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Gate for SFTP upload/download. Direction must be enabled; remote path must
 * pass deny then allow; local path must stay under localRoot when configured.
 */
export function checkTransfer(
  direction: "upload" | "download",
  localPath: string,
  remotePath: string,
  config: Config,
  connection: Connection
): GateResult {
  const transfers: TransfersConfig =
    connection.transfers ?? config.transfers ?? {};

  const enabled =
    direction === "upload"
      ? transfers.uploadEnabled === true
      : transfers.downloadEnabled === true;

  if (!enabled) {
    return {
      allowed: false,
      reason:
        `ssh_${direction} is disabled for this connection. ` +
        `Enable transfers.${direction}Enabled in the config (and set path rules) to allow it.`,
    };
  }

  // Reject traversal before and after normalize (normalize collapses ..).
  if (remotePath.includes("..")) {
    return {
      allowed: false,
      reason: "remote_path must not contain '..' segments.",
    };
  }

  const remote = normalizeRemotePath(remotePath);
  if (!remote.startsWith("/")) {
    return {
      allowed: false,
      reason: "remote_path must be an absolute path starting with /.",
    };
  }

  const remoteDeny = transfers.remoteDeny ?? [];
  for (const pattern of remoteDeny) {
    const m = safeMatch(pattern, remote, true);
    if (m === "error") {
      return {
        allowed: false,
        reason: `Transfer blocked: remoteDeny rule /${pattern}/ is invalid (fail-closed).`,
      };
    }
    if (m === true) {
      return {
        allowed: false,
        reason: `Transfer blocked by remoteDeny /${pattern}/.`,
      };
    }
  }

  const remoteAllow = transfers.remoteAllow ?? [];
  if (remoteAllow.length > 0) {
    const ok = remoteAllow.some((pattern) => {
      const m = safeMatch(pattern, remote, false);
      return m === true;
    });
    if (!ok) {
      return {
        allowed: false,
        reason: `Transfer not permitted: remote path matches no remoteAllow rule. Allowed: ${remoteAllow
          .map((p) => `/${p}/`)
          .join(", ")}`,
      };
    }
  }

  if (transfers.localRoot) {
    const root = resolve(expandHome(transfers.localRoot));
    const local = resolve(expandHome(localPath));
    const rel = relative(root, local);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return {
        allowed: false,
        reason: `local_path must be under localRoot (${root}). Got: ${local}`,
      };
    }
  } else if (!isAbsolute(expandHome(localPath)) && !localPath.startsWith("~")) {
    // Prefer absolute local paths to avoid cwd-relative surprises in the MCP host.
    return {
      allowed: false,
      reason: "local_path must be absolute (or under a configured localRoot).",
    };
  }

  return { allowed: true };
}

function normalizeRemotePath(p: string): string {
  // POSIX-style normalize without resolving against local FS
  const collapsed = normalize("/" + p.replace(/\\/g, "/")).replace(/\\/g, "/");
  return collapsed === "/" ? "/" : collapsed.replace(/\/$/, "") || "/";
}

function expandHome(p: string): string {
  if (p === "~") return process.env.HOME || p;
  if (p.startsWith("~/")) return `${process.env.HOME || ""}${p.slice(1)}`;
  return p;
}

/**
 * @param failClosed when true, invalid regex returns "error" (for deny).
 *                   when false, invalid regex returns false (no match, for allow).
 */
function safeMatch(
  pattern: string,
  value: string,
  failClosed: boolean
): boolean | "error" {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return failClosed ? "error" : false;
  }
}
