import { z } from "zod";

const ConfigSchema = z.object({
  bridge: z.object({
    user: z.string().min(1, "PROTON_BRIDGE_USER is required"),
    pass: z.string().min(1, "PROTON_BRIDGE_PASS is required"),
    host: z.string().default("127.0.0.1"),
    imapPort: z.number().int().positive().default(1143),
    smtpPort: z.number().int().positive().default(1025),
    from: z.string().email("PROTON_MAIL_FROM must be a valid email"),
    tlsInsecure: z.boolean().default(true),
  }),
  transport: z.object({
    kind: z.enum(["stdio", "http"]).default("stdio"),
    httpHost: z.string().default("127.0.0.1"),
    httpPort: z.number().int().positive().default(8787),
    authToken: z.string().optional(),
    allowedOrigins: z.array(z.string()).default([]),
  }),
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const env = process.env;
  const raw = {
    bridge: {
      user: env.PROTON_BRIDGE_USER ?? "",
      pass: env.PROTON_BRIDGE_PASS ?? "",
      host: env.PROTON_BRIDGE_HOST ?? "127.0.0.1",
      imapPort: Number(env.PROTON_BRIDGE_IMAP_PORT ?? 1143),
      smtpPort: Number(env.PROTON_BRIDGE_SMTP_PORT ?? 1025),
      from: env.PROTON_MAIL_FROM ?? env.PROTON_BRIDGE_USER ?? "",
      tlsInsecure: (env.PROTON_BRIDGE_TLS_INSECURE ?? "true") === "true",
    },
    transport: {
      kind: (env.MCP_TRANSPORT ?? "stdio") as "stdio" | "http",
      httpHost: env.MCP_HTTP_HOST ?? "127.0.0.1",
      httpPort: Number(env.MCP_HTTP_PORT ?? 8787),
      authToken: env.MCP_AUTH_TOKEN || undefined,
      allowedOrigins: (env.MCP_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    logLevel: (env.LOG_LEVEL ?? "info") as "error" | "warn" | "info" | "debug",
  };
  return ConfigSchema.parse(raw);
}

// -----------------------------------------------------------------------------
// Logger — writes to stderr only. stdio transport reserves stdout for MCP JSON-RPC.
// -----------------------------------------------------------------------------
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
export type LogLevel = keyof typeof LEVELS;

export function createLogger(level: LogLevel) {
  const threshold = LEVELS[level];
  const write = (lvl: LogLevel, msg: string, extra?: unknown) => {
    if (LEVELS[lvl] > threshold) return;
    const ts = new Date().toISOString();
    const tail = extra === undefined ? "" : ` ${safeStringify(extra)}`;
    process.stderr.write(`[${ts}] ${lvl.toUpperCase()} ${msg}${tail}\n`);
  };
  return {
    error: (msg: string, extra?: unknown) => write("error", msg, extra),
    warn: (msg: string, extra?: unknown) => write("warn", msg, extra),
    info: (msg: string, extra?: unknown) => write("info", msg, extra),
    debug: (msg: string, extra?: unknown) => write("debug", msg, extra),
  };
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}
