// Repo-wide unused-export ratchet (#1397, tracking #1378). A declaration
// exported by a `packages/*/src` file (packages/extension excluded) must be
// used by some other file of the repo — source, tests, scripts or runnable
// examples — or be listed in unused-exports/baseline.txt as
// `<file> <name>`. The baseline holds the unused exports of the day the
// check landed and can only shrink: a new unused export fails, and so does
// a baseline line whose export is now used outside its file or no longer
// exists. A re-export alone (a barrel or a package entry) is not a use; see
// unused-exports/scan.ts for what counts.
//
// The list is sorted, one entry per line, with no blank line.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BASELINE_FILE, type ExportInfo, parseBaseline, ratchetErrors, scanExports, unusedExports } from "./unused-exports/scan";

const ROOT = join(import.meta.dir, "..", "..", "..");

describe("unused-export ratchet", () => {
  // One checker pass over the whole repo: about 6 s on a quiet machine.
  test("every export unused outside its file is in the shrinking baseline", () => {
    const { entries, errors } = parseBaseline(readFileSync(join(ROOT, BASELINE_FILE), "utf8"));
    errors.push(...ratchetErrors(scanExports(ROOT), entries));
    if (errors.length > 0) throw new Error(`unused-export ratchet (#1397):\n  ${errors.join("\n  ")}`);
  }, 120_000);
});

describe("unused-export scanner", () => {
  // A miniature repo: every form of use, and the non-uses.
  const files: Record<string, string> = {
    "packages/p/src/a.ts": [
      "export function unused() {}",
      "export function localOnly() {}",
      "localOnly();",
      "export function usedByTest() {}",
      "export const viaScript = 1;",
      "export const viaExample = 1;",
      "export const viaNamespace = 1;",
      "export const viaElement = 1;",
      "export const viaDynamic = 1;",
      "export type ViaImportType = string;",
      "export interface ViaTypeImport { a: 1 }",
      "export const viaBarrel = 1;",
      "export const onlyReexported = 1;",
      "export const onlyImported = 1;",
      "export const viaShorthand = 1;",
      "export function Overloaded(a: string): string;",
      "export function Overloaded(a: number): number;",
      "export function Overloaded(a: unknown) { return a; }",
      "export interface Merged { a: 1 }",
      "export interface Merged { b: 2 }",
      "export const Dual = 1;",
      "export type Dual = number;",
      "const hidden = 1;",
      "export { hidden as shown };",
      "export default function main() {}",
    ].join("\n"),
    "packages/p/src/b.ts": "export const Merged = 1;\nexport function Overloaded() {}\n",
    "packages/p/src/barrel.ts": 'export { onlyReexported, viaBarrel } from "./a";\nexport * from "./a";\n',
    "packages/p/src/index.ts": 'import { onlyImported } from "./a";\nexport { onlyImported };\nexport { onlyReexported } from "./a";\n',
    "packages/p/src/c.ts": [
      'import { viaBarrel } from "./barrel";',
      'import * as ns from "./a";',
      'import type { ViaTypeImport } from "./a";',
      'import { viaShorthand } from "./a";',
      "viaBarrel;",
      "ns.viaNamespace;",
      'ns["viaElement"];',
      'const { viaDynamic } = await import("./a");',
      "viaDynamic;",
      'type T = import("./a").ViaImportType;',
      "let v: ViaTypeImport | T | undefined;",
      "v;",
      "const o = { viaShorthand };",
      "o;",
    ].join("\n"),
    "packages/p/test/a.test.ts": 'import { usedByTest } from "../src/a";\nusedByTest();\n',
    "scripts/s.ts": 'import { viaScript } from "../packages/p/src/a";\nviaScript;\n',
    "docs/extending/examples/e.mjs": 'import { viaExample } from "../../../packages/p/src/a.ts";\nviaExample;\n',
    "packages/extension/src/x.ts": "export const extensionOnly = 1;\n",
    // Skipped: a dot-directory (a worktree copy) and node_modules.
    ".claude/worktrees/w/packages/p/src/u.ts": 'import { unused } from "../../../../../../packages/p/src/a";\nunused();\n',
    "packages/p/node_modules/q/index.ts": 'import { unused } from "../../src/a";\nunused();\n',
  };

  test("lists exactly the exports no other file uses; imports and re-exports alone do not count", () => {
    const root = mkdtempSync(join(tmpdir(), "moh-unused-exports-"));
    try {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      const exports = scanExports(root);
      expect(unusedExports(exports)).toEqual([
        "packages/p/src/a.ts Dual",
        "packages/p/src/a.ts Merged",
        "packages/p/src/a.ts Overloaded",
        "packages/p/src/a.ts default",
        "packages/p/src/a.ts localOnly",
        "packages/p/src/a.ts onlyImported",
        "packages/p/src/a.ts onlyReexported",
        "packages/p/src/a.ts shown",
        "packages/p/src/a.ts unused",
        "packages/p/src/b.ts Merged",
        "packages/p/src/b.ts Overloaded",
      ]);
      expect(exports.get("packages/p/src/a.ts viaBarrel")?.usedBy).toEqual(["packages/p/src/c.ts"]);
      expect(exports.get("packages/p/src/a.ts usedByTest")?.usedBy).toEqual(["packages/p/test/a.test.ts"]);
      expect(exports.get("packages/p/src/a.ts viaScript")?.usedBy).toEqual(["scripts/s.ts"]);
      expect(exports.get("packages/p/src/a.ts viaExample")?.usedBy).toEqual(["docs/extending/examples/e.mjs"]);
      expect(exports.get("packages/p/src/a.ts Merged")?.line).toBe(19);
      expect([...exports.keys()].some((key) => key.startsWith("packages/extension/"))).toBe(false);
      expect([...exports.keys()].some((key) => key.startsWith("packages/p/src/barrel.ts") || key.startsWith("packages/p/src/index.ts"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("ratchet rules", () => {
  const info = (file: string, name: string, line: number, usedBy: string[] = []): [string, ExportInfo] => [
    `${file} ${name}`,
    { file, name, line, usedBy },
  ];
  const exports = new Map([
    info("packages/p/src/a.ts", "used", 1, ["packages/p/test/a.test.ts"]),
    info("packages/p/src/a.ts", "old", 2),
  ]);
  const baseline = new Map([["packages/p/src/a.ts old", 1]]);

  test("passes when every unused export is in the baseline", () => {
    expect(ratchetErrors(exports, baseline)).toEqual([]);
  });

  test("a new unused export fails and names the source file and line; a use elsewhere makes it pass", () => {
    const added = new Map([...exports, info("packages/q/src/b.ts", "helper", 7)]);
    expect(ratchetErrors(added, baseline)).toEqual([
      "packages/q/src/b.ts:7 exports helper, which no other file in the repo uses (source, tests, scripts and examples included). " +
        "Under the existing public-surface criterion (ADR-0004; ablation tracking #1378, #1397) an export needs a caller: " +
        "in packages/q/src/b.ts, remove `export` from helper (and delete it if its own file does not use it either), " +
        "or use it from the file that needs it. Never add it to packages/core/test/unused-exports/baseline.txt.",
    ]);
    const used = new Map([...exports, info("packages/q/src/b.ts", "helper", 7, ["packages/q/src/c.ts"])]);
    expect(ratchetErrors(used, baseline)).toEqual([]);
  });

  test("a baseline name now used outside its file fails (the baseline only shrinks)", () => {
    const now = new Map([...exports, info("packages/p/src/a.ts", "old", 2, ["packages/q/src/c.ts", "packages/q/test/c.test.ts"])]);
    expect(ratchetErrors(now, baseline)).toEqual([
      "packages/core/test/unused-exports/baseline.txt:1: old (packages/p/src/a.ts) is now used by packages/q/src/c.ts and 1 more " +
        "(remove the line from packages/core/test/unused-exports/baseline.txt; it only shrinks)",
    ]);
  });

  test("a baseline name that is gone or no longer exported is a stale line", () => {
    const gone = new Map([info("packages/p/src/a.ts", "used", 1, ["packages/p/test/a.test.ts"])]);
    expect(ratchetErrors(gone, baseline)).toEqual([
      "packages/core/test/unused-exports/baseline.txt:1: packages/p/src/a.ts no longer exports old " +
        "(remove the line from packages/core/test/unused-exports/baseline.txt)",
    ]);
  });

  test("the same name in two files is two entries", () => {
    const twice = new Map([...exports, info("packages/q/src/b.ts", "old", 3)]);
    expect(ratchetErrors(twice, baseline)).toHaveLength(1);
    expect(ratchetErrors(twice, new Map([...baseline, ["packages/q/src/b.ts old", 2]]))).toEqual([]);
  });
});

describe("baseline format", () => {
  test("a sorted list ending in one newline parses with line numbers", () => {
    const { entries, errors } = parseBaseline("a.ts x\nb.ts y\n");
    expect(errors).toEqual([]);
    expect([...entries]).toEqual([
      ["a.ts x", 1],
      ["b.ts y", 2],
    ]);
    expect(parseBaseline("")).toEqual({ entries: new Map(), errors: [] });
  });

  test("blank, malformed, duplicate and out-of-order lines fail with their line number", () => {
    expect(parseBaseline("a.ts x\n\nb.ts y\nnot-a-pair\nb.ts y\na.ts z\n\n").errors).toEqual([
      "packages/core/test/unused-exports/baseline.txt:2 is a blank line (remove it)",
      'packages/core/test/unused-exports/baseline.txt:4 is not "<file> <name>": not-a-pair',
      "packages/core/test/unused-exports/baseline.txt:5 duplicates line 3: b.ts y",
      "packages/core/test/unused-exports/baseline.txt:6 is out of order (sorts before the line above it): a.ts z",
      "packages/core/test/unused-exports/baseline.txt:7 is a blank line (remove it)",
    ]);
  });
});
