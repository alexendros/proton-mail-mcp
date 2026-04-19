# proton-mail-mcp

MCP server para **Proton Mail** vía **Proton Mail Bridge** (IMAP + SMTP). TypeScript, 13 tools, doble transporte (`stdio` y `streamable HTTP`). Pensado para **Claude Code CLI en Linux**, **Claude Routines** y tu **Command Center**.

> Mantiene la garantía E2E de Proton: el cifrado/descifrado ocurre en Bridge, en una máquina que controlas tú.

---

## Estado verificado

- ✅ Typecheck limpio contra `@modelcontextprotocol/sdk@^1.19`, `imapflow@^1.0.189`, `nodemailer@^6.9.16`
- ✅ Build `tsc` sin errores
- ✅ Smoke test stdio end-to-end: `initialize` + `tools/list` responden con las **13 tools** y annotations (`readOnlyHint`, `idempotentHint`, `destructiveHint`, `openWorldHint`)
- ✅ Validación Zod de config con mensaje de error claro cuando faltan env vars
- ⚠ Modo HTTP **no probado end-to-end** en el entorno de build (sandbox sin stack de red). El SDK puro sí funciona en test aislado y `enableJsonResponse` (que rompía en v1.19) está eliminado. Primer despliegue en Dokploy: arranca con `LOG_LEVEL=debug` para ver trazas.

---

## Tools expuestas (13)

| Tool | Descripción | Tipo |
|---|---|---|
| `proton_list_folders` | Lista mailboxes (INBOX, Sent, Trash, labels, carpetas) | Read |
| `proton_create_folder` | Crea un nuevo mailbox | Write |
| `proton_mailbox_status` | Contadores rápidos (total, unseen, recent) | Read |
| `proton_list_emails` | Lista mensajes recientes con paginación | Read |
| `proton_search_emails` | Búsqueda por keyword y/o filtros (fecha, remitente, unseen) | Read |
| `proton_get_email` | Lee un mensaje completo (headers, cuerpo texto/HTML, adjuntos metadata) | Read |
| `proton_get_attachment` | Descarga un adjunto (base64) | Read |
| `proton_send_email` | Envía un email (texto/HTML + adjuntos) | Write |
| `proton_reply_email` | Responde preservando threading (In-Reply-To / References) | Write |
| `proton_forward_email` | Reenvía (opcionalmente con adjuntos originales) | Write |
| `proton_flag_email` | Marca leído / no-leído / starred; flags custom | Write |
| `proton_move_email` | Mueve un mensaje entre mailboxes | Write |
| `proton_delete_email` | Elimina (a Trash o permanente) | Destructive |

Todas las tools de lectura soportan `response_format: "markdown" | "json"`.

---

## Arquitectura

```
Consumidores                MCP server                  Bridge              Proton
┌──────────────┐   HTTP    ┌─────────────────┐   IMAP  ┌─────────────┐  HTTPS  ┌──────────┐
│ Claude       │◀────────▶│ proton-mail-mcp │◀──────▶│ Proton Mail │◀──────▶│  Proton  │
│ Routines     │           │   TypeScript    │   SMTP  │   Bridge    │         │  Servers │
│ Command Ctr. │           │  stdio + HTTP   │◀──────▶│ (GUI o CLI) │         │          │
│ Claude Code  │  stdio    │                 │         └─────────────┘         └──────────┘
└──────────────┘◀────────▶└─────────────────┘
```

---

## Modo A — Local en Fedora Silverblue con Claude Code CLI

Ideal para uso diario desde el workstation. Bridge corre en GUI, el MCP se lanza vía stdio cuando Claude Code lo invoca.

### 1. Instalar Proton Mail Bridge en Silverblue

Bridge oficial viene como `.rpm` o `.AppImage`. En Silverblue lo más limpio es distrobox (no contamina el host inmutable):

```bash
distrobox create --name proton-bridge --image fedora:40
distrobox enter proton-bridge
sudo dnf install -y https://proton.me/download/bridge/protonmail-bridge-<version>.rpm
protonmail-bridge &
```

Alternativa AppImage (portable, menos integración con keyring): `https://proton.me/mail/bridge-details`.

Dentro de Bridge: **Login** → **Account** → **Mailbox password**. Anota ese password (**NO** es el de tu cuenta Proton — es un password específico de Bridge para IMAP/SMTP).

### 2. Construir el MCP

```bash
git clone <tu-fork>/proton-mail-mcp
cd proton-mail-mcp
npm install
npm run build
```

Deberías ver `dist/index.js`. Verifica con smoke test (igual que el que corre en CI):

```bash
(
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
  sleep 0.3
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  sleep 0.3
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 0.5
) | PROTON_BRIDGE_USER=test@proton.me \
    PROTON_BRIDGE_PASS=x \
    PROTON_MAIL_FROM=test@proton.me \
    MCP_TRANSPORT=stdio \
    LOG_LEVEL=error \
    node dist/index.js
```

Debe responder con `initialize` (protocolVersion 2025-06-18) y una lista de 13 tools.

### 3. Registrar en Claude Code CLI

**Opción A — CLI (una línea):**

```bash
claude mcp add --transport stdio proton-mail \
  --scope user \
  --env PROTON_BRIDGE_USER=tu@proton.me \
  --env PROTON_BRIDGE_PASS=bridge-mailbox-password \
  --env PROTON_MAIL_FROM=tu@proton.me \
  --env PROTON_BRIDGE_TLS_INSECURE=true \
  --env MCP_TRANSPORT=stdio \
  -- node /ruta/absoluta/a/proton-mail-mcp/dist/index.js
```

`--scope user` → disponible en todos tus proyectos. Para un solo proyecto usa `--scope project` (queda en `.mcp.json` versionable) o `--scope local` (por defecto, solo tu usuario en ese proyecto).

**Opción B — editando `~/.claude.json` a mano** (útil con muchas env vars):

```json
{
  "mcpServers": {
    "proton-mail": {
      "type": "stdio",
      "command": "node",
      "args": ["/home/alejandro/code/proton-mail-mcp/dist/index.js"],
      "env": {
        "PROTON_BRIDGE_USER": "tu@proton.me",
        "PROTON_BRIDGE_PASS": "bridge-mailbox-password",
        "PROTON_MAIL_FROM": "tu@proton.me",
        "PROTON_BRIDGE_TLS_INSECURE": "true",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

### 4. Verificar dentro de Claude Code

```bash
claude
# dentro de la sesión:
/mcp
```

Deberías ver `proton-mail` con estado `connected` y 13 tools disponibles. Prueba: *"lista las carpetas de mi Proton Mail"*.

### 5. (Opcional) Inspector MCP

```bash
npx @modelcontextprotocol/inspector node dist/index.js
# abre http://localhost:6274 — GUI para probar tools manualmente
```

---

## Modo B — VPS Dokploy (Routines + Command Center remoto)

Para que **Claude Routines** pueda invocar el MCP, necesita ser accesible por HTTP público. Misma imagen, transporte HTTP.

### Arquitectura del stack

- Contenedor `bridge`: Proton Mail Bridge headless (imagen community `shenxn/protonmail-bridge`) con vault persistido en volumen
- Contenedor `mcp`: este servidor en modo HTTP con bearer auth y origin allowlist
- Traefik (gestionado por Dokploy) termina TLS y enruta a `mcp:8787`

### 1. Variables de entorno en Dokploy

```ini
PROTON_BRIDGE_USER=tu@proton.me
PROTON_BRIDGE_PASS=<se-rellena-tras-login-inicial>
PROTON_MAIL_FROM=tu@proton.me
MCP_AUTH_TOKEN=<openssl rand -hex 32>
MCP_ALLOWED_ORIGINS=https://claude.ai,https://command-center.tudominio.com
LOG_LEVEL=info
```

### 2. Login one-off en Bridge (obligatorio la primera vez)

El contenedor `bridge` necesita login interactivo una sola vez. Desde SSH al VPS:

```bash
cd /etc/dokploy/compose/<tu-app>/
docker compose run --rm bridge /bin/bash

# Dentro del contenedor:
/app/Bridge --cli
>>> login
# usuario Proton + password de cuenta + 2FA si aplica
>>> info
# copia el "bridge password" que muestra → pégalo en PROTON_BRIDGE_PASS en Dokploy
>>> exit
```

El volumen `bridge-data` persiste el vault. Los siguientes arranques serán automáticos.

### 3. Ajustar dominio Traefik

En `docker-compose.yml` sustituye `mcp-proton.example.com` por tu dominio real. Dokploy emitirá el cert Let's Encrypt.

### 4. Desplegar

Push al repo que Dokploy observa. Dokploy construye con el `Dockerfile` y levanta.

### 5. Verificar

```bash
# Healthcheck
curl https://mcp-proton.tudominio.com/healthz

# initialize
curl -X POST https://mcp-proton.tudominio.com/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

Si falla: `docker compose logs mcp` con `LOG_LEVEL=debug` para ver trazas.

### 6. Registrar el server remoto en Claude Code CLI

```bash
claude mcp add --transport http proton-mail-remote \
  --scope user \
  https://mcp-proton.tudominio.com/mcp \
  -H "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

### 7. Registrar en Claude Routines

En la UI de Routines (claude.ai), añade **Remote MCP Server**:

- URL: `https://mcp-proton.tudominio.com/mcp`
- Authorization header: `Bearer <MCP_AUTH_TOKEN>`

Ahora puedes programar rutinas tipo:

> *"Cada lunes a las 9:00, lista los correos no leídos de la última semana, clasifícalos por tema, y envíame un resumen."*

---

## Integración en Command Center (Next.js)

Si tu Command Center invoca el MCP directamente (sin Claude de intermediario):

```ts
// lib/proton-mcp.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function protonMcp() {
  const transport = new StreamableHTTPClientTransport(
    new URL(process.env.PROTON_MCP_URL!),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${process.env.PROTON_MCP_TOKEN!}` },
      },
    },
  );
  const client = new Client({ name: "command-center", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

// Uso en un route handler:
const client = await protonMcp();
const result = await client.callTool({
  name: "proton_search_emails",
  arguments: { query: "factura", unseen_only: true, limit: 10 },
});
```

Añade `https://command-center.tudominio.com` a `MCP_ALLOWED_ORIGINS`.

---

## Casos de uso monetizables

Una vez desplegado, el coste marginal por caso de uso adicional es 0.

| Vertical | Flujo | Ingreso esperado |
|---|---|---|
| **Afiladocs** | Routine cada 30min: busca unread con "consulta" → extrae datos → crea lead en CRM → reply automatizado | Reducción de fricción → más conversión de leads |
| **Productos digitales** | Al recibir email de Stripe, extrae detalles y registra venta en sheet de seguimiento | Tiempo 0 para alta de ventas |
| **Websites SEO clientes** | Botón en Command Center: generar informe mensual → template + adjuntar PDF → `proton_send_email` | Fidelización clientes recurrentes |
| **Empleo hostelería** | Routine diaria: buscar correos de portales (InfoJobs, LinkedIn) → resumen priorizado → marcar leídos | Ahorro tiempo búsqueda activa |

---

## Consideraciones de seguridad

| Aspecto | Tratamiento |
|---|---|
| TLS del Bridge local | Autofirmado; `PROTON_BRIDGE_TLS_INSECURE=true` acepta el cert de `127.0.0.1`. En Dokploy ocurre dentro del network Docker interno. Para producción estricta, importa la CA del Bridge y pon `false`. |
| Bearer token HTTP | Obligatorio en modo HTTP. Comparación timing-safe. Roto → regenera con `openssl rand -hex 32`. |
| DNS rebinding | `MCP_ALLOWED_ORIGINS` aplica allowlist sobre el header `Origin`. Vacío = no se valida origin (solo bearer). |
| Credenciales | `PROTON_BRIDGE_PASS` es el *mailbox password* de Bridge, no el password de tu cuenta Proton. Guárdalo solo en env vars / Dokploy secrets. |
| Logs | Salen a `stderr`. En modo stdio eso es crítico (stdout lo reserva MCP para JSON-RPC). |

---

## Desarrollo

```bash
npm install
npm run dev         # tsc --watch
npm run typecheck
npm run inspect     # abre el MCP Inspector
```

Estructura:

```
src/
├── index.ts    # Entry: elige transporte (stdio | http), auth, CORS
├── config.ts   # Validación Zod de env vars + logger stderr
├── imap.ts     # Pool IMAP persistente (imapflow) + operaciones lectura/modif
├── smtp.ts     # SMTP (nodemailer) + helpers reply/forward con threading
└── server.ts   # McpServer + registro de las 13 tools
```

---

## Roadmap sugerido

- [ ] Tests e2e con Bridge de prueba (Greenmail + SMTP mock)
- [ ] Output schemas (`structuredContent`) cuando el SDK lo materialice mejor
- [ ] Tool `proton_watch_inbox` usando IDLE + webhook a n8n (flujos event-driven en Command Center)
- [ ] Rate limiting por token en modo HTTP
- [ ] Soporte multi-alias (Proton permite varias direcciones por cuenta)

---

## Licencia

MIT
