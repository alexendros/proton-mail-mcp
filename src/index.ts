#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { loadConfig, createLogger } from "./config.js";
import { buildServer } from "./server.js";

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write(`[FATAL] Invalid configuration: ${(err as Error).message}\n`);
    process.stderr.write("Check your environment variables against .env.example\n");
    process.exit(2);
  }

  const log = createLogger(cfg.logLevel);
  const { server, imap, smtp } = buildServer(cfg, log);

  const cleanup = async (signal: string) => {
    log.info(`Shutting down (signal=${signal})…`);
    try { await imap.close(); } catch { /* noop */ }
    try { await smtp.close(); } catch { /* noop */ }
    process.exit(0);
  };
  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));
  process.on("SIGHUP", () => cleanup("SIGHUP"));
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[uncaughtException] ${err.stack}\n`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[unhandledRejection] ${reason instanceof Error ? reason.stack : reason}\n`);
  });

  if (cfg.transport.kind === "stdio") {
    log.info("Starting MCP on stdio");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return; // Keep process alive; transport handles stdin/stdout
  }

  // ---------------------------------------------------------------------------
  // Streamable HTTP transport
  // ---------------------------------------------------------------------------
  if (!cfg.transport.authToken) {
    process.stderr.write("[FATAL] HTTP mode requires MCP_AUTH_TOKEN. Generate one: openssl rand -hex 32\n");
    process.exit(2);
  }
  const expectedToken = cfg.transport.authToken;
  const allowedOrigins = new Set(cfg.transport.allowedOrigins);

  const app = express();
  app.use(express.json({ limit: "25mb" }));

  // Auth + Origin protection for all /mcp requests
  app.use("/mcp", (req, res, next) => {
    // DNS rebinding protection: reject disallowed Origin headers
    const origin = req.headers.origin;
    if (origin && allowedOrigins.size > 0 && !allowedOrigins.has(origin)) {
      res.status(403).json({ error: "origin_not_allowed" });
      return;
    }
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    // Timing-safe comparison
    if (token.length !== expectedToken.length || !safeEqual(token, expectedToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  // In stateless JSON mode, one transport per request works well for scaling.
  // We use one persistent transport here because our IMAP connection is also persistent,
  // which simplifies bookkeeping and matches MCP session model.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  app.all("/mcp", async (req, res) => {
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error("Error handling MCP request", { message: (err as Error).message });
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, version: "0.1.0" });
  });

  app.listen(cfg.transport.httpPort, cfg.transport.httpHost, () => {
    log.info(`MCP listening on http://${cfg.transport.httpHost}:${cfg.transport.httpPort}/mcp`);
  });
}

function safeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

main().catch((err) => {
  process.stderr.write(`[FATAL] ${err?.stack ?? err}\n`);
  process.exit(1);
});
