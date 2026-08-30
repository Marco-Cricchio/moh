/**
 * #351: progress rendering for `moh update` — one line per phase committed
 * with ✓/✗, a braille spinner on the open phase line in TTY runs, plain
 * milestone lines when piped (no ANSI, no animation, no timers). The core
 * emits `SelfUpdateProgress` transitions; this module owns all presentation.
 *
 * Output goes to stdout: progress is the normal output of an interactive
 * update; the final result message keeps its existing stream (stdout on
 * success, stderr otherwise).
 */

/** Braille spinner frames, brew-style cadence (see DEFAULT_TICK_MS). */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const DEFAULT_TICK_MS = 80;

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

/** Human-readable byte size: `35 B`, `46.2 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** True when spinner animation and colors are appropriate for `stream`. */
export function interactiveStream(stream: NodeJS.WritableStream): boolean {
  return (stream as { isTTY?: boolean }).isTTY === true && !process.env.NO_COLOR;
}

export interface UpdateProgressOptions {
  /** Destination for all progress output. */
  stream: NodeJS.WritableStream;
  /** TTY mode: in-place repaint, spinner, colors. Plain mode commits lines only. */
  interactive: boolean;
  /** Spinner repaint interval; 0 disables the timer (tests). */
  tickMs?: number;
}

interface OpenPhase {
  label: string;
  frame: number;
  timer: ReturnType<typeof setInterval> | null;
}

/** Phase-line renderer driven by `SelfUpdateProgress` transitions. */
export class UpdateProgress {
  private open: OpenPhase | null = null;
  private paused = false;
  private cursorHidden = false;

  constructor(private readonly opts: UpdateProgressOptions) {}

  private get ansi(): boolean {
    return this.opts.interactive;
  }

  private write(s: string): void {
    this.opts.stream.write(s);
  }

  private paintFrame(): void {
    if (!this.open) return;
    const frame = FRAMES[this.open.frame % FRAMES.length];
    const marker = this.ansi ? `${DIM}${frame}${RESET}` : frame;
    this.write(`\r${marker} ${this.open.label}`);
  }

  /** Starts a phase: TTY runs open a spinner line; plain runs stay silent
   * until the phase commits. Starting the next phase implicitly commits
   * the open one with ✓ (the core only advances after success). */
  begin(label: string): void {
    if (this.open) this.commit(true);
    this.open = { label, frame: 0, timer: null };
    this.paused = false;
    if (this.ansi) {
      this.hideCursor();
      this.paintFrame();
      const tick = this.opts.tickMs ?? DEFAULT_TICK_MS;
      if (tick > 0) {
        this.open.timer = setInterval(() => {
          if (!this.open) return;
          this.open.frame++;
          this.paintFrame();
        }, tick);
      }
    }
  }

  /** Commits the open phase line with ✓ (or ✗) and an optional detail
   * (e.g. downloaded size). No-op when no phase is open. */
  commit(ok: boolean, detail?: string): void {
    if (!this.open) return;
    this.stopTimer();
    const { label } = this.open;
    const detailPlain = detail ? ` — ${detail}` : "";
    if (this.ansi) {
      const marker = ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      const tail = detail ? ` ${DIM}— ${detail}${RESET}` : "";
      this.write(`\r${marker} ${label}${tail}\n`);
      this.showCursor();
    } else {
      this.write(`${ok ? "✓" : "✗"} ${label}${detailPlain}\n`);
    }
    this.open = null;
    this.paused = false;
  }

  /** Clears the open line (keeps it open) and pauses animation — used
   * around the interactive downgrade prompt so readline owns the terminal. */
  pause(): void {
    if (!this.open) return;
    this.stopTimer();
    this.clearLine();
    this.paused = true;
  }

  /** Repaints the open phase line after a `pause`. */
  resume(): void {
    if (!this.open || !this.paused) return;
    this.paused = false;
    if (this.ansi) {
      this.hideCursor();
      this.paintFrame();
      const tick = this.opts.tickMs ?? DEFAULT_TICK_MS;
      if (tick > 0) {
        this.open.timer = setInterval(() => {
          if (!this.open) return;
          this.open.frame++;
          this.paintFrame();
        }, tick);
      }
    }
  }

  /** Last-resort cleanup: stop timers, drop any uncommitted line, restore
   * the cursor. Idempotent; safe to call in a finally block. */
  end(): void {
    this.stopTimer();
    if (this.open) {
      this.clearLine();
      this.open = null;
    }
    this.showCursor();
  }

  private startTimer(): void {
    if (!this.ansi || !this.open) return;
    const tick = this.opts.tickMs ?? DEFAULT_TICK_MS;
    if (tick <= 0) return;
    this.open.timer = setInterval(() => {
      if (!this.open) return;
      this.open.frame++;
      this.paintFrame();
    }, tick);
  }

  private stopTimer(): void {
    if (this.open?.timer) {
      clearInterval(this.open.timer);
      this.open.timer = null;
    }
  }

  /** Erases the open line content (keeps it open), TTY only. */
  private clearLine(): void {
    if (!this.open || !this.ansi) return;
    const frame = FRAMES[0];
    this.write(`\r${" ".repeat(frame.length + 1 + this.open.label.length)}\r`);
  }

  private hideCursor(): void {
    if (!this.cursorHidden && this.ansi) {
      this.write(HIDE_CURSOR);
    }
    this.cursorHidden = true;
  }

  private showCursor(): void {
    if (this.cursorHidden && this.ansi) {
      this.write(SHOW_CURSOR);
    }
    this.cursorHidden = false;
  }
}
