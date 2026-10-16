// Keep-criterion check for @moh/core (#1396, ADR-0004). Every name exported
// by the core entry (the list #1388 locks in entry-surface/core.txt) must be
// imported from "@moh/core" by a client — the non-test files of tui, cli,
// jev-guard, team, extension and evals, or a runnable example in
// docs/extending/examples/ — or have a line in keep-criterion/allowlist.txt
// naming the docs/extending/ page that documents it. Tests never count as a
// client (tests import from the defining module, ADR-0004), neither core's
// nor the clients'.
//
// The names failing both on the day the check landed are in
// keep-criterion/baseline.txt. It is a ratchet: a new failing name fails
// here, and so does a baseline name that a client now imports or that the
// entry no longer exports, so the baseline can only shrink.
//
// Both lists are sorted, one name per line (allowlist: `<name> <page>`).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { clientUses, keepCriterionErrors } from "./keep-criterion/scan";

const ROOT = join(import.meta.dir, "..", "..", "..");
const LISTS = join(import.meta.dir, "keep-criterion");
const CLIENTS = ["tui", "cli", "jev-guard", "team", "extension", "evals"];
const EXAMPLES = join(ROOT, "docs", "extending", "examples");
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function coreExports(): string[] {
  const entry = join(ROOT, "packages", "core", "src", "index.ts");
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const moduleSymbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) throw new Error(`entry has no exports: ${entry}`);
  return [...new Set(checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.getName()))].sort();
}

function clientFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "test") walk(path);
      } else if (SOURCE.test(entry.name) && !/\.test\.[a-z]+$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  for (const pkg of CLIENTS) walk(join(ROOT, "packages", pkg));
  walk(EXAMPLES);
  return files.sort();
}

function readLines(file: string): string[] {
  return readFileSync(join(LISTS, file), "utf8").split("\n").filter((line) => line !== "");
}

const sorted = (lines: readonly string[]) => [...new Set(lines)].sort();

describe("@moh/core keep-criterion", () => {
  test("every export is client-imported, allowlisted, or in the shrinking baseline", () => {
    const baseline = readLines("baseline.txt");
    const allowLines = readLines("allowlist.txt");
    expect(baseline).toEqual(sorted(baseline));
    expect(allowLines).toEqual(sorted(allowLines));
    const allowlist = new Map<string, string>();
    for (const line of allowLines) {
      const match = /^(\S+) (\S+)$/.exec(line);
      if (match === null) throw new Error(`allowlist line is not "<name> <page>": ${line}`);
      if (allowlist.has(match[1]!)) throw new Error(`allowlist names ${match[1]} twice`);
      allowlist.set(match[1]!, match[2]!);
    }

    const used = new Set<string>();
    const problems: string[] = [];
    for (const file of clientFiles()) {
      const uses = clientUses(relative(ROOT, file), readFileSync(file, "utf8"));
      for (const name of uses.names) used.add(name);
      problems.push(...uses.problems);
    }
    expect(problems).toEqual([]);

    const errors = keepCriterionErrors({
      exports: coreExports(),
      used,
      allowlist,
      baseline,
      pageExists: (page) => existsSync(join(ROOT, page)),
    });
    if (errors.length > 0) {
      throw new Error(
        `@moh/core keep-criterion (#1396):\n  ${errors.join("\n  ")}\n` +
          "Import the name from a client, document it under docs/extending/ and add an allowlist line, " +
          "or stop exporting it. Remove baseline lines that no longer fail; never add new ones.",
      );
    }
  });
});

describe("client-use scanner", () => {
  const names = (text: string, file = "client.ts") => {
    const uses = clientUses(file, text);
    expect(uses.problems).toEqual([]);
    return [...uses.names].sort();
  };
  const problems = (text: string) => clientUses("client.ts", text).problems;

  test("static named import", () => {
    expect(names(`import { a, b } from "@moh/core";`)).toEqual(["a", "b"]);
  });

  test("type-only import and inline type specifier", () => {
    expect(names(`import type { A } from "@moh/core"; import { type B, c } from "@moh/core";`)).toEqual(["A", "B", "c"]);
  });

  test("aliased import counts the exported name, not the local one", () => {
    expect(names(`import { a as local, type B as Bee } from "@moh/core"; local(); let x: Bee;`)).toEqual(["B", "a"]);
  });

  test("re-export from a client package, aliased or not", () => {
    expect(names(`export { a, b as c, type D } from "@moh/core";`)).toEqual(["D", "a", "b"]);
  });

  test("namespace import with property, element and type access", () => {
    const text = `import * as core from "@moh/core"; core.a(); core["b"]; const { c, d: e } = core; let t: core.T;`;
    expect(names(text)).toEqual(["T", "a", "b", "c", "d"]);
  });

  test("dynamic import with destructuring", () => {
    expect(names(`const { a, b: local } = await import("@moh/core");`)).toEqual(["a", "b"]);
  });

  test("dynamic import with property access", () => {
    expect(names(`(await import("@moh/core")).a(); const m = await import("@moh/core"); m.b;`)).toEqual(["a", "b"]);
  });

  test("dynamic import of another entry is not a core use", () => {
    expect(names(`const { renderTui } = await import("@moh/tui"); import { x } from "@moh/extension";`)).toEqual([]);
  });

  test("import type node, qualified or indexed", () => {
    const text = `let a: import("@moh/core").A; type P = Parameters<typeof import("@moh/core").B.scripted>; type C = typeof import("@moh/core")["c"];`;
    expect(names(text)).toEqual(["A", "B", "c"]);
  });

  test("require and import-equals", () => {
    expect(names(`const { a } = require("@moh/core"); import core = require("@moh/core"); core.b;`)).toEqual(["a", "b"]);
  });

  test("JavaScript and TSX sources", () => {
    expect(names(`import { a } from "@moh/core";`, "example.mjs")).toEqual(["a"]);
    expect(names(`import { A } from "@moh/core"; export const X = () => <A />;`, "view.tsx")).toEqual(["A"]);
  });

  test("forms that cannot be attributed are reported, never skipped", () => {
    expect(problems(`export * from "@moh/core";`)).toHaveLength(1);
    expect(problems(`export * as core from "@moh/core";`)).toHaveLength(1);
    expect(problems(`import * as core from "@moh/core"; use(core);`)).toHaveLength(1);
    expect(problems(`import("@moh/core").then((m) => m.a);`)).toHaveLength(1);
    expect(problems(`use(await import("@moh/core"));`)).toHaveLength(1);
    expect(problems(`const { ...rest } = await import("@moh/core");`)).toHaveLength(1);
  });
});

describe("keep-criterion ratchet", () => {
  const base = {
    exports: ["a", "b", "c"],
    used: new Set(["a"]),
    allowlist: new Map([["b", "docs/extending/library-usage.md"]]),
    baseline: ["c"],
    pageExists: () => true,
  };

  test("passes when every export is used, allowlisted or in the baseline", () => {
    expect(keepCriterionErrors(base)).toEqual([]);
  });

  test("a new export with no client import fails; a client import makes it pass", () => {
    const added = { ...base, exports: [...base.exports, "d"] };
    expect(keepCriterionErrors(added)).toEqual(["export with no client import and no allowlist entry: d"]);
    expect(keepCriterionErrors({ ...added, used: new Set(["a", "d"]) })).toEqual([]);
  });

  test("a baseline name that a client now imports fails (the baseline only shrinks)", () => {
    expect(keepCriterionErrors({ ...base, used: new Set(["a", "c"]) })).toEqual([
      "baseline entry now imported by a client (remove it): c",
    ]);
  });

  test("a baseline name the entry no longer exports is a stale entry", () => {
    expect(keepCriterionErrors({ ...base, exports: ["a", "b"] })).toEqual([
      "baseline entry no longer exported (remove it): c",
    ]);
  });

  test("an allowlist line must name an existing docs/extending/ page of an exported name", () => {
    expect(keepCriterionErrors({ ...base, pageExists: () => false })).toEqual([
      "allowlist entry b names a missing docs/extending/ page: docs/extending/library-usage.md",
    ]);
    expect(keepCriterionErrors({ ...base, allowlist: new Map([["b", "docs/manual/x.md"]]) })).toEqual([
      "allowlist entry b names a missing docs/extending/ page: docs/manual/x.md",
    ]);
    expect(keepCriterionErrors({ ...base, exports: ["a", "c"] })).toEqual(["allowlist entry no longer exported: b"]);
  });
});
