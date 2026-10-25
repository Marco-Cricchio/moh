/**
 * #1679: the origin probes are bounded. A `git` that never answers is killed
 * after the timeout and read as "no origin" — the caller gets null, not a
 * parked thread. The stall is a fake `git` first on the PATH of a child
 * `bun` (an in-process PATH change does not stop Bun from finding git).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("origin probe timeout (#1679)", () => {
  test("a stalled git is killed and both probes return null", async () => {
    const bin = mkdtempSync(join(tmpdir(), "moh-fake-git-"));
    dirs.push(bin);
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 30\n");
    chmodSync(join(bin, "git"), 0o755);

    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "git-origin-stall-probe.ts")], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
    const out = JSON.parse(stdout.trim().split("\n").pop()!);
    expect(out.sync.value).toBeNull();
    expect(out.async.value).toBeNull();
    // Killed at ~300 ms, nowhere near the fake git's 30 s.
    expect(out.sync.ms).toBeLessThan(5_000);
    expect(out.async.ms).toBeLessThan(5_000);
  });
});
