FROM oven/bun:1 AS base
WORKDIR /app

RUN apt-get update && apt-get install -y supervisor curl ca-certificates gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# ─── Install dependencies ────────────────────────────────────────────────
FROM base AS deps
# Copy root lockfile + workspace manifests — bun needs ALL package.json
# files to resolve workspace: deps before installing
COPY package.json bun.lock ./
COPY packages/core/package.json ./packages/core/
COPY packages/kit/package.json ./packages/kit/
COPY packages/types/package.json ./packages/types/
COPY packages/ui/package.json ./packages/ui/
COPY apps/studio/server/package.json ./apps/studio/server/
COPY apps/studio/web/package.json ./apps/studio/web/
COPY apps/studio/db/package.json ./apps/studio/db/
COPY plugins/jiku.connector/package.json ./plugins/jiku.connector/
COPY plugins/jiku.cron/package.json ./plugins/jiku.cron/
COPY plugins/jiku.skills/package.json ./plugins/jiku.skills/
COPY plugins/jiku.social/package.json ./plugins/jiku.social/
COPY plugins/jiku.telegram/package.json ./plugins/jiku.telegram/
RUN bun install

# ─── Build web (Next.js) ─────────────────────────────────────────────────
FROM deps AS web-builder
# NEXT_PUBLIC_* vars are baked at build time — must be passed as build args
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY . .
RUN cd apps/studio/web && bun run build

# ─── Final image ─────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app

# Workspace source + installed deps
COPY --from=web-builder /app/node_modules ./node_modules
COPY --from=web-builder /app/packages ./packages
COPY --from=web-builder /app/plugins ./plugins
COPY --from=web-builder /app/apps ./apps

# Supervisord config
COPY infra/dokploy/supervisord.conf /etc/supervisor/conf.d/jiku.conf

EXPOSE 3001 3000

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf"]