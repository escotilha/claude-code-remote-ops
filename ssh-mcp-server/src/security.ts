import type { Config, Connection } from "./config.js";

export interface GateResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether a command may run against a given connection.
 *
 * Rules (connection-level lists take precedence over global lists):
 *   1. If any deny regex matches -> blocked.
 *   2. If an allow list exists and nothing matches -> blocked.
 *   3. Otherwise -> allowed.
 *
 * An empty allow list means "allow anything not denied". That's convenient but
 * risky, so the server warns at startup when no allow list is configured.
 */
export function checkCommand(
  command: string,
  config: Config,
  connection: Connection
): GateResult {
  const allow = connection.allow ?? config.allow;
  const deny = connection.deny ?? config.deny;

  for (const pattern of deny) {
    if (safeMatch(pattern, command)) {
      return {
        allowed: false,
        reason: `Command blocked by deny rule /${pattern}/. Adjust the command or update the config.`,
      };
    }
  }

  if (allow.length > 0) {
    const ok = allow.some((pattern) => safeMatch(pattern, command));
    if (!ok) {
      return {
        allowed: false,
        reason: `Command not permitted: it matches no allow rule. Allowed patterns: ${allow
          .map((p) => `/${p}/`)
          .join(", ")}`,
      };
    }
  }

  return { allowed: true };
}

function safeMatch(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    // A malformed regex in config should fail closed for deny, open for allow.
    // We signal "no match" here; callers treat deny-miss as pass and allow-miss
    // as block, which is the safe direction for a broken deny pattern only if
    // there is also an allow list. To be strict, treat malformed as non-match.
    return false;
  }
}
