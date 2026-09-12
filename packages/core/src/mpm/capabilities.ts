import { extname } from "node:path";
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
  /** Relation families the extractor actually proves — nothing more. */
  families: ReadonlySet<MpmRelationFamily>;
  /** Extract symbols and relations from one file's content. */
  extract(content: string): { symbols: MpmSymbol[]; relations: Omit<MpmRelation, "target">[] };
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
 */export const MPM_CAPABILITIES: readonly MpmLanguageCapability[] = [
  typescriptLike("typescript", [".ts", ".tsx", ".mts", ".cts"]),
  typescriptLike("javascript", [".js", ".jsx", ".mjs", ".cjs"]),
  configuration("json-config", [".json"]),
  configuration("yaml-config", [".yaml", ".yml"]),
  configuration("toml-config", [".toml"]),
  plain("markdown", [".md", ".mdx"]),
];

export function capabilityForPath(path: string): MpmLanguageCapability | null {
  const ext = extname(path).toLowerCase();
  for (const cap of MPM_CAPABILITIES) {
    if (cap.extensions.includes(ext)) return cap;
  }
  return null;
}
