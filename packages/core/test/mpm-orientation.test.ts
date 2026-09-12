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

function make(root: string, svc: MpmService): MpmOrientation {
  return new MpmOrientation({ service: svc, root });
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
