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
import codecs
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


class Screen:
    """A minimal VT100 screen model.

    The chat transcript now lives inside a fixed-height window (issue #117),
    so Ink repaints rows in place with cursor-movement sequences instead of
    emitting a newline per line. Splitting the raw byte stream on "\n" fused
    unrelated rows; assertions need the *physical* screen, so this class
    emulates the cursor/erase subset Ink emits (CUU/CUD/CUF/CUB, ED, EL,
    CUP/CHA, CR/LF/BS, autowrap) and ignores styling (SGR/OSC).
    """

    def __init__(self, cols: int, rows: int):
        self.cols, self.rows = cols, rows
        self.grid = [[" "] * cols for _ in range(rows)]
        self.row = self.col = 0
        self.pending = ""  # partial escape sequence across writes
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def feed_bytes(self, data: bytes) -> None:
        self.feed(self.decoder.decode(data))

    def _scroll(self) -> None:
        if self.row >= self.rows:
            self.grid.pop(0)
            self.grid.append([" "] * self.cols)
            self.row = self.rows - 1

    def put(self, ch: str) -> None:
        if self.col >= self.cols:  # autowrap
            self.col = 0
            self.row += 1
            self._scroll()
        self.grid[self.row][self.col] = ch
        self.col += 1

    def feed(self, text: str) -> None:
        text = self.pending + text
        self.pending = ""
        i = 0
        n = len(text)
        while i < n:
            ch = text[i]
            if ch == "\x1b":
                m = ANSI.match(text, i)
                if m:
                    self._csi(m.group(0))
                    i = m.end()
                    continue
                if ch == "\x1b" and i + 1 < n and text[i + 1] == "]":
                    end = text.find("\x07", i)  # OSC: skip to BEL
                    if end == -1:
                        self.pending = text[i:]
                        return
                    i = end + 1
                    continue
                self.pending = text[i:]  # sequence split across writes
                return
            if ch == "\r":
                self.col = 0
            elif ch == "\n":
                self.row += 1
                self._scroll()
            elif ch == "\b":
                self.col = max(0, self.col - 1)
            elif ch == "\t":
                self.col = min(self.cols - 1, (self.col // 8 + 1) * 8)
            elif ch >= " ":
                self.put(ch)
            i += 1

    def _csi(self, seq: str) -> None:
        params = re.findall(r"\d+", seq)
        p1 = int(params[0]) if params else None
        final = seq[-1]
        if final == "A":
            self.row = max(0, self.row - (p1 or 1))
        elif final == "B":
            self.row = min(self.rows - 1, self.row + (p1 or 1))
        elif final == "C":
            self.col = min(self.cols - 1, self.col + (p1 or 1))
        elif final == "D":
            self.col = max(0, self.col - (p1 or 1))
        elif final == "G":
            self.col = min(self.cols - 1, max(0, (p1 or 1) - 1))
        elif final in ("H", "f"):
            r = int(params[0]) if len(params) > 0 else 1
            c = int(params[1]) if len(params) > 1 else 1
            self.row = min(self.rows - 1, max(0, r - 1))
            self.col = min(self.cols - 1, max(0, c - 1))
        elif final == "K":
            mode = p1 or 0
            start, end = self.col, self.cols
            if mode == 1:
                start, end = 0, self.col + 1
            elif mode == 2:
                start, end = 0, self.cols
            for c in range(start, end):
                self.grid[self.row][c] = " "
        elif final == "J":
            mode = p1 or 0
            if mode >= 2:
                self.grid = [[" "] * self.cols for _ in range(self.rows)]
            elif mode == 0:
                for c in range(self.col, self.cols):
                    self.grid[self.row][c] = " "
                for r in range(self.row + 1, self.rows):
                    self.grid[r] = [" "] * self.cols
        # SGR (m), OSC and anything else: styling or unsupported → ignore

    def lines(self) -> list[str]:
        return ["".join(row).rstrip() for row in self.grid]


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
    screen = Screen(cols, rows)

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
                    screen.feed_bytes(chunk)

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
            screen = Screen(resize["cols"], resize["rows"])  # Ink fully repaints after SIGWINCH
            pump(2.0)
    finally:
        try:
            os.kill(proc.pid, signal.SIGINT)
        except ProcessLookupError:
            pass
        time.sleep(0.3)
        proc.terminate()

    lines = screen.lines()[-spec.get("tail", rows):]
    out = []
    for line in lines:
        out.append({
            "lead": len(line) - len(line.lstrip()),
            "width": len(line),
            "text": line,
        })
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
