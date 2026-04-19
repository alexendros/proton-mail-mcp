import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ImapClient } from "./imap.js";
import type { SearchObject } from "imapflow";
import { SmtpClient, buildForwardOptions, buildReplyOptions } from "./smtp.js";
import type { Config } from "./config.js";

type Logger = ReturnType<typeof import("./config.js").createLogger>;

export function buildServer(cfg: Config, log: Logger): { server: McpServer; imap: ImapClient; smtp: SmtpClient } {
  const imap = new ImapClient(cfg.bridge, log);
  const smtp = new SmtpClient(cfg.bridge, log);

  const server = new McpServer(
    { name: "proton-mail-mcp", version: "0.1.0" },
    {
      instructions:
        "Proton Mail via Proton Mail Bridge. Before any operation, call proton_list_folders to see available mailboxes. Use UIDs (not sequence numbers) when modifying messages. Bridge must be running and reachable at the configured host.",
    },
  );

  // ---------------------------------------------------------------------------
  // Folders
  // ---------------------------------------------------------------------------
  server.registerTool(
    "proton_list_folders",
    {
      title: "List mailboxes (folders/labels)",
      description:
        "Lists every IMAP mailbox exposed by Proton Bridge (system folders like INBOX/Sent/Trash and user labels/folders). Use the returned 'path' values as the mailbox argument in other tools. Call this first when the agent doesn't know the mailbox layout.",
      inputSchema: {
        response_format: z.enum(["markdown", "json"]).default("markdown").describe("Output format"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async ({ response_format }) => {
      const mbs = await imap.listMailboxes();
      if (response_format === "json") {
        return { content: [{ type: "text", text: JSON.stringify(mbs, null, 2) }] };
      }
      const lines = [
        "| Path | Name | Special-use | Flags |",
        "|---|---|---|---|",
        ...mbs.map((m) => `| \`${m.path}\` | ${m.name} | ${m.specialUse ?? "—"} | ${m.flags.join(", ") || "—"} |`),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "proton_create_folder",
    {
      title: "Create a mailbox (folder)",
      description: "Creates a new IMAP mailbox under the given path (e.g. 'Projects/Afiladocs').",
      inputSchema: { path: z.string().min(1).describe("Mailbox path to create") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ path }) => {
      const res = await imap.createMailbox(path);
      return { content: [{ type: "text", text: `Created ${res.path} (new=${res.created}).` }] };
    },
  );

  server.registerTool(
    "proton_mailbox_status",
    {
      title: "Get mailbox counts",
      description: "Returns total messages, unseen/unread count and recent count for a mailbox. Fast — useful for Routines to check 'do I have unread mail?'.",
      inputSchema: { mailbox: z.string().default("INBOX").describe("Mailbox path, e.g. INBOX") },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async ({ mailbox }) => {
      const s = await imap.mailboxStatus(mailbox);
      return {
        content: [
          {
            type: "text",
            text: `**${mailbox}** — total: ${s.messages}, unseen: ${s.unseen}, recent: ${s.recent}${s.uidNext ? `, uidNext: ${s.uidNext}` : ""}`,
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Listing and search
  // ---------------------------------------------------------------------------
  server.registerTool(
    "proton_list_emails",
    {
      title: "List emails in a mailbox",
      description:
        "Lists recent emails in a mailbox, newest first. Use pagination with offset+limit. Returns UID, from, to, subject, date, flags, size. Does NOT return the body — use proton_get_email for that.",
      inputSchema: {
        mailbox: z.string().default("INBOX"),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
        response_format: z.enum(["markdown", "json"]).default("markdown"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async ({ mailbox, limit, offset, response_format }) => {
      const { items, total } = await imap.listEmails(mailbox, limit, offset);
      if (response_format === "json") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { mailbox, total, count: items.length, offset, has_more: offset + items.length < total, next_offset: offset + items.length, items },
                null,
                2,
              ),
            },
          ],
        };
      }
      return { content: [{ type: "text", text: renderEmailList(items, mailbox, total, offset) }] };
    },
  );

  server.registerTool(
    "proton_search_emails",
    {
      title: "Search emails",
      description:
        "Keyword-search emails in a mailbox. Filter by text in any field, or restrict to subject/from/to/body. Combine with date range and unseen flag. Returns newest matches first, up to 'limit'. Use 'text' for a broad 'anywhere' match.",
      inputSchema: {
        mailbox: z.string().default("INBOX"),
        query: z.string().optional().describe("Keyword to search for"),
        fields: z
          .array(z.enum(["text", "subject", "from", "to", "body"]))
          .default(["text"])
          .describe("Which fields to search. 'text' = anywhere."),
        since: z.string().optional().describe("ISO date — only messages on/after this date"),
        before: z.string().optional().describe("ISO date — only messages before this date"),
        unseen_only: z.boolean().default(false).describe("Only return unread messages"),
        from_address: z.string().optional().describe("Restrict to messages from this address"),
        to_address: z.string().optional().describe("Restrict to messages to this address"),
        limit: z.number().int().min(1).max(100).default(25),
        response_format: z.enum(["markdown", "json"]).default("markdown"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async (args) => {
      const criteria: SearchObject = {};
      if (args.unseen_only) criteria.seen = false;
      if (args.since) criteria.since = new Date(args.since);
      if (args.before) criteria.before = new Date(args.before);
      if (args.from_address) criteria.from = args.from_address;
      if (args.to_address) criteria.to = args.to_address;
      if (args.query) {
        for (const f of args.fields) {
          if (f === "text") criteria.body = args.query;
          if (f === "subject") criteria.subject = args.query;
          if (f === "from" && !criteria.from) criteria.from = args.query;
          if (f === "to" && !criteria.to) criteria.to = args.query;
          if (f === "body") criteria.body = args.query;
        }
      }
      const { items, matched } = await imap.searchEmails(args.mailbox, criteria, args.limit);
      if (args.response_format === "json") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { mailbox: args.mailbox, matched, count: items.length, has_more: matched > items.length, items },
                null,
                2,
              ),
            },
          ],
        };
      }
      return {
        content: [
          { type: "text", text: `Matched ${matched} message(s), showing ${items.length}.\n\n${renderEmailList(items, args.mailbox, matched, 0)}` },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------
  server.registerTool(
    "proton_get_email",
    {
      title: "Read one email (full body)",
      description:
        "Fetches one email by UID, with headers, text/html body and attachment metadata. Use proton_get_attachment to download attachment bytes. Large HTML bodies are returned as-is — truncate client-side if needed.",
      inputSchema: {
        mailbox: z.string().default("INBOX"),
        uid: z.number().int().positive().describe("Message UID (from list/search)"),
        include_html: z.boolean().default(false).describe("Include HTML body in addition to text"),
        mark_as_read: z.boolean().default(false).describe("Mark the message as seen after fetching"),
        response_format: z.enum(["markdown", "json"]).default("markdown"),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false },
    },
    async ({ mailbox, uid, include_html, mark_as_read, response_format }) => {
      const msg = await imap.getEmail(mailbox, uid);
      if (!msg) {
        return { isError: true, content: [{ type: "text", text: `No message with UID ${uid} in ${mailbox}.` }] };
      }
      if (mark_as_read) await imap.setFlags(mailbox, uid, ["\\Seen"], []);
      const out = include_html ? msg : { ...msg, htmlBody: undefined };
      if (response_format === "json") {
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
      return { content: [{ type: "text", text: renderFullEmail(out) }] };
    },
  );

  server.registerTool(
    "proton_get_attachment",
    {
      title: "Download an attachment",
      description: "Returns the bytes of a specific attachment encoded as base64. Use the attachment index from proton_get_email.",
      inputSchema: {
        mailbox: z.string().default("INBOX"),
        uid: z.number().int().positive(),
        index: z.number().int().min(0).describe("Zero-based index in the attachments array"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async ({ mailbox, uid, index }) => {
      const att = await imap.getAttachment(mailbox, uid, index);
      if (!att) {
        return { isError: true, content: [{ type: "text", text: `Attachment #${index} not found for UID ${uid}.` }] };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ filename: att.filename, contentType: att.contentType, base64: att.base64 }),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Send / reply / forward
  // ---------------------------------------------------------------------------
  server.registerTool(
    "proton_send_email",
    {
      title: "Send an email",
      description:
        "Sends an email via Proton Bridge SMTP. 'from' is fixed to the configured address. Provide either text, html, or both. Attachments are base64-encoded bytes.",
      inputSchema: {
        to: z.array(z.string().email()).min(1).describe("Recipient addresses"),
        subject: z.string().min(1),
        text: z.string().optional(),
        html: z.string().optional(),
        cc: z.array(z.string().email()).optional(),
        bcc: z.array(z.string().email()).optional(),
        reply_to: z.string().email().optional(),
        attachments: z
          .array(
            z.object({
              filename: z.string(),
              content_base64: z.string(),
              content_type: z.string().optional(),
            }),
          )
          .optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      if (!args.text && !args.html) {
        return { isError: true, content: [{ type: "text", text: "Provide at least one of 'text' or 'html'." }] };
      }
      const res = await smtp.send({
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        text: args.text,
        html: args.html,
        replyTo: args.reply_to,
        attachments: args.attachments?.map((a) => ({
          filename: a.filename,
          contentBase64: a.content_base64,
          contentType: a.content_type,
        })),
      });
      return {
        content: [
          {
            type: "text",
            text: `Sent. messageId=${res.messageId} accepted=${res.accepted.length} rejected=${res.rejected.length}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "proton_reply_email",
    {
      title: "Reply to an email",
      description:
        "Replies to an existing message preserving threading (In-Reply-To, References). Set reply_all=true to include CC recipients. Set include_quote=true to quote the original.",
      inputSchema: {
        mailbox: z.string().default("INBOX"),
        uid: z.number().int().positive(),
        text: z.string().optional(),
        html: z.string().optional(),
        reply_all: z.boolean().default(false),
        include_quote: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      if (!args.text && !args.html) {
        return { isError: true, content: [{ type: "text", text: "Provide at least one of 'text' or 'html'." }] };
      }
      const opts = await buildReplyOptions(
        imap,
        args.mailbox,
        args.uid,
        { text: args.text, html: args.html },
        args.include_quote,
        args.reply_all,
        cfg.bridge.from,
      );
      if (!opts) return { isError: true, content: [{ type: "text", text: `Original UID ${args.uid} not found.` }] };
      if (opts.to.length === 0) return { isError: true, content: [{ type: "text", text: "Original has no reply-to address." }] };
      const res = await smtp.send(opts);
      return {
        content: [
          { type: "text", text: `Reply sent to ${opts.to.join(", ")}. messageId=${res.messageId} accepted=${res.accepted.length}` },
        ],
      };
    },
  );

  server.registerTool(
    "proton_forward_email",
    {
      title: "Forward an email",
      description: "Forwards an existing message to new recipients. Optionally includes original attachments.",
      inputSchema: {
        mailbox: z.string().default("INBOX"),
        uid: z.number().int().positive(),
        to: z.array(z.string().email()).min(1),
        text: z.string().optional(),
        html: z.string().optional(),
        include_attachments: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const opts = await buildForwardOptions(
        imap,
        args.mailbox,
        args.uid,
        args.to,
        { text: args.text, html: args.html },
        args.include_attachments,
      );
      if (!opts) return { isError: true, content: [{ type: "text", text: `Original UID ${args.uid} not found.` }] };
      const res = await smtp.send(opts);
      return {
        content: [{ type: "text", text: `Forwarded to ${args.to.join(", ")}. messageId=${res.messageId}` }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Modify
  // ---------------------------------------------------------------------------
  server.registerTool(
    "proton_flag_email",
    {
      title: "Flag / unflag emails",
      description:
        "Toggles per-message flags. Supported: 'read', 'unread', 'starred', 'unstarred'. For custom flags, pass add_flags/remove_flags directly.",
      inputSchema: {
        mailbox: z.string().default("INBOX"),
        uid: z.number().int().positive(),
        action: z.enum(["read", "unread", "starred", "unstarred", "custom"]).describe("Shorthand action"),
        add_flags: z.array(z.string()).optional().describe("Custom flags to add (action=custom only)"),
        remove_flags: z.array(z.string()).optional().describe("Custom flags to remove (action=custom only)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ mailbox, uid, action, add_flags, remove_flags }) => {
      let add: string[] = [];
      let remove: string[] = [];
      switch (action) {
        case "read":
          add = ["\\Seen"];
          break;
        case "unread":
          remove = ["\\Seen"];
          break;
        case "starred":
          add = ["\\Flagged"];
          break;
        case "unstarred":
          remove = ["\\Flagged"];
          break;
        case "custom":
          add = add_flags ?? [];
          remove = remove_flags ?? [];
          break;
      }
      const ok = await imap.setFlags(mailbox, uid, add, remove);
      return { content: [{ type: "text", text: ok ? `Flags updated on UID ${uid}.` : `Failed to update flags on UID ${uid}.` }] };
    },
  );

  server.registerTool(
    "proton_move_email",
    {
      title: "Move an email to another mailbox",
      description: "Moves a message by UID from one mailbox to another. Use proton_list_folders to see valid targets.",
      inputSchema: {
        from_mailbox: z.string(),
        uid: z.number().int().positive(),
        to_mailbox: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ from_mailbox, uid, to_mailbox }) => {
      const ok = await imap.moveEmail(from_mailbox, uid, to_mailbox);
      return { content: [{ type: "text", text: ok ? `Moved UID ${uid} → ${to_mailbox}` : `Move failed.` }] };
    },
  );

  server.registerTool(
    "proton_delete_email",
    {
      title: "Delete an email",
      description:
        "Deletes a message. Default mode='trash' moves it to Trash (reversible). mode='permanent' expunges immediately — cannot be undone.",
      inputSchema: {
        mailbox: z.string().default("INBOX"),
        uid: z.number().int().positive(),
        mode: z.enum(["trash", "permanent"]).default("trash"),
        trash_path: z.string().default("Trash").describe("Path of your Trash mailbox (find via proton_list_folders)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ mailbox, uid, mode, trash_path }) => {
      if (mode === "trash") {
        const ok = await imap.moveEmail(mailbox, uid, trash_path);
        return { content: [{ type: "text", text: ok ? `Moved UID ${uid} to ${trash_path}.` : "Delete-to-trash failed." }] };
      }
      const ok = await imap.deleteEmail(mailbox, uid);
      return { content: [{ type: "text", text: ok ? `Permanently deleted UID ${uid}.` : "Delete failed." }] };
    },
  );

  return { server, imap, smtp };
}

// -----------------------------------------------------------------------------
// Renderers
// -----------------------------------------------------------------------------
function renderEmailList(items: { uid: number; from?: string; subject?: string; date?: string; flags: string[] }[], mailbox: string, total: number, offset: number): string {
  if (items.length === 0) return `No messages in ${mailbox} (total: ${total}).`;
  const head = `**${mailbox}** — showing ${items.length} of ${total} (offset ${offset})\n\n| UID | Date | From | Subject | Flags |\n|---|---|---|---|---|`;
  const rows = items.map((m) => {
    const date = m.date ? m.date.slice(0, 16).replace("T", " ") : "—";
    const from = truncate(m.from ?? "—", 32);
    const subject = truncate(m.subject ?? "(no subject)", 50);
    const flags = m.flags.join(" ") || "—";
    return `| ${m.uid} | ${date} | ${from} | ${subject} | ${flags} |`;
  });
  return [head, ...rows].join("\n");
}

function renderFullEmail(m: {
  uid: number;
  from?: string;
  to: string[];
  cc: string[];
  subject?: string;
  date?: string;
  flags: string[];
  textBody?: string;
  htmlBody?: string;
  attachments: { filename?: string; contentType: string; size: number }[];
}): string {
  const lines = [
    `**Subject:** ${m.subject ?? "(no subject)"}`,
    `**From:** ${m.from ?? "—"}`,
    `**To:** ${m.to.join(", ") || "—"}`,
    m.cc.length > 0 ? `**Cc:** ${m.cc.join(", ")}` : null,
    `**Date:** ${m.date ?? "—"}`,
    `**UID:** ${m.uid}   **Flags:** ${m.flags.join(" ") || "—"}`,
    "",
    "---",
    "",
    m.textBody ?? "(no text body)",
  ].filter((x) => x !== null) as string[];
  if (m.attachments.length > 0) {
    lines.push("", "**Attachments:**");
    m.attachments.forEach((a, i) => {
      lines.push(`- [${i}] ${a.filename ?? "unnamed"} — ${a.contentType} — ${(a.size / 1024).toFixed(1)} KB`);
    });
  }
  if (m.htmlBody) {
    lines.push("", "---", "HTML body present (fetch with include_html=true and response_format=json to retrieve).");
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
