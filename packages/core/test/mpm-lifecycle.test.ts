import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, unlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MpmService } from "../src/mpm/service";
import { MpmLifecycle } from "../src/mpm/lifecycle";
import { extractWorkspace } from "../src/mpm/extractor";

/** Synchronous fake clock so lifecycle ticks are deterministic. */
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
    clearInterval(_h: unknown) {},
    /** Fire the registered interval once. */
    tick() {
      for (const t of [...timers]) t.fn();
    },
  };
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "moh-mpm-lifecycle-"));
}

async function seedWorkspace(root: string): Promise<void> {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export function a() {}\n");
  await writeFile(join(root, "src", "b.ts"), 'import { a } from "./a";\nexport const b = a();\n');
}


describe("MpmLifecycle (#617)", () => {
  test("external edit refreshes the projection after the debounce window", async () => {
    const root = await tempRoot();
    const mapDir = join(root, "project-map");
    try {
      await seedWorkspace(root);
      const service = new MpmService(mapDir);
      service.rebuild(extractWorkspace(root));
      expect(service.record("src/b.ts")!.relations.length).toBe(1);

      const clock = fakeTimers();
      const lifecycle = new MpmLifecycle({
        service,
        root,
        debounceMs: 500,
        timers: clock,
      });
      // External edit (not via moh): b.ts drops its import of a.ts.
      await writeFile(join(root, "src", "b.ts"), "export const b = 1;\n");
      lifecycle.noteExternalChange("src/b.ts");

      // Before the debounce window elapses: untouched.
      clock.advance(100);
      clock.tick();
      expect(service.record("src/b.ts")!.relations.length).toBe(1);

      clock.advance(500);
      clock.tick();
      expect(service.record("src/b.ts")!.relations.length).toBe(0);
      lifecycle.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rename/delete removes the stale path (stale-source safety)", async () => {
    const root = await tempRoot();
    const mapDir = join(root, "project-map");
    try {
      await seedWorkspace(root);
      const service = new MpmService(mapDir);
      service.rebuild(extractWorkspace(root));
      const clock = fakeTimers();
      const lifecycle = new MpmLifecycle({ service, root, timers: clock });

      await rename(join(root, "src", "a.ts"), join(root, "src", "renamed.ts"));
      lifecycle.noteExternalChange("src/a.ts");
      clock.advance(10_000);
      clock.tick();
      expect(service.record("src/a.ts")).toBeNull();
      lifecycle.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("successful moh edits enqueue a targeted immediate refresh", async () => {
    const root = await tempRoot();
    const mapDir = join(root, "project-map");
    try {
      await seedWorkspace(root);
      const service = new MpmService(mapDir);
      service.rebuild(extractWorkspace(root));
      const clock = fakeTimers();
      const lifecycle = new MpmLifecycle({ service, root, timers: clock });

      // moh itself writes a new file via the write tool path.
      await writeFile(join(root, "src", "c.ts"), "export const c = 2;\n");
      lifecycle.noteEdit("src/c.ts");
      clock.tick(); // edits fire without a debounce wait
      expect(service.record("src/c.ts")!.symbols.map((s) => s.name)).toContain("c");
      lifecycle.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("active turns yield: busy sweeps do no work until idle", async () => {
    const root = await tempRoot();
    const mapDir = join(root, "project-map");
    try {
      await seedWorkspace(root);
      const service = new MpmService(mapDir);
      service.rebuild(extractWorkspace(root));
      let busy = true;
      const clock = fakeTimers();
      const lifecycle = new MpmLifecycle({ service, root, isBusy: () => busy, timers: clock });

      await writeFile(join(root, "src", "b.ts"), "export const b = 1;\n");
      lifecycle.noteEdit("src/b.ts");
      clock.tick(); // busy: zero budget, work is deferred
      expect(service.record("src/b.ts")!.relations.length).toBe(1);

      busy = false;
      clock.tick(); // idle: deferred work runs
      expect(service.record("src/b.ts")!.relations.length).toBe(0);
      lifecycle.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sweep budgets cap work per slice and resume across ticks", async () => {
    const root = await tempRoot();
    const mapDir = join(root, "project-map");
    try {
      await seedWorkspace(root);
      for (let i = 0; i < 5; i++) await writeFile(join(root, "src", `m${i}.ts`), `export const m${i} = ${i};\n`);
      const service = new MpmService(mapDir);
      service.rebuild(extractWorkspace(root));
      // Bump mtimes on all m-files externally.
      for (let i = 0; i < 5; i++) await writeFile(join(root, "src", `m${i}.ts`), `export const m${i} = ${i + 10};\n`);
      const clock = fakeTimers();
      const lifecycle = new MpmLifecycle({
        service,
        root,
        maxFilesPerSweep: 2,
        timers: clock,
      });
      lifecycle.noteExternalChange("src/m0.ts");
      lifecycle.noteExternalChange("src/m1.ts");
      lifecycle.noteExternalChange("src/m2.ts");
      clock.advance(10_000);
      clock.tick(); // budget 2: m0, m1 refresh; m2 deferred
      expect(service.record("src/m0.ts")!.symbols[0]!.name).toBe("m0");
      // m2 still maps the OLD content (size from before the edit).
      const oldSize = service.record("src/m2.ts")!.size;
      expect(oldSize).toBeGreaterThan(0);
      expect(oldSize).not.toBe(new Blob([`export const m2 = ${2 + 10};\n`]).size);
      clock.tick(); // deferred remainder completes
      expect(service.record("src/m2.ts")!.symbols[0]!.name).toBe("m2");
      // The refreshed record reflects the new content hash.
      const { createHash } = await import("node:crypto");
      const content = await import("node:fs/promises").then((m) => m.readFile(join(root, "src", "m0.ts"), "utf8"));
      expect(service.record("src/m0.ts")!.hash).toBe(createHash("sha256").update(content).digest("hex"));
      lifecycle.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("quota eviction bounds storage and drops LRU entries first", async () => {
    const root = await tempRoot();
    const mapDir = join(root, "project-map");
    try {
      await seedWorkspace(root);
      const service = new MpmService(mapDir);
      service.rebuild(extractWorkspace(root));
      // Touch b.ts so a.ts becomes the coldest entry.
      service.record("src/b.ts");
      const evicted = service.enforceQuota({ maxFiles: 1 });
      expect(evicted).toEqual(["src/a.ts"]);
      expect(service.record("src/a.ts")).toBeNull();
      expect(service.record("src/b.ts")).not.toBeNull();
      // Persisted: a fresh service sees the same shape.
      const reloaded = new MpmService(mapDir);
      reloaded.load();
      expect(reloaded.fileCount).toBe(1);
      expect(reloaded.record("src/b.ts")).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("periodic scan detects external changes and reports honest status", async () => {
    const root = await tempRoot();
    const mapDir = join(root, "project-map");
    try {
      await seedWorkspace(root);
      const service = new MpmService(mapDir);
      service.rebuild(extractWorkspace(root));
      const clock = fakeTimers();
      const lifecycle = new MpmLifecycle({ service, root, timers: clock });
      expect(service.status).toBe("ready");

      // First scan adopts mtimes; a real mtime change then triggers refresh.
      clock.advance(10_000);
      clock.tick();
      expect(service.status).toBe("ready");

      await writeFile(join(root, "src", "a.ts"), "export function a2() {}\n");
      await unlink(join(root, "src", "b.ts"));
      clock.advance(10_000);
      clock.tick();
      expect(service.record("src/a.ts")!.symbols[0]!.name).toBe("a2");
      expect(service.record("src/b.ts")).toBeNull();
      expect(service.status).toBe("ready"); // settled: honest ready
      lifecycle.dispose();

      // A never-loaded service is honestly unavailable; a missing
      // projection loads to an empty (but ready) one, matching #614.
      const neverLoaded = new MpmService(join(root, "nope"));
      expect(neverLoaded.status).toBe("unavailable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("updating status is honest during outstanding background work", async () => {
    const root = await tempRoot();
    const mapDir = join(root, "project-map");
    try {
      await seedWorkspace(root);
      const service = new MpmService(mapDir);
      service.rebuild(extractWorkspace(root));
      const clock = fakeTimers();
      const lifecycle = new MpmLifecycle({ service, root, maxFilesPerSweep: 1, timers: clock });

      for (let i = 0; i < 3; i++) await writeFile(join(root, "src", `u${i}.ts`), `export const u${i} = ${i};\n`);
      lifecycle.noteEdit("src/u0.ts");
      lifecycle.noteEdit("src/u1.ts");
      lifecycle.noteEdit("src/u2.ts");
      clock.tick(); // 1 of 3 done, remainder deferred
      expect(service.status).toBe("updating");
      clock.tick();
      clock.tick();
      expect(service.status).toBe("ready");
      lifecycle.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
