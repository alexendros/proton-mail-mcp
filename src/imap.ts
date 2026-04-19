/**
 * Cliente IMAP contra Proton Mail Bridge.
 *
 * Por qué `imapflow` en vez de `imap` / `node-imap`: soporte nativo async/await,
 * locks granulares por mailbox, `STARTTLS` correcto y compatibilidad con el
 * servidor IMAP personalizado de Bridge (gluon).
 *
 * Patrones usados:
 *  - **Conexión reutilizable**: `this.client` vive entre llamadas. `connect()`
 *    detecta si el cliente sigue `usable` y lo reutiliza; si cayó, lo tira y
 *    abre uno nuevo con retry + backoff.
 *  - **Mailbox locks**: `getMailboxLock()` garantiza que dos operaciones
 *    simultáneas sobre la misma mailbox (p. ej. list + search) no se pisen.
 *  - **UIDs siempre, seq nunca**: las tools de modificación (flags, move,
 *    delete) reciben UIDs del cliente y los pasan a imapflow con
 *    `{ uid: true }`. Seq numbers cambian entre sesiones; los UIDs no.
 *  - **Body parsing**: fetch con `source: true` → Buffer crudo → `mailparser`
 *    para extraer text/html/attachments. Más lento que fetch parcial, pero
 *    evita decodificar MIME a mano.
 */
import { ImapFlow, type ImapFlowOptions, type ListResponse, type FetchQueryObject, type SearchObject } from "imapflow";
import { simpleParser, type ParsedMail, type Attachment } from "mailparser";
import type { Config } from "./config.js";

export interface EmailSummary {
  uid: number;
  seq: number;
  messageId: string | undefined;
  from: string | undefined;
  to: string[];
  subject: string | undefined;
  date: string | undefined;
  flags: string[];
  size: number | undefined;
  snippet?: string;
}

export interface EmailFull extends EmailSummary {
  cc: string[];
  bcc: string[];
  replyTo: string[];
  textBody: string | undefined;
  htmlBody: string | undefined;
  attachments: Array<{
    filename: string | undefined;
    contentType: string;
    size: number;
    contentId: string | undefined;
    checksum: string | undefined;
  }>;
  headers: Record<string, string>;
}

export interface MailboxInfo {
  path: string;
  name: string;
  delimiter: string;
  flags: string[];
  specialUse: string | undefined;
  subscribed: boolean;
  listed: boolean;
}

export class ImapClient {
  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;

  constructor(private readonly cfg: Config["bridge"], private readonly log: { debug: (m: string, e?: unknown) => void; info: (m: string, e?: unknown) => void; error: (m: string, e?: unknown) => void; }) {}

  private buildOpts(): ImapFlowOptions {
    return {
      host: this.cfg.host,
      port: this.cfg.imapPort,
      // Bridge presenta TLS directo (sin STARTTLS) en 1143.
      secure: true,
      // `rejectUnauthorized: false` necesario cuando Bridge usa cert
      // autofirmado en 127.0.0.1. En producción estricta se puede pinear
      // la CA de Bridge vía `PROTON_BRIDGE_CA_PATH` (roadmap).
      tls: { rejectUnauthorized: !this.cfg.tlsInsecure },
      auth: { user: this.cfg.user, pass: this.cfg.pass },
      // Silenciamos el logger de imapflow (pino) para que no compita con
      // nuestro logger stderr. Si hace falta debug, se reactiva aquí.
      logger: false,
      // Bridge soporta IDLE. 60s de keepalive = Bridge no nos tira por idle
      // timeout y nosotros no pagamos el coste de reconectar.
      maxIdleTime: 60_000,
    };
  }

  /** Returns a connected, authenticated client. Reuses existing connection when possible. */
  private async connect(): Promise<ImapFlow> {
    if (this.client && this.client.usable) return this.client;
    if (this.client && !this.client.usable) {
      this.log.debug("IMAP client no longer usable, discarding");
      try { await this.client.logout(); } catch { /* noop */ }
      this.client = null;
    }
    if (this.connecting) return this.connecting;

    this.connecting = this.connectWithRetry();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /**
   * Reintenta conectar hasta 3 veces con backoff exponencial (500 ms, 1 s, 2 s).
   *
   * Motivación: en despliegue con Docker Compose / Swarm, Bridge puede
   * tardar unos segundos en estar listo tras un reinicio. Sin retry, la
   * primera llamada después del reinicio falla con `ECONNREFUSED` y el MCP
   * devuelve error al modelo, que lo interpreta como "tool no disponible".
   */
  private async connectWithRetry(): Promise<ImapFlow> {
    const maxAttempts = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const c = new ImapFlow(this.buildOpts());
        c.on("error", (err) => this.log.error("IMAP error event", { message: err.message }));
        c.on("close", () => this.log.debug("IMAP connection closed"));
        this.log.debug("Connecting to Proton Bridge IMAP", { host: this.cfg.host, port: this.cfg.imapPort, attempt });
        await c.connect();
        this.log.info("IMAP connected", { attempt });
        this.client = c;
        return c;
      } catch (err) {
        lastErr = err;
        this.log.error("IMAP connect failed", { attempt, message: (err as Error).message });
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("IMAP connect failed");
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.logout();
      } catch (err) {
        this.log.debug("IMAP logout error (ignored)", { message: (err as Error).message });
      }
      this.client = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Mailboxes
  // ---------------------------------------------------------------------------

  async listMailboxes(): Promise<MailboxInfo[]> {
    const c = await this.connect();
    const raw: ListResponse[] = await c.list();
    return raw.map((m) => ({
      path: m.path,
      name: m.name,
      delimiter: m.delimiter,
      flags: Array.from(m.flags ?? []) as string[],
      specialUse: m.specialUse,
      subscribed: m.subscribed ?? false,
      listed: m.listed ?? true,
    }));
  }

  async createMailbox(path: string): Promise<{ path: string; created: boolean }> {
    const c = await this.connect();
    const res = await c.mailboxCreate(path);
    return { path: res.path, created: res.created };
  }

  async mailboxStatus(path: string): Promise<{ messages: number; unseen: number; recent: number; uidNext?: number; uidValidity?: number }> {
    const c = await this.connect();
    const s = await c.status(path, { messages: true, unseen: true, recent: true, uidNext: true, uidValidity: true });
    return {
      messages: s.messages ?? 0,
      unseen: s.unseen ?? 0,
      recent: s.recent ?? 0,
      uidNext: s.uidNext === undefined ? undefined : Number(s.uidNext),
      uidValidity: s.uidValidity === undefined ? undefined : Number(s.uidValidity),
    };
  }

  // ---------------------------------------------------------------------------
  // Listing and searching
  // ---------------------------------------------------------------------------

  /**
   * Lista mensajes recientes (primero los más nuevos) con paginación.
   *
   * Truco: IMAP no tiene un `ORDER BY date DESC LIMIT offset`. Para simular
   * paginación "newest-first" calculamos un rango de seq numbers desde el
   * final (`total - offset`) hacia atrás `limit` posiciones. Esto asume que
   * el orden de seq se corresponde con el orden de llegada — válido en
   * Bridge/Proton, pero si migramos a otro IMAP habría que usar SORT.
   */
  async listEmails(mailbox: string, limit: number, offset: number): Promise<{ items: EmailSummary[]; total: number }> {
    const c = await this.connect();
    const lock = await c.getMailboxLock(mailbox);
    try {
      const status = await c.status(mailbox, { messages: true });
      const total = status.messages ?? 0;
      if (total === 0) return { items: [], total: 0 };

      // Ventana desde el final: si total=1000 y offset=0, end=1000, start=976
      // (25 últimos mensajes). offset=25 → end=975, start=951.
      const end = total - offset;
      const start = Math.max(1, end - limit + 1);
      if (end < 1) return { items: [], total };

      const items: EmailSummary[] = [];
      for await (const msg of c.fetch(`${start}:${end}`, this.summaryFetchQuery(), { uid: false })) {
        items.push(this.toSummary(msg));
      }
      items.sort((a, b) => b.seq - a.seq);
      return { items, total };
    } finally {
      lock.release();
    }
  }

  async searchEmails(
    mailbox: string,
    criteria: SearchObject,
    limit: number,
  ): Promise<{ items: EmailSummary[]; matched: number }> {
    const c = await this.connect();
    const lock = await c.getMailboxLock(mailbox);
    try {
      const searchResult = await c.search(criteria, { uid: true });
      const uids: number[] = Array.isArray(searchResult) ? searchResult : [];
      const matched = uids.length;
      if (matched === 0) return { items: [], matched };
      // Newest UIDs first
      const sorted = [...uids].sort((a, b) => b - a).slice(0, limit);
      const items: EmailSummary[] = [];
      for await (const msg of c.fetch(sorted, this.summaryFetchQuery(), { uid: true })) {
        items.push(this.toSummary(msg));
      }
      items.sort((a, b) => b.uid - a.uid);
      return { items, matched };
    } finally {
      lock.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Full message fetch
  // ---------------------------------------------------------------------------

  async getEmail(mailbox: string, uid: number): Promise<EmailFull | null> {
    const c = await this.connect();
    const lock = await c.getMailboxLock(mailbox);
    try {
      const msg = await c.fetchOne(String(uid), { source: true, flags: true, envelope: true, uid: true, size: true }, { uid: true });
      if (!msg || !msg.source) return null;
      const parsed = await simpleParser(msg.source as Buffer);
      return this.toFull(msg, parsed);
    } finally {
      lock.release();
    }
  }

  async getAttachment(mailbox: string, uid: number, index: number): Promise<{ filename: string | undefined; contentType: string; base64: string } | null> {
    const c = await this.connect();
    const lock = await c.getMailboxLock(mailbox);
    try {
      const msg = await c.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) return null;
      const parsed = await simpleParser(msg.source as Buffer);
      const att: Attachment | undefined = parsed.attachments[index];
      if (!att) return null;
      return {
        filename: att.filename,
        contentType: att.contentType,
        base64: att.content.toString("base64"),
      };
    } finally {
      lock.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Modifications
  // ---------------------------------------------------------------------------

  async setFlags(mailbox: string, uid: number, add: string[], remove: string[]): Promise<boolean> {
    const c = await this.connect();
    const lock = await c.getMailboxLock(mailbox);
    try {
      let ok = true;
      if (add.length > 0) ok = (await c.messageFlagsAdd(String(uid), add, { uid: true })) && ok;
      if (remove.length > 0) ok = (await c.messageFlagsRemove(String(uid), remove, { uid: true })) && ok;
      return ok;
    } finally {
      lock.release();
    }
  }

  async moveEmail(fromMailbox: string, uid: number, toMailbox: string): Promise<boolean> {
    const c = await this.connect();
    const lock = await c.getMailboxLock(fromMailbox);
    try {
      const res = await c.messageMove(String(uid), toMailbox, { uid: true });
      return !!res;
    } finally {
      lock.release();
    }
  }

  async deleteEmail(mailbox: string, uid: number): Promise<boolean> {
    const c = await this.connect();
    const lock = await c.getMailboxLock(mailbox);
    try {
      const res = await c.messageDelete(String(uid), { uid: true });
      return !!res;
    } finally {
      lock.release();
    }
  }

  async appendMessage(mailbox: string, raw: Buffer, flags: string[] = []): Promise<{ uid: number | undefined }> {
    const c = await this.connect();
    const res = await c.append(mailbox, raw, flags);
    if (!res) return { uid: undefined };
    return { uid: typeof res.uid === "number" ? res.uid : undefined };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private summaryFetchQuery(): FetchQueryObject {
    return {
      uid: true,
      flags: true,
      envelope: true,
      size: true,
      bodyStructure: false,
    };
  }

  private toSummary(msg: any): EmailSummary {
    const env = msg.envelope ?? {};
    return {
      uid: Number(msg.uid),
      seq: Number(msg.seq),
      messageId: env.messageId,
      from: addrListToString(env.from),
      to: addrListToArray(env.to),
      subject: env.subject,
      date: env.date instanceof Date ? env.date.toISOString() : env.date,
      flags: Array.from(msg.flags ?? []) as string[],
      size: msg.size,
    };
  }

  private toFull(msg: any, parsed: ParsedMail): EmailFull {
    const base = this.toSummary(msg);
    const headers: Record<string, string> = {};
    for (const [k, v] of parsed.headers.entries()) {
      headers[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
    return {
      ...base,
      cc: addressesToArray(parsed.cc),
      bcc: addressesToArray(parsed.bcc),
      replyTo: addressesToArray(parsed.replyTo),
      textBody: parsed.text ?? undefined,
      htmlBody: typeof parsed.html === "string" ? parsed.html : undefined,
      attachments: parsed.attachments.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
        contentId: a.contentId,
        checksum: a.checksum,
      })),
      headers,
    };
  }
}

// -----------------------------------------------------------------------------
// Address helpers
// -----------------------------------------------------------------------------
type EnvelopeAddress = { name?: string; address?: string; mailbox?: string; host?: string };

function addrListToString(list: EnvelopeAddress[] | undefined): string | undefined {
  if (!list || list.length === 0) return undefined;
  return list.map(envelopeAddrToString).filter(Boolean).join(", ");
}

function addrListToArray(list: EnvelopeAddress[] | undefined): string[] {
  if (!list) return [];
  return list.map(envelopeAddrToString).filter((s): s is string => !!s);
}

function envelopeAddrToString(a: EnvelopeAddress): string | undefined {
  const email = a.address ?? (a.mailbox && a.host ? `${a.mailbox}@${a.host}` : undefined);
  if (!email) return undefined;
  return a.name ? `${a.name} <${email}>` : email;
}

function addressesToArray(field: ParsedMail["to"] | ParsedMail["cc"] | ParsedMail["bcc"] | ParsedMail["replyTo"]): string[] {
  if (!field) return [];
  const list = Array.isArray(field) ? field : [field];
  const out: string[] = [];
  for (const item of list) {
    if (!item?.value) continue;
    for (const v of item.value) {
      if (v.address) out.push(v.name ? `${v.name} <${v.address}>` : v.address);
    }
  }
  return out;
}
