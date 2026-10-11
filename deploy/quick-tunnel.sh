#!/usr/bin/env bash
# deploy/quick-tunnel.sh — publish this instance through a Cloudflare quick tunnel.
#
# A quick tunnel needs no Cloudflare account, no credentials and no DNS: it prints a random
# https://<name>.trycloudflare.com URL that anyone can open. That also means:
#   - the URL changes on every restart — read it from `journalctl -u gemba-tunnel | grep trycloudflare`
#     or /var/log/gemba-tunnel.log;
#   - it is for showing the product to someone today, not for a service anyone depends on.
# Set GEMBA_USER/GEMBA_PASS first. Without them the ask form is open to the internet, and every
# question spends money on a model.
#
# For a stable hostname, add one ingress entry to the managed tunnel instead
# (README § Publishing it to a hostname): <name>.<domain> -> http://<host>:<port>.
set -euo pipefail

BIN=/usr/local/bin/cloudflared
PORT="${GEMBA_PORT:-8090}"
ENV_FILE="${GEMBA_ENV_FILE:-/etc/gemba/gemba.env}"

if grep -qE '^GEMBA_PASS=.+$' "$ENV_FILE" 2>/dev/null; then
  echo "-> front gate is configured in $ENV_FILE"
else
  echo "!! $ENV_FILE has no GEMBA_PASS: the tunnel would publish an open ask form." >&2
  echo "   Set GEMBA_USER and GEMBA_PASS there, restart gemba.service, then re-run this." >&2
  exit 1
fi

if [ ! -x "$BIN" ]; then
  echo "-> installing cloudflared"
  curl -fsSL -o "$BIN" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x "$BIN"
fi
"$BIN" --version

cat > /etc/systemd/system/gemba-tunnel.service <<UNIT
[Unit]
Description=Cloudflare quick tunnel for Gemba (temporary public URL)
After=network-online.target gemba.service
Wants=network-online.target

[Service]
ExecStart=$BIN tunnel --no-autoupdate --url http://127.0.0.1:$PORT --logfile /var/log/gemba-tunnel.log --loglevel info
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now gemba-tunnel.service
for _ in 1 2 3 4 5 6 7 8; do
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /var/log/gemba-tunnel.log 2>/dev/null | head -1 || true)
  [ -n "$URL" ] && break
  sleep 3
done
echo "public URL: ${URL:-'(not in the log yet — journalctl -u gemba-tunnel | grep trycloudflare)'}"
