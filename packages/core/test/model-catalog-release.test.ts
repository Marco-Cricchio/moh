/**
 * #1005: the release-time half of the catalog pipeline. Two properties of
 * the generator's CLI, both offline through its documented local-snapshot
 * seam (`--models-dev` / `--open-router`) and neither touching the network
 * or writing a file:
 *
 * - the drift compare that exits non-zero stays reachable — the daily
 *   schedule and catalog PRs run it (`--check`);
 * - the tag-time job (`--freshness`) reports instead of judging, and no
 *   flavour of drift turns it red: what it can measure it states, what it
 *   cannot reads `--`, and the only failure left is a source that could not
 *   be fetched at all.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../src/model-catalogs/manifest.json";
import { releaseVersionProblem } from "../src/model-catalog-build";

const SCRIPT = join(import.meta.dir, "../scripts/build-model-catalogs.ts");
const REFERENCE = "2026-09-25T18:06:00.000Z";

/** Empty aggregator snapshots: every committed row loses its aggregator
 * data, which is the largest possible upstream move. Nothing here touches
 * the network or writes a file. */
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

describe("#1005 release-time catalog freshness", () => {
  test("the version contract holds offline and names both versions when it does not", () => {
    const ok = run(["--verify-version", manifest.version]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain(`manifest.json declares moh ${manifest.version}`);

    const mismatch = run(["--verify-version", "0.50.0"]);
    expect(mismatch.code).toBe(1);
    expect(mismatch.err).toContain(`manifest.json declares moh ${manifest.version}, but the release is 0.50.0`);
  });

  test("a manifest with no version at all breaks the contract too, and says so", () => {
    // The branch a hand-edited or pre-manifest tree would hit: the release
    // must not proceed on a catalog that declares nothing.
    expect(releaseVersionProblem(undefined, "0.51.0")).toBe(
      "manifest.json declares moh (no version), but the release is 0.51.0 — regenerate with --version 0.51.0 and commit the result",
    );
    expect(releaseVersionProblem("0.51.0", "0.51.0")).toBeUndefined();
  });

  test("a rebuild the guards refuse still reports — age and drifted files, with no row counts", () => {
    // Empty snapshots: every committed row loses its aggregator data, so the
    // guards reject the rebuild. That is the release whose freshness is worth
    // reading most, and there is no flavour of drift that makes this job red.
    const { code, out } = run(["--freshness", "--at", REFERENCE]);
    expect(code).toBe(0);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(
      new RegExp(`^catalog freshness — the committed catalog declares moh ${manifest.version.replace(/\./g, "\\.")}, generated 2026-09-25T22:02:23\\.839Z`),
    );
    expect(lines[0]).toContain(`old against ${REFERENCE}`);
    // The drifted-file count survives; the row counts cannot be measured and
    // say so instead of reading as zero.
    expect(lines[1]).toBe(
      "upstream moved since: 18 of 25 file(s) differ — the rebuild was refused by the guards, so no row-level move could be counted",
    );
    expect(out).toContain("  anthropic.json: differs from the rebuild");
    expect(out).toMatch(/^  guard: .+/m);
    expect(out).toMatch(/advisory: \d+ committed file\(s\) differ and \d+ guard finding\(s\)/);
    expect(out).not.toContain("0 price(s)");
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
