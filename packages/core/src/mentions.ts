import { readdir, readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

// #488 (vision note 3): file mentions. A user-typed `@path` token stays in
// the message text; the core attaches a snapshot of the file's content (or
// a directory's path listing) as a structured attachment riding the turn.
// `@` is UX sugar, never a bypass: read-permission rules gate every file
// snapshot, and a denied file produces a visible warning — never a silent
// drop and never a turn error.

/** ~200KB cap for text file snapshots; larger files attach truncated. */
export const MENTION_TEXT_CAP = 200 * 1024;
/** Safety cap for directory listings (entries). */
export const MENTION_DIR_ENTRY_CAP = 5000;

/** One structured attachment on a `user_message` event (#488). */
export type MentionAttachment =
  | {
      kind: "file";
      /** Path as written by the user (cwd-relative when under cwd). */
      path: string;
      /** Detected MIME type (best-effort extension map; binaries included). */
      mime: string;
      /** Content snapshot at send time (text; binaries keep raw bytes as base64). */
      content: string;
      /** True when the content was cut at MENTION_TEXT_CAP. */
      truncated: boolean;
    }
  | {
      kind: "directory";
      path: string;
      /** Recursive listing of relative paths only — no contents. */
      listing: string[];
      /** True when the listing was cut at MENTION_DIR_ENTRY_CAP. */
      truncated: boolean;
    };

/** A visible warning for a mention the core could not attach (#488). */
export interface MentionWarning {
  /** Path as written by the user. */
  path: string;
  /** Human-readable reason, e.g. "denied by rule" / "requires approval". */
  reason: string;
}

export interface ParsedMention {
  /** The raw token as it appears in the text, e.g. `@src/x.ts` or `@"a b.txt"`. */
  token: string;
  /** The path the token refers to (may be relative; resolve against cwd). */
  rawPath: string;
}

export interface ExpandedMention extends ParsedMention {
  /** Absolute path resolved against cwd. */
  absPath: string;
  /** Path relative to cwd when under it, else the absolute path. */
  displayPath: string;
  exists: boolean;
  isDirectory: boolean;
}

export interface ExpandMentionsResult {
  /** The message unchanged — mentions stay in the text (#488 decision). */
  text: string;
  mentions: ExpandedMention[];
}

const UNQUOTED_PATH = /[^\s,;:!)\]]+/;
const LEADING_PUNCT = /[.,;:]+$/;

/**
 * Parses `@path` mention tokens from message text. A token starts at `@`
 * when it begins the text or follows whitespace; paths with spaces use the
 * quoted form `@"my file.txt"`. Mentions stay in the text — the caller
 * decides what to attach (#488).
 */
export function parseMentions(text: string): ParsedMention[] {
  const mentions: ParsedMention[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@") continue;
    if (i > 0 && !/\s/.test(text[i - 1]!)) continue;
    if (text[i + 1] === '"') {
      const end = text.indexOf('"', i + 2);
      if (end === -1) continue;
      const rawPath = text.slice(i + 2, end);
      if (rawPath) mentions.push({ token: text.slice(i, end + 1), rawPath });
      i = end;
      continue;
    }
    const rest = text.slice(i + 1);
    const m = UNQUOTED_PATH.exec(rest);
    if (!m) continue;
    const rawPath = m[0].replace(LEADING_PUNCT, "");
    if (rawPath) mentions.push({ token: `@${m[0]}`, rawPath });
    i += m[0].length;
  }
  return mentions;
}

/** Resolves parsed mentions against cwd, annotating existence/kind. Duplicates (same resolved path) collapse to the first occurrence. */
export function expandMentions(text: string, cwd: string): ExpandMentionsResult {
  const mentions: ExpandedMention[] = [];
  const seen = new Set<string>();
  for (const { token, rawPath } of parseMentions(text)) {
    const absPath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
    if (seen.has(absPath)) continue;
    seen.add(absPath);
    let st = null;
    try {
      st = statSync(absPath);
    } catch {
      /* missing: kept, surfaced as a warning by assembly */
    }
    const rel = relative(cwd, absPath);
    mentions.push({
      token,
      rawPath,
      absPath,
      displayPath: rel && !rel.startsWith("..") ? rel : absPath,
      exists: st !== null,
      isDirectory: st?.isDirectory() ?? false,
    });
  }
  return { text, mentions };
}

/** Read-permission seam: "allow" attaches; anything else warns (#488 — @ is sugar, never a bypass). */
export type MentionCanRead = (absPath: string) => boolean;

export interface AssembleMentionsOptions {
  cwd: string;
  canRead?: MentionCanRead;
  /** Snapshot cap override (tests). */
  textCap?: number;
  /** Directory listing cap override (tests). */
  dirCap?: number;
}

export interface AssembleMentionsResult {
  /** The message with mentions left in place (#488 decision). */
  text: string;
  attachments: MentionAttachment[];
  warnings: MentionWarning[];
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".json": "application/json",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".js": "text/plain",
  ".jsx": "text/plain",
  ".txt": "text/plain",
};

/** Best-effort MIME from extension; unknown binaries default to application/octet-stream. */
export function mimeForPath(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function looksBinary(buf: Buffer): boolean {
  // Null-byte sniff: the cheap and reliable heuristic.
  return buf.subarray(0, 8000).includes(0);
}

/**
 * Assembles structured attachments for the mentions in `text` (#488).
 * Files snapshot their content at send time (text cap ~200KB, binaries
 * attach base64 with a detected mime); directories attach a recursive
 * path listing only. Every file is gated by `canRead` (read-permission
 * rules) — denied paths produce a visible warning, not an attachment.
 * Missing paths warn too. Mentions stay in the message text.
 */
export async function assembleMentions(text: string, options: AssembleMentionsOptions): Promise<AssembleMentionsResult> {
  const { textCap = MENTION_TEXT_CAP, dirCap = MENTION_DIR_ENTRY_CAP } = options;
  const { mentions } = expandMentions(text, options.cwd);
  const attachments: MentionAttachment[] = [];
  const warnings: MentionWarning[] = [];
  for (const mention of mentions) {
    if (!mention.exists) {
      warnings.push({ path: mention.displayPath, reason: "not found" });
      continue;
    }
    if (options.canRead && !options.canRead(mention.absPath)) {
      warnings.push({ path: mention.displayPath, reason: "denied by permission rule" });
      continue;
    }
    if (mention.isDirectory) {
      const { listing, truncated } = await listDirectory(mention.absPath, dirCap);
      attachments.push({ kind: "directory", path: mention.displayPath, listing, truncated });
      continue;
    }
    const mime = mimeForPath(mention.absPath);
    let buf: Buffer;
    try {
      buf = await readFile(mention.absPath);
    } catch (err) {
      warnings.push({ path: mention.displayPath, reason: `unreadable: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (looksBinary(buf)) {
      attachments.push({ kind: "file", path: mention.displayPath, mime, content: buf.toString("base64"), truncated: false });
      continue;
    }
    if (buf.length > textCap) {
      attachments.push({
        kind: "file",
        path: mention.displayPath,
        mime,
        content: `${buf.subarray(0, textCap).toString("utf8")}\n\n[truncated: file exceeds the ${textCap}-byte attachment cap]`,
        truncated: true,
      });
      continue;
    }
    attachments.push({ kind: "file", path: mention.displayPath, mime, content: buf.toString("utf8"), truncated: false });
  }
  return { text, attachments, warnings };
}

async function listDirectory(dir: string, cap: number): Promise<{ listing: string[]; truncated: boolean }> {
  const listing: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    if (listing.length >= cap) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // unreadable subtree: skipped, like `ls` would skip it
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (listing.length >= cap) return;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        listing.push(`${rel}/`);
        await walk(join(current, entry.name), rel);
      } else {
        listing.push(rel);
      }
    }
  };
  await walk(dir, "");
  return { listing, truncated: listing.length >= cap };
}

/** Renders one attachment as a provider-facing text block (multimodal blocks are vision note 4, out of scope). */
export function renderMentionAttachment(attachment: MentionAttachment): string {
  if (attachment.kind === "directory") {
    const suffix = attachment.truncated ? `\n[truncated at ${MENTION_DIR_ENTRY_CAP} entries]` : "";
    return `<attachment kind="directory" path="${attachment.path}">\n${attachment.listing.join("\n")}${suffix}\n</attachment>`;
  }
  const binary = attachment.mime !== "application/octet-stream" && !attachment.mime.startsWith("text/");
  const body = binary ? `[base64-encoded ${attachment.mime}] ${attachment.content}` : attachment.content;
  const suffix = attachment.truncated ? "\n[truncated at the attachment cap]" : "";
  return `<attachment kind="file" path="${attachment.path}" mime="${attachment.mime}">\n${body}${suffix}\n</attachment>`;
}
