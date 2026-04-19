import { describe, it, expect } from "vitest";
import { prefixSubject, addrMatches, extractEmail, collectReferences } from "../src/smtp.js";
import type { EmailFull } from "../src/imap.js";

describe("prefixSubject", () => {
  it("adds prefix when missing", () => {
    expect(prefixSubject("Hello", "Re: ")).toBe("Re: Hello");
  });

  it("does not duplicate prefix (case-insensitive)", () => {
    expect(prefixSubject("Re: Hello", "Re: ")).toBe("Re: Hello");
    expect(prefixSubject("RE: hello", "Re: ")).toBe("RE: hello");
  });

  it("handles undefined subject", () => {
    expect(prefixSubject(undefined, "Fwd: ")).toBe("Fwd: ");
  });

  it("trims whitespace", () => {
    expect(prefixSubject("  Hello  ", "Re: ")).toBe("Re: Hello");
  });
});

describe("addrMatches", () => {
  it("matches bare email", () => {
    expect(addrMatches("alice@example.com", "alice@example.com")).toBe(true);
  });

  it("matches name-form address", () => {
    expect(addrMatches("Alice <alice@example.com>", "alice@example.com")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(addrMatches("Alice <ALICE@Example.com>", "alice@example.com")).toBe(true);
  });

  it("returns false for different addresses", () => {
    expect(addrMatches("bob@example.com", "alice@example.com")).toBe(false);
  });
});

describe("extractEmail", () => {
  it("extracts email from name form", () => {
    expect(extractEmail("Alice <alice@example.com>")).toBe("alice@example.com");
  });

  it("returns bare email unchanged", () => {
    expect(extractEmail("alice@example.com")).toBe("alice@example.com");
  });
});

describe("collectReferences", () => {
  const base: EmailFull = {
    uid: 1,
    seq: 1,
    messageId: "<msg-3@example.com>",
    from: "a@example.com",
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: "s",
    date: undefined,
    flags: [],
    size: 0,
    textBody: "",
    htmlBody: undefined,
    attachments: [],
    headers: {},
  };

  it("collects References from header and appends current messageId", () => {
    const msg: EmailFull = { ...base, headers: { references: "<msg-1@x> <msg-2@x>" } };
    const refs = collectReferences(msg);
    expect(refs).toEqual(["<msg-1@x>", "<msg-2@x>", "<msg-3@example.com>"]);
  });

  it("returns only current messageId when no References header", () => {
    const refs = collectReferences(base);
    expect(refs).toEqual(["<msg-3@example.com>"]);
  });

  it("returns empty array when no References and no messageId", () => {
    const msg: EmailFull = { ...base, messageId: undefined };
    expect(collectReferences(msg)).toEqual([]);
  });
});
