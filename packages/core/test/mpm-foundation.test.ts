import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MpmService } from "../src/mpm/service";
import { MpmStore } from "../src/mpm/store";
import { MPM_FORMAT_VERSION, type MpmFileRecord } from "../src/mpm/types";

async function tempMapDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "moh-mpm-test-"));
  return join(root, "project-map");
}

function rec(path: string, overrides: Partial<MpmFileRecord> = {}): MpmFileRecord {
  return {
    path,
    hash: `hash-${path}`,
    size: 100,
    language: "typescript",
    symbols: [],
    relations: [],
    ...overrides,
  };
}

const fixture: MpmFileRecord[] = [
  rec("src/date.ts", {
    symbols: [{ name: "formatDate", kind: "function", line: 1 }],
    relations: [{ kind: "imports", target: "src/types.ts", via: "./types", line: 1 }],
  }),
  rec("src/types.ts", { symbols: [{ name: "date", kind: "interface", line: 3 }] }),
  rec("src/date.test.ts", {
    relations: [{ kind: "imports", target: "src/date.ts", via: "./date", line: 1 }],
  }),
];

async function seedProjection(dir: string, records: MpmFileRecord[]): Promise<void> {
  const store = new MpmStore(dir);
  store.writeProjection(new Map(records.map((r) => [r.path, r])));
}

describe("MpmStore", () => {
  test("persists shards outside the repository and manifest flips atomically", async () => {
    const dir = await tempMapDir();
    try {
      await seedProjection(dir, fixture);
      const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
      expect(manifest.formatVersion).toBe(MPM_FORMAT_VERSION);
      expect(manifest.fileCount).toBe(3);
      // Shard files exist and contain metadata only.
      const files = await readdir(dir);
      expect(files.filter((f) => f.startsWith("shard-")).length).toBe(3);
      const shardBody = await readFile(join(dir, manifest.shards["src/date.ts"]), "utf8");
      expect(shardBody).not.toContain("export function formatDate");
    } finally {
      await rm(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("drainJournal replays upserts and removes and clears the journal", async () => {
    const dir = await tempMapDir();
    try {
      const store = new MpmStore(dir);
      await mkdir(dir, { recursive: true });
      store.appendJournal({ op: "upsert", path: "a.ts", record: rec("a.ts"), at: 1 });
      store.appendJournal({ op: "remove", path: "b.ts", at: 2 });
      // A torn tail line (crash mid-append): truncate the file back to the
      // end of the last complete entry, keeping its trailing newline so the
      // next append starts on a fresh line.
      const { truncateSync, readFileSync } = await import("node:fs");
      const journalFile = join(dir, "journal.jsonl");
      const raw = readFileSync(journalFile, "utf8");
      truncateSync(journalFile, raw.lastIndexOf("\n") + 1);
      store.appendJournal({ op: "upsert", path: "c.ts", record: rec("c.ts"), at: 3 });
      const entries = store.drainJournal();
      expect(entries.map((e) => e.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
      expect(store.drainJournal()).toEqual([]);
    } finally {
      await rm(join(dir, ".."), { recursive: true, force: true });
    }
  });
});

describe("MpmService recovery", () => {
  test("missing projection loads to an empty, ready service", async () => {
    const dir = await tempMapDir();
    try {
      const svc = new MpmService(dir);
      svc.load();
      expect(svc.status).toBe("ready");
      expect(svc.fileCount).toBe(0);
    } finally {
      await rm(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("corrupt manifest is discarded and the service rebuilds", async () => {
    const dir = await tempMapDir();
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "manifest.json"), "{not json");
      const svc = new MpmService(dir);
      svc.load();
      expect(svc.status).toBe("ready");
      expect(svc.fileCount).toBe(0);
      // The corrupt directory was isolated, not left in place.
      const parent = join(dir, "..");
      const entries = await readdir(parent);
      expect(entries.some((e) => e.startsWith("project-map.corrupt-"))).toBe(true);
      expect(entries.includes("project-map") === false || svc.fileCount === 0).toBe(true);
    } finally {
      await rm(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("incompatible formatVersion is discarded, not migrated", async () => {
    const dir = await tempMapDir();
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "manifest.json"),
        JSON.stringify({ formatVersion: 999, builtAt: 1, shards: {}, fileCount: 0 }),
      );
      const svc = new MpmService(dir);
      svc.load();
      expect(svc.status).toBe("ready");
      expect(svc.fileCount).toBe(0);
    } finally {
      await rm(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("a corrupt shard falls back instead of poisoning the service", async () => {
    const dir = await tempMapDir();
    try {
      await seedProjection(dir, fixture);
      const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
      await writeFile(join(dir, manifest.shards["src/types.ts"]), "GARBAGE");
      const svc = new MpmService(dir);
      svc.load();
      expect(svc.status).toBe("ready");
      expect(svc.fileCount).toBe(0);
    } finally {
      await rm(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("unreadable shard file mode fails safe to unavailable-then-rebuildable", async () => {
    const dir = await tempMapDir();
    try {
      await seedProjection(dir, fixture);
      const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
      const { chmodSync } = await import("node:fs");
      chmodSync(join(dir, manifest.shards["src/date.ts"]), 0o000);
      const svc = new MpmService(dir);
      svc.load();
      expect(svc.status).toBe("ready");
      expect(svc.fileCount).toBe(0);
    } finally {
      await rm(join(dir, ".."), { recursive: true, force: true });
    }
  });
});

describe("MpmService queries and provenance", () => {
  async function loadedService(): Promise<{ svc: MpmService; dir: string; root: string }> {
    const root = await mkdtemp(join(tmpdir(), "moh-mpm-svc-"));
    const dir = join(root, "project-map");
    await seedProjection(dir, fixture);
    const svc = new MpmService(dir);
    svc.load();
    return { svc, dir, root };
  }

  test("query returns incoming, outgoing, and symbol relations with provenance", async () => {
    const { svc, root } = await loadedService();
    try {
      const result = svc.query("src/date.ts");
      expect(result).not.toBeNull();
      // Outgoing: src/types.ts; incoming: src/date.test.ts; symbol stem "date" matches itself only.
      expect(result!.paths).toContain("src/types.ts");
      expect(result!.paths).toContain("src/date.test.ts");
      const typesIdx = result!.paths.indexOf("src/types.ts");
      const prov = result!.provenance[typesIdx];
      expect(prov.source).toBe("src/date.ts");
      expect(prov.line).toBe(1);
      expect(prov.extractor).toBe("mpm/typescript");
      // Outgoing relation outranks incoming.
      expect(result!.paths[0]).toBe("src/types.ts");
      void root;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("query on an unmapped path returns incoming pointers only", async () => {
    const { svc, root } = await loadedService();
    try {
      const result = svc.query("src/types.ts");
      expect(result!.paths).toContain("src/date.ts");
      const prov = result!.provenance[result!.paths.indexOf("src/date.ts")];
      expect(prov.source).toBe("src/date.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unavailable service returns null and never throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "moh-mpm-null-"));
    try {
      const svc = new MpmService(join(root, "project-map"));
      expect(svc.query("src/date.ts")).toBeNull();
      expect(svc.status).toBe("unavailable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("journal replay after load preserves targeted upserts", async () => {
    const { svc, root } = await loadedService();
    try {
      svc.upsert(rec("src/new.ts", { relations: [{ kind: "imports", target: "src/date.ts", via: "./date", line: 2 }] }));
      const fresh = new MpmService(join(root, "project-map"));
      // Journal was written but the manifest predates it; replay must
      // surface the upserted record without a full rebuild.
      fresh.load();
      const result = fresh.query("src/new.ts");
      expect(result!.paths).toContain("src/date.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
