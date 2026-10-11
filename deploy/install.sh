#!/usr/bin/env bash
# deploy/install.sh — install Gemba on a Debian/Ubuntu host as a systemd service.
#
# Re-runnable: everything it touches is created if missing and overwritten if present, so the
# same command deploys a fresh host or updates a running one. It never edits a file it did not
# create, except the systemd unit it owns.
#
#   bash deploy/install.sh            # install or update from this checkout
#
# Reads (optional, from the environment):
#   GEMBA_LLM_KEY_FILE   file holding the AI tier key (never on a command line or in a log).
#                        Default gateway is the OpenCode one; an OpenRouter key also works by
#                        setting GEMBA_LLM_BASE_URL/GEMBA_LLM_MODEL. Without a key the app runs
#                        in labelled extractive mode.
#   GEMBA_BANK_BIN / GEMBA_BANK_ACCOUNT   receiving account for the VietQR transfer instruction
#   GEMBA_ADMIN_TOKEN    operator token; generated and stored if absent
#   GEMBA_PORT           default 8090
set -euo pipefail

APP_DIR=/opt/gemba
NODE_DIR=/opt/node22
ENV_DIR=/etc/gemba
DATA_DIR=/var/lib/gemba
PORT="${GEMBA_PORT:-8090}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "0. rename migration (a legacy installation is moved in place)"
# Runs before anything else: the migration is what moves the database, the config and the unit out of
# the old name. It exits immediately on a host that never used the old name.
bash "$SRC_DIR/deploy/migrate-rename.sh"

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
# Unpacking over the previous tree leaves files that the source no longer has: after the corpus was
# renamed, /opt/gemba/seed/corpus held both the old Vietnamese notes and the new English ones, and the
# seed read all of them. Clear everything except data/ first (the legacy database lives there, and
# step 4 migrates it), so the installed tree is exactly the source tree.
find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +
# The database never lives inside the checkout: a redeploy would otherwise drop live state.
tar czf - -C "$SRC_DIR" --exclude=data --exclude=.git --exclude='*.db*' . | tar xzf - -C "$APP_DIR"
echo "files: $(find "$APP_DIR" -type f | wc -l), version $(python3 -c "import json;print(json.load(open('$APP_DIR/package.json'))['version'])")"

say "3. runtime config -> $ENV_DIR/gemba.env (mode 600)"
mkdir -p "$ENV_DIR" "$DATA_DIR"
chmod 700 "$ENV_DIR"
# The key may be handed over as a file instead of an environment variable, so it never has to
# appear in a shell history, a command line or a deployment log.
if [ -z "${GEMBA_LLM_KEY:-}" ] && [ -n "${GEMBA_LLM_KEY_FILE:-}" ] && [ -f "${GEMBA_LLM_KEY_FILE}" ]; then
  GEMBA_LLM_KEY="$(head -1 "$GEMBA_LLM_KEY_FILE")"
  echo "LLM key read from $GEMBA_LLM_KEY_FILE"
fi
if [ -f "$ENV_DIR/gemba.env" ]; then
  echo "keeping the existing env file (edit $ENV_DIR/gemba.env to change keys)"
else
  cat > "$ENV_DIR/gemba.env" <<EOF
# Gemba runtime configuration. Mode 600 — holds the LLM key and the operator token.
GEMBA_PORT=$PORT
GEMBA_HOST=0.0.0.0
GEMBA_USER=${GEMBA_USER:-}
GEMBA_PASS=${GEMBA_PASS:-}
GEMBA_DATA_DIR=$DATA_DIR
GEMBA_LLM_KEY=${GEMBA_LLM_KEY:-}
# Default gateway: the OpenCode one. It speaks the same OpenAI-compatible protocol, and the model
# id below is the one *it* serves — a mismatched pair fails at the first question, not at install.
GEMBA_LLM_BASE_URL=${GEMBA_LLM_BASE_URL:-https://opencode.ai/zen/go/v1}
GEMBA_LLM_MODEL=${GEMBA_LLM_MODEL:-deepseek-v4.1-flash}
# The OpenCode gateway routes by session id; one stable id per installation.
GEMBA_LLM_SESSION=${GEMBA_LLM_SESSION:-$(cat /proc/sys/kernel/random/uuid)}
GEMBA_BANK_BIN=${GEMBA_BANK_BIN:-}
GEMBA_BANK_ACCOUNT=${GEMBA_BANK_ACCOUNT:-}
GEMBA_ADMIN_TOKEN=${GEMBA_ADMIN_TOKEN:-}
EOF
fi
chmod 600 "$ENV_DIR/gemba.env"

# An env file written by an earlier run predates any key added since, and the script keeps
# existing files rather than clobbering the operator's configuration. So every key that the
# current unit expects is added if it is missing — otherwise a new setting silently never
# applies, which is how the front gate looked configured while the instance stayed open.
for key in GEMBA_USER GEMBA_PASS; do
  if ! grep -q "^$key=" "$ENV_DIR/gemba.env"; then
    echo "$key=" >> "$ENV_DIR/gemba.env"
    echo "added the missing key $key to $ENV_DIR/gemba.env (empty — fill it in to use it)"
  fi
done
if [ -n "${GEMBA_USER:-}" ] && [ -n "${GEMBA_PASS:-}" ]; then
  sed -i "s|^GEMBA_USER=.*|GEMBA_USER=$GEMBA_USER|; s|^GEMBA_PASS=.*|GEMBA_PASS=$GEMBA_PASS|" "$ENV_DIR/gemba.env"
  echo "front gate set from this script's environment"
fi
chmod 600 "$ENV_DIR/gemba.env"

say "4. seed the corpus (idempotent: upserts by slug)"
set -a; . "$ENV_DIR/gemba.env"; set +a
cd "$APP_DIR"

# Migration for instances deployed before the app honoured its configured database path. Back then
# the service read $APP_DIR/data/gemba.db (a relative default) while this script seeded
# $DATA_DIR/gemba.db, so a live instance could sit on an empty corpus, or hold its questions in a
# file that lives inside the code directory. If the old file is there and the configured one is
# not, the old one is the one with the real state: move it rather than seed over the top of it.
OLD_DB="$APP_DIR/data/gemba.db"
CONFIGURED_DB="${GEMBA_DB:-$DATA_DIR/gemba.db}"
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
install -m 644 "$APP_DIR/deploy/gemba.service" /etc/systemd/system/gemba.service
systemctl daemon-reload
systemctl enable gemba.service
STARTED_AT=$(date +%s)
# `enable --now` does not restart a unit that is already running, so an update left the old process
# serving the old code and old database while the checks below — and the operator — saw a healthy
# instance. Restart explicitly, then prove the running process is the one just installed.
systemctl restart gemba.service
sleep 2
systemctl --no-pager --lines=8 status gemba.service || true
ACTIVE_SINCE=$(systemctl show gemba.service -p ActiveEnterTimestamp --value)
ACTIVE_EPOCH=$(date -d "$ACTIVE_SINCE" +%s 2>/dev/null || echo 0)
if [ "$ACTIVE_EPOCH" -lt "$STARTED_AT" ]; then
  echo "ERROR: the service did not restart — it is still the process started at $ACTIVE_SINCE."
  echo "       Everything below would be testing the previous build."
  exit 1
fi
echo "restarted at $ACTIVE_SINCE (pid $(systemctl show gemba.service -p MainPID --value))"
journalctl -u gemba.service --no-pager -n 6 -o cat | sed 's/^/  /' || true

say "6. verify over HTTP"
for i in 1 2 3 4 5; do
  if curl -fsS "http://127.0.0.1:$PORT/healthz"; then break; fi
  sleep 2
done
echo
echo "health above must show ok:true and the note count."
# One factual question through the live AI tier, so a broken key shows up here and not in front
# of a customer. It is a real question about a real note in the seeded corpus — and the installer
# then deletes the row it created: a verification step must not leave its own test data on the
# instance it just verified (the home page counts questions, and an operator cannot tell the
# installer's probe from a real one).
echo "live ask:"
# Behind the front gate the smoke question needs the same credentials a browser uses, otherwise
# the gate answers 401 and the check fails on a JSON parse instead of on the thing it tests.
AUTH=()
if [ -n "${GEMBA_USER:-}" ] && [ -n "${GEMBA_PASS:-}" ]; then AUTH=(-u "$GEMBA_USER:$GEMBA_PASS"); fi
PROBE_JSON="$(mktemp)"
PROBE_REF_FILE="$(mktemp)"
curl -fsS "${AUTH[@]}" -X POST "http://127.0.0.1:$PORT/api/ask" -H 'content-type: application/json' \
  -d '{"question":"the machine stops mid-shift — what should I check, and in what order?"}' -o "$PROBE_JSON"
python3 - "$PROBE_JSON" "$PROBE_REF_FILE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("  coverage:", d["coverage"], "| mode:", d["mode"], "| cited:", [c["title"] for c in d["citations"]])
open(sys.argv[2], "w").write(d.get("ref", ""))
PY
PROBE_REF="$(cat "$PROBE_REF_FILE")"
rm -f "$PROBE_JSON" "$PROBE_REF_FILE"
if [ -n "$PROBE_REF" ]; then
  PROBE_REF="$PROBE_REF" DB="$DATA_DIR/gemba.db" "$NODE_DIR/bin/node" -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.env.DB);
    const n = db.prepare("DELETE FROM questions WHERE ref = ?").run(process.env.PROBE_REF).changes;
    console.log("  probe question removed from the instance:", n, "row");
    db.close();'
fi

TOKEN="$(sed -n 's/^GEMBA_ADMIN_TOKEN=//p' "$ENV_DIR/gemba.env")"
if [ -z "$TOKEN" ]; then TOKEN="$(cat "$DATA_DIR/admin.token" 2>/dev/null || true)"; fi
cat <<EOF

Installed. Reachable on http://$(hostname -I | awk '{print $1}'):$PORT
  operator console: /qt/$TOKEN
  expert desks:     /c/demo-hung-7f3a91, /c/demo-lan-2c8d40, /c/demo-dung-91be55
Logs: journalctl -u gemba -f
EOF
