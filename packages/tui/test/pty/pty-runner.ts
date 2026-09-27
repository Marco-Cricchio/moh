export interface PtyLine {
  lead: number;
  width: number;
  text: string;
}

export interface PtySpec {
  cols: number;
  rows: number;
  /** Optional mid-run resize; `until` names a readiness needle the post-resize
   * repaint must reach before the harness stops pumping (#538 mid-frame flake). */
  resize?: { cols: number; rows: number; until?: string; untilWait?: number };
  /** Optional user config written to the temp home's ~/.moh/config. */
  config?: Record<string, unknown>;
  /** When true, reports {lines, exited, exitCode} instead of bare lines. */
  meta?: boolean;
  /** Optional project moh.json written to the temp cwd. */
  project?: Record<string, unknown>;
  /** Optional path to dump the raw PTY byte stream. */
  rawDump?: string;
  /** Extra environment variables for the child (#490 image-preview
   * detection: TERM_PROGRAM, KITTY_WINDOW_ID, …). */
  env?: Record<string, string>;
  /** Files written into the child's cwd (base64 name → content), so
   * mentions can attach real project files. */
  files?: Record<string, string>;
  /** #1023: number of seeded existing sessions in the temp project's
   * session directory, so the Home list has rows. */
  seedSessions?: number;
  /** `checkpoint` snapshots physical screen + native scrollback after this
   * step, letting one script assert a mid-stream viewport and final settle. */
  steps: ReadonlyArray<{ wait?: number; send?: string; until?: string; untilOnScreen?: boolean; checkpoint?: string; mark?: boolean; markEnd?: boolean }>;
  tail?: number;
}

const HARNESS = `${import.meta.dir}/harness.py`;
const python3Path = Bun.which("python3");
export const python3 = python3Path;
export const hasPython = python3Path !== null;

/**
 * Runs the moh CLI inside a real pseudo terminal (see harness.py) and
 * returns the last rendered screen as geometry-aware lines. Requires
 * python3 on PATH — callers should skip when `python3` is null.
 */
export async function runPty(spec: PtySpec): Promise<PtyLine[]> {
  return (await runPtyRaw(spec)).lines;
}

export interface PtyMeta {
  lines: PtyLine[];
  /** Rows that left the main screen through native terminal scrolling. */
  scrollback?: string[];
  exited: boolean;
  exitCode: number | null;
  /** #236: sampled before the harness kills the process — unlike `exited`,
   * false here genuinely means the app died mid-script (OOM/kill). */
  aliveAtEnd?: boolean;
  /** #1022: the widest single repaint measured on the physical screen — the
   * row span one frame wrote, i.e. the height ink compares against
   * `stdout.rows` when it picks the log-update or the fullscreen path. */
  maxFrameRows?: number;
  /** #1022: repaints that took ink's fullscreen path (clearTerminal + full
   * static reprint) — the corruption this guard exists to prevent. */
  fullscreenFrames?: number;
  /** #1022: repaints observed AFTER the last `mark` step, and how many of
   * them took ink's fullscreen path. A startup ramp may blip fullscreen
   * (Home's own geometry); the stream that follows must not. */
  framesAfterMark?: number;
  fullscreenAfterMark?: number;
  /** #1022: the widest log-update frame after the mark, measured on the
   * physical screen — must stay strictly below the terminal height. */
  maxFrameRowsAfterMark?: number;
  /** #1022: how many repaints the harness observed (frame-accounting
   * sanity: a geometry that never repaints proves nothing). */
  frames?: number;
  /** Named physical-screen snapshots captured at PTY script checkpoints. */
  checkpoints?: Record<string, { lines: PtyLine[]; scrollback: string[] }>;
}

export async function runPtyRaw(spec: PtySpec): Promise<PtyMeta> {
  if (!python3) throw new Error("python3 not found on PATH");
  // #236: this MUST be asynchronous. Several PTY tests host their fake
  // openai-compat SSE server via Bun.serve in the parent test process; a
  // Bun.spawnSync wait blocks that process's event loop on Linux, so the
  // child TUI's fetch never reaches the handler (model_call_start, then an
  // infinite spinner; fake call count stays zero). Keeping the parent event
  // loop alive lets those cross-process requests progress.
  const proc = Bun.spawn([python3, HARNESS, JSON.stringify({ ...spec, meta: true })], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, 45_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (timedOut) throw new Error("pty harness timed out after 45000ms");
  if (exitCode !== 0) {
    throw new Error(`pty harness failed (${exitCode}): ${stderr}`);
  }
  return JSON.parse(stdout) as PtyMeta;
}

/** A session start with pinned settings: no onboarding/workflow overlays. */
export const DEV_CONFIG = { onboarded: true, workflowOffered: true, mode: "dev" };
export const VIBE_CONFIG = { onboarded: true, workflowOffered: true, mode: "vibe" };
