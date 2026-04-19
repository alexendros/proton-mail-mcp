# Security policy — proton-mail-mcp

## Supported versions

Only the `main` branch and the latest Docker image tag (`ghcr.io/alexendros/proton-mail-mcp:latest`) receive security fixes.

## Reporting a vulnerability

Email `security@alexendros.me` (PGP key in the website). Do not open public GitHub issues for vulnerabilities.

---

## Threat model

| Id | Threat | Likelihood | Impact | Mitigation |
|----|--------|------------|--------|------------|
| T1 | **MCP bearer token leaked** (logs, env dump, client-side) | Medium | High — full mailbox read/write on behalf of the user | Rotate with `openssl rand -hex 32`, update Dokploy + all consumers; rate limit caps abuse to 120 req/min; auditoría mensual |
| T2 | **DNS rebinding** (local network attacker causes victim's browser to hit `localhost:8787`) | Low | High | `MCP_ALLOWED_ORIGINS` allowlist enforced on every request; in production the server refuses to start without it |
| T3 | **SMTP relay abuse via `proton_send_email`** (leaked token used for spam) | Medium | Medium | Rate limit by token; Proton Bridge enforces its own daily send limit; `from` is fixed to configured address (no spoofing) |
| T4 | **Prompt injection via email body** (hostile email instructs Claude to exfiltrate/destroy) | High (for any mail-reading agent) | High | Operators must instruct the LLM to treat bodies as untrusted; destructive tools (`proton_delete_email` mode=permanent) should require human confirmation; do not auto-forward or auto-reply based on untrusted body content |
| T5 | **IMAP credential theft from env** | Low | High — direct access to entire mailbox | Credentials only in Dokploy secrets / local `.env` (0600); never committed; rotated by regenerating Bridge mailbox password in the Bridge UI |
| T6 | **Attachment contents exfiltrated via LLM context** | Medium | Medium | `max_bytes` cap (default 10 MB, hard cap 50 MB) truncates large attachments; operator must review before forwarding |
| T7 | **Transport downgrade (MITM on local Bridge TLS)** | Low | Medium | Bridge listens on `127.0.0.1` by default; in Docker, stays inside the internal network. For paranoid setups set `PROTON_BRIDGE_CA_PATH` and `PROTON_BRIDGE_TLS_INSECURE=false` to pin Bridge's self-signed CA |

## Security controls present

- **Bearer token auth** on all `/mcp` requests, timing-safe comparison (`src/auth.ts`).
- **Origin allowlist** (`MCP_ALLOWED_ORIGINS`) — production refuses to start without it.
- **Rate limiting** — 120 req/min per token on `/mcp`.
- **Per-session transports** — one `StreamableHTTPServerTransport` per MCP session id, avoiding state bleed between clients.
- **Session idle eviction** — sessions unused for 30 min are closed.
- **Attachment size cap** — default 10 MB, hard cap 50 MB.
- **No secrets in logs** — logger writes to stderr only; request bodies are not logged.
- **Stdout reserved for MCP JSON-RPC** in stdio mode — logs go to stderr to avoid corrupting the protocol stream.

## Operator checklist before going live

- [ ] `MCP_AUTH_TOKEN` generated with `openssl rand -hex 32` and stored only in Dokploy secrets.
- [ ] `MCP_ALLOWED_ORIGINS` limited to exact values (`https://claude.ai`, `https://control.alexendros.me`).
- [ ] Dokploy webhook receives GHCR image pushes; `docker pull` uses digest pinning if possible.
- [ ] Bridge vault volume backed up weekly.
- [ ] Review routines quarterly — remove any that invoke destructive tools without human-in-the-loop.

## What this MCP does NOT protect against

- An attacker who controls the **Bridge host** itself (OS-level access) can read the vault.
- An attacker who **steals both your Proton account password AND the Bridge mailbox password** can impersonate you regardless of this MCP.
- The **E2E encryption guarantee of Proton stops at the Bridge boundary** — anything downstream (this MCP, Claude, Routines) operates on plaintext by design.
