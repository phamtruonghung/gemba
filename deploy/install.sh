#!/usr/bin/env bash
# deploy/install.sh — install Xuong on a Debian/Ubuntu host as a systemd service.
#
# Re-runnable: everything it touches is created if missing and overwritten if present, so the
# same command deploys a fresh host or updates a running one. It never edits a file it did not
# create, except the systemd unit it owns.
#
#   bash deploy/install.sh            # install or update from this checkout
#
# Reads (optional, from the environment):
#   OPENROUTER_API_KEY   the AI tier's key; without it the app runs in labelled extractive mode
#   XUONG_BANK_BIN / XUONG_BANK_ACCOUNT   receiving account for the VietQR transfer instruction
#   XUONG_ADMIN_TOKEN    operator token; generated and stored if absent
#   XUONG_PORT           default 8090
set -euo pipefail

APP_DIR=/opt/xuong
NODE_DIR=/opt/node22
ENV_DIR=/etc/xuong
DATA_DIR=/var/lib/xuong
PORT="${XUONG_PORT:-8090}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "1. Node runtime (>= 22.5, for node:sqlite)"
if [ -x "$NODE_DIR/bin/node" ]; then
  echo "already installed: $("$NODE_DIR/bin/node" -v)"
else
  VER="$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys; print(next(r["version"] for r in json.load(sys.stdin) if r["version"].startswith("v22.")))')"
  echo "installing Node $VER into $NODE_DIR"
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/$VER/node-$VER-linux-x64.tar.xz" -o "$tmp/node.tar.xz"
  mkdir -p "$NODE_DIR"
  tar xJf "$tmp/node.tar.xz" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
  "$NODE_DIR/bin/node" -v
fi

say "2. application code -> $APP_DIR"
mkdir -p "$APP_DIR"
# The database never lives inside the checkout: a redeploy would otherwise drop live state.
tar czf - -C "$SRC_DIR" --exclude=data --exclude=.git --exclude='*.db*' . | tar xzf - -C "$APP_DIR"
echo "files: $(find "$APP_DIR" -type f | wc -l), version $(python3 -c "import json;print(json.load(open('$APP_DIR/package.json'))['version'])")"

say "3. runtime config -> $ENV_DIR/xuong.env (mode 600)"
mkdir -p "$ENV_DIR" "$DATA_DIR"
chmod 700 "$ENV_DIR"
# The key may be handed over as a file instead of an environment variable, so it never has to
# appear in a shell history, a command line or a deployment log.
if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -n "${XUONG_LLM_KEY_FILE:-}" ] && [ -f "${XUONG_LLM_KEY_FILE}" ]; then
  OPENROUTER_API_KEY="$(head -1 "$XUONG_LLM_KEY_FILE")"
  echo "LLM key read from $XUONG_LLM_KEY_FILE"
fi
if [ -f "$ENV_DIR/xuong.env" ]; then
  echo "keeping the existing env file (edit $ENV_DIR/xuong.env to change keys)"
else
  cat > "$ENV_DIR/xuong.env" <<EOF
# Xuong runtime configuration. Mode 600 — holds the LLM key and the operator token.
XUONG_PORT=$PORT
XUONG_HOST=0.0.0.0
XUONG_USER=${XUONG_USER:-}
XUONG_PASS=${XUONG_PASS:-}
XUONG_DATA_DIR=$DATA_DIR
XUONG_LLM_KEY=${OPENROUTER_API_KEY:-}
XUONG_LLM_BASE_URL=${XUONG_LLM_BASE_URL:-https://openrouter.ai/api/v1}
XUONG_LLM_MODEL=${XUONG_LLM_MODEL:-deepseek/deepseek-v4-flash-0731}
XUONG_BANK_BIN=${XUONG_BANK_BIN:-}
XUONG_BANK_ACCOUNT=${XUONG_BANK_ACCOUNT:-}
XUONG_ADMIN_TOKEN=${XUONG_ADMIN_TOKEN:-}
EOF
fi
chmod 600 "$ENV_DIR/xuong.env"

# An env file written by an earlier run predates any key added since, and the script keeps
# existing files rather than clobbering the operator's configuration. So every key that the
# current unit expects is added if it is missing — otherwise a new setting silently never
# applies, which is how the front gate looked configured while the instance stayed open.
for key in XUONG_USER XUONG_PASS; do
  if ! grep -q "^$key=" "$ENV_DIR/xuong.env"; then
    echo "$key=" >> "$ENV_DIR/xuong.env"
    echo "added the missing key $key to $ENV_DIR/xuong.env (empty — fill it in to use it)"
  fi
done
if [ -n "${XUONG_USER:-}" ] && [ -n "${XUONG_PASS:-}" ]; then
  sed -i "s|^XUONG_USER=.*|XUONG_USER=$XUONG_USER|; s|^XUONG_PASS=.*|XUONG_PASS=$XUONG_PASS|" "$ENV_DIR/xuong.env"
  echo "front gate set from this script's environment"
fi
chmod 600 "$ENV_DIR/xuong.env"

say "4. seed the corpus (idempotent: upserts by slug)"
set -a; . "$ENV_DIR/xuong.env"; set +a
cd "$APP_DIR"

# Migration for instances deployed before the app honoured its configured database path. Back then
# the service read $APP_DIR/data/xuong.db (a relative default) while this script seeded
# $DATA_DIR/xuong.db, so a live instance could sit on an empty corpus, or hold its questions in a
# file that lives inside the code directory. If the old file is there and the configured one is
# not, the old one is the one with the real state: move it rather than seed over the top of it.
OLD_DB="$APP_DIR/data/xuong.db"
CONFIGURED_DB="${XUONG_DB:-$DATA_DIR/xuong.db}"
if [ "$OLD_DB" != "$CONFIGURED_DB" ] && [ -f "$OLD_DB" ] && [ ! -f "$CONFIGURED_DB" ]; then
  echo "moving the old data file $OLD_DB -> $CONFIGURED_DB (it holds the live state)"
  mv "$OLD_DB" "$CONFIGURED_DB"
  # The WAL is part of the database — committed transactions live in it until a checkpoint. Move it
  # into place next to the new file, and only then drop the shared-memory file, which is rebuilt.
  [ -f "$OLD_DB-wal" ] && mv "$OLD_DB-wal" "$CONFIGURED_DB-wal" || true
  rm -f "$OLD_DB-shm"
fi
if [ "$OLD_DB" != "$CONFIGURED_DB" ] && [ -f "$OLD_DB" ] && [ -f "$CONFIGURED_DB" ]; then
  echo "note: both $OLD_DB and $CONFIGURED_DB exist — the service uses $CONFIGURED_DB."
  echo "      Check the old one with: node scripts/probe-db.mjs $OLD_DB $CONFIGURED_DB"
fi

"$NODE_DIR/bin/node" scripts/seed.mjs

say "5. systemd unit"
install -m 644 "$APP_DIR/deploy/xuong.service" /etc/systemd/system/xuong.service
systemctl daemon-reload
systemctl enable xuong.service
STARTED_AT=$(date +%s)
# `enable --now` does not restart a unit that is already running, so an update left the old process
# serving the old code and old database while the checks below — and the operator — saw a healthy
# instance. Restart explicitly, then prove the running process is the one just installed.
systemctl restart xuong.service
sleep 2
systemctl --no-pager --lines=8 status xuong.service || true
ACTIVE_SINCE=$(systemctl show xuong.service -p ActiveEnterTimestamp --value)
ACTIVE_EPOCH=$(date -d "$ACTIVE_SINCE" +%s 2>/dev/null || echo 0)
if [ "$ACTIVE_EPOCH" -lt "$STARTED_AT" ]; then
  echo "ERROR: the service did not restart — it is still the process started at $ACTIVE_SINCE."
  echo "       Everything below would be testing the previous build."
  exit 1
fi
echo "restarted at $ACTIVE_SINCE (pid $(systemctl show xuong.service -p MainPID --value))"
journalctl -u xuong.service --no-pager -n 6 -o cat | sed 's/^/  /' || true

say "6. verify over HTTP"
for i in 1 2 3 4 5; do
  if curl -fsS "http://127.0.0.1:$PORT/healthz"; then break; fi
  sleep 2
done
echo
echo "health above must show ok:true and the note count."
# One factual question through the live AI tier, so a broken key shows up here and not in front
# of a customer. It is a real question about a real note in the seeded corpus.
echo "live ask:"
# Behind the front gate the smoke question needs the same credentials a browser uses, otherwise
# the gate answers 401 and the check fails on a JSON parse instead of on the thing it tests.
AUTH=()
if [ -n "${XUONG_USER:-}" ] && [ -n "${XUONG_PASS:-}" ]; then AUTH=(-u "$XUONG_USER:$XUONG_PASS"); fi
curl -fsS "${AUTH[@]}" -X POST "http://127.0.0.1:$PORT/api/ask" -H 'content-type: application/json' \
  -d '{"question":"the machine stops mid-shift — what should I check, and in what order?"}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("  coverage:", d["coverage"], "| mode:", d["mode"], "| cited:", [c["title"] for c in d["citations"]])'

TOKEN="$(sed -n 's/^XUONG_ADMIN_TOKEN=//p' "$ENV_DIR/xuong.env")"
if [ -z "$TOKEN" ]; then TOKEN="$(cat "$DATA_DIR/admin.token" 2>/dev/null || true)"; fi
cat <<EOF

Installed. Reachable on http://$(hostname -I | awk '{print $1}'):$PORT
  operator console: /qt/$TOKEN
  expert desks:     /c/demo-hung-7f3a91, /c/demo-lan-2c8d40, /c/demo-dung-91be55
Logs: journalctl -u xuong -f
EOF
