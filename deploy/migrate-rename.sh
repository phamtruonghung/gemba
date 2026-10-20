#!/usr/bin/env bash
# deploy/migrate-rename.sh — move a live "Xuong" installation to "Gemba" in place.
#
# The product was renamed: the brand, the repo, the image, the systemd unit and every path it owns.
# A rename that stops at the label leaves the unit, the config and the database answering to a name
# nobody recognises any more, so this runs from install.sh as step 0 and moves the state.
#
# This is the only file in the repository allowed to spell the old name: it has to know what to look
# for. test/naming.test.mjs allowlists exactly this file and nothing else.
#
# Idempotent: with no legacy installation present it prints one line and exits 0. A second run after
# a successful migration does nothing.
set -euo pipefail

OLD_ENV_DIR="${GEMBA_LEGACY_ENV_DIR:-/etc/xuong}"
OLD_DATA_DIR="${GEMBA_LEGACY_DATA_DIR:-/var/lib/xuong}"
OLD_APP_DIR="${GEMBA_LEGACY_APP_DIR:-/opt/xuong}"
OLD_UNIT=xuong.service
NEW_ENV_DIR=/etc/gemba
NEW_DATA_DIR=/var/lib/gemba

# Cleanup mode, called by install.sh *after* a successful install: at that point the new instance is
# verified healthy, so what remains of the old one is a second copy of the app and a config file
# carrying the same secrets under a name nothing uses. Keeping these paths in one file is deliberate —
# install.sh must not have to spell the old name to be able to clean it up.
#
# The data directory is different from the other two, and it is the only one that can hold something
# nobody can recreate. A migration that found the new database already in place leaves the old one
# where it was (it cannot tell which file is live), and this cleanup then deleted it: the operator's
# questions, with "Installed." printed afterwards. So the app and config directories are removed, and
# the data directory is only removed when it is empty.
if [ "${1:-}" = "--cleanup" ]; then
  for legacy in "$OLD_APP_DIR" "$OLD_ENV_DIR"; do
    if [ -e "$legacy" ]; then
      rm -rf "$legacy"
      echo "removed legacy $legacy"
    fi
  done
  if [ -e "$OLD_DATA_DIR" ] && [ -n "$(ls -A "$OLD_DATA_DIR" 2>/dev/null)" ]; then
    echo "refusing to remove $OLD_DATA_DIR: it still holds files, and one of them may be the live database." >&2
    ls -la "$OLD_DATA_DIR" >&2 || true
    echo "  Compare it with the configured database before deleting anything:" >&2
    echo "    node /opt/gemba/scripts/probe-db.mjs $OLD_DATA_DIR/*.db $NEW_DATA_DIR/gemba.db" >&2
    echo "  Nothing was removed from it." >&2
    exit 1
  fi
  if [ -d "$OLD_DATA_DIR" ]; then
    rmdir "$OLD_DATA_DIR" && echo "removed empty legacy $OLD_DATA_DIR"
  fi
  exit 0
fi

legacy=0
for p in "$OLD_ENV_DIR" "$OLD_DATA_DIR" "$OLD_APP_DIR" "/etc/systemd/system/$OLD_UNIT"; do
  [ -e "$p" ] && legacy=1
done

if [ "$legacy" -eq 0 ]; then
  echo "no legacy (Xuong) installation found — nothing to migrate"
  exit 0
fi

echo "legacy installation found — migrating Xuong -> Gemba"

# Where the database actually lives: the legacy env is the only place that knows, because the
# configured path always wins over the default.
OLD_DB="$OLD_DATA_DIR/xuong.db"
if [ -f "$OLD_ENV_DIR/xuong.env" ]; then
  configured="$(sed -n 's/^XUONG_DB=//p' "$OLD_ENV_DIR/xuong.env" | head -1)"
  [ -n "$configured" ] && OLD_DB="$configured"
fi

# 1. Stop the old service before touching its database. A running process holding a WAL is the one
#    way to turn a rename into data loss.
if systemctl list-unit-files 2>/dev/null | grep -q "^$OLD_UNIT"; then
  systemctl stop "$OLD_UNIT" 2>/dev/null || true
  systemctl disable "$OLD_UNIT" 2>/dev/null || true
  echo "stopped and disabled $OLD_UNIT"
fi

mkdir -p "$NEW_ENV_DIR" "$NEW_DATA_DIR"
chmod 700 "$NEW_ENV_DIR"

# 2. Config: keys are renamed, values are carried over exactly. An existing new-style env file wins,
#    so a re-run cannot overwrite a live key with a stale one.
if [ -f "$OLD_ENV_DIR/xuong.env" ] && [ ! -f "$NEW_ENV_DIR/gemba.env" ]; then
  # Keys *and* values: the prefix rewrite alone leaves GEMBA_DATA_DIR pointing at the old directory,
  # and the app then creates a second, empty database there while the real one sits in the new path.
  # Observed on the first live migration: two databases, one of them holding only the installer's own
  # probe question, and the health check reading the wrong file.
  sed -e 's/^XUONG_/GEMBA_/' \
      -e 's|/var/lib/xuong|/var/lib/gemba|g' \
      -e 's|/etc/xuong|/etc/gemba|g' \
      -e 's|/opt/xuong|/opt/gemba|g' \
      -e 's|xuong\.db|gemba.db|g' \
      "$OLD_ENV_DIR/xuong.env" > "$NEW_ENV_DIR/gemba.env"
  chmod 600 "$NEW_ENV_DIR/gemba.env"
  # The old file holds the same secrets under the old key names. Leaving it behind is a stale copy of
  # a credential plus a file that answers to a name the product no longer uses: remove it once the new
  # one is written and non-empty.
  if [ -s "$NEW_ENV_DIR/gemba.env" ]; then
    rm -f "$OLD_ENV_DIR/xuong.env"
    echo "config moved to $NEW_ENV_DIR/gemba.env (XUONG_* -> GEMBA_*), old file removed"
  fi
fi

# 3. State: the database with its write-ahead log and shared memory. The WAL is moved first — the
#    earlier ordering bug in this project dropped a -shm before the -wal and lost committed rows.
if [ -f "$OLD_DB" ] && [ ! -f "$NEW_DATA_DIR/gemba.db" ]; then
  [ -f "$OLD_DB-wal" ] && mv "$OLD_DB-wal" "$NEW_DATA_DIR/gemba.db-wal"
  rm -f "$OLD_DB-shm"
  mv "$OLD_DB" "$NEW_DATA_DIR/gemba.db"
  echo "database moved to $NEW_DATA_DIR/gemba.db"
fi
for f in admin.token basic-auth.txt; do
  if [ -f "$OLD_DATA_DIR/$f" ] && [ ! -f "$NEW_DATA_DIR/$f" ]; then
    mv "$OLD_DATA_DIR/$f" "$NEW_DATA_DIR/$f"
  fi
  if [ -f "$OLD_ENV_DIR/$f" ] && [ ! -f "$NEW_ENV_DIR/$f" ]; then
    mv "$OLD_ENV_DIR/$f" "$NEW_ENV_DIR/$f"
  fi
done

# 4. The unit itself: removed only after its replacement is installed (install.sh writes
#    /etc/systemd/system/gemba.service later in the same run).
if [ -f "/etc/systemd/system/$OLD_UNIT" ]; then
  rm -f "/etc/systemd/system/$OLD_UNIT"
  echo "removed /etc/systemd/system/$OLD_UNIT"
fi

# 5. Old directories: the state is already moved, and install.sh removes the legacy code directory at
#    the end of a successful install (deploy/install.sh step 8). What is left here is removed only when
#    empty, so anything the migration did not claim stays for a human rather than being deleted.
for d in "$OLD_DATA_DIR" "$OLD_ENV_DIR" "$OLD_APP_DIR"; do
  if [ -d "$d" ]; then
    rmdir "$d" 2>/dev/null && echo "removed empty $d" || echo "kept $d (still holds files: $(ls -A "$d" | tr '\n' ' '))"
  fi
done

systemctl daemon-reload 2>/dev/null || true
echo "migration done — install.sh now installs Gemba over it"
