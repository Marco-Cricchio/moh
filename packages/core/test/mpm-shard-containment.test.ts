import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MpmService } from "../src/mpm/service";
import { MpmStore } from "../src/mpm/store";
import { MPM_FORMAT_VERSION, type MpmFileRecord } from "../src/mpm/types";

function rec(path: string): MpmFileRecord {
  return {
    path,
    hash: `hash-${path}`,
    size: 100,
    language: "typescript",
    symbols: [],
    relations: [],
  };
}

async function tempMapDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "moh-mpm-escape-test-"));
  return join(root, "project-map");
}

/** Hostile manifest: one shard points outside the map dir, one is absolute. */
async function writeHostileManifest(dir: string): Promise<Record<string, string>> {
  const shards = {
    "src/ok.ts": "shard-ok.json",
    "src/escape.ts": "../outside.json",
    "src/absolute.ts": "/tmp/moh-mpm-evil.json",
  };
  await writeFile(
    join(dir, "manifest.json"),
    `${JSON.stringify({ formatVersion: MPM_FORMAT_VERSION, builtAt: Date.now(), shards, fileCount: 3 })}\n`,
  );
  // The escaping shard files exist and hold valid records — the bug is that
  // reads follow them outside the map dir, not that they fail.
  await writeFile(join(dir, "shard-ok.json"), `${JSON.stringify(rec("src/ok.ts"))}\n`);
  await writeFile(join(dir, "..", "outside.json"), `${JSON.stringify(rec("src/escape.ts"))}\n`);
  await writeFile("/tmp/moh-mpm-evil.json", `${JSON.stringify(rec("src/absolute.ts"))}\n`);
  return shards;
}

describe("MPM shard containment (#702)", () => {
  test("readRecord returns null for shards escaping the map dir", async () => {
    const dir = await tempMapDir();
    try {
      await mkdir(dir, { recursive: true });
      await writeHostileManifest(dir);
      const store = new MpmStore(dir);
      const manifest = store.readManifest();
      expect(manifest).not.toBeNull();
      // Contained shard still reads.
      expect(store.readRecord(manifest!, "src/ok.ts")?.path).toBe("src/ok.ts");
      // `..`-laden and absolute shard names never resolve outside the dir.
      expect(store.readRecord(manifest!, "src/escape.ts")).toBeNull();
      expect(store.readRecord(manifest!, "src/absolute.ts")).toBeNull();
    } finally {
      await rm(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("hostile manifest → projection discarded and rebuilt, no read outside", async () => {
    const dir = await tempMapDir();
    try {
      await mkdir(dir, { recursive: true });
      const shards = await writeHostileManifest(dir);
      void shards;
      const svc = new MpmService(dir);
      svc.load();
      // Treated as corruption: discarded and rebuilt to empty, status ready.
      expect(svc.query("src/ok.ts").paths).toEqual([]);
      expect(svc.status).toBe("ready");
      // A subsequent rebuild writes a clean, contained manifest.
      svc.rebuild(new Map([["src/ok.ts", rec("src/ok.ts")]]));
      const m = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as { shards: Record<string, string> };
      expect(Object.values(m.shards)).toEqual([m.shards["src/ok.ts"]]);
      expect(String(Object.values(m.shards)[0]!)).toMatch(/^shard-/);
      expect(svc.query("src/escape.ts").paths).toEqual([]);
    } finally {
      await rm("/tmp/moh-mpm-evil.json", { force: true });
      await rm(join(dir, ".."), { recursive: true, force: true });
    }
  });
});
