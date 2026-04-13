# @jiku/camofox

Docker wrapper around [jo-inc/camofox-browser](https://github.com/jo-inc/camofox-browser) — a Firefox-based anti-fingerprint browser with a REST API on port 9377.

Upstream does not publish a pre-built image, so we build our own from source at a pinned ref. The Dockerfile here clones the upstream repo at build time, runs `npm install` (which pulls Camoufox binaries for the target arch), and launches the server.

## Consumers

- `plugins/jiku.camofox` — Studio adapter that speaks the REST API.
- `apps/studio/server/docker-compose.browser.yml` — local dev stack.
- `infra/dokploy/docker-compose.browser.yml` — production stack.

## Build

```bash
cd packages/camofox
bun run docker:build          # → jiku-camofox:local
bun run docker:run            # → http://localhost:9377
```

## Pin the upstream ref

The Dockerfile accepts a build arg:

```bash
docker build --build-arg CAMOFOX_REF=<sha-or-tag> -t jiku-camofox:local ./docker
```

Default is `master`. Bump when upstream ships a breaking change.
