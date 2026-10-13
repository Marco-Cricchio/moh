// S0.2/B1 public-surface snapshot.
//
//   bun scripts/ablation-baseline/surface.ts <outDir>
//
// Writes <outDir>/surface.txt: sorted, one name per line —
// - every runtime and type export of the four entry points
//   (core, extension, tui index, tui bundled-extensions);
// - every public method/getter/setter of the nine contract classes;
// - the `exports` map of every packages/*/package.json.
//
// Syntax-only walk via the TypeScript 5.9 compiler API
// (packages/core/node_modules/typescript — the root typescript@7 has no
// JS API), per appendix A § A6.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "../../packages/core/node_modules/typescript";

const REPO = join(import.meta.dir, "..", "..");

const ENTRY_FILES = [
  ["@moh/core", "packages/core/src/index.ts"],
  ["@moh/extension", "packages/extension/src/index.ts"],
  ["@moh/tui", "packages/tui/src/index.ts"],
  ["@moh/tui/bundled-extensions", "packages/tui/src/bundled-extensions.ts"],
] as const;

const CLASS_FILES: ReadonlyArray<[string, string]> = [
  ["AgentSession", "packages/core/src/session/session.ts"],
  ["ExtensionRuntime", "packages/core/src/extensions.ts"],
  ["SessionStore", "packages/core/src/session-store.ts"],
  ["MockProvider", "packages/core/src/mock-provider.ts"],
  ["ProviderRegistry", "packages/core/src/provider-registry.ts"],
  ["McpRuntime", "packages/core/src/mcp/runtime.ts"],
  ["MpmService", "packages/core/src/mpm/service.ts"],
  ["CompactionRunner", "packages/core/src/compaction.ts"],
  ["PromptComposer", "packages/core/src/prompt-composer.ts"],
];

function propertyName(expr: ts.ModuleExportName): string {
  if (ts.isIdentifier(expr)) return expr.text;
  return expr.text;
}

function specifierText(expr: ts.Expression): string {
  if (ts.isStringLiteral(expr)) return expr.text;
  return expr.getText();
}

function memberName(node: ts.ClassElement): string | null {
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    const name = node.name;
    if (ts.isIdentifier(name)) return name.text;
    if (ts.isStringLiteral(name)) return name.text;
  }
  return null;
}

function publicMembers(source: ts.SourceFile, className: string): string[] {
  const out: string[] = [];
  source.forEachChild((stmt) => {
    if (!ts.isClassDeclaration(stmt) || stmt.name?.text !== className) return;
    for (const member of stmt.members) {
      const name = memberName(member);
      if (name === null) continue;
      const flags = ts.getCombinedModifierFlags(member);
      const isPrivate = (flags & ts.ModifierFlags.Private) !== 0 || (flags & ts.ModifierFlags.Protected) !== 0;
      if (isPrivate) continue;
      const isStatic = (flags & ts.ModifierFlags.Static) !== 0;
      const kind = ts.isGetAccessorDeclaration(member)
        ? "get"
        : ts.isSetAccessorDeclaration(member)
          ? "set"
          : "method";
      out.push(`${kind}\t${name}${isStatic ? "\tstatic" : ""}`);
    }
  });
  return out;
}

function exportNames(source: ts.SourceFile): string[] {
  const out: string[] = [];
  source.forEachChild((stmt) => {
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          out.push(el.propertyName ? `${propertyName(el.propertyName)} as ${el.name.text}` : el.name.text);
        }
      } else if (stmt.exportClause && ts.isNamespaceExport(stmt.exportClause)) {
        out.push(`* as ${stmt.exportClause.name.text}`);
      } else if (stmt.exportClause === undefined && stmt.moduleSpecifier) {
        out.push(`* from ${specifierText(stmt.moduleSpecifier)}`);
      }
      return;
    }
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      out.push("default");
      return;
    }
    const hasExport = (node: ts.Node): boolean =>
      (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      ) ?? false;
    if (
      (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)) &&
      hasExport(stmt) &&
      stmt.name
    ) {
      out.push(stmt.name.text);
      return;
    }
    if (
      (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) &&
      hasExport(stmt)
    ) {
      out.push(stmt.name.escapedText as string);
      return;
    }
    if (ts.isVariableStatement(stmt) && hasExport(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) out.push(decl.name.text);
      }
    }
  });
  return out;
}

function main(): void {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("usage: surface.ts <outDir>");
    process.exit(2);
  }
  const lines: string[] = [];

  for (const [pkg, rel] of ENTRY_FILES) {
    const file = join(REPO, rel);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const name of exportNames(source)) lines.push(`export\t${pkg}\t${name}`);
  }

  for (const [className, rel] of CLASS_FILES) {
    const file = join(REPO, rel);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const member of publicMembers(source, className)) lines.push(`member\t${className}\t${member}`);
  }

  const packagesDir = join(REPO, "packages");
  for (const pkg of readdirSync(packagesDir).sort()) {
    const file = join(packagesDir, pkg, "package.json");
    let json: { exports?: Record<string, unknown> };
    try {
      json = JSON.parse(readFileSync(file, "utf8")) as { exports?: Record<string, unknown> };
    } catch {
      continue;
    }
    for (const key of Object.keys(json.exports ?? {}).sort()) {
      const target = json.exports![key]!;
      lines.push(`pkg-exports\t${pkg}\t${key}\t${typeof target === "string" ? target : JSON.stringify(target)}`);
    }
  }

  lines.sort();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(dirname(join(outDir, "surface.txt")), { recursive: true });
  writeFileSync(join(outDir, "surface.txt"), lines.join("\n") + "\n");
  console.log(`surface: ${lines.length} lines`);
}

main();
