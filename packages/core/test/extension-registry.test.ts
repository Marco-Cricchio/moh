/**
 * The extension registry (#1128, ADR-0061): installs from exactly two
 * immutable sources (npm scoped, GitHub releases) with static checks
 * only — package code is never executed. Checksum mismatches refuse
 * with expected/actual digests; unknown capability slots warn; raw URLs
 * are refused; list/remove share the catalog seam.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installExtension,
  listInstalledExtensions,
  parseExtensionRef,
  removeInstalledExtension,
  scopeGrammarValidity,
  verifyIntegrity,
  type NpmPackument,
  type RegistryIo,
} from "../src/extension-registry";
import { MANIFEST_FILE } from "../src/extension-manifest";
import { DEPS_LOCK_FILE, EXTENSION_DEPS_DIR, extensionDepsDir } from "../src/extension-deps";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "moh-registry-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const GOOD_MANIFEST = { name: "no-rm-rf", version: "1.2.0", entry: "index.mjs", capabilities: ["veto"] };

/** Builds a fake npm tarball payload and the io serving it. */
function fakeRegistryIo(options: {
  packument: NpmPackument;
  tgzBytes?: Uint8Array;
  integrity?: string;
  github?: { release: unknown; digest?: string };
  rawResponses?: Map<string, string>;
  /** GitHub archives extract at the root, without npm's "package/" wrapper. */
  flatArchive?: boolean;
}): RegistryIo & { fetchedUrls: string[]; extractedInto: string[] } {
  const tgz = options.tgzBytes ?? new TextEncoder().encode("fake-tgz-bytes");
  const state = { fetchedUrls: [] as string[], extractedInto: [] as string[] };
  return {
    fetchedUrls: state.fetchedUrls,
    extractedInto: state.extractedInto,
    async fetchText(url) {
      state.fetchedUrls.push(url);
      const raw = options.rawResponses?.get(url);
      if (raw) return { ok: true, body: raw };
      if (url.includes("registry.npmjs.org")) return { ok: true, body: JSON.stringify(options.packument) };
      if (url.includes("api.github.com")) {
        const release = options.github?.release ?? {};
        return { ok: true, body: JSON.stringify(release) };
      }
      if (url.endsWith(".sha256")) return { ok: true, body: `${options.github?.digest ?? ""}` };
      return { ok: false, message: `unexpected fetch ${url}` };
    },
    async fetchBytes(url) {
      state.fetchedUrls.push(url);
      return { ok: true, body: tgz };
    },
    async extractTgz(_tgz, dir) {
      state.extractedInto.push(dir);
      mkdirSync(join(dir, "package"), { recursive: true });
      writeFileSync(join(dir, "package", MANIFEST_FILE), JSON.stringify(GOOD_MANIFEST));
      writeFileSync(join(dir, "package", "index.mjs"), "export default { name: 'no-rm-rf', version: '1.2.0', apiVersion: '1.0', setup() {} };\n");
      writeFileSync(join(dir, "package", "package.json"), JSON.stringify({ dependencies: { zod: "^4" } }));
      // a GitHub archive has no npm "package/" wrapper — files at the root
      if (options.flatArchive) {
        writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(GOOD_MANIFEST));
        writeFileSync(join(dir, "index.mjs"), "export default {};\n");
      }
    },
  };
}

function packumentFor(tgz: Uint8Array, version = "1.2.0"): NpmPackument {
  const integrity = `sha512-${createHash("sha512").update(tgz).digest("base64")}`;
  return {
    "dist-tags": { latest: version },
    versions: { [version]: { dist: { tarball: "https://registry.npmjs.org/@x/y/-/y-1.2.0.tgz", integrity } } },
  };
}

describe("parseExtensionRef", () => {
  test("parses npm scoped packages with and without a version", () => {
    expect(parseExtensionRef("@scope/name@1.2.0")).toEqual({ ok: true, ref: { source: "npm", package: "@scope/name", version: "1.2.0" } });
    expect(parseExtensionRef("@scope/name")).toEqual({ ok: true, ref: { source: "npm", package: "@scope/name" } });
  });

  test("parses github repo+tag references", () => {
    expect(parseExtensionRef("github:owner/repo@v1.2.0")).toEqual({ ok: true, ref: { source: "github", owner: "owner", repo: "repo", tag: "v1.2.0" } });
    expect(parseExtensionRef("github:owner/repo")).toEqual({ ok: true, ref: { source: "github", owner: "owner", repo: "repo" } });
  });

  test("refuses raw URLs and tarballs with the immutable-sources reason", () => {
    for (const bad of ["https://example.com/ext.tgz", "http://example.com/ext.zip", "./ext.tgz"]) {
      const result = parseExtensionRef(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("immutable sources");
    }
    expect(parseExtensionRef("").ok).toBe(false);
    expect(parseExtensionRef("bare-name").ok).toBe(false);
  });
});

describe("verifyIntegrity", () => {
  test("accepts a matching sha512 integrity and refuses a mismatch with digests", () => {
    const bytes = new TextEncoder().encode("payload");
    const good = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    expect(verifyIntegrity(bytes, good)).toEqual({ ok: true });
    const bad = verifyIntegrity(bytes, `sha512-${createHash("sha512").update("other").digest("base64")}`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.expected).toContain("sha512-");
      expect(bad.actual).toContain("sha512-");
      expect(bad.expected).not.toBe(bad.actual);
    }
  });
});

describe("scopeGrammarValidity (ADR-0071)", () => {
  test("a typo in any shipped prefix's grammar is refused with a clear message", () => {
    for (const typo of ["path:/abs", "host:", "credential:", "tool:", "contribute-tool:bad name", "endpoint:"]) {
      const result = scopeGrammarValidity(typo);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain(`invalid scope "${typo}"`);
    }
  });
  test("valid shipped scopes and truly novel slots pass untouched", () => {
    for (const capability of ["path:src/**", "host:api.example.com", "credential:ref", "tool:git", "contribute-tool:search", "endpoint:zen", "observe", "time-travel"]) {
      expect(scopeGrammarValidity(capability).ok).toBe(true);
    }
  });
});

describe("installExtension (npm)", () => {
  test("installs without executing package code: manifest read, checksum verified, files extracted", async () => {
    const tgz = new TextEncoder().encode("tarball-1");
    const io = fakeRegistryIo({ packument: packumentFor(tgz), tgzBytes: tgz });
    const dest = tempDir();
    const parsed = parseExtensionRef("@scope/name@1.2.0");
    if (!parsed.ok) throw new Error(parsed.reason);
    const result = await installExtension({ ref: parsed.ref, destRoot: dest, io });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.name).toBe("no-rm-rf");
      expect(result.version).toBe("1.2.0");
      expect(result.dir).toBe(join(dest, "no-rm-rf"));
      expect(result.notes.join(" ")).toContain("never authorizes");
    }
    expect(io.extractedInto.length).toBe(1);
  });

  test("a checksum mismatch refuses with the expected and actual digests", async () => {
    const tgz = new TextEncoder().encode("real-bytes");
    const packument = packumentFor(new TextEncoder().encode("other-bytes"));
    const io = fakeRegistryIo({ packument, tgzBytes: tgz });
    const result = await installExtension({ ref: { source: "npm", package: "@scope/name", version: "1.2.0" }, destRoot: tempDir(), io });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("checksum mismatch");
      expect(result.expected).toMatch(/^sha512-/);
      expect(result.actual).toMatch(/^sha512-/);
    }
  });

  test("an unknown capability slot warns and still installs; load-time consent still decides", async () => {
    const tgz = new TextEncoder().encode("warn-bytes");
    const io = fakeRegistryIo({ packument: packumentFor(tgz), tgzBytes: tgz });
    const originalExtract = io.extractTgz.bind(io);
    (io as { extractTgz: typeof io.extractTgz }).extractTgz = async (bytes, dir) => {
      await originalExtract(bytes, dir);
      writeFileSync(
        join(dir, "package", MANIFEST_FILE),
        JSON.stringify({ ...GOOD_MANIFEST, capabilities: ["veto", "time-travel"] }),
      );
    };
    const result = await installExtension({ ref: { source: "npm", package: "@scope/name", version: "1.2.0" }, destRoot: tempDir(), io });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.join(" ")).toContain("time-travel");
      expect(result.notes.join(" ")).toContain("consent");
    }
  });

  test("a typo in a shipped scope's grammar is a manifest error, never a warning (ADR-0071)", async () => {
    const tgz = new TextEncoder().encode("typo-bytes");
    const io = fakeRegistryIo({ packument: packumentFor(tgz), tgzBytes: tgz });
    const originalExtract = io.extractTgz.bind(io);
    (io as { extractTgz: typeof io.extractTgz }).extractTgz = async (bytes, dir) => {
      await originalExtract(bytes, dir);
      writeFileSync(
        join(dir, "package", MANIFEST_FILE),
        JSON.stringify({ ...GOOD_MANIFEST, capabilities: ["path:/etc/passwd"] }),
      );
    };
    const result = await installExtension({ ref: { source: "npm", package: "@scope/name", version: "1.2.0" }, destRoot: tempDir(), io });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("path:/etc/passwd");
    }
  });

  test("one valid scope per shipped prefix installs with no unknown-slot warnings", async () => {
    const tgz = new TextEncoder().encode("scopes-bytes");
    const io = fakeRegistryIo({ packument: packumentFor(tgz), tgzBytes: tgz });
    const originalExtract = io.extractTgz.bind(io);
    (io as { extractTgz: typeof io.extractTgz }).extractTgz = async (bytes, dir) => {
      await originalExtract(bytes, dir);
      writeFileSync(
        join(dir, "package", MANIFEST_FILE),
        JSON.stringify({
          ...GOOD_MANIFEST,
          capabilities: [
            "path:src/**",
            "host:api.example.com",
            "credential:typesafe",
            "tool:git",
            "contribute-tool:search",
            "endpoint:zen",
          ],
        }),
      );
    };
    const result = await installExtension({ ref: { source: "npm", package: "@scope/name", version: "1.2.0" }, destRoot: tempDir(), io });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toEqual([]);
    }
  });

  test("a missing manifest refuses the install", async () => {
    const tgz = new TextEncoder().encode("no-manifest");
    const io = fakeRegistryIo({ packument: packumentFor(tgz), tgzBytes: tgz });
    const originalExtract = io.extractTgz.bind(io);
    (io as { extractTgz: typeof io.extractTgz }).extractTgz = async (bytes, dir) => {
      await originalExtract(bytes, dir);
      rmSync(join(dir, "package", MANIFEST_FILE));
    };
    const result = await installExtension({ ref: { source: "npm", package: "@scope/name", version: "1.2.0" }, destRoot: tempDir(), io });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(MANIFEST_FILE);
  });

  test("declared npm dependencies are noted, never installed", async () => {
    const tgz = new TextEncoder().encode("deps-bytes");
    const io = fakeRegistryIo({ packument: packumentFor(tgz), tgzBytes: tgz });
    const result = await installExtension({ ref: { source: "npm", package: "@scope/name", version: "1.2.0" }, destRoot: tempDir(), io });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.notes.join(" ")).toContain("zod");
  });

  test("a package with no integrity digest is refused", async () => {
    const io = fakeRegistryIo({
      packument: { "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { dist: { tarball: "https://registry.npmjs.org/@x/y/-/y.tgz" } } } },
    });
    const result = await installExtension({ ref: { source: "npm", package: "@scope/name", version: "1.0.0" }, destRoot: tempDir(), io });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("integrity");
  });
});

describe("installExtension (github)", () => {
  test("installs from a release with a verified SHA-256 digest asset", async () => {
    const tgz = new TextEncoder().encode("gh-bytes");
    const digest = createHash("sha256").update(tgz).digest("hex");
    const io = fakeRegistryIo({
      packument: {},
      tgzBytes: tgz,
      flatArchive: true,
      github: { release: { tag_name: "v1.2.0", assets: [{ name: "src.tar.gz", browser_download_url: "https://github.com/o/r/releases/src.tar.gz" }, { name: "src.tar.gz.sha256", browser_download_url: "https://github.com/o/r/releases/src.tar.gz.sha256" }] }, digest },
    });
    const result = await installExtension({ ref: { source: "github", owner: "o", repo: "r", tag: "v1.2.0" }, destRoot: tempDir(), io });
    expect(result.ok).toBe(true);
  });

  test("a wrong digest refuses with expected and actual", async () => {
    const tgz = new TextEncoder().encode("gh-bytes");
    const io = fakeRegistryIo({
      packument: {},
      flatArchive: true,
      github: {
        release: { tag_name: "v1", assets: [{ name: "src.tar.gz", browser_download_url: "https://github.com/o/r/x.tgz" }, { name: "x.tgz.sha256", browser_download_url: "https://github.com/o/r/x.sha256" }] },
        digest: createHash("sha256").update("different").digest("hex"),
      },
      tgzBytes: tgz,
    });
    const result = await installExtension({ ref: { source: "github", owner: "o", repo: "r" }, destRoot: tempDir(), io });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("checksum mismatch");
  });

  test("a release without a digest asset is refused, never installed unverified", async () => {
    const io = fakeRegistryIo({
      packument: {},
      github: { release: { tag_name: "v1", assets: [{ name: "src.tar.gz", browser_download_url: "https://github.com/o/r/x.tgz" }] } },
    });
    const result = await installExtension({ ref: { source: "github", owner: "o", repo: "r" }, destRoot: tempDir(), io });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("sha256");
  });
});

describe("listInstalledExtensions / removeInstalledExtension", () => {
  function writePkg(root: string, name: string, version = "1.0.0", capabilities: string[] = ["veto"]): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify({ name, version, entry: "index.mjs", capabilities }));
    writeFileSync(join(dir, "index.mjs"), "export default {};\n");
    return dir;
  }

  test("lists installed packages from both roots with manifest data", () => {
    const home = tempDir();
    const cwd = tempDir();
    mkdirSync(join(home, ".moh", "extensions"), { recursive: true });
    mkdirSync(join(cwd, "extensions"), { recursive: true });
    writePkg(join(home, ".moh", "extensions"), "user-ext");
    writePkg(join(cwd, "extensions"), "project-ext");
    const all = listInstalledExtensions({ mohHome: join(home, ".moh"), cwd });
    expect(all.map((e) => `${e.name}:${e.scope}`).sort()).toEqual(["project-ext:project", "user-ext:user"]);
  });

  test("same identity in both scopes: project wins, the dotdir copy is visibly reported, no error", () => {
    const home = tempDir();
    const cwd = tempDir();
    mkdirSync(join(home, ".moh", "extensions"), { recursive: true });
    mkdirSync(join(cwd, "extensions"), { recursive: true });
    writePkg(join(home, ".moh", "extensions"), "dup", "1.0.0");
    writePkg(join(cwd, "extensions"), "dup", "2.0.0");
    const all = listInstalledExtensions({ mohHome: join(home, ".moh"), cwd });
    expect(all).toHaveLength(1);
    const dup = all[0]!;
    expect(dup.scope).toBe("project");
    expect(dup.version).toBe("2.0.0");
    expect(dup.ignoredDuplicates?.[0]).toContain(join(home, ".moh", "extensions"));
  });

  test("remove deletes the project copy first and reports an unknown name", () => {
    const home = tempDir();
    const cwd = tempDir();
    mkdirSync(join(home, ".moh", "extensions"), { recursive: true });
    mkdirSync(join(cwd, "extensions"), { recursive: true });
    const userDir = writePkg(join(home, ".moh", "extensions"), "gone");
    writePkg(join(cwd, "extensions"), "gone");
    const result = removeInstalledExtension("gone", { mohHome: join(home, ".moh"), cwd });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scope).toBe("project");
      expect(result.path).not.toBe(userDir);
    }
    // the dotdir copy still exists and is now the listed one
    expect(listInstalledExtensions({ mohHome: join(home, ".moh"), cwd })[0]?.scope).toBe("user");
    expect(removeInstalledExtension("absent", { mohHome: join(home, ".moh"), cwd }).ok).toBe(false);
  });

  test("remove deletes the extension's dependency directory too (ADR-0070)", () => {
    const home = tempDir();
    const cwd = tempDir();
    const mohHome = join(home, ".moh");
    mkdirSync(join(mohHome, "extensions"), { recursive: true });
    writePkg(join(mohHome, "extensions"), "depped");
    // A dependency tree under the moh-owned extension-deps root.
    const depsDir = extensionDepsDir(mohHome, "depped");
    mkdirSync(join(depsDir, "node_modules", "zod"), { recursive: true });
    writeFileSync(join(depsDir, "node_modules", "zod", "package.json"), "{}");
    writeFileSync(join(depsDir, DEPS_LOCK_FILE), "{}");
    const result = removeInstalledExtension("depped", { mohHome, cwd });
    expect(result.ok).toBe(true);
    // The dependency directory went with the package; the root holds
    // nothing else (no shared store, no GC).
    expect(existsSync(depsDir)).toBe(false);
    expect(existsSync(join(mohHome, EXTENSION_DEPS_DIR))).toBe(true);
  });
});
