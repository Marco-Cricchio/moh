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
  steps: ReadonlyArray<{ wait?: number; send?: string }>;
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
}

export async function runPtyRaw(spec: PtySpec): Promise<PtyMeta> {
  if (!python3) throw new Error("python3 not found on PATH");
  const result = Bun.spawnSync([python3, HARNESS, JSON.stringify({ ...spec, meta: true })], {
    timeout: 45_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`pty harness failed (${result.exitCode}): ${new TextDecoder().decode(result.stderr)}`);
  }
  return JSON.parse(new TextDecoder().decode(result.stdout)) as PtyMeta;
}

/** A session start with pinned settings: no onboarding/workflow overlays. */
export const DEV_CONFIG = { onboarded: true, workflowOffered: true, mode: "dev" };
export const VIBE_CONFIG = { onboarded: true, workflowOffered: true, mode: "vibe" };
