/**
 * Shared model-picker plumbing (#181): the incremental filter and row
 * formatting used by both pickers — the `/model` modal (in-session,
 * ephemeral) and the Settings panel's per-endpoint default-model picker
 * (persistent, moh.json). Both receive an endpoint-aware catalog — one
 * list story for builtin and recognized openai-compat providers.
 */
import type { CatalogModel, LiveModelListing } from "@moh/core";

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

/** The context-window text of one row. ADR-0049, both doors: a model
 * whose window was declared — by a refusal this session (`declared`)
 * or by the endpoint's own listing (the row carries the overlay and
 * `shippedContextWindow` the figure it replaced) — shows **both**
 * numbers: the declared one first (it is the one every context decision
 * uses) and the catalog figure it replaced. A model that declared
 * nothing, or one whose declared number agrees with the catalog,
 * renders exactly as before. */
export function windowText(catalogWindow: number, declared?: number, shipped?: number): string {
  const effective = declared !== undefined && declared > 0 ? declared : catalogWindow;
  const replaced = declared !== undefined && declared > 0 && declared !== catalogWindow ? catalogWindow : shipped;
  if (replaced === undefined || replaced <= 0 || replaced === effective) return contextLabel(effective);
  return `${contextLabel(effective)} declared · ${contextLabel(replaced)} catalog`;
}

/** One list row: `name (id) · ctx Nk`, with the current-model marker. */
export function modelRow(m: CatalogModel, current?: boolean, declared?: number): string {
  const shipped = (m as PickerModel).shippedContextWindow;
  return `${m.name} (${m.id}) · ctx ${windowText(m.contextWindow, declared, shipped)}${current ? " ‹current›" : ""}`;
}

/** The free-text fallback row shown when the query misses the catalog
 * (or the endpoint has none — openai-compat, custom). */
export function freeTextRow(query: string): string {
  return `+ use "${query}" (free text)`;
}

/** One endpoint in a picker: its profile plus the model list to show —
 * a vendored catalog for builtin providers and recognized compat hosts
 * (e.g. Z.ai), a live `GET /models` fetch for other openai-compat
 * backends (#181 follow-up), or nothing (free text only). */
export interface EndpointPick {
  name: string;
  type: string;
  defaultModel?: string;
  baseUrl?: string;
  apiKey?: string;
  /** Catalog rows (vendored or fetched). Empty + no baseUrl = free-text only. */
  catalog: CatalogModel[];
}

/** One catalog row as the picker shows it: the entry plus, when the
 * endpoint's own listing declared a different window (#1032), the
 * shipped value it replaced — both numbers, wherever a window is shown
 * (ADR-0049). */
export interface PickerModel extends CatalogModel {
  /** The shipped catalog window this row's `contextWindow` replaced
   * (absent when the two agree or no listing declared one). */
  shippedContextWindow?: number;
}

/** Fetched model ids → picker rows (name = id, no metadata available). */
export function fetchedToCatalog(ids: string[]): CatalogModel[] {
  return ids.map((id) => ({ id, name: id, contextWindow: 0, reasoning: false }));
}

/** Merges a live listing (#551) into an endpoint's picker list.
 * Additive on identity: fetched-only models are appended. But where the
 * listing carries a window for an id moh ships (#1032), the endpoint's
 * own number wins on the row and the shipped value is kept aside — the
 * display then shows both (ADR-0049 door two). */
export function mergePickCatalog(base: CatalogModel[], live: LiveModelListing[]): PickerModel[] {
  const declared = new Map(live.filter((m) => typeof m.contextWindow === "number").map((m) => [m.id, m.contextWindow!]));
  const rows: PickerModel[] = base.map((m) => {
    const window = declared.get(m.id);
    if (window !== undefined && window !== m.contextWindow) {
      return { ...m, contextWindow: window, shippedContextWindow: m.contextWindow };
    }
    return { ...m };
  });
  const seen = new Set(base.map((m) => m.id));
  return [
    ...rows,
    ...live
      .filter((m) => !seen.has(m.id))
      .map((m) => ({ id: m.id, name: m.name ?? m.id, contextWindow: m.contextWindow ?? 0, reasoning: false })),
  ];
}

/** Context window for an active-model label (`endpointName/modelId`,
 * the `session.activeModel` / `model_call_start.model` shape) from the
/** Context window for an active-model label (`endpointName/modelId`,
 * the `session.activeModel` / `model_call_start.model` shape) from the
 * endpoints' catalogs — the merged rows carry the declared window where
 * the endpoint's listing declared one (#1032). 0 when the endpoint or
 * model is unknown — openai-compat backends have no vendored catalog,
 * so callers treat 0 as "use the default". */
export function contextWindowForLabel(
  picks: EndpointPick[],
  modelLabel: string,
  /** ADR-0049 door one: the session's declared windows — the number a
   * refusal taught outranks even the listing overlay, for every
   * window-derived figure on screen (the footer's gauge denominator
   * included). */
  declaredFor?: (ref: string) => number | undefined,
): number {
  const slash = modelLabel.indexOf("/");
  if (slash < 0) return 0;
  const name = modelLabel.slice(0, slash);
  const modelId = modelLabel.slice(slash + 1);
  const declared = declaredFor?.(modelLabel);
  if (declared !== undefined && declared > 0) return declared;
  const pick = picks.find((p) => p.name === name);
  return pick?.catalog.find((m) => m.id === modelId)?.contextWindow ?? 0;
}
