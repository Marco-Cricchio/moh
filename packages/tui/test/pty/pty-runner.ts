export interface PtyLine {
  lead: number;
  width: number;
  text: string;
}

export interface PtySpec {
  cols: number;
  rows: number;
  resize?: { cols: number; rows: number };
  /** Optional user config written to the temp home's ~/.moh/config. */
  config?: Record<string, unknown>;
  /** When true, reports {lines, exited, exitCode} instead of bare lines. */
  meta?: boolean;
  /** Optional project moh.json written to the temp cwd. */
  project?: Record<string, unknown>;
  /** Optional path to dump the raw PTY byte stream. */
  rawDump?: string;
  steps: ReadonlyArray<{ wait?: number; send?: string; until?: string }>;
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
  exited: boolean;
  exitCode: number | null;
  /** #236: sampled before the harness kills the process — unlike `exited`,
   * false here genuinely means the app died mid-script (OOM/kill). */
  aliveAtEnd?: boolean;
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
