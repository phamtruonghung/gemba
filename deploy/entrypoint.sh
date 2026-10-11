#!/bin/sh
# Container entrypoint: make the data path safe, seed the corpus when the database is not there
# yet, say out loud whether the front gate is on, then hand over to the server.
set -e

# An .env copied from the systemd deployment points XUONG_DATA_DIR at /var/lib/xuong, which does
# not exist and cannot be created by the unprivileged user in this image. Fall back to /data
# (where the volume is mounted) instead of dying on a mkdir — a warning beats a crash loop.
DATA_DIR="${XUONG_DATA_DIR:-/data}"
if [ ! -d "$DATA_DIR" ] || [ ! -w "$DATA_DIR" ]; then
  echo "!! XUONG_DATA_DIR=$DATA_DIR is not writable in the container; using /data instead."
  echo "   Mount a volume or bind mount at /data to keep the database across restarts."
  export XUONG_DATA_DIR=/data
  export XUONG_DB=/data/xuong.db
fi
DB="${XUONG_DB:-$DATA_DIR/xuong.db}"

# The seed only ever upserts (experts and notes by slug), so it never deletes questions, answers
# or bookings. XUONG_SEED=always re-runs it, which is how a rebuilt image picks up new notes.
if [ ! -f "$DB" ] || [ "${XUONG_SEED:-}" = "always" ]; then
  echo "-> seeding the corpus into $DB"
  node scripts/seed.mjs
fi

if [ -n "${XUONG_PASS:-}" ]; then
  echo "-> front gate: on (HTTP basic auth; only /healthz answers without it)"
else
  echo "!! XUONG_PASS is not set, so this instance has NO front gate."
  echo "   Set XUONG_USER and XUONG_PASS before putting it on a hostname:"
  echo "   every question spends money on a model, and an open form is an open bill."
fi

exec "$@"
