# proton-mail-mcp

[![CI](https://github.com/alexendros/proton-mail-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/alexendros/proton-mail-mcp/actions/workflows/ci.yml)
[![CodeQL](https://github.com/alexendros/proton-mail-mcp/actions/workflows/codeql.yml/badge.svg)](https://github.com/alexendros/proton-mail-mcp/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](./package.json)
[![MCP SDK](https://img.shields.io/badge/%40modelcontextprotocol%2Fsdk-%5E1.19-blue.svg)](https://github.com/modelcontextprotocol/typescript-sdk)

Servidor **[MCP (Model Context Protocol)](https://modelcontextprotocol.io)** para **Proton Mail** vía Proton Mail Bridge. Expone la bandeja — lectura, búsqueda, envío, mover, etiquetar, borrar — a cualquier cliente MCP con tipado estricto, anotaciones de seguridad y doble transporte (`stdio` y `streamable HTTP`).

> La garantía E2E de Proton se preserva: el cifrado y descifrado ocurren en Bridge, una máquina que controlas tú. Ni los servidores de Anthropic ni terceros ven tu correo descifrado — sólo el agente al que tú autorizas.

---

## Por qué existe este proyecto

Hay dos formas comunes de darle "ojos sobre el correo" a un asistente como Claude:

1. **Copiar y pegar** bloques de correo dentro del chat. Trabajoso, frágil y sin trazabilidad.
2. **OAuth contra un proveedor SaaS** (Gmail API, Microsoft Graph). Funciona pero expone los datos al proveedor y deja el agente fuera de una cuenta Proton Mail, que es E2E y no tiene API pública.

Este MCP resuelve ambos problemas sobre Proton Mail:

- **Interfaz MCP estándar.** Cualquier cliente compatible (Claude Code CLI, Claude Routines, SDK cliente en tu backend) puede llamar a las 13 tools sin implementar IMAP/SMTP.
- **Autohospedado.** El binario corre donde tú decidas — laptop, VPS, contenedor. Bridge hace la criptografía en el mismo host y nunca expone el vault a la red pública.
- **Dual transport.** `stdio` para cliente local (Claude Code en la CLI), `streamable HTTP` con bearer auth + allowlist de origen para clientes remotos (Routines, dashboards propios).

Este repositorio también sirve como **muestra pública de craft**: tests automatizados, hardening por capas, CI/CD completo y modelo de amenazas explícito — no es un boilerplate, es una pieza de producción.

---

## Estado actual

| Pieza | Estado |
|---|---|
| Smoke `stdio`: `initialize` + `tools/list` responden con las 13 tools | verificado |
| Typecheck strict (`tsc --noEmit`) sobre todo `src/` y `tests/` | verde |
| Suite Vitest: 4 archivos, **39 tests** (auth · config · smtp-helpers · http-transport) | verde |
| Build `tsc` a `dist/` + smoke integrado en `npm run smoke` | verde |
| Imagen Docker multi-stage para el MCP | construye |
| Imagen extendida `Dockerfile.bridge` (libfido2, dbus, pass, libGL, credential helpers) | construye |
| CI GitHub Actions (matrix Node 20/22, typecheck, test, build, smoke, `npm audit`, CodeQL) | configurado |
| Release workflow a `ghcr.io/alexendros/proton-mail-mcp` en push a `main` | configurado |
| Despliegue Dokploy en `https://protonmail.alexendros.me/mcp` | en progreso |

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            CONSUMIDORES MCP                             │
│                                                                         │
│   Claude Code CLI          Claude Routines         Backend propio       │
│   (stdio, local)           (HTTP, claude.ai)       (HTTP, tu código)    │
│         │                         │                       │             │
└─────────┼─────────────────────────┼───────────────────────┼─────────────┘
          │ JSON-RPC                │ HTTPS + Bearer        │ HTTPS + Bearer
          │                         │ + Origin allowlist    │
          ▼                         ▼                       ▼
    ┌──────────────────────────────────────────────────────────────┐
    │                      proton-mail-mcp                         │
    │     TypeScript · @modelcontextprotocol/sdk@^1.19             │
    │     Dual transport · Per-session StreamableHTTP              │
    │     Bearer timing-safe · Rate-limit 120/min/token            │
    │                                                              │
    │   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌─────────┐   │
    │   │config.ts │   │ auth.ts  │   │  http.ts │   │server.ts│   │
    │   │Zod env   │   │bearer    │   │Express + │   │ 13 MCP  │   │
    │   │validation│   │timing-   │   │per-sess. │   │ tools + │   │
    │   │stderr log│   │safe cmp  │   │transport │   │ Zod in  │   │
    │   └──────────┘   └──────────┘   └──────────┘   └────┬────┘   │
    │                                                     │        │
    │              ┌───────────────────┐   ┌──────────────┴──────┐ │
    │              │      imap.ts      │   │       smtp.ts       │ │
    │              │   imapflow pool   │   │   nodemailer pool   │ │
    │              │   retry+backoff   │   │   threading headers │ │
    │              │   mailbox locks   │   │   quote/forward     │ │
    │              └─────────┬─────────┘   └──────────┬──────────┘ │
    └────────────────────────┼────────────────────────┼────────────┘
                             │ IMAP 1143              │ SMTP 1025
                             │ STARTTLS               │ STARTTLS
                             ▼                        ▼
                    ┌────────────────────────────────────────┐
                    │         Proton Mail Bridge             │
                    │     (localhost o VPS interno)          │
                    │       FRONTERA CRIPTOGRÁFICA E2E       │
                    └────────────────┬───────────────────────┘
                                     │ OpenPGP + HTTPS
                                     ▼
                            ┌──────────────────┐
                            │ Proton Servers   │
                            │ (cifrado E2E)    │
                            └──────────────────┘
```

**Claves de diseño:**

- **Fontera cripto**: todo lo que está a la izquierda de Bridge opera sobre correo en claro. Bridge vive en una máquina que tú controlas, en una red que tú controlas. Nada se filtra a terceros.
- **Per-session HTTP transport**: un `StreamableHTTPServerTransport` por `Mcp-Session-Id` (recomendación del SDK). Evita bleed de estado entre clientes concurrentes (Routines + Command Center + CLI pueden convivir).
- **Pool persistente IMAP/SMTP**: se reutiliza una conexión a Bridge entre llamadas. Reconexión con retry + backoff exponencial si Bridge se reinicia.
- **Stderr-only logs**: en modo `stdio`, `stdout` está reservado a JSON-RPC. Contaminarlo rompería el protocolo.

---

## Las 13 tools

Todas las tools de lectura aceptan `response_format: "markdown" | "json"`.

| Tool | Tipo | Descripción |
|---|---|---|
| `proton_list_folders` | read | Lista mailboxes (INBOX, Sent, Trash, labels, carpetas custom) |
| `proton_create_folder` | write | Crea un mailbox nuevo |
| `proton_mailbox_status` | read | Contadores rápidos: total / unseen / recent |
| `proton_list_emails` | read | Lista paginada de mensajes recientes (UID, from, subject, date, flags) |
| `proton_search_emails` | read | Búsqueda con filtros combinables (`query`, `since`/`before`, `unseen_only`, `from_address`, `to_address`, `fields`) |
| `proton_get_email` | read | Mensaje completo: headers, cuerpo texto/HTML, metadata de adjuntos |
| `proton_get_attachment` | read | Descarga un adjunto en base64. `max_bytes` default 10 MB (hard cap 50 MB) con `truncated=true` explícito |
| `proton_send_email` | write | Envía texto/HTML + adjuntos. `from` fijo al configurado (no spoofing) |
| `proton_reply_email` | write | Responde preservando threading (`In-Reply-To` + `References`), con `reply_all` opcional y quote |
| `proton_forward_email` | write | Reenvía opcionalmente con adjuntos originales |
| `proton_flag_email` | write (idempotent) | `read` / `unread` / `starred` / `unstarred` / flags custom |
| `proton_move_email` | write | Mueve entre mailboxes por UID |
| `proton_delete_email` | **destructive** | Modo `trash` (default, reversible) o `permanent` (expunge inmediato) |

Cada tool se registra con `annotations` del SDK — `readOnlyHint`, `idempotentHint`, `destructiveHint`, `openWorldHint` — para que el modelo pueda razonar sobre el efecto antes de invocarla.

---

## Tres caminos de integración

### 1 · Claude Code CLI (local, stdio)

Ideal para el día a día en el workstation. Bridge corre en la máquina; el MCP se lanza vía stdio cuando Claude Code lo necesita.

```bash
claude mcp add --transport stdio proton-mail --scope user \
  --env PROTON_BRIDGE_USER=tu@proton.me \
  --env PROTON_BRIDGE_PASS=tu-bridge-password \
  --env PROTON_MAIL_FROM=tu@proton.me \
  --env PROTON_BRIDGE_TLS_INSECURE=true \
  --env MCP_TRANSPORT=stdio \
  -- node /ruta/absoluta/a/proton-mail-mcp/dist/index.js
```

Dentro de cualquier sesión de Claude Code, el comando `/mcp` muestra `proton-mail: connected` y las 13 tools. A partir de ahí, lenguaje natural: *"resume mis correos no leídos de la última semana por tema"*.

### 2 · Claude Routines (claude.ai, HTTP)

Routines necesita un endpoint HTTPS público. Tras desplegar en Dokploy (abajo), se añade como **Remote MCP Server**:

- URL: `https://tu-dominio.com/mcp`
- Authorization: `Bearer <MCP_AUTH_TOKEN>`

Y se programan rutinas declarativas:

> *"Cada lunes a las 9:00, busca en INBOX correos no leídos de los últimos 7 días, clasifícalos por tema (software / administraciones / finanzas / personal / legal), y envíame un resumen markdown a mi propia cuenta."*

### 3 · Backend propio (HTTP, SDK oficial o fetch)

El servidor habla JSON-RPC estándar. El ejemplo oficial usa `@modelcontextprotocol/sdk`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL(process.env.PROTON_MCP_URL!),
  { requestInit: { headers: { Authorization: `Bearer ${process.env.PROTON_MCP_TOKEN!}` } } },
);
const client = new Client({ name: "mi-backend", version: "1.0.0" });
await client.connect(transport);

const { content } = await client.callTool({
  name: "proton_search_emails",
  arguments: { query: "factura", unseen_only: true, limit: 10 },
});
```

Para ahorrarte esa dependencia, este repo incluye también un **cliente fetch de ~130 líneas** en `extras/` (ver [Integración en Next.js](#integración-en-nextjs)).

---

## Quickstart local

Prerrequisitos: **Node ≥ 20**, **Proton Mail Bridge** corriendo en el workstation (GUI o distrobox), y el *bridge password* a mano (no es tu password Proton — lo muestra Bridge en **Account → Mailbox password**).

```bash
git clone https://github.com/alexendros/proton-mail-mcp.git
cd proton-mail-mcp
npm install
npm run build
npm test        # 39 tests verdes
npm run smoke   # verifica stdio: initialize + tools/list
```

Crea `.env` desde el template:

```bash
cp .env.example .env
# edita PROTON_BRIDGE_USER, PROTON_BRIDGE_PASS y PROTON_MAIL_FROM
```

Arranca en modo stdio contra Bridge local:

```bash
PROTON_BRIDGE_USER=tu@proton.me \
PROTON_BRIDGE_PASS=xxx \
PROTON_MAIL_FROM=tu@proton.me \
PROTON_BRIDGE_TLS_INSECURE=true \
MCP_TRANSPORT=stdio \
node dist/index.js
```

O con el inspector oficial (UI gráfica para probar tools):

```bash
npm run inspect
# → abre http://localhost:6274
```

---

## Producción: Docker + Dokploy

El repo incluye todo para un despliegue autohospedado con dos contenedores: **bridge** (Proton Mail Bridge headless) y **mcp** (este servidor en HTTP). Traefik emite un cert Let's Encrypt automáticamente.

### 1. Variables en Dokploy

```env
PROTON_BRIDGE_USER=tu@proton.me
PROTON_BRIDGE_PASS=<se rellena tras login inicial>
PROTON_MAIL_FROM=tu@proton.me
MCP_AUTH_TOKEN=<openssl rand -hex 32>
MCP_ALLOWED_ORIGINS=https://claude.ai,https://tu-dashboard.com
LOG_LEVEL=info
```

Todas las variables se validan en arranque con Zod. En `NODE_ENV=production`, el servidor se niega a arrancar si `MCP_ALLOWED_ORIGINS` está vacío (evita exposición accidental a cualquier origen).

### 2. Login one-off al Bridge headless

La primera vez hay que iniciar sesión interactivamente en Bridge (TTY):

```bash
ssh tu-vps
docker run --rm -it \
  -v <volumen-bridge-data>:/root \
  --entrypoint /bin/bash proton-mail-mcp-bridge:latest \
  -c "/protonmail/proton-bridge --cli"
# dentro:
>>> login      # username/pass/2FA
>>> info       # anota el bridge password mostrado
>>> exit
```

Pega ese bridge password en `PROTON_BRIDGE_PASS` y redeploy. El volumen persiste el vault: siguientes arranques son automáticos.

### 3. Verificación

```bash
curl https://tu-dominio.com/healthz
# {"ok":true,"version":"0.1.0","sessions":0}

curl -X POST https://tu-dominio.com/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

### 4. Registrar en Claude Code remoto

```bash
claude mcp add --transport http proton-mail-remote --scope user \
  https://tu-dominio.com/mcp \
  -H "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

---

## Seguridad

La hoja completa está en [`SECURITY.md`](./SECURITY.md). Resumen de los controles activos:

- **Bearer timing-safe** (`src/auth.ts`): comparación byte-a-byte en tiempo constante, con early-return por longitud para no filtrar el tamaño del token esperado.
- **Origin allowlist** (`MCP_ALLOWED_ORIGINS`): cada request `/mcp` se valida contra la lista exacta. Mitigación de DNS rebinding.
- **Rate limit** 120 req/min por token (`express-rate-limit`, draft-7 headers).
- **Per-session transport**: un `StreamableHTTPServerTransport` por `Mcp-Session-Id`, eviction tras 30 min idle.
- **Attachment cap**: `max_bytes` default 10 MB (hard cap 50 MB), con `truncated=true` explícito cuando aplica. Evita que un adjunto hostil sature el contexto del LLM.
- **Stderr-only logging**: ningún cuerpo de request, ninguna credencial en logs.
- **Secrets fuera de git**: `.env.example` muestra la forma; los valores viven en Dokploy secrets / `.env` local con permisos `0600`.

Amenazas modeladas (T1–T7 en `SECURITY.md`): robo de bearer, DNS rebinding, SMTP relay abuse, prompt injection vía cuerpo de email, robo de credenciales IMAP, exfiltración vía adjuntos, downgrade TLS del canal Bridge local.

---

## Integración en Next.js

Si tu dashboard es un Next.js (por ejemplo, el [Developer Command Center](https://github.com/alexendros/developer-command-center) que hospeda las acciones reales), el patrón que uso es un cliente fetch minimalista — evita arrastrar el SDK MCP entero cuando sólo necesitas un par de llamadas:

```ts
// src/lib/mcp/proton.ts (extracto)
export async function fetchUnreadSummary(opts: { limit?: number } = {}) {
  const mcp = await connectProtonMcp();   // initialize + session id
  try {
    const call = await mcp.callTool("proton_search_emails", {
      mailbox: "INBOX",
      unseen_only: true,
      limit: opts.limit ?? 10,
      response_format: "json",
    });
    return JSON.parse(call.content[0].text);
  } finally {
    await mcp.close();
  }
}
```

Y una acción sobre el patrón *actions dispatcher* (Zod + auth + audit log append-only):

```ts
// src/lib/actions/handlers.ts
export async function mailUnreadSummary(p: { mailbox?: string; limit?: number }) {
  const summary = await fetchUnreadSummary({ limit: p.limit });
  return { providerRef: `mailbox:${summary.mailbox}`, result: summary };
}
```

Desde la UI, un `<ActionButton action="mail/unread-summary" />` dispara la llamada, pinta un toast, y deja rastro en el timeline append-only de `/acciones`.

---

## Calidad de código

```bash
npm run typecheck    # tsc --noEmit, strict mode
npm test             # vitest run, 39 tests en 4 suites
npm run smoke        # initialize + tools/list stdio
```

**Lo que hay tests para:**

- `auth.test.ts` — `compareTokens` timing-safe en casos extremos (longitudes distintas, tokens vacíos, tokens hex de 64 chars).
- `config.test.ts` — Zod rechaza env missing, acepta defaults correctos, parsea CSV en `allowedOrigins`.
- `smtp-helpers.test.ts` — `prefixSubject` no duplica "Re:", `addrMatches` es case-insensitive, `collectReferences` preserva orden de threading.
- `http-transport.test.ts` — `GET /healthz` 200 sin auth, `POST /mcp` sin bearer 401, Origin inválido 403, `initialize` devuelve `Mcp-Session-Id`, rate limit middleware wired.

**CI pipeline:**

1. `verify` (matrix Node 20/22): install + typecheck + test + build + smoke
2. `audit`: `npm audit --audit-level=high`
3. `docker-build`: construye la imagen sin push (smoke)
4. `codeql`: análisis SAST JavaScript/TypeScript en push a main y semanal
5. `release` (en push a main): docker build + push a `ghcr.io/alexendros/proton-mail-mcp:{sha,latest}`

---

## Casos de uso reales

| Contexto | Flujo | Ganancia |
|---|---|---|
| **Triaje semanal** | Routine cada lunes 09:00 → clasifica no-leídos por tema → envía digest | 30 min → 0 min humanos |
| **Leads comerciales** | Routine cada 30 min → busca asuntos con "consulta" → extrae datos → crea lead en CRM | Menos fricción, más conversión |
| **Administraciones** | Routine diaria → detecta comunicaciones BOE/AEAT/AEPD → extrae plazos → tarea en Notion | Cero plazos perdidos |
| **Post-venta Stripe** | Webhook Stripe → route handler llama `proton_send_email` con plantilla + PDF | Email automatizado con un solo servicio |

Coste marginal de cada flujo nuevo una vez desplegado: **cero**.

---

## Stack técnico

| Pieza | Versión | Por qué |
|---|---|---|
| TypeScript | 5.7 | `strict` + `NodeNext` para catch-at-compile |
| Node | ≥20 | Fetch nativo, `node:crypto` estable, rendimiento en `imapflow` |
| `@modelcontextprotocol/sdk` | ^1.19 | SDK oficial; per-session `StreamableHTTPServerTransport` |
| `imapflow` | ^1.0 | IMAP moderno, async/await, lock de mailbox granular |
| `nodemailer` | ^6.9 | Estándar de facto para SMTP en Node, con pool |
| `mailparser` | ^3.7 | Decodifica MIME + adjuntos a estructura tipada |
| `zod` | ^3.23 | Validación de schemas a nivel tool + env vars |
| `express` | ^4.21 | Middleware para auth/rate-limit/origin allowlist |
| `express-rate-limit` | ^7.4 | 120 req/min por token |
| `vitest` | ^2.1 | Runner rápido con TypeScript nativo |
| `supertest` | ^7.0 | Tests del transport HTTP sin puerto real |

---

## Desarrollo

```
src/
├── index.ts      Arranque: stdio o HTTP, signal handlers, guardrails de producción
├── config.ts     Zod env validation + logger stderr
├── auth.ts       compareTokens timing-safe + extractBearer
├── http.ts       buildHttpApp: per-session StreamableHTTP + rate-limit + origin allowlist
├── imap.ts       ImapClient: pool + retry/backoff + mailbox locks
├── smtp.ts       SmtpClient: nodemailer pool + helpers de threading (reply/forward)
└── server.ts     McpServer con registro de las 13 tools (Zod in, markdown/json out)

tests/
├── auth.test.ts
├── config.test.ts
├── smtp-helpers.test.ts
└── http-transport.test.ts

scripts/
└── smoke.sh      initialize + tools/list sobre stdio, integrable en CI

.github/workflows/
├── ci.yml        lint/typecheck/test/build/smoke + npm audit + docker build
├── release.yml   push a ghcr.io en main y tags semver
└── codeql.yml    SAST JavaScript/TypeScript

Dockerfile          imagen mcp: multi-stage node:20-alpine
Dockerfile.bridge   imagen bridge: extiende shenxn/protonmail-bridge:build con libfido2,
                    dbus-x11, credential-helpers, libGL/libOpenGL y libs Qt XCB
docker-compose.yml  stack bridge + mcp con red proton-net interna +
                    dokploy-network externa para Traefik
```

---

## Roadmap abierto

- Tests E2E con Bridge de prueba (Greenmail + SMTP mock).
- `outputSchema` con `structuredContent` en las tools de lectura cuando el SDK lo materialice mejor.
- `proton_watch_inbox` con IDLE + webhook (flujos event-driven sin polling).
- Soporte multi-alias (Proton permite varias direcciones por cuenta).
- Bridge CA pinning opcional (`PROTON_BRIDGE_CA_PATH`) para cerrar `tlsInsecure` en producción estricta.

---

## Sobre este proyecto

Soy [**Alexendros**](https://alexendros.me) (Alejandro Domingo Agustí). Construyo productos SaaS con integración IA — este repositorio es una muestra del nivel de cuidado que aplico a cualquier pieza de infra que toco: tests antes de shippear, hardening antes de abrir puertos, docs antes de olvidar decisiones.

Si necesitas algo parecido para tu caso, cuéntamelo: `contacto [at] alexendros [dot] me`.

---

## Licencia

[MIT](./LICENSE) — úsalo, fórkalo, véndelo. Sin garantía.
