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
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
