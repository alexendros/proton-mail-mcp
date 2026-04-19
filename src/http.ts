import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compareTokens, extractBearer } from "./auth.js";
import type { Config } from "./config.js";

type Logger = {
  debug: (m: string, e?: unknown) => void;
  info: (m: string, e?: unknown) => void;
  error: (m: string, e?: unknown) => void;
};

export interface HttpAppDeps {
  buildServer: () => McpServer;
  cfg: Config;
  log: Logger;
}

/**
 * Per-session transport + server pattern (recommended by MCP SDK).
 * One session = one transport = one McpServer instance. Session id travels
 * via `mcp-session-id` header.
 */
export function buildHttpApp(deps: HttpAppDeps): Express {
  const { buildServer, cfg, log } = deps;
  const expectedToken = cfg.transport.authToken ?? "";
  const allowedOrigins = new Set(cfg.transport.allowedOrigins);

  const app = express();
  app.use(express.json({ limit: "25mb" }));

  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer; lastUsed: number }>();

  app.use("/mcp", authMiddleware);

  app.all("/mcp", async (req: Request, res: Response) => {
    const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;
    try {
      let entry = sessionId ? sessions.get(sessionId) : undefined;

      if (!entry && req.method === "POST" && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            log.debug("MCP session initialized", { id });
          },
        });
        const server = buildServer();
        await server.connect(transport);
        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
            log.debug("MCP session closed", { id: transport.sessionId });
          }
        };
        await transport.handleRequest(req, res, req.body);
        if (transport.sessionId) {
          sessions.set(transport.sessionId, { transport, server, lastUsed: Date.now() });
        }
        return;
      }

      if (!entry) {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session. Send an initialize request first." }, id: null });
        return;
      }

      entry.lastUsed = Date.now();
      await entry.transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error("Error handling MCP request", { message: (err as Error).message });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal_error" }, id: null });
      }
    }
  });

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, version: "0.1.0", sessions: sessions.size });
  });

  setInterval(() => {
    const now = Date.now();
    const idleTimeout = 30 * 60 * 1000;
    for (const [id, entry] of sessions) {
      if (now - entry.lastUsed > idleTimeout) {
        entry.transport.close().catch(() => { /* noop */ });
        sessions.delete(id);
        log.debug("Evicted idle session", { id });
      }
    }
  }, 60_000).unref();

  return app;

  function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const origin = req.headers.origin as string | undefined;
    if (origin && allowedOrigins.size > 0 && !allowedOrigins.has(origin)) {
      res.status(403).json({ error: "origin_not_allowed" });
      return;
    }
    const token = extractBearer(req.headers.authorization as string | undefined);
    if (!compareTokens(token, expectedToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  }
}
