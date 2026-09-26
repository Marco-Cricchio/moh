/**
 * ADR-0046 (#959): the model-catalog builder — the pure half of the
 * generation pipeline. The CLI half
 * (`packages/core/scripts/build-model-catalogs.ts`) fetches the two
 * aggregators and writes files; everything decidable lives here, so the
 * join, the unit conversions, the override merge, the guards, the
 * manifest and the report are testable without network or disk.
 *
 * The pipeline is declared, never deduced:
 *
 * - **Rows** come from the hand-maintained sidecar (`<provider>.overrides.json`,
 *   next to the catalog): the sidecar is the only authored surface. A row
 *   that is not declared there does not exist, and a committed row that the
 *   sidecar omits fails generation.
 * - **Value fields** (`cost`, `contextWindow`, `maxTokens`, `reasoning`,
 *   `input`) come from the aggregators where they cover the row, in the
 *   declared precedence: models.dev first (the namespaces the sidecar names,
 *   in order), then OpenRouter (exact id, declared vendor prefixes, then the
 *   namespaced-id join). An override always wins over an aggregator.
 * - **moh-owned fields** (`name`, `api`, `provider`, `baseUrl`,
 *   `thinkingLevelMap`, `compat`, `headers`) are never aggregator-supplied:
 *   they are labels and capability declarations moh owns (upstream display
 *   names are noisier — "OpenAI: GPT-5.4" — and would silently relabel the
 *   picker). `api` is the wire a row is filed under, so it also drives the
 *   output grouping.
 * - **Units**: models.dev `cost` is USD per 1M tokens as numbers; OpenRouter
 *   `pricing` is USD per token as strings. The conversion lives here, once
 *   (×1e6, string→number, rounded) — a naive copy is wrong by six orders of
 *   magnitude.
 * - **Billing plans** (ADR-0046): a sidecar may declare `source.plan` — the
 *   namespace(s) supplying the subscription-plan pricing entry of the same
 *   row (`planCost`). The metered entry stays `cost`.
 */
import type { ModelPricing, ModelPricingTier } from "./model-catalog";

/** The `{ <api>: { <id>: row } }` shape of a catalog file. */
export type CatalogFileJson = Record<string, Record<string, CatalogRowJson>>;

/** One catalog row as written to disk. `cost` is the metered entry (the
 * default one); `planCost` is the subscription-plan entry when the row has
 * one (ADR-0046 billing plan). */
export interface CatalogRowJson {
  id: string;
  name?: string;
  api?: string;
  provider?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: ModelPricing;
  planCost?: ModelPricing;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** The value fields an aggregator may supply — the ones the coverage
 * guards count. `name` is deliberately absent: labels are moh-owned. */
export const AGGREGATOR_FIELDS = ["cost", "contextWindow", "maxTokens", "reasoning", "input"] as const;
export type AggregatorField = (typeof AGGREGATOR_FIELDS)[number];

/** The fields an override may declare. Every one of them wins over the
 * aggregator value for the same row (ADR-0046: an override always wins). */
/** The value fields a row carries, in declaration order: the ones the
 * provenance and the coverage counts speak about (`AGGREGATOR_FIELDS` plus
 * the plan entry). */
export const ROW_VALUE_FIELDS = [...AGGREGATOR_FIELDS, "planCost"] as const;

export const OVERRIDE_FIELDS = [
  "api",
  "provider",
  "baseUrl",
  "name",
  "reasoning",
  "input",
  "cost",
  "planCost",
  "contextWindow",
  "maxTokens",
  "thinkingLevelMap",
  "compat",
  "headers",
] as const;

export interface ModelsDevCostTier {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  tier?: { type?: string; size?: number };
}

export interface ModelsDevRecord {
  id?: string;
  name?: string;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    tiers?: ModelsDevCostTier[];
  };
  limit?: { context?: number; output?: number };
  reasoning?: boolean;
  modalities?: { input?: string[] };
  base_model?: string | null;
}

/** `https://models.dev/api.json` — provider namespace → its models. */
export type ModelsDevSnapshot = Record<string, { models?: Record<string, ModelsDevRecord> }>;

export interface OpenRouterRecord {
  id?: string;
  name?: string;
  context_length?: number;
  pricing?: Record<string, string>;
  architecture?: { input_modalities?: string[] };
  supported_parameters?: string[];
  top_provider?: { context_length?: number };
}

/** `https://openrouter.ai/api/v1/models`. */
export interface OpenRouterSnapshot {
  data?: OpenRouterRecord[];
}

export interface AggregatorSnapshots {
  modelsDev: ModelsDevSnapshot;
  openRouter: OpenRouterSnapshot;
}

/** Where one catalog file's rows may be matched, and where its
 * subscription-plan entry comes from. */
export interface CatalogSourceSpec {
  /** models.dev namespaces this catalog mirrors, in precedence order. */
  modelsDev?: readonly string[];
  /** OpenRouter vendor prefixes for the `<vendor>/<id>` join. The exact-id
   * and namespaced-id joins need no declaration. */
  openRouter?: readonly string[];
  /** ADR-0046 billing plan: the namespace(s) supplying `planCost`. */
  plan?: CatalogSourceSpec;
}

/** One hand-maintained row: the declaration plus every moh-owned field and
 * every correction on top of aggregator data. `author`, `date` and `reason`
 * are the audit trail — who declared it, when, and why. */
export interface CatalogRowOverride {
  author: string;
  date: string;
  reason: string;
  api?: string;
  provider?: string;
  baseUrl?: string;
  name?: string;
  reasoning?: boolean;
  input?: readonly string[];
  cost?: ModelPricing;
  planCost?: ModelPricing;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** The declared escape hatch of the contextWindow guard: the aggregator's
   * smaller window is accepted for this row instead of frozen at the
   * committed value. */
  acceptContextShrink?: true;
}

/** `<provider>.overrides.json` — the whole hand-maintained region of one
 * catalog file. */
export interface CatalogOverrides {
  schemaVersion: number;
  provider: string;
  source: CatalogSourceSpec;
  /** Defaults for every row of the file; a row may override each of them. */
  file?: { api?: string; provider?: string; baseUrl?: string };
  rows: Record<string, CatalogRowOverride>;
}

export interface BuildIssue {
  level: "error" | "warning";
  code: string;
  provider: string;
  id?: string;
  message: string;
}

/** One migration note, reported so a reviewer sees every row where the
 * sidecar had to carry something the aggregators cannot supply. */
export interface MigrationNote {
  provider: string;
  id: string;
  code:
    | "absent-row"
    | "metered-rate-kept"
    | "context-shrink-accepted"
    | "field-carried"
    | "label-filled"
    | "pricing-sentinel-dropped";
  message: string;
}

/** Per-row provenance, recorded in the manifest (ADR-0046). */
export interface RowProvenance {
  verdict: "exact" | "base-model" | "ambiguous" | "absent";
  source?: "models.dev" | "openrouter";
  namespace?: string;
  /** Value fields the aggregator supplied. */
  supplied: AggregatorField[];
  plan?: { source: "models.dev" | "openrouter"; namespace?: string };
  /** Value fields the sidecar declared instead of, or on top of, the
   * aggregator. Row identity and labels (`api`, `provider`, `baseUrl`,
   * `name`) are declarations, not provenance, and are not listed. */
  overrides: Array<AggregatorField | "planCost">;
}

export interface BuiltCatalog {
  provider: string;
  file: CatalogFileJson;
  /** Deterministic serialization — the bytes the generator writes. */
  json: string;
  rows: Record<string, RowProvenance>;
  verdicts: Record<string, number>;
  issues: BuildIssue[];
  /** Rows whose upstream window is smaller than the committed one and whose
   * sidecar accepts the correction (`acceptContextShrink`). */
  shrinkAccepted: string[];
  /** Cross-source context differences, informational (ADR-0046 report). */
  crossSourceContextDiffs: Array<{ id: string; modelsDev: number; openRouter: number }>;
}

export interface SourceSnapshotInfo {
  name: string;
  url: string;
  fetchedAt: string;
}

export interface CatalogManifest {
  schemaVersion: number;
  version: string;
  generatedAt: string;
  sources: SourceSnapshotInfo[];
  files: Record<string, { sha256: string; rows: number; verdicts: Record<string, number> }>;
  rows: Record<string, RowProvenance & { provider: string; id: string }>;
}

/** The row fields, in the order the generator writes them. */
const ROW_FIELD_ORDER: (keyof CatalogRowJson)[] = [
  "id",
  "name",
  "api",
  "provider",
  "baseUrl",
  "reasoning",
  "thinkingLevelMap",
  "input",
  "cost",
  "planCost",
  "contextWindow",
  "maxTokens",
  "compat",
  "headers",
];

/** moh's input-modality vocabulary. Upstream modalities are projected onto
 * it (`pdf`/`video`/`audio` describe content moh cannot send, and copying
 * them would claim a capability the client does not have); order is kept. */
const MODALITIES = ["text", "image"] as const;

/** Converts a models.dev `cost` (USD/1M, snake_case) into a `ModelPricing`.
 * Returns undefined for a record without a cost object. */
export function modelsDevPricing(cost: ModelsDevRecord["cost"]): ModelPricing | undefined {
  if (!cost) return undefined;
  const pricing: ModelPricing = { input: cost.input ?? 0, output: cost.output ?? 0 };
  if (cost.cache_read !== undefined) pricing.cacheRead = cost.cache_read;
  if (cost.cache_write !== undefined) pricing.cacheWrite = cost.cache_write;
  const tiers: ModelPricingTier[] = [];
  for (const tier of cost.tiers ?? []) {
    // models.dev carries `tiers` and the legacy `context_over_200k` together
    // (always, in the current snapshot): converting the structured form only
    // means a tier never lands twice.
    if (tier.tier?.type !== "context" || typeof tier.tier.size !== "number") continue;
    const converted: ModelPricingTier = {
      inputTokensAbove: tier.tier.size,
      input: tier.input ?? 0,
      output: tier.output ?? 0,
    };
    if (tier.cache_read !== undefined) converted.cacheRead = tier.cache_read;
    if (tier.cache_write !== undefined) converted.cacheWrite = tier.cache_write;
    tiers.push(converted);
  }
  if (tiers.length > 0) pricing.tiers = tiers;
  return pricing;
}

/** Converts OpenRouter `pricing` (USD per token, strings) into USD per 1M
 * numbers. Rounded to six decimals so the ×1e6 never leaves float dust
 * (`0.19999999999999998`) in the committed data. A negative value is
 * OpenRouter's variable-pricing sentinel (`-1` on the `auto` routers), never
 * a rate — the same "unknown, not free" rule as a zero-only record. */
export function openRouterPricing(pricing: OpenRouterRecord["pricing"]): ModelPricing | undefined {
  if (!pricing) return undefined;
  const perMillion = (key: string): number | undefined => {
    const raw = pricing[key];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return undefined;
    return Math.round(value * 1e6 * 1e6) / 1e6;
  };
  const input = perMillion("prompt");
  const output = perMillion("completion");
  if (input === undefined && output === undefined) return undefined;
  const converted: ModelPricing = { input: input ?? 0, output: output ?? 0 };
  const cacheRead = perMillion("input_cache_read");
  const cacheWrite = perMillion("input_cache_write");
  if (cacheRead !== undefined) converted.cacheRead = cacheRead;
  if (cacheWrite !== undefined) converted.cacheWrite = cacheWrite;
  return converted;
}

/** Projects upstream input modalities onto moh's vocabulary. */
export function projectModalities(input: readonly string[] | undefined): string[] | undefined {
  if (!input) return undefined;
  const projected = MODALITIES.filter((modality) => input.includes(modality));
  return projected.length > 0 ? [...projected] : undefined;
}

interface Match {
  source: "models.dev" | "openrouter";
  namespace?: string;
  record: ModelsDevRecord | OpenRouterRecord;
  /** "exact" when the record carries the row id itself; "base-model" when
   * it was reached through a join key (`base_model`, a vendor prefix or the
   * namespaced id); "ambiguous" when another declared source matches the
   * same row with different base rates (the census's fourth verdict, #953) —
   * the declared precedence still decides the value, the verdict makes the
   * conflict visible. */
  verdict: "exact" | "base-model" | "ambiguous";
}

/** Finds the aggregator record for one row id: models.dev namespaces in
 * declared order (exact id, then `base_model`), then OpenRouter (exact id,
 * declared vendor prefixes, then the namespaced-id join — a unique
 * candidate only; several candidates are ambiguous, never guessed). */
function findRecord(
  id: string,
  spec: CatalogSourceSpec,
  snapshots: AggregatorSnapshots,
  issues: BuildIssue[],
  provider: string,
): Match | undefined {
  for (const namespace of spec.modelsDev ?? []) {
    const models = snapshots.modelsDev[namespace]?.models ?? {};
    if (models[id]) return { source: "models.dev", namespace, record: models[id]!, verdict: "exact" };
  }
  // models.dev `base_model`: a record of a declared namespace pointing at
  // this id as its canonical model (the ADR's second join key).
  for (const namespace of spec.modelsDev ?? []) {
    const models = snapshots.modelsDev[namespace]?.models ?? {};
    for (const record of Object.values(models)) {
      if (record.base_model === id) return { source: "models.dev", namespace, record, verdict: "base-model" };
    }
  }

  const candidates = openRouterCandidates(id, spec, snapshots);
  if (candidates.length > 1) {
    issues.push({
      level: "warning",
      code: "ambiguous-openrouter-match",
      provider,
      id,
      message: `openrouter has ${candidates.length} records matching this id (${candidates.map((c) => c.id).join(", ")}) — declare the vendor prefix in the sidecar`,
    });
    return undefined;
  }
  if (candidates.length === 1) {
    const record = candidates[0]!;
    return {
      source: "openrouter",
      namespace: record.id,
      record,
      verdict: record.id === id ? "exact" : "base-model",
    };
  }
  return undefined;
}

/** Every OpenRouter record that can legitimately stand for one row id: the
 * exact id, the declared `<vendor>/<id>` forms, and — the ADR's
 * namespaced-id join — any record whose model part is this id. */
function openRouterCandidates(id: string, spec: CatalogSourceSpec, snapshots: AggregatorSnapshots): OpenRouterRecord[] {
  const out = new Map<string, OpenRouterRecord>();
  for (const record of snapshots.openRouter.data ?? []) {
    const recordId = record.id ?? "";
    if (!recordId) continue;
    const declaredVendor = (spec.openRouter ?? []).some((vendor) => recordId === `${vendor}/${id}`);
    const modelPart = recordId.includes("/") ? recordId.slice(recordId.indexOf("/") + 1) : recordId;
    if (recordId === id || declaredVendor || modelPart === id) out.set(recordId, record);
  }
  return [...out.values()];
}

/** Whether two records of the SAME source match the row with different
 * rates — the census's ambiguity test (#953): models.dev and OpenRouter
 * disagreeing is a cross-source difference, resolved by the declared
 * precedence and reported as such, while two records of one source
 * disagreeing is a genuine conflict. */
function sameSourceConflict(
  id: string,
  spec: CatalogSourceSpec,
  snapshots: AggregatorSnapshots,
  winner: Match,
  winnerCost: ModelPricing | undefined,
): boolean {
  if (winner.source !== "models.dev") return false;
  // The plan namespaces are models.dev too: the five ambiguous zai rows are
  // exactly a `zai` record and a `zai-coding-plan` record that disagree.
  const namespaces = [...(spec.modelsDev ?? []), ...(spec.plan?.modelsDev ?? [])];
  for (const namespace of namespaces) {
    if (namespace === winner.namespace) continue;
    const record = snapshots.modelsDev[namespace]?.models?.[id];
    const other = modelsDevPricing(record?.cost);
    if (!other || !winnerCost) continue;
    if (winnerCost.input !== other.input || winnerCost.output !== other.output) return true;
  }
  return false;
}

/** The aggregator-supplied value fields of one record. */
function suppliedFields(
  record: ModelsDevRecord | OpenRouterRecord,
  source: "models.dev" | "openrouter",
): { fields: Partial<CatalogRowJson>; supplied: AggregatorField[] } {
  const fields: Partial<CatalogRowJson> = {};
  const supplied: AggregatorField[] = [];
  if (source === "models.dev") {
    const md = record as ModelsDevRecord;
    const cost = modelsDevPricing(md.cost);
    if (cost) {
      fields.cost = cost;
      supplied.push("cost");
    }
    if (md.limit?.context) {
      fields.contextWindow = md.limit.context;
      supplied.push("contextWindow");
    }
    if (md.limit?.output) {
      fields.maxTokens = md.limit.output;
      supplied.push("maxTokens");
    }
    if (typeof md.reasoning === "boolean") {
      fields.reasoning = md.reasoning;
      supplied.push("reasoning");
    }
    const input = projectModalities(md.modalities?.input);
    if (input) {
      fields.input = input;
      supplied.push("input");
    }
    return { fields, supplied };
  }
  const or = record as OpenRouterRecord;
  const cost = openRouterPricing(or.pricing);
  if (cost) {
    fields.cost = cost;
    supplied.push("cost");
  }
  const context = or.context_length ?? or.top_provider?.context_length;
  if (context) {
    fields.contextWindow = context;
    supplied.push("contextWindow");
  }
  if (or.supported_parameters?.some((parameter) => parameter.includes("reasoning"))) {
    fields.reasoning = true;
    supplied.push("reasoning");
  }
  const input = projectModalities(or.architecture?.input_modalities);
  if (input) {
    fields.input = input;
    supplied.push("input");
  }
  // OpenRouter declares no output limit — `maxTokens` is models.dev-only
  // (ADR-0046 per-field supply), so a row covered only by OpenRouter keeps
  // the hand-maintained value.
  return { fields, supplied };
}

/** Writes the row with a stable field order, dropping undefined values. */
function reorderRow(row: CatalogRowJson): CatalogRowJson {
  const out: Record<string, unknown> = {};
  for (const field of ROW_FIELD_ORDER) {
    const value = row[field];
    if (value !== undefined) out[field] = value;
  }
  return out as unknown as CatalogRowJson;
}

/** The override's row payload (everything but the audit trail). */
function overrideFields(override: CatalogRowOverride): Partial<CatalogRowJson> {
  const out: Record<string, unknown> = {};
  for (const field of OVERRIDE_FIELDS) {
    const value = override[field];
    if (value === undefined) continue;
    out[field] = field === "input" ? [...(value as readonly string[])] : value;
  }
  return out as Partial<CatalogRowJson>;
}

/** Builds one catalog file from its sidecar and the aggregator snapshots. */
export function buildCatalog(
  overrides: CatalogOverrides,
  snapshots: AggregatorSnapshots,
  options: { previous?: CatalogFileJson } = {},
): BuiltCatalog {
  const issues: BuildIssue[] = [];
  const provider = overrides.provider;
  const file: CatalogFileJson = {};
  const rows: Record<string, RowProvenance> = {};
  const verdicts: Record<string, number> = { exact: 0, "base-model": 0, ambiguous: 0, absent: 0 };
  const shrinkAccepted: string[] = [];
  const crossSourceContextDiffs: BuiltCatalog["crossSourceContextDiffs"] = [];

  for (const [id, override] of Object.entries(overrides.rows)) {
    if (!id) {
      issues.push({ level: "error", code: "row-without-id", provider, message: "a sidecar row has an empty id" });
      continue;
    }
    const match = findRecord(id, overrides.source, snapshots, issues, provider);
    const supplied = match ? suppliedFields(match.record, match.source) : { fields: {}, supplied: [] };
    // A row more than one declared source matches with different base rates
    // is ambiguous: the declared precedence still picks the value, and the
    // verdict says the choice was made for us, not by the data.
    const conflicting = match ? sameSourceConflict(id, overrides.source, snapshots, match, supplied.fields.cost) : false;
    const verdict: RowProvenance["verdict"] = match === undefined ? "absent" : conflicting ? "ambiguous" : match.verdict;
    verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;

    // The subscription-plan entry: the same row in the plan namespace(s).
    let plan: RowProvenance["plan"];
    let planCost = override.planCost;
    if (overrides.source.plan) {
      const planMatch = findRecord(id, overrides.source.plan, snapshots, issues, provider);
      if (planMatch) {
        plan = { source: planMatch.source, namespace: planMatch.namespace };
        planCost = planCost ?? suppliedFields(planMatch.record, planMatch.source).fields.cost;
      }
    }

    const merged: Partial<CatalogRowJson> = {
      name: override.name,
      api: override.api ?? overrides.file?.api,
      provider: override.provider ?? overrides.file?.provider,
      baseUrl: override.baseUrl ?? overrides.file?.baseUrl,
      ...supplied.fields,
      ...overrideFields(override),
      planCost,
    };
    const api = merged.api ?? "";
    const row = reorderRow({ ...merged, id });
    (file[api] ??= {})[id] = row;

    rows[id] = {
      verdict,
      ...(match ? { source: match.source, namespace: match.namespace } : {}),
      supplied: supplied.supplied,
      ...(plan ? { plan } : {}),
      overrides: ROW_VALUE_FIELDS.filter((field) => override[field] !== undefined),
    };

    // Cross-source context differences are reported, never merged: the
    // declared precedence decides, the report makes the difference visible.
    if (match?.source === "models.dev" && supplied.fields.contextWindow) {
      const candidates = openRouterCandidates(id, overrides.source, snapshots);
      // One candidate only: with several the difference would be attributed
      // to a record the join itself refused to pick.
      const other = candidates.length === 1 ? candidates[0] : undefined;
      const otherContext = other?.context_length ?? other?.top_provider?.context_length;
      if (otherContext && otherContext !== supplied.fields.contextWindow) {
        crossSourceContextDiffs.push({ id, modelsDev: supplied.fields.contextWindow, openRouter: otherContext });
      }
    }
  }

  for (const [id, override] of Object.entries(overrides.rows)) {
    if (override.acceptContextShrink === true) shrinkAccepted.push(id);
  }

  const built: BuiltCatalog = {
    provider,
    file,
    json: JSON.stringify(file),
    rows,
    verdicts,
    issues,
    shrinkAccepted,
    crossSourceContextDiffs,
  };
  issues.push(...guardCatalog(overrides, built, options.previous));
  return built;
}

/** The generation guards (ADR-0046). Every one of them fails generation —
 * "did not regenerate" on a source outage, never "regenerated with less".
 * An override is the declared escape hatch: a row whose sidecar entry
 * declares the field has a human decision behind it. */
export function guardCatalog(
  overrides: CatalogOverrides,
  built: BuiltCatalog,
  previous?: CatalogFileJson,
): BuildIssue[] {
  const issues: BuildIssue[] = [];
  const provider = overrides.provider;
  const error = (code: string, id: string, message: string): void => {
    issues.push({ level: "error", code, provider, id, message });
  };

  const seen = new Set<string>();
  for (const [api, models] of Object.entries(built.file)) {
    for (const id of Object.keys(models)) {
      if (seen.has(id)) error("duplicate-row-id", id, `row id appears twice in the built catalog (api ${api})`);
      seen.add(id);
    }
  }

  if (!previous) return issues;

  for (const [api, models] of Object.entries(previous)) {
    for (const [id, before] of Object.entries(models)) {
      const declared = overrides.rows[id];
      if (!declared) {
        error("row-not-declared", id, `the committed catalog has this row but ${provider}.overrides.json does not declare it`);
        continue;
      }
      const after = findRow(built.file, id);
      if (!after) {
        error("row-lost", id, `the row was not written by the build (committed api ${api})`);
        continue;
      }
      if ((before.contextWindow ?? 0) > 0 && declared.contextWindow === undefined) {
        const next = after.contextWindow ?? 0;
        if (next < (before.contextWindow ?? 0) && declared.acceptContextShrink !== true) {
          error(
            "context-window-regression",
            id,
            `contextWindow ${before.contextWindow} → ${next || "absent"}; declare it in the sidecar (or acceptContextShrink) to accept the correction`,
          );
        }
      }
      if (declared.cost === undefined) {
        if (hasNonzeroPricing(before.cost) && !hasNonzeroPricing(after.cost)) {
          error("pricing-coverage-drop", id, "the row had a metered price and the build produced none");
        } else if ((before.cost?.tiers?.length ?? 0) > 0 && (after.cost?.tiers?.length ?? 0) === 0) {
          // Tiers are not an aggregator field for every source (OpenRouter
          // declares none): losing them silently would change what a call
          // costs past the tier boundary.
          error("pricing-coverage-drop", id, "the row had tiered rates and the build produced none");
        }
      }
    }
  }
  return issues;
}

function findRow(file: CatalogFileJson, id: string): CatalogRowJson | undefined {
  for (const models of Object.values(file)) if (models[id]) return models[id];
  return undefined;
}

/** True for a pricing record that carries evidence of a rate: zero-only
 * records are placeholders, not evidence of a free model (ADR-0029), and a
 * negative value is a variable-pricing sentinel (`-1` on the OpenRouter
 * `auto` routers), not a rate. */
export function hasNonzeroPricing(pricing: ModelPricing | undefined): boolean {
  if (!pricing) return false;
  if (pricing.input > 0 || pricing.output > 0) return true;
  return (pricing.tiers ?? []).some((tier) => tier.input > 0 || tier.output > 0);
}

/** A pricing record whose rates are negative: OpenRouter's variable-pricing
 * sentinel, meaningless as a price and dropped rather than carried. */
export function isSentinelPricing(pricing: ModelPricing | undefined): boolean {
  if (!pricing) return false;
  if (pricing.input < 0 || pricing.output < 0) return true;
  return (pricing.tiers ?? []).some((tier) => tier.input < 0 || tier.output < 0);
}

/** Per-file coverage: how many rows carry each value field. The report
 * compares these against the committed catalog's own numbers. */
export function coverageOf(file: CatalogFileJson): Record<string, number> {
  const rows = Object.values(file).flatMap((models) => Object.values(models));
  return {
    rows: rows.length,
    pricing: rows.filter((row) => hasNonzeroPricing(row.cost) || hasNonzeroPricing(row.planCost)).length,
    contextWindow: rows.filter((row) => (row.contextWindow ?? 0) > 0).length,
    maxTokens: rows.filter((row) => (row.maxTokens ?? 0) > 0).length,
    reasoning: rows.filter((row) => row.reasoning === true).length,
    input: rows.filter((row) => (row.input ?? []).length > 0).length,
  };
}

export function buildManifest(options: {
  version: string;
  generatedAt: string;
  sources: SourceSnapshotInfo[];
  catalogs: BuiltCatalog[];
  hashes: Record<string, string>;
}): CatalogManifest {
  const files: CatalogManifest["files"] = {};
  const rows: CatalogManifest["rows"] = {};
  for (const catalog of options.catalogs) {
    files[catalog.provider] = {
      sha256: options.hashes[catalog.provider] ?? "",
      rows: rowCount(catalog.file),
      verdicts: catalog.verdicts,
    };
    for (const [id, provenance] of Object.entries(catalog.rows)) {
      rows[`${catalog.provider}/${id}`] = { provider: catalog.provider, id, ...provenance };
    }
  }
  return {
    schemaVersion: 1,
    version: options.version,
    generatedAt: options.generatedAt,
    sources: options.sources,
    files,
    rows,
  };
}

function rowCount(file: CatalogFileJson): number {
  return Object.values(file).reduce((sum, models) => sum + Object.keys(models).length, 0);
}

export interface GenerationReport {
  schemaVersion: number;
  version: string;
  generatedAt: string;
  sources: SourceSnapshotInfo[];
  totals: {
    files: number;
    rows: number;
    exact: number;
    baseModel: number;
    ambiguous: number;
    absent: number;
    rowsWithOverrides: number;
  };
  files: Array<{
    provider: string;
    rows: number;
    verdicts: Record<string, number>;
    coverage: Record<string, number>;
    previous?: Record<string, number>;
  }>;
  /** Rows no declared source matched: hand-maintained, visible here and in
   * the sidecar's own `reason`. */
  absentIds: string[];
  crossSourceContextDiffs: Array<{ provider: string; id: string; modelsDev: number; openRouter: number }>;
  contextWindowShrinks: Array<{ provider: string; id: string; from: number; to: number; declared: boolean }>;
  changes: {
    pricing: Array<{ provider: string; id: string; from: ModelPricing; to: ModelPricing }>;
    contextWindow: Array<{ provider: string; id: string; from: number; to: number }>;
    reasoning: Array<{ provider: string; id: string; from: boolean; to: boolean }>;
  };
  issues: BuildIssue[];
}

/** The human-readable audit trail of one generation: what changed against
 * the committed catalog, what stayed hand-maintained, and what the guards
 * had to say. */
export function buildReport(options: {
  version: string;
  generatedAt: string;
  sources: SourceSnapshotInfo[];
  catalogs: BuiltCatalog[];
  previous: Record<string, CatalogFileJson>;
}): GenerationReport {
  const totals = { files: 0, rows: 0, exact: 0, baseModel: 0, ambiguous: 0, absent: 0, rowsWithOverrides: 0 };
  const files: GenerationReport["files"] = [];
  const absentIds: string[] = [];
  const crossSourceContextDiffs: GenerationReport["crossSourceContextDiffs"] = [];
  const contextWindowShrinks: GenerationReport["contextWindowShrinks"] = [];
  const changes: GenerationReport["changes"] = { pricing: [], contextWindow: [], reasoning: [] };
  const issues: BuildIssue[] = [];

  for (const catalog of options.catalogs) {
    const rows = rowCount(catalog.file);
    totals.files += 1;
    totals.rows += rows;
    totals.exact += catalog.verdicts.exact ?? 0;
    totals.baseModel += catalog.verdicts["base-model"] ?? 0;
    totals.ambiguous += catalog.verdicts.ambiguous ?? 0;
    totals.absent += catalog.verdicts.absent ?? 0;
    totals.rowsWithOverrides += Object.values(catalog.rows).filter((row) => row.overrides.length > 0).length;
    for (const [id, row] of Object.entries(catalog.rows)) if (row.verdict === "absent") absentIds.push(`${catalog.provider}/${id}`);
    for (const diff of catalog.crossSourceContextDiffs) {
      crossSourceContextDiffs.push({ provider: catalog.provider, id: diff.id, modelsDev: diff.modelsDev, openRouter: diff.openRouter });
    }
    issues.push(...catalog.issues);

    const before = options.previous[catalog.provider];
    files.push({
      provider: catalog.provider,
      rows,
      verdicts: catalog.verdicts,
      coverage: coverageOf(catalog.file),
      ...(before ? { previous: coverageOf(before) } : {}),
    });

    if (!before) continue;
    const previousRows = new Map<string, CatalogRowJson>();
    for (const models of Object.values(before)) for (const [id, row] of Object.entries(models)) previousRows.set(id, row);
    for (const models of Object.values(catalog.file)) {
      for (const [id, row] of Object.entries(models)) {
        const was = previousRows.get(id);
        if (!was) continue;
        const beforeCost = was.cost;
        const afterCost = row.cost;
        if (beforeCost && afterCost && hasNonzeroPricing(beforeCost) && !samePricing(beforeCost, afterCost)) {
          changes.pricing.push({ provider: catalog.provider, id, from: beforeCost, to: afterCost });
        }
        if (was.contextWindow !== undefined && row.contextWindow !== undefined && was.contextWindow !== row.contextWindow) {
          changes.contextWindow.push({ provider: catalog.provider, id, from: was.contextWindow, to: row.contextWindow });
          if (row.contextWindow < was.contextWindow) {
            contextWindowShrinks.push({
              provider: catalog.provider,
              id,
              from: was.contextWindow,
              to: row.contextWindow,
              declared: catalog.shrinkAccepted.includes(id),
            });
          }
        }
        if (typeof was.reasoning === "boolean" && typeof row.reasoning === "boolean" && was.reasoning !== row.reasoning) {
          changes.reasoning.push({ provider: catalog.provider, id, from: was.reasoning, to: row.reasoning });
        }
      }
    }
  }

  return {
    schemaVersion: 1,
    version: options.version,
    generatedAt: options.generatedAt,
    sources: options.sources,
    totals,
    files,
    absentIds,
    crossSourceContextDiffs,
    contextWindowShrinks,
    changes,
    issues,
  };
}

function samePricing(a: ModelPricing, b: ModelPricing): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Release freshness (#1005, ADR-0046 amendment).
 *
 * The catalog is release-pinned, so the two questions a release asks are
 * "which release does the data declare?" and "how far has upstream moved
 * since it was generated?". The second is answered by the same compare the
 * scheduled check fails on; here it is a report, never a verdict: at a 4–5
 * hour drift window a red at the tag is the steady state, so the tag-time
 * job states the facts (age, how many files differ, what moved) and lets
 * the human decide. Everything decidable lives here, so the wording is
 * testable without network or disk.
 */

/** The provenance a freshness report reads from `manifest.json`: which
 * release the catalog belongs to, when it was generated, and the hashes it
 * recorded (the compare uses them as a third drift source). */
export interface CommittedManifest {
  version?: string;
  generatedAt?: string;
  files?: Record<string, { sha256?: string }>;
}

/** One committed file that moved upstream, as the rebuild-and-compare found
 * it. `file` is the name on disk (`anthropic.json`), so several findings on
 * one file count once. */
export interface CatalogDriftEntry {
  file: string;
  message: string;
}

/** What one catalog rebuild changed against the committed tree — the row
 * counts `buildReport` computes, without the report's own plumbing. */
export interface UpstreamMoves {
  pricing: number;
  contextWindow: number;
  reasoning: number;
}

export interface FreshnessReport {
  /** The release the committed catalog declares, when the manifest has one. */
  version?: string;
  generatedAt?: string;
  /** The instant the age is measured against (the tagged commit's date at
   * the tag; now, elsewhere). */
  reference: string;
  /** The staleness window, already rendered: "1d 7h", "5h 20m", "12m", or
   * "unknown" when the manifest carries no usable date — an unknown age is
   * reported as unknown, never as zero. One rendered field, not a duration
   * and its formatter both: every reader of this report is a human line. */
  age: string;
  /** Committed catalog files the rebuild covers. */
  totalFiles: number;
  /** Files whose content or recorded hash differs from the rebuild, in the
   * order the compare found them. */
  driftedFiles: string[];
}

/** "1d 7h", "5h 20m", "12m" — a staleness window read at a glance. A
 * missing or unusable date is "unknown", and a date in the future (a clock
 * skew, never a real age) degrades to "0m". */
export function formatAge(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return "unknown";
  const ms = Math.max(0, ageMs);
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function freshnessReport(options: {
  manifest: CommittedManifest | undefined;
  reference: string;
  drift: CatalogDriftEntry[];
  totalFiles: number;
}): FreshnessReport {
  const generatedAt = options.manifest?.generatedAt;
  const generated = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  const reference = Date.parse(options.reference);
  const age = Number.isFinite(generated) && Number.isFinite(reference) ? formatAge(reference - generated) : "unknown";
  return {
    ...(options.manifest?.version ? { version: options.manifest.version } : {}),
    ...(generatedAt ? { generatedAt } : {}),
    reference: options.reference,
    age,
    totalFiles: options.totalFiles,
    driftedFiles: [...new Set(options.drift.map((entry) => entry.file))],
  };
}

/** The tag-time report: what is being shipped, how old it is, and how far
 * upstream has moved. `drift` is the same list `report.driftedFiles` counts,
 * so one entry per reason — two findings on one file are two lines and one
 * file. `moved` holds the row-level counts, `rowMoves` their already
 * rendered lines (a price, a context window, a reasoning flag). The report
 * is a human-read transcript; no caller parses it, so it stays one shape.
 * Informational by construction — nothing here decides anything. */
export function formatFreshness(report: FreshnessReport, moved: UpstreamMoves, drift: CatalogDriftEntry[], rowMoves: string[]): string {
  const lines: string[] = [];
  lines.push(
    `catalog freshness — the committed catalog declares moh ${report.version ?? "(no version)"}, generated ${report.generatedAt ?? "(no date)"} — ${report.age} old against ${report.reference}`,
  );
  lines.push(
    `upstream moved since: ${report.driftedFiles.length} of ${report.totalFiles} file(s) differ — ${moved.pricing} price(s), ${moved.contextWindow} context window(s), ${moved.reasoning} reasoning flag(s)`,
  );
  for (const entry of drift) lines.push(`  ${entry.file}: ${entry.message}`);
  for (const line of rowMoves) lines.push(`  ${line}`);
  return lines.join("\n");
}

/** The version contract (ADR-0029 + ADR-0046): the catalog a release ships
 * must declare that release, because `PRICING_SNAPSHOT.version` is a public
 * export read from the manifest. Returns the message naming both versions
 * when they disagree, undefined when they agree.
 *
 * The `v0.50.1` release is the precedent: it shipped a manifest declaring
 * `0.50.0`, so `PRICING_SNAPSHOT.version` named a release that did not
 * contain the data. Nothing checked it; this does. */
export function releaseVersionProblem(declared: string | undefined, release: string): string | undefined {
  if (declared === release) return undefined;
  return `manifest.json declares moh ${declared ?? "(no version)"}, but the release is ${release} — regenerate with --version ${release} and commit the result`;
}

/** The audit trail every migrated row carries. */
export interface MigrationStamp {
  author: string;
  date: string;
}

const MIGRATION_REASON = {
  absent: "no aggregator record: the row is fully hand-maintained",
  labels: "labels and row identity are moh-owned (ADR-0046): never aggregator-supplied",
  metered:
    "metered rate kept from the previous catalog: the aggregator record carries no usable rate for this row (zero-only, or no tiers where the row has tiered rates), so the metered entry stays hand-maintained",
  shrink: "contextWindow correction accepted against the committed catalog",
  carried: "field the aggregators cannot supply: carried from the previous catalog",
  sentinel:
    "dropped: the previous catalog carried a negative rate (a variable-pricing sentinel), which is not a price",
} as const;

/**
 * ADR-0046 migration (#959): turns one committed catalog into its
 * hand-maintained sidecar. The sidecar declares every row, keeps every
 * moh-owned field, and carries — as an explicit override — every value the
 * aggregators cannot supply, so the first generation reproduces the
 * committed data and refreshes it only where the aggregators cover it.
 *
 * This is an authoring act, not a build step: it runs once, its output is
 * reviewed in the PR, and from then on the sidecar is edited by hand.
 */
export function migrateOverrides(options: {
  provider: string;
  source: CatalogSourceSpec;
  previous: CatalogFileJson;
  snapshots: AggregatorSnapshots;
  stamp: MigrationStamp;
}): { overrides: CatalogOverrides; notes: MigrationNote[] } {
  const { provider, source, previous, snapshots, stamp } = options;
  const notes: MigrationNote[] = [];
  const rows: Record<string, CatalogRowOverride> = {};
  const issues: BuildIssue[] = [];
  const file: CatalogOverrides["file"] = {};

  for (const [api, models] of Object.entries(previous)) {
    for (const [id, before] of Object.entries(models)) {
      // File-level defaults cover what every row of the file repeats; a row
      // that deviates declares its own value.
      if (file.api === undefined) file.api = api;
      if (before.provider !== undefined && file.provider === undefined) file.provider = before.provider;
      if (before.baseUrl !== undefined && file.baseUrl === undefined) file.baseUrl = before.baseUrl;

      const match = findRecord(id, source, snapshots, issues, provider);
      const supplied = match ? suppliedFields(match.record, match.source) : { fields: {}, supplied: [] };
      const override: CatalogRowOverride = { author: stamp.author, date: stamp.date, reason: "" };

      if (api !== file.api) override.api = api;
      if (before.provider !== undefined && before.provider !== file.provider) override.provider = before.provider;
      if (before.baseUrl !== undefined && before.baseUrl !== file.baseUrl) override.baseUrl = before.baseUrl;
      if (before.name !== undefined) override.name = before.name;
      if (before.thinkingLevelMap) override.thinkingLevelMap = before.thinkingLevelMap;
      if (before.compat) override.compat = before.compat;
      if (before.headers) override.headers = before.headers;

      const carried: string[] = [];
      for (const field of AGGREGATOR_FIELDS) {
        const value = before[field];
        if (value === undefined || field === "cost") continue;
        if (supplied.fields[field] === undefined) {
          Object.assign(override, { [field]: value });
          carried.push(field);
        }
      }

      // The metered entry: refreshed where the aggregator carries a nonzero,
      // fully-shaped rate, kept where it does not — a zero-only record is a
      // placeholder (ADR-0029), and an untiered record cannot replace a
      // tiered one (dropping the tiers would change what a call costs past
      // the tier boundary).
      const upstreamCost = supplied.fields.cost;
      if (match && before.cost && hasNonzeroPricing(before.cost)) {
        const tierless = (before.cost.tiers?.length ?? 0) > 0 && (upstreamCost?.tiers?.length ?? 0) === 0;
        if (!hasNonzeroPricing(upstreamCost) || tierless) {
          override.cost = before.cost;
          notes.push({ provider, id, code: "metered-rate-kept", message: `${MIGRATION_REASON.metered}${tierless ? " (tiered rates)" : ""}` });
        }
      }

      // A contextWindow smaller than the committed one is a correction the
      // migration accepts explicitly (the guard would otherwise fail).
      const upstreamContext = supplied.fields.contextWindow;
      if ((before.contextWindow ?? 0) > 0 && upstreamContext !== undefined && upstreamContext < (before.contextWindow ?? 0)) {
        override.acceptContextShrink = true;
        notes.push({
          provider,
          id,
          code: "context-shrink-accepted",
          message: `${before.contextWindow} → ${upstreamContext}: ${MIGRATION_REASON.shrink}`,
        });
      }

      if (isSentinelPricing(before.cost)) {
        override.cost = undefined;
        notes.push({ provider, id, code: "pricing-sentinel-dropped", message: MIGRATION_REASON.sentinel });
      }

      if (!match) {
        // No aggregator record at all: the whole row is hand-maintained.
        if (before.name === undefined) override.name = id;
        for (const field of AGGREGATOR_FIELDS) {
          if (field === "cost") {
            if (before.cost !== undefined && !isSentinelPricing(before.cost)) override.cost = before.cost;
            continue;
          }
          const value = before[field];
          if (value !== undefined) Object.assign(override, { [field]: value });
        }
        override.reason = MIGRATION_REASON.absent;
        notes.push({ provider, id, code: "absent-row", message: MIGRATION_REASON.absent });
      } else {
        if (before.name === undefined) {
          // No curated label existed (the OpenCode snapshots): the
          // aggregator's label is better than a raw id, and it is declared
          // here so the picker never depends on upstream naming.
          const upstreamName = (match.record as { name?: string }).name;
          if (upstreamName) {
            override.name = upstreamName;
            notes.push({ provider, id, code: "label-filled", message: `label taken from ${match.source} (no curated label existed)` });
          }
        }
        if (carried.length > 0) {
          notes.push({ provider, id, code: "field-carried", message: `${MIGRATION_REASON.carried}: ${carried.join(", ")}` });
        }
        const parts: string[] = [MIGRATION_REASON.labels];
        if (carried.length > 0) parts.push(`${MIGRATION_REASON.carried}: ${carried.join(", ")}`);
        if (override.cost) parts.push(MIGRATION_REASON.metered);
        if (override.acceptContextShrink) parts.push(MIGRATION_REASON.shrink);
        override.reason = parts.join("; ");
      }

      rows[id] = override;
    }
  }

  return { overrides: { schemaVersion: 1, provider, source, file, rows }, notes };
}

/** Serializes a manifest/report deterministically (2-space JSON, trailing
 * newline) — the same bytes on every machine for the same input. */
export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
