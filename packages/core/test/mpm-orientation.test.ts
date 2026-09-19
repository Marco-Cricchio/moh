import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MpmService } from "../src/mpm/service";
import { MpmStore } from "../src/mpm/store";
import { MpmOrientation } from "../src/mpm/orientation";
import { MPM_FORMAT_VERSION, type MpmFileRecord } from "../src/mpm/types";

/**
 * #616: MPM orientation plans — conservative local eligibility, fresh-only
 * candidates, source-cited entries, adaptive small budget, never source text.
 */

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function rec(path: string, content: string, overrides: Partial<MpmFileRecord> = {}): MpmFileRecord {
  return {
    path,
    hash: sha(content),
    size: content.length,
    language: "typescript",
    symbols: [],
    relations: [],
    ...overrides,
  };
}

const FILES: Record<string, string> = {
  "src/date.ts": [
    'import { DateLike } from "./types";',
    "export function formatDate(d: DateLike): string { return d.toISOString(); }",
  ].join("\n"),
  "src/types.ts": ["export interface DateLike { toISOString(): string; }"].join("\n"),
  "src/date.test.ts": ['import { formatDate } from "./date";', "test('formats', () => {});"].join("\n"),
  "src/unrelated.ts": ["export const x = 1;"].join("\n"),
};

const FIXTURE: MpmFileRecord[] = [
  rec("src/date.ts", FILES["src/date.ts"], {
    symbols: [{ name: "formatDate", kind: "function", line: 2 }],
    relations: [{ kind: "imports", target: "src/types.ts", via: "./types", line: 1 }],
  }),
  rec("src/types.ts", FILES["src/types.ts"], {
    symbols: [{ name: "DateLike", kind: "interface", line: 1 }],
  }),
  rec("src/date.test.ts", FILES["src/date.test.ts"], {
    relations: [{ kind: "imports", target: "src/date.ts", via: "./date", line: 1 }],
  }),
  rec("src/unrelated.ts", FILES["src/unrelated.ts"]),
];

async function setup(): Promise<{ root: string; svc: MpmService }> {
  const root = await mkdtemp(join(tmpdir(), "moh-mpm-orient-"));
  for (const [path, content] of Object.entries(FILES)) {
    const abs = join(root, path);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content);
  }
  const dir = join(root, "project-map");
  const store = new MpmStore(dir);
  store.writeProjection(new Map(FIXTURE.map((r) => [r.path, r])));
  const svc = new MpmService(dir);
  svc.load();
  return { root, svc };
}

function make(
  root: string,
  svc: MpmService,
  rerank?: (req: RerankRequest) => Promise<Set<string> | null>,
): MpmOrientation {
  return new MpmOrientation({ service: svc, root, ...(rerank ? { rerank } : {}) });
}

interface RerankCandidate {
  id: string;
  path: string;
  symbols: readonly string[];
  provenance: string;
}

interface RerankRequest {
  task: string;
  candidates: readonly RerankCandidate[];
}

describe("MpmOrientation eligibility (#616)", () => {
  test("a text without any mapped path yields no plan", async () => {
    const { root, svc } = await setup();
    try {
      const o = make(root, svc);
      expect(o.planFor("fix the flaky PTY test and update the release notes")).toBeNull();
      expect(o.planFor("")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unmapped path-like token yields no plan (conservative)", async () => {
    const { root, svc } = await setup();
    try {
      const o = make(root, svc);
      expect(o.planFor("refactor src/missing.ts and friends")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an eligible task with a mapped path produces a plan", async () => {
    const { root, svc } = await setup();
    try {
      const o = make(root, svc);
      const plan = o.planFor("please extend formatDate handling in src/date.ts");
      expect(plan).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("MpmOrientation plan content (#616)", () => {
  test("entries are source-cited: path, relation, and a concise reason; no source excerpts", async () => {
    const { root, svc } = await setup();
    try {
      const o = make(root, svc);
      const plan = o.planFor("work on src/date.ts")!;
      expect(plan).toContain("src/date.ts");
      // Outgoing relation, cited with its line.
      expect(plan).toContain("src/types.ts");
      expect(plan).toMatch(/src\/types\.ts.*line 1/s);
      // Incoming relation from the test file.
      expect(plan).toContain("src/date.test.ts");
      // Never a copied source excerpt.
      expect(plan).not.toContain("export function formatDate");
      expect(plan).not.toContain("toISOString(): string");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a stale seed (file changed after mapping) is omitted; all-stale yields no plan", async () => {
    const { root, svc } = await setup();
    try {
      await writeFile(join(root, "src/date.ts"), "export function formatDate(): string { return 'x'; }");
      const o = make(root, svc);
      // Seed itself is stale → no plan.
      expect(o.planFor("work on src/date.ts")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("plan respects a small character budget (adaptive entry cap)", async () => {
    const { root, svc } = await setup();
    try {
      const o = make(root, svc, );
      const plan = o.planFor("work on src/date.ts")!;
      expect(plan.length).toBeLessThanOrEqual(1500);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unavailable service yields no plan", async () => {
    const { root } = await setup();
    try {
      const cold = new MpmService(join(root, "project-map"));
      const o = new MpmOrientation({ service: cold, root });
      expect(o.planFor("work on src/date.ts")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// #759: seed eligibility extension — exact task symbols (medium tier) and
// recency-weighted reasoning identifiers (low tier), with ambiguity guard.
describe("MpmOrientation symbol seeds (#759)", () => {
  test("a task naming an exact symbol yields a medium-tier plan", async () => {
    const { root, svc } = await setup();
    try {
      const o = make(root, svc);
      const plan = o.planFor("please refactor formatDate handling");
      expect(plan).not.toBeNull();
      expect(plan).toContain("matches symbol `formatDate`");
      // The symbol's relations render as ordinary plan entries.
      expect(plan).toContain("src/date.test.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("generic prose and unresolved identifiers never seed", async () => {
    const { root, svc } = await setup();
    try {
      const o = make(root, svc);
      expect(o.planFor("improve the update of the system")).toBeNull();
      expect(o.planFor("handle the NotThere symbol properly")).toBeNull();
      expect(o.lastFallbackReason).toBe("no-eligible-seed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("MpmOrientation reasoning seeds (#759)", () => {
  const REASONING =
    "Could touch unrelatedThing or DateHelper, but formatDate is the right place.";

  test("reasoning-only symbol mention yields a low-tier plan", async () => {
    const { root, svc } = await setup();
    try {
      const o = make(root, svc);
      const plan = o.planFor("continue", REASONING);
      expect(plan).not.toBeNull();
      expect(plan).toContain("mentioned in recent reasoning (advisory)");
      // Low tier renders visually subordinate.
      expect(plan).toMatch(/^  \u00b7 /m);
      expect(o.lastFallbackReason).toBe("reasoning-seeded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recency weighting: tail mentions win over head mentions", async () => {
    const { root, svc } = await setup();
    try {
      const o = make(root, svc);
      // DateLike first (discarded alternative), formatDate last (chosen).
      const plan = o.planFor("continue", "DateLike seems relevant; also DateLike again; going with formatDate");
      expect(plan).not.toBeNull();
      // formatDate is at the tail — its weight survives; the head mention
      // of DateLike is below the threshold and never seeded.
      expect(plan).not.toContain("DateLike");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a successful prior mpm_query suppresses the reasoning source", async () => {
    const { root, svc } = await setup();
    try {
      const o = make(root, svc);
      o.noteModelQuery();
      expect(o.planFor("continue", REASONING)).toBeNull();
      expect(o.lastFallbackReason).toBe("no-eligible-seed");
      // A new turn re-arms it.
      o.beginTurn();
      expect(o.planFor("continue", REASONING)).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("no reasoning → today's behavior, zero regression", async () => {
    const { root, svc } = await setup();
    try {
      const o = make(root, svc);
      expect(o.planFor("continue")).toBeNull();
      // Paths still seed high-tier plans.
      expect(o.planFor("work on src/date.ts")).toContain("in the same module as src/date.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("MpmOrientation ambiguity and stats (#759)", () => {
  test("a symbol matching more than 5 files yields no plan (over-threshold)", async () => {
    const { root, svc } = await setup();
    try {
      // Add six files all declaring the same helper symbol.
      for (let i = 0; i < 6; i++) {
        const p = `src/gen${i}.ts`;
        const content = `export function helper${i}(): number { return ${i}; }`;
        await writeFile(join(root, p), content);
        svc.upsert({ ...rec(p, content), symbols: [{ name: "sharedHelper", kind: "function", line: 1 }] });
      }
      const o = make(root, svc);
      expect(o.planFor("update sharedHelper usage")).toBeNull();
      expect(o.lastFallbackReason).toBe("over-threshold");
      expect(o.seedStats.overThreshold).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("seedStats count decisive tiers", async () => {
    const { root, svc } = await setup();
    try {
      const o = make(root, svc);
      o.planFor("work on src/date.ts");
      o.planFor("refactor formatDate");
      o.planFor("continue", "settling on formatDate");
      const stats = o.seedStats;
      expect(stats).toEqual({ pathPlans: 1, symbolPlans: 1, reasoningPlans: 1, overThreshold: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("#788 classifier gate", () => {
  test("noteGated records the classifier-gated fallback reason", async () => {
    const { root, svc } = await setup();
    try {
      const o = make(root, svc);
      expect(o.lastFallbackReason).toBeNull();
      o.noteGated();
      expect(o.lastFallbackReason).toBe("classifier-gated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("MPM seed rerank (#790)", () => {
  test("an over-threshold seed set produces a rescued plan when the rerank hook returns kept paths", async () => {
    const { root, svc } = await setup();
    try {
      // Six files all declaring the same symbol — over-threshold by one.
      for (let i = 0; i < 6; i++) {
        const p = `src/gen${i}.ts`;
        const content = `export function helper${i}(): number { return ${i}; }`;
        await writeFile(join(root, p), content);
        svc.upsert({
          ...rec(p, content),
          symbols: [{ name: "sharedHelper", kind: "function", line: 1 }],
        });
      }
      const calls: RerankRequest[] = [];
      const rerank = async (req: RerankRequest): Promise<Set<string> | null> => {
        calls.push(req);
        // Pick the three most plausible files: the symbol actually appears
        // in every file; the ranker chooses — the orientation module only
        // checks the result is non-empty and within the kept size.
        return new Set(["src/gen0.ts", "src/gen2.ts", "src/gen4.ts"]);
      };
      const o = make(root, svc, rerank);
      const plan = await o.planForWithRerank("update sharedHelper usage");
      expect(plan).not.toBeNull();
      // One request, one fan-out: the orientation module never makes two
      // rerank calls per send.
      expect(calls.length).toBe(1);
      // The state shape: the task text plus a candidate per over-threshold
      // path (six files, six candidates).
      expect(calls[0]!.task).toBe("update sharedHelper usage");
      expect(calls[0]!.candidates.length).toBe(6);
      const candidatePaths = new Set(calls[0]!.candidates.map((c) => c.path));
      expect(candidatePaths).toEqual(new Set(["src/gen0.ts", "src/gen1.ts", "src/gen2.ts", "src/gen3.ts", "src/gen4.ts", "src/gen5.ts"]));
      // Per-candidate shape: path, symbols (top 3), provenance (the seed's reason).
      const first = calls[0]!.candidates[0]!;
      expect(typeof first.id).toBe("string");
      expect(first.symbols).toContain("sharedHelper");
      expect(first.provenance).toContain("sharedHelper");
      // Advisory by contract: the state carries metadata only — never a
      // source excerpt (asserted; the fixture files contain declarations).
      expect(JSON.stringify(calls[0])).not.toContain("export function");
      // Rescued plan: the kept paths show up, marked reranked so a reader
      // can see why an over-threshold seed produced a plan.
      expect(plan).toContain("src/gen0.ts");
      expect(plan).toContain("src/gen2.ts");
      expect(plan).toContain("src/gen4.ts");
      expect(plan).toContain("reranked");
      // Diagnostics: not an over-threshold fallback — a real plan with the
      // symbolPlans counter incremented (the seed source was a symbol).
      expect(o.lastFallbackReason).toBeNull();
      expect(o.seedStats.overThreshold).toBe(0);
      expect(o.seedStats.symbolPlans).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the rerank hook is NEVER consulted when the seed set is already within threshold", async () => {
    const { root, svc } = await setup();
    try {
      // The base fixture's `src/date.ts` is a path seed that yields a
      // within-threshold plan (it has relations, so query returns results).
      let called = false;
      const rerank = async (): Promise<Set<string> | null> => {
        called = true;
        return new Set();
      };
      const o = make(root, svc, rerank);
      const plan = o.planFor("work on src/date.ts");
      expect(plan).not.toBeNull();
      // The hook was never consulted — a plan that already exists costs
      // nothing extra.
      expect(called).toBe(false);
      // No `reranked` marker on a within-threshold plan.
      expect(plan).not.toContain("reranked");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fewer than 2 kept paths degrades to no plan (never a guessed one)", async () => {
    const { root, svc } = await setup();
    try {
      for (let i = 0; i < 6; i++) {
        const p = `src/gen${i}.ts`;
        const content = `export function helper${i}(): number { return ${i}; }`;
        await writeFile(join(root, p), content);
        svc.upsert({
          ...rec(p, content),
          symbols: [{ name: "sharedHelper", kind: "function", line: 1 }],
        });
      }
      const rerank = async (): Promise<Set<string> | null> => new Set(["src/gen0.ts"]);
      const o = make(root, svc, rerank);
      expect(await o.planForWithRerank("update sharedHelper usage")).toBeNull();
      expect(o.lastFallbackReason).toBe("over-threshold");
      expect(o.seedStats.overThreshold).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an empty rerank hook (null) degrades to no plan, never a broken turn", async () => {
    const { root, svc } = await setup();
    try {
      for (let i = 0; i < 6; i++) {
        const p = `src/gen${i}.ts`;
        const content = `export function helper${i}(): number { return ${i}; }`;
        await writeFile(join(root, p), content);
        svc.upsert({
          ...rec(p, content),
          symbols: [{ name: "sharedHelper", kind: "function", line: 1 }],
        });
      }
      const rerank = async (): Promise<Set<string> | null> => null;
      const o = make(root, svc, rerank);
      expect(await o.planForWithRerank("update sharedHelper usage")).toBeNull();
      expect(o.lastFallbackReason).toBe("over-threshold");
      expect(o.seedStats.overThreshold).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an empty rerank Set also degrades to no plan", async () => {
    const { root, svc } = await setup();
    try {
      for (let i = 0; i < 6; i++) {
        const p = `src/gen${i}.ts`;
        const content = `export function helper${i}(): number { return ${i}; }`;
        await writeFile(join(root, p), content);
        svc.upsert({
          ...rec(p, content),
          symbols: [{ name: "sharedHelper", kind: "function", line: 1 }],
        });
      }
      const rerank = async (): Promise<Set<string> | null> => new Set();
      const o = make(root, svc, rerank);
      expect(await o.planForWithRerank("update sharedHelper usage")).toBeNull();
      expect(o.lastFallbackReason).toBe("over-threshold");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rescued plan rehashes every entry against the mapped record (freshness unchanged)", async () => {
    const { root, svc } = await setup();
    try {
      for (let i = 0; i < 6; i++) {
        const p = `src/gen${i}.ts`;
        const content = `export function helper${i}(): number { return ${i}; }`;
        await writeFile(join(root, p), content);
        svc.upsert({
          ...rec(p, content),
          symbols: [{ name: "sharedHelper", kind: "function", line: 1 }],
        });
      }
      // Stale one file after mapping: the rescued plan MUST exclude it,
      // exactly the way today's within-threshold plan does (#616).
      await writeFile(join(root, "src/gen3.ts"), "// stale");
      const rerank = async (): Promise<Set<string> | null> =>
        new Set(["src/gen0.ts", "src/gen3.ts", "src/gen4.ts"]);
      const o = make(root, svc, rerank);
      const plan = await o.planForWithRerank("update sharedHelper usage");
      expect(plan).not.toBeNull();
      // The stale file is absent from the plan; the rest survived the
      // freshness check.
      expect(plan).toContain("src/gen0.ts");
      expect(plan).not.toContain("src/gen3.ts");
      expect(plan).toContain("src/gen4.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
