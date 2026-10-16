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
// An allowlist page must resolve inside docs/extending/ and name the symbol
// as a whole word (see `pageNames`); an allowlisted name that a client now
// imports must leave the allowlist, as for the baseline.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import {
  ALLOWLIST_FILE,
  BASELINE_FILE,
  clientUses,
  keepCriterionErrors,
  listOrderErrors,
  pageNames,
  parseAllowlist,
  scriptKind,
} from "./keep-criterion/scan";

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

describe("@moh/core keep-criterion", () => {
  test("every export is client-imported, allowlisted, or in the shrinking baseline", () => {
    const baseline = readLines("baseline.txt");
    const allowLines = readLines("allowlist.txt");
    const errors = [...listOrderErrors(BASELINE_FILE, baseline), ...listOrderErrors(ALLOWLIST_FILE, allowLines)];
    const parsed = parseAllowlist(allowLines);
    const allowlist = parsed.allowlist;
    errors.push(...parsed.errors);

    const used = new Set<string>();
    for (const file of clientFiles()) {
      const uses = clientUses(relative(ROOT, file), readFileSync(file, "utf8"));
      for (const name of uses.names) used.add(name);
      errors.push(...uses.problems);
    }

    errors.push(
      ...keepCriterionErrors({
        exports: coreExports(),
        used,
        allowlist,
        baseline,
        pageText: (page) => (existsSync(join(ROOT, page)) ? readFileSync(join(ROOT, page), "utf8") : undefined),
      }),
    );
    if (errors.length > 0) throw new Error(`@moh/core keep-criterion (#1396):\n  ${errors.join("\n  ")}`);
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

  test("a same-named local shadows the namespace: its members never count", () => {
    const head = `import * as core from "@moh/core"; core.a(); `;
    expect(names(head + `function f() { const core = other(); core.ghost; }`)).toEqual(["a"]);
    expect(names(head + `function f() { let core = other(); core.ghost; }`)).toEqual(["a"]);
    expect(names(head + `function f() { var core = other(); core.ghost; }`)).toEqual(["a"]);
    expect(names(head + `try { run(); } catch (core) { core.ghost; }`)).toEqual(["a"]);
    expect(names(head + `for (const core of items) core.ghost;`)).toEqual(["a"]);
    expect(names(head + `function f(core) { return core.ghost; }`)).toEqual(["a"]);
    expect(names(`const m = await import("@moh/core"); m.a; function g(s) { const m = /x/.exec(s); return m.ghost; }`)).toEqual(["a"]);
  });

  test("a namespace use that names no member is reported, even next to a shadow", () => {
    expect(problems(`import * as core from "@moh/core"; { const core = 1; core.ghost; } use(core);`)).toHaveLength(1);
    expect(problems(`import * as core from "@moh/core"; use({ core });`)).toHaveLength(1);
    expect(problems(`import * as core from "@moh/core"; export { core };`)).toHaveLength(1);
    expect(problems(`import * as core from "@moh/core"; const again = core; again.a;`)).toHaveLength(1);
  });

  test("scriptKind follows the file extension", () => {
    expect(scriptKind("a.ts")).toBe(ts.ScriptKind.TS);
    expect(scriptKind("a.mts")).toBe(ts.ScriptKind.TS);
    expect(scriptKind("a.cts")).toBe(ts.ScriptKind.TS);
    expect(scriptKind("a.tsx")).toBe(ts.ScriptKind.TSX);
    expect(scriptKind("a.jsx")).toBe(ts.ScriptKind.JSX);
    expect(scriptKind("a.js")).toBe(ts.ScriptKind.JS);
    expect(scriptKind("a.mjs")).toBe(ts.ScriptKind.JS);
    expect(scriptKind("a.cjs")).toBe(ts.ScriptKind.JS);
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
  const page = "docs/extending/library-usage.md";
  const base = {
    exports: ["a", "b", "c"],
    used: new Set(["a"]),
    allowlist: new Map([["b", page]]),
    baseline: ["c"],
    pageText: (path: string) => (path === page ? "Call `b(x)` to get it." : undefined),
  };

  test("passes when every export is used, allowlisted or in the baseline", () => {
    expect(keepCriterionErrors(base)).toEqual([]);
  });

  test("a new export with no client import fails; a client import makes it pass", () => {
    const added = { ...base, exports: [...base.exports, "d"] };
    expect(keepCriterionErrors(added)).toEqual([
      "packages/core/src/index.ts exports d with no client import and no packages/core/test/keep-criterion/allowlist.txt line " +
        "(import it from a client, document it under docs/extending/ and add a line, or stop exporting it; never add it to packages/core/test/keep-criterion/baseline.txt)",
    ]);
    expect(keepCriterionErrors({ ...added, used: new Set(["a", "d"]) })).toEqual([]);
  });

  test("a baseline name that a client now imports fails (the baseline only shrinks)", () => {
    expect(keepCriterionErrors({ ...base, used: new Set(["a", "c"]) })).toEqual([
      "packages/core/test/keep-criterion/baseline.txt: c is now imported by a client (remove the line)",
    ]);
  });

  test("a baseline name the entry no longer exports is a stale entry", () => {
    expect(keepCriterionErrors({ ...base, exports: ["a", "b"] })).toEqual([
      "packages/core/test/keep-criterion/baseline.txt: c is no longer exported by packages/core/src/index.ts (remove the line)",
    ]);
  });

  test("an allowlisted name that a client now imports fails", () => {
    expect(keepCriterionErrors({ ...base, used: new Set(["a", "b"]) })).toEqual([
      "packages/core/test/keep-criterion/allowlist.txt: b is now imported by a client (remove the line)",
    ]);
  });

  test("an allowlisted name the entry no longer exports is a stale entry", () => {
    expect(keepCriterionErrors({ ...base, exports: ["a", "c"] })).toEqual([
      "packages/core/test/keep-criterion/allowlist.txt: b is no longer exported by packages/core/src/index.ts (remove the line)",
    ]);
  });

  test("an allowlist page must resolve inside docs/extending/", () => {
    for (const outside of ["docs/extending/../../README.md", "docs/manual/x.md", "/docs/extending/index.md", "docs/extendingx/a.md"]) {
      expect(keepCriterionErrors({ ...base, allowlist: new Map([["b", outside]]), pageText: () => "b" })).toEqual([
        `packages/core/test/keep-criterion/allowlist.txt: b names a page outside docs/extending/: ${outside}`,
      ]);
    }
    expect(keepCriterionErrors({ ...base, allowlist: new Map([["b", "docs/extending/examples/../library-usage.md"]]) })).toEqual([]);
  });

  test("an allowlist page must exist and name the symbol as a whole word", () => {
    expect(keepCriterionErrors({ ...base, pageText: () => undefined })).toEqual([
      `packages/core/test/keep-criterion/allowlist.txt: b names a page that does not exist: ${page}`,
    ]);
    expect(keepCriterionErrors({ ...base, pageText: () => "only `bb` and `ab_c` here" })).toEqual([
      `packages/core/test/keep-criterion/allowlist.txt: b is not named in its page ${page}`,
    ]);
  });

  test("a name in both lists fails", () => {
    expect(keepCriterionErrors({ ...base, baseline: ["b", "c"] })).toEqual([
      "packages/core/test/keep-criterion/allowlist.txt and packages/core/test/keep-criterion/baseline.txt both list b (keep one)",
    ]);
  });

  test("an allowlist name listed twice is an error, even with two different pages", () => {
    const { allowlist, errors } = parseAllowlist([
      "activePath docs/extending/index.md",
      "activePath docs/extending/library-usage.md",
      "not a line",
    ]);
    expect(errors).toEqual([
      "packages/core/test/keep-criterion/allowlist.txt:2 lists activePath a second time (keep one line)",
      'packages/core/test/keep-criterion/allowlist.txt:3 is not "<name> <page>": not a line',
    ]);
    expect([...allowlist]).toEqual([["activePath", "docs/extending/index.md"]]);
  });

  test("pageNames matches whole identifier words only, a mention inside a code block included", () => {
    expect(pageNames('```ts\nimport { activePath } from "@moh/core";\n```', "activePath")).toBe(true);
    expect(pageNames("use `activePath(events)`", "activePath")).toBe(true);
    expect(pageNames("activePath", "activePath")).toBe(true);
    expect(pageNames("SessionConfig.mpm opts in", "SessionConfig")).toBe(true);
    expect(pageNames("activePathX and xactivePath and activePath_ and $activePath", "activePath")).toBe(false);
  });

  test("listOrderErrors names the first out-of-place lines, not the whole list", () => {
    expect(listOrderErrors("l.txt", ["a", "b", "c"])).toEqual([]);
    expect(listOrderErrors("l.txt", ["a", "c", "b", "d", "d"])).toEqual([
      "l.txt:3 is out of order (sorts before line 2): b",
      "l.txt:5 duplicates an earlier line: d",
    ]);
    expect(listOrderErrors("l.txt", ["z", "y", "x", "w", "v", "u", "t"])).toHaveLength(5);
  });
});
