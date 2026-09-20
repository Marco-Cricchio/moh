/**
 * Deterministic rubric discovery (#789, spec §2): the convention
 * documents a project actually ships, read off disk — never invented.
 *
 * Golden rule (TypeSafe skill guidance): this module owns the name list,
 * the caps and the read order. Extending the list is a one-line change to
 * `RUBRIC_NAMES`. No match means the quality gate is **inert**: a repo
 * without convention docs gets silence, never synthesized criteria.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { truncateToBytes } from "./routing";

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
 * the caps bind. The `.cursor/rules/` directory (any `*.mdc`/`*.md` file
 * under it) is appended after the fixed names, in sorted order.
 * `exists`/`read`/`listCursorRules` are test seams.
 */
export function discoverRubrics(
  root: string,
  seams: {
    exists?: (path: string) => boolean;
    read?: (path: string) => string;
    listCursorRules?: (dir: string) => string[];
  } = {},
): RubricDoc[] {
  const exists = seams.exists ?? ((p: string) => existsSync(p));
  const read = seams.read ?? ((p: string) => readFileSync(p, "utf8"));
  const listCursorRules =
    seams.listCursorRules ??
    ((dir: string) => {
      try {
        return readdirSync(dir).filter((f) => f.endsWith(".mdc") || f.endsWith(".md")).sort();
      } catch {
        return [];
      }
    });
  const candidates: string[] = [...RUBRIC_NAMES];
  const cursorDir = join(root, ".cursor", "rules");
  for (const f of listCursorRules(cursorDir)) candidates.push(join(".cursor", "rules", f));
  const docs: RubricDoc[] = [];
  let bytes = 0;
  for (const name of candidates) {
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
    text =
      encoded > budget
        ? truncateToBytes(trimmed, budget - Buffer.byteLength(RUBRIC_TRUNCATION_MARKER, "utf8")) +
          RUBRIC_TRUNCATION_MARKER
        : trimmed;
    bytes += Buffer.byteLength(text, "utf8");
    docs.push({ path: name, text });
  }
  return docs;
}
