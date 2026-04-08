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
    dbus-x11 \
    socat \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Create non-root user so Chromium runs without --no-sandbox
RUN groupadd -r browser && useradd -r -g browser -m -d /home/browser browser

# Environment
ENV DISPLAY=:99
ENV SCREEN_WIDTH=1280
ENV SCREEN_HEIGHT=720
ENV SCREEN_DEPTH=24
ENV VNC_PORT=5900
ENV NOVNC_PORT=6080
ENV CDP_PORT=9222

# Expose ports
# 9222 = CDP
# 6080 = noVNC (web-based VNC viewer)
EXPOSE ${CDP_PORT} ${NOVNC_PORT}

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
