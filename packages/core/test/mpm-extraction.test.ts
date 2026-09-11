import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkspace, MPM_MAX_FILE_SIZE } from "../src/mpm/discover";
import { capabilityForPath, MPM_CAPABILITIES } from "../src/mpm/capabilities";
import { extractWorkspace } from "../src/mpm/extractor";
import { MpmService } from "../src/mpm/service";
import type { MpmRelationFamily } from "../src/mpm/capabilities";

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "moh-mpm-ws-"));
}

/** A small multi-language fixture corpus laid out under `root`. */
async function seedCorpus(root: string): Promise<void> {
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "src", "__tests__"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "vendor-pkg"), { recursive: true });
  await writeFile(
    join(root, "src", "types.ts"),
    `export interface Options {\n  name: string;\n}\nexport type Kind = "a" | "b";\n`,
  );
  await writeFile(
    join(root, "src", "date.ts"),
    `import type { Options } from "./types";\nexport function formatDate(o: Options): string {\n  return o.name;\n}\nexport const VERSION = 1;\n`,
  );
  await writeFile(
    join(root, "src", "__tests__", "date.test.ts"),
    `import { formatDate } from "../date";\n`,
  );
  await writeFile(
    join(root, "src", "legacy.js"),
    `const x = require("./types");\nmodule.exports = x;\n`,
  );
  await writeFile(
    join(root, "config", "settings.json"),
    `{\n  "entry": "./src/date.ts",\n  "other": "not-relative"\n}\n`,
  );
  await writeFile(join(root, "docs", "readme.md"), `# Docs\nSee src/date.ts.\n`);
  await writeFile(join(root, "vendor-pkg", "helper.js"), `export const h = 1;\n`);
  await mkdir(join(root, "vendor"), { recursive: true });
  await writeFile(join(root, "vendor", "vendored.go-ish.js"), `export const v = 1;\n`);
  await writeFile(join(root, "config", "settings.yaml"), `entry: "./src/date.ts"\n`);
  await writeFile(join(root, "config", "settings.toml"), `entry = "./src/date.ts"\n`);
  await writeFile(join(root, "README"), `coverage-only, no capability\n`);
}

describe("MPM discovery safety (#615)", () => {
  test("respects gitignore rules including negation and nested files", async () => {
    const root = await makeWorkspace();
    try {
      await seedCorpus(root);
      await writeFile(join(root, ".gitignore"), `vendor-pkg/\n*.json\n!config/settings.json\n`);
      await writeFile(join(root, "src", "scratch.ts"), `export const s = 1;\n`);
      const files = discoverWorkspace(root);
      expect(files).toContain("src/date.ts");
      expect(files).toContain("config/settings.json"); // negation rescues it
      expect(files).toContain("src/scratch.ts"); // untouched by any rule
      expect(files).not.toContain("vendor-pkg/helper.js");
      expect(files.filter((f) => f.endsWith(".json"))).toEqual(["config/settings.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("hard sensitive-file denylist is not rescuable by negation", async () => {
    const root = await makeWorkspace();
    try {
      await seedCorpus(root);
      await writeFile(join(root, ".gitignore"), `!.env\n!server.pem\n`);
      await writeFile(join(root, ".env"), `SECRET=1\n`);
      await writeFile(join(root, "server.pem"), `---KEY---\n`);
      await writeFile(join(root, "id_ed25519"), `---KEY---\n`);
      const files = discoverWorkspace(root);
      expect(files).not.toContain(".env");
      expect(files).not.toContain("server.pem");
      expect(files).not.toContain("id_ed25519");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("binary, oversize, generated, and excluded-dir files are skipped", async () => {
    const root = await makeWorkspace();
    try {
      await seedCorpus(root);
      await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(root, "node_modules", "pkg", "index.js"), `module.exports = 1;\n`);
      await writeFile(join(root, "logo.png"), `\x89PNG fake`);
      await writeFile(join(root, "app.min.js"), `var a=1;`);
      await writeFile(join(root, "sourcemap.js.map"), `{}`);
      await writeFile(join(root, "package-lock.json"), `{}`);
      await writeFile(join(root, "big.ts"), `export const big = ${"1".repeat(MPM_MAX_FILE_SIZE + 1)};\n`);
      const files = discoverWorkspace(root);
      expect(files).not.toContain("logo.png");
      expect(files).not.toContain("app.min.js");
      expect(files).not.toContain("sourcemap.js.map");
      expect(files).not.toContain("package-lock.json");
      expect(files).not.toContain("big.ts");
      expect(files.filter((f) => f.startsWith("node_modules/"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("symlinks leaving the root are never followed; inside-root links are followed once", async () => {
    const root = await makeWorkspace();
    try {
      await seedCorpus(root);
      const outside = await makeWorkspace();
      await writeFile(join(outside, "outside.ts"), `export const o = 1;\n`);
      await symlink(join(outside, "outside.ts"), join(root, "link-outside.ts"));
      await symlink(join(root, "src"), join(root, "src-link"));
      const files = discoverWorkspace(root);
      expect(files).not.toContain("link-outside.ts");
      expect(files).toContain("src-link/date.ts");
      await rm(outside, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("symlink loops are terminated, not fatal", async () => {
    const root = await makeWorkspace();
    try {
      await mkdir(join(root, "a"), { recursive: true });
      await mkdir(join(root, "b"), { recursive: true });
      await writeFile(join(root, "a", "one.ts"), `export const one = 1;\n`);
      await symlink(join(root, "b"), join(root, "a", "to-b"));
      await symlink(join(root, "a"), join(root, "b", "to-a"));
      const files = discoverWorkspace(root);
      expect(files).toContain("a/one.ts");
      // It terminates and maps at most one cycle traversal of the file.
      expect(files.filter((f) => f.endsWith("one.ts")).length).toBeLessThan(5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("committed vendor trees are excluded natively, without gitignore", async () => {
    const root = await makeWorkspace();
    try {
      await seedCorpus(root);
      const files = discoverWorkspace(root);
      expect(files).not.toContain("vendor/vendored.go-ish.js");
      expect(files).toContain("src/date.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("discovery is deterministic across runs", async () => {
    const root = await makeWorkspace();
    try {
      await seedCorpus(root);
      expect(discoverWorkspace(root)).toEqual(discoverWorkspace(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("MPM capability declarations (#615)", () => {
  test("each capability declares its relation families explicitly", () => {
    for (const cap of MPM_CAPABILITIES) {
      expect(cap.families).toBeInstanceOf(Set);
    }
    const ts = MPM_CAPABILITIES.find((c) => c.name === "typescript")!;
    expect(ts.families.has("imports" as MpmRelationFamily)).toBe(true);
    expect(ts.families.has("references" as MpmRelationFamily)).toBe(true);
    expect(ts.families.has("test-subjects" as MpmRelationFamily)).toBe(true);
    const md = MPM_CAPABILITIES.find((c) => c.name === "markdown")!;
    expect(md.families.size).toBe(0);
    // Families align with real relation kinds plus the derived test-subject edge.
    const kinds: ReadonlySet<string> = new Set(["imports", "references", "config-links", "test-subjects"]);
    for (const cap of MPM_CAPABILITIES) {
      for (const family of cap.families) expect(kinds.has(family)).toBe(true);
    }
  });

  test("unsupported extensions map with no capability", () => {
    expect(capabilityForPath("x.unknown")).toBeNull();
    expect(capabilityForPath("README")).toBeNull();
  });
});

describe("MPM extraction corpus (#615)", () => {
  test("proves import/export relations with source coordinates", async () => {
    const root = await makeWorkspace();
    try {
      await seedCorpus(root);
      const records = extractWorkspace(root);
      const date = records.get("src/date.ts")!;
      expect(date.language).toBe("typescript");
      expect(date.symbols).toContainEqual({ name: "formatDate", kind: "function", line: 2 });
      expect(date.symbols).toContainEqual({ name: "VERSION", kind: "const", line: 5 });
      expect(date.relations).toContainEqual({ kind: "imports", target: "src/types.ts", via: "./types", line: 1 });
      const test = records.get("src/__tests__/date.test.ts")!;
      expect(test.relations).toContainEqual({ kind: "imports", target: "src/date.ts", via: "../date", line: 1 });
      expect(test.relations).toContainEqual({ kind: "references", target: "src/date.ts", via: `test-subject:src/date.ts`, line: 1 });
      const js = records.get("src/legacy.js")!;
      expect(js.relations).toContainEqual({ kind: "imports", target: "src/types.ts", via: "./types", line: 1 });
      const yaml = records.get("config/settings.yaml")!;
      expect(yaml.language).toBe("yaml-config");
      expect(yaml.relations).toContainEqual({ kind: "config-links", target: "src/date.ts", via: "./src/date.ts", line: 1 });
      const toml = records.get("config/settings.toml")!;
      expect(toml.language).toBe("toml-config");
      expect(toml.relations).toContainEqual({ kind: "config-links", target: "src/date.ts", via: "./src/date.ts", line: 1 });
      expect(records.has("vendor/vendored.go-ish.js")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("configuration links are proven only against mapped files", async () => {
    const root = await makeWorkspace();
    try {
      await seedCorpus(root);
      const records = extractWorkspace(root);
      const config = records.get("config/settings.json")!;
      expect(config.language).toBe("json-config");
      expect(config.relations).toEqual([{ kind: "config-links", target: "src/date.ts", via: "./src/date.ts", line: 2 }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("partial-support silence: plain text and unsupported files carry no relations", async () => {
    const root = await makeWorkspace();
    try {
      await seedCorpus(root);
      const records = extractWorkspace(root);
      const md = records.get("docs/readme.md")!;
      expect(md.language).toBe("markdown");
      expect(md.symbols).toEqual([]);
      expect(md.relations).toEqual([]);
      const bare = records.get("README")!;
      expect(bare.language).toBe("unsupported");
      expect(bare.relations).toEqual([]);
      // Coverage, not absence: the file is still in the map.
      expect(records.has("docs/readme.md")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unresolvable specifiers are dropped, never invented", async () => {
    const root = await makeWorkspace();
    try {
      await writeFile(join(root, "a.ts"), `import x from "missing-pkg";\nimport y from "./nowhere";\n`);
      const records = extractWorkspace(root);
      expect(records.get("a.ts")!.relations).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("extraction stores no source-file content", async () => {
    const root = await makeWorkspace();
    try {
      await seedCorpus(root);
      const records = extractWorkspace(root);
      for (const record of records.values()) {
        expect(JSON.stringify(record)).not.toContain("return o.name");
        expect(JSON.stringify(record)).not.toContain("SECRET");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("extracted records feed MpmService.rebuild and answer provenance queries", async () => {
    const root = await makeWorkspace();
    try {
      await seedCorpus(root);
      const mapDir = join(root, ".moh-projection");
      const records = extractWorkspace(root);
      const svc = new MpmService(mapDir);
      svc.rebuild(records);
      expect(svc.status).toBe("ready");
      const result = svc.query("src/__tests__/date.test.ts");
      expect(result).not.toBeNull();
      expect(result!.paths).toContain("src/date.ts");
      const idx = result!.paths.indexOf("src/date.ts");
      expect(result!.provenance[idx].source).toBe("src/__tests__/date.test.ts");
      expect(result!.provenance[idx].line).toBe(1);
      expect(result!.provenance[idx].extractor).toBe("mpm/typescript");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
