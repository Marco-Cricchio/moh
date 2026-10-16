// Client-use scanner for the @moh/core keep-criterion check (#1396).
// Reads one source file syntactically and returns the @moh/core entry names
// it imports, in every form a client can reach the entry with:
//   import { a, b as c } from "@moh/core"      (also `import type`)
//   export { a, b as c } from "@moh/core"      (re-export from a client)
//   import * as core from "@moh/core"; core.a / core["a"] / const { a } = core
//   const { a } = await import("@moh/core"); (await import("@moh/core")).a
//   const m = await import("@moh/core"); m.a
//   type T = import("@moh/core").A
// A form whose names cannot be read off the syntax (`export * from`, a
// namespace passed around as a value, a dynamic import with no destructuring
// or property access) is returned as a problem, never silently skipped.
import { posix } from "node:path";
import ts from "typescript";

export const CORE_ENTRY = "@moh/core";

export type ClientUses = { readonly names: Set<string>; readonly problems: string[] };

export function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const isCoreSpecifier = (node: ts.Node | undefined): boolean =>
  node !== undefined && ts.isStringLiteralLike(node) && node.text === CORE_ENTRY;

function isCoreImportCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const requireCall = ts.isIdentifier(node.expression) && node.expression.text === "require";
  return (dynamicImport || requireCall) && isCoreSpecifier(node.arguments[0]);
}

function stringKey(node: ts.Expression): string | undefined {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

// Skip the wrappers that leave the module value unchanged.
function outerOf(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAwaitExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isNonNullExpression(current.parent)
  ) {
    current = current.parent;
  }
  return current;
}

// A checker over this one file alone: the binder's scopes resolve local
// identifiers; imports stay unresolved (noResolve, noLib), which is enough
// to tell a namespace binding from a same-named local.
function fileChecker(source: ts.SourceFile): ts.TypeChecker {
  const options: ts.CompilerOptions = { noResolve: true, noLib: true, allowJs: true, types: [], noEmit: true };
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === source.fileName ? source : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === source.fileName,
    readFile: () => undefined,
  };
  return ts.createProgram([source.fileName], options, host).getTypeChecker();
}

export function clientUses(fileName: string, text: string): ClientUses {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const names = new Set<string>();
  const problems: string[] = [];
  // Binding identifiers of the module value (namespace import, import-equals,
  // `const m = await import(…)`); their uses are found by symbol below.
  const namespaces = new Set<ts.Identifier>();
  const where = (node: ts.Node) => `${fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;

  function fromBindingPattern(pattern: ts.ObjectBindingPattern, at: ts.Node): void {
    for (const element of pattern.elements) {
      const key = element.propertyName ?? element.name;
      if (element.dotDotDotToken !== undefined || !(ts.isIdentifier(key) || ts.isStringLiteralLike(key))) {
        problems.push(`${where(at)}: @moh/core destructured with a rest or computed key`);
        continue;
      }
      names.add(key.text);
    }
  }

  // The module value (namespace import, dynamic import, require) is consumed
  // by `consumer`; read the names off it or report it.
  function fromModuleValue(value: ts.Node, at: ts.Node): void {
    const consumer = value.parent;
    if (ts.isPropertyAccessExpression(consumer) && consumer.expression === value && consumer.name.text !== "then") {
      names.add(consumer.name.text);
      return;
    }
    if (ts.isElementAccessExpression(consumer) && consumer.expression === value) {
      const key = stringKey(consumer.argumentExpression);
      if (key !== undefined) {
        names.add(key);
        return;
      }
    }
    if (ts.isVariableDeclaration(consumer) && consumer.initializer === value) {
      if (ts.isObjectBindingPattern(consumer.name)) {
        fromBindingPattern(consumer.name, at);
        return;
      }
      if (ts.isIdentifier(consumer.name)) {
        namespaces.add(consumer.name);
        return;
      }
    }
    problems.push(`${where(at)}: @moh/core module value used without a named property`);
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && isCoreSpecifier(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.name !== undefined) names.add("default");
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) names.add((element.propertyName ?? element.name).text);
      } else if (bindings !== undefined) {
        namespaces.add(bindings.name);
      }
    } else if (ts.isExportDeclaration(node) && isCoreSpecifier(node.moduleSpecifier)) {
      const clause = node.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements) names.add((element.propertyName ?? element.name).text);
      } else {
        problems.push(`${where(node)}: \`export *\` from @moh/core cannot be attributed to names`);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isCoreSpecifier(node.moduleReference.expression)
    ) {
      namespaces.add(node.name);
    } else if (isCoreImportCall(node)) {
      fromModuleValue(outerOf(node), node);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && isCoreSpecifier(node.argument.literal)) {
      let qualifier = node.qualifier;
      while (qualifier !== undefined && ts.isQualifiedName(qualifier)) qualifier = qualifier.left;
      if (qualifier !== undefined) {
        names.add(qualifier.text);
      } else if (
        ts.isIndexedAccessTypeNode(node.parent) &&
        node.parent.objectType === node &&
        ts.isLiteralTypeNode(node.parent.indexType) &&
        ts.isStringLiteral(node.parent.indexType.literal)
      ) {
        names.add(node.parent.indexType.literal.text);
      } else {
        problems.push(`${where(node)}: import("@moh/core") type used without a named member`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);

  // Namespace bindings: every identifier that resolves to the binding's
  // symbol must name a member. Resolution is by symbol (the file's own scopes,
  // no module resolution), so a shadowing local of the same name — `const`,
  // `let`, `var`, a parameter, `catch (core)`, `for (const core of …)` — is a
  // different symbol and neither counts nor is reported.
  if (namespaces.size > 0) {
    const checker = fileChecker(source);
    const symbolOf = (id: ts.Identifier): ts.Symbol | undefined => {
      const parent = id.parent;
      if (ts.isShorthandPropertyAssignment(parent) && parent.name === id) {
        return checker.getShorthandAssignmentValueSymbol(parent);
      }
      if (ts.isExportSpecifier(parent) && (parent.propertyName ?? parent.name) === id) {
        return checker.getExportSpecifierLocalTargetSymbol(parent);
      }
      return checker.getSymbolAtLocation(id);
    };
    const bound = new Set<ts.Symbol>();
    for (const id of namespaces) {
      const symbol = checker.getSymbolAtLocation(id);
      if (symbol === undefined) problems.push(`${where(id)}: @moh/core module binding has no symbol`);
      else bound.add(symbol);
    }
    const walk = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && !namespaces.has(node)) {
        const symbol = symbolOf(node);
        if (symbol !== undefined && bound.has(symbol)) {
          const parent = node.parent;
          if (ts.isQualifiedName(parent) && parent.left === node) names.add(parent.right.text);
          else if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && parent.initializer === node) {
            problems.push(`${where(node)}: @moh/core module value re-bound to another name`);
          } else fromModuleValue(node, node);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  return { names, problems };
}

export const LIST_DIR = "packages/core/test/keep-criterion";
export const BASELINE_FILE = `${LIST_DIR}/baseline.txt`;
export const ALLOWLIST_FILE = `${LIST_DIR}/allowlist.txt`;
export const ENTRY_FILE = "packages/core/src/index.ts";
const DOCS = "docs/extending/";

// The first out-of-place lines of a committed list (sorted, no duplicates),
// instead of a whole-list diff.
export function listOrderErrors(file: string, lines: readonly string[], limit = 5): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length && errors.length < limit; i++) {
    const line = lines[i]!;
    if (seen.has(line)) errors.push(`${file}:${i + 1} duplicates an earlier line: ${line}`);
    else if (i > 0 && line < lines[i - 1]!) errors.push(`${file}:${i + 1} is out of order (sorts before line ${i}): ${line}`);
    seen.add(line);
  }
  return errors;
}

// The page names the symbol as a whole word: the name not preceded or
// followed by an identifier character (letters, digits, `_`, `$`).
export function pageNames(text: string, name: string): boolean {
  const escaped = name.replace(/[$]/g, "\\$");
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}($|[^A-Za-z0-9_$])`).test(text);
}

export type KeepCriterionInput = {
  readonly exports: readonly string[];
  readonly used: ReadonlySet<string>;
  readonly allowlist: ReadonlyMap<string, string>;
  readonly baseline: readonly string[];
  /** The page's text, or undefined when the file does not exist (repo-relative path). */
  readonly pageText: (page: string) => string | undefined;
};

// The ratchet. An export is kept by a client import, or by an allowlist line
// naming the docs/extending/ page that documents it; every other export must
// be in the baseline, and the baseline holds nothing else (so it can only
// shrink). An allowlisted name that a client now imports leaves the
// allowlist the same way.
export function keepCriterionErrors(input: KeepCriterionInput): string[] {
  const exported = new Set(input.exports);
  const baseline = new Set(input.baseline);
  const errors: string[] = [];
  for (const [name, page] of input.allowlist) {
    const resolved = posix.normalize(page);
    if (!exported.has(name)) {
      errors.push(`${ALLOWLIST_FILE}: ${name} is no longer exported by ${ENTRY_FILE} (remove the line)`);
    } else if (input.used.has(name)) {
      errors.push(`${ALLOWLIST_FILE}: ${name} is now imported by a client (remove the line)`);
    }
    if (posix.isAbsolute(resolved) || !resolved.startsWith(DOCS)) {
      errors.push(`${ALLOWLIST_FILE}: ${name} names a page outside ${DOCS}: ${page}`);
    } else {
      const text = input.pageText(resolved);
      if (text === undefined) errors.push(`${ALLOWLIST_FILE}: ${name} names a page that does not exist: ${page}`);
      else if (!pageNames(text, name)) errors.push(`${ALLOWLIST_FILE}: ${name} is not named in its page ${page}`);
    }
    if (baseline.has(name)) errors.push(`${ALLOWLIST_FILE} and ${BASELINE_FILE} both list ${name} (keep one)`);
  }
  for (const name of input.exports) {
    if (input.used.has(name) || input.allowlist.has(name) || baseline.has(name)) continue;
    errors.push(
      `${ENTRY_FILE} exports ${name} with no client import and no ${ALLOWLIST_FILE} line ` +
        `(import it from a client, document it under ${DOCS} and add a line, or stop exporting it; never add it to ${BASELINE_FILE})`,
    );
  }
  for (const name of input.baseline) {
    if (!exported.has(name)) errors.push(`${BASELINE_FILE}: ${name} is no longer exported by ${ENTRY_FILE} (remove the line)`);
    else if (input.used.has(name)) errors.push(`${BASELINE_FILE}: ${name} is now imported by a client (remove the line)`);
  }
  return errors;
}
