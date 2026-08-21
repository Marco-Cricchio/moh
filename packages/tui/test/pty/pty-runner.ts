export interface PtyLine {
  lead: number;
  width: number;
  text: string;
}

export interface PtySpec {
  cols: number;
  rows: number;
  resize?: { cols: number; rows: number };
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
  if (!python3) throw new Error("python3 not found on PATH");
  const result = Bun.spawnSync([python3, HARNESS, JSON.stringify(spec)], {
    timeout: 45_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`pty harness failed (${result.exitCode}): ${new TextDecoder().decode(result.stderr)}`);
  }
  return JSON.parse(new TextDecoder().decode(result.stdout)) as PtyLine[];
}
