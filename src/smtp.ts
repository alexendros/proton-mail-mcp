/**
 * Cliente SMTP contra Proton Mail Bridge + helpers de threading.
 *
 * Dos piezas:
 *  1. `SmtpClient`: wrapper fino sobre `nodemailer` con pool persistente
 *     (maxConnections 2, maxMessages 50). Bridge habla SMTP con STARTTLS en
 *     1025 contra `127.0.0.1`. Cert autofirmado igual que IMAP.
 *  2. `buildReplyOptions` / `buildForwardOptions`: construyen un
 *     `SendOptions` respetando el estándar RFC 5322 de threading
 *     (`In-Reply-To` + `References`). Sin esto los clientes de correo
 *     tratarían la respuesta como hilo nuevo y romperían la conversación.
 */
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "./config.js";
import type { EmailFull, ImapClient } from "./imap.js";

export interface SendOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: Array<{
    filename: string;
    contentBase64: string;
    contentType?: string;
  }>;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response: string;
}

export class SmtpClient {
  private transporter: Transporter;

  constructor(private readonly cfg: Config["bridge"], private readonly log: { info: (m: string, e?: unknown) => void; debug: (m: string, e?: unknown) => void; }) {
    this.transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.smtpPort,
      // Bridge escucha SMTP submission con STARTTLS, no TLS directo.
      // secure=false + requireTLS=true = "inicia plaintext y súbete a TLS con STARTTLS, obligatorio".
      secure: false,
      requireTLS: true,
      tls: { rejectUnauthorized: !cfg.tlsInsecure },
      auth: { user: cfg.user, pass: cfg.pass },
      // Pool: 2 conexiones simultáneas es más que suficiente para un MCP —
      // los clientes llaman secuencialmente. maxMessages=50 recicla la
      // conexión cada 50 envíos para evitar leaks en Bridge.
      pool: true,
      maxConnections: 2,
      maxMessages: 50,
    });
  }

  async send(opts: SendOptions): Promise<SendResult> {
    const info = await this.transporter.sendMail({
      from: this.cfg.from,
      to: opts.to.join(", "),
      cc: opts.cc?.join(", "),
      bcc: opts.bcc?.join(", "),
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      replyTo: opts.replyTo,
      inReplyTo: opts.inReplyTo,
      references: opts.references,
      attachments: opts.attachments?.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.contentBase64, "base64"),
        contentType: a.contentType,
      })),
    });
    this.log.info("Email sent", { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected });
    return {
      messageId: info.messageId,
      accepted: (info.accepted ?? []) as string[],
      rejected: (info.rejected ?? []) as string[],
      response: info.response,
    };
  }

  async close(): Promise<void> {
    this.transporter.close();
  }
}

// -----------------------------------------------------------------------------
// Reply / Forward helpers: fetch original and build proper threaded send opts
// -----------------------------------------------------------------------------

/**
 * Construye un `SendOptions` para responder a un mensaje preservando hilo.
 *
 * Regla de `to`: usar `Reply-To` si existe (convención para listas/newsletters),
 * de lo contrario el `From` original. Regla de `cc` (reply_all): todos los
 * destinatarios originales menos nuestra propia dirección (evita loop) y los
 * ya incluidos en `to` (evita duplicados en el mismo correo).
 */
export async function buildReplyOptions(
  imap: ImapClient,
  mailbox: string,
  uid: number,
  body: { text?: string; html?: string },
  includeQuote: boolean,
  replyAll: boolean,
  ownAddress: string,
): Promise<SendOptions | null> {
  const original = await imap.getEmail(mailbox, uid);
  if (!original) return null;

  const subject = prefixSubject(original.subject, "Re: ");
  const to: string[] = original.replyTo.length > 0 ? original.replyTo : original.from ? [original.from] : [];
  const cc: string[] = replyAll
    ? [...original.to, ...original.cc].filter((a) => !addrMatches(a, ownAddress) && !isInList(a, to))
    : [];

  const refs = collectReferences(original);
  const quoted = includeQuote ? buildQuote(original, body) : body;

  return {
    to,
    cc,
    subject,
    text: quoted.text,
    html: quoted.html,
    inReplyTo: original.messageId,
    references: refs,
  };
}

export async function buildForwardOptions(
  imap: ImapClient,
  mailbox: string,
  uid: number,
  to: string[],
  body: { text?: string; html?: string },
  includeAttachments: boolean,
): Promise<SendOptions | null> {
  const original = await imap.getEmail(mailbox, uid);
  if (!original) return null;

  const subject = prefixSubject(original.subject, "Fwd: ");
  const forwarded = buildForwardBody(original, body);

  const attachments: SendOptions["attachments"] = [];
  if (includeAttachments && original.attachments.length > 0) {
    for (let i = 0; i < original.attachments.length; i++) {
      const meta = original.attachments[i]!;
      const data = await imap.getAttachment(mailbox, uid, i);
      if (data) {
        attachments.push({
          filename: meta.filename ?? `attachment-${i}`,
          contentBase64: data.base64,
          contentType: meta.contentType,
        });
      }
    }
  }

  return {
    to,
    subject,
    text: forwarded.text,
    html: forwarded.html,
    inReplyTo: original.messageId,
    references: collectReferences(original),
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

export function prefixSubject(subject: string | undefined, prefix: string): string {
  const s = (subject ?? "").trim();
  if (s.toLowerCase().startsWith(prefix.toLowerCase())) return s;
  return `${prefix}${s}`;
}

/**
 * Construye el valor del header `References` para mantener el hilo RFC 5322.
 *
 * La cadena acumulada es: todos los `References` previos + el `Message-ID`
 * del mensaje al que respondemos. Parseamos los anteriores como `<id>`
 * separados (pueden venir con saltos de línea y espacios variables).
 */
export function collectReferences(original: EmailFull): string[] {
  const refsHeader = original.headers["references"] ?? "";
  const existing: string[] = refsHeader.match(/<[^>]+>/g) ?? [];
  if (original.messageId) existing.push(original.messageId);
  return existing;
}

export function addrMatches(addr: string, target: string): boolean {
  const m = addr.match(/<([^>]+)>/);
  const email = (m?.[1] ?? addr).toLowerCase().trim();
  return email === target.toLowerCase().trim();
}

function isInList(addr: string, list: string[]): boolean {
  return list.some((a) => addrMatches(a, extractEmail(addr)));
}

export function extractEmail(s: string): string {
  const m = s.match(/<([^>]+)>/);
  return (m?.[1] ?? s).trim();
}

function buildQuote(original: EmailFull, body: { text?: string; html?: string }): { text?: string; html?: string } {
  const dateStr = original.date ?? "";
  const from = original.from ?? "";
  const header = `On ${dateStr}, ${from} wrote:`;
  const text =
    (body.text ?? "") +
    "\n\n" +
    header +
    "\n" +
    (original.textBody ?? "")
      .split("\n")
      .map((line) => "> " + line)
      .join("\n");
  const htmlQuote = original.htmlBody ?? escapeHtml(original.textBody ?? "").replace(/\n/g, "<br>");
  const html = body.html
    ? `${body.html}<br><br><div>${escapeHtml(header)}</div><blockquote style="border-left:2px solid #ccc;padding-left:8px;margin-left:0;">${htmlQuote}</blockquote>`
    : undefined;
  return { text, html };
}

function buildForwardBody(original: EmailFull, body: { text?: string; html?: string }): { text?: string; html?: string } {
  const header = [
    "---------- Forwarded message ----------",
    `From: ${original.from ?? ""}`,
    `Date: ${original.date ?? ""}`,
    `Subject: ${original.subject ?? ""}`,
    `To: ${original.to.join(", ")}`,
    "",
  ].join("\n");
  const text = (body.text ?? "") + "\n\n" + header + "\n" + (original.textBody ?? "");
  const htmlBody = original.htmlBody ?? escapeHtml(original.textBody ?? "").replace(/\n/g, "<br>");
  const html = body.html
    ? `${body.html}<br><br><div>${escapeHtml(header).replace(/\n/g, "<br>")}</div>${htmlBody}`
    : undefined;
  return { text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
