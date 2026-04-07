FROM oven/bun:1 AS base
WORKDIR /app

# Install supervisord and curl
RUN apt-get update && apt-get install -y supervisor curl && rm -rf /var/lib/apt/lists/*

# ─── Install dependencies ───────────────────────────────────────────────
FROM base AS deps
COPY package.json bun.lock* ./
COPY packages/ ./packages/
COPY apps/studio/server/package.json ./apps/studio/server/
COPY apps/studio/web/package.json ./apps/studio/web/
COPY apps/studio/db/package.json ./apps/studio/db/
# Copy any plugins that are workspace deps
COPY plugins/ ./plugins/
RUN bun install --frozen-lockfile

# ─── Build web (Next.js) ─────────────────────────────────────────────────
FROM deps AS web-builder
COPY . .
RUN cd apps/studio/web && bun run build

# ─── Final image ─────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app

# Copy installed node_modules + source
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/plugins ./plugins

# Copy source for server (runs via bun directly, no pre-bundling needed)
COPY apps/ ./apps/

# Copy pre-built Next.js output
COPY --from=web-builder /app/apps/studio/web/.next ./apps/studio/web/.next
COPY --from=web-builder /app/apps/studio/web/public ./apps/studio/web/public

# Copy supervisord config
COPY infra/dokploy/supervisord.conf /etc/supervisor/conf.d/jiku.conf

EXPOSE 3100 3000

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf"]
