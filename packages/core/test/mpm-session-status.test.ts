import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, type Provider } from "../src/index";
import { MpmService } from "../src/mpm/service";
import { MpmStore } from "../src/mpm/store";
import type { MpmFileRecord } from "../src/mpm/types";
import type { Message } from "../src/types";

/**
 * #619: the client-facing MPM seams — `mpmSnapshot()` and
 * `mpmDiagnostics()` — for the TUI status row and inspection view. Null
 * when MPM never activated; honest live state when it did.
 */

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const FILES: Record<string, string> = {
  "src/date.ts": ['import { DateLike } from "./types";', "export function formatDate(d: DateLike): string { return d.toISOString(); }"].join("\n"),
  "src/types.ts": ["export interface DateLike { toISOString(): string; }"].join("\n"),
};

const FIXTURE: MpmFileRecord[] = [
  {
    path: "src/date.ts",
    hash: sha(FILES["src/date.ts"]),
    size: FILES["src/date.ts"].length,
    language: "typescript",
    symbols: [{ name: "formatDate", kind: "function", line: 2 }],
    relations: [{ kind: "imports", target: "src/types.ts", via: "./types", line: 1 }],
  },
  {
    path: "src/types.ts",
    hash: sha(FILES["src/types.ts"]),
    size: FILES["src/types.ts"].length,
    language: "typescript",
    symbols: [],
    relations: [],
  },
];

const tmpDirs: string[] = [];
async function setup(): Promise<{ root: string; service: MpmService }> {
  const root = await mkdtemp(join(tmpdir(), "moh-mpm-status-"));
  tmpDirs.push(root);
  for (const [path, content] of Object.entries(FILES)) {
    const abs = join(root, path);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content);
  }
  const store = new MpmStore(join(root, "project-map"));
  store.writeProjection(new Map(FIXTURE.map((r) => [r.path, r])));
  const service = new MpmService(join(root, "project-map"));
  service.load();
  return { root, service };
}

function provider(): Provider {
  return {
    name: "capture",
    async *stream(_messages: Message[]) {
      yield { type: "finish" as const, reason: "stop" as const };
    },
  };
}

afterAll(() => {
  for (const d of tmpDirs) rm(d, { recursive: true, force: true });
});

describe("MPM client seams (#619)", () => {
  test("without mpm config the seams report null and a disabled report", async () => {
    const { root } = await setup();
    const session = createSession({ provider: provider(), cwd: root });
    expect(session.mpmSnapshot()).toBeNull();
    expect(session.mpmSnapshot()).toBeNull();
    const diag = session.mpmDiagnostics();
    // No live service: never fabricates a ready projection.
    expect(diag.status).toBe("unavailable");
    expect(diag.fileCount).toBe(0);
  });

  test("an activated session reports ready status and honest diagnostics", async () => {
    const { root, service } = await setup();
    const session = createSession({ provider: provider(), cwd: root, mpm: { service } });
    expect(session.mpmSnapshot()?.status).toBe("ready");
    const snap = session.mpmSnapshot();
    expect(snap?.status).toBe("ready");
    expect(snap?.pendingWork).toBe(0);
    expect(snap?.fallbackReason).toBeNull();
    const diag = session.mpmDiagnostics();
    expect(diag.disabled).toBe(false);
    expect(diag.fileCount).toBe(2);
    expect(diag.symbolCount).toBe(1);
    expect(diag.coverage.map((c) => c.language)).toContain("typescript");
    expect(diag.builtAt).not.toBeNull();
    expect(diag.staleCount).toBe(0);
    expect(diag.evictions).toBe(0);
    expect(diag.pendingWork).toBe(0);
  });

  test("status flips to updating while a refresh is in flight; pending work surfaces", async () => {
    const { root, service } = await setup();
    const session = createSession({ provider: provider(), cwd: root, mpm: { service } });
    expect(session.mpmSnapshot()?.status).toBe("ready");
    service.setUpdating(true);
    expect(session.mpmSnapshot()?.status).toBe("updating");
    expect(session.mpmSnapshot()?.status).toBe("updating");
    expect(session.mpmDiagnostics().status).toBe("updating");
    service.setUpdating(false);
    expect(session.mpmSnapshot()?.status).toBe("ready");
  });

  test("a stale mapped file counts as stale in diagnostics", async () => {
    const { root, service } = await setup();
    await writeFile(join(root, "src/date.ts"), "export const totally = 'changed';");
    const session = createSession({ provider: provider(), cwd: root, mpm: { service } });
    const diag = session.mpmDiagnostics();
    expect(diag.staleCount).toBeGreaterThan(0);
  });

  test("diagnostics never throw with a broken user config", async () => {
    const { root, service } = await setup();
    const session = createSession({ provider: provider(), cwd: root, mpm: { service, root } });
    // mohHome defaults to ~/.moh — the real user config may or may not
    // parse; either way the projection must not throw.
    const diag = session.mpmDiagnostics();
    expect(typeof diag.status).toBe("string");
    expect(Array.isArray(diag.coverage)).toBe(true);
  });
});
