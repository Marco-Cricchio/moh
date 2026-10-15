// Package-entry surface lock (#1388). Every name exported by an entry of
// @moh/core, @moh/tui and @moh/extension (the `exports` map subpaths of each
// package.json) is committed in entry-surface/<package>[.<subpath>].txt, sorted,
// one name per line. Adding or removing an export fails here until the list is
// updated in the same change, so a surface change is a visible diff line.
// This test does not judge whether an export is justified (#1396).
//
// Regenerate after an intended change:
//   MOH_UPDATE_ENTRY_SURFACE=1 bun test packages/core/test/entry-surface.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const PACKAGES = join(import.meta.dir, "..", "..");
const LISTS = join(import.meta.dir, "entry-surface");
const UPDATE = process.env.MOH_UPDATE_ENTRY_SURFACE === "1";

const SCOPES = ["core", "tui", "extension"] as const;

type Entry = { readonly key: string; readonly file: string; readonly list: string };

function entriesOf(pkg: string): Entry[] {
  const manifest = JSON.parse(readFileSync(join(PACKAGES, pkg, "package.json"), "utf8")) as {
    exports: Record<string, string>;
  };
  return Object.entries(manifest.exports).map(([sub, target]) => {
    const suffix = sub === "." ? "" : `.${sub.replace(/^\.\//, "").replaceAll("/", "-")}`;
    return {
      key: sub === "." ? `@moh/${pkg}` : `@moh/${pkg}/${sub.replace(/^\.\//, "")}`,
      file: join(PACKAGES, pkg, target),
      list: join(LISTS, `${pkg}${suffix}.txt`),
    };
  });
}

function exportedNames(files: readonly string[]): Map<string, string[]> {
  const program = ts.createProgram([...files], {
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
  const out = new Map<string, string[]>();
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (source === undefined) throw new Error(`entry not found: ${file}`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (moduleSymbol === undefined) throw new Error(`entry has no exports: ${file}`);
    const names = checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.getName());
    out.set(file, [...new Set(names)].sort());
  }
  return out;
}

function readList(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
}

const all = SCOPES.flatMap(entriesOf);
const names = exportedNames(all.map((entry) => entry.file));

describe("package entry surface", () => {
  if (UPDATE) {
    test("regenerates the committed lists", () => {
      for (const entry of all) {
        writeFileSync(entry.list, `${names.get(entry.file)?.join("\n") ?? ""}\n`);
      }
    });
    return;
  }

  test("every committed list belongs to an exports-map entry", () => {
    const expected = all.map((entry) => entry.list.slice(LISTS.length + 1)).sort();
    const actual = readdirSync(LISTS).filter((f) => f.endsWith(".txt")).sort();
    expect(actual).toEqual(expected);
  });

  for (const entry of all) {
    test(`${entry.key} exports match ${entry.list.slice(LISTS.length + 1)}`, () => {
      expect(existsSync(entry.list)).toBe(true);
      const expected = readList(entry.list);
      const actual = names.get(entry.file) ?? [];
      const added = actual.filter((name) => !expected.includes(name));
      const removed = expected.filter((name) => !actual.includes(name));
      if (added.length > 0 || removed.length > 0) {
        const reminder = entry.key === "@moh/extension"
          ? "\n@moh/extension additions follow the apiVersion policy (additive-only; bump the minor apiVersion)."
          : "";
        throw new Error(
          `${entry.key} surface changed.\n  added: ${added.join(", ") || "-"}\n  removed: ${removed.join(", ") || "-"}\n` +
            `Update ${entry.list} in the same change (MOH_UPDATE_ENTRY_SURFACE=1 bun test packages/core/test/entry-surface.test.ts).${reminder}`,
        );
      }
      expect(actual).toEqual(expected);
    });
  }
});
