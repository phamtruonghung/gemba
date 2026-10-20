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

# Read install-time operator credentials *before* the config file is sourced below: a GEMBA_ADMIN_PASSWORD
# sitting in the environment file is a stored password, and re-reading it here would silently reset the
# operator's password on every deploy.
ADMIN_PASSWORD_ARG="${GEMBA_ADMIN_PASSWORD:-}"
ADMIN_EMAIL_ARG="${GEMBA_ADMIN_EMAIL:-}"

say "0. rename migration (a legacy installation is moved in place)"
# Runs before anything else: the migration is what moves the database, the config and the unit out of
# the old name. It exits immediately on a host that never used the old name.
bash "$SRC_DIR/deploy/migrate-rename.sh"

say "1. Node runtime (pinned, >= 22.13 for node:sqlite)"
# Pinned, not "whatever nodejs.org lists first today": a deploy is the same runtime every time, and a
# newer one is a decision made here, in a diff. GEMBA_NODE_VERSION overrides it for a host that needs to.
NODE_VERSION=v22.23.3
VER="${GEMBA_NODE_VERSION:-$NODE_VERSION}"
if [ -x "$NODE_DIR/bin/node" ] && [ "$("$NODE_DIR/bin/node" -v)" = "$VER" ]; then
  echo "already installed: $VER"
else
  case "$(uname -m)" in
    x86_64|amd64) NODE_ARCH=x64 ;;
    aarch64|arm64) NODE_ARCH=arm64 ;;
    *) echo "unsupported architecture $(uname -m): install Node >= 22.13 yourself at $NODE_DIR" >&2; exit 1 ;;
  esac
  echo "installing Node $VER ($NODE_ARCH) into $NODE_DIR"
  tmp="$(mktemp -d)"
  TARBALL="node-$VER-linux-$NODE_ARCH.tar.xz"
  curl -fsSL "https://nodejs.org/dist/$VER/$TARBALL" -o "$tmp/$TARBALL"
  # Verify the download against the published checksum. This tarball becomes the runtime that answers
  # the operator's questions; an installer that skips this trusts whatever the network path returned.
  # The line for this very file is selected explicitly, so an empty match fails instead of checking nothing.
  curl -fsSL "https://nodejs.org/dist/$VER/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  ( cd "$tmp" && sha256sum -c - <<<"$(grep " $TARBALL\$" SHASUMS256.txt)" )
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar xJf "$tmp/$TARBALL" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
  "$NODE_DIR/bin/node" -v
fi
# Assert the floor instead of trusting the label: node:sqlite only exists from 22.13, and a runtime
# that cannot load it failed three steps later — after step 2 had already replaced the application
# tree — so the error arrived as "the service is unhealthy", not "this Node is too old".
"$NODE_DIR/bin/node" -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<13)){console.error(`node:sqlite needs Node >= 22.13, found ${process.versions.node}`);process.exit(1)} require("node:sqlite")' 

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
# Secrets are written below by deploy/set-env.py, never by this heredoc: an unquoted heredoc
# expands `$` and a backtick inside the value.
GEMBA_USER=
GEMBA_PASS=
GEMBA_DATA_DIR=$DATA_DIR
# GEMBA_LLM_KEY is written below, verbatim, by deploy/set-env.py
GEMBA_LLM_KEY=
# Default gateway: the OpenCode one. It speaks the same OpenAI-compatible protocol, and the model
# id below is the one *it* serves — a mismatched pair fails at the first question, not at install.
GEMBA_LLM_BASE_URL=${GEMBA_LLM_BASE_URL:-https://opencode.ai/zen/go/v1}
GEMBA_LLM_MODEL=${GEMBA_LLM_MODEL:-deepseek-v4.1-flash}
# The OpenCode gateway routes by session id; one stable id per installation.
GEMBA_LLM_SESSION=${GEMBA_LLM_SESSION:-$(cat /proc/sys/kernel/random/uuid)}
GEMBA_BANK_BIN=
GEMBA_BANK_ACCOUNT=
GEMBA_ADMIN_TOKEN=
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
# A password is data, not syntax. This used to be a `sed` replacement built out of the value: `&`
# expanded to the matched text, `|` broke the delimiter, and a space made the later sourced file
# execute the tail as a command. The installer then printed "front gate set" and exited 0 while the
# service held a password nobody knew.
if [ -n "${GEMBA_USER:-}" ] || [ -n "${GEMBA_PASS:-}" ]; then
  if [ -z "${GEMBA_USER:-}" ] || [ -z "${GEMBA_PASS:-}" ]; then
    echo "refusing a half-configured front gate: set both GEMBA_USER and GEMBA_PASS, or neither." >&2
    echo "  One of them alone used to leave the instance open to the internet." >&2
    exit 1
  fi
  python3 "$SRC_DIR/deploy/set-env.py" "$ENV_DIR/gemba.env" GEMBA_USER "$GEMBA_USER" GEMBA_PASS "$GEMBA_PASS"
  echo "front gate set from this script's environment (written verbatim, mode 600)"
fi
if [ -n "${GEMBA_LLM_KEY:-}" ]; then
  python3 "$SRC_DIR/deploy/set-env.py" "$ENV_DIR/gemba.env" GEMBA_LLM_KEY "$GEMBA_LLM_KEY"
  echo "LLM key written to $ENV_DIR/gemba.env (verbatim, mode 600)"
fi
# Same for the bank account and the operator token: they come from the environment, so they are data.
# A newline in GEMBA_ADMIN_TOKEN used to inject a line into the file the service reads.
for key in GEMBA_BANK_BIN GEMBA_BANK_ACCOUNT GEMBA_ADMIN_TOKEN; do
  if [ -n "${!key:-}" ]; then
    python3 "$SRC_DIR/deploy/set-env.py" "$ENV_DIR/gemba.env" "$key" "${!key}"
    echo "$key written to $ENV_DIR/gemba.env (verbatim, mode 600)"
  fi
done
chmod 600 "$ENV_DIR/gemba.env"

say "4. seed the corpus (idempotent: upserts by slug)"
# Read the two paths the seed and the operator step need, line by line. Sourcing this file would
# evaluate whatever an operator put in a value (`set -a; . gemba.env` splits on spaces and runs
# `$(...)`), which is the same class of bug as the sed rewrite above.
GEMBA_DATA_DIR="$(sed -n 's/^GEMBA_DATA_DIR=//p' "$ENV_DIR/gemba.env" | head -1)"
GEMBA_DB="$(sed -n 's/^GEMBA_DB=//p' "$ENV_DIR/gemba.env" | head -1)"
export GEMBA_DATA_DIR
if [ -n "$GEMBA_DB" ]; then export GEMBA_DB; fi
cd "$APP_DIR"

# Migration for instances deployed before the app honoured its configured database path. Back then
# the service read $APP_DIR/data/gemba.db (a relative default) while this script seeded
# $DATA_DIR/gemba.db, so a live instance could sit on an empty corpus, or hold its questions in a
# file that lives inside the code directory. If the old file is there and the configured one is
# not, the old one is the one with the real state: move it rather than seed over the top of it.
OLD_DB="$APP_DIR/data/gemba.db"
# The installer owns one data directory. If the config points somewhere else — which is exactly what a
# half-done rename leaves behind — stop, loudly: continuing means seeding a second database beside the
# real one and reporting success while the instance serves the wrong file.
CONFIGURED_DATA_DIR="$(sed -n 's/^GEMBA_DATA_DIR=//p' "$ENV_DIR/gemba.env" | head -1)"
if [ -n "$CONFIGURED_DATA_DIR" ] && [ "$CONFIGURED_DATA_DIR" != "$DATA_DIR" ]; then
  echo "refusing to continue: the config's GEMBA_DATA_DIR is $CONFIGURED_DATA_DIR, but this installer owns $DATA_DIR" >&2
  echo "  fix it (or move the database) before installing; see deploy/migrate-rename.sh" >&2
  exit 1
fi

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
  echo "refusing to continue: two databases exist and this script cannot tell which one is live." >&2
  echo "  old location: $OLD_DB" >&2
  echo "  configured:   $CONFIGURED_DB" >&2
  echo "  Seeding now would write to the new file while the old one may hold the real state, and step 8" >&2
  echo "  removes the old directory. Compare them, then move the one you want:" >&2
  echo "    cd $APP_DIR && node scripts/probe-db.mjs $OLD_DB $CONFIGURED_DB" >&2
  exit 1
fi

"$NODE_DIR/bin/node" scripts/seed.mjs

say "5. operator account"
# Signing in to /admin needs an account, not the URL token: management lives behind a session because a
# token in a URL cannot be revoked. This creates one on a fresh install and prints the password once;
# on a later run it leaves the existing operator alone (scripts/admin-create.mjs owns that rule).
GEMBA_ADMIN_EMAIL="${ADMIN_EMAIL_ARG:-operator@gemba.local}" \
GEMBA_ADMIN_PASSWORD="$ADMIN_PASSWORD_ARG" \
"$NODE_DIR/bin/node" scripts/admin-create.mjs
unset GEMBA_ADMIN_PASSWORD

say "6. systemd unit"
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

say "7. verify over HTTP"
HEALTH_OK=0
for i in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz"; then HEALTH_OK=1; break; fi
  sleep 2
done
echo
if [ "$HEALTH_OK" -ne 1 ]; then
  echo "ERROR: the service did not answer /healthz within 30s — it is not running." >&2
  systemctl --no-pager --lines=20 status gemba.service >&2 || true
  journalctl -u gemba.service --no-pager -n 40 -o cat >&2 || true
  echo "  Nothing below would be testing anything. Fix the service, then re-run." >&2
  exit 1
fi
echo "health: ok:true above, with the note count."
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

say "7b. backup timer"
# A deployment that can lose its database in a disk failure is a demonstration, not a deployment.
# The timer is installed here and the first copy is taken now, so the schedule is never the only
# thing standing between a live instance and an empty directory.
install -m 644 "$APP_DIR/deploy/gemba-backup.service" /etc/systemd/system/gemba-backup.service
install -m 644 "$APP_DIR/deploy/gemba-backup.timer" /etc/systemd/system/gemba-backup.timer
systemctl daemon-reload
systemctl enable --now gemba-backup.timer
if "$APP_DIR/deploy/gemba-backup.sh"; then
  echo "first backup taken; check it any time with: $APP_DIR/deploy/gemba-backup.sh --list"
else
  echo "WARNING: the first backup failed — the timer is installed but there is no copy yet." >&2
fi

say "8. legacy directories"
# The migration script owns every reference to the old paths; this asks it to do the cleanup now that
# the instance above has been verified healthy. Nothing is removed before that probe passes.
bash "$SRC_DIR/deploy/migrate-rename.sh" --cleanup

# The operator link is a secret: say where it lives rather than printing it into a terminal, a CI log or
# a screen share. It can be rotated from /admin.
if grep -q '^GEMBA_ADMIN_TOKEN=.' "$ENV_DIR/gemba.env"; then TOKEN_FILE="$ENV_DIR/gemba.env (GEMBA_ADMIN_TOKEN)"; else TOKEN_FILE="$DATA_DIR/admin.token"; fi
cat <<EOF

Installed. Reachable on http://$(hostname -I | awk '{print $1}'):$PORT
  operator console: /qt/<token>, with the token in $TOKEN_FILE (mode 600); rotate it at /admin
  expert desks:     /c/demo-hung-7f3a91, /c/demo-lan-2c8d40, /c/demo-dung-91be55
Logs: journalctl -u gemba -f
EOF
