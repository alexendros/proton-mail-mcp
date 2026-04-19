# ---- Builder ----
FROM node:25-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime ----
FROM node:25-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=builder /app/dist ./dist

# Listen on all interfaces inside the container (network policy is enforced by Dokploy/reverse proxy)
ENV MCP_HTTP_HOST=0.0.0.0
ENV MCP_HTTP_PORT=8787
ENV MCP_TRANSPORT=http

EXPOSE 8787

# Simple healthcheck — relies on /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1

CMD ["node", "dist/index.js"]
