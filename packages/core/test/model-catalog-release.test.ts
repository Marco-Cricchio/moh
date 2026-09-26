/**
 * #1005: the release-time half of the catalog pipeline. The tag-time job
 * must report freshness (the committed catalog's age against the tagged
 * commit, and how far upstream has moved) without failing, while the drift
 * compare with a non-zero exit stays the one the daily schedule and
 * catalog PRs run. Offline throughout, through the generator's documented
 * local-snapshot seam (`--models-dev` / `--open-router`).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../src/model-catalogs/manifest.json";

const SCRIPT = join(import.meta.dir, "../scripts/build-model-catalogs.ts");

/** Empty aggregator snapshots: every row becomes hand-maintained, which is
 * the largest possible upstream move. A run that still reports instead of
 * failing is the property under test — and nothing here touches the network
 * or writes a file. */
function snapshots(): { modelsDev: string; openRouter: string } {
  const dir = mkdtempSync(join(tmpdir(), "moh-catalog-"));
  const modelsDev = join(dir, "models-dev.json");
  const openRouter = join(dir, "open-router.json");
  writeFileSync(modelsDev, "{}\n");
  writeFileSync(openRouter, '{"data":[]}\n');
  return { modelsDev, openRouter };
}

function run(args: string[]): { code: number; out: string; err: string } {
  const snap = snapshots();
  const result = Bun.spawnSync([process.execPath, SCRIPT, ...args, "--models-dev", snap.modelsDev, "--open-router", snap.openRouter], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

const REFERENCE = "2026-09-25T18:06:00.000Z";

describe("#1005 release-time catalog freshness", () => {
  test("the version contract holds offline and names both versions when it does not", () => {
    const ok = run(["--verify-version", manifest.version]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain(`manifest.json declares moh ${manifest.version}`);

    const mismatch = run(["--verify-version", "0.50.0"]);
    expect(mismatch.code).toBe(1);
    expect(mismatch.err).toContain(`manifest.json declares moh ${manifest.version}, but the release is 0.50.0`);
  });

  test("freshness reports the age against the tagged commit and how far upstream moved, without failing", () => {
    const { code, out } = run(["--freshness", "--at", REFERENCE]);
    expect(code).toBe(0);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(
      new RegExp(`^catalog freshness — the committed catalog declares moh ${manifest.version.replace(/\./g, "\\.")}, generated .+ — .+ old against ${REFERENCE}$`),
    );
    expect(lines[1]).toMatch(/^upstream moved since: \d+ of \d+ file\(s\) differ — \d+ price\(s\), \d+ context window\(s\), \d+ reasoning flag\(s\); \d+ guard finding\(s\)$/);
    expect(out).toContain("differs from the rebuild");
    expect(out).toMatch(/advisory: nothing here gates the release/);
    // A rebuild the guards reject is upstream moving, not a reason to fail.
    expect(out).not.toContain("generation failed");
  });

  test("the drift compare keeps its non-zero exit for the scheduled and PR runs", () => {
    const check = run(["--check"]);
    expect(check.code).toBe(1);
    expect(check.err).toContain("generation failed");
  });

  test("--check and --freshness together are a usage error, not a silent choice", () => {
    const both = run(["--check", "--freshness"]);
    expect(both.code).toBe(2);
    expect(both.err).toContain("--check fails on drift and --freshness reports it");
  });
});
