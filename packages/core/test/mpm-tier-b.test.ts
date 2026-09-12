import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractWorkspace } from "../src/mpm/extractor";
import { MpmService } from "../src/mpm/service";

/**
 * #640 Tier B fixture corpus: module-based languages whose relations
 * resolve only through project files (ADR-0025). Each language proves both
 * halves of the contract: what resolves through its anchor, and what stays
 * silent when the anchor is absent or the mapping is ambiguous.
 */

async function tierBWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "moh-mpm-tierB-"));

  // Rust: crate with nested mod tree.
  await mkdir(join(root, "rust", "src", "store"), { recursive: true });
  await writeFile(join(root, "rust", "Cargo.toml"), `[package]\nname = "app"\nversion = "0.1.0"\n`);
  await writeFile(
    join(root, "rust", "src", "main.rs"),
    `mod store;\nfn main() {\n    store::open();\n}\n`,
  );
  await writeFile(
    join(root, "rust", "src", "store", "mod.rs"),
    `pub mod backend;\npub fn open() {\n    backend::connect();\n}\n`,
  );
  await writeFile(
    join(root, "rust", "src", "store", "backend.rs"),
    `use crate::store::open;\npub fn connect() {\n    open();\n}\npub struct Pool;\n`,
  );
  // C#: SDK-style project with literal namespace/directory mapping.
  await mkdir(join(root, "csharp", "App", "Services"), { recursive: true });
  await writeFile(join(root, "csharp", "App.csproj"), `<Project Sdk="Microsoft.NET.Sdk">\n</Project>\n`);
  await writeFile(
    join(root, "csharp", "App", "Services", "Greeter.cs"),
    `namespace App.Services;\npublic class Greeter {\n}\n`,
  );
  await writeFile(
    join(root, "csharp", "Program.cs"),
    `using App.Services;\nnamespace App;\nclass Program {\n    static void Main() {}\n}\n`,
  );
  // Same namespace declared in two files → ambiguous → silent.
  await writeFile(
    join(root, "csharp", "App", "Services", "GreeterB.cs"),
    `namespace App.Services;\nclass GreeterB {}\n`,
  );

  // Swift: package with a literal Sources/<Target> layout.
  await mkdir(join(root, "swift", "Sources", "Networking"), { recursive: true });
  await writeFile(
    join(root, "swift", "Package.swift"),
    `// swift-tools-version:5.9\nlet package = Package(\n  name: "App",\n  targets: [\n    .target(name: "Networking"),\n    .executableTarget(name: "App")\n  ]\n)\n`,
  );
  await writeFile(
    join(root, "swift", "Sources", "Networking", "Client.swift"),
    `public struct Client {\n  public func run() {}\n}\n`,
  );
  await mkdir(join(root, "swift", "Sources", "App"), { recursive: true });
  await writeFile(
    join(root, "swift", "Sources", "App", "Main.swift"),
    `import Networking\nstruct App {\n  let client = Client()\n}\nfunc start() {}\n`,
  );

  // Kotlin: Gradle source-set with literal package/directory mapping.
  await mkdir(join(root, "kotlin", "src", "main", "kotlin", "com", "example"), { recursive: true });
  await writeFile(join(root, "kotlin", "build.gradle.kts"), `plugins { kotlin("jvm") }\n`);
  await writeFile(
    join(root, "kotlin", "src", "main", "kotlin", "com", "example", "Repo.kt"),
    `package com.example\nclass Repo {\n    fun find() {}\n}\n`,
  );
  await writeFile(
    join(root, "kotlin", "src", "main", "kotlin", "com", "example", "App.kt"),
    `package com.example\nimport com.example.Repo\nfun main() {\n}\n`,
  );
  await writeFile(
    join(root, "kotlin", "src", "main", "kotlin", "com", "example", "Second.kt"),
    `package com.example\nobject Holder\n`,
  );

  return root;
}

describe("Tier B — Rust (#640)", () => {
  test("mod declarations resolve to both file layouts, crate paths walk the tree", async () => {
    const root = await tierBWorkspace();
    try {
      const records = extractWorkspace(root);
      const main = records.get("rust/src/main.rs")!;
      expect(main.language).toBe("rust");
      // `mod store;` → store/mod.rs (directory layout wins over store.rs).
      expect(main.relations).toContainEqual({ kind: "imports", target: "rust/src/store/mod.rs", via: "mod:store", line: 1 });
      expect(main.symbols).toContainEqual({ name: "main", kind: "function", line: 2 });
      const modRs = records.get("rust/src/store/mod.rs")!;
      expect(modRs.relations).toContainEqual({
        kind: "imports",
        target: "rust/src/store/backend.rs",
        via: "mod:backend",
        line: 1,
      });
      expect(modRs.symbols).toContainEqual({ name: "open", kind: "function", line: 2 });
      const backend = records.get("rust/src/store/backend.rs")!;
      // `use crate::store::open` walks crate root → store/mod.rs → open in mod.rs.
      expect(backend.relations).toContainEqual({
        kind: "imports",
        target: "rust/src/store/mod.rs",
        via: "crate:store::open",
        line: 1,
      });
      expect(backend.symbols).toContainEqual({ name: "connect", kind: "function", line: 2 });
      expect(backend.symbols).toContainEqual({ name: "Pool", kind: "class", line: 5 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("use crate paths to nonexistent modules stay silent; extern crates stay silent", async () => {
    const root = await tierBWorkspace();
    try {
      const { writeFile: wf } = await import("node:fs/promises");
      await wf(
        join(root, "rust", "src", "extra.rs"),
        `use crate::nope::missing;\nuse serde::Serialize;\npub fn e() {}\n`,
      );
      const records = extractWorkspace(root);
      const extra = records.get("rust/src/extra.rs")!;
      // Neither the unresolvable crate path nor the extern crate survives.
      expect(extra.relations).toEqual([]);
      expect(extra.symbols).toContainEqual({ name: "e", kind: "function", line: 3 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Tier B — C# (#640)", () => {
  test("namespace references resolve when unique, stay silent when ambiguous", async () => {
    const root = await tierBWorkspace();
    try {
      const records = extractWorkspace(root);
      const program = records.get("csharp/Program.cs")!;
      expect(program.language).toBe("csharp");
      // Both Greeter.cs and GreeterB.cs declare App.Services → the using is
      // ambiguous → dropped rather than guessed.
      expect(program.relations).toEqual([]);
      expect(program.symbols).toContainEqual({ name: "Program", kind: "class", line: 3 });
      const greeter = records.get("csharp/App/Services/Greeter.cs")!;
      expect(greeter.symbols).toContainEqual({ name: "Greeter", kind: "class", line: 2 });
      // A namespace declared by exactly one file resolves.
      const { rm: rmF } = await import("node:fs/promises");
      await rmF(join(root, "csharp", "App", "Services", "GreeterB.cs"));
      const fresh = extractWorkspace(root);
      const program2 = fresh.get("csharp/Program.cs")!;
      expect(program2.relations).toEqual([
        { kind: "references", target: "csharp/App/Services/Greeter.cs", via: "ns:App.Services", line: 1 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("without a csproj anchor, namespace references stay silent", async () => {
    const root = await tierBWorkspace();
    try {
      const { rm: rmF } = await import("node:fs/promises");
      await rmF(join(root, "csharp", "App.csproj"));
      const records = extractWorkspace(root);
      const program = records.get("csharp/Program.cs")!;
      expect(program.relations).toEqual([]);
      expect(program.symbols).toContainEqual({ name: "Program", kind: "class", line: 3 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Tier B — Swift (#640)", () => {
  test("module imports resolve through Package.swift target declarations", async () => {
    const root = await tierBWorkspace();
    try {
      const records = extractWorkspace(root);
      const main = records.get("swift/Sources/App/Main.swift")!;
      expect(main.language).toBe("swift");
      expect(main.relations).toEqual([
        { kind: "references", target: "swift/Sources/Networking/Client.swift", via: "module:Networking", line: 1 },
      ]);
      expect(main.symbols).toContainEqual({ name: "start", kind: "function", line: 5 });
      expect(main.symbols).toContainEqual({ name: "App", kind: "class", line: 2 });
      const client = records.get("swift/Sources/Networking/Client.swift")!;
      expect(client.symbols).toContainEqual({ name: "Client", kind: "class", line: 1 });
      expect(client.symbols).toContainEqual({ name: "run", kind: "function", line: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("system imports stay silent; resolution is per-file literal", async () => {
    const root = await tierBWorkspace();
    try {
      const { writeFile: wf } = await import("node:fs/promises");
      await wf(join(root, "swift", "Sources", "App", "Extra.swift"), `import Foundation\n`);
      const records = extractWorkspace(root);
      // Foundation is an undeclared (system) target: silent.
      const extra = records.get("swift/Sources/App/Extra.swift")!;
      expect(extra.relations).toEqual([]);
      const { rm: rmF } = await import("node:fs/promises");
      await rmF(join(root, "swift", "Package.swift"));
      const fresh = extractWorkspace(root);
      const main = fresh.get("swift/Sources/App/Main.swift")!;
      expect(main.relations).toEqual([]);
      expect(main.symbols).toContainEqual({ name: "App", kind: "class", line: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Tier B — Kotlin (#640)", () => {
  test("package references resolve through Gradle source-set layout", async () => {
    const root = await tierBWorkspace();
    try {
      const records = extractWorkspace(root);
      const app = records.get("kotlin/src/main/kotlin/com/example/App.kt")!;
      expect(app.language).toBe("kotlin");
      // App.kt imports com.example.Repo → Repo.kt is the unique file that
      // pins that dotted path → provable. Its own package declaration
      // (com.example) would match itself → self-relations never emitted.
      expect(app.relations).toEqual([
        {
          kind: "references",
          target: "kotlin/src/main/kotlin/com/example/Repo.kt",
          via: "pkg:com.example.Repo",
          line: 2,
        },
      ]);
      expect(app.symbols).toContainEqual({ name: "main", kind: "function", line: 3 });
      // But the declaring file still maps with symbols.
      const repo = records.get("kotlin/src/main/kotlin/com/example/Repo.kt")!;
      expect(repo.symbols).toContainEqual({ name: "Repo", kind: "class", line: 2 });
      expect(repo.symbols).toContainEqual({ name: "find", kind: "function", line: 3 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unique package-directory file resolves; no build file stays silent", async () => {
    const root = await tierBWorkspace();
    try {
      const { mkdir: mkd, rm: rmF, writeFile: wf } = await import("node:fs/promises");
      await mkd(join(root, "kotlin", "src", "main", "kotlin", "com", "example", "unique"), { recursive: true });
      await wf(
        join(root, "kotlin", "src", "main", "kotlin", "com", "example", "unique", "Solo.kt"),
        `package com.example.unique\nclass Solo\n`,
      );
      await wf(
        join(root, "kotlin", "src", "main", "kotlin", "com", "example", "App2.kt"),
        `package com.example\nimport com.example.unique.Solo\nfun other() {}\n`,
      );
      const records = extractWorkspace(root);
      const app2 = records.get("kotlin/src/main/kotlin/com/example/App2.kt")!;
      expect(app2.relations).toEqual([
        {
          kind: "references",
          target: "kotlin/src/main/kotlin/com/example/unique/Solo.kt",
          via: "pkg:com.example.unique.Solo",
          line: 2,
        },
      ]);
      await rmF(join(root, "kotlin", "build.gradle.kts"));
      const fresh = extractWorkspace(root);
      expect(fresh.get("kotlin/src/main/kotlin/com/example/App2.kt")!.relations).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Tier B — end-to-end through MpmService (#640)", () => {
  test("extracted tier-B records feed the projection with correct provenance", async () => {
    const root = await tierBWorkspace();
    try {
      const records = extractWorkspace(root);
      const svc = new MpmService(join(root, ".moh-projection"));
      svc.rebuild(records);
      const rust = svc.query("rust/src/store/backend.rs");
      expect(rust!.paths).toContain("rust/src/store/mod.rs");
      const idx = rust!.paths.indexOf("rust/src/store/mod.rs");
      expect(rust!.provenance[idx].extractor).toBe("mpm/rust");
      const swift = svc.query("swift/Sources/App/Main.swift");
      expect(swift!.paths).toContain("swift/Sources/Networking/Client.swift");
      expect(swift!.provenance[swift!.paths.indexOf("swift/Sources/Networking/Client.swift")].extractor).toBe("mpm/swift");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
