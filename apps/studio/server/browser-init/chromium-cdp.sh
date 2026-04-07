#!/bin/bash
# Run everything in background so container startup is not blocked

(
  # Wait for Wayland socket — linuxserver/chromium uses /config/.XDG/wayland-1
  for i in $(seq 1 60); do
    if [ -S /config/.XDG/wayland-1 ]; then
      break
    fi
    sleep 1
  done
  sleep 3  # extra buffer for the DE and any auto-launched Chromium to settle

  # Kill any Chromium already running (launched by the DE without CDP flags)
  pkill -f chromium-browser 2>/dev/null || true
  sleep 1

  # Re-launch Chromium with CDP enabled
  WAYLAND_DISPLAY=wayland-1 \
  XDG_RUNTIME_DIR=/config/.XDG \
  HOME=/config \
  chromium-browser \
    --remote-debugging-port=9222 \
    --remote-debugging-address=0.0.0.0 \
    --remote-allow-origins=* \
    --no-sandbox \
    --disable-dev-shm-usage \
    --no-first-run \
    --no-default-browser-check \
    --ozone-platform=wayland \
    about:blank &

  # Wait for CDP to be ready on localhost:9222
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
import socket, threading

def inject_origin(data):
    try:
        text = data.decode('utf-8', errors='replace')
    except Exception:
        return data
    if not text.startswith('GET ') or 'Upgrade: websocket' not in text:
        return data
    if 'Origin:' in text or 'origin:' in text:
        return data
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
