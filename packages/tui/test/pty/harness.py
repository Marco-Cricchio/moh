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

    Ink's interactive area repaints rows with cursor-movement sequences while
    settled transcript blocks are emitted to native scrollback (#183).
    Splitting the raw byte stream on "\n" fuses unrelated rows; assertions
    need the *physical* screen, so this class
    emulates the cursor/erase subset Ink emits (CUU/CUD/CUF/CUB, ED, EL,
    CUP/CHA, CR/LF/BS, autowrap) and ignores styling (SGR/OSC).
    """

    def __init__(self, cols: int, rows: int):
        self.cols, self.rows = cols, rows
        self.grid = [[" "] * cols for _ in range(rows)]
        self.row = self.col = 0
        # Alternate-screen state (DECSET 1049): `main_saved` holds the main
        # buffer's grid + cursor while the alternate buffer is active.
        self.alt_active = False
        self.main_saved = None
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
        elif final == "h" and seq.startswith("\x1b[?1049"):
            # Alternate screen buffer (DECSET 1049): modal overlays render
            # there (see App.tsx). The harness keeps both grids and swaps
            # cursor + content on the switch, so assertions see the buffer
            # the user actually sees after the modal closes.
            if not self.alt_active:
                self.main_saved = (self.grid, self.row, self.col)
                self.alt_active = True
                self.grid = [[" "] * self.cols for _ in range(self.rows)]
                self.row = self.col = 0
        elif final == "l" and seq.startswith("\x1b[?1049"):
            if self.alt_active:
                self.grid, self.row, self.col = self.main_saved
                self.main_saved = None
                self.alt_active = False
        # SGR (m), OSC and anything else: styling or unsupported → ignore

    def lines(self) -> list[str]:
        return ["".join(row).rstrip() for row in self.grid]


def main() -> None:
    spec = json.loads(sys.argv[1])
    cols, rows = spec["cols"], spec["rows"]
    home = tempfile.mkdtemp(prefix="moh-pty-home-")
    cwd = tempfile.mkdtemp(prefix="moh-pty-cwd-")
    # Optional user-config injection (~/.moh/config): lets tests pin TUI
    # settings (mode, onboarding flags) instead of scripting overlays.
    if isinstance(spec.get("project"), dict):
        with open(os.path.join(cwd, "moh.json"), "w") as f:
            json.dump(spec["project"], f)
    if isinstance(spec.get("config"), dict):
        os.makedirs(os.path.join(home, ".moh"), exist_ok=True)
        with open(os.path.join(home, ".moh", "config"), "w") as f:
            json.dump(spec["config"], f)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    # CI=true silences Ink entirely (it detects CI environments and skips
    # live frames) — strip it or every PTY test renders nothing on runners.
    env = { k: v for k, v in os.environ.items() if k != "CI" }
    env.update(HOME=home, TERM="xterm-256color", COLORTERM="truecolor")

    # The pty must be the child's CONTROLLING terminal (#236): bun on Linux
    # reads the window size from /dev/tty, not the stdout fd — without
    # TIOCSCTTY it reports columns/rows = 0, Ink cannot lay out, and no live
    # frame is ever painted (every PTY test fails; the same is true of any
    # harness that spawns moh session-less, e.g. CI runners). macOS bun reads
    # the size from the stdout fd, which is why this only broke on Linux.
    def make_controlling():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

    proc = subprocess.Popen(
        ["bun", CLI],
        stdin=slave, stdout=slave, stderr=slave, cwd=cwd, env=env,
        preexec_fn=make_controlling,
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

    def pump_until(seconds: float, needle: str, since: int) -> bool:
        """#236: readiness wait — pump for up to `seconds`, returning as soon
        as `needle` appears in the raw byte stream AFTER offset `since`
        (the cumulative buffer also holds everything painted before this
        step; matching it wholesale would return instantly on a stale
        match). Fixed budgets tuned on one machine systematically fail on
        slower hosts; waiting for the actual readiness signal makes timing
        host-independent."""
        target = needle.encode("utf-8", "replace")
        end = time.time() + seconds
        while time.time() < end:
            if buf.find(target, since) != -1:
                pump(0.2)  # let the frame finish painting
                return True
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    return False
                if chunk:
                    buf.extend(chunk)
                    screen.feed_bytes(chunk)
        return buf.find(target, since) != -1

    def send(b64: str) -> None:
        os.write(master, base64.b64decode(b64))

    try:
        pump(2.5)  # boot: onboarding appears
        for step in spec.get("steps", []):
            if step.get("until"):
                # Readiness steps are send-only-free by contract: a step that
                # both waits for readiness and sends would be ambiguous, so
                # refuse it loudly instead of silently dropping the send.
                if step.get("send"):
                    raise ValueError("pty step: 'until' and 'send' are mutually exclusive")
                pump_until(step.get("wait", 5.0), step["until"], since=len(buf))
                continue
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
        # aliveAtEnd (#236): sampled BEFORE the harness kills the process —
        # `exited` alone can be false merely because the kill hasn't landed
        # yet, which used to make the survival assertion pass for the wrong
        # reason on slow hosts.
        alive_at_end = proc.poll() is None
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
    if spec.get("rawDump"):
        with open(spec["rawDump"], "wb") as f:
            f.write(bytes(buf))
    payload = out
    if spec.get("meta"):
        payload = {"lines": out, "exited": proc.poll() is not None, "exitCode": proc.returncode, "aliveAtEnd": alive_at_end}
    json.dump(payload, sys.stdout)


if __name__ == "__main__":
    main()
