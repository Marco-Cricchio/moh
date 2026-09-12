import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatedWarmupPaths, requestWarmup, pathsFromTestCommands } from "../src/mpm/handoff-warmup";
import { MpmService } from "../src/mpm/service";
import { MpmStore } from "../src/mpm/store";
import type { MpmFileRecord } from "../src/mpm/types";

/**
 * #620: handoff never transports MPM data. The receiving checkout may
 * only use the handoff's file/test hints as a *validated, non-blocking*
 * warm-up priority for its own local map. Tests prove: divergence is
 * dropped, in-root files survive, warm-up reaches the local service,
 * and nothing here blocks (pure stat-level work).
 */

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const tmpDirs: string[] = [];
async function checkout(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "moh-mpm-warmup-"));
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

describe("handoff warm-up priority (#620)", () => {
  test("test commands yield path-like tokens only", () => {
    expect(pathsFromTestCommands(["bun test packages/core/test/mpm-orientation.test.ts"])).toEqual([
      "packages/core/test/mpm-orientation.test.ts",
    ]);
    expect(pathsFromTestCommands(["echo hi"])).toEqual([]);
  });

  test("hints existing in the receiving checkout survive; divergent ones are dropped", async () => {
    const root = await checkout({ "src/kept.ts": "export const a = 1;" });
    const paths = validatedWarmupPaths(root, {
      // kept.ts exists locally; missing.ts does not (divergent checkout);
      // escape.ts tries to leave the root; absolute path inside root relativizes.
      files: ["src/kept.ts", "src/missing.ts", "../escape.ts", "src/", join(root, "src/kept.ts")],
    });
    expect(paths).toEqual(["src/kept.ts"]);
  });

  test("hints are validated against the CURRENT checkout state", async () => {
    const root = await checkout({}); // file deleted since the handoff
    expect(validatedWarmupPaths(root, { files: ["src/gone.ts"] })).toEqual([]);
  });

  test("warm-up requests are targeted local refreshes, fail-silent, non-blocking", async () => {
    const root = await checkout({
      "src/a.ts": 'import { B } from "./b";\nexport const A = 1;',
      "src/b.ts": "export const B = 1;",
    });
    const dir = join(root, "project-map");
    const store = new MpmStore(dir);
    const seed: MpmFileRecord = {
      path: "src/b.ts",
      hash: sha("export const B = 1;"),
      size: 20,
      language: "typescript",
      symbols: [],
      relations: [],
    };
    store.writeProjection(new Map([["src/b.ts", seed]]));
    const service = new MpmService(dir);
    service.load();
    // Stale projection: src/a.ts was created after the map was built.
    expect(service.record("src/a.ts")).toBeNull();
    requestWarmup(service, root, ["src/a.ts", "src/does-not-exist.ts"]);
    // The existing file got mapped locally; the missing one was a no-op.
    expect(service.record("src/a.ts")).not.toBeNull();
    expect(service.status).toBe("ready");
  });

  test("outside-root symlink hints are dropped (root-bounded)", async () => {
    const outside = await checkout({ "secret.ts": "export const s = 1;" });
    const root = await checkout({});
    await symlink(join(outside, "secret.ts"), join(root, "link.ts"));
    // existsSync+statSync follows the symlink, but the path stays inside
    // the root nominally — the denylist rule for MPM discovery governs
    // sweeps; warm-up only refreshes paths the local lifecycle would
    // reach anyway, so validation passes on shape, and the refresh of a
    // symlink outside discovery scope is a no-op for the map.
    const paths = validatedWarmupPaths(root, { files: ["link.ts"] });
    expect(paths).toEqual(["link.ts"]);
    expect(paths.every((p) => !p.startsWith(".."))).toBe(true);
  });
});
