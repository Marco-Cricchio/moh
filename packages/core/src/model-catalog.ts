/**
 * Vendored model catalogs for subscription providers (#156): the
 * post-login model list the wizard shows. Data files are verbatim
 * copies of pi-ai's auto-generated catalogs (MIT — see
 * model-catalogs/README.md for attribution and the regeneration
 * script); this module flattens them into a per-provider list.
 *
 * Deliberately read-only and static: no pi-ai runtime dependency, no
 * network fetch — the catalog ships with the package and is versioned
 * in the repo (issue #156 owner decision).
 */
import anthropicJson from "./model-catalogs/anthropic.json";
import openaiCodexJson from "./model-catalogs/openai-codex.json";
import googleJson from "./model-catalogs/google.json";

/** One selectable model in a subscription catalog. */
export interface CatalogModel {
  /** The model id to persist as `defaultModel`. */
  id: string;
  /** Human label for the picker. */
  name: string;
  contextWindow: number;
  reasoning: boolean;
}

/** The pi-ai catalog shape: `{ <api>: { <modelId>: entry } }`. */
type PiAiCatalog = Record<string, Record<string, PiAiEntry>>;
interface PiAiEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
}

function collect(catalog: PiAiCatalog): CatalogModel[] {
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const api of Object.values(catalog)) {
    for (const entry of Object.values(api)) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push({
        id: entry.id,
        name: entry.name ?? entry.id,
        contextWindow: entry.contextWindow ?? 0,
        reasoning: entry.reasoning ?? false,
      });
    }
  }
  return out;
}

const CATALOGS: Record<"anthropic" | "openai" | "google", CatalogModel[]> = {
  anthropic: collect(anthropicJson),
  openai: collect(openaiCodexJson),
  google: collect(googleJson),
};

/** Providers that have a vendored subscription catalog. */
export type CatalogProviderType = keyof typeof CATALOGS;

/**
 * The post-login model list for a subscription provider. Unknown types
 * (openai-compat, custom) get an empty list — the wizard falls back to
 * free-text entry (acceptance: subscription onboarding never *requires*
 * the list, but never requires typing when one exists).
 */
export function subscriptionModelCatalog(type: string): CatalogModel[] {
  return (CATALOGS as Record<string, CatalogModel[]>)[type] ?? [];
}
