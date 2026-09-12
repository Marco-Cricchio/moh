import { dirname, extname, join, posix } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import type { MpmRelation, MpmSymbol } from "./types";

/**
 * MPM language capabilities (#615): each supported language explicitly
 * declares which relation families its extractor can prove. MPM never
 * invents relations outside the declared families, and languages with no
 * capability contribute files to the map (coverage) but never relations
 * (partial-support silence is the contract).
 */

export type MpmRelationFamily = "imports" | "references" | "config-links" | "test-subjects";

export interface MpmLanguageCapability {
  /** Stable capability name, surfaced in provenance as `mpm/<name>`. */
  name: string;
  /** File extensions this capability claims (lowercase, with dot). */
  extensions: string[];
  /** Exact file names claimed regardless of extension (e.g. `go.mod`). */
  files?: string[];
  /** Relation families the extractor actually proves — nothing more. */
  families: ReadonlySet<MpmRelationFamily>;
  /** Extract symbols and relations from one file's content. */
  extract(content: string): { symbols: MpmSymbol[]; relations: Omit<MpmRelation, "target">[] };
  /**
   * Language-specific specifier resolution (#639). When absent, the default
   * TS/JS relative resolution applies. Returns null when the specifier
   * cannot be proven against the discovered file set — never an invented
   * target.
   */
  resolveTarget?(via: string, fromPath: string, known: Set<string>, root: string): string | null;
}

/** Symbols + import/export relations for the C-family / TS family. */
const typescriptLike = (name: string, extensions: string[]): MpmLanguageCapability => ({
  name,
  extensions,
  families: new Set<MpmRelationFamily>(["imports", "references", "test-subjects"]),
  extract(content: string) {
    return extractJsLike(content);
  },
});

/** `import x from "./y"` / `export ... from "./y"` / `require("./y")` / dynamic `import("./y")`. */
const JS_IMPORT_RE = /(?:^\s*import\s+(?:[\s\S]*?\s+from\s+)?|^\s*export\s+(?:[\s\S]*?\s+from\s+)?|\brequire\s*\(\s*|\bimport\s*\(\s*)["']([^"']+)["']/;

function extractJsLike(content: string): { symbols: MpmSymbol[]; relations: Omit<MpmRelation, "target">[] } {
  const symbols: MpmSymbol[] = [];
  const relations: Omit<MpmRelation, "target">[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Import/export-from/require relations: line-scoped and directly verifiable.
    const m = line.match(JS_IMPORT_RE);
    if (m) relations.push({ kind: "imports", via: m[1], line: i + 1 });
    // Declaration symbols: only exact, line-anchored forms are proven.
    let sym: MpmSymbol["kind"] | null = null;
    let name: string | undefined;
    let fn: RegExpMatchArray | null;
    if ((fn = line.match(/^\s*export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) {
      sym = "function";
      name = fn[1];
    } else if ((fn = line.match(/^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/))) {
      sym = "class";
      name = fn[1];
    } else if ((fn = line.match(/^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/))) {
      sym = "interface";
      name = fn[1];
    } else if ((fn = line.match(/^\s*export\s+type\s+([A-Za-z_$][\w$]*)\s*=/))) {
      sym = "type";
      name = fn[1];
    } else if ((fn = line.match(/^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*[=:]/))) {
      sym = "const";
      name = fn[1];
    }
    if (sym && name) symbols.push({ name, kind: sym, line: i + 1 });
  }
  return { symbols, relations };
}

/** JSON/YAML/TOML configuration files: structure only, `config-links` via string values that name a mapped file. */
const configuration = (name: string, extensions: string[]): MpmLanguageCapability => ({
  name,
  extensions,
  families: new Set<MpmRelationFamily>(["config-links"]),
  extract(content: string) {
    return { symbols: [], relations: extractConfigLinks(content) };
  },
});

function extractConfigLinks(content: string): Omit<MpmRelation, "target">[] {
  const relations: Omit<MpmRelation, "target">[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // A quoted relative path to an existing file is the only provable
    // configuration relation: `"./src/cli.ts"`-style values.
    for (const m of lines[i].matchAll(/"(\.\.?\/[^"]+\.[A-Za-z][\w]+)"/g)) {
      relations.push({ kind: "config-links", via: m[1], line: i + 1 });
    }
  }
  return relations;
}

/** Plain text / markup: mapped for coverage, no relations proven (silence). */
const plain = (name: string, extensions: string[]): MpmLanguageCapability => ({
  name,
  extensions,
  families: new Set<MpmRelationFamily>([]),
  extract() {
    return { symbols: [], relations: [] };
  },
});

/**
 * The capability registry. Membership is the whole truth: an extension not
 * listed here (or a file with no matching capability) maps with
 * `language: "unsupported"` and zero relations.
 */
export const MPM_CAPABILITIES: readonly MpmLanguageCapability[] = [
  typescriptLike("typescript", [".ts", ".tsx", ".mts", ".cts"]),
  typescriptLike("javascript", [".js", ".jsx", ".mjs", ".cjs"]),
  ...tierALanguages(),
  ...tierBLanguages(),
  configuration("json-config", [".json"]),
  configuration("yaml-config", [".yaml", ".yml"]),
  configuration("toml-config", [".toml"]),
  plain("markdown", [".md", ".mdx"]),
];

/** #639 Tier A: path-based languages — relations resolve to real file paths. */
function tierALanguages(): MpmLanguageCapability[] {
  return [
    pythonCapability(),
    goCapability(),
    cFamilyCapability(),
    phpCapability(),
    shellCapability(),
    luaCapability(),
  ];
}

// ─── Python ────────────────────────────────────────────────────────────────

function pythonCapability(): MpmLanguageCapability {
  return {
    name: "python",
    extensions: [".py"],
    families: new Set<MpmRelationFamily>(["imports", "references", "test-subjects"]),
    extract(content: string) {
      const symbols: MpmSymbol[] = [];
      const relations: Omit<MpmRelation, "target">[] = [];
      for (const [i, line] of content.split("\n").entries()) {
        // Relative-import forms are the only provable ones: the target is a
        // file inside the workspace. Absolute imports name packages whose
        // file layout is not locally provable — left silent.
        const m = line.match(/^\s*from\s+(\.+)([\w.]*)\s+import\s/);
        if (m) {
          relations.push({ kind: "imports", via: `rel:${m[1]}:${m[2].replace(/\./g, "/")}`, line: i + 1 });
          continue;
        }
        const fn = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/) ?? line.match(/^\s*class\s+([A-Za-z_]\w*)/);
        if (fn) symbols.push({ name: fn[1], kind: line.match(/^\s*class\s/) ? "class" : "function", line: i + 1 });
      }
      return { symbols, relations };
    },
    resolveTarget(via, fromPath, known) {
      // `rel:<dots>:<module-path>` — count parent hops, then probe
      // `<dir>/module.py` and `<dir>/module/__init__.py`.
      const m = via.match(/^rel:(\.+):(.*)$/);
      if (!m) return null;
      let dir = dirname(fromPath);
      for (let i = 1; i < m[1].length; i++) dir = dirname(dir);
      const stem = m[2] ? `${dir}/${m[2]}` : dir;
      // Python resolves the package (`__init__.py`) over a same-named module.
      for (const candidate of [`${stem}/__init__.py`, `${stem}.py`]) {
        if (known.has(candidate)) return candidate;
      }
      return null;
    },
  };
}

// ─── Go ────────────────────────────────────────────────────────────────────

function goCapability(): MpmLanguageCapability {
  return {
    name: "go",
    extensions: [".go"],
    files: ["go.mod"],
    families: new Set<MpmRelationFamily>(["imports"]),
    extract(content: string) {
      const symbols: MpmSymbol[] = [];
      const relations: Omit<MpmRelation, "target">[] = [];
      for (const [i, line] of content.split("\n").entries()) {
        // go.mod itself maps with no relations; its module path is used at
        // resolution time. Package-import lines carry quoted import paths.
        const imp = line.match(/^\s*"([^"]+)"$/);
        if (imp) relations.push({ kind: "imports", via: imp[1], line: i + 1 });
        const fn = line.match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/);
        if (fn) symbols.push({ name: fn[1], kind: "function", line: i + 1 });
        const ty = line.match(/^\s*type\s+([A-Za-z_]\w*)\s+struct\b/);
        if (ty) symbols.push({ name: ty[1], kind: "class", line: i + 1 });
        const it = line.match(/^\s*type\s+([A-Za-z_]\w*)\s+interface\b/);
        if (it) symbols.push({ name: it[1], kind: "interface", line: i + 1 });
      }
      return { symbols, relations };
    },
    resolveTarget(via, fromPath, known, root) {
      // The module path comes from the nearest go.mod, found by walking up
      // from the importing file's directory to the workspace root. Read
      // fresh each time: extraction order must not matter, no state is
      // carried between files.
      const parts = dirname(fromPath).split("/");
      let modulePath: string | null = null;
      let prefix = "";
      for (let i = parts.length; i >= 0; i--) {
        const dir = parts.slice(0, i).join("/");
        try {
          const mod = readFileSync(join(root, dir, "go.mod"), "utf8").match(/^module\s+(\S+)$/m);
          if (mod) {
            modulePath = mod[1];
            prefix = dir ? `${dir}/` : "";
            break;
          }
        } catch {
          // No go.mod at this level; keep walking up.
        }
      }
      if (!modulePath || !via.startsWith(`${modulePath}/`)) return null;
      // Package import → directory under the found module root: every
      // discovered .go file under that directory is a proven import target
      // (the first, deterministically).
      const dir = `${prefix}${via.slice(modulePath.length + 1)}`;
      for (const knownPath of known) {
        if (knownPath.startsWith(`${dir}/`) && knownPath.endsWith(".go")) return knownPath;
      }
      return null;
    },
  };
}

// ─── C / C++ ───────────────────────────────────────────────────────────────

function cFamilyCapability(): MpmLanguageCapability {
  return {
    name: "c-family",
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
    families: new Set<MpmRelationFamily>(["imports"]),
    extract(content: string) {
      const symbols: MpmSymbol[] = [];
      const relations: Omit<MpmRelation, "target">[] = [];
      for (const [i, line] of content.split("\n").entries()) {
        // Only the quote form names a workspace-relative path; the angle
        // form names a system header — silent by contract.
        const m = line.match(/^\s*#\s*include\s*"([^"]+)"/);
        if (m) relations.push({ kind: "imports", via: m[1], line: i + 1 });
        // Symbols only from declaration-shaped lines: a known return type at
        // the start of the line, or a struct/enum/class declaration. Calls,
        // comments, and strings don't match — never invented.
        const fn = line.match(
          /^\s*(?:static\s+|extern\s+|inline\s+|const\s+)*(?:void|int|char|float|double|short|long|signed|unsigned|size_t|bool|[A-Za-z_]\w*_t)\s+\*?([A-Za-z_]\w*)\s*\(/,
        );
        if (fn) symbols.push({ name: fn[1], kind: "function", line: i + 1 });
        const ty = line.match(/^\s*(?:typedef\s+)?(?:struct|enum|union|class)\s+([A-Za-z_]\w*)/);
        if (ty) symbols.push({ name: ty[1], kind: "interface", line: i + 1 });
      }
      return { symbols, relations };
    },
    // Quote-form includes are relative paths without a `./` prefix.
    resolveTarget(via, fromPath, known) {
      const base = posix.normalize(posix.join(dirname(fromPath), via));
      return known.has(base) ? base : null;
    },
  };
}

// ─── PHP ───────────────────────────────────────────────────────────────────

function phpCapability(): MpmLanguageCapability {
  return {
    name: "php",
    extensions: [".php"],
    families: new Set<MpmRelationFamily>(["imports", "references"]),
    extract(content: string) {
      const symbols: MpmSymbol[] = [];
      const relations: Omit<MpmRelation, "target">[] = [];
      for (const [i, line] of content.split("\n").entries()) {
        // Only literal-path include/require is provable; variable paths and
        // URLs stay silent.
        const m = line.match(/^\s*(?:include|require)(?:_once)?\s*\(?\s*["'](\.\.?\/[^"']+)["']/);
        if (m) relations.push({ kind: "imports", via: m[1], line: i + 1 });
        const cls = line.match(/^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/);
        if (cls) symbols.push({ name: cls[1], kind: "class", line: i + 1 });
        const fn = line.match(/^\s*function\s+([A-Za-z_]\w*)/);
        if (fn) symbols.push({ name: fn[1], kind: "function", line: i + 1 });
      }
      return { symbols, relations };
    },
  };
}

// ─── Shell ─────────────────────────────────────────────────────────────────

function shellCapability(): MpmLanguageCapability {
  return {
    name: "shell",
    extensions: [".sh", ".bash", ".zsh"],
    families: new Set<MpmRelationFamily>(["imports"]),
    extract(content: string) {
      const symbols: MpmSymbol[] = [];
      const relations: Omit<MpmRelation, "target">[] = [];
      for (const [i, line] of content.split("\n").entries()) {
        const m = line.match(/^\s*(?:source|\.)\s+(\.{1,2}\/[^\s;]+)(?:\s|;|$)/);
        if (m) relations.push({ kind: "imports", via: m[1], line: i + 1 });
        const fn = line.match(/^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/);
        if (fn) symbols.push({ name: fn[1], kind: "function", line: i + 1 });
      }
      return { symbols, relations };
    },
  };
}

// ─── Lua ───────────────────────────────────────────────────────────────────

function luaCapability(): MpmLanguageCapability {
  return {
    name: "lua",
    extensions: [".lua"],
    families: new Set<MpmRelationFamily>(["imports"]),
    extract(content: string) {
      const symbols: MpmSymbol[] = [];
      const relations: Omit<MpmRelation, "target">[] = [];
      for (const [i, line] of content.split("\n").entries()) {
        const m = line.match(/(?:^|\s)(?:require(?:\s*\(|\s")|dofile(?:\s*\(|\s")|loadfile\s*\()\s*\(?\s*["'](\.[^"']+)["']/);
        if (m) relations.push({ kind: "imports", via: m[1], line: i + 1 });
        const fn = line.match(/^\s*(?:local\s+)?function\s+([A-Za-z_][\w.:]*)/);
        if (fn) symbols.push({ name: fn[1], kind: "function", line: i + 1 });
      }
      return { symbols, relations };
    },
    resolveTarget(via, fromPath, known) {
      // `require "./x/y"` and `dofile "x.lua"` resolve like filesystem paths
      // relative to the requiring file (Lua's dot-notation without `./` is
      // package-path dependent — silent).
      if (!via.startsWith(".")) return null;
      const base = posix.normalize(posix.join(dirname(fromPath), via));
      for (const candidate of [base, `${base}.lua`, `${base}/init.lua`]) {
        if (known.has(candidate)) return candidate;
      }
      return null;
    },
  };
}

/** #639 Tier B: module-based languages — relations resolve via project files (ADR-0025). */
function tierBLanguages(): MpmLanguageCapability[] {
  return [rustCapability(), csharpCapability(), swiftCapability(), kotlinCapability()];
}

/**
 * Shared Tier B walk-up: from the importing file's directory to the root,
 * return the first directory whose listing satisfies `predicate`. Read
 * fresh per call — no cross-file state.
 */
function nearestAnchorLike(
  root: string,
  fromPath: string,
  predicate: (entry: string) => boolean,
): { dir: string } | null {
  const parts = dirname(fromPath).split("/");
  for (let i = parts.length; i >= 0; i--) {
    const dir = parts.slice(0, i).join("/");
    try {
      if (readdirSync(join(root, dir)).some(predicate)) return { dir };
    } catch {
      // Unreadable level: keep walking up.
    }
  }
  return null;
}

/** Nearest directory containing an exact-named anchor file. */
function nearestAnchor(
  root: string,
  fromPath: string,
  anchor: string,
): { dir: string } | null {
  return nearestAnchorLike(root, fromPath, (name) => name === anchor);
}

// ─── Rust ──────────────────────────────────────────────────────────────────

function rustCapability(): MpmLanguageCapability {
  return {
    name: "rust",
    extensions: [".rs"],
    files: ["Cargo.toml"],
    families: new Set<MpmRelationFamily>(["imports", "config-links"]),
    extract(content: string) {
      const symbols: MpmSymbol[] = [];
      const relations: Omit<MpmRelation, "target">[] = [];
      for (const [i, line] of content.split("\n").entries()) {
        // mod declarations are the compiler's own module→file rule: the only
        // module reference that pins a file without any project context.
        const mod = line.match(/^\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;/);
        if (mod) {
          relations.push({ kind: "imports", via: `mod:${mod[1]}`, line: i + 1 });
          continue;
        }
        const use_ = line.match(/^\s*(?:pub\s+)?use\s+crate::([\w:]+)\s*;/);
        if (use_) relations.push({ kind: "imports", via: `crate:${use_[1]}`, line: i + 1 });
        // Cargo.toml path dependencies: `name = { path = "vendor/foo" }` —
        // the only dependency form with a literal local path.
        const dep = line.match(/^\s*[\w-]+\s*=\s*\{[^}]*path\s*=\s*"([^"]+)"/);
        if (dep) relations.push({ kind: "config-links", via: `path-dep:${dep[1]}`, line: i + 1 });
        const fn = line.match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/);
        if (fn) symbols.push({ name: fn[1], kind: "function", line: i + 1 });
        const st = line.match(/^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/);
        if (st) symbols.push({ name: st[1], kind: "class", line: i + 1 });
        const en = line.match(/^\s*(?:pub\s+)?(?:enum|trait)\s+([A-Za-z_]\w*)/);
        if (en) symbols.push({ name: en[1], kind: "interface", line: i + 1 });
      }
      return { symbols, relations };
    },
    resolveTarget(via, fromPath, known, root) {
      const fromDir = dirname(fromPath);
      if (via.startsWith("mod:")) {
        // lib.rs/main.rs: `<name>.rs` or `<name>/mod.rs` next to the file —
        // but only when some sibling file actually declares the module
        // (mod-declaration check keeps orphan files from being invented).
        const name = via.slice(4);
        const declaring = declaredMods(root, known, fromDir);
        if (!declaring.has(name)) return null;
        for (const candidate of [`${fromDir}/${name}.rs`, `${fromDir}/${name}/mod.rs`]) {
          if (known.has(candidate)) return candidate;
        }
        return null;
      }
      if (via.startsWith("path-dep:")) {
        // Cargo.toml path dependency: `vendor/foo` → the dep crate's
        // lib.rs is a proven cross-crate target (literal path in the
        // project file). The path is relative to the Cargo.toml's
        // directory, found by walking up from the referencing file.
        const anchor = nearestAnchor(root, fromPath, "Cargo.toml");
        if (!anchor) return null;
        const depDir = anchor.dir ? `${anchor.dir}/${via.slice("path-dep:".length)}` : via.slice("path-dep:".length);
        for (const candidate of [`${depDir}/src/lib.rs`, `${depDir}/src/main.rs`]) {
          if (known.has(candidate)) return candidate;
        }
        return null;
      }
      if (!via.startsWith("crate:")) return null;
      // `use crate::a::b` — walk up to the crate root (the directory with
      // Cargo.toml), then follow mod-file layout from its `src/` root,
      // requiring every segment to be declared as a module by its parent
      // (not just present on disk).
      const cargo = nearestAnchor(root, fromPath, "Cargo.toml");
      if (!cargo) return null;
      const segs = via.slice(6).split("::").filter((s) => s.length > 0);
      const srcRoot = cargo.dir ? `${cargo.dir}/src` : "src";
      if (!known.has(`${srcRoot}/main.rs`) && !known.has(`${srcRoot}/lib.rs`)) return null;
      // Every crate-root segment (except a possible final item) must be
      // declared by the module file that contains it.
      let dir = srcRoot;
      let lastMatched: string | null = null;
      for (let s = 0; s < segs.length; s++) {
        const isLast = s === segs.length - 1;
        const declaring = declaredMods(root, known, dir);
        // Candidate targets for this segment: declared module files, plus
        // (for the final segment) the current module file itself when the
        // segment names an item inside it.
        const candidates: string[] = [];
        if (declaring.has(segs[s])) {
          candidates.push(`${dir}/${segs[s]}.rs`, `${dir}/${segs[s]}/mod.rs`);
        }
        if (isLast && lastMatched) candidates.push(lastMatched);
        let matched: string | null = null;
        for (const candidate of candidates) {
          if (known.has(candidate)) {
            matched = candidate;
            break;
          }
        }
        if (!matched) return null;
        lastMatched = matched;
        if (isLast) return matched;
        dir = matched.endsWith("/mod.rs") ? matched.slice(0, -"/mod.rs".length) : dirname(matched);
      }
      return lastMatched;
    },
  };
}

/**
 * Set of module names declared by `mod x;` lines across the `.rs` files of
 * one directory (read fresh per call — no cross-file state). Read cost is
 * bounded: only files in the single directory being descended into.
 */
function declaredMods(root: string, known: Set<string>, dir: string): Set<string> {
  const declared = new Set<string>();
  for (const path of known) {
    if (dirname(path) !== dir || !path.endsWith(".rs")) continue;
    try {
      const content = readFileSync(join(root, path), "utf8");
      for (const line of content.split("\n")) {
        const mod = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/);
        if (mod) declared.add(mod[1]);
      }
    } catch {
      // Unreadable sibling: it declares nothing.
    }
  }
  return declared;
}

// ─── C# ────────────────────────────────────────────────────────────────────

function csharpCapability(): MpmLanguageCapability {
  return {
    name: "csharp",
    extensions: [".cs"],
    families: new Set<MpmRelationFamily>(["references"]),
    extract(content: string) {
      const symbols: MpmSymbol[] = [];
      const relations: Omit<MpmRelation, "target">[] = [];
      for (const [i, line] of content.split("\n").entries()) {
        const ns = line.match(/^\s*(?:namespace\s+([\w.]+))/);
        if (ns) relations.push({ kind: "references", via: `ns:${ns[1]}`, line: i + 1 });
        const use_ = line.match(/^\s*(?:global\s+)?using\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/);
        if (use_) relations.push({ kind: "references", via: `ns:${use_[1]}`, line: i + 1 });
        const cls = line.match(/^\s*(?:public|internal|private|protected)?\s*(?:sealed\s+|abstract\s+|static\s+|partial\s+)*(class|interface|struct|record|enum)\s+([A-Za-z_]\w*)/);
        if (cls) {
          const kind = cls[1] === "interface" || cls[1] === "enum" ? "interface" : "class";
          symbols.push({ name: cls[2], kind, line: i + 1 });
        }
      }
      return { symbols, relations };
    },
    resolveTarget(via, fromPath, known, root) {
      // `ns:<namespace>` — provable only when the nearest *.csproj exists
      // and exactly one discovered .cs file declares that namespace. The
      // declaring file is re-read at resolution time (literal text =
      // verification, not inference); self-references never emit.
      if (!via.startsWith("ns:")) return null;
      const csproj = nearestAnchorLike(root, fromPath, (name) => name.endsWith(".csproj"));
      if (!csproj) return null;
      const ns = via.slice(3);
      const nsDecl = new RegExp(`^\\s*namespace\\s+${ns.replace(/\./g, "\\.")}\\s*[;{]`, "m");
      const candidates = [...known].filter((p) => {
        if (!p.endsWith(".cs") || p === fromPath) return false;
        try {
          return nsDecl.test(readFileSync(join(root, p), "utf8"));
        } catch {
          return false;
        }
      });
      return candidates.length === 1 ? candidates[0] : null;
    },
  };
}

// ─── Swift ─────────────────────────────────────────────────────────────────

function swiftCapability(): MpmLanguageCapability {
  return {
    name: "swift",
    extensions: [".swift"],
    files: ["Package.swift"],
    families: new Set<MpmRelationFamily>(["references"]),
    extract(content: string) {
      const symbols: MpmSymbol[] = [];
      const relations: Omit<MpmRelation, "target">[] = [];
      for (const [i, line] of content.split("\n").entries()) {
        const imp = line.match(/^\s*(?:@testable\s+)?import\s+([A-Za-z_]\w*)/);
        if (imp) relations.push({ kind: "references", via: `module:${imp[1]}`, line: i + 1 });
        const cls = line.match(/^\s*(?:public\s+|open\s+|internal\s+|private\s+|final\s+)*(class|struct|enum|protocol|actor)\s+([A-Za-z_]\w*)/);
        if (cls) {
          const kind = cls[1] === "protocol" || cls[1] === "enum" ? "interface" : "class";
          symbols.push({ name: cls[2], kind, line: i + 1 });
        }
        const fn = line.match(/^\s*(?:public\s+|open\s+|internal\s+|private\s+|static\s+)*(?:func\s+)([A-Za-z_]\w*)/);
        if (fn) symbols.push({ name: fn[1], kind: "function", line: i + 1 });
      }
      return { symbols, relations };
    },
    resolveTarget(via, fromPath, known, root) {
      // `module:<Name>` — provable only when the nearest Package.swift
      // declares a target whose name matches AND the target's source
      // directory maps literally under Sources/<Name>/. Pick the discovered
      // swift file in that directory deterministically; ambiguous → silent.
      if (!via.startsWith("module:")) return null;
      const name = via.slice(7);
      const anchor = nearestAnchor(root, fromPath, "Package.swift");
      if (!anchor) return null;
      // Literal target declaration, line-anchored, comments skipped. A
      // custom `path:` overrides the Sources/<Name> convention; without one
      // the mapping must be literal.
      const pkgPath = join(root, anchor.dir, "Package.swift");
      let lines: string[];
      try {
        lines = readFileSync(pkgPath, "utf8").split("\n");
      } catch {
        return null;
      }
      let declared = false;
      let customPath: string | null = null;
      let inTarget = false;
      for (const raw of lines) {
        const line = raw.trim();
        if (line.startsWith("//")) continue;
        if (/\.target\(name:\s*"([\w-]+)"/.test(line) || /\.executableTarget\(name:\s*"([\w-]+)"/.test(line)) {
          inTarget = new RegExp(`\\(name:\\s*"${name}"`).test(line);
          declared = declared || inTarget;
        }
        if (inTarget) {
          const pathOverride = line.match(/path:\s*"([^"]+)"/);
          if (pathOverride) customPath = pathOverride[1];
        }
      }
      if (!declared) return null;
      const base = customPath ?? (anchor.dir ? `${anchor.dir}/Sources/${name}` : `Sources/${name}`);
      const candidates = [...known].filter((p) => p.startsWith(`${base}/`) && p.endsWith(".swift"));
      return candidates.length === 1 ? candidates[0] : null;
    },
  };
}

// ─── Kotlin ────────────────────────────────────────────────────────────────

function kotlinCapability(): MpmLanguageCapability {
  return {
    name: "kotlin",
    extensions: [".kt", ".kts"],
    families: new Set<MpmRelationFamily>(["references"]),
    extract(content: string) {
      const symbols: MpmSymbol[] = [];
      const relations: Omit<MpmRelation, "target">[] = [];
      for (const [i, line] of content.split("\n").entries()) {
        const pkg = line.match(/^\s*package\s+([\w.]+)/);
        if (pkg) relations.push({ kind: "references", via: `pkg:${pkg[1]}`, line: i + 1 });
        const imp = line.match(/^\s*import\s+([\w.]+)\s*$/);
        // Only the last segment beyond a proven package root is useful at
        // resolution time; pass the full dotted path and let the resolver
        // walk it. `import a.b.C` — the resolver pins a.b to a directory
        // and C to a file.
        if (imp) relations.push({ kind: "references", via: `pkg:${imp[1]}`, line: i + 1 });
        const cls = line.match(/^\s*(?:public\s+|private\s+|internal\s+|open\s+|abstract\s+|sealed\s+|data\s+)*(class|interface|object|enum\s+class)\s+([A-Za-z_]\w*)/);
        if (cls) {
          const kind = cls[1] === "interface" || cls[1].includes("enum") ? "interface" : "class";
          symbols.push({ name: cls[2], kind, line: i + 1 });
        }
        const fn = line.match(/^\s*(?:public\s+|private\s+|internal\s+|open\s+|override\s+|suspend\s+)*fun\s+(?:<[^>]+>\s+)?(?:[A-Za-z_][\w.<>]*\.)?([A-Za-z_]\w*)\s*\(/);
        if (fn) symbols.push({ name: fn[1], kind: "function", line: i + 1 });
      }
      return { symbols, relations };
    },
    resolveTarget(via, fromPath, known, root) {
      // `pkg:<package>[.Member]` — provable only when a Gradle/Maven
      // source-set root makes the package-to-directory mapping literal:
      // find the nearest build file, then the unique discovered Kotlin file
      // matching the dotted path (last segment = file, rest = directory).
      if (!via.startsWith("pkg:")) return null;
      const buildAnchor =
        nearestAnchor(root, fromPath, "build.gradle.kts") ??
        nearestAnchor(root, fromPath, "build.gradle") ??
        nearestAnchor(root, fromPath, "pom.xml");
      if (!buildAnchor) return null;
      const segs = via.slice(4).split(".");
      const srcRoots = ["src/main/kotlin", "src/main/java", "src/test/kotlin", "src/test/java"];
      for (const src of srcRoots) {
        const base = `${buildAnchor.dir}/${src}`;
        // Full path as file (package segments + member file name).
        for (let split = segs.length; split >= 1; split--) {
          const dir = `${base}/${segs.slice(0, split - 1).join("/")}`;
          const candidate = `${dir}/${segs[split - 1]}.kt`;
          if (known.has(candidate) && candidate !== fromPath) return candidate;
        }
      }
      return null;
    },
  };
}

export function capabilityForPath(path: string): MpmLanguageCapability | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  for (const cap of MPM_CAPABILITIES) {
    if (cap.files?.includes(base)) return cap;
  }
  const ext = extname(path).toLowerCase();
  for (const cap of MPM_CAPABILITIES) {
    if (cap.extensions.includes(ext)) return cap;
  }
  return null;
}
