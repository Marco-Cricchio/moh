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
import errno
import fcntl
import hashlib
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import uuid

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
        self.scrollback = []
        self.row = self.col = 0
        # Alternate-screen state (DECSET 1049): `main_saved` holds the main
        # buffer's grid + cursor while the alternate buffer is active.
        self.alt_active = False
        self.main_saved = None
        self.pending = ""  # partial escape sequence across writes
        self.sync_active = False  # DECSET 2026 synchronized update
        self.sync_grid = None
        self.sync_scrollback_len = None
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        # Frame accounting (#1022): ink writes one repaint as
        # `eraseLines(previous) + frame + cursor suffix` inside a DECSET-2026
        # sync block. The frame's height is the line count of that payload
        # (`outputHeight`), which is what ink compares against `stdout.rows`
        # when it picks between the log-update path and the fullscreen one —
        # measuring it here reads the physical frame, not an estimate.
        self.frames = []  # completed repaints: height in rows
        self.windows = []  # per repaint: (requested height, fullscreen?)
        self.max_frame_rows = 0
        self.fullscreen_frames = 0  # repaints that took ink's clearTerminal path
        # Marks the end of the startup ramp: fullscreen blips before it are
        # the Home screen's own geometry, not the streaming frame (#1022).
        self.mark = None
        self.markEnd = None
        self._frame_top = None
        self._frame_bottom = None
        self._frame_newlines = 0
        self._frame_erase = False
        self._frame_clear = False
        self._frame_trailing_newline = False

    def feed_bytes(self, data: bytes) -> None:
        self.feed(self.decoder.decode(data))

    def _touch(self, row: int) -> None:
        if self._frame_top is None or row < self._frame_top:
            self._frame_top = row
        if self._frame_bottom is None or row > self._frame_bottom:
            self._frame_bottom = row

    def _open_frame(self) -> None:
        self._frame_top = self._frame_bottom = None
        self._frame_newlines = 0
        self._frame_erase = False
        self._frame_clear = False
        self._frame_trailing_newline = False

    def _close_frame(self) -> None:
        """Ends the current repaint and records its rendered height.

        Two independent readings, the larger wins: the payload's line count
        (exact for a log-update repaint) and the span of rows whose content
        the repaint touched (the fallback for a stream without sync markers).
        A block that carries a full-screen clear is ink's fullscreen path —
        counted separately, never as a height."""
        span = 0
        if self._frame_top is not None:
            span = self._frame_bottom - self._frame_top + 1
        newlines, erase, clear = self._frame_newlines, self._frame_erase, self._frame_clear
        trailing = self._frame_trailing_newline
        self._open_frame()
        if clear:
            self.fullscreen_frames += 1
            self.windows.append((0, True))
            return
        if not erase and not span:
            return  # not a frame repaint (a plain write, e.g. patched console)
        # `output + '\n'` (log-update's rewrite payload) carries one newline
        # more than the frame has rows; the fullscreen payload carries none.
        # Rows the frame actually paints: the newlines it wrote, plus the
        # open last line when the payload did not end with one.
        height = max(span, newlines + (0 if trailing else (1 if span or newlines else 0)))
        self.frames.append(height)
        self.windows.append((height, False))
        if height > self.max_frame_rows:
            self.max_frame_rows = height

    def _scroll(self) -> None:
        if self.row >= self.rows:
            if not self.alt_active:
                self.scrollback.append("".join(self.grid[0]).rstrip())
            self.grid.pop(0)
            self.grid.append([" "] * self.cols)
            self.row = self.rows - 1

    def put(self, ch: str) -> None:
        if self.col >= self.cols:  # autowrap
            self.col = 0
            self.row += 1
            self._scroll()
        self._touch(self.row)
        self.grid[self.row][self.col] = ch
        self.col += 1
        self._frame_trailing_newline = False

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
                # #1022: the frame's own line breaks are its height — the
                # live tail, once promoted, leaves the frame for scrollback,
                # so only the frame's rows are counted here.
                self._frame_newlines += 1
                self._frame_trailing_newline = True
            elif ch == "\b":
                self.col = max(0, self.col - 1)
            elif ch == "\t":
                self.col = min(self.cols - 1, (self.col // 8 + 1) * 8)
            elif ch >= " ":
                self.put(ch)
            i += 1

    def _csi(self, seq: str) -> None:
        # DECSET 2026 (synchronized update): Ink brackets each repaint in
        # BEGIN/END. A snapshot taken mid-bracket shows a half-cleared
        # frame the real terminal never displays; buffer the writes and
        # commit atomically on END.
        if os.environ.get("MOH_SYNC_DEBUG") and "2026" in seq:
            sys.stderr.write(f"SYNC {seq!r}\n")
        if re.fullmatch(r"\x1b\[\?2026;?\d*h", seq):
            # #1022: a repaint begins — the sync block delimits one frame.
            self._open_frame()
            self.sync_active = True
            self.sync_opened = time.time()
            self.sync_grid = [row[:] for row in self.grid]
            return
        if re.fullmatch(r"\x1b\[\?2026;?\d*l", seq):
            self._close_frame()
            self.sync_active = False
            self.sync_grid = None
            return
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
            if mode == 2:
                # A repaint without sync markers (non-TTY or CI) delimits its
                # frames with `eraseLines`: the first full-line erase opens a
                # fresh frame, so the previous one is measured here if the
                # stream never emitted a sync block (#1022).
                if self._frame_erase and not self.sync_active:
                    self._close_frame()
                self._frame_erase = True
            start, end = self.col, self.cols
            if mode == 1:
                start, end = 0, self.col + 1
            elif mode == 2:
                start, end = 0, self.cols
            for c in range(start, end):
                self.grid[self.row][c] = " "
        elif final == "J":
            mode = p1 or 0
            if mode == 3:
                self.scrollback.clear()
                self._frame_clear = True
            elif mode == 2:
                self.grid = [[" "] * self.cols for _ in range(self.rows)]
                self._frame_clear = True
            elif mode == 0:
                for c in range(self.col, self.cols):
                    self.grid[self.row][c] = " "
                for r in range(self.row + 1, self.rows):
                    self.grid[r] = [" "] * self.cols
        elif final == "r":
            # DECSTBM (scroll region): moh/Ink sets regions for backbuffer
            # pushes. The screen model has no regions; recording cursor
            # home is enough for the frames assertions sample.
            self.col = 0
        elif final == "M":
            # Reverse index: terminals scroll the region ABOVE the cursor
            # (0..row) up by one, pushing the top row toward scrollback.
            if self.row > 0:
                if not self.alt_active:
                    self.scrollback.append("".join(self.grid[0]).rstrip())
                self.grid.pop(0)
                self.grid.insert(self.row - 1 if self.row - 1 >= 0 else 0, [" "] * self.cols)
                self.row -= 1
            self.col = 0
        elif final == "L":
            count = p1 or 1
            for _ in range(count):
                self.grid.pop()
                self.grid.insert(self.row, [" "] * self.cols)
        elif final == "S":
            # SU — scroll up: push the top `count` rows out to scrollback
            # (Ink's Static/backbuffer commit path above the viewport).
            count = p1 or 1
            for _ in range(count):
                if not self.alt_active:
                    self.scrollback.append("".join(self.grid[0]).rstrip())
                self.grid.pop(0)
                self.grid.insert(self.rows - 1, [" "] * self.cols)
        elif final == "T":
            # SD — scroll down: rows move down, a blank row appears on top.
            count = p1 or 1
            for _ in range(count):
                self.grid.pop()
                self.grid.insert(0, [" "] * self.cols)
        elif final == "D":
            self.row = min(self.rows - 1, self.row + 1)
            self.col = 0
            self._scroll()
        elif final == "E":
            self.row = min(self.rows - 1, self.row + 1)
            self.col = 0
            self._scroll()
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
        # A real terminal displays the COMMITTED frame; a mid-block snapshot
        # shows the last committed state. A block open for >2s is a parser
        # bug (real sync blocks are single repaints): fall through to live.
        stale = self.sync_active and (time.time() - self.sync_opened > 2.0)
        grid = self.sync_grid if self.sync_active and self.sync_grid is not None and not stale else self.grid
        return ["".join(row).rstrip() for row in grid]

    @property
    def scrollback_view(self) -> list[str]:
        # Scrollback rows pushed inside a sync block are committed by the
        # block's END in a real terminal; the grid buffers, the scrollback
        # does not need to.
        return self.scrollback


def prune_stale_pty_tmp() -> None:
    """Removes moh-pty-* temp dirs older than 2 days and /tmp raw dumps older
    than 2 days. Gated by a stamp file so at most one run per hour pays the
    scan; everything is best-effort (test isolation must never fail because
    cleanup failed)."""
    stamp = os.path.join(tempfile.gettempdir(), "moh-pty-prune.stamp")
    if os.path.exists(stamp) and time.time() - os.path.getmtime(stamp) < 3600:
        return
    open(stamp, "w").close()
    cutoff = time.time() - 2 * 24 * 3600
    base = tempfile.gettempdir()
    for name in os.listdir(base):
        if not name.startswith("moh-pty-"):
            continue
        path = os.path.join(base, name)
        try:
            if os.path.getmtime(path) < cutoff:
                if os.path.isdir(path) and not os.path.islink(path):
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    os.unlink(path)
        except OSError:
            continue


def main() -> None:
    spec = json.loads(sys.argv[1])
    cols, rows = spec["cols"], spec["rows"]
    # Lazy retention sweep (#595 stabilization): every PTY run leaves two
    # temp dirs behind (the child may still hold fds at exit, so atexit
    # cleanup is unreliable). Left unbounded they accumulate — 1800+ stale
    # dirs were found on a dev machine. Prune runs/f dirs older than 2 days,
    # at most once per hour, and never raises.
    try:
        prune_stale_pty_tmp()
    except Exception:
        pass
    home = tempfile.mkdtemp(prefix="moh-pty-home-")
    cwd = tempfile.mkdtemp(prefix="moh-pty-cwd-")
    # Optional user-config injection (~/.moh/config): lets tests pin TUI
    # settings (mode, onboarding flags) instead of scripting overlays.
    # PTY fixtures exercise established Home/chat behaviour, not the
    # first-project handoff offer. Pin its explicit off state so the new
    # startup modal cannot consume their scripted keystrokes; focused Ink
    # tests cover the offer itself.
    project = {"handoff": {"transport": "none"}}
    if isinstance(spec.get("project"), dict):
        project.update(spec["project"])
    with open(os.path.join(cwd, "moh.json"), "w") as f:
        json.dump(project, f)
    if isinstance(spec.get("config"), dict):
        os.makedirs(os.path.join(home, ".moh"), exist_ok=True)
        with open(os.path.join(home, ".moh", "config"), "w") as f:
            json.dump(spec["config"], f)
    # ADR-0074: pre-grant the team extension's enable consent in every PTY
    # home, so the team question cannot consume the scripts' keystrokes —
    # the same isolation the factory-level tests get from grantTeamExtension.
    # The descriptor declares its manifest as literals, so the store record
    # is keyed by the descriptor's derived identity ("team", empty hash).
    os.makedirs(os.path.join(home, ".moh"), exist_ok=True)
    with open(os.path.join(home, ".moh", "extensions.json"), "w") as f:
        json.dump({
            "consents": {"memory:team": True},
            "dependencies": {},
            "manifests": {"team": {"hash": "", "capabilities": ["spawn-subagent", "contribute-tool:team"]}},
        }, f)
    # Optional fixture files written into the child's cwd (mentions need
    # real files under the session root to attach).
    if isinstance(spec.get("files"), dict):
        for name, content in spec["files"].items():
            path = os.path.join(cwd, name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(base64.b64decode(content))
    # #1023: seeded existing sessions so the Home list has rows. One JSONL
    # line per event; a single `user_message` gives each session a title
    # and an unconsumed state (no `session_resumed` in the log). The legacy
    # path-derived slug matches what the child's `SessionStore.list` reads.
    if isinstance(spec.get("seedSessions"), int) and spec["seedSessions"] > 0:
        slug_base = os.path.basename(cwd.rstrip("/")).lower()
        slug_base = "".join(c if c.isalnum() or c in "._-" else "-" for c in slug_base).strip("-") or "project"
        slug = f"{slug_base}-" + hashlib.sha256(os.path.realpath(cwd).encode()).hexdigest()[:8]
        sess_dir = os.path.join(home, ".moh", "projects", slug)
        os.makedirs(sess_dir, exist_ok=True)
        stamp = int(time.time() * 1000)
        for i in range(spec["seedSessions"]):
            sid = time.strftime("%Y%m%dT%H%M%S", time.gmtime(stamp / 1000)) + ("%03dZ" % (stamp % 1000)) + "-" + uuid.uuid4().hex[:8]
            # #1045: a log MUST start with session_start or SessionStore.load
            # refuses it ("corrupt session log") — a bare user_message seed
            # made every OPEN of a seeded session crash the child. (Listing
            # never loaded the log, which is why #1023 got away with it.)
            events = [
                {"type": "session_start", "schemaVersion": 1, "promptVersion": "p"},
                {"type": "user_message", "text": f"seeded session number {i + 1}"},
            ]
            with open(os.path.join(sess_dir, sid + ".jsonl"), "w") as f:
                for event in events:
                    f.write(json.dumps(event) + "\n")
            stamp += 1
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    # CI=true silences Ink entirely (it detects CI environments and skips
    # live frames) — strip it or every PTY test renders nothing on runners.
    env = { k: v for k, v in os.environ.items() if k != "CI" }
    env.update(HOME=home, TERM="xterm-256color", COLORTERM="truecolor")
    # Optional env injection (image-preview detection tests, #490): the
    # caller pins TERM_PROGRAM/KITTY_WINDOW_ID to simulate a terminal.
    if isinstance(spec.get("env"), dict):
        env.update(spec["env"])

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

    def pump_until(seconds: float, needle: str, since: int, on_screen: bool = False,
                   entry_buffer: bool = False) -> bool:
        """#236: readiness wait — pump for up to `seconds`, returning as soon
        as `needle` appears in the raw byte stream AFTER offset `since`
        (the cumulative buffer also holds everything painted before this
        step; matching it wholesale would return instantly on a stale
        match). Fixed budgets tuned on one machine systematically fail on
        slower hosts; waiting for the actual readiness signal makes timing
        host-independent.

        `on_screen` (#874): also accept a needle already visible on the
        current SCREEN at step entry. The `since` guard silently assumes
        that whatever we wait for gets REPAINTED after the step starts —
        true while the app churns frames, false once a flicker fix stops
        the repaints (the #622 oversized ask box then paints exactly once,
        before this step, and the guard could never match it: the wait
        burned its whole budget and the runner killed the harness). Opt-in,
        never the default: needles that merely prove "the app repainted"
        (e.g. a modal-closed anchor) must keep requiring a fresh paint.

        `entry_buffer` (#1045): same opt-in shape as `on_screen`, but the
        whole byte BUFFER counts at step entry, not just the screen — for
        one-shot needles painted before or right at step entry, where a
        `since`-guarded wait could never match a second occurrence. Known
        limit: a needle that recurs satisfies instantly on its first
        occurrence; such steps need a per-turn-unique needle."""
        target = needle.encode("utf-8", "replace")

        def visible() -> bool:
            # Screen AND scrollback: the row may already have left the
            # visible area while still being on screen for the user.
            return any(needle in line for line in screen.lines()) \
                or any(needle in line for line in screen.scrollback_view)

        end = time.time() + seconds
        # #1045: the needle may already have been painted BEFORE the step
        # began (the boot pump paints the composer, and a flicker fix can
        # mean nothing repaints afterwards). Readiness asks "has the state
        # been reached", not "does it get repainted": accept a whole-buffer
        # match at entry instead of burning the budget on the `since` guard.
        if (entry_buffer or on_screen):
            # #1045: at step entry a needle already in the buffer (or on
            # screen) means the state was reached before the step began.
            if buf.find(target) != -1 or visible():
                return True
        while time.time() < end:
            if buf.find(target, since) != -1:
                pump(0.2)  # let the frame finish painting
                return True
            if on_screen and visible():
                pump(0.2)
                return True
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError as err:
                    if err.errno != errno.EINTR:
                        # #1045: the master closed — the child is gone (a
                        # closed master can also surface as an empty read,
                        # handled below). Fail loudly instead of returning
                        # False and letting the assertions run over a
                        # snapshot the step never reached.
                        raise RuntimeError(
                            f"pty readiness wait: terminal closed while waiting for {needle!r}")
                    continue
                if chunk:
                    buf.extend(chunk)
                    screen.feed_bytes(chunk)
                elif proc.poll() is not None:
                    # EOF with the child gone: the terminal closed (macOS
                    # reports a closed master as b"" rather than OSError).
                    raise RuntimeError(
                        f"pty readiness wait: terminal closed while waiting for {needle!r}")
                # An empty read while the child lives is not evidence of
                # anything; keep waiting (a raise here would kill runs on
                # spurious wakeups).
        # #1045: an expired readiness wait used to return False that the
        # call site dropped, so the runner pumped a fixed follow-up sleep and
        # asserted on a state the step never verified (#1045's CI failure
        # snapped a mid-stream dump). By this point the needle is nowhere in
        # the buffer and not on screen: the state was never reached. Say so,
        # naming the needle, instead of failing later on an assertion that
        # could never hold.
        tail = bytes(buf[-2000:]).decode("utf-8", "replace")
        raise RuntimeError(
            f"pty readiness wait expired after {seconds}s: needle {needle!r} never appeared"
            f"\n--- buffer tail ---\n{tail}")

    def send(b64: str) -> None:
        os.write(master, base64.b64decode(b64))

    checkpoints = {}

    def snapshot():
        rendered = []
        for line in screen.lines()[-spec.get("tail", rows):]:
            rendered.append({
                "lead": len(line) - len(line.lstrip()),
                "width": len(line),
                "text": line,
            })
        return {"lines": rendered, "scrollback": list(screen.scrollback_view)}

    try:
        pump(2.5)  # boot: onboarding appears
        for step in spec.get("steps", []):
            if step.get("until"):
                # Readiness steps are send-only-free by contract: a step that
                # both waits for readiness and sends would be ambiguous, so
                # refuse it loudly instead of silently dropping the send.
                if step.get("send"):
                    raise ValueError("pty step: 'until' and 'send' are mutually exclusive")
                pump_until(step.get("wait", 5.0), step["until"], since=len(buf), on_screen=bool(step.get("untilOnScreen")), entry_buffer=bool(step.get("untilFromBuffer")))
            else:
                if step.get("send"):
                    send(step["send"])
                pump(step.get("wait", 0.3))
            if step.get("mark"):
                # #1022: a mark delimits measurement windows — the window
                # following it is the one the assertions are about. The frame
                # being painted right now counts for the window that is
                # closing, not for the one that opens here.
                screen._close_frame()
                screen.mark = len(screen.windows)
            if step.get("markEnd"):
                # #1022: closes the window opened by the last `mark` — the
                # frames after this point belong to another phase (settle)
                # and must not be attributed to the streaming window.
                screen._close_frame()
                screen.markEnd = len(screen.windows)
            if step.get("checkpoint"):
                checkpoints[step["checkpoint"]] = snapshot()
        resize = spec.get("resize")
        if resize:
            fcntl.ioctl(master, termios.TIOCSWINSZ,
                        struct.pack("HHHH", resize["rows"], resize["cols"], 0, 0))
            os.kill(proc.pid, signal.SIGWINCH)
            previous_scrollback = screen.scrollback_view
            screen = Screen(resize["cols"], resize["rows"])  # Ink fully repaints after SIGWINCH
            screen.scrollback = previous_scrollback
            pump(2.0)
            if resize.get("until"):
                # Readiness wait for the post-resize repaint: a fixed pump can
                # stop mid-frame on a slow host, leaving the last footer rows
                # unpainted (#538 flake). Wait until the needle appears in the
                # post-resize byte stream (or the budget expires).
                pump_until(resize.get("untilWait", 10.0), resize["until"], since=len(buf))
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
        # Bounded, best-effort reap: the child may be mid-tool-call and take
        # seconds to die (its own exit-work budget). Shutdown slowness is not
        # a crash — a hard kill is enough here; the runner-level 45s budget
        # owns real timeouts (#595 flake).
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
    # Normal exits: the double-ctrl+c quit (0), an already-exited child
    # (None), or our own shutdown signals. -9 and -15 mean WE killed it
    # (runner budget or the shutdown path above), never a child crash.
    if proc.returncode not in (0, None, -signal.SIGINT, -signal.SIGTERM, -9, -15):
        # #595 flake: when the TUI child crashes mid-script (an uncaught
        # error on stderr), the readiness `pump_until` budgets would keep
        # draining on a dead screen and the test would fail later on an
        # unrelated assertion — or look hung. Fail fast with the child's
        # output so the diagnosis lands in the failure message.
        text = bytes(buf).decode("utf-8", "replace")
        clean = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()][A-Z0-9]", "", text)
        raise RuntimeError(f"moh TUI crashed under the PTY harness (exit {proc.returncode}):\n{clean[-4000:]}")

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
    if os.environ.get("MOH_PTY_DUMP"):
        json.dump(checkpoints, open(os.environ["MOH_PTY_DUMP"], "w"), default=str)
    mark = screen.mark or 0
    end = screen.markEnd if screen.markEnd is not None else len(screen.windows)
    window = screen.windows[mark:end]
    fullscreen_after_mark = sum(1 for _, is_fullscreen in window if is_fullscreen)
    rows_after_mark = [height for height, is_fullscreen in window if not is_fullscreen]
    payload = {"lines": out, "scrollback": screen.scrollback_view, "checkpoints": checkpoints, "exited": proc.poll() is not None, "exitCode": proc.returncode, "aliveAtEnd": alive_at_end, "maxFrameRows": screen.max_frame_rows, "frames": len(screen.frames), "fullscreenFrames": screen.fullscreen_frames, "framesAfterMark": len(window), "maxFrameRowsAfterMark": max(rows_after_mark) if rows_after_mark else 0, "fullscreenAfterMark": fullscreen_after_mark}
    json.dump(payload, sys.stdout)


if __name__ == "__main__":
    main()
