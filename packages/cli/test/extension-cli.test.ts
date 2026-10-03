import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionCommand, type ExtensionOptions } from "../src/extension";
import type { NpmPackument, RegistryIo } from "@moh/core";

const MANIFEST = { name: "no-rm-rf", version: "1.2.0", entry: "index.mjs", capabilities: ["veto"] };

function fakeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "moh-ext-cli-"));
  mkdirSync(join(dir, ".moh"));
  return dir;
}

function fakeIo(options: {
  packument: NpmPackument;
  tgzBytes?: Uint8Array;
  digest?: string;
  withDeps?: boolean;
}): RegistryIo & { extracted: string[] } {
  const tgz = options.tgzBytes ?? new TextEncoder().encode("tgz-bytes");
  const state = { extracted: [] as string[] };
  return {
    extracted: state.extracted,
    async fetchText(url: string) {
      if (url.includes("registry.npmjs.org")) return { ok: true, body: JSON.stringify(options.packument) };
      if (url.includes("api.github.com")) {
        return {
          ok: true,
          body: JSON.stringify({
            tag_name: "v1.2.0",
            assets: [
              { name: "src.tar.gz", browser_download_url: "https://github.test/o/r/src.tar.gz" },
              { name: "src.tar.gz.sha256", browser_download_url: "https://github.test/o/r/src.tar.gz.sha256" },
            ],
          }),
        };
      }
      if (url.endsWith(".sha256")) return { ok: true, body: options.digest ?? "" };
      return { ok: false, message: `unexpected fetch ${url}` };
    },
    async fetchBytes(_url: string) {
      return { ok: true, body: tgz };
    },
    async extractTgz(_tgz: Uint8Array, dir: string) {
      state.extracted.push(dir);
      mkdirSync(join(dir, "package"), { recursive: true });
      writeFileSync(join(dir, "package", "moh.extension.json"), JSON.stringify(MANIFEST));
      writeFileSync(join(dir, "package", "index.mjs"), "export default {};\n");
      if (options.withDeps) writeFileSync(join(dir, "package", "package.json"), JSON.stringify({ dependencies: { zod: "^4" } }));
    },
  };
}

function npmPackument(tgz: Uint8Array, integrity = true): NpmPackument {
  return {
    "dist-tags": { latest: "1.2.0" },
    versions: {
      "1.2.0": {
        dist: {
          tarball: "https://registry.npmjs.org/@scope/name/-/name-1.2.0.tgz",
          ...(integrity ? { integrity: `sha512-${createHash("sha512").update(tgz).digest("base64")}` } : {}),
        },
      },
    },
  };
}

async function run(argv: string[], cwd: string, home: string, io?: RegistryIo) {
  const out: string[] = [];
  const err: string[] = [];
  const options: ExtensionOptions = {
    argv,
    cwd,
    home,
    ...(io ? { io } : {}),
    stdout: { write: (s: string) => out.push(s) } as unknown as NodeJS.WritableStream,
    stderr: { write: (s: string) => err.push(s) } as unknown as NodeJS.WritableStream,
  };
  const code = await extensionCommand(options);
  return { code, out: out.join(""), err: err.join("") };
}

describe("moh extension", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "moh-ext-cwd-"));
    dirs.push(d);
    return d;
  };

  test("add installs an npm package into the project scope without executing code", async () => {
    const cwd = tmp();
    const home = fakeHome();
    const tgz = new TextEncoder().encode("cli-bytes");
    const io = fakeIo({ packument: npmPackument(tgz), tgzBytes: tgz, withDeps: true });
    const r = await run(["add", "@scope/name@1.2.0"], cwd, home, io);
    expect(r.code).toBe(0);
    expect(r.out).toContain("installed no-rm-rf@1.2.0");
    expect(r.out).toContain("never authorizes");
    expect(r.out).toContain("zod"); // dependencies noted, never installed
    // the installed dir exists with the manifest — no node_modules, no install run
    expect(readdirSync(join(cwd, "extensions", "no-rm-rf"))).toContain("moh.extension.json");
  });

  test("add --user installs into the dotdir", async () => {
    const cwd = tmp();
    const home = fakeHome();
    const tgz = new TextEncoder().encode("user-bytes");
    const io = fakeIo({ packument: npmPackument(tgz), tgzBytes: tgz });
    const r = await run(["add", "@scope/name", "--user"], cwd, home, io);
    expect(r.code).toBe(0);
    expect(r.out).toContain(join(home, ".moh", "extensions", "no-rm-rf"));
  });

  test("a checksum mismatch refuses with the expected and actual digests", async () => {
    const cwd = tmp();
    const home = fakeHome();
    const io = fakeIo({ packument: npmPackument(new TextEncoder().encode("different")), tgzBytes: new TextEncoder().encode("real") });
    const r = await run(["add", "@scope/name@1.2.0"], cwd, home, io);
    expect(r.code).toBe(1);
    expect(r.err).toContain("checksum mismatch");
    expect(r.err).toContain("expected:");
    expect(r.err).toContain("actual:");
  });

  test("a raw URL refuses with the immutable-sources reason", async () => {
    const cwd = tmp();
    const home = fakeHome();
    const r = await run(["add", "https://example.com/ext.tgz"], cwd, home);
    expect(r.code).toBe(2);
    expect(r.err).toContain("immutable sources");
  });

  test("an npm package without an integrity digest is refused", async () => {
    const cwd = tmp();
    const home = fakeHome();
    const io = fakeIo({ packument: npmPackument(new TextEncoder().encode("x"), false), tgzBytes: new TextEncoder().encode("x") });
    const r = await run(["add", "@scope/name@1.2.0"], cwd, home, io);
    expect(r.code).toBe(1);
    expect(r.err).toContain("integrity");
  });

  test("add from a GitHub release verifies the digest asset", async () => {
    const cwd = tmp();
    const home = fakeHome();
    const tgz = new TextEncoder().encode("gh-cli-bytes");
    const io = fakeIo({ packument: {}, tgzBytes: tgz, digest: createHash("sha256").update(tgz).digest("hex") });
    const r = await run(["add", "github:owner/repo@v1.2.0"], cwd, home, io);
    expect(r.code).toBe(0);
    expect(r.out).toContain("installed no-rm-rf@1.2.0");
  });

  test("list reports both scopes and the ignored duplicate copy", async () => {
    const cwd = tmp();
    const home = fakeHome();
    for (const root of [join(cwd, "extensions"), join(home, ".moh", "extensions")]) {
      mkdirSync(root, { recursive: true });
      const dir = join(root, "dup");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "moh.extension.json"), JSON.stringify(MANIFEST));
      writeFileSync(join(dir, "index.mjs"), "export default {};\n");
    }
    const r = await run(["list"], cwd, home);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no-rm-rf@1.2.0");
    expect(r.out).toContain("[project");
    expect(r.out).toContain("ignored duplicate");
    expect(r.out).toContain("project scope wins");
  });

  test("list is empty-state friendly; remove works project-first and refuses unknown names", async () => {
    const cwd = tmp();
    const home = fakeHome();
    let r = await run(["list"], cwd, home);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no extensions installed");

    mkdirSync(join(cwd, "extensions", "gone"), { recursive: true });
    writeFileSync(join(cwd, "extensions", "gone", "moh.extension.json"), JSON.stringify(MANIFEST));
    writeFileSync(join(cwd, "extensions", "gone", "index.mjs"), "export default {};\n");
    r = await run(["remove", "no-rm-rf"], cwd, home);
    expect(r.code).toBe(0);
    expect(r.out).toContain("(project scope)");
    r = await run(["remove", "no-rm-rf"], cwd, home);
    expect(r.code).toBe(1);
    expect(r.err).toContain('no installed extension named "no-rm-rf"');
  });

  test("help and unknown commands behave like the other command groups", async () => {
    const cwd = tmp();
    const home = fakeHome();
    let r = await run(["--help"], cwd, home);
    expect(r.code).toBe(0);
    expect(r.out).toContain("usage: moh extension");
    r = await run(["frobnicate"], cwd, home);
    expect(r.code).toBe(2);
    expect(r.err).toContain('unknown command "frobnicate"');
    r = await run(["add"], cwd, home);
    expect(r.code).toBe(2);
    expect(r.err).toContain("package reference is required");
  });
});
