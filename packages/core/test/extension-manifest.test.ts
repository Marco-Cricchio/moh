/**
 * The extension manifest (ADR-0061, #1125): capabilities, version and
 * entry point declared in a static `moh.extension.json` beside the entry
 * point. Consent reads it without executing anything; the runtime verifies
 * the code's declared capabilities are a subset of the manifest's.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityDiff, readExtensionManifest } from "../src/extension-manifest";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "moh-manifest-"));
  dirs.push(dir);
  return dir;
}

describe("readExtensionManifest", () => {
  test("reads a well-formed manifest beside the entry point", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "moh.extension.json"),
      JSON.stringify({ name: "guard", version: "1.2.0", entry: "index.mjs", capabilities: ["contribute-commands"] }),
    );
    const result = readExtensionManifest(join(dir, "index.mjs"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe("guard");
      expect(result.manifest.version).toBe("1.2.0");
      expect(result.manifest.capabilities).toEqual(["contribute-commands"]);
    }
  });

  // ADR-0070 (#1166): the manifest grammar gains a `dependencies` object —
  // exact versions only, a range is a validation error naming the package.
  describe("dependencies (ADR-0070)", () => {
    test("exact dependencies are read onto the manifest and the authority consent signs", () => {
      const dir = tempDir();
      writeFileSync(
        join(dir, "moh.extension.json"),
        JSON.stringify({ name: "d", version: "1.0.0", entry: "index.mjs", capabilities: [], dependencies: { zod: "3.23.8", left: "1.3.0-beta.2" } }),
      );
      writeFileSync(join(dir, "index.mjs"), "export default {};");
      const result = readExtensionManifest(join(dir, "index.mjs"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.manifest.dependencies).toEqual({ zod: "3.23.8", left: "1.3.0-beta.2" });
        expect(result.authority.dependencies).toEqual({ zod: "3.23.8", left: "1.3.0-beta.2" });
      }
    });

    test("a range is a malformed manifest naming the package and the exactness rule", () => {
      const dir = tempDir();
      writeFileSync(
        join(dir, "moh.extension.json"),
        JSON.stringify({ name: "d", version: "1.0.0", entry: "index.mjs", capabilities: [], dependencies: { zod: "^3.23.8" } }),
      );
      const result = readExtensionManifest(join(dir, "index.mjs"));
      expect(result).toMatchObject({ ok: false, reason: "malformed" });
      if (!result.ok) {
        expect(result.message).toContain("zod");
        expect(result.message).toContain("^3.23.8");
        expect(result.message).toContain("exact");
      }
    });

    test("every range shape refuses: caret, tilde, wildcard, tag, partial", () => {
      for (const spec of ["~2.0.0", "2.x", "*", "latest", "2.0"]) {
        const dir = tempDir();
        writeFileSync(
          join(dir, "moh.extension.json"),
          JSON.stringify({ name: "d", version: "1.0.0", entry: "index.mjs", dependencies: { pkg: spec } }),
        );
        const result = readExtensionManifest(join(dir, "index.mjs"));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.message).toContain("pkg");
      }
    });

    test("a wrong-shaped dependencies value is malformed; absent dependencies stay legal", () => {
      const dir = tempDir();
      writeFileSync(
        join(dir, "moh.extension.json"),
        JSON.stringify({ name: "d", version: "1.0.0", entry: "index.mjs", dependencies: ["zod@3"] }),
      );
      expect(readExtensionManifest(join(dir, "index.mjs")).ok).toBe(false);
      writeFileSync(
        join(dir, "moh.extension.json"),
        JSON.stringify({ name: "d", version: "1.0.0", entry: "index.mjs" }),
      );
      const plain = readExtensionManifest(join(dir, "index.mjs"));
      expect(plain.ok).toBe(true);
      if (plain.ok) expect(plain.manifest.dependencies).toBeUndefined();
    });
  });

  test("a missing manifest is not an error object — the caller refuses without one", () => {
    const dir = tempDir();
    const result = readExtensionManifest(join(dir, "index.mjs"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing");
  });

  test("malformed JSON and wrong-shaped fields are `malformed`, never a throw", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "moh.extension.json"), "{not json");
    let result = readExtensionManifest(join(dir, "index.mjs"));
    expect(result).toMatchObject({ ok: false, reason: "malformed" });

    writeFileSync(join(dir, "moh.extension.json"), JSON.stringify({ name: "x", version: 1, entry: "index.mjs" }));
    result = readExtensionManifest(join(dir, "index.mjs"));
    expect(result).toMatchObject({ ok: false, reason: "malformed" });

    // capabilities must be strings when present.
    writeFileSync(
      join(dir, "moh.extension.json"),
      JSON.stringify({ name: "x", version: "1.0.0", entry: "index.mjs", capabilities: [1, 2] }),
    );
    result = readExtensionManifest(join(dir, "index.mjs"));
    expect(result).toMatchObject({ ok: false, reason: "malformed" });
  });

  test("a manifest whose entry names another file does not belong to this module", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "moh.extension.json"),
      JSON.stringify({ name: "other", version: "1.0.0", entry: "other.mjs", capabilities: [] }),
    );
    const result = readExtensionManifest(join(dir, "index.mjs"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing");
  });

  test("a manifest may declare several entries sharing one package's capabilities", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "moh.extension.json"),
      JSON.stringify({
        name: "pkg",
        version: "1.0.0",
        entry: ["a-first.mjs", "b-second.mjs"],
        capabilities: ["contribute-commands"],
      }),
    );
    expect(readExtensionManifest(join(dir, "b-second.mjs"))).toMatchObject({ ok: true });
  });
});

describe("capabilityDiff", () => {
  test("added is what the new list has and the old lacks; removed is the reverse", () => {
    expect(capabilityDiff(["a", "b"], ["b", "c", "a"])).toEqual({ added: ["c"], removed: [] });
    expect(capabilityDiff(["a", "b"], ["b"])).toEqual({ added: [], removed: ["a"] });
    expect(capabilityDiff([], ["x"])).toEqual({ added: ["x"], removed: [] });
    expect(capabilityDiff(["same"], ["same"])).toEqual({ added: [], removed: [] });
  });
});

describe("runtime × manifest (ADR-0061, #1125)", () => {
  const bait = (marker: string) =>
    `import { writeFileSync } from "node:fs";\n` +
    `writeFileSync(${JSON.stringify(marker)}, "top-level code ran");\n` +
    `export default { name: "bait", version: "1.0.0", apiVersion: "1.0", setup() {} };\n`;

  test("a missing manifest asks no consent and imports nothing — not even top-level code", async () => {
    const { ExtensionRuntime } = await import("../src/index");
    const dir = mkdtempSync(join(tmpdir(), "moh-manifest-rt-"));
    dirs.push(dir);
    const marker = join(dir, "PWNED");
    const file = join(dir, "bait.mjs");
    writeFileSync(file, bait(marker));
    let asked = 0;
    const rt = new ExtensionRuntime({ mohHome: dir, consent: () => { asked += 1; return true; } });
    expect(await rt.registerFile(file)).toBe(false);
    expect(asked).toBe(0);
    expect(rt.instances).toHaveLength(0);
    expect(require("node:fs").existsSync(marker)).toBe(false);
    const failed = rt.consumeLoadEvents().find((e: any) => e.type === "extension_failed");
    expect(failed).toMatchObject({ reason: "manifest" });
  });

  test("a malformed manifest refuses the same way", async () => {
    const { ExtensionRuntime } = await import("../src/index");
    const dir = mkdtempSync(join(tmpdir(), "moh-manifest-rt-"));
    dirs.push(dir);
    const file = join(dir, "bait.mjs");
    writeFileSync(file, bait(join(dir, "PWNED")));
    writeFileSync(join(dir, "moh.extension.json"), "{nope");
    let asked = 0;
    const rt = new ExtensionRuntime({ mohHome: dir, consent: () => { asked += 1; return true; } });
    expect(await rt.registerFile(file)).toBe(false);
    expect(asked).toBe(0);
    expect(require("node:fs").existsSync(join(dir, "PWNED"))).toBe(false);
  });

  test("a code capability outside the manifest refuses loudly, naming the slot", async () => {
    const { ExtensionRuntime } = await import("../src/index");
    const dir = mkdtempSync(join(tmpdir(), "moh-manifest-rt-"));
    dirs.push(dir);
    const file = join(dir, "greedy.mjs");
    writeFileSync(
      file,
      `export default { name: "greedy", version: "1.0.0", apiVersion: "1.0",
        capabilities: ["contribute-commands", "contribute-panels"], setup() {} };`,
    );
    writeFileSync(
      join(dir, "moh.extension.json"),
      JSON.stringify({ name: "greedy", version: "1.0.0", entry: "greedy.mjs", capabilities: ["contribute-commands"] }),
    );
    const rt = new ExtensionRuntime({ mohHome: dir, consent: () => true });
    expect(await rt.registerFile(file)).toBe(false);
    const failed = rt.consumeLoadEvents().find((e: any) => e.type === "extension_failed");
    expect(failed).toMatchObject({ reason: "capability_undeclared" });
    expect((failed as any).message).toContain("contribute-panels");
    expect(rt.instances).toHaveLength(0);
  });

  test("a widening manifest edit re-asks with the capability diff in the question", async () => {
    const { ExtensionRuntime } = await import("../src/index");
    const dir = mkdtempSync(join(tmpdir(), "moh-manifest-rt-"));
    dirs.push(dir);
    const file = join(dir, "grow.mjs");
    const writeIt = (caps: string[]) => {
      writeFileSync(
        file,
        `export default { name: "grow", version: "1.0.0", apiVersion: "1.0", capabilities: ${JSON.stringify(caps)}, setup() {} };`,
      );
      writeFileSync(
        join(dir, "moh.extension.json"),
        JSON.stringify({ name: "grow", version: "1.0.0", entry: "grow.mjs", capabilities: caps }),
      );
    };
    writeIt(["contribute-commands"]);
    const asks: any[] = [];
    let answer = true;
    const rt1 = new ExtensionRuntime({
      mohHome: dir,
      consent: (r) => {
        asks.push(r);
        return answer;
      },
    });
    expect(await rt1.registerFile(file)).toBe(true);
    // Unchanged manifest+code: no second ask.
    const rt2 = new ExtensionRuntime({ mohHome: dir, consent: () => (asks.push({ unchanged: true }), false) });
    expect(await rt2.registerFile(file)).toBe(true);
    // Widening edit: asked again, with the diff.
    writeIt(["contribute-commands", "contribute-panels"]);
    const rt3 = new ExtensionRuntime({
      mohHome: dir,
      consent: (r) => {
        asks.push(r);
        return true;
      },
    });
    expect(await rt3.registerFile(file)).toBe(true);
    expect(asks).toHaveLength(2);
    expect(asks[0].capabilities).toEqual(["contribute-commands"]);
    expect(asks[0].addedCapabilities).toBeUndefined();
    expect(asks[1].addedCapabilities).toEqual(["contribute-panels"]);
  });
});
