import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * A single named SSH target. Auth is either a password or a private key path.
 * Per-connection allow/deny lists override the global ones when present.
 */
export const ConnectionSchema = z
  .object({
    host: z.string().min(1).describe("Hostname or IP of the remote server"),
    port: z.number().int().min(1).max(65535).default(22),
    username: z.string().min(1).describe("SSH username"),
    password: z.string().optional().describe("Password auth (prefer a key)"),
    privateKeyPath: z
      .string()
      .optional()
      .describe("Path to a private key file for key-based auth"),
    passphrase: z
      .string()
      .optional()
      .describe("Passphrase for the private key, if encrypted"),
    // Regex strings. A command must match at least one allow entry (if any are
    // defined) and must match no deny entry.
    allow: z.array(z.string()).optional().describe("Allowlist regexes"),
    deny: z.array(z.string()).optional().describe("Denylist regexes"),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Per-command timeout override"),
  })
  .strict()
  .refine((c) => c.password || c.privateKeyPath, {
    message: "Each connection needs either 'password' or 'privateKeyPath'",
  });

export const ConfigSchema = z
  .object({
    defaultConnection: z.string().optional(),
    defaultTimeoutMs: z.number().int().positive().default(30_000),
    // Global lists applied when a connection doesn't define its own.
    allow: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    connections: z.record(z.string(), ConnectionSchema),
  })
  .strict();

export type Connection = z.infer<typeof ConnectionSchema>;
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Load and validate config from a JSON file. Throws a readable error if the
 * file is missing or malformed so the agent gets an actionable message.
 */
export function loadConfig(path: string): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `Could not read config file at '${path}'. Pass --config <path> or set SSH_MCP_CONFIG.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Config at '${path}' is not valid JSON: ${(e as Error).message}`
    );
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Config validation failed:\n${result.error.issues
        .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n")}`
    );
  }
  return result.data;
}
