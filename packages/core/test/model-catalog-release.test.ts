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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createLockFile, releaseLockFile } from "../src/memory-lock";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../src/model-catalogs/manifest.json";
import { releaseVersionProblem } from "../scripts/model-catalog-build";

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
    // The age is the committed manifest's, not the rebuild's: it is readable
    // whatever the guards decide about the rebuild itself.
    expect(lines[0]).toMatch(
      new RegExp(`^catalog freshness — the committed catalog declares moh ${manifest.version.replace(/\./g, "\\.")}, generated ${manifest.generatedAt}`),
    );
    expect(lines[0]).toContain(`old against ${REFERENCE}`);
    // The drifted-file count survives; the row counts cannot be measured and
    // say so instead of reading as zero.
    expect(lines[1]).toMatch(/^upstream moved since: \d+ of 25 file\(s\) differ — the rebuild was refused by the guards, so no row-level move could be counted$/);
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

describe("catalog publication safety", () => {
  // Copy the real CLI and its implementation to a temporary repository.
  // The production path stays fixed relative to the script: no test-only
  // output directory, filesystem mock, network, or modified checkout.
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "moh-catalog-publication-"));
    const scripts = join(root, "scripts");
    const src = join(root, "src");
    const dir = join(src, "model-catalogs");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(dir, { recursive: true });
    for (const name of ["build-model-catalogs.ts", "model-catalog-build.ts"]) copyFileSync(join(import.meta.dir, "../scripts", name), join(scripts, name));
    for (const name of ["memory-lock.ts", "fs-atomic.ts"]) copyFileSync(join(import.meta.dir, "../src", name), join(src, name));
    const row = { id: "one", name: "One", api: "openai-completions", contextWindow: 100, cost: { input: 1, output: 2 } };
    const overrides = { schemaVersion: 1, provider: "demo", source: { modelsDev: ["demo"] }, rows: { one: { author: "test", date: "2026-11-11", reason: "fixture", name: "One", api: "openai-completions" } } };
    writeFileSync(join(dir, "demo.json"), JSON.stringify({ "openai-completions": { one: row } }));
    writeFileSync(join(dir, "demo.overrides.json"), JSON.stringify(overrides));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: "1.0.0" }));
    writeFileSync(join(dir, "generation-report.json"), "previous report\n");
    const md = join(root, "models-dev.json");
    const or = join(root, "open-router.json");
    writeFileSync(md, JSON.stringify({ demo: { models: { one: { id: "one", limit: { context: 200 }, cost: { input: 2, output: 4 } } } } }));
    writeFileSync(or, '{"data":[]}');
    const run = (args: string[] = ["--version", "1.0.1"]) => Bun.spawnSync([process.execPath, join(scripts, "build-model-catalogs.ts"), ...args, "--models-dev", md, "--open-router", or], { stdout: "pipe", stderr: "pipe" });
    const contents = () => Object.fromEntries(readdirSync(dir).filter(name => statSync(join(dir, name)).isFile()).sort().map(name => [name, readFileSync(join(dir, name), "utf8")]));
    return { root, dir, md, or, run, contents };
  }

  for (const failure of ["missing-source", "invalid-json", "empty-source", "late-sidecar", "missing-sidecar", "staging-write"] as const) {
    test(`${failure}: refuses the build and preserves every published byte`, () => {
      const f = fixture();
      try {
        if (failure === "missing-source") rmSync(f.md);
        if (failure === "invalid-json") writeFileSync(f.md, "{");
        if (failure === "empty-source") writeFileSync(f.md, "{}");
        if (failure === "late-sidecar") writeFileSync(join(f.dir, "zzz.overrides.json"), "{");
        if (failure === "missing-sidecar") rmSync(join(f.dir, "demo.overrides.json"));
        if (failure === "staging-write") {
          rmSync(join(f.dir, "generation-report.json"));
          mkdirSync(join(f.dir, "generation-report.json"));
          writeFileSync(join(f.dir, "generation-report.json", "keep"), "previous");
        }
        const before = f.contents();
        const result = f.run();
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain("failed");
        expect(f.contents()).toEqual(before);
        if (failure === "staging-write") expect(readFileSync(join(f.dir, "generation-report.json", "keep"), "utf8")).toBe("previous");
        expect(existsSync(`${f.dir}.previous`)).toBe(false);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    });
  }

  test("a late migration error cannot leave an earlier sidecar behind", () => {
    const f = fixture();
    try {
      rmSync(join(f.dir, "demo.overrides.json"));
      renameSync(join(f.dir, "demo.json"), join(f.dir, "anthropic.json"));
      writeFileSync(join(f.dir, "zzz.json"), "{}");
      const before = f.contents();
      expect(f.run(["--migrate-overrides", "--version", "1.0.1"]).exitCode).toBe(1);
      expect(f.contents()).toEqual(before);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("recovery keeps the complete new generation after the second rename", () => {
    const f = fixture();
    try {
      mkdirSync(`${f.dir}.previous`);
      writeFileSync(join(`${f.dir}.previous`, "manifest.json"), '{"version":"0.9.0"}');
      const before = f.contents();
      expect(f.run(["--verify-version", "1.0.0"]).exitCode).toBe(0);
      expect(f.contents()).toEqual(before);
      expect(existsSync(`${f.dir}.previous`)).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("publishes a complete generation whose files match its manifest", () => {
    const f = fixture();
    try {
      const sidecar = readFileSync(join(f.dir, "demo.overrides.json"), "utf8");
      const result = f.run();
      expect(result.exitCode).toBe(0);
      const m = JSON.parse(readFileSync(join(f.dir, "manifest.json"), "utf8"));
      expect(m.version).toBe("1.0.1");
      expect(m.files.demo.sha256).toBe(createHash("sha256").update(readFileSync(join(f.dir, "demo.json"))).digest("hex"));
      expect(JSON.parse(readFileSync(join(f.dir, "generation-report.json"), "utf8")).issues).toEqual([]);
      expect(readFileSync(join(f.dir, "demo.overrides.json"), "utf8")).toBe(sidecar);
      expect(existsSync(`${f.dir}.previous`)).toBe(false);
      expect(existsSync(`${f.dir}.staging`)).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("refuses a live generator's lock without touching its staging files", () => {
    const f = fixture();
    try {
      expect(createLockFile(`${f.dir}.lock`)).toBe(true);
      // A different cached uptime must never make a live PID reclaimable.
      const lock = JSON.parse(readFileSync(`${f.dir}.lock`, "utf8"));
      writeFileSync(`${f.dir}.lock`, JSON.stringify({ ...lock, boot: 0 }));
      mkdirSync(`${f.dir}.staging`);
      writeFileSync(join(`${f.dir}.staging`, "sentinel"), "busy");
      const before = f.contents();
      expect(f.run().exitCode).toBe(1);
      expect(f.contents()).toEqual(before);
      expect(readFileSync(join(`${f.dir}.staging`, "sentinel"), "utf8")).toBe("busy");
    } finally { releaseLockFile(`${f.dir}.lock`); rmSync(f.root, { recursive: true, force: true }); }
  });

  test("an occupied reclamation marker is never removed by a contender", () => {
    const f = fixture();
    try {
      expect(createLockFile(`${f.dir}.lock`)).toBe(true);
      expect(createLockFile(`${f.dir}.reclaim`)).toBe(true);
      const before = f.contents();
      const result = f.run();
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("lock recovery is busy or interrupted");
      expect(existsSync(`${f.dir}.reclaim`)).toBe(true);
      expect(f.contents()).toEqual(before);
    } finally {
      releaseLockFile(`${f.dir}.lock`);
      releaseLockFile(`${f.dir}.reclaim`);
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("recovers a process killed between directory renames before checking the version", () => {
    const f = fixture();
    try {
      const before = f.contents();
      renameSync(f.dir, `${f.dir}.previous`);
      mkdirSync(`${f.dir}.staging`);
      writeFileSync(join(`${f.dir}.staging`, "incomplete"), "partial");
      // A process-boundary fixture: the lock's owner has really exited.
      const lockScript = `import { createLockFile } from ${JSON.stringify(join(f.root, "src/memory-lock.ts"))}; createLockFile(${JSON.stringify(`${f.dir}.lock`)});`;
      expect(Bun.spawnSync([process.execPath, "-e", lockScript]).exitCode).toBe(0);
      expect(f.run(["--verify-version", "1.0.0"]).exitCode).toBe(0);
      expect(f.contents()).toEqual(before);
      expect(existsSync(`${f.dir}.previous`)).toBe(false);
      expect(existsSync(`${f.dir}.staging`)).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 15_000);
});
