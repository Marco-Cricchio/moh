import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MpmService } from "../src/mpm/service";
import { MpmStore } from "../src/mpm/store";
import type { MpmFileRecord } from "../src/mpm/types";

/**
 * #620: project identity migration relocates the disposable map together
 * with the project data (the whole project directory is renamed); before
 * the relocated map is used, it is revalidated against the active root:
 * records whose file no longer exists here are dropped, survivors stay.
 */

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function rec(path: string, content: string, language = "typescript"): MpmFileRecord {
  return {
    path,
    hash: sha(content),
    size: content.length,
    language,
    symbols: [],
    relations: [],
  };
}

const tmpDirs: string[] = [];
async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "moh-mpm-reval-"));
  tmpDirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

afterAll(async () => {
  for (const d of tmpDirs) rm(d, { recursive: true, force: true });
});

async function serviceWith(records: MpmFileRecord[]): Promise<MpmService> {
  const dir = await mkdtemp(join(tmpdir(), "moh-mpm-reval-map-"));
  tmpDirs.push(dir);
  const store = new MpmStore(join(dir, "project-map"));
  store.writeProjection(new Map(records.map((r) => [r.path, r])));
  const service = new MpmService(join(dir, "project-map"));
  service.load();
  return service;
}

describe("identity-migration map revalidation (#620)", () => {
  test("records absent at the active root are dropped; survivors persist across reload", async () => {
    const root = await workspace({ "src/kept.ts": "export const k = 1;" });
    const service = await serviceWith([
      rec("src/kept.ts", "export const k = 1;"),
      rec("src/gone.ts", "export const g = 1;"),
    ]);
    const result = service.revalidate(root);
    expect(result.kept).toBe(1);
    expect(result.dropped).toEqual(["src/gone.ts"]);
    expect(service.record("src/kept.ts")).not.toBeNull();
    expect(service.record("src/gone.ts")).toBeNull();
    // The drop survives a reload (persisted, not just in-memory).
    const reloaded = new MpmService(service.dir);
    reloaded.load();
    expect(reloaded.record("src/gone.ts")).toBeNull();
    expect(reloaded.fileCount).toBe(1);
  });

  test("a fully divergent root empties the projection (rebuild territory, never trusted)", async () => {
    const root = await workspace({});
    const service = await serviceWith([rec("src/other.ts", "export const o = 1;")]);
    const result = service.revalidate(root);
    expect(result.kept).toBe(0);
    expect(service.fileCount).toBe(0);
  });

  test("revalidation is a no-op on an unloaded/empty service and never throws", async () => {
    const root = await workspace({});
    const dir = await mkdtemp(join(tmpdir(), "moh-mpm-reval-empty-"));
    tmpDirs.push(dir);
    const unloaded = new MpmService(join(dir, "project-map"));
    expect(unloaded.revalidate(root)).toEqual({ kept: 0, dropped: [] });
    // Unreadable paths degrade to dropped, not thrown.
    const service = await serviceWith([rec("src/x.ts", "export const x = 1;")]);
    const result = service.revalidate(root, () => {
      throw new Error("boom");
    });
    expect(result.dropped).toEqual(["src/x.ts"]);
  });
});
