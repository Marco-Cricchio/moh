/**
 * Shared model-picker plumbing (#181): the incremental filter and row
 * formatting used by both pickers — the `/model` modal (in-session,
 * ephemeral) and the Settings panel's per-endpoint default-model picker
 * (persistent, moh.json). Both read the same `subscriptionModelCatalog`
 * (#156/#164) — one list story.
 */
import type { CatalogModel } from "@moh/core";

/** One pickable row: a catalog entry or the free-text fallback. */
export type PickerRow =
  | { kind: "catalog"; model: CatalogModel }
  | { kind: "free"; query: string };

/**
 * Incremental filter over a catalog (#181): case-insensitive substring
 * on name or id first, subsequence ("fuzzy") on id as the fallback.
 * Keeps the catalog's own order (the provider's preference); the
 * free-text row is appended by the caller, not here.
 */
export function filterCatalog(models: CatalogModel[], query: string): CatalogModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  const substr = models.filter(
    (m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
  );
  if (substr.length > 0) return substr;
  return models.filter((m) => isSubsequence(q, m.id.toLowerCase()));
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}

/** Human context-window label ("200k", "—"). */
export function contextLabel(contextWindow: number): string {
  return contextWindow > 0 ? `${Math.round(contextWindow / 1000)}k` : "—";
}

/** One list row: `name (id) · ctx Nk`, with the current-model marker. */
export function modelRow(m: CatalogModel, current?: boolean): string {
  return `${m.name} (${m.id}) · ctx ${contextLabel(m.contextWindow)}${current ? " ‹current›" : ""}`;
}

/** The free-text fallback row shown when the query misses the catalog
 * (or the endpoint has none — openai-compat, custom). */
export function freeTextRow(query: string): string {
  return `+ use "${query}" (free text)`;
}
