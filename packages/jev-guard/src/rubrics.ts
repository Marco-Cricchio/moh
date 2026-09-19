/**
 * Deterministic rubric discovery (#789, spec §2): the convention
 * documents a project actually ships, read off disk — never invented.
 *
 * Golden rule (TypeSafe skill guidance): this module owns the name list,
 * the caps and the read order. Extending the list is a one-line change to
 * `RUBRIC_NAMES`. No match means the quality gate is **inert**: a repo
 * without convention docs gets silence, never synthesized criteria.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The convention-document name list, in specificity order (root first,
 * then the tool-specific and nested locations). Every match across the
 * list is collected — first match wins per *name*, so `AGENTS.md` at the
 * root and `.github/AGENTS.md` can coexist as two distinct rubrics.
 */
export const RUBRIC_NAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "STYLE.md",
  "CONVENTIONS.md",
  ".cursorrules",
  ".github/CONTRIBUTING.md",
  ".github/AGENTS.md",
  "docs/CONTRIBUTING.md",
  "docs/CONVENTIONS.md",
  "docs/STYLE.md",
] as const;

/** Caps (ratified): 6 files, 16 KiB of combined rubric text. */
export const RUBRIC_MAX_FILES = 6;
export const RUBRIC_MAX_BYTES = 16 * 1024;

/** The visible truncation marker appended to a cut rubric. */
export const RUBRIC_TRUNCATION_MARKER = "…[truncated]";

/** One discovered rubric document. */
export interface RubricDoc {
  /** Repo-relative path, as recorded in the judgment payload. */
  readonly path: string;
  /** The document's text, already truncated to the combined budget. */
  readonly text: string;
}

/**
 * Collects every convention document present in `root`. Deterministic:
 * the name-list order decides both precedence and what gets dropped when
 * the caps bind. `exists`/`read` are test seams.
 */
export function discoverRubrics(
  root: string,
  seams: { exists?: (path: string) => boolean; read?: (path: string) => string } = {},
): RubricDoc[] {
  const exists = seams.exists ?? ((p: string) => existsSync(p));
  const read = seams.read ?? ((p: string) => readFileSync(p, "utf8"));
  const docs: RubricDoc[] = [];
  let bytes = 0;
  for (const name of RUBRIC_NAMES) {
    if (docs.length >= RUBRIC_MAX_FILES) break;
    const absolute = join(root, name);
    if (!exists(absolute)) continue;
    let text: string;
    try {
      text = read(absolute);
    } catch {
      // Unreadable document: skip it, never crash the gate on it.
      continue;
    }
    const budget = RUBRIC_MAX_BYTES - bytes;
    if (budget <= 0) break;
    const trimmed = text.trim();
    if (trimmed === "") continue;
    const encoded = Buffer.byteLength(trimmed, "utf8");
    if (encoded > budget) {
      // Walk back over UTF-8 continuation bytes like the shared truncator.
      const bytes2 = Buffer.from(trimmed, "utf8");
      let end = budget - Buffer.byteLength(RUBRIC_TRUNCATION_MARKER, "utf8");
      while (end > 0 && (bytes2[end]! & 0xc0) === 0x80) end -= 1;
      text = bytes2.subarray(0, end).toString("utf8") + RUBRIC_TRUNCATION_MARKER;
    } else {
      text = trimmed;
    }
    bytes += Buffer.byteLength(text, "utf8");
    docs.push({ path: name, text });
  }
  return docs;
}
