# Self-contained CamoFox image. Clones the upstream repo at build time and
# runs its REST server on port 9377. Upstream does not publish a registry
# image, so this wrapper is our single source of truth.
#
# Docs: https://github.com/jo-inc/camofox-browser

FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Pin upstream ref — override at build time:
#   docker build --build-arg CAMOFOX_REF=<sha-or-tag> ...
ARG CAMOFOX_REF=master
ARG CAMOFOX_REPO=https://github.com/jo-inc/camofox-browser.git

# System deps:
#   • git, ca-certificates — clone upstream
#   • python3, make, g++    — npm packages with native build steps
#   • Firefox/Camoufox runtime libs — graphical + audio stack needed by the
#     anti-fingerprint Firefox fork that Camoufox ships
#   • xvfb                  — headless display server
#   • fonts-*, curl         — small QoL extras used by the upstream scripts
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl \
      python3 make g++ \
      xvfb dbus dbus-x11 \
      libasound2 libatk1.0-0 libatk-bridge2.0-0 libcairo2 libdbus-1-3 \
      libdbus-glib-1-2 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 \
      libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
      libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 \
      libxrender1 libxss1 libxtst6 \
      fonts-liberation fonts-noto-color-emoji \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Clone at the pinned ref. --depth 1 keeps the layer small; bump CAMOFOX_REF
# (not a branch) to get reproducible rebuilds.
RUN git clone --depth 1 --branch "${CAMOFOX_REF}" "${CAMOFOX_REPO}" . \
 && rm -rf .git

# Install deps. Upstream's postinstall (or an explicit `camoufox-js fetch`
# step) pulls the Camoufox Firefox binary for the current CPU arch.
# We try --omit=dev first; if scripts live in devDependencies, fall back.
RUN (npm ci --omit=dev 2>/dev/null || npm ci || npm install) \
 && npm cache clean --force

# Runtime defaults — overridable via docker-compose env.
ENV CAMOFOX_PORT=9377 \
    DISPLAY=:99

# Pre-create persistent dirs + Camoufox binary cache, then hand ownership to
# the unprivileged `node` user. The cache dir is where `camoufox fetch` writes
# the Firefox binary; without it CamoFox crashes at first /tabs call with:
#   "Version information not found at /home/node/.cache/camoufox/version.json"
RUN mkdir -p /home/node/.camofox/cookies /home/node/.cache/camoufox /data/camofox \
 && chown -R node:node /home/node/.camofox /home/node/.cache /data/camofox /app

USER node

# Download the Camoufox Firefox binary for the current CPU arch. Upstream's
# Makefile normally does this on the host BEFORE `docker build`; we bake it
# into the image instead so the container starts ready. Runs as `node` so the
# cache lands at /home/node/.cache/camoufox with the right ownership.
RUN npx --yes camoufox fetch \
 || npx --yes camoufox-js fetch \
 || npm run fetch

EXPOSE 9377

# Use `npm start` so we inherit whatever entrypoint upstream configures.
# If upstream renames the start script, update here.
CMD ["npm", "start"]
