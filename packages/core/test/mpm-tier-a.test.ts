import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractWorkspace } from "../src/mpm/extractor";
import { MpmService } from "../src/mpm/service";

/**
 * #639 Tier A fixture corpus: path-based languages whose relations resolve
 * to real workspace files. Per language: proven relations with coordinates,
 * silence where a convention is not locally provable, and discovery safety
 * applying unchanged.
 */

async function tierAWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "moh-mpm-tierA-"));

  // Python
  await mkdir(join(root, "py", "pkg"), { recursive: true });
  await writeFile(join(root, "py", "pkg", "__init__.py"), `PKG = 1\n`);
  await writeFile(join(root, "py", "pkg", "core.py"), `def run(x):\n    return x\n\nclass Engine:\n    pass\n`);
  await writeFile(join(root, "py", "app.py"), `from .pkg import core\nfrom .pkg.core import run\nimport os\nfrom ..outside import nope\n`);
  await writeFile(join(root, "py", "test_app.py"), `from .app import run\n`);

  // Go
  await mkdir(join(root, "go", "internal", "store"), { recursive: true });
  await writeFile(join(root, "go", "go.mod"), `module example.com/proj\n\ngo 1.22\n`);
  await writeFile(join(root, "go", "main.go"), `package main\n\nimport (\n\t"fmt"\n\t"example.com/proj/internal/store"\n)\n\nfunc main() {\n\tstore.Open()\n}\n`);
  await writeFile(join(root, "go", "internal", "store", "store.go"), `package store\n\ntype Store struct{}\n\nfunc Open() *Store {\n\treturn nil\n}\n`);
  await writeFile(join(root, "go", "main.ts"), ``); // noise guard

  // C / C++
  await mkdir(join(root, "c", "include"), { recursive: true });
  await writeFile(join(root, "c", "include", "util.h"), `#pragma once\nstruct Config { int a; };\nint util(void);\n`);
  await writeFile(join(root, "c", "main.c"), `#include "include/util.h"\n#include <stdio.h>\n#include "missing.h"\nint main(void) { return util(); }\n`);

  // PHP
  await mkdir(join(root, "php", "lib"), { recursive: true });
  await writeFile(join(root, "php", "lib", "helper.php"), `<?php\nfunction helper() {}\n`);
  await writeFile(join(root, "php", "index.php"), `<?php\nrequire_once "./lib/helper.php";\ninclude __DIR__ . "/gone.php";\nclass App {}\n`);
  await writeFile(join(root, "php", "var.php"), `<?php\nrequire $path;\n`);

  // Shell
  await mkdir(join(root, "sh", "lib"), { recursive: true });
  await writeFile(join(root, "sh", "lib", "common.sh"), `log() {\n  echo "$1"\n}\n`);
  await writeFile(join(root, "sh", "deploy.sh"), `#!/bin/bash\nsource ./lib/common.sh\n. /etc/profile\nbuild() {\n  log hi\n}\n`);

  // Lua
  await mkdir(join(root, "lua", "modules"), { recursive: true });
  await writeFile(join(root, "lua", "modules", "cfg.lua"), `local function load() end\nreturn {}\n`);
  await writeFile(join(root, "lua", "main.lua"), `local cfg = require("./modules/cfg")\ndofile("./modules/cfg.lua")\nlocal function main() end\nrequire("nonexistent")\n`);

  return root;
}

describe("Tier A — Python (#639)", () => {
  test("relative imports and defs/classes resolve with coordinates", async () => {
    const root = await tierAWorkspace();
    try {
      const records = extractWorkspace(root);
      const app = records.get("py/app.py")!;
      expect(app.language).toBe("python");
      // `from .pkg import core` proves the package __init__; the explicit
      // module import proves core.py itself.
      expect(app.relations).toContainEqual({ kind: "imports", target: "py/pkg/__init__.py", via: "rel:.:pkg", line: 1 });
      expect(app.relations).toContainEqual({ kind: "imports", target: "py/pkg/core.py", via: "rel:.:pkg/core", line: 2 });
      const core = records.get("py/pkg/core.py")!;
      expect(core.symbols).toContainEqual({ name: "run", kind: "function", line: 1 });
      expect(core.symbols).toContainEqual({ name: "Engine", kind: "class", line: 4 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("absolute imports and unresolvable relatives stay silent", async () => {
    const root = await tierAWorkspace();
    try {
      const records = extractWorkspace(root);
      const app = records.get("py/app.py")!;
      // `import os` and `from ..outside import nope` are unprovable: dropped.
      expect(app.relations.every((r) => r.via.startsWith("rel"))).toBe(true);
      expect(app.relations.every((r) => ["py/pkg/core.py", "py/pkg/__init__.py"].includes(r.target))).toBe(true);
      // Test file gains a references edge to its subject.
      const test = records.get("py/test_app.py")!;
      expect(test.relations).toContainEqual({
        kind: "references",
        target: "py/app.py",
        via: "test-subject:py/app.py",
        line: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Tier A — Go (#639)", () => {
  test("module-qualified package imports resolve to package files", async () => {
    const root = await tierAWorkspace();
    try {
      const records = extractWorkspace(root);
      const main = records.get("go/main.go")!;
      expect(main.language).toBe("go");
      // The stdlib import ("fmt") is silent — not under the module path.
      expect(main.relations).toEqual([
        { kind: "imports", target: "go/internal/store/store.go", via: "example.com/proj/internal/store", line: 5 },
      ]);
      const store = records.get("go/internal/store/store.go")!;
      expect(store.symbols).toContainEqual({ name: "Open", kind: "function", line: 5 });
      expect(store.symbols).toContainEqual({ name: "Store", kind: "interface", line: 3 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("without go.mod, package imports are unprovable and stay silent", async () => {
    const root = await tierAWorkspace();
    try {
      const { rm: rmSync } = await import("node:fs/promises");
      await rmSync(join(root, "go", "go.mod"));
      const records = extractWorkspace(root);
      const main = records.get("go/main.go")!;
      expect(main.relations).toEqual([]);
      expect(main.symbols).toContainEqual({ name: "main", kind: "function", line: 8 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Tier A — C/C++ (#639)", () => {
  test("quote-form includes resolve; system and missing includes stay silent", async () => {
    const root = await tierAWorkspace();
    try {
      const records = extractWorkspace(root);
      const main = records.get("c/main.c")!;
      expect(main.language).toBe("c-family");
      expect(main.relations).toEqual([
        { kind: "imports", target: "c/include/util.h", via: "include/util.h", line: 1 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Tier A — PHP (#639)", () => {
  test("literal include/require resolves; variable and magic-constant paths stay silent", async () => {
    const root = await tierAWorkspace();
    try {
      const records = extractWorkspace(root);
      const index = records.get("php/index.php")!;
      expect(index.language).toBe("php");
      expect(index.relations).toEqual([
        { kind: "imports", target: "php/lib/helper.php", via: "./lib/helper.php", line: 2 },
      ]);
      expect(index.symbols).toContainEqual({ name: "App", kind: "class", line: 4 });
      const helper = records.get("php/lib/helper.php")!;
      expect(helper.symbols).toContainEqual({ name: "helper", kind: "function", line: 2 });
      // Variable-path require is dropped entirely.
      const varFile = records.get("php/var.php")!;
      expect(varFile.relations).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Tier A — Shell (#639)", () => {
  test("source/. of relative paths resolve; absolute paths stay silent", async () => {
    const root = await tierAWorkspace();
    try {
      const records = extractWorkspace(root);
      const deploy = records.get("sh/deploy.sh")!;
      expect(deploy.language).toBe("shell");
      expect(deploy.relations).toEqual([
        { kind: "imports", target: "sh/lib/common.sh", via: "./lib/common.sh", line: 2 },
      ]);
      expect(deploy.symbols).toContainEqual({ name: "build", kind: "function", line: 4 });
      const common = records.get("sh/lib/common.sh")!;
      expect(common.symbols).toContainEqual({ name: "log", kind: "function", line: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Tier A — Lua (#639)", () => {
  test("./require and dofile resolve; bare module names stay silent", async () => {
    const root = await tierAWorkspace();
    try {
      const records = extractWorkspace(root);
      const main = records.get("lua/main.lua")!;
      expect(main.language).toBe("lua");
      expect(main.relations).toEqual([
        { kind: "imports", target: "lua/modules/cfg.lua", via: "./modules/cfg", line: 1 },
        { kind: "imports", target: "lua/modules/cfg.lua", via: "./modules/cfg.lua", line: 2 },
      ]);
      const cfg = records.get("lua/modules/cfg.lua")!;
      expect(cfg.symbols).toContainEqual({ name: "load", kind: "function", line: 1 });
      expect(main.symbols).toContainEqual({ name: "main", kind: "function", line: 3 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Tier A — end-to-end through MpmService (#639)", () => {
  test("extracted tier-A records feed the projection and answer queries", async () => {
    const root = await tierAWorkspace();
    try {
      const records = extractWorkspace(root);
      const svc = new MpmService(join(root, ".moh-projection"));
      svc.rebuild(records);
      const result = svc.query("py/test_app.py");
      expect(result!.paths).toContain("py/app.py");
      const idx = result!.paths.indexOf("py/app.py");
      expect(result!.provenance[idx].extractor).toBe("mpm/python");
      const go = svc.query("go/main.go");
      expect(go!.paths).toContain("go/internal/store/store.go");
      expect(go!.provenance[go!.paths.indexOf("go/internal/store/store.go")].extractor).toBe("mpm/go");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
