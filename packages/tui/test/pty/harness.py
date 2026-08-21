#!/usr/bin/env python3
"""Real-PTY harness for TUI layout verification (issues #64/#65).

Headless Ink snapshots cannot validate viewport geometry (the lesson from
the TUI prototype sessions), and node-pty does not load under Bun. This
small stdlib-only Python harness spawns the moh CLI inside a real pseudo
terminal, scripts keystrokes, optionally resizes the terminal, and prints
the last rendered screen as JSON for assertion by the Bun test suite.

Protocol: a JSON spec on stdin, one JSON array on stdout:
    {
      "cols": 160, "rows": 45,        # initial pty size
      "resize": {"cols": 80, "rows": 24},   # optional mid-run resize
      "steps": [                       # scripted input
        {"wait": 2.5},
        {"wait": 0.6, "send": "cw=="}  # send = base64 of raw bytes
      ],
      "tail": 45                       # lines of stripped output to report
    }
Each reported line: {"lead": <leading spaces>, "width": <rstripped length>,
"text": <rstripped text>}.
"""
import base64
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
CLI = os.path.join(REPO_ROOT, "packages", "cli", "src", "cli.ts")
ANSI = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def main() -> None:
    spec = json.loads(sys.argv[1])
    cols, rows = spec["cols"], spec["rows"]
    home = tempfile.mkdtemp(prefix="moh-pty-home-")
    cwd = tempfile.mkdtemp(prefix="moh-pty-cwd-")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    env = dict(os.environ, HOME=home, TERM="xterm-256color", COLORTERM="truecolor")
    proc = subprocess.Popen(
        ["bun", CLI],
        stdin=slave, stdout=slave, stderr=slave, cwd=cwd, env=env,
        start_new_session=True,
    )
    os.close(slave)
    buf = bytearray()

    def pump(seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    return
                if chunk:
                    buf.extend(chunk)

    def send(b64: str) -> None:
        os.write(master, base64.b64decode(b64))

    try:
        pump(2.5)  # boot: onboarding appears
        for step in spec.get("steps", []):
            if step.get("send"):
                send(step["send"])
            pump(step.get("wait", 0.3))
        resize = spec.get("resize")
        if resize:
            fcntl.ioctl(master, termios.TIOCSWINSZ,
                        struct.pack("HHHH", resize["rows"], resize["cols"], 0, 0))
            os.kill(proc.pid, signal.SIGWINCH)
            pump(2.0)
    finally:
        try:
            os.kill(proc.pid, signal.SIGINT)
        except ProcessLookupError:
            pass
        time.sleep(0.3)
        proc.terminate()

    text = ANSI.sub("", buf.decode("utf-8", "replace"))
    lines = text.split("\n")[-spec.get("tail", rows):]
    out = []
    for line in lines:
        stripped = line.rstrip()
        out.append({
            "lead": len(stripped) - len(stripped.lstrip()),
            "width": len(stripped),
            "text": stripped,
        })
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
