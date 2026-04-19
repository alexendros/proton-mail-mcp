import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig · Zod env validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("PROTON_") || k.startsWith("MCP_") || k === "LOG_LEVEL") delete process.env[k];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws with clear error when PROTON_BRIDGE_USER is missing", () => {
    process.env.PROTON_BRIDGE_PASS = "x";
    process.env.PROTON_MAIL_FROM = "a@b.com";
    expect(() => loadConfig()).toThrow(/PROTON_BRIDGE_USER/);
  });

  it("throws when PROTON_MAIL_FROM is not a valid email", () => {
    process.env.PROTON_BRIDGE_USER = "a@b.com";
    process.env.PROTON_BRIDGE_PASS = "x";
    process.env.PROTON_MAIL_FROM = "not-an-email";
    expect(() => loadConfig()).toThrow();
  });

  it("defaults PROTON_MAIL_FROM to PROTON_BRIDGE_USER when unset", () => {
    process.env.PROTON_BRIDGE_USER = "alice@proton.me";
    process.env.PROTON_BRIDGE_PASS = "x";
    const cfg = loadConfig();
    expect(cfg.bridge.from).toBe("alice@proton.me");
  });

  it("parses tlsInsecure=false correctly", () => {
    process.env.PROTON_BRIDGE_USER = "a@b.com";
    process.env.PROTON_BRIDGE_PASS = "x";
    process.env.PROTON_MAIL_FROM = "a@b.com";
    process.env.PROTON_BRIDGE_TLS_INSECURE = "false";
    const cfg = loadConfig();
    expect(cfg.bridge.tlsInsecure).toBe(false);
  });

  it("parses MCP_ALLOWED_ORIGINS CSV into array", () => {
    process.env.PROTON_BRIDGE_USER = "a@b.com";
    process.env.PROTON_BRIDGE_PASS = "x";
    process.env.PROTON_MAIL_FROM = "a@b.com";
    process.env.MCP_ALLOWED_ORIGINS = "https://claude.ai, https://control.alexendros.me";
    const cfg = loadConfig();
    expect(cfg.transport.allowedOrigins).toEqual([
      "https://claude.ai",
      "https://control.alexendros.me",
    ]);
  });

  it("defaults to stdio transport when MCP_TRANSPORT unset", () => {
    process.env.PROTON_BRIDGE_USER = "a@b.com";
    process.env.PROTON_BRIDGE_PASS = "x";
    process.env.PROTON_MAIL_FROM = "a@b.com";
    const cfg = loadConfig();
    expect(cfg.transport.kind).toBe("stdio");
  });

  it("reads custom bridge host and ports from env", () => {
    process.env.PROTON_BRIDGE_USER = "a@b.com";
    process.env.PROTON_BRIDGE_PASS = "x";
    process.env.PROTON_MAIL_FROM = "a@b.com";
    process.env.PROTON_BRIDGE_HOST = "bridge";
    process.env.PROTON_BRIDGE_IMAP_PORT = "1143";
    process.env.PROTON_BRIDGE_SMTP_PORT = "1025";
    const cfg = loadConfig();
    expect(cfg.bridge.host).toBe("bridge");
    expect(cfg.bridge.imapPort).toBe(1143);
    expect(cfg.bridge.smtpPort).toBe(1025);
  });
});
