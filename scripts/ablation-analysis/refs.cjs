// Cross-reference analysis over the moh monorepo using the TS 5.9 compiler API.
// Usage: node refs.cjs <repoRoot> <outDir>
const path = require("path");
const fs = require("fs");
const root = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3]);
const ts = require(path.join(root, "packages/core/node_modules/typescript"));

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) acc.push(p);
  }
  return acc;
}
const files = [];
for (const pkg of fs.readdirSync(path.join(root, "packages"))) walk(path.join(root, "packages", pkg), files);
walk(path.join(root, "scripts"), files);
files.push(path.join(root, "packages/core/src/assets.d.ts"));

const program = ts.createProgram(files, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  resolveJsonModule: true,
  jsx: ts.JsxEmit.ReactJSX,
  allowImportingTsExtensions: true,
  types: ["bun-types"],
  typeRoots: [path.join(root, "node_modules/@types"), path.join(root, "node_modules")],
});
const checker = program.getTypeChecker();
const rel = (f) => path.relative(root, f);
const isTest = (f) => /\.test\.|\/test\/|\/scripts\/|\/evals\//.test(rel(f)) || rel(f).startsWith("scripts/");
const isOurs = (f) => f.startsWith(root) && !f.includes("node_modules");

// declKey -> info
const decls = new Map();
function keyOf(decl) {
  const sf = decl.getSourceFile();
  return sf.fileName + ":" + decl.getStart();
}
function nameOf(decl) {
  return decl.name && decl.name.getText ? decl.name.getText() : "<anon>";
}
function resolve(sym) {
  if (!sym) return undefined;
  if (sym.flags & ts.SymbolFlags.Alias) {
    try { sym = checker.getAliasedSymbol(sym); } catch { return undefined; }
  }
  return sym;
}
function isExported(node) {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods && mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

// Pass 1: collect top-level declarations (exported or not) + class methods + all functions.
for (const sf of program.getSourceFiles()) {
  if (!isOurs(sf.fileName)) continue;
  const visit = (node, topLevel) => {
    let d;
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      if (node.name) d = { node, kind: ts.SyntaxKind[node.kind].replace("Declaration", ""), exported: topLevel && isExported(node), top: topLevel };
    } else if (ts.isVariableStatement(node) && topLevel) {
      for (const v of node.declarationList.declarations) {
        if (ts.isIdentifier(v.name)) {
          const fn = v.initializer && (ts.isArrowFunction(v.initializer) || ts.isFunctionExpression(v.initializer));
          const info = { node: v, kind: fn ? "ConstFn" : "Const", exported: isExported(node), top: true };
          decls.set(keyOf(v), { ...info, file: sf.fileName, name: v.name.text, line: sf.getLineAndCharacterOfPosition(v.getStart()).line + 1, refs: new Map(), calls: 0, callArgCounts: [] });
        }
      }
    } else if ((ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) && node.parent && ts.isClassDeclaration(node.parent) && node.name) {
      d = { node, kind: ts.isMethodDeclaration(node) ? "Method" : "Property", exported: false, top: false, owner: node.parent.name && node.parent.name.text };
    }
    if (d) {
      decls.set(keyOf(d.node), { ...d, file: sf.fileName, name: nameOf(d.node), line: sf.getLineAndCharacterOfPosition(d.node.getStart()).line + 1, refs: new Map(), calls: 0, callArgCounts: [] });
    }
    ts.forEachChild(node, (c) => visit(c, false));
  };
  ts.forEachChild(sf, (c) => visit(c, true));
}

// Pass 2: every identifier -> resolved symbol -> its declarations -> record ref file.
for (const sf of program.getSourceFiles()) {
  if (!isOurs(sf.fileName)) continue;
  const visit = (node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      const parent = node.parent;
      // skip the declaration name itself
      const isDeclName = parent && parent.name === node && decls.has(keyOf(parent));
      if (!isDeclName) {
        let sym;
        try { sym = checker.getSymbolAtLocation(node); } catch {}
        const inExport = parent && (ts.isExportSpecifier(parent));
        const inImport = parent && (ts.isImportSpecifier(parent) || ts.isImportClause(parent));
        sym = resolve(sym);
        if (sym && sym.declarations) {
          for (const dd of sym.declarations) {
            const info = decls.get(keyOf(dd));
            if (!info) continue;
            const kind = inExport ? "reexport" : inImport ? "import" : "use";
            const r = info.refs.get(sf.fileName) || { use: 0, import: 0, reexport: 0 };
            r[kind]++;
            info.refs.set(sf.fileName, r);
            // call-site arg counts
            if (kind === "use" && parent) {
              let call = null;
              if (ts.isCallExpression(parent) && parent.expression === node) call = parent;
              else if (ts.isPropertyAccessExpression(parent) && parent.name === node && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) call = parent.parent;
              else if (ts.isNewExpression(parent) && parent.expression === node) call = parent;
              if (call) { info.calls++; info.callArgCounts.push(call.arguments ? call.arguments.length : 0); }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const rows = [];
for (const info of decls.values()) {
  const refFiles = [...info.refs.entries()];
  const own = info.refs.get(info.file) || { use: 0, import: 0, reexport: 0 };
  const external = refFiles.filter(([f, r]) => f !== info.file && r.use > 0);
  const extSrc = external.filter(([f]) => !isTest(f));
  const extTest = external.filter(([f]) => isTest(f));
  const reexportOnly = refFiles.filter(([f, r]) => f !== info.file && r.use === 0);
  // params
  let params = null;
  const n = info.node;
  const fnNode = ts.isVariableDeclaration(n) ? n.initializer : n;
  if (fnNode && fnNode.parameters) {
    params = fnNode.parameters.map((p) => ({ name: p.name.getText(), optional: !!(p.questionToken || p.initializer) }));
  }
  rows.push({
    file: rel(info.file), line: info.line, end: info.node.getSourceFile().getLineAndCharacterOfPosition(info.node.getEnd()).line + 1, name: info.name, kind: info.kind, exported: info.exported, top: info.top, owner: info.owner,
    ownUses: own.use, extSrc: extSrc.map(([f, r]) => rel(f)), extTest: extTest.map(([f]) => rel(f)), reexportVia: reexportOnly.map(([f]) => rel(f)),
    calls: info.calls, callArgCounts: info.callArgCounts, params, srcFile: !isTest(info.file),
  });
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "refs.json"), JSON.stringify(rows));
console.log("decls", rows.length);
