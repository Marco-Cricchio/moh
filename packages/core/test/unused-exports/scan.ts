// Unused-export scanner for the repo-wide ratchet (#1397).
//
// Builds one TypeScript program over every source file of the repo (all
// packages with their tests and scripts, scripts/, the runnable examples
// under docs/extending/examples/), then, for each declaration exported by a
// `packages/*/src` file (packages/extension excluded), records the other
// files that use it. A use is resolved by the checker, never by text:
// static and type-only imports used in code or types, `import("./x").T`
// types, namespace members (`ns.x`, `ns["x"]`), destructured dynamic imports
// (`const { x } = await import("./x")`), JSX. Imports go through every
// re-export to the declaration, so a use through a barrel counts for the
// declaration. A re-export alone (`export { x } from`, `export *`, an
// `import` that is only re-exported, a package entry included) is not a
// use: the entry's names are locked by #1388 and judged by #1396.
//
// Identity: `<repo-relative file> <exported name>`. The same name exported
// by two files is two entries; overloads and merged declarations are one
// symbol, so one entry per exported name.
//
// The files are the repo's, not the disk's: `git ls-files --cached --others
// --exclude-standard` (tracked files plus new files that are not ignored),
// so a git-ignored local file never counts as a user and a local run
// matches CI; a new file not yet added to the index still counts.
//
// Known limits:
// - Several names of one symbol share one set of uses (`export { a as b,
//   a as c }`, or `default` plus a name): when one name is used the others
//   count as used too, even if nobody uses them. Today this happens only
//   for `default` in jev-guard/src/index.ts and team/src/index.ts.
// - `export =` produces no entry, neither used nor unused (no scoped file
//   uses it today).
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

export const BASELINE_FILE = "packages/core/test/unused-exports/baseline.txt";
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const IN_SCOPE = /^packages\/(?!extension\/)[^/]+\/src\/.+\.(ts|tsx|mts|cts)$/;

export type ExportInfo = {
  readonly file: string;
  readonly name: string;
  readonly line: number;
  /** Repo-relative files, other than the declaring one, that use the declaration (sorted). */
  readonly usedBy: readonly string[];
};

// Every source file of the repo, tracked or new and not ignored; paths under
// node_modules or a dot-directory (.claude worktrees) are skipped, and so is
// a tracked file deleted from the working tree.
function repoFiles(root: string): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = new Set<string>();
  for (const path of listed.split("\0")) {
    if (!SOURCE.test(path) || path.split("/").some((part) => part === "node_modules" || part.startsWith("."))) continue;
    const file = join(root, path);
    if (existsSync(file)) files.add(file);
  }
  return [...files].sort();
}

// The identifier names an import or re-export, not a use.
function isPlumbing(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportEqualsDeclaration(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isExportAssignment(parent)
  );
}

/** Keyed by `<file> <name>`: every name a scoped file exports from its own declarations. */
export function scanExports(repoRoot: string): Map<string, ExportInfo> {
  // The real path, so a root given through a symlink (/var -> /private/var)
  // still contains the files the compiler resolves.
  const root = realpathSync(repoRoot);
  const rel = (file: string) => relative(root, file).split(sep).join("/");
  const program = ts.createProgram(repoFiles(root), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    strict: true,
    noEmit: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const resolve = (symbol: ts.Symbol): ts.Symbol =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const ours = program
    .getSourceFiles()
    .filter((source) => !rel(source.fileName).startsWith("..") && !source.fileName.includes("/node_modules/"));

  // Exported declarations, by symbol (several names may share one symbol).
  const declared = new Map<ts.Symbol, { file: string; name: string; line: number }[]>();
  for (const source of ours) {
    const file = rel(source.fileName);
    if (!IN_SCOPE.test(file) || source.isDeclarationFile) continue;
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (moduleSymbol === undefined) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol = resolve(exported);
      const own = symbol.declarations?.find((declaration) => declaration.getSourceFile() === source);
      if (own === undefined) continue; // re-exported from another file
      const line = source.getLineAndCharacterOfPosition(own.getStart(source)).line + 1;
      const names = declared.get(symbol) ?? [];
      names.push({ file, name: exported.getName(), line });
      declared.set(symbol, names);
    }
  }

  const users = new Map<ts.Symbol, Set<string>>();
  for (const source of ours) {
    const file = rel(source.fileName);
    const visit = (node: ts.Node): void => {
      const element = ts.isStringLiteral(node) && ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node;
      if ((ts.isIdentifier(node) || element) && !isPlumbing(node)) {
        const parent = node.parent;
        let symbol: ts.Symbol | undefined;
        if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
          symbol = checker.getShorthandAssignmentValueSymbol(parent);
        } else if (ts.isBindingElement(parent) && ts.isObjectBindingPattern(parent.parent) && (parent.propertyName ?? parent.name) === node && ts.isIdentifier(node)) {
          symbol = checker.getTypeAtLocation(parent.parent).getProperty(node.text);
        } else {
          symbol = checker.getSymbolAtLocation(node);
        }
        if (symbol !== undefined) {
          for (const candidate of new Set([symbol, resolve(symbol), checker.getExportSymbolOfSymbol(symbol)])) {
            if (!declared.has(candidate)) continue;
            const set = users.get(candidate) ?? new Set<string>();
            set.add(file);
            users.set(candidate, set);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const out = new Map<string, ExportInfo>();
  for (const [symbol, names] of declared) {
    for (const { file, name, line } of names) {
      const usedBy = [...(users.get(symbol) ?? [])].filter((user) => user !== file).sort();
      out.set(`${file} ${name}`, { file, name, line, usedBy });
    }
  }
  return out;
}

/** The exported names nobody uses outside their own file, as sorted baseline lines. */
export function unusedExports(exports: ReadonlyMap<string, ExportInfo>): string[] {
  return [...exports].filter(([, info]) => info.usedBy.length === 0).map(([key]) => key).sort();
}

// Baseline lines: `<file> <name>`, sorted, one per line, no blank line. The
// file ends with one newline. Every bad line is reported with its number.
export function parseBaseline(text: string): { entries: Map<string, number>; errors: string[] } {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const entries = new Map<string, number>();
  const errors: string[] = [];
  let previous: string | undefined;
  lines.forEach((line, i) => {
    const at = `${BASELINE_FILE}:${i + 1}`;
    if (line === "") {
      errors.push(`${at} is a blank line (remove it)`);
    } else if (!/^\S+ \S+$/.test(line)) {
      errors.push(`${at} is not "<file> <name>": ${line}`);
    } else if (entries.has(line)) {
      errors.push(`${at} duplicates line ${entries.get(line)}: ${line}`);
    } else {
      if (previous !== undefined && line < previous) errors.push(`${at} is out of order (sorts before the line above it): ${line}`);
      entries.set(line, i + 1);
      previous = line;
    }
  });
  return { entries, errors };
}

// The ratchet. An export nobody uses outside its own file must be in the
// baseline; a baseline line must name an export that still exists and is
// still unused, so the baseline can only shrink.
export function ratchetErrors(exports: ReadonlyMap<string, ExportInfo>, baseline: ReadonlyMap<string, number>): string[] {
  const errors: string[] = [];
  for (const key of unusedExports(exports)) {
    if (baseline.has(key)) continue;
    const { file, name, line } = exports.get(key)!;
    errors.push(
      `${file}:${line} exports ${name}, which no other file in the repo uses (source, tests, scripts and examples included). ` +
        `Under the existing public-surface criterion (ADR-0004; ablation tracking #1378, #1397) an export needs a caller: ` +
        `in ${file}, remove \`export\` from ${name} (and delete it if its own file does not use it either), ` +
        `or use it from the file that needs it. Never add it to ${BASELINE_FILE}.`,
    );
  }
  for (const [key, lineNumber] of baseline) {
    const info = exports.get(key);
    const [file, name] = key.split(" ");
    if (info === undefined) {
      errors.push(`${BASELINE_FILE}:${lineNumber}: ${file} no longer exports ${name} (remove the line from ${BASELINE_FILE})`);
    } else if (info.usedBy.length > 0) {
      errors.push(
        `${BASELINE_FILE}:${lineNumber}: ${name} (${file}) is now used by ${info.usedBy[0]}` +
          `${info.usedBy.length > 1 ? ` and ${info.usedBy.length - 1} more` : ""} (remove the line from ${BASELINE_FILE}; it only shrinks)`,
      );
    }
  }
  return errors;
}
