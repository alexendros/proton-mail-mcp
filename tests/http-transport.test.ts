import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { buildHttpApp } from "../src/http.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../src/config.js";

const silent = {
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
};

function cfg(overrides: Partial<Config["transport"]> = {}): Config {
  return {
    bridge: {
      user: "x@y.com",
      pass: "p",
      host: "127.0.0.1",
      imapPort: 1143,
      smtpPort: 1025,
      from: "x@y.com",
      tlsInsecure: true,
    },
    transport: {
      kind: "http",
      httpHost: "127.0.0.1",
      httpPort: 8787,
      authToken: "expected-token",
      allowedOrigins: [],
      ...overrides,
    },
    logLevel: "error",
  };
}

const miniServer = (): McpServer =>
  new McpServer({ name: "t", version: "1.0.0" }, { instructions: "test" });

describe("HTTP transport · auth and session lifecycle", () => {
  beforeEach(() => {
    silent.debug.mockReset();
    silent.info.mockReset();
    silent.error.mockReset();
  });

  it("GET /healthz returns 200 without auth", async () => {
    const app = buildHttpApp({ buildServer: miniServer, cfg: cfg(), log: silent });
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("POST /mcp without bearer returns 401", async () => {
    const app = buildHttpApp({ buildServer: miniServer, cfg: cfg(), log: silent });
    const res = await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("POST /mcp with wrong bearer returns 401", async () => {
    const app = buildHttpApp({ buildServer: miniServer, cfg: cfg(), log: silent });
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", "Bearer wrong-token")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(401);
  });

  it("POST /mcp with disallowed Origin returns 403", async () => {
    const app = buildHttpApp({
      buildServer: miniServer,
      cfg: cfg({ allowedOrigins: ["https://claude.ai"] }),
      log: silent,
    });
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", "Bearer expected-token")
      .set("Origin", "https://evil.com")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("origin_not_allowed");
  });

  it("POST /mcp with valid bearer but no session id and non-initialize body returns 400", async () => {
    const app = buildHttpApp({ buildServer: miniServer, cfg: cfg(), log: silent });
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", "Bearer expected-token")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe(-32000);
  });

  it("POST /mcp initialize returns MCP session id header and OK body", async () => {
    const app = buildHttpApp({ buildServer: miniServer, cfg: cfg(), log: silent });
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", "Bearer expected-token")
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      });
    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toMatch(/[0-9a-f-]{36}/);
  });

  it("timing-safe auth: short wrong token does not leak via status", async () => {
    const app = buildHttpApp({ buildServer: miniServer, cfg: cfg(), log: silent });
    const short = await request(app).post("/mcp").set("Authorization", "Bearer x").send({});
    const wrong = await request(app).post("/mcp").set("Authorization", "Bearer yy-very-different-length").send({});
    expect(short.status).toBe(401);
    expect(wrong.status).toBe(401);
  });
});
