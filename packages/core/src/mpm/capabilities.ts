import { dirname, extname, join, posix } from "node:path";
import { readFileSync } from "node:fs";
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
        let m = line.match(/^\s*from\s+(\.+)([\w.]*)\s+import\s/);
        if (m) {
          relations.push({ kind: "imports", via: `rel:${m[1]}:${m[2].replace(/\./g, "/")}`, line: i + 1 });
          continue;
        }
        m = line.match(/^\s*import\s+\.([\w.]+)/);
        if (m) {
          relations.push({ kind: "imports", via: `rel:.:${m[1].replace(/\./g, "/")}`, line: i + 1 });
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
      for (const candidate of [`${stem}.py`, `${stem}/__init__.py`]) {
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
    families: new Set<MpmRelationFamily>(["imports", "config-links"]),
    extract(content: string) {
      const symbols: MpmSymbol[] = [];
      const relations: Omit<MpmRelation, "target">[] = [];
      for (const [i, line] of content.split("\n").entries()) {
        // go.mod itself maps with no relations; its module path is used at
        // resolution time. Package-import lines carry quoted import paths.
        const imp = line.match(/^\s*"([^"]+)"$/);
        if (imp) relations.push({ kind: "imports", via: imp[1], line: i + 1 });
        const fn = line.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/);
        if (fn) symbols.push({ name: fn[1], kind: "function", line: i + 1 });
        const ty = line.match(/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/);
        if (ty) symbols.push({ name: ty[1], kind: "interface", line: i + 1 });
      }
      return { symbols, relations };
    },
    resolveTarget(via, fromPath, known, root) {
      // The module path comes from the go.mod nearest the importing file
      // (here: the go.mod's own directory — read fresh, extraction order
      // must not matter, no state carried between files).
      const fromDir = dirname(fromPath);
      const modDir = fromPath.includes("/")
        ? `${root}/${fromDir.slice(0, fromDir.lastIndexOf("/") >= 0 ? fromDir.indexOf("/") : undefined)}`
        : root;
      let modulePath: string | null = null;
      try {
        const mod = readFileSync(join(modDir, "go.mod"), "utf8").match(/^module\s+(\S+)$/m);
        if (mod) modulePath = mod[1];
      } catch {
        return null;
      }
      if (!modulePath || !via.startsWith(`${modulePath}/`)) return null;
      // Package import → directory under the go.mod's directory: every
      // discovered .go file under that directory is a proven import target
      // (the first, deterministically).
      const prefix = fromPath.includes("/") ? `${fromPath.slice(0, fromPath.indexOf("/"))}/` : "";
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
        const fn = line.match(/^[A-Za-z_][\w\s*]*?\b([A-Za-z_]\w*)\s*\([^;]*$|^struct\s+([A-Za-z_]\w*)/);
        const name = fn?.[1] ?? fn?.[2];
        if (fn && name) symbols.push({ name, kind: fn[2] ? "interface" : "function", line: i + 1 });
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
