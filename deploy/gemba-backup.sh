#!/usr/bin/env bash
# deploy/gemba-backup.sh — a consistent copy of the only stateful file, and a way to prove it.
#
# The database holds the questions, the bookings, what was paid, and the published notes. Until this
# script existed the only recipe in the tree was `tar` of the live volume, which copies the database
# and its write-ahead log at different instants: a copy that looks fine and restores a database that
# never existed. The copy here is `VACUUM INTO` (deploy/db-copy.mjs), which is transactional.
#
#   deploy/gemba-backup.sh                 # take a backup, verify it, prune old ones
#   deploy/gemba-backup.sh --verify FILE   # check a backup and print what is in it
#   deploy/gemba-backup.sh --list          # what exists, with sizes and ages
#
# Environment:
#   GEMBA_DB                 default /var/lib/gemba/gemba.db
#   GEMBA_BACKUP_DIR         default /var/backups/gemba
#   GEMBA_BACKUP_KEEP_DAYS   default 7        (a second copy off the host: GEMBA_BACKUP_REMOTE)
#   GEMBA_BACKUP_REMOTE      optional rclone target, e.g. "b2:gemba-backups"
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB="${GEMBA_DB:-/var/lib/gemba/gemba.db}"
DEST="${GEMBA_BACKUP_DIR:-/var/backups/gemba}"
KEEP_DAYS="${GEMBA_BACKUP_KEEP_DAYS:-7}"
REMOTE="${GEMBA_BACKUP_REMOTE:-}"

NODE="${GEMBA_NODE:-}"
if [ -z "$NODE" ]; then
  if command -v node >/dev/null 2>&1; then NODE="$(command -v node)"
  elif [ -x /opt/node22/bin/node ]; then NODE=/opt/node22/bin/node
  else echo "backup: no node on PATH and /opt/node22/bin/node is absent" >&2; exit 1; fi
fi

case "${1:-}" in
  --verify)
    [ -n "${2:-}" ] || { echo "usage: $0 --verify FILE" >&2; exit 2; }
    echo "$2: $("$NODE" "$HERE/db-copy.mjs" verify "$2")"
    exit 0
    ;;
  --list)
    ls -lh "$DEST" 2>/dev/null || echo "no backups in $DEST"
    exit 0
    ;;
esac

[ -f "$DB" ] || { echo "backup: $DB does not exist — nothing to back up" >&2; exit 1; }
mkdir -p "$DEST"
chmod 700 "$DEST"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/gemba-$STAMP.db"
"$NODE" "$HERE/db-copy.mjs" copy "$DB" "$OUT"
chmod 600 "$OUT"

# A backup nobody opened is a file, not a backup. This opens it, runs SQLite's own integrity check and
# prints the row counts, so a truncated or empty copy fails here rather than during a restore.
VERDICT="$("$NODE" "$HERE/db-copy.mjs" verify "$OUT")" \
  || { echo "backup: $OUT failed verification: $VERDICT" >&2; exit 1; }
echo "backup: $OUT $(stat -c%s "$OUT") bytes — $VERDICT"

if [ -n "$REMOTE" ] && command -v rclone >/dev/null 2>&1; then
  rclone copy "$OUT" "$REMOTE" && echo "backup: copied to $REMOTE"
fi

# Retention. A backup directory that grows forever is a disk that fills at 3am.
find "$DEST" -maxdepth 1 -name 'gemba-*.db' -type f -mtime "+$KEEP_DAYS" -print -delete \
  | sed 's/^/backup: pruned /'

echo "backup: $(find "$DEST" -maxdepth 1 -name 'gemba-*.db' -type f | wc -l) copy(ies) held, keeping ${KEEP_DAYS} days"
