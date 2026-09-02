/**
 * Session Handoff T2 (#435): the `moh run` exit publish. With
 * handoff.transport "gist" and no local artifact, the run still exits 0
 * (transport failures are warnings, story 15) and the warning goes to
 * stderr — stdout stays pure JSONL. No gh, no network: the missing
 * artifact short-circuits before any gh call.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../src/run";

const TMP = join(import.meta.dir, "tmp-run-handoff");

function projectDir(name: string, transport?: string): { cwd: string; home: string } {
  const dir = join(TMP, name);
  const cwd = join(dir, "project");
  const home = join(dir, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (transport) writeFileSync(join(cwd, "moh.json"), JSON.stringify({ handoff: { transport } }));
  return { cwd, home };
}

function streams() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: { write: (s: string) => void out.push(s) } as unknown as NodeJS.WritableStream,
    stderr: { write: (s: string) => void err.push(s) } as unknown as NodeJS.WritableStream,
  };
}

describe("moh run handoff exit publish (#435)", () => {
  test("gist transport with no local artifact warns on stderr and still exits 0", async () => {
    // Isolated home: no artifact exists, so the publish short-circuits
    // before any gh call — no network, deterministic (the gh-missing
    // path itself is covered by the core fake-runner tests).
    const { cwd, home } = projectDir("gist", "gist");
    const s = streams();
    const code = await runCommand({ argv: ["hello"], cwd, home, ...s });
    expect(code).toBe(0);
    expect(s.err.join("")).toContain("handoff publish failed (no-artifact)");
    // stdout stays pure JSONL events
    for (const line of s.out.join("").split("\n").filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("transport off never touches the publish path (no warning)", async () => {
    const { cwd, home } = projectDir("off");
    const s = streams();
    const code = await runCommand({ argv: ["hello"], cwd, home, ...s });
    expect(code).toBe(0);
    expect(s.err.join("")).not.toContain("handoff");
  });
});

afterAll(() => rmSync(TMP, { recursive: true, force: true }));
