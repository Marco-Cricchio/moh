// File-local export inventory (#1415, tracking #1378). The "expand" half of
// S2.4: before any package drops `export` from a declaration used only in its
// own file (#1416–#1421, closeout #1422), this check freezes which rows of the
// unused-export baseline (#1397) are safe to contract and which are not, and
// why. It changes no export itself.
//
// Per package, `inventory/<pkg>.txt` (`<file> <name> <kind>`) lists the
// contraction candidates and `exclusions/<pkg>.txt`
// (`<file> <name> <category> <reason>`) the baseline rows that must keep their
// `export`. Together they are exactly the package's rows of
// unused-exports/baseline.txt, with no overlap, so a contraction removes the
// same row from its inventory file and from the baseline.
//
// "Use" is G4's (unused-exports/scan.ts, imported, not copied): a row is in
// the baseline when no other file of the repo uses the declaration. This file
// adds the facts G4 does not need, in a second checker pass over the same
// file set (`git ls-files --cached --others --exclude-standard`).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import type { ExportInfo } from "../unused-exports/scan";

export const INVENTORY_DIR = "packages/core/test/file-local-exports";
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const IN_SCOPE = /^packages\/(?!extension\/)[^/]+\/src\/.+\.(ts|tsx|mts|cts)$/;
// Public documentation (rule E2): extension-author docs, the domain glossary,
// the generated manual and its source, the serve protocol.
const DOCS = /^(docs\/extending\/|docs\/manual\/|docs\/serve-protocol\.md$|CONTEXT\.md$|packages\/core\/src\/manual\/)/;
const WORD = /[A-Za-z0-9_$]+/g;

export const CATEGORIES = ["entry", "barrel", "signature", "dynamic", "dead", "docs"] as const;
export type ExclusionCategory = (typeof CATEGORIES)[number];
export type Category = ExclusionCategory | "local";

export type Facts = {
  /** Declaration kind: Function, Variable, Interface, TypeAlias, Class, Enum, … */
  readonly kind: string;
  /** References to the declaration inside its own file, its name aside. */
  readonly ownRefs: number;
  /** Package entries (`@moh/core`, `@moh/tui/bundled-extensions`) that export the declaration. */
  readonly entries: readonly string[];
  /** Other files that re-export the declaration. */
  readonly reexportedBy: readonly string[];
  /** Public members/functions elsewhere whose inferred type names the declaration. */
  readonly signature: readonly string[];
  /**
   * Other files that reach the declaration through `require("<relative>")` or
   * `import("<relative>")` (destructured or a property read), which neither
   * G4 nor `tsc` sees behind a cast: `<file> (require("<specifier>"))`.
   */
  readonly dynamic: readonly string[];
  /** Documentation files that name it as a whole word. */
  readonly docs: readonly string[];
};

function repoFiles(root: string): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = new Set<string>();
  for (const path of listed.split("\0")) {
    if (!SOURCE.test(path) || path.split("/").some((part) => part === "node_modules" || part.startsWith("."))) continue;
    if (existsSync(join(root, path))) files.add(join(root, path));
  }
  return [...files].sort();
}

function docFiles(root: string): { file: string; words: Set<string> }[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out: { file: string; words: Set<string> }[] = [];
  for (const path of listed.split("\0").sort()) {
    if (!DOCS.test(path) || !path.endsWith(".md") || !existsSync(join(root, path))) continue;
    out.push({ file: path, words: new Set(readFileSync(join(root, path), "utf8").match(WORD) ?? []) });
  }
  return out;
}

// The package entries, from every `exports` map: `@moh/<pkg>[/<subpath>]` -> source file.
function entryFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const packages = join(root, "packages");
  if (!existsSync(packages)) return out;
  for (const pkg of readdirSync(packages).sort()) {
    const manifest = join(packages, pkg, "package.json");
    if (!existsSync(manifest)) continue;
    const exportsMap = (JSON.parse(readFileSync(manifest, "utf8")) as { exports?: Record<string, string> }).exports;
    if (exportsMap === undefined) continue;
    for (const [sub, target] of Object.entries(exportsMap)) {
      out.set(sub === "." ? `@moh/${pkg}` : `@moh/${pkg}/${sub.replace(/^\.\//, "")}`, join(packages, pkg, target));
    }
  }
  return out;
}

const KIND_SUFFIX = /Declaration$/;

/** Facts for every export the baseline can hold (the `exports` G4 scanned that nobody uses outside their file). */
export function scanFacts(repoRoot: string, exports: ReadonlyMap<string, ExportInfo>): Map<string, Facts> {
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
  const resolve = (symbol: ts.Symbol): ts.Symbol => (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
  const ours = program
    .getSourceFiles()
    .filter((source) => !rel(source.fileName).startsWith("..") && !source.fileName.includes("/node_modules/"));

  // The candidates: exports G4 found unused outside their file, by declaration symbol.
  const candidates = new Map<ts.Symbol, { file: string; names: string[]; kind: string }>();
  const wanted = (file: string, name: string) => exports.get(`${file} ${name}`)?.usedBy.length === 0;
  for (const source of ours) {
    const file = rel(source.fileName);
    if (!IN_SCOPE.test(file) || source.isDeclarationFile) continue;
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (moduleSymbol === undefined) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol = resolve(exported);
      const own = symbol.declarations?.find((declaration) => declaration.getSourceFile() === source);
      if (own === undefined || !wanted(file, exported.getName())) continue;
      const entry = candidates.get(symbol) ?? { file, names: [], kind: ts.SyntaxKind[own.kind].replace(KIND_SUFFIX, "") };
      entry.names.push(exported.getName());
      candidates.set(symbol, entry);
    }
  }

  // References inside the declaring file (the declaration's own name does not count).
  const ownRefs = new Map<ts.Symbol, number>();
  for (const source of ours) {
    const file = rel(source.fileName);
    if (!IN_SCOPE.test(file) || source.isDeclarationFile) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const plumbing = ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isExportAssignment(parent);
        let symbol: ts.Symbol | undefined;
        if (!plumbing) {
          symbol = ts.isShorthandPropertyAssignment(parent) && parent.name === node
            ? checker.getShorthandAssignmentValueSymbol(parent)
            : checker.getSymbolAtLocation(node);
        }
        if (symbol !== undefined) {
          for (const candidate of new Set([symbol, resolve(symbol), checker.getExportSymbolOfSymbol(symbol)])) {
            const info = candidates.get(candidate);
            if (info === undefined || info.file !== file) continue;
            const isName = (parent as { name?: ts.Node }).name === node && candidate.declarations?.includes(parent as ts.Declaration);
            if (!isName) ownRefs.set(candidate, (ownRefs.get(candidate) ?? 0) + 1);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  // Package entries and other files that re-export a candidate.
  const entries = new Map<ts.Symbol, string[]>();
  const entryPaths = new Set<string>();
  for (const [key, path] of entryFiles(root)) {
    const source = program.getSourceFile(path);
    const moduleSymbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
    if (moduleSymbol === undefined) continue;
    entryPaths.add(path);
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol = resolve(exported);
      if (candidates.has(symbol)) entries.set(symbol, [...new Set([...(entries.get(symbol) ?? []), key])].sort());
    }
  }
  const reexported = new Map<ts.Symbol, string[]>();
  for (const source of ours) {
    const file = rel(source.fileName);
    if (source.isDeclarationFile || entryPaths.has(source.fileName)) continue;
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (moduleSymbol === undefined) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol = resolve(exported);
      const info = candidates.get(symbol);
      if (info === undefined || info.file === file) continue;
      reexported.set(symbol, [...new Set([...(reexported.get(symbol) ?? []), file])].sort());
    }
  }

  // Declarations in one file whose *inferred* type names a candidate of another
  // file: without `export` on the candidate, `--declaration` could not name it
  // (TS4053 and its kin). An explicit annotation in the same file is fine.
  const signature = new Map<ts.Symbol, string[]>();
  const collect = (type: ts.Type, node: ts.Node, found: Set<ts.Symbol>, seen: Set<ts.Type>, depth: number): void => {
    if (seen.has(type) || depth > 6) return;
    seen.add(type);
    // Only a named object type (interface, class, enum) cannot be written back
    // structurally; a type alias is expanded, so it never needs its export.
    for (const argument of type.aliasTypeArguments ?? []) collect(argument, node, found, seen, depth + 1);
    if (type.symbol !== undefined && type.symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class | ts.SymbolFlags.Enum)) {
      found.add(type.symbol);
    }
    if (type.isUnionOrIntersection()) for (const part of type.types) collect(part, node, found, seen, depth + 1);
    if (!(type.flags & ts.TypeFlags.Object)) return;
    const object = type as ts.ObjectType;
    if (object.objectFlags & ts.ObjectFlags.Reference) {
      for (const argument of checker.getTypeArguments(object as ts.TypeReference)) collect(argument, node, found, seen, depth + 1);
    }
    if (type.symbol !== undefined && !(type.symbol.flags & (ts.SymbolFlags.TypeLiteral | ts.SymbolFlags.ObjectLiteral))) return;
    for (const property of checker.getPropertiesOfType(type)) collect(checker.getTypeOfSymbolAtLocation(property, node), node, found, seen, depth + 1);
    for (const callSignature of type.getCallSignatures()) {
      collect(callSignature.getReturnType(), node, found, seen, depth + 1);
      for (const parameter of callSignature.getParameters()) collect(checker.getTypeOfSymbolAtLocation(parameter, node), node, found, seen, depth + 1);
    }
  };
  const note = (file: string, label: string, type: ts.Type, node: ts.Node): void => {
    const found = new Set<ts.Symbol>();
    collect(type, node, found, new Set(), 0);
    for (const symbol of found) {
      const info = candidates.get(symbol);
      if (info === undefined || info.file === file) continue;
      signature.set(symbol, [...new Set([...(signature.get(symbol) ?? []), label])].sort());
    }
  };
  const isPrivate = (member: ts.ClassElement) =>
    (ts.canHaveModifiers(member) && ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) ||
    (member.name !== undefined && ts.isPrivateIdentifier(member.name));
  for (const source of ours) {
    const file = rel(source.fileName);
    if (!IN_SCOPE.test(file) || source.isDeclarationFile) continue;
    for (const statement of source.statements) {
      const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.type === undefined) {
        const signatureOf = checker.getSignatureFromDeclaration(statement);
        if (signatureOf !== undefined) note(file, statement.name.text, signatureOf.getReturnType(), statement);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (declaration.type === undefined && ts.isIdentifier(declaration.name)) {
            note(file, declaration.name.text, checker.getTypeAtLocation(declaration.name), declaration);
          }
        }
      } else if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
        for (const member of statement.members) {
          if (isPrivate(member) || member.name === undefined) continue;
          const label = `${statement.name.text}.${member.name.getText(source)}`;
          if ((ts.isMethodDeclaration(member) || ts.isGetAccessor(member)) && member.type === undefined) {
            const signatureOf = checker.getSignatureFromDeclaration(member);
            if (signatureOf !== undefined) note(file, label, signatureOf.getReturnType(), member);
          } else if (ts.isPropertyDeclaration(member) && member.type === undefined) {
            note(file, label, checker.getTypeAtLocation(member), member);
          }
        }
      }
    }
  }

  // `require("./m")` / `import("./m")` of a candidate's module, destructured
  // (`const { x } = require(…)`, also through `as {…}`) or read as a property
  // (`require(…).x`, `(await import(…)).x`). The module is resolved by the
  // compiler with the program's own options, as G4's imports are.
  const dynamic = new Map<ts.Symbol, string[]>();
  const options = program.getCompilerOptions();
  const wrapped = (node: ts.Node): ts.Node => {
    let outer = node;
    while (
      ts.isParenthesizedExpression(outer.parent) ||
      ts.isAsExpression(outer.parent) ||
      ts.isSatisfiesExpression(outer.parent) ||
      ts.isTypeAssertionExpression(outer.parent) ||
      ts.isNonNullExpression(outer.parent) ||
      ts.isAwaitExpression(outer.parent)
    ) {
      outer = outer.parent;
    }
    return outer;
  };
  const readNames = (call: ts.Node): string[] => {
    const outer = wrapped(call);
    const parent = outer.parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer === outer && ts.isObjectBindingPattern(parent.name)) {
      return parent.name.elements.flatMap((element) => {
        const name = element.propertyName ?? element.name;
        return ts.isIdentifier(name) || ts.isStringLiteral(name) ? [name.text] : [];
      });
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === outer) return [parent.name.text];
    if (ts.isElementAccessExpression(parent) && parent.expression === outer && ts.isStringLiteralLike(parent.argumentExpression)) {
      return [parent.argumentExpression.text];
    }
    return [];
  };
  for (const source of ours) {
    if (source.isDeclarationFile) continue;
    const file = rel(source.fileName);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0]!)) {
        const callee = node.expression.kind === ts.SyntaxKind.ImportKeyword ? "import" : ts.isIdentifier(node.expression) && node.expression.text === "require" ? "require" : undefined;
        const specifier = node.arguments[0].text;
        if (callee !== undefined && specifier.startsWith(".")) {
          const resolved = ts.resolveModuleName(specifier, source.fileName, options, ts.sys).resolvedModule?.resolvedFileName;
          const target = resolved === undefined ? undefined : program.getSourceFile(resolved);
          const moduleSymbol = target === undefined ? undefined : checker.getSymbolAtLocation(target);
          if (moduleSymbol !== undefined) {
            const names = new Set(readNames(node));
            for (const exported of checker.getExportsOfModule(moduleSymbol)) {
              if (!names.has(exported.getName())) continue;
              const symbol = resolve(exported);
              const info = candidates.get(symbol);
              if (info === undefined || info.file === file) continue;
              const witness = `${file} (${callee}("${specifier}"))`;
              dynamic.set(symbol, [...new Set([...(dynamic.get(symbol) ?? []), witness])].sort());
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const docs = docFiles(root);
  const out = new Map<string, Facts>();
  for (const [symbol, info] of candidates) {
    for (const name of info.names) {
      out.set(`${info.file} ${name}`, {
        kind: info.kind,
        ownRefs: ownRefs.get(symbol) ?? 0,
        entries: entries.get(symbol) ?? [],
        reexportedBy: reexported.get(symbol) ?? [],
        signature: signature.get(symbol) ?? [],
        dynamic: dynamic.get(symbol) ?? [],
        docs: docs.filter((doc) => doc.words.has(name)).map((doc) => doc.file),
      });
    }
  }
  return out;
}

/** Why a baseline row may or may not lose `export`; the first matching reason wins. */
export function categoryOf(facts: Facts): Category {
  if (facts.entries.length > 0) return "entry";
  if (facts.reexportedBy.length > 0) return "barrel";
  if (facts.signature.length > 0) return "signature";
  if (facts.dynamic.length > 0) return "dynamic";
  if (facts.ownRefs === 0) return "dead";
  if (facts.docs.length > 0) return "docs";
  return "local";
}

export const DEAD_REASON = "zero references, deleting the declaration is out of S2.4 scope";

/** What a row's reason text must name for the category to be verifiable from the reason alone. */
export function witnesses(category: ExclusionCategory, facts: Facts): string[] {
  switch (category) {
    case "entry":
      return [...facts.entries];
    case "barrel":
      return [...facts.reexportedBy];
    case "signature":
      return [...facts.signature];
    case "dynamic":
      return [...facts.dynamic];
    case "docs":
      return facts.docs.slice(0, 1);
    case "dead":
      return [DEAD_REASON];
  }
}

/** A reason that names exactly the witnesses. */
export function reasonText(category: ExclusionCategory, facts: Facts): string {
  switch (category) {
    case "entry":
      return `exported by the package entry ${facts.entries.join(", ")}`;
    case "barrel":
      return `re-exported, and imported by nobody, in ${facts.reexportedBy.join(", ")}`;
    case "signature":
      return `named by the inferred type of ${facts.signature.join(", ")}`;
    case "dynamic":
      return `reached dynamically from ${facts.dynamic.join(", ")}`;
    case "docs":
      return `named as a whole word in ${facts.docs[0]}${facts.docs.length > 1 ? ` and ${facts.docs.length - 1} more` : ""}`;
    case "dead":
      return DEAD_REASON;
  }
}

export type Inventory = { entries: Map<string, { kind: string; line: number }>; errors: string[] };
export type Exclusions = { entries: Map<string, { category: string; reason: string; line: number }>; errors: string[] };

function lines(text: string): string[] {
  const all = text.split("\n");
  if (all[all.length - 1] === "") all.pop();
  return all;
}

/** `<file> <name> <kind>`, sorted, one per line, no blank line. */
export function parseInventory(text: string, path: string): Inventory {
  const entries = new Map<string, { kind: string; line: number }>();
  const errors: string[] = [];
  let previous: string | undefined;
  lines(text).forEach((line, i) => {
    const at = `${path}:${i + 1}`;
    const match = /^(\S+) (\S+) (\S+)$/.exec(line);
    if (line === "") errors.push(`${at} is a blank line (remove it)`);
    else if (match === null) errors.push(`${at} is not "<file> <name> <kind>": ${line}`);
    else {
      const key = `${match[1]} ${match[2]}`;
      if (entries.has(key)) errors.push(`${at} duplicates line ${entries.get(key)!.line}: ${key}`);
      else entries.set(key, { kind: match[3]!, line: i + 1 });
      if (previous !== undefined && line < previous) errors.push(`${at} is out of order (sorts before the line above it): ${line}`);
      previous = line;
    }
  });
  return { entries, errors };
}

/** `<file> <name> <category> <reason>`, sorted, one per line, no blank line. */
export function parseExclusions(text: string, path: string): Exclusions {
  const entries = new Map<string, { category: string; reason: string; line: number }>();
  const errors: string[] = [];
  let previous: string | undefined;
  lines(text).forEach((line, i) => {
    const at = `${path}:${i + 1}`;
    const match = /^(\S+) (\S+) (\S+) (\S.*)$/.exec(line);
    if (line === "") errors.push(`${at} is a blank line (remove it)`);
    else if (match === null) errors.push(`${at} is not "<file> <name> <category> <reason>": ${line}`);
    else {
      const key = `${match[1]} ${match[2]}`;
      if (!(CATEGORIES as readonly string[]).includes(match[3]!)) errors.push(`${at} has unknown category ${match[3]} (one of ${CATEGORIES.join(", ")})`);
      if (entries.has(key)) errors.push(`${at} duplicates line ${entries.get(key)!.line}: ${key}`);
      else entries.set(key, { category: match[3]!, reason: match[4]!, line: i + 1 });
      if (previous !== undefined && line < previous) errors.push(`${at} is out of order (sorts before the line above it): ${line}`);
      previous = line;
    }
  });
  return { entries, errors };
}

/**
 * The invariant and the per-row checks for one package. `baseline` is the
 * package's rows of unused-exports/baseline.txt; inventory and exclusions
 * partition it exactly.
 */
export function inventoryErrors(
  pkg: string,
  baseline: ReadonlySet<string>,
  inventory: Inventory,
  exclusions: Exclusions,
  exports: ReadonlyMap<string, ExportInfo>,
  facts: ReadonlyMap<string, Facts>,
): string[] {
  const inventoryPath = `${INVENTORY_DIR}/inventory/${pkg}.txt`;
  const exclusionsPath = `${INVENTORY_DIR}/exclusions/${pkg}.txt`;
  const errors = [...inventory.errors, ...exclusions.errors];
  for (const [key, { line }] of inventory.entries) {
    if (exclusions.entries.has(key)) errors.push(`${inventoryPath}:${line}: ${key} is also in ${exclusionsPath} (a row is a candidate or excluded, not both)`);
    if (!baseline.has(key)) {
      errors.push(
        `${inventoryPath}:${line}: ${key} is not in packages/core/test/unused-exports/baseline.txt any more ` +
          `(a contraction removes the row from the inventory and from the baseline together)`,
      );
    }
  }
  for (const [key, { line }] of exclusions.entries) {
    if (!baseline.has(key)) {
      errors.push(
        `${exclusionsPath}:${line}: ${key} is not in packages/core/test/unused-exports/baseline.txt any more ` +
          `(remove the row from the exclusions)`,
      );
    }
  }
  for (const key of [...baseline].sort()) {
    if (!inventory.entries.has(key) && !exclusions.entries.has(key)) {
      errors.push(
        `${key} is in packages/core/test/unused-exports/baseline.txt but in neither ${inventoryPath} nor ${exclusionsPath} ` +
          `(add it to the inventory as "${key} <kind>", or to the exclusions with a category and a reason)`,
      );
    }
  }
  for (const [key, { kind, line }] of inventory.entries) {
    const at = `${inventoryPath}:${line}`;
    const info = exports.get(key);
    const fact = facts.get(key);
    if (info === undefined) {
      errors.push(`${at}: ${key} is no longer exported (remove the row)`);
      continue;
    }
    if (info.usedBy.length > 0) {
      errors.push(
        `${at}: ${key} is now used by ${info.usedBy[0]}${info.usedBy.length > 1 ? ` and ${info.usedBy.length - 1} more` : ""}; ` +
          `it is no longer file-local (remove the row, or migrate that import back so the declaration stays file-local)`,
      );
      continue;
    }
    if (fact === undefined) {
      // Every unused export G4 reports has facts; a gap means the two scans disagree on scope.
      errors.push(`${at}: no facts for ${key} (scanner scope mismatch)`);
      continue;
    }
    const category = categoryOf(fact);
    if (category !== "local") {
      errors.push(`${at}: ${key} must keep its export (${category}: ${reasonText(category, fact)}); move the row to ${exclusionsPath} as "${key} ${category} <reason>"`);
    }
    if (kind !== fact.kind) errors.push(`${at}: ${key} is a ${fact.kind}, not a ${kind}`);
  }
  for (const [key, { category, reason, line }] of exclusions.entries) {
    const at = `${exclusionsPath}:${line}`;
    const fact = facts.get(key);
    if (fact === undefined) {
      if (exports.has(key)) errors.push(`${at}: ${key} is now used outside its file (remove the row; it only shrinks)`);
      else errors.push(`${at}: ${key} is no longer exported (remove the row)`);
      continue;
    }
    const actual = categoryOf(fact);
    if (actual !== category) {
      errors.push(`${at}: ${key} is excluded as "${category}" but the reason no longer holds (it is now ${actual === "local" ? "file-local: move it to the inventory" : `"${actual}"`})`);
      continue;
    }
    if (!(CATEGORIES as readonly string[]).includes(category)) continue;
    for (const witness of witnesses(category as ExclusionCategory, fact)) {
      if (!reason.includes(witness)) errors.push(`${at}: the reason for ${key} must name ${witness}`);
    }
  }
  return errors;
}

export function packageOf(file: string): string {
  return file.split("/")[1]!;
}
