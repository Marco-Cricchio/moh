// #953 coverage census: moh catalog rows vs models.dev + OpenRouter.
// Output: coverage-census.json (per-row verdicts) + summary on stdout.
//
// Join key (per issue #953): exact id first, then models.dev base_model, then the
// OpenRouter namespaced id (vendor/model). models.dev matching is scoped to the
// candidate namespaces a moh file legitimately maps to (its provider field / file
// name / declared alias), so a bare-id collision across unrelated providers does
// not create a false match.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CAT_DIR = join(ROOT, "packages/core/src/model-catalogs");

const modelsDev = JSON.parse(readFileSync("/tmp/modelsdev.json", "utf8"));
const orJson = JSON.parse(readFileSync("/tmp/openrouter.json", "utf8"));
const orModels: any[] = orJson.data;

// provider file -> models.dev namespaces it may map to (file name + declared aliases)
const NS_ALIASES: Record<string, string[]> = {
  "opencode-zen": ["opencode"],
  "opencode-go": ["opencode-go"],
  "kimi-coding": ["kimi-code-plan-global", "kimi-code-plan-cn"],
  zai: ["zai", "zai-coding-plan"],
  minimax: ["minimax", "minimax-cn", "minimax-coding-plan", "minimax-cn-coding-plan"],
  moonshot: ["moonshotai", "moonshotai-cn"],
};

const mdIndex = new Map<string, Map<string, any>>();
const mdBaseIndex = new Map<string, Array<{ provider: string; id: string; rec: any }>>();
let mdBaseCount = 0;
for (const [prov, pdata] of Object.entries<any>(modelsDev)) {
  for (const [id, rec] of Object.entries<any>(pdata.models ?? {})) {
    if (!mdIndex.has(prov)) mdIndex.set(prov, new Map());
    mdIndex.get(prov)!.set(id, rec);
    const base = rec.base_model;
    if (typeof base === "string" && base.length > 0) {
      mdBaseCount++;
      if (!mdBaseIndex.has(base)) mdBaseIndex.set(base, []);
      mdBaseIndex.get(base)!.push({ provider: prov, id, rec });
    }
  }
}
const orById = new Map<string, any>();
for (const m of orModels) orById.set(m.id, m);

// pi-ai 0.87.1 comparison reference: module name -> { id -> entry }
const PIAI_ALIASES: Record<string, string[]> = {
  "opencode-zen": ["opencode"],
  "opencode-go": ["opencode-go"],
  "kimi-coding": ["kimi-coding"],
  zai: ["zai", "zai-coding-cn"],
  minimax: ["minimax", "minimax-cn"],
  moonshot: ["moonshotai", "moonshotai-cn"],
  "openai-codex": ["openai-codex"],
  "github-copilot": ["github-copilot"],
  "xiaomi-mimo": ["xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "xiaomi-token-plan-ams"],
  qwen: ["qwen", "qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual"],
  "nvidia-nim": ["nvidia"],
  anthropic: ["anthropic", "amazon-bedrock", "google-vertex"],
  google: ["google", "google-vertex"],
  openrouter: ["openrouter", "meta"],
};
const piaiIndex = new Map<string, Map<string, any>>();
{
  const modNames = [
    "amazon-bedrock", "ant-ling", "anthropic", "azure-openai-responses", "baseten", "cerebras",
    "cloudflare-ai-gateway", "cloudflare-workers-ai", "deepseek", "fireworks", "github-copilot",
    "google-vertex", "google", "groq", "huggingface", "kimi-coding", "meta", "minimax-cn",
    "minimax", "mistral", "moonshotai-cn", "moonshotai", "nvidia", "openai-codex", "openai",
    "opencode-go", "opencode", "openrouter", "qwen-token-plan-cn", "qwen-token-plan-individual",
    "qwen-token-plan", "radius", "together", "vercel-ai-gateway", "xai", "xiaomi-token-plan-ams",
    "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "xiaomi", "zai-coding-cn", "zai",
  ];
  for (const name of modNames) {
    try {
      const mod = require(`/tmp/piai/package/dist/providers/${name}.models.js`);
      const entry = Object.values(mod)[0] as Record<string, any>;
      const idx = new Map<string, any>();
      for (const [id, rec] of Object.entries(entry ?? {})) idx.set(id, rec);
      piaiIndex.set(name, idx);
    } catch {
      /* module missing in this pi-ai version */
    }
  }
}
function piaiSupplies(rec: any): string[] {
  const out: string[] = [];
  if (rec.cost && (rec.cost.input || rec.cost.output)) out.push("cost(USD/1M:number)");
  if (rec.contextWindow ?? rec.limit?.context) out.push("contextWindow");
  if (rec.maxTokens ?? rec.limit?.output) out.push("maxTokens");
  if (typeof rec.reasoning === "boolean") out.push("reasoning");
  if (rec.input) out.push("inputModalities");
  return out;
}

function costValues(cost: any): string | null {
  if (!cost || typeof cost !== "object") return null;
  const v = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].map((x) =>
    typeof x === "number" ? x : null
  );
  if (v.every((x) => x === null || x === 0)) return "zero";
  return "nonzero";
}

function mdSupplies(rec: any) {
  const out: string[] = [];
  if (rec.cost && (rec.cost.input || rec.cost.output)) out.push("cost(USD/1M:number)");
  if (rec.limit?.context) out.push("contextWindow");
  if (rec.limit?.output) out.push("maxTokens");
  if (typeof rec.reasoning === "boolean") out.push("reasoning");
  if (rec.modalities?.input) out.push("inputModalities");
  return out;
}

function orSupplies(m: any) {
  const out: string[] = [];
  const p = m.pricing ?? {};
  const pr = Number(p.prompt), po = Number(p.completion);
  if (Number.isFinite(pr) || Number.isFinite(po)) out.push("cost(USD/token:string)");
  if (m.context_length) out.push("contextWindow");
  if (m.architecture?.input_modalities) out.push("inputModalities");
  if (m.supported_parameters?.some((x: string) => x.includes("reasoning"))) out.push("reasoning");
  return out;
}

// compare two cost pairs; returns true if conflicting
function costConflict(a: any, b: any): boolean {
  const pa = a.cost ? [a.cost.input, a.cost.output] : a.pricing ? [Number(a.pricing.prompt), Number(a.pricing.completion)] : null;
  const pb = b.cost ? [b.cost.input, b.cost.output] : b.pricing ? [Number(b.pricing.prompt), Number(b.pricing.completion)] : null;
  if (!pa || !pb) return false;
  return pa[0] !== pb[0] || pa[1] !== pb[1];
}

type Verdict = "exact" | "base-model" | "ambiguous" | "absent";
const rows: any[] = [];

for (const file of readdirSync(CAT_DIR).filter((f) => f.endsWith(".json")).sort()) {
  const short = file.replace(/\.json$/, "");
  const cat = JSON.parse(readFileSync(join(CAT_DIR, file), "utf8"));
  for (const [wire, models] of Object.entries<any>(cat)) {
    for (const [mohId, m] of Object.entries<any>(models)) {
      const mohCost = costValues(m.cost);
      const namespaces = new Set<string>([short, ...(NS_ALIASES[short] ?? [])]);
      const rowProvider = m.provider;
      if (rowProvider) namespaces.add(rowProvider);

      // ---- exact: same id inside a candidate namespace ----
      const exacts: { src: string; rec: any }[] = [];
      for (const ns of namespaces) {
        const rec = mdIndex.get(ns)?.get(mohId);
        if (rec) exacts.push({ src: `models.dev:${ns}/${mohId}`, rec });
      }
      const orExact = orById.get(mohId);
      if (orExact) exacts.push({ src: `openrouter:${mohId}`, rec: orExact });

      // ---- base-model join: models.dev base_model, then OpenRouter namespaced id ----
      const bases: { src: string; rec: any }[] = [];
      const mdBase = mdBaseIndex.get(mohId) ?? [];
      for (const b of mdBase) bases.push({ src: `models.dev base_model:${b.provider}/${b.id}`, rec: b.rec });
      const orNs = orModels.filter(
        (r) => r.id.includes("/") && r.id.split("/").slice(1).join("/") === mohId
      );
      for (const r of orNs) bases.push({ src: `openrouter namespaced:${r.id}`, rec: r });

      let verdict: Verdict;
      let matches: string[] = [];
      const all = [...exacts, ...bases];
      // ambiguous only when records within the SAME source conflict (same units);
      // cross-source differences are reported, not treated as conflict.
      const conflictWithin = (group: typeof all) =>
        group.length > 1 &&
        (group.some((a) => group.some((b) => a !== b && costConflict(a.rec, b.rec))) ||
          new Set(group.map((a) => a.rec.limit?.context ?? a.rec.context_length ?? null)).size > 1);
      if (all.length === 0) verdict = "absent";
      else {
        const mdGroup = all.filter((a) => a.src.startsWith("models.dev"));
        const orGroup = all.filter((a) => a.src.startsWith("openrouter"));
        const conflicts = conflictWithin(mdGroup) || conflictWithin(orGroup);
        if (exacts.length > 0) verdict = conflicts ? "ambiguous" : "exact";
        else verdict = conflicts ? "ambiguous" : "base-model";
        matches = all.map((a) => a.src);
      }

      const suppliedBy: Record<string, string[]> = {};
      for (const a of all.slice(0, 4)) suppliedBy[a.src] = a.rec.cost || a.rec.pricing ? (a.src.startsWith("openrouter") ? orSupplies(a.rec) : mdSupplies(a.rec)) : mdSupplies(a.rec);
      // cross-source context diff (same unit on both sides): informational only
      const mdCtx = exacts.concat(bases).filter((a) => a.src.startsWith("models.dev")).map((a) => a.rec.limit?.context ?? null);
      const orCtx = exacts.concat(bases).filter((a) => a.src.startsWith("openrouter")).map((a) => a.rec.context_length ?? null);
      const crossSourceContextDiffers =
        mdCtx.length > 0 && orCtx.length > 0 && mdCtx[0] !== orCtx[0];

      // pi-ai 0.87.1 reference: does it carry this row where the aggregators do not?
      const piaiModules = [
        ...new Set([short, ...(NS_ALIASES[short] ?? []), ...(PIAI_ALIASES[short] ?? [])]),
      ].flatMap((ns) => (piaiIndex.has(ns) ? [ns] : []));
      const piaiHits = piaiModules
        .filter((ns) => piaiIndex.get(ns)!.has(mohId))
        .map((ns) => ({ module: ns, supplies: piaiSupplies(piaiIndex.get(ns)!.get(mohId)) }));

      const aggregatorHasPrice = all.some(
        (a) =>
          (a.rec.cost && (a.rec.cost.input > 0 || a.rec.cost.output > 0)) ||
          (a.rec.pricing && (Number(a.rec.pricing.prompt) > 0 || Number(a.rec.pricing.completion) > 0))
      );

      rows.push({
        file: short,
        id: mohId,
        verdict,
        mohCost: mohCost ?? "none",
        costFillableByAggregator: mohCost !== "nonzero" && aggregatorHasPrice,
        matches,
        suppliedBy,
        crossSourceContextDiffers,
        piai: piaiHits,
        unitsNote:
          verdict !== "absent" && all.some((a) => a.rec.pricing)
            ? "OpenRouter pricing is USD/token (string); moh cost is USD/1M (number) — 1e6 factor needed"
            : undefined,
      });
    }
  }
}

const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
const perProvider = new Map<string, Record<string, number>>();
for (const r of rows) {
  if (!perProvider.has(r.file)) perProvider.set(r.file, { exact: 0, "base-model": 0, ambiguous: 0, absent: 0 });
  perProvider.get(r.file)![r.verdict]++;
}
const uncovered = [...perProvider.entries()].filter(([, c]) => c.exact + c["base-model"] + c.ambiguous === 0).map(([p]) => p);
const fillable = rows.filter((r) => r.costFillableByAggregator);
const absent = rows.filter((r) => r.verdict === "absent");

writeFileSync(join(ROOT, "research-953/951-coverage-census.json"), JSON.stringify({ generatedAt: new Date().toISOString(), baseModelRecordsInModelsDev: mdBaseCount, rows, }, null, 2));

console.log(`#953 coverage census — ${rows.length} catalog rows`);
console.log(`models.dev base_model records in snapshot: ${mdBaseCount} (join key therefore unused for models.dev)`);
console.log(`verdicts: exact=${count("exact")} base-model=${count("base-model")} ambiguous=${count("ambiguous")} absent=${count("absent")}`);
console.log(`\nPer provider (exact/base/ambig/absent):`);
for (const [p, c] of perProvider) console.log(`  ${p}: ${c.exact}/${c["base-model"]}/${c.ambiguous}/${c.absent}`);
console.log(`\nProviders with zero aggregator coverage: ${uncovered.length ? uncovered.join(", ") : "none"}`);
console.log(`\nRows with no/zero cost fillable by aggregators: ${fillable.length}`);
console.log(fillable.map((r) => `  ${r.file}/${r.id} [${r.verdict}] via ${r.matches.join(", ")}`).join("\n"));
console.log(`\nAbsent rows (${absent.length}):`);
for (const r of absent)
  console.log(
    `  ${r.file}/${r.id}` +
      (r.piai.length ? `  [pi-ai 0.87.1 HAS it: ${r.piai.map((p: any) => p.module).join(",")}]` : "  [not in pi-ai either]")
  );
const piaiOnly = rows.filter((r) => r.verdict === "absent" && r.piai.length);
console.log(`\nOf the absent rows, pi-ai 0.87.1 would supply: ${piaiOnly.length}/${absent.length}`);
