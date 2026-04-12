# syntax=docker/dockerfile:1.7-labs
FROM oven/bun:1 AS base
WORKDIR /app

RUN apt-get update && apt-get install -y supervisor curl ca-certificates gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# ─── Install dependencies ────────────────────────────────────────────────
# Copy root lockfile + EVERY workspace manifest so bun can resolve
# `workspace:*` deps before installing.
FROM base AS deps
COPY package.json bun.lock ./
COPY packages/core/package.json ./packages/core/
COPY packages/kit/package.json ./packages/kit/
COPY packages/types/package.json ./packages/types/
COPY packages/ui/package.json ./packages/ui/
COPY packages/browser/package.json ./packages/browser/
COPY apps/studio/server/package.json ./apps/studio/server/
COPY apps/studio/web/package.json ./apps/studio/web/
COPY apps/studio/db/package.json ./apps/studio/db/
COPY apps/cli/package.json ./apps/cli/
# Every plugin manifest (each plugins/<id>/package.json) preserved via
# BuildKit's --parents flag. Adding a new plugin = drop a folder; no
# Dockerfile edit required.
COPY --parents plugins/*/package.json ./
RUN bun install

# ─── Build plugin UI bundles (Plan 17) ───────────────────────────────────
# Each plugin's `dist/ui/*.js` is produced by tsup and served to the browser
# by the Studio server at `/api/plugins/:id/ui/*`. Must run BEFORE the final
# image, otherwise the asset router returns 404 at runtime.
FROM deps AS plugin-builder
COPY . .
ENV NODE_ENV=production
RUN bun run jiku plugin build

# ─── Build web (Next.js) ─────────────────────────────────────────────────
# Reuses the plugin-builder stage so the final COPY picks up both web build
# output + plugin dist directories.
FROM plugin-builder AS web-builder
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN cd apps/studio/web && bun run build

# ─── Final image ─────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=web-builder /app/node_modules ./node_modules
COPY --from=web-builder /app/package.json ./package.json
COPY --from=web-builder /app/bun.lock ./bun.lock
COPY --from=web-builder /app/packages ./packages
COPY --from=web-builder /app/plugins ./plugins
COPY --from=web-builder /app/apps ./apps

COPY infra/dokploy/supervisord.conf /etc/supervisor/conf.d/jiku.conf

EXPOSE 3001 3000

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf"]
