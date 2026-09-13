import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MpmService } from "../src/mpm/service";
import { MpmLifecycle } from "../src/mpm/lifecycle";
import { MpmOrientation } from "../src/mpm/orientation";
import { mpmDiagnostics } from "../src/mpm/diagnostics";
import { extractWorkspace } from "../src/mpm/extractor";
import { resolveMpmConfig } from "../src/mpm/config";
import { validatedWarmupPaths, requestWarmup } from "../src/mpm/handoff-warmup";
import { discoverWorkspace } from "../src/mpm/discover";

/**
 * #621 — MPM end-to-end hardening and release gate (spec #613). A maintained
 * multi-language corpus drives end-to-end scenarios through the real seams
 * (extraction → store → service → orientation → lifecycle → diagnostics →
 * handoff warm-up): targeted multi-file orientation, ordinary fallback,
 * external edits, disabled mode, subagent-relevant snapshots, handoff
 * warm-up, identity migration, disposable-cache recovery, large-workspace
 * budgets, and foreground responsiveness while background work is active.
 */

/**
 * The maintained multi-language corpus: full capability (TypeScript with
 * proven imports + a directly-referencing test), partial capability
 * (Python path-based imports, JSON config-links), and silence-by-design
 * (Markdown maps with no relations). Secrets and dependency trees prove
 * discovery exclusions.
 */
const CORPUS: Record<string, string> = {
  "src/date.ts": [
    'import { DateLike } from "./types";',
    "export function formatDate(d: DateLike): string { return d.toISOString(); }",
  ].join("\n"),
  "src/types.ts": ["export interface DateLike { toISOString(): string; }"].join("\n"),
  "src/date.test.ts": ['import { formatDate } from "./date";', "test('formats', () => {});"].join("\n"),
  "src/report.py": [
    "from .utils.helpers import format",
    "def render(report):",
    "    return format(report)",
  ].join("\n"),
  "src/utils/helpers.py": ["def format(x):", "    return str(x)"].join("\n"),
  "config/app.json": ['{"entry": "./src/date.ts"}'].join("\n"),
  "docs/notes.md": ["# Notes", "No structural facts are provable here."].join("\n"),
  // Never mapped: sensitive denylist and dependency tree.
  ".env": "SECRET=never",
  "keys/server.key": "never-mapped",
  "node_modules/left-pad/index.js": "module.exports = () => 1;",
};

async function writeCorpus(root: string): Promise<void> {
  for (const [path, content] of Object.entries(CORPUS)) {
    const abs = join(root, path);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content);
  }
}

const tmpDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(root);
  return root;
}

/** A live projection built the way production builds it: real extraction. */
function serviceFor(root: string): MpmService {
  const service = new MpmService(join(root, "project-map"));
  service.rebuild(extractWorkspace(root));
  return service;
}

/** Fake synchronous clock for deterministic lifecycle ticks. */
function fakeTimers() {
  let now = 1_000_000;
  const timers: { fn: () => void }[] = [];
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    setInterval(fn: () => void) {
      timers.push({ fn });
      return timers.length - 1;
    },
    clearInterval() {},
    tick() {
      for (const t of [...timers]) t.fn();
    },
  };
}

describe("MPM release gate (#621)", () => {
  test("corpus maps multi-language coverage with exclusions held", async () => {
    const root = await tempRoot("moh-mpm-gate-");
    await writeCorpus(root);
    const service = serviceFor(root);

    // Full capability: TS imports resolve to real paths; test→subject edge.
    expect(service.record("src/date.ts")!.relations.map((r) => r.target)).toContain("src/types.ts");
    expect(service.record("src/date.test.ts")!.relations.some((r) => r.kind === "references" && r.target === "src/date.ts")).toBe(true);
    // Partial capability: only the relative Python import is provable —
    // the absolute form would be an invented relation (silence instead).
    expect(service.record("src/report.py")!.relations.map((r) => r.target)).toContain("src/utils/helpers.py");
    // Config-links: JSON points at a real workspace file.
    expect(service.record("config/app.json")!.relations.some((r) => r.kind === "config-links")).toBe(true);
    // Silence by design: Markdown maps with zero proven relations.
    const md = service.record("docs/notes.md");
    expect(md).not.toBeNull();
    expect(md!.relations).toHaveLength(0);
    // Secure discovery: sensitive files, keys, and node_modules never map.
    expect(service.record(".env")).toBeNull();
    expect(service.record("keys/server.key")).toBeNull();
    expect(service.record("node_modules/left-pad/index.js")).toBeNull();
    expect(discoverWorkspace(root)).not.toContain(".env");
  });

  test("targeted multi-file change gets a source-cited plan spanning import and test edges", async () => {
    const root = await tempRoot("moh-mpm-gate-");
    await writeCorpus(root);
    const service = serviceFor(root);
    const orientation = new MpmOrientation({ service, root });

    const plan = orientation.planFor("change src/date.ts formatting behavior");
    expect(plan).not.toBeNull();
    // Every entry cites its path; proven relations carry coordinates.
    expect(plan).toContain("src/types.ts");
    expect(plan).toMatch(/src\/types\.ts at line \d+/);
    expect(plan).toContain("src/date.test.ts");
    // Advisory framing and verification instruction are present.
    expect(plan).toContain("advisory");
    expect(plan).toContain("verify");
    // The directly-referencing test is cited as test-subject provenance.
    expect(plan).toMatch(/src\/date\.test\.ts/);
    // Never a source excerpt: only paths, coordinates, and reasons.
    expect(plan).not.toContain("toISOString");
    expect(plan).not.toContain("export ");
  });

  test("ordinary fallback: no plan for unmapped, unsupported, or prose scopes", async () => {
    const root = await tempRoot("moh-mpm-gate-");
    await writeCorpus(root);
    const service = serviceFor(root);
    const orientation = new MpmOrientation({ service, root });

    // Nothing in the task maps: no plan, honest fallback reason.
    expect(orientation.planFor("rewrite the project README prose")).toBeNull();
    expect(orientation.lastFallbackReason).toBe("no-eligible-seed");
    // The derived map never invents relations for silence-by-design files:
    // the markdown note maps, but citing it as a change target is refused.
    expect(orientation.planFor("please work on docs/notes.md")).toBeNull();
    // Available-but-unrelated workspace: still a clean fallback.
    expect(orientation.planFor("summarize our conversation")).toBeNull();
  });

  test("external edits after mapping: the stale orientation is refused and the lifecycle restores freshness", async () => {
    const root = await tempRoot("moh-mpm-gate-");
    await writeCorpus(root);
    const service = serviceFor(root);
    const clock = fakeTimers();
    const lifecycle = new MpmLifecycle({ service, root, timers: clock, debounceMs: 10 });
    const orientation = new MpmOrientation({ service, root });

    // External edit lands after mapping (before the write): the obsolete
    // orientation is refused — the ordinary write path rechecks against
    // the real file, never a stale map.
    await writeFile(join(root, "src/date.ts"), "export const rewritten = true;\n");
    expect(orientation.planFor("change src/date.ts formatting behavior")).toBeNull();
    expect(orientation.lastFallbackReason).toBe("stale");

    // The debounced external-change observation remaps the file.
    lifecycle.noteExternalChange("src/date.ts");
    clock.advance(20);
    clock.tick();
    const refreshed = orientation.planFor("change src/date.ts formatting behavior");
    expect(refreshed).not.toBeNull();
    // The surviving incoming edge (the test) is still cited; the dropped
    // outgoing edge (the import) is gone from the plan — honest freshness.
    expect(refreshed).toContain("src/date.test.ts");
    expect(refreshed).not.toContain("src/types.ts");
    lifecycle.dispose();
  });

  test("moh-observed edits refresh at the highest priority", async () => {
    const root = await tempRoot("moh-mpm-gate-");
    await writeCorpus(root);
    const service = serviceFor(root);
    const clock = fakeTimers();
    const lifecycle = new MpmLifecycle({ service, root, timers: clock, debounceMs: 10_000 });

    await writeFile(join(root, "src/types.ts"), "export interface DateLike { toISOString(): string; }\nexport type X = 1;\n");
    lifecycle.noteEdit("src/types.ts");
    clock.tick(); // edits fire immediately, no debounce
    // The map knows the file's new content: the plan is fresh again.
    const orientation = new MpmOrientation({ service, root });
    expect(orientation.planFor("work on src/types.ts")).not.toBeNull();
    lifecycle.dispose();
  });

  test("disabled mode: an explicit project opt-out wins, diagnostics say why, nothing maps", async () => {
    const root = await tempRoot("moh-mpm-gate-");
    await writeCorpus(root);
    // ADR-0026: an explicit project enabled:false overrides a global opt-in.
    const forced = resolveMpmConfig({ enabled: true }, { enabled: false });
    expect(forced.enabled).toBe(false);
    expect(forced.disabledReason).toBe("project");

    const service = new MpmService(join(root, "project-map"));
    service.rebuild(extractWorkspace(root));
    const diagnostics = mpmDiagnostics({
      service,
      root,
      config: forced,
    });
    expect(diagnostics.disabled).toBe(true);
    expect(diagnostics.status).toBe("unavailable");
    expect(diagnostics.fallbackReason).toBe("disabled");
    expect(diagnostics.fileCount).toBe(0);
  });

  test("child-task orientation: the subagent snapshot seam yields a bounded, metadata-only plan", async () => {
    const root = await tempRoot("moh-mpm-gate-");
    await writeCorpus(root);
    const service = serviceFor(root);
    const orientation = new MpmOrientation({ service, root });
    // Same seam the session exposes as subagents' snapshotFor: bounded,
    // metadata-only, relevant to the child's task, no mutation surface.
    const childPlan = orientation.planFor("investigate src/report.py helpers");
    expect(childPlan).not.toBeNull();
    expect(childPlan!.length).toBeLessThan(1500);
    expect(childPlan).toContain("src/utils/helpers.py");
    // Metadata only, never extracted source content.
    expect(childPlan).not.toContain("str(x)");
    // Bounded entry count: the hard cap keeps the snapshot small.
    const lines = childPlan!.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBeLessThanOrEqual(8);
  });

  test("handoff warm-up: hints validate against the local checkout and nothing travels", async () => {
    const root = await tempRoot("moh-mpm-gate-");
    await writeCorpus(root);
    const service = serviceFor(root);

    // The receiving machine validates handoff hints locally: existing paths
    // survive, foreign absolute paths and escapes are dropped.
    const hints = {
      files: ["src/date.ts", "/other/machine/src/ghost.ts", "../escape.ts"],
      tests: ["bun test src/date.test.ts"],
    };
    const warmed = validatedWarmupPaths(root, hints);
    expect(warmed).toContain("src/date.ts");
    expect(warmed).toContain("src/date.test.ts");
    expect(warmed.some((p) => p.startsWith("..") || p.includes("ghost"))).toBe(false);

    // Warm-up refreshes through the lifecycle's highest-priority seam.
    requestWarmup(service, root, warmed);
    expect(service.status).toBe("ready");
  });

  test("identity migration: the relocated map revalidates against the active root", async () => {
    const root = await tempRoot("moh-mpm-gate-");
    await writeCorpus(root);
    const service = serviceFor(root);
    const before = service.fileCount;
    expect(before).toBeGreaterThan(0);

    // Migration: the map relocates with the project data; one file does not
    // exist at the new root (checked out differently) — it is dropped,
    // never trusted.
    await rm(join(root, "src/report.py"));
    const result = service.revalidate(root);
    expect(result.dropped).toContain("src/report.py");
    expect(result.kept).toBe(before - 1);
    // Survivors still orient; the dropped path falls back honestly.
    const orientation = new MpmOrientation({ service, root });
    expect(orientation.planFor("work on src/date.ts")).not.toBeNull();
    expect(orientation.planFor("work on src/report.py")).toBeNull();
  });

  test("recovery from a disposable-cache failure: corrupt data discards and rebuilds", async () => {
    const root = await tempRoot("moh-mpm-gate-");
    await writeCorpus(root);
    const mapDir = join(root, "project-map");
    // Corrupt the projection: a manifest the service cannot read.
    await mkdir(mapDir, { recursive: true });
    await writeFile(join(mapDir, "manifest.json"), `{"formatVersion": 99999, "shards": {}}`);
    const service = new MpmService(mapDir);
    service.load(); // never throws; corrupt/incompatible data is discarded
    expect(service.fileCount).toBe(0);
    expect(service.status).toBe("ready");

    // The projection is rebuildable from source at full fidelity.
    service.rebuild(extractWorkspace(root));
    expect(service.record("src/date.ts")).not.toBeNull();
    const orientation = new MpmOrientation({ service, root });
    expect(orientation.planFor("change src/date.ts")).not.toBeNull();
  });

  test("large-workspace budget: LRU eviction keeps the projection bounded and honest", async () => {
    const root = await tempRoot("moh-mpm-gate-");
    await writeCorpus(root);
    // Pad the workspace past a tiny quota.
    await mkdir(join(root, "gen"), { recursive: true });
    for (let i = 0; i < 10; i++) {
      await writeFile(join(root, "gen", `g${i}.ts`), `export const g${i} = ${i};\n`);
    }
    const service = serviceFor(root);
    // Force the LRU order deterministically: touching date.ts makes it
    // hot, so the padding files are the cold tail that gets evicted.
    expect(service.record("src/date.ts")).not.toBeNull();
    const evicted = service.enforceQuota({ maxFiles: 8 });
    expect(evicted.length).toBeGreaterThan(0);
    expect(service.fileCount).toBe(8);
    expect(evicted).not.toContain("src/date.ts");
    // Deterministic: the insertion-order cold tail goes first, skipping
    // the hot survivor — 3 corpus/config entries then the padding.
    expect(evicted).toEqual(["config/app.json", "docs/notes.md", "gen/g0.ts", "gen/g1.ts", "gen/g2.ts", "gen/g3.ts", "gen/g4.ts", "gen/g5.ts", "gen/g6.ts"]);
    // The diagnostics projection reports the budget and eviction cost.
    const diagnostics = mpmDiagnostics({
      service,
      root,
      config: resolveMpmConfig({ enabled: true }, { quota: { maxFiles: 8 } }),
      evictions: evicted.length,
    });
    expect(diagnostics.budget.maxFiles).toBe(8);
    expect(diagnostics.evictions).toBe(evicted.length);
    // The hot survivor still orients; evicted coverage degrades honestly.
    const orientation = new MpmOrientation({ service, root });
    expect(orientation.planFor("change src/date.ts")).not.toBeNull();
  });

  test("responsiveness: an active turn pauses background map work and plan lookups stay local", async () => {
    const root = await tempRoot("moh-mpm-gate-");
    await writeCorpus(root);
    const service = serviceFor(root);
    const clock = fakeTimers();
    let busy = false;
    const lifecycle = new MpmLifecycle({
      service,
      root,
      isBusy: () => busy,
      timers: clock,
    });

    // Work arrives while a turn is active: nothing is remapped, no budget
    // is spent; the queue simply waits.
    await writeFile(join(root, "src/types.ts"), "export interface DateLike { toISOString(): string; }\nexport type Q = 2;\n");
    lifecycle.noteEdit("src/types.ts");
    busy = true;
    clock.tick();
    // Busy yielding means the stale record is still the mapped one; the
    // honest "updating" status refuses plans mid-turn instead of citing
    // soon-to-be-refreshed content.
    const orientation = new MpmOrientation({ service, root });
    expect(service.status).toBe("updating");
    expect(orientation.planFor("change src/date.ts")).toBeNull();

    // The turn settles: the queued edit is the very next unit of work.
    busy = false;
    clock.tick();
    // Settled: fresh data, honest status, plans flow again — lookups
    // themselves never spent foreground budget.
    expect(service.status).toBe("ready");
    expect(orientation.planFor("change src/date.ts")).not.toBeNull();
    const record = service.record("src/types.ts")!;
    expect(record.symbols.some((s) => s.name === "DateLike")).toBe(true);
    expect(service.status).toBe("ready");
    lifecycle.dispose();
  });

  test("comparative: the cited plan bounds the candidate set that ordinary exploration would have to walk", async () => {
    const root = await tempRoot("moh-mpm-gate-");
    await writeCorpus(root);
    // A bigger workspace makes ordinary exploration visibly broader.
    await mkdir(join(root, "src/area-a"), { recursive: true });
    await mkdir(join(root, "src/area-b"), { recursive: true });
    for (let i = 0; i < 20; i++) {
      await writeFile(join(root, `src/area-a/f${i}.ts`), `export const a${i} = ${i};\n`);
      await writeFile(join(root, `src/area-b/f${i}.ts`), `export const b${i} = ${i};\n`);
    }
    const service = serviceFor(root);
    const orientation = new MpmOrientation({ service, root });

    // Ordinary exploration baseline: with no map, every file in the
    // workspace is a candidate — the agent must walk the tree.
    const walked = discoverWorkspace(root).length;
    expect(walked).toBeGreaterThanOrEqual(40);

    // With MPM: one bounded, source-cited plan names the related files.
    const plan = orientation.planFor("extend src/date.ts and src/report.py");
    expect(plan).not.toBeNull();
    const cited = plan!.split("\n").filter((l) => l.startsWith("- "));
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.length).toBeLessThanOrEqual(8);
    expect(cited.length).toBeLessThan(walked);
    // Every citation is verifiable against source (all mapped + fresh —
    // the orientation refuses anything else), so verification cost is per
    // cited entry, not per workspace file.
    for (const line of cited) {
      const path = line.slice(2).split(" ")[0]!;
      expect(service.record(path)).not.toBeNull();
    }
    // Coverage stayed across languages despite the same budget.
    const diagnostics = mpmDiagnostics({ service, root, config: resolveMpmConfig({ enabled: true }, {}) });
    expect(diagnostics.coverage.length).toBeGreaterThanOrEqual(3);
    expect(diagnostics.coverage.map((c) => c.language)).toContain("typescript");
    expect(diagnostics.coverage.map((c) => c.language)).toContain("python");
  });
});

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
