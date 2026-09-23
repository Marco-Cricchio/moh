#!/usr/bin/env python3
"""Run a command with (or deliberately without) a controlling terminal.

The installer's root confirmation reads /dev/tty (#917) — a device that only
exists for a process with a controlling terminal, which a pipe-spawned child
(as under CI, or a test runner whose stdio is captured) does not have. This
harness gives the child either a real controlling pty (default) or a fresh
session with none (`--no-tty`), prints the child's output to its own stdout,
and exits with the child's status.

Usage:
    pty-run.py [--no-tty] [--feed BASE64] -- command [args...]

With a pty, stdout and stderr are the same stream (the terminal), so callers
assert on the merged output; `--no-tty` keeps the parent's separate pipes.
"""
import base64
import fcntl
import os
import pty
import select
import subprocess
import sys
import termios
import time

TIMEOUT_SECONDS = 60


def usage(message: str) -> int:
    sys.stderr.write(f"pty-run: {message}\n")
    sys.stderr.write("usage: pty-run.py [--no-tty] [--feed BASE64] -- command [args...]\n")
    return 2


def main() -> int:
    argv = sys.argv[1:]
    no_tty = False
    feed = b""
    while argv and argv[0] != "--":
        opt = argv.pop(0)
        if opt == "--no-tty":
            no_tty = True
        elif opt == "--feed":
            if not argv:
                return usage("--feed needs a base64 argument")
            feed = base64.b64decode(argv.pop(0))
        else:
            return usage(f"unknown option: {opt}")
    if argv[:1] == ["--"]:
        argv.pop(0)
    if not argv:
        return usage("no command given")

    if no_tty:
        # A new session with no controlling terminal: opening /dev/tty fails,
        # exactly as it does for a child under `curl … | sh` in CI.
        proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, preexec_fn=os.setsid)
        return proc.wait()

    master, slave = pty.openpty()

    def make_controlling() -> None:
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

    proc = subprocess.Popen(
        argv,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        preexec_fn=make_controlling,
        close_fds=True,
    )
    os.close(slave)
    if feed:
        # The pty buffers input, so writing before the child prompts is safe.
        try:
            os.write(master, feed)
        except OSError:
            pass

    deadline = time.time() + TIMEOUT_SECONDS
    chunks = []
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            proc.kill()
            proc.wait()
            sys.stdout.write(b"".join(chunks).decode("utf-8", "replace"))
            sys.stdout.flush()
            return 124
        ready, _, _ = select.select([master], [], [], remaining)
        if not ready:
            continue
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        chunks.append(data)

    sys.stdout.write(b"".join(chunks).decode("utf-8", "replace"))
    sys.stdout.flush()
    return proc.wait()


if __name__ == "__main__":
    sys.exit(main())
