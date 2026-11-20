#!/usr/bin/env python3
"""Write KEY=VALUE pairs into an environment file without ever interpreting them.

The installer used to build a `sed` replacement out of GEMBA_PASS. A password containing `&`
expanded to the matched text, a `|` broke the delimiter, and a space made the later
`set -a; . gemba.env` execute the tail of the password as a command. The operator was then
configured with a password nobody knew, while the installer printed "front gate set" and exited 0.

A secret is data, not syntax. This writes it verbatim, atomically, mode 600, and refuses a value
that cannot survive a line-oriented file (a newline) instead of writing something that looks fine
and is not.

Usage: set-env.py FILE KEY VALUE [KEY VALUE ...]
"""
import os
import sys
import tempfile


def main(argv):
    if len(argv) < 4 or (len(argv) - 2) % 2:
        print("usage: set-env.py FILE KEY VALUE [KEY VALUE ...]", file=sys.stderr)
        return 2
    path, values = argv[1], list(zip(argv[2::2], argv[3::2]))

    for key, value in values:
        if not key or "=" in key or " " in key:
            print(f"refusing key {key!r}: not a valid environment name", file=sys.stderr)
            return 2
        if "\n" in value or "\r" in value:
            print(f"refusing {key}: a newline cannot be stored in a line-oriented file", file=sys.stderr)
            return 2
        # Two programs read this file and they disagree: systemd's EnvironmentFile= unescapes backslashes
        # and strips surrounding quotes and whitespace; the app's own reader strips quotes only. A value
        # that would read differently in each is a password that works in one and not the other, so it is
        # refused here. `&`, `|`, `$`, `#`, backticks and inner spaces are all stored verbatim.
        if "\\" in value:
            print(f"refusing {key}: a backslash is read differently by systemd and by the app; choose a value without one", file=sys.stderr)
            return 2
        if value != value.strip() or value[:1] in "\"'" or value[-1:] in "\"'":
            print(f"refusing {key}: a value that starts or ends with a quote or a space is rewritten by systemd; choose one that does not", file=sys.stderr)
            return 2

    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except FileNotFoundError:
        lines = []

    pending = dict(values)
    out, replaced = [], set()
    for line in lines:
        key = line.split("=", 1)[0]
        if "=" in line and key in pending:
            out.append(f"{key}={pending[key]}")
            replaced.add(key)
        else:
            out.append(line)
    for key, value in values:
        if key not in replaced:
            out.append(f"{key}={value}")

    directory = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".env-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write("\n".join(out) + "\n")
        os.chmod(tmp, 0o600)
        # Atomic replace: a reader (systemd, or the next step of this script) either sees the old
        # file or the complete new one, never a half-written secret.
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

    # A copy of this file taken before an edit is a second copy of every secret it held: rotating a
    # value in the live file leaves the retired one readable in the copy, and nothing ever revisits
    # it. Measured on CT150 (2026-11-20): a `gemba.env.bak-<timestamp>` left by a November change
    # still held the model key and the front-gate pair long after both had been rotated. The write
    # above is atomic (`os.replace`), so this script never creates such a copy itself — a sibling
    # `.bak-<timestamp>` comes from an operator or a lane doing `cp` by hand — and a successful write
    # is the moment to remove them. Scoped to this file's own name in this file's own directory, and
    # it names what it deleted: removing a secret's copy is not a silent act.
    base = os.path.basename(path)
    for name in sorted(os.listdir(directory)):
        if not name.startswith(f"{base}.bak-"):
            continue
        try:
            os.unlink(os.path.join(directory, name))
        except OSError as err:
            print(f"could not remove the superseded copy {name}: {err.strerror}", file=sys.stderr)
        else:
            print(f"removed the superseded copy {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
