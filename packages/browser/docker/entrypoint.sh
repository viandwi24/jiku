#!/bin/bash
set -e

# Internal port for Chromium CDP (not exposed directly)
CHROME_INTERNAL_PORT=19222

# Start Xvfb (virtual framebuffer)
Xvfb ${DISPLAY} -screen 0 ${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH} -ac &
sleep 1

# Start Fluxbox (lightweight window manager)
fluxbox -display ${DISPLAY} &
sleep 1

# Start Chromium as non-root user (no --no-sandbox needed, no warning banner)
su browser -c "chromium \
  --disable-gpu \
  --disable-dev-shm-usage \
  --disable-software-rasterizer \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=${CHROME_INTERNAL_PORT} \
  --display=${DISPLAY} \
  --window-size=${SCREEN_WIDTH},${SCREEN_HEIGHT} \
  --start-maximized \
  --no-first-run \
  --disable-default-apps \
  --disable-extensions \
  --user-data-dir=/home/browser/chrome-data \
  about:blank" &

sleep 2

# Proxy: forward public CDP_PORT (0.0.0.0:9222) → internal Chromium (127.0.0.1:19222)
# This makes both /json/* HTTP API and WebSocket CDP accessible from outside the container
socat TCP-LISTEN:${CDP_PORT},fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:${CHROME_INTERNAL_PORT} &

# Start VNC server (passwordless for dev)
x11vnc -display ${DISPLAY} -forever -nopw -shared -rfbport ${VNC_PORT} -bg

# Start noVNC (web-based VNC client)
websockify --web=/usr/share/novnc ${NOVNC_PORT} localhost:${VNC_PORT}
