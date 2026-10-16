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
import ts from "typescript";

export const CORE_ENTRY = "@moh/core";

export type ClientUses = { readonly names: Set<string>; readonly problems: string[] };

function scriptKind(fileName: string): ts.ScriptKind {
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

export function clientUses(fileName: string, text: string): ClientUses {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const names = new Set<string>();
  const problems: string[] = [];
  const namespaces = new Set<string>();
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
        namespaces.add(consumer.name.text);
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
        namespaces.add(bindings.name.text);
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
      namespaces.add(node.name.text);
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

  // Namespace bindings: every other occurrence of the identifier must name a
  // member. Matching is by identifier text (no scope analysis): a shadowing
  // local of the same name is reported as a problem, never ignored.
  if (namespaces.size > 0) {
    const isBinding = (id: ts.Identifier): boolean => {
      const parent = id.parent;
      return (
        (ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent) || ts.isVariableDeclaration(parent)) &&
        parent.name === id
      );
    };
    const walk = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && namespaces.has(node.text) && !isBinding(node)) {
        const parent = node.parent;
        if (ts.isQualifiedName(parent) && parent.left === node) {
          names.add(parent.right.text);
        } else if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
          // `x.core` is a property named like the namespace, not a use of it.
        } else if (ts.isPropertyAssignment(parent) && parent.name === node) {
          // `{ core: … }` is a key, not a use.
        } else {
          fromModuleValue(node, node);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  return { names, problems };
}

export type KeepCriterionInput = {
  readonly exports: readonly string[];
  readonly used: ReadonlySet<string>;
  readonly allowlist: ReadonlyMap<string, string>;
  readonly baseline: readonly string[];
  readonly pageExists: (page: string) => boolean;
};

// The ratchet. An export is kept by a client import, or by an allowlist line
// naming its docs/extending/ page; every other export must be in the
// baseline, and the baseline holds nothing else (so it can only shrink).
export function keepCriterionErrors(input: KeepCriterionInput): string[] {
  const exported = new Set(input.exports);
  const baseline = new Set(input.baseline);
  const errors: string[] = [];
  for (const [name, page] of input.allowlist) {
    if (!exported.has(name)) errors.push(`allowlist entry no longer exported: ${name}`);
    if (!page.startsWith("docs/extending/") || !input.pageExists(page)) {
      errors.push(`allowlist entry ${name} names a missing docs/extending/ page: ${page}`);
    }
    if (baseline.has(name)) errors.push(`name both allowlisted and in the baseline: ${name}`);
  }
  for (const name of input.exports) {
    if (input.used.has(name) || input.allowlist.has(name) || baseline.has(name)) continue;
    errors.push(`export with no client import and no allowlist entry: ${name}`);
  }
  for (const name of input.baseline) {
    if (!exported.has(name)) errors.push(`baseline entry no longer exported (remove it): ${name}`);
    else if (input.used.has(name)) errors.push(`baseline entry now imported by a client (remove it): ${name}`);
  }
  return errors;
}
