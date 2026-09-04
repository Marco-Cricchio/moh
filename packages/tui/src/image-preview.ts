/**
 * Inline image preview (vision note 4 / #490): kitty graphics protocol and
 * iTerm2 inline images, with a plain-text chip fallback. Place-once: an
 * image is emitted into the terminal scrollback exactly once, at its point
 * in the transcript; kitty placement ids mitigate repaint duplication.
 * Detection is environment-based only — never capability queries, never
 * blind attempts.
 */
import { imageDimensions } from "@moh/core";

/** `images.preview` setting: `auto` renders pixels only when the
 * environment supports them; `off` always degrades to the chip. */
export type ImagePreviewSetting = "auto" | "on" | "off";

export type ImagePreviewMode =
  | { protocol: "kitty" }
  | { protocol: "iterm2" }
  | { protocol: "none" };

/** One detection result per environment, memoized by the caller. */
export function detectPreviewMode(
  env: Record<string, string | undefined>,
  setting: ImagePreviewSetting,
): ImagePreviewMode {
  if (setting === "off") return { protocol: "none" };
  const termProgram = env.TERM_PROGRAM ?? "";
  if (env.KITTY_WINDOW_ID || env.GHOSTTY_RESOURCES_DIR) return { protocol: "kitty" };
  if (termProgram === "iTerm.app" || termProgram === "WezTerm" || env.MINTTY_SHORTCUT) {
    return { protocol: "iterm2" };
  }
  if (setting === "on") {
    // Explicit opt-in: trust the user over an unrecognized environment —
    // still without blind queries; we just pick the wider-compatibility
    // iTerm2 sequence (WezTerm/mintty/conemu-lineage understand it).
    return { protocol: "iterm2" };
  }
  return { protocol: "none" };
}

export interface PreviewImage {
  name: string;
  mime: string;
  /** Raw bytes, base64. */
  base64: string;
  width?: number;
  height?: number;
}

/** Cell geometry for the emission (caller reads the live stdout size). */
export interface PreviewCell {
  columns: number;
  rows: number;
  /** Cell pixel size when known (kitty reports it); 0 = unknown. */
  cellWidth: number;
  cellHeight: number;
}

/** The universal persistent text marker — always part of the text flow. */
export function imageChip(image: { name: string; width?: number; height?: number }): string {
  const dims = image.width && image.height ? ` ${image.width}x${image.height}` : "";
  return `[image: ${image.name}${dims}]`;
}

/**
 * The escape sequence for one inline image, or null when the mode is
 * `none`. Kitty uses the graphics protocol with a placement id so a later
 * repaint can delete the placement (mitigating the known place-once
 * duplicate); iTerm2 uses OSC 1337. The trailing newline is NOT included —
 * the caller owns row layout.
 */
export function emitImage(
  image: PreviewImage,
  mode: ImagePreviewMode,
  cell: PreviewCell,
  placementId: number,
): string | null {
  if (mode.protocol === "none") return null;
  const dims = imageDimensions(Buffer.from(image.base64, "base64"), image.mime);
  const width = image.width ?? dims.width;
  const height = image.height ?? dims.height;
  if (mode.protocol === "kitty") {
    const cols = fitCells(width, height, cell, c => c.columns);
    const rows = fitCells(width, height, cell, c => c.rows);
    const head = `\x1b_Gf=1,a=T,p=${placementId},${gridArgs(width, height, cols, rows)};${image.base64}\x1b\\`;
    // Large payloads must be chunked at 4096 bytes with m=1 continuation.
    if (head.length <= 4200) return head;
    return chunkKitty(placementId, image.base64, width, height, cols, rows);
  }
  const scale = itermSize(width, height, cell);
  return `\x1b]1337;File=name=${b64(image.name)};size=${image.base64.length};inline=1${scale};preserveAspectRatio=1:${b64(image.base64)}\x07`;
}

function gridArgs(width?: number, height?: number, cols?: number, rows?: number): string {
  const parts: string[] = [];
  if (width) parts.push(`s=${width}`);
  if (height) parts.push(`v=${height}`);
  if (cols) parts.push(`c=${cols}`);
  if (rows) parts.push(`r=${rows}`);
  return parts.join(",");
}

function chunkKitty(placementId: number, base64: string, width?: number, height?: number, cols?: number, rows?: number): string {
  const parts: string[] = [];
  const payload = base64;
  const size = 4096;
  for (let i = 0; i < payload.length; i += size) {
    const last = i + size >= payload.length;
    const mid = last ? "" : "m=1,";
    parts.push(`\x1b_Gf=1,a=T,p=${placementId},${mid}${gridArgs(width, height, cols, rows)};${payload.slice(i, i + size)}\x1b\\`);
  }
  return parts.join("");
}

function fitCells(width: number | undefined, height: number | undefined, cell: PreviewCell, pick: (c: PreviewCell) => number): number | undefined {
  if (!width || !height) return undefined;
  if (cell.cellWidth > 0 && cell.cellHeight > 0) {
    const cols = Math.ceil(width / cell.cellWidth);
    const rows = Math.ceil(height / cell.cellHeight);
    const maxCols = Math.max(1, cell.columns - 2);
    const maxRows = Math.max(1, Math.floor(cell.rows / 2));
    if (cols <= maxCols && rows <= maxRows) return cols;
    const scale = Math.min(maxCols / cols, maxRows / rows);
    return Math.max(1, Math.floor(cols * scale));
  }
  return pick(cell);
}

function itermSize(width: number | undefined, height: number | undefined, cell: PreviewCell): string {
  if (!width || !height || cell.cellWidth <= 0) return "";
  const maxPxW = Math.max(1, cell.columns - 2) * cell.cellWidth;
  const maxPxH = Math.max(1, Math.floor(cell.rows / 2)) * cell.cellHeight;
  const scale = Math.min(1, maxPxW / width, maxPxH / height);
  return `;width=${Math.round(width * scale)}px;height=${Math.round(height * scale)}px`;
}

function b64(s: string): string {
  return Buffer.from(s, "binary").toString("base64");
}

/** Kitty delete-on-repaint: removes a placement so a Static re-emission of
 * the citing row does not duplicate pixels. No-op on other protocols. */
export function deletePlacement(placementId: number, mode: ImagePreviewMode): string {
  return mode.protocol === "kitty" ? `\x1b_Ga=d,p=${placementId}\x1b\\` : "";
}
