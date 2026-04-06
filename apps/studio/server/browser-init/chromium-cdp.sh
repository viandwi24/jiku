#!/bin/bash
# Run everything in background so container startup is not blocked

(
  # Wait for X display to be ready
  for i in $(seq 1 60); do
    if DISPLAY=:1 xdpyinfo >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  # Launch Chromium with CDP enabled
  DISPLAY=:1 chromium-browser \
    --remote-debugging-port=9222 \
    --remote-debugging-address=0.0.0.0 \
    --remote-allow-origins=* \
    --no-sandbox \
    --disable-dev-shm-usage \
    --no-first-run \
    --no-default-browser-check \
    about:blank &

  # Wait for Chrome CDP to be ready on localhost:9222
  for i in $(seq 1 30); do
    if curl -sf http://localhost:9222/json/version >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  # HTTP-aware proxy 0.0.0.0:9223 -> 127.0.0.1:9222
  # Injects "Origin: http://localhost" on WebSocket upgrade requests so that
  # Playwright (which sends no Origin) is accepted by Chrome's CDP server.
  python3 -c "
import socket, threading, re

def inject_origin(data):
    # Only modify HTTP upgrade requests (first chunk of a WebSocket handshake)
    try:
        text = data.decode('utf-8', errors='replace')
    except Exception:
        return data
    if not text.startswith('GET ') or 'Upgrade: websocket' not in text:
        return data
    if 'Origin:' in text or 'origin:' in text:
        return data  # already has Origin, leave it
    # Insert Origin header before the blank line that ends the headers
    text = text.replace('\r\n\r\n', '\r\nOrigin: http://localhost\r\n\r\n', 1)
    return text.encode('utf-8')

def fwd(src, dst, patch_first=False):
    first = True
    try:
        while True:
            d = src.recv(4096)
            if not d:
                break
            if patch_first and first:
                first = False
                d = inject_origin(d)
            dst.sendall(d)
    except:
        pass
    finally:
        try: src.close()
        except: pass
        try: dst.close()
        except: pass

def handle(src):
    try:
        dst = socket.create_connection(('127.0.0.1', 9222))
        threading.Thread(target=fwd, args=(src, dst, True), daemon=True).start()
        threading.Thread(target=fwd, args=(dst, src, False), daemon=True).start()
    except:
        src.close()

srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('0.0.0.0', 9223))
srv.listen(32)
while True:
    c, _ = srv.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
" &

) &
