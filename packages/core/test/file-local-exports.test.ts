// File-local export inventory (#1415, tracking #1378; the "expand" step of
// S2.4, before the per-package contractions #1416–#1421 and the closeout
// #1422). For every package, file-local-exports/inventory/<pkg>.txt and
// file-local-exports/exclusions/<pkg>.txt together are exactly the package's
// rows of unused-exports/baseline.txt (#1397), with no overlap. An inventory
// row is a declaration used only inside its own file that may later lose
// `export`; an exclusion row must keep it, for a category and a reason that
// are checked here (see file-local-exports/scan.ts for the categories).
//
// A package's contraction removes its rows from its inventory file and from
// the baseline in one change; no other package's block is touched, so each
// package turns green on its own. This change removes no `export`.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BASELINE_FILE, type ExportInfo, parseBaseline, scanExports } from "./unused-exports/scan";
import {
  DEAD_REASON,
  type Facts,
  INVENTORY_DIR,
  categoryOf,
  inventoryErrors,
  packageOf,
  parseExclusions,
  parseInventory,
  reasonText,
  scanFacts,
  witnesses,
} from "./file-local-exports/scan";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PACKAGES = ["cli", "core", "evals", "jev-guard", "team", "tui"];

describe("file-local export inventory", () => {
  // One G4 pass and one facts pass over the whole repo: about 10 s together.
  let scanned: { exports: Map<string, ExportInfo>; facts: Map<string, Facts> } | undefined;
  const scan = () => {
    if (scanned === undefined) {
      const exports = scanExports(ROOT);
      scanned = { exports, facts: scanFacts(ROOT, exports) };
    }
    return scanned;
  };
  const baseline = parseBaseline(readFileSync(join(ROOT, BASELINE_FILE), "utf8"));

  test("the baseline holds no package outside the inventory scope", () => {
    expect(baseline.errors).toEqual([]);
    const outside = [...baseline.entries.keys()].filter((key) => !PACKAGES.includes(packageOf(key)));
    expect(outside).toEqual([]);
  });

  for (const pkg of PACKAGES) {
    test(`${pkg}: inventory and exclusions partition its baseline rows, and every row still holds`, () => {
      const read = (dir: string) => {
        const path = `${INVENTORY_DIR}/${dir}/${pkg}.txt`;
        return { path, text: existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), "utf8") : "" };
      };
      const inventory = read("inventory");
      const exclusions = read("exclusions");
      const rows = new Set([...baseline.entries.keys()].filter((key) => packageOf(key) === pkg));
      const { exports, facts } = scan();
      const errors = inventoryErrors(pkg, rows, parseInventory(inventory.text, inventory.path), parseExclusions(exclusions.text, exclusions.path), exports, facts);
      if (errors.length > 0) throw new Error(`file-local export inventory (#1415), package ${pkg}:\n  ${errors.join("\n  ")}`);
    }, 120_000);
  }
});

describe("file-local export scanner", () => {
  // A miniature repo: one row of every category, and rows that stay local.
  const files: Record<string, string> = {
    "packages/p/package.json": JSON.stringify({ name: "@moh/p", exports: { ".": "./src/index.ts" } }),
    "packages/p/src/index.ts": 'export { atEntry } from "./a";\n',
    "packages/p/src/a.ts": [
      "export function atEntry() {}",
      "export const reexported = 1;",
      "export const Documented = 1;",
      "export const dead = 1;",
      "export const keepsLocal = 1;",
      "export interface Named { a: 1 }",
      "export type Expanded = { a: 1 } | { b: 2 };",
      "export function make(): Named { return { a: 1 }; }",
      "export function makeExpanded(): Expanded { return { a: 1 }; }",
      "export class Local {}",
      "keepsLocal;",
      "Documented;",
      "reexported;",
      "new Local();",
    ].join("\n"),
    "packages/p/src/barrel.ts": 'export { reexported } from "./a";\n',
    // `K.m` and `K.n` have inferred types: Named cannot be written back
    // without its export, Expanded is expanded structurally.
    "packages/p/src/b.ts": [
      'import { make, makeExpanded } from "./a";',
      "export class K {",
      "  m() { return make(); }",
      "  n() { return makeExpanded(); }",
      "  #hidden() { return make(); }",
      "  private q() { return make(); }",
      "}",
    ].join("\n"),
    // Dynamic access that G4 and the checker cannot follow: a destructured
    // `require`, a `require` behind a cast, an `import()` read behind a cast.
    // A plain `(await import(…)).x` is resolved by the checker, so G4 already
    // counts it as a use; `notRequired` shares the module but is never read.
    "packages/p/src/dyn.ts": [
      "export function viaRequire() {}",
      "export function viaCast() {}",
      "export function viaImportCast() {}",
      "export function viaImport() {}",
      "export function notRequired() {}",
      "viaRequire; viaCast; viaImportCast; viaImport; notRequired;",
    ].join("\n"),
    "packages/p/test/dyn.test.ts": [
      'const { viaRequire } = require("../src/dyn");',
      'const { viaCast } = require("../src/dyn") as { viaCast(): void };',
      'const castRead = ((await import("../src/dyn")) as { viaImportCast(): void }).viaImportCast;',
      'const plainRead = (await import("../src/dyn")).viaImport;',
      'const { other } = require("../src/dyn") as { other?: () => void };',
      "viaRequire(); viaCast(); castRead(); plainRead(); other?.();",
    ].join("\n"),
    "packages/p/test/k.test.ts": 'import { K } from "../src/b";\nimport { make, makeExpanded } from "../src/a";\nnew K();\nmake();\nmakeExpanded();\n',
    "docs/extending/guide.md": "Use `Documented` from the library.\n",
    "docs/internal/notes.md": "dead keepsLocal Named\n",
    "packages/extension/src/x.ts": "export const extensionOnly = 1;\n",
  };

  test("classifies entry, barrel, signature, dead, docs and local rows; the first matching reason wins", () => {
    const root = mkdtempSync(join(tmpdir(), "moh-file-local-"));
    try {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["add", "-A"], { cwd: root });
      const exports = scanExports(root);
      const facts = scanFacts(root, exports);
      const categories = Object.fromEntries([...facts].map(([key, fact]) => [key, categoryOf(fact)]));
      expect(categories).toEqual({
        "packages/p/src/a.ts Documented": "docs",
        "packages/p/src/a.ts Expanded": "local",
        "packages/p/src/a.ts Local": "local",
        "packages/p/src/a.ts Named": "signature",
        "packages/p/src/a.ts atEntry": "entry",
        "packages/p/src/a.ts dead": "dead",
        "packages/p/src/a.ts keepsLocal": "local",
        "packages/p/src/a.ts reexported": "barrel",
        "packages/p/src/dyn.ts notRequired": "local",
        "packages/p/src/dyn.ts viaCast": "dynamic",
        "packages/p/src/dyn.ts viaImportCast": "dynamic",
        "packages/p/src/dyn.ts viaRequire": "dynamic",
      });
      expect(facts.get("packages/p/src/dyn.ts viaRequire")?.dynamic).toEqual(['packages/p/test/dyn.test.ts (require("../src/dyn"))']);
      expect(facts.get("packages/p/src/dyn.ts viaCast")?.dynamic).toEqual(['packages/p/test/dyn.test.ts (require("../src/dyn"))']);
      expect(facts.get("packages/p/src/dyn.ts viaImportCast")?.dynamic).toEqual(['packages/p/test/dyn.test.ts (import("../src/dyn"))']);
      expect(facts.get("packages/p/src/dyn.ts notRequired")?.dynamic).toEqual([]);
      // The checker follows `(await import(…)).viaImport`: G4 counts it, so it is no candidate.
      expect(exports.get("packages/p/src/dyn.ts viaImport")?.usedBy).toEqual(["packages/p/test/dyn.test.ts"]);
      expect(facts.has("packages/p/src/dyn.ts viaImport")).toBe(false);
      expect(facts.get("packages/p/src/a.ts atEntry")?.entries).toEqual(["@moh/p"]);
      expect(facts.get("packages/p/src/a.ts reexported")?.reexportedBy).toEqual(["packages/p/src/barrel.ts"]);
      // The private and #private members are not public; only K.m names Named.
      expect(facts.get("packages/p/src/a.ts Named")?.signature).toEqual(["K.m"]);
      expect(facts.get("packages/p/src/a.ts Documented")?.docs).toEqual(["docs/extending/guide.md"]);
      expect(facts.get("packages/p/src/a.ts Local")?.kind).toBe("Class");
      expect(facts.get("packages/p/src/a.ts keepsLocal")?.kind).toBe("Variable");
      expect(facts.get("packages/p/src/a.ts dead")?.ownRefs).toBe(0);
      expect(facts.get("packages/p/src/a.ts keepsLocal")?.ownRefs).toBe(1);
      // Not scanned: packages/extension, and a row used by another file (G4's rule).
      expect([...facts.keys()].some((key) => key.startsWith("packages/extension/"))).toBe(false);
      expect(facts.has("packages/p/src/b.ts K")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("inventory rules", () => {
  const fact = (over: Partial<Facts> = {}): Facts => ({ kind: "Function", ownRefs: 1, entries: [], reexportedBy: [], signature: [], dynamic: [], docs: [], ...over });
  const info = (file: string, name: string, usedBy: string[] = []): [string, ExportInfo] => [`${file} ${name}`, { file, name, line: 1, usedBy }];
  const A = "packages/p/src/a.ts";
  const exports = new Map([info(A, "local"), info(A, "entry"), info(A, "barrel"), info(A, "gone")]);
  const facts = new Map<string, Facts>([
    [`${A} local`, fact()],
    [`${A} entry`, fact({ entries: ["@moh/p"] })],
    [`${A} barrel`, fact({ reexportedBy: ["packages/p/src/barrel.ts"] })],
  ]);
  exports.delete(`${A} gone`);
  const rows = (...names: string[]) => new Set(names.map((name) => `${A} ${name}`));
  const inventory = (text: string) => parseInventory(text, "inv");
  const exclusions = (text: string) => parseExclusions(text, "exc");
  const good = {
    inventory: `${A} local Function\n`,
    exclusions: `${A} barrel barrel re-exported in packages/p/src/barrel.ts\n${A} entry entry exported by @moh/p\n`,
  };
  const run = (baseline: Set<string>, inv: string, exc: string, ex = exports, fa = facts) =>
    inventoryErrors("p", baseline, inventory(inv), exclusions(exc), ex, fa);

  test("passes when inventory and exclusions partition the baseline and every row holds", () => {
    expect(run(rows("local", "entry", "barrel"), good.inventory, good.exclusions)).toEqual([]);
  });

  test("a baseline row in neither file fails; a row in both fails; a row not in the baseline fails", () => {
    expect(run(rows("local", "entry", "barrel"), "", good.exclusions).join("\n")).toContain("in packages/core/test/unused-exports/baseline.txt but in neither");
    expect(run(rows("local", "entry", "barrel"), `${A} entry Function\n${good.inventory}`, good.exclusions).join("\n")).toContain("is also in");
    expect(run(rows("entry", "barrel"), good.inventory, good.exclusions).join("\n")).toContain("a.ts local is not in packages/core/test/unused-exports/baseline.txt any more");
  });

  test("an inventory row that gained a referent outside its file fails and says to migrate the import", () => {
    const used = new Map([...exports, info(A, "local", ["packages/p/src/c.ts"])]);
    const errors = run(rows("local", "entry", "barrel"), good.inventory, good.exclusions, used, new Map([...facts].filter(([key]) => key !== `${A} local`)));
    expect(errors.join("\n")).toContain("is now used by packages/p/src/c.ts; it is no longer file-local");
  });

  test("an inventory row that became an entry or barrel row must move to the exclusions", () => {
    const entry = new Map(facts).set(`${A} local`, fact({ entries: ["@moh/p"] }));
    expect(run(rows("local", "entry", "barrel"), good.inventory, good.exclusions, exports, entry).join("\n")).toContain("must keep its export (entry:");
  });

  test("an excluded row whose reason no longer holds fails, and so does a reason that omits its witness", () => {
    const flipped = new Map(facts).set(`${A} barrel`, fact());
    expect(run(rows("local", "entry", "barrel"), good.inventory, good.exclusions, exports, flipped).join("\n")).toContain('excluded as "barrel" but the reason no longer holds (it is now file-local');
    const vague = `${A} barrel barrel re-exported somewhere\n${A} entry entry exported by @moh/p\n`;
    expect(run(rows("local", "entry", "barrel"), good.inventory, vague).join("\n")).toContain("the reason for packages/p/src/a.ts barrel must name packages/p/src/barrel.ts");
  });

  test("an inventory row reached dynamically fails; a dynamic exclusion fails when the access it names is gone", () => {
    const reached = new Map(facts).set(`${A} local`, fact({ dynamic: ['packages/p/test/t.test.ts (require("../src/a"))'] }));
    expect(run(rows("local", "entry", "barrel"), good.inventory, good.exclusions, exports, reached).join("\n")).toContain(
      'must keep its export (dynamic: reached dynamically from packages/p/test/t.test.ts (require("../src/a")))',
    );
    const excluded = `${A} barrel barrel re-exported in packages/p/src/barrel.ts\n${A} entry entry exported by @moh/p\n${A} local dynamic reached dynamically from packages/p/test/t.test.ts (require("../src/a"))\n`;
    expect(run(rows("local", "entry", "barrel"), "", excluded, exports, reached)).toEqual([]);
    expect(run(rows("local", "entry", "barrel"), "", excluded).join("\n")).toContain('excluded as "dynamic" but the reason no longer holds (it is now file-local');
    const moved = new Map(facts).set(`${A} local`, fact({ dynamic: ['packages/p/test/u.test.ts (import("../src/a"))'] }));
    expect(run(rows("local", "entry", "barrel"), "", excluded, exports, moved).join("\n")).toContain('must name packages/p/test/u.test.ts (import("../src/a"))');
  });

  test("an inventory row without facts fails instead of passing unchecked", () => {
    const missing = new Map([...facts].filter(([key]) => key !== `${A} local`));
    expect(run(rows("local", "entry", "barrel"), good.inventory, good.exclusions, exports, missing).join("\n")).toContain(
      "inventory/p.txt:1: no facts for packages/p/src/a.ts local (scanner scope mismatch)",
    );
  });

  test("a wrong kind, a vanished export and a row used elsewhere fail", () => {
    expect(run(rows("local", "entry", "barrel"), `${A} local Interface\n`, good.exclusions).join("\n")).toContain("is a Function, not a Interface");
    expect(run(rows("local", "gone", "entry", "barrel"), `${A} gone Function\n${good.inventory}`, good.exclusions).join("\n")).toContain("gone is no longer exported");
  });

  test("categories, witnesses and reasons agree", () => {
    expect(categoryOf(fact({ ownRefs: 0, docs: ["docs/extending/x.md"] }))).toBe("dead");
    expect(categoryOf(fact({ docs: ["docs/extending/x.md"] }))).toBe("docs");
    expect(witnesses("dead", fact())).toEqual([DEAD_REASON]);
    for (const [category, over] of [
      ["entry", { entries: ["@moh/p"] }],
      ["barrel", { reexportedBy: ["packages/p/src/b.ts"] }],
      ["signature", { signature: ["K.m"] }],
      ["dynamic", { dynamic: ['packages/p/test/t.test.ts (require("../src/a"))'] }],
      ["docs", { docs: ["docs/extending/x.md"] }],
      ["dead", { ownRefs: 0 }],
    ] as const) {
      const f = fact(over);
      expect(categoryOf(f)).toBe(category);
      for (const witness of witnesses(category, f)) expect(reasonText(category, f)).toContain(witness);
    }
  });

  test("list format: sorted, no blank, no duplicate, known categories", () => {
    expect(parseInventory("a.ts x Function\nb.ts y Variable\n", "inv").errors).toEqual([]);
    expect(parseInventory("b.ts y Variable\n\na.ts x\na.ts x Function\n", "inv").errors).toEqual([
      "inv:2 is a blank line (remove it)",
      'inv:3 is not "<file> <name> <kind>": a.ts x',
      "inv:4 is out of order (sorts before the line above it): a.ts x Function",
    ]);
    expect(parseExclusions("a.ts x docs because\na.ts x entry again\na.ts z other why\n", "exc").errors).toEqual([
      "exc:2 duplicates line 1: a.ts x",
      "exc:3 has unknown category other (one of entry, barrel, signature, dynamic, dead, docs)",
    ]);
  });
});
