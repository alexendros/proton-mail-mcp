#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, createLogger } from "./config.js";
import { buildServer } from "./server.js";
import { buildHttpApp } from "./http.js";

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write(`[FATAL] Invalid configuration: ${(err as Error).message}\n`);
    process.stderr.write("Check your environment variables against .env.example\n");
    process.exit(2);
  }

  const log = createLogger(cfg.logLevel);

  if (cfg.transport.kind === "stdio") {
    const { server, imap, smtp } = buildServer(cfg, log);
    installSignalHandlers(log, async () => {
      try { await imap.close(); } catch { /* noop */ }
      try { await smtp.close(); } catch { /* noop */ }
    });
    log.info("Starting MCP on stdio");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  if (!cfg.transport.authToken) {
    process.stderr.write("[FATAL] HTTP mode requires MCP_AUTH_TOKEN. Generate one: openssl rand -hex 32\n");
    process.exit(2);
  }

  if (process.env.NODE_ENV === "production" && cfg.transport.allowedOrigins.length === 0) {
    process.stderr.write("[FATAL] HTTP mode in production requires MCP_ALLOWED_ORIGINS to be set\n");
    process.exit(2);
  }

  const shared = buildServer(cfg, log);
  installSignalHandlers(log, async () => {
    try { await shared.imap.close(); } catch { /* noop */ }
    try { await shared.smtp.close(); } catch { /* noop */ }
  });

  const app = buildHttpApp({
    buildServer: () => buildServer(cfg, log).server,
    cfg,
    log,
  });

  app.listen(cfg.transport.httpPort, cfg.transport.httpHost, () => {
    log.info(`MCP listening on http://${cfg.transport.httpHost}:${cfg.transport.httpPort}/mcp`);
  });
}

function installSignalHandlers(log: ReturnType<typeof createLogger>, cleanup: () => Promise<void>): void {
  const handler = async (signal: string): Promise<void> => {
    log.info(`Shutting down (signal=${signal})…`);
    await cleanup();
    process.exit(0);
  };
  process.on("SIGINT", () => void handler("SIGINT"));
  process.on("SIGTERM", () => void handler("SIGTERM"));
  process.on("SIGHUP", () => void handler("SIGHUP"));
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[uncaughtException] ${err.stack}\n`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[unhandledRejection] ${reason instanceof Error ? reason.stack : String(reason)}\n`);
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`[FATAL] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
