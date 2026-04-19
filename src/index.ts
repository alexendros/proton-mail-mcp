#!/usr/bin/env node
/**
 * Entry point del MCP server.
 *
 * Dos modos de arranque según `MCP_TRANSPORT`:
 *  - `stdio`: pensado para Claude Code CLI. Un único `McpServer` + `ImapClient`
 *    + `SmtpClient` viven lo que dura el proceso. stdout queda RESERVADO al
 *    protocolo JSON-RPC; los logs van siempre a stderr (ver `config.ts`).
 *  - `http`: transporte `StreamableHTTPServerTransport` detrás de Express.
 *    La app delega en `buildHttpApp` (ver `http.ts`), que crea un transport +
 *    McpServer nuevo **por sesión** (buena práctica del SDK 1.19+). La I/O
 *    contra Bridge sigue compartiendo un único par de pools IMAP/SMTP para
 *    evitar abrir conexiones duplicadas por cada request.
 *
 * Guardrails:
 *  - En HTTP exigimos `MCP_AUTH_TOKEN` siempre y, si `NODE_ENV=production`,
 *    `MCP_ALLOWED_ORIGINS` no vacío. Un deploy sin allowlist expone el bearer
 *    a cualquier navegador que nos alcance por DNS → fail-closed.
 *  - Handlers SIGINT/SIGTERM/SIGHUP cierran las conexiones a Bridge antes de
 *    salir. Necesario para no dejar sockets IMAP colgados en reinicios
 *    rápidos de Dokploy.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, createLogger } from "./config.js";
import { buildServer } from "./server.js";
import { buildHttpApp } from "./http.js";

async function main(): Promise<void> {
  // Primera línea de defensa: Zod valida env vars o peta con mensaje legible.
  // Exit 2 para distinguir error de configuración del error 1 de runtime.
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write(`[FATAL] Invalid configuration: ${(err as Error).message}\n`);
    process.stderr.write("Check your environment variables against .env.example\n");
    process.exit(2);
  }

  const log = createLogger(cfg.logLevel);

  // Rama stdio: cliente local (Claude Code). Sin red, sin auth — el proceso
  // confía en quien lo lance.
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

  // Rama HTTP: cliente remoto (Routines, dashboard propio).
  if (!cfg.transport.authToken) {
    process.stderr.write("[FATAL] HTTP mode requires MCP_AUTH_TOKEN. Generate one: openssl rand -hex 32\n");
    process.exit(2);
  }

  if (process.env.NODE_ENV === "production" && cfg.transport.allowedOrigins.length === 0) {
    process.stderr.write("[FATAL] HTTP mode in production requires MCP_ALLOWED_ORIGINS to be set\n");
    process.exit(2);
  }

  // `shared` mantiene vivos los pools IMAP/SMTP durante toda la vida del
  // proceso; cada sesión HTTP recibe un `McpServer` propio dentro de
  // `buildHttpApp`, pero todas reutilizan las mismas conexiones a Bridge.
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

/**
 * Gestión centralizada de señales del proceso. `cleanup` corre una sola vez
 * y cierra con exit 0 para que Docker/systemd lo marquen como shutdown
 * limpio (no reinicio por crash).
 */
function installSignalHandlers(log: ReturnType<typeof createLogger>, cleanup: () => Promise<void>): void {
  const handler = async (signal: string): Promise<void> => {
    log.info(`Shutting down (signal=${signal})…`);
    await cleanup();
    process.exit(0);
  };
  process.on("SIGINT", () => void handler("SIGINT"));
  process.on("SIGTERM", () => void handler("SIGTERM"));
  process.on("SIGHUP", () => void handler("SIGHUP"));
  // Crasheos silenciosos no deseados: los escribimos a stderr y matamos el
  // proceso para que el orquestador (Dokploy/docker) reinicie en vez de
  // dejar un servidor en estado inconsistente.
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
