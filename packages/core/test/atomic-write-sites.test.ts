/**
 * Characterization of the atomic-write call sites (#1425, D6 of #1386).
 *
 * Pins, per site: the temp-file name, the final file mode, the mode of the
 * directory the site creates (or that it creates none), and what is left
 * behind when the rename fails. Written against the code as it was before
 * the shared `writeFileAtomic` helper; it must pass unchanged after it.
 *
 * Observation technique: a rename is made to fail by placing a non-empty
 * directory at the destination, so the temp file stays and can be read back.
 * Modes depend on the umask, so the test sets its own (0o027) and restores it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DevelopmentLaneStore } from "../src/development-lanes";
import { noteUnrecognizedContextRefusal, contextRefusalsFile } from "../src/context-refusal-trace";
import { noteProviderTestFailure } from "../src/provider-test-trace";
import { noteSecretRedactionMiss, secretRedactionMissesFile } from "../src/redact";
import { RetroStore } from "../src/retro";
import { updateUserConfigFile } from "../src/user-config";
import { updateCacheFile, writeUpdateCache } from "../src/update-check";
import { HandoffRunner } from "../src/handoff";
import { exportHandoffFile, importHandoffFile, importedHandoffFile } from "../src/handoff-file";
import { handoffPublishedMarkerFile, publishHandoffAtExit, type HandoffTransport } from "../src/handoff-transport";
import { MemoryStore } from "../src/memory";
import { acknowledgeStrandedData } from "../src/project-identity";
import { MpmStore } from "../src/mpm/store";
import type { MpmFileRecord } from "../src/mpm/types";
import type { RawHandoff } from "../src/handoff";

const UMASK = 0o027;
let previousUmask = 0;
beforeAll(() => {
  previousUmask = process.umask(UMASK);
});
afterAll(() => {
  process.umask(previousUmask);
});

const mode = (path: string): number => statSync(path).mode & 0o777;
const root = (label: string): string => mkdtempSync(join(tmpdir(), `moh-atomic-${label}-`));
const pid = process.pid;

/** Puts a non-empty directory at `path` so a rename onto it fails. */
function blockRename(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "keep"), "x");
}

/** Files in `dir` whose name contains ".tmp". */
function temps(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(".tmp"));
}

const handoff: RawHandoff = {
  version: 1,
  kind: "raw",
  sessionId: "s-1",
  updatedAt: "2026-09-02T10:00:00.000Z",
  git: { branch: "develop", head: "abc123", dirty: false },
  turns: 3,
  lastUserMessage: "fix",
  lastAssistantMessage: "done",
  files: [],
  tests: [],
  counts: { toolCalls: 1, errors: 0, cancelled: 0 },
};

describe("retro findings (#writeFindings)", () => {
  test("fresh: 0600 file, 0700 directory, no temp left", () => {
    const dir = join(root("retro-f"), "retro");
    const store = new RetroStore(dir);
    expect(store.append([{ category: "c", evidence: "e", confidence: 0.9, session: "s", signature: "sig" }])).toBe(1);
    expect(mode(store.findingsFile)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    expect(temps(dir)).toEqual([]);
  });

  test("an existing file keeps its mode", () => {
    const dir = join(root("retro-p"), "retro");
    const store = new RetroStore(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(store.findingsFile, "");
    chmodSync(store.findingsFile, 0o640);
    expect(store.append([{ category: "c", evidence: "e", confidence: 0.9, session: "s", signature: "sig" }])).toBe(1);
    expect(mode(store.findingsFile)).toBe(0o640);
  });

  test("temp is `<file>.tmp-<pid>`, left behind when the rename fails", () => {
    const dir = join(root("retro-t"), "retro");
    const store = new RetroStore(dir);
    blockRename(store.findingsFile);
    store.append([{ category: "c", evidence: "e", confidence: 0.9, session: "s", signature: "sig" }]);
    const tmp = `${store.findingsFile}.tmp-${pid}`;
    expect(existsSync(tmp)).toBe(true);
    expect(readFileSync(tmp, "utf8")).toContain('"signature":"sig"');
    expect(temps(dir)).toEqual([basename(tmp)]);
  });
});

describe("retro dismissed set (#writeAtomic)", () => {
  test("fresh: 0600 file, 0700 directory, no temp left", () => {
    const dir = join(root("retro-d"), "retro");
    new RetroStore(dir).dismiss("sig");
    const file = join(dir, "dismissed.json");
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
    expect(mode(file)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    expect(temps(dir)).toEqual([]);
  });

  test("an existing file is replaced with a fresh 0600 file", () => {
    const dir = join(root("retro-d2"), "retro");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "dismissed.json");
    writeFileSync(file, "{}");
    chmodSync(file, 0o644);
    new RetroStore(dir).dismiss("sig");
    expect(mode(file)).toBe(0o600);
  });

  test("temp is `<file>.tmp-<pid>`, left behind when the rename fails", () => {
    const dir = join(root("retro-d3"), "retro");
    const file = join(dir, "dismissed.json");
    blockRename(file);
    new RetroStore(dir).dismiss("sig");
    expect(JSON.parse(readFileSync(`${file}.tmp-${pid}`, "utf8")).signatures.sig).toBeDefined();
  });
});

describe("user-config (updateUserConfigFile)", () => {
  test("fresh: 0600 file, 0700 directory", () => {
    const dir = join(root("uc"), "cfg");
    const file = join(dir, "moh.json");
    updateUserConfigFile(file, (d) => void (d.theme = "x"));
    expect(mode(file)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    expect(temps(dir)).toEqual([]);
  });
});

describe("user-config (updateUserConfigFile) — real file twins (#1431)", () => {
  test("temp is `<file>.tmp-<pid>`, written with 0600, left behind when the rename fails (real file)", () => {
    const dir = join(root("uc-t-real"), "cfg");
    const file = join(dir, "moh.json");
    mkdirSync(dir, { recursive: true });
    blockRename(file);
    // the destination is a non-empty directory, so the guardian reads it as unreadable ({}) — as the injected `{}` reader does
    expect(() => updateUserConfigFile(file, (d) => void (d.theme = "x"))).toThrow();
    const tmp = `${file}.tmp-${pid}`;
    expect(JSON.parse(readFileSync(tmp, "utf8")).theme).toBe("x");
    expect(mode(tmp)).toBe(0o600);
  });
});

describe("development lanes (writeState)", () => {
  test("fresh: 0600 file, 0700 directory, no temp left (the name carries a random UUID)", () => {
    const home = root("lanes");
    const store = new DevelopmentLaneStore({ cwd: join(home, "proj"), home });
    store.createFeatureGroup({ name: "g", targetRef: "main" });
    expect(mode(store.file)).toBe(0o600);
    expect(mode(dirname(store.file))).toBe(0o700);
    expect(temps(dirname(store.file))).toEqual([]);
    store.createFeatureGroup({ name: "g2", targetRef: "main" });
    expect(temps(dirname(store.file))).toEqual([]);
  });
});

describe("update cache (writeUpdateCache)", () => {
  test("fresh: 0600 file, 0700 directory, no temp left", () => {
    const home = join(root("uc2"), "moh");
    writeUpdateCache(home, "1.2.3", { now: () => 5 });
    const file = updateCacheFile(home);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ lastCheckedAt: 5, latestVersion: "1.2.3" });
    expect(mode(file)).toBe(0o600);
    expect(mode(dirname(file))).toBe(0o700);
    expect(temps(dirname(file))).toEqual([]);
  });

  test("an existing file keeps its mode", () => {
    const home = join(root("uc2p"), "moh");
    const file = updateCacheFile(home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{}");
    chmodSync(file, 0o640);
    writeUpdateCache(home, "1.2.3", { now: () => 5 });
    expect(mode(file)).toBe(0o640);
  });

  test("temp is `<file>.tmp-<pid>`, left behind when the rename fails", () => {
    const home = join(root("uc2t"), "moh");
    const file = updateCacheFile(home);
    blockRename(file);
    expect(() => writeUpdateCache(home, "1.2.3", { now: () => 5 })).not.toThrow();
    expect(JSON.parse(readFileSync(`${file}.tmp-${pid}`, "utf8")).latestVersion).toBe("1.2.3");
  });
});

describe("miss report (redact, #1262)", () => {
  test("fresh: 0700 directory, no temp left", () => {
    const home = join(root("miss"), "moh");
    noteSecretRedactionMiss({ home, shape: "opaque-word:64" });
    expect(mode(home)).toBe(0o700);
    expect(temps(home)).toEqual([]);
  });

  test("a failed rename is retried with a fresh random temp name, three attempts, each 0600, none cleaned up", () => {
    const home = join(root("miss-r"), "moh");
    const file = secretRedactionMissesFile(home);
    blockRename(file);
    noteSecretRedactionMiss({ home, shape: "opaque-word:64" });
    const left = temps(home);
    expect(left).toHaveLength(3);
    for (const name of left) {
      expect(name).toMatch(new RegExp(`^${basename(file).replace(".", "\\.")}\\.tmp-[0-9a-f]{32}$`));
      expect(mode(join(home, name))).toBe(0o600);
      expect(readFileSync(join(home, name), "utf8")).toContain("opaque-word:64");
    }
    expect(left).not.toContain(`${basename(file)}.tmp-${pid}`);
  });
});

describe("context-refusal trace (writeEntries)", () => {
  const input = (home: string) => ({ home, model: "m", message: "refused" });

  test("fresh: 0600 file, 0700 directory, no temp left", () => {
    const home = join(root("ctx"), "moh");
    noteUnrecognizedContextRefusal(input(home));
    const file = contextRefusalsFile(home);
    expect(mode(file)).toBe(0o600);
    expect(mode(home)).toBe(0o700);
    expect(temps(home)).toEqual([]);
  });

  test("temp is `<file>.tmp-<pid>`, left behind when the rename fails", () => {
    const home = join(root("ctx-t"), "moh");
    const file = contextRefusalsFile(home);
    blockRename(file);
    noteUnrecognizedContextRefusal(input(home));
    expect(readFileSync(`${file}.tmp-${pid}`, "utf8")).toContain('"message":"refused"');
  });
});

describe("provider-test trace (writeEntries)", () => {
  const input = (home: string) => ({
    home,
    profile: { name: "ep", type: "openai-compat", baseUrl: "http://x/v1", apiKey: "k", defaultModel: "m" } as never,
    result: { ok: false, error: "boom" } as never,
  });

  test("fresh: 0600 file, 0700 directory, no temp left", () => {
    const home = join(root("ptt"), "moh");
    noteProviderTestFailure(input(home));
    const file = join(home, "provider-test-failures.log");
    expect(mode(file)).toBe(0o600);
    expect(mode(home)).toBe(0o700);
    expect(temps(home)).toEqual([]);
  });

  test("temp is `<file>.tmp-<pid>`, left behind when the rename fails", () => {
    const home = join(root("ptt-t"), "moh");
    const file = join(home, "provider-test-failures.log");
    blockRename(file);
    noteProviderTestFailure(input(home));
    expect(readFileSync(`${file}.tmp-${pid}`, "utf8")).toContain('"message":"boom"');
  });
});

describe("handoff artifact (HandoffRunner.turnSettled)", () => {
  const events = [{ type: "user_message", text: "hi" }, { type: "assistant_delta", text: "yo" }, { type: "done" }] as never;

  test("fresh: 0600 file, 0700 directory, no temp left", () => {
    const base = root("ho");
    const dir = join(base, "p", "sub");
    const file = join(dir, "handoff.json");
    new HandoffRunner({ file, sessionId: "s", cwd: base }).turnSettled(1, events);
    expect(mode(file)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    expect(temps(dir)).toEqual([]);
  });

  test("temp is `<file>.<pid>.tmp`, left behind when the rename fails", () => {
    const base = root("ho-t");
    const file = join(base, "handoff.json");
    blockRename(file);
    new HandoffRunner({ file, sessionId: "s", cwd: base }).turnSettled(1, events);
    expect(JSON.parse(readFileSync(`${file}.${pid}.tmp`, "utf8")).sessionId).toBe("s");
  });
});

describe("memory index (#writeIndex)", () => {
  test("an existing index keeps its mode", async () => {
    const store = new MemoryStore(join(root("mem"), "memory"));
    await store.append([{ topic: "t", fact: "one" }], "s1");
    chmodSync(store.indexFile, 0o640);
    await store.append([{ topic: "t", fact: "two" }], "s2");
    expect(mode(store.indexFile)).toBe(0o640);
    expect(temps(store.dir)).toEqual([]);
  });

  test("temp is `index.json.<pid>.tmp`, left behind when the rename fails", async () => {
    const store = new MemoryStore(join(root("mem-t"), "memory"));
    blockRename(store.indexFile);
    await expect(store.append([{ topic: "t", fact: "one" }], "s1")).rejects.toThrow();
    const tmp = join(store.dir, `index.json.${pid}.tmp`);
    expect(JSON.parse(readFileSync(tmp, "utf8")).topics.t.entries).toBe(1);
  });
});

describe("handoff export (exportHandoffFile)", () => {
  test("0600 file, creates no directory, no temp left", async () => {
    const base = root("hx");
    const out = join(base, "bridge.json");
    expect(await exportHandoffFile({ cwd: base, home: base, out, read: () => handoff })).toEqual({ ok: true, path: out });
    expect(mode(out)).toBe(0o600);
    expect(temps(base)).toEqual([]);
    const missing = join(base, "no-such", "bridge.json");
    const result = await exportHandoffFile({ cwd: base, home: base, out: missing, read: () => handoff });
    expect(result.ok).toBe(false);
    expect(existsSync(dirname(missing))).toBe(false);
  });

  test("temp is `<out>.<pid>.tmp`, left behind when the rename fails", async () => {
    const base = root("hx-t");
    const out = join(base, "bridge.json");
    blockRename(out);
    const result = await exportHandoffFile({ cwd: base, home: base, out, read: () => handoff });
    expect(result.ok).toBe(false);
    expect(JSON.parse(readFileSync(`${out}.${pid}.tmp`, "utf8")).sessionId).toBe("s-1");
  });
});

describe("handoff import (importHandoffFile)", () => {
  test("fresh: 0600 file, 0700 directory, no temp left", async () => {
    const base = root("hi");
    const file = join(base, "bridge.json");
    writeFileSync(file, JSON.stringify(handoff));
    const result = await importHandoffFile({ cwd: join(base, "proj"), home: base, file });
    expect(result.ok).toBe(true);
    const dest = importedHandoffFile(join(base, "proj"), base);
    expect(mode(dest)).toBe(0o600);
    expect(mode(dirname(dest))).toBe(0o700);
    expect(temps(dirname(dest))).toEqual([]);
  });

  test("temp is `<dest>.<pid>.tmp`, left behind when the rename fails", async () => {
    const base = root("hi-t");
    const file = join(base, "bridge.json");
    writeFileSync(file, JSON.stringify(handoff));
    const dest = importedHandoffFile(join(base, "proj"), base);
    blockRename(dest);
    const result = await importHandoffFile({ cwd: join(base, "proj"), home: base, file });
    expect(result.ok).toBe(false);
    expect(JSON.parse(readFileSync(`${dest}.${pid}.tmp`, "utf8")).sessionId).toBe("s-1");
  });
});

describe("published marker (writePublishedMarker)", () => {
  const transport: HandoffTransport = {
    async publish() {
      return { ok: true, url: "https://gist.github.com/abc" };
    },
    async fetch() {
      throw new Error("unused");
    },
  };

  test("0600 marker, no temp left", async () => {
    const base = root("pm");
    const artifactFile = join(base, "handoff.json");
    writeFileSync(artifactFile, `${JSON.stringify(handoff)}\n`);
    expect((await publishHandoffAtExit({ artifactFile, transport, timeoutMs: 500 })).ok).toBe(true);
    expect(mode(handoffPublishedMarkerFile(artifactFile))).toBe(0o600);
    expect(temps(base)).toEqual([]);
  });

  test("temp is `<marker>.<pid>.tmp`, left behind when the rename fails; the publish still succeeds", async () => {
    const base = root("pm-t");
    const artifactFile = join(base, "handoff.json");
    writeFileSync(artifactFile, `${JSON.stringify(handoff)}\n`);
    const marker = handoffPublishedMarkerFile(artifactFile);
    blockRename(marker);
    expect((await publishHandoffAtExit({ artifactFile, transport, timeoutMs: 500 })).ok).toBe(true);
    expect(JSON.parse(readFileSync(`${marker}.${pid}.tmp`, "utf8")).sessionId).toBe("s-1");
  });
});

describe("stranded-data acknowledgement (acknowledgeStrandedData)", () => {
  function seed(label: string): { dir: string; file: string } {
    const dir = root(label);
    const file = join(dir, "stranded-data.json");
    writeFileSync(file, JSON.stringify({ source: "/a", destination: "/b", recordedAt: "2026-01-01T00:00:00.000Z" }));
    chmodSync(file, 0o644);
    return { dir, file };
  }

  test("the replacement is a fresh 0600 file (the old mode is not kept); no temp left", () => {
    const { dir, file } = seed("sd");
    acknowledgeStrandedData(dir);
    expect(typeof JSON.parse(readFileSync(file, "utf8")).acknowledgedAt).toBe("string");
    expect(mode(file)).toBe(0o600);
    expect(temps(dir)).toEqual([]);
  });

  test("the temp is `<file>.<pid>.tmp` (a directory squatting on that name makes the write fail); no directory is created", () => {
    const { dir, file } = seed("sd-t");
    mkdirSync(`${file}.${pid}.tmp`);
    expect(() => acknowledgeStrandedData(dir)).toThrow();
    expect(JSON.parse(readFileSync(file, "utf8")).acknowledgedAt).toBeUndefined();
  });
});

describe("mpm projection (MpmStore.writeProjection)", () => {
  const record: MpmFileRecord = { path: "a.ts", hash: "h", size: 1, language: "ts", symbols: [], relations: [] };

  test("0600 manifest and shard, directory created without a mode, no temp left", () => {
    const dir = join(root("mpm"), "mpm");
    new MpmStore(dir).writeProjection(new Map([["a.ts", record]]));
    expect(mode(join(dir, "manifest.json"))).toBe(0o600);
    expect(mode(dir)).toBe(0o750); // 0o777 & ~umask: no explicit mode
    expect(temps(dir)).toEqual([]);
  });

  test("temp is `manifest.json.<pid>.tmp`, left behind when the rename fails", () => {
    const dir = join(root("mpm-t"), "mpm");
    blockRename(join(dir, "manifest.json"));
    expect(() => new MpmStore(dir).writeProjection(new Map([["a.ts", record]]))).toThrow();
    const tmp = join(dir, `manifest.json.${pid}.tmp`);
    expect(JSON.parse(readFileSync(tmp, "utf8")).fileCount).toBe(1);
    expect(mode(tmp)).toBe(0o600);
  });
});
