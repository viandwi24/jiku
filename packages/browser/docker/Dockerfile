FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Install Chromium (works on both amd64 and arm64), noVNC, and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    chromium \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    fluxbox \
    procps \
    dbus \
    dbus-x11 \
    nginx-light \
    curl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Environment
ENV DISPLAY=:99
ENV SCREEN_WIDTH=1280
ENV SCREEN_HEIGHT=720
ENV SCREEN_DEPTH=24
ENV VNC_PORT=5900
ENV NOVNC_PORT=6080
ENV CDP_PORT=9222

# Pre-create Chromium data + log directories
RUN mkdir -p /data/chrome-data /var/log/jiku-browser

# Expose ports
# 9222 = CDP (via nginx HTTP proxy that rewrites Host header)
# 6080 = noVNC (web-based VNC viewer)
EXPOSE ${CDP_PORT} ${NOVNC_PORT}

# nginx config that rewrites the inbound Host header to "localhost" so
# chromium's DNS rebinding protection accepts the request when called from
# another docker service. See entrypoint.sh comments for the full story.
COPY nginx.conf /etc/jiku/nginx.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
