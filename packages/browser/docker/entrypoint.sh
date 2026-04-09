#!/bin/bash
#
# Entrypoint for the @jiku/browser Chromium container.
#
# Order of operations:
#   1. dbus     — chromium logs warnings without it
#   2. Xvfb     — virtual X server on $DISPLAY
#   3. Fluxbox  — minimal WM so Chromium has decorations
#   4. Chromium — headful with --remote-debugging-port (loopback only)
#   5. wait     — block until Chromium's CDP port is reachable
#   6. nginx    — HTTP proxy on 0.0.0.0:$CDP_PORT → 127.0.0.1:19222
#                 (rewrites Host header to "localhost" so chromium's DNS
#                  rebinding protection accepts cross-container requests)
#   7. x11vnc   — VNC server bound to the Xvfb display
#   8. exec websockify — noVNC, runs as PID 1 so SIGTERM propagates
#
set -e

CHROME_INTERNAL_PORT=19222
LOG_DIR=/var/log/jiku-browser
mkdir -p "$LOG_DIR"

# ─── 1. dbus ──────────────────────────────────────────────────────────────
mkdir -p /var/run/dbus
dbus-daemon --system --fork >/dev/null 2>&1 || true

# ─── 2. Xvfb ──────────────────────────────────────────────────────────────
Xvfb "${DISPLAY}" -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH}" -ac \
  >"$LOG_DIR/xvfb.log" 2>&1 &

# Wait for Xvfb to come up by polling its UNIX socket
for _ in $(seq 1 50); do
  [ -S "/tmp/.X11-unix/X${DISPLAY#:}" ] && break
  sleep 0.1
done

# ─── 3. Fluxbox ───────────────────────────────────────────────────────────
fluxbox -display "${DISPLAY}" >"$LOG_DIR/fluxbox.log" 2>&1 &

# ─── 4. Chromium ──────────────────────────────────────────────────────────
# --no-sandbox is required because Docker Desktop on macOS/Windows does not
# expose unprivileged user namespaces to containers, so chromium's zygote
# fails with "No usable sandbox!" without it. We're already in an isolated
# container, so this is the standard pattern for headful chromium in Docker.
chromium \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --disable-software-rasterizer \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="${CHROME_INTERNAL_PORT}" \
  --remote-allow-origins=* \
  --display="${DISPLAY}" \
  --window-size="${SCREEN_WIDTH},${SCREEN_HEIGHT}" \
  --start-maximized \
  --no-first-run \
  --no-default-browser-check \
  --disable-default-apps \
  --disable-extensions \
  --disable-popup-blocking \
  --disable-translate \
  --disable-features=TranslateUI \
  --user-data-dir=/data/chrome-data \
  about:blank \
  >"$LOG_DIR/chromium.log" 2>&1 &
CHROMIUM_PID=$!

# ─── 5. Wait until CDP is reachable ───────────────────────────────────────
echo "[entrypoint] waiting for chromium CDP on 127.0.0.1:${CHROME_INTERNAL_PORT}"
for i in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${CHROME_INTERNAL_PORT}/json/version"; then
    echo "[entrypoint] chromium CDP is ready (after ${i} attempts)"
    break
  fi
  if ! kill -0 "$CHROMIUM_PID" 2>/dev/null; then
    echo "[entrypoint] FATAL: chromium exited before becoming ready" >&2
    echo "[entrypoint] tail of $LOG_DIR/chromium.log:" >&2
    tail -n 50 "$LOG_DIR/chromium.log" >&2 || true
    exit 1
  fi
  sleep 0.5
done

if ! curl -fsS -o /dev/null "http://127.0.0.1:${CHROME_INTERNAL_PORT}/json/version"; then
  echo "[entrypoint] FATAL: chromium did not become ready in time" >&2
  echo "[entrypoint] tail of $LOG_DIR/chromium.log:" >&2
  tail -n 50 "$LOG_DIR/chromium.log" >&2 || true
  exit 1
fi

# ─── 6. nginx CDP proxy ────────────────────────────────────────────────────
# nginx sits in front of chromium's internal debug port and rewrites the
# inbound Host header to "localhost". Without this, chromium's DNS rebinding
# protection rejects every /json/* request whose Host header is not
# localhost / 127.0.0.1 / an IP — which is exactly what happens when this
# container is reached from another docker service by its compose alias
# (e.g. `bitorex-...-chrome-1`). The chrome's reply is:
#
#   "Host header is specified and is not an IP address or localhost."
#
# nginx also handles the WebSocket upgrade for the CDP connection that
# agent-browser opens after fetching /json/version.
#
# A previous version used `socat` here. socat is purely TCP and lets the
# Host header through unchanged, so it worked from the same machine but
# silently failed across docker services in production deployments.
mkdir -p /run /var/log/nginx
nginx -c /etc/jiku/nginx.conf

# Verify the proxy actually started. Chromium is already up at this point,
# so the proxied request should succeed immediately. If not, dump the nginx
# error log so the failure is visible in `docker compose logs`.
sleep 0.3
if ! curl -fsS -o /dev/null "http://127.0.0.1:${CDP_PORT}/json/version"; then
  echo "[entrypoint] FATAL: nginx CDP proxy did not come up on ${CDP_PORT}" >&2
  if [ -f "$LOG_DIR/nginx-error.log" ]; then
    echo "[entrypoint] tail of nginx-error.log:" >&2
    tail -n 50 "$LOG_DIR/nginx-error.log" >&2
  fi
  exit 1
fi
echo "[entrypoint] nginx CDP proxy listening on 0.0.0.0:${CDP_PORT}"

# ─── 7. x11vnc ────────────────────────────────────────────────────────────
x11vnc -display "${DISPLAY}" -forever -nopw -shared \
       -rfbport "${VNC_PORT}" -bg \
       -o "$LOG_DIR/x11vnc.log" >/dev/null 2>&1

# ─── 8. noVNC (foreground / PID 1) ────────────────────────────────────────
exec websockify --web=/usr/share/novnc "${NOVNC_PORT}" "localhost:${VNC_PORT}"
