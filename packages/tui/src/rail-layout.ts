/**
 * #1218: the extensions rail's geometry, as pure functions — the grilling
 * decisions on the per-extension panel model (ADR-0062, as amended).
 *
 * The rail no longer draws one enclosing frame: each panel is its own
 * bordered box, and the vertical space between the terminal top and the
 * composer's top line is distributed equally across panels — computed on
 * real space, not nominal. A panel demanding less than its share takes
 * only its demand; the leftover is never backfilled. The composer floor
 * is guaranteed by construction: `available` is what remains after the
 * composer frame and the footer are subtracted, and allocation never
 * exceeds it.
 */

/** The rail column's width (matches the panel prototype's measure). */
export const RAIL_WIDTH = 38;
/** Below this many available rows the rail collapses to the names strip —
 * the vertical grammar of the ≤80-column narrow rule, applied to height. */
export const RAIL_MIN_ROWS = 10;
/** Composer frame: the separator above, the composer, the separator below. */
export const COMPOSER_FRAME_ROWS = 3;
/** Footer: two status rows + the key row (2, with its margin) + the blank
 * separator between the composer frame and the footer. */
export const FOOTER_BASE_ROWS = 5;
/** The subagent chips row costs one more footer row when subagents exist. */
export const SUBAGENT_CHIP_ROWS = 1;
/** Past this share of the rail's available height, a declared maxHeight is
 * an overlay job — /extensions says so instead of refusing (ADR-0062). */
export const OVERLAY_ADVICE_SHARE = 0.6;

/** Rows the rail may distribute: what is left under the composer floor. */
export function railAvailableRows(viewportRows: number, subagentChips: number): number {
  const footer = FOOTER_BASE_ROWS + (subagentChips > 0 ? SUBAGENT_CHIP_ROWS : 0);
  return Math.max(0, viewportRows - COMPOSER_FRAME_ROWS - footer);
}

/**
 * Equal-share distribution with no backfill: each panel's height is its
 * demand, capped by the share of the space left after every panel's chrome
 * (border pair + the blank row between panels) is paid for.
 */
export function distribute(available: number, demands: number[]): number[] {
  if (demands.length === 0) return [];
  const chrome = demands.length * 2 + (demands.length - 1);
  const share = Math.max(1, Math.floor(Math.max(0, available - chrome) / demands.length));
  return demands.map((d) => Math.max(1, Math.min(d, share)));
}

export interface PanelAllocation {
  /** Content rows: the header row plus the drawable body. */
  height: number;
  /** Rows of body the panel may draw (height minus the header row). */
  body: number;
  /** Content rows demanded: header + min(render, declared maxHeight). */
  demand: number;
  /** The share cap cut the demand — the amber `of D` header marker. */
  shareCapped: boolean;
  /** A declared maxHeight cut the demand — the `·max N → n (clamped)` marker. */
  maxClamped: boolean;
}

/** Allocates every panel of a rail in one pass: hybrid demand (#1218
 * decision 1) — `demand = header + min(render, maxHeight ?? ∞)` — then the
 * equal-share cap from `distribute`, no backfill. The header row rides
 * inside each panel's content rows. */
export function allocatePanels(
  available: number,
  natural: number[],
  maxHeights: (number | undefined)[],
): PanelAllocation[] {
  const demands = natural.map((n, i) => 1 + Math.min(n, maxHeights[i] ?? Infinity));
  const heights = distribute(available, demands);
  return heights.map((height, i) => ({
    height,
    body: Math.max(0, height - 1),
    demand: demands[i]!,
    shareCapped: demands[i]! > height,
    maxClamped: (maxHeights[i] ?? Infinity) < natural[i]!,
  }));
}

/** The client-drawn header (#1218 decision 4): identity + real allocation,
 * counted in drawable body rows. `·Nr (P%)` always; ` of D` only when the
 * share cap cut the demand; the clamp marker when a declared maxHeight is
 * doing the cutting. */
export function allocationHeader(
  name: string,
  extension: string,
  allocation: PanelAllocation,
  available: number,
): { plain: string; amber: string } {
  const pct = available > 0 ? Math.round((allocation.height / available) * 100) : 0;
  let plain = ` ${name} ${extension} `;
  let amber = `·${allocation.body}r (${pct}%)`;
  if (allocation.shareCapped) amber += ` of ${allocation.demand - 1}`;
  if (allocation.maxClamped) amber += ` ·max ${maxHeightOf(allocation)} → ${allocation.body} (clamped)`;
  return { plain, amber };
}

function maxHeightOf(allocation: PanelAllocation): number {
  // A max-clamped panel's declared value is the demand it was cut to.
  return allocation.demand - 1;
}

/** #1218 decision 2: a declared maxHeight past the overlay-advice share of
 * the available height should be a full-screen overlay — advise, never refuse. */
export function suggestOverlay(maxHeight: number, available: number): boolean {
  return available > 0 && maxHeight > available * OVERLAY_ADVICE_SHARE;
}
