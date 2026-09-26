/**
 * ADR-0046 (#959): the catalog rebuilder — fetch, build, write.
 *
 * The generator owns no logic: the join, the unit conversions, the override
 * merge, the guards, the manifest and the report live in
 * `packages/core/src/model-catalog-build.ts` (tested without network or
 * disk). This file is the I/O half.
 *
 * Usage:
 *   bun packages/core/scripts/build-model-catalogs.ts --version 0.50.0
 *   bun packages/core/scripts/build-model-catalogs.ts --check
 *   bun packages/core/scripts/build-model-catalogs.ts --freshness [--at <iso>]
 *   bun packages/core/scripts/build-model-catalogs.ts --verify-version 0.50.0
 *   bun packages/core/scripts/build-model-catalogs.ts --migrate-overrides --version 0.50.0
 *
 * `--version` declares the moh release that will contain the catalog
 * (ADR-0029 amendment): generation is local and human-invoked. Regenerating
 * declaring the release being cut is a step of the release flow, before the
 * tag — the release PR carries the regenerated catalog (ADR-0046 amendment,
 * #1005).
 *
 * `--check` rebuilds and compares, failing on drift: the daily schedule, PRs
 * touching the catalog, and manual dispatch. `--freshness` runs the same
 * compare and reports instead of failing — the release pipeline's job, which
 * states the committed catalog's age against the tagged commit and how far
 * upstream has moved, and never gates on drift — a rebuild the guards reject
 * reports less (age and drifted files, with the row-level counts as `--`)
 * instead of failing. `--verify-version` enforces the version contract
 * offline: the catalog a release ships must declare that release, because
 * `PRICING_SNAPSHOT.version` reads it.
 *
 * Offline runs (tests, CI debugging): `--models-dev <file>` and
 * `--open-router <file>` read a local snapshot instead of fetching.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  buildCatalog,
  buildManifest,
  buildReport,
  formatFreshness,
  freshnessReport,
  migrateOverrides,
  releaseVersionProblem,
  serializeJson,
  type AggregatorSnapshots,
  type BuiltCatalog,
  type CatalogDriftEntry,
  type CatalogFileJson,
  type CatalogOverrides,
  type CatalogSourceSpec,
  type CommittedManifest,
  type ModelsDevSnapshot,
  type OpenRouterSnapshot,
  type SourceSnapshotInfo,
} from "../src/model-catalog-build";

const CATALOG_DIR = join(import.meta.dir, "../src/model-catalogs");
const MANIFEST_FILE = join(CATALOG_DIR, "manifest.json");
const REPORT_FILE = join(CATALOG_DIR, "generation-report.json");

const MODELS_DEV_URL = "https://models.dev/api.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

/** The migration's source declaration, per catalog (#959). It is used once,
 * by `--migrate-overrides`, to write the `source` block of each sidecar;
 * from then on the sidecars are the authored surface and the build reads
 * the declaration from there. */
const MIGRATION_SOURCES: Record<string, CatalogSourceSpec> = {
  anthropic: { modelsDev: ["anthropic"] },
  baseten: { modelsDev: ["baseten"] },
  cerebras: { modelsDev: ["cerebras"] },
  "cloudflare-ai-gateway": { modelsDev: ["cloudflare-ai-gateway"] },
  deepseek: { modelsDev: ["deepseek"], openRouter: ["deepseek"] },
  fireworks: { modelsDev: ["fireworks-ai"] },
  "github-copilot": { modelsDev: ["github-copilot"] },
  google: { modelsDev: ["google"] },
  groq: { modelsDev: ["groq"] },
  huggingface: { modelsDev: ["huggingface"] },
  // Kimi Code plan ids live only in the plan namespaces; the plan entry
  // comes from there too (ADR-0046: kimi-coding migrates via its aliases).
  "kimi-coding": {
    modelsDev: ["kimi-code-plan-global", "kimi-code-plan-cn"],
    plan: { modelsDev: ["kimi-code-plan-global", "kimi-code-plan-cn"] },
  },
  minimax: { modelsDev: ["minimax", "minimax-cn"] },
  mistral: { modelsDev: ["mistral"] },
  moonshot: { modelsDev: ["moonshotai", "moonshotai-cn"] },
  "nvidia-nim": { modelsDev: ["nvidia"] },
  // The ChatGPT/Codex backend ids have no models.dev namespace of their own:
  // the census covers them through the OpenRouter namespaced ids.
  "openai-codex": { openRouter: ["openai"] },
  "opencode-go": { modelsDev: ["opencode-go"] },
  "opencode-zen": { modelsDev: ["opencode"] },
  openrouter: { modelsDev: ["openrouter"] },
  qwen: { openRouter: ["qwen"] },
  together: { openRouter: ["meta-llama"] },
  "vercel-ai-gateway": { openRouter: ["openai"] },
  xai: { modelsDev: ["xai"] },
  "xiaomi-mimo": { modelsDev: ["xiaomi"] },
  zai: { modelsDev: ["zai"], openRouter: ["z-ai"], plan: { modelsDev: ["zai-coding-plan"] } },
};

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

/** Reads a snapshot from a local path or fetches it, recording what was
 * used (the manifest and report name the source, its url and its fetch
 * date — a source outage must be visible, never silent). */
async function loadSnapshot(name: string, url: string, override?: string): Promise<{ json: unknown; info: SourceSnapshotInfo }> {
  const fetchedAt = new Date().toISOString();
  // The recorded url is always the canonical source: a local snapshot
  // (tests, offline debugging) must not make the manifest lie about where
  // the committed data came from.
  if (override !== undefined) {
    if (!existsSync(override)) throw new Error(`${name}: ${override} does not exist`);
    return { json: JSON.parse(readFileSync(override, "utf8")), info: { name, url, fetchedAt } };
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${name}: ${url} answered ${response.status} ${response.statusText}`);
  return { json: await response.json(), info: { name, url, fetchedAt } };
}

function readCatalog(provider: string): CatalogFileJson | undefined {
  const file = join(CATALOG_DIR, `${provider}.json`);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as CatalogFileJson;
}

function readOverrides(provider: string): CatalogOverrides | undefined {
  const file = join(CATALOG_DIR, `${provider}.overrides.json`);
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as CatalogOverrides;
  if (parsed.schemaVersion !== 1) throw new Error(`${file}: unsupported schemaVersion ${parsed.schemaVersion}`);
  if (parsed.provider !== provider) throw new Error(`${file}: declares provider "${parsed.provider}", expected "${provider}"`);
  return parsed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The committed catalog files a rebuild covers — `manifest.json` and
 * `generation-report.json` are artifacts, not catalogs. */
function committedCatalogFiles(): string[] {
  return readdirSync(CATALOG_DIR).filter(
    (file) => file.endsWith(".json") && !file.endsWith(".overrides.json") && file !== "manifest.json" && file !== "generation-report.json",
  );
}

/** The rebuild-and-compare findings: a catalog the rebuild would not write,
 * or one whose bytes do not match the hash the manifest recorded. `--check`
 * fails on them, `--freshness` reports them — one function, so the failing
 * door and the reporting door cannot drift apart. */
function collectDrift(catalogs: BuiltCatalog[], committedManifest: CommittedManifest | undefined): CatalogDriftEntry[] {
  const drift: CatalogDriftEntry[] = [];
  const withSidecar = new Set(catalogs.map((catalog) => catalog.provider));
  for (const name of committedCatalogFiles()) {
    const provider = name.replace(/\.json$/, "");
    if (!withSidecar.has(provider)) {
      drift.push({ file: name, message: "committed catalog without a sidecar — every catalog is generated" });
    }
  }
  for (const catalog of catalogs) {
    const committed = readCatalog(catalog.provider);
    if (!committed) {
      drift.push({ file: `${catalog.provider}.json`, message: "not committed yet" });
      continue;
    }
    if (JSON.stringify(committed) !== catalog.json) {
      drift.push({ file: `${catalog.provider}.json`, message: "differs from the rebuild (run the generator and commit the result)" });
    }
  }
  // The manifest's own hashes: a hand-edited catalog is drift too.
  for (const catalog of catalogs) {
    const recorded = committedManifest?.files?.[catalog.provider]?.sha256;
    if (recorded && recorded !== sha256(catalog.json)) {
      drift.push({ file: `${catalog.provider}.json`, message: "does not match the hash recorded in manifest.json" });
    }
  }
  return drift;
}

async function main(): Promise<number> {
  const providers = readdirSync(CATALOG_DIR)
    .filter((name) => name.endsWith(".overrides.json"))
    .map((name) => name.replace(/\.overrides\.json$/, ""))
    .sort();

  const committedManifest = existsSync(MANIFEST_FILE)
    ? (JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as CommittedManifest)
    : undefined;

  // --- the version contract: offline, before anything is fetched ---
  const release = argValue("--verify-version");
  if (release !== undefined) {
    const problem = releaseVersionProblem(committedManifest?.version, release);
    if (problem) {
      console.error(problem);
      return 1;
    }
    console.log(`manifest.json declares moh ${release} — this catalog belongs to the release being tagged`);
    return 0;
  }

  if (hasFlag("--check") && hasFlag("--freshness")) {
    console.error("--check fails on drift and --freshness reports it: pass one of the two");
    return 2;
  }

  const modelsDev = await loadSnapshot("models.dev", MODELS_DEV_URL, argValue("--models-dev"));
  const openRouter = await loadSnapshot("openrouter", OPENROUTER_URL, argValue("--open-router"));
  const snapshots: AggregatorSnapshots = {
    modelsDev: modelsDev.json as ModelsDevSnapshot,
    openRouter: openRouter.json as OpenRouterSnapshot,
  };
  const sources = [modelsDev.info, openRouter.info];

  const version = argValue("--version") ?? committedManifest?.version;
  if (!version) {
    console.error("--version <x.y.z> is required: it declares the moh release that will contain the catalog");
    return 2;
  }

  // --- one-off migration: committed catalogs → hand-maintained sidecars ---
  if (hasFlag("--migrate-overrides")) {
    let written = 0;
    for (const provider of readdirSync(CATALOG_DIR).filter((name) => name.endsWith(".json")).map((name) => name.replace(/\.json$/, "")).sort()) {
      const previous = readCatalog(provider);
      if (!previous) continue;
      const source = MIGRATION_SOURCES[provider];
      if (!source) {
        console.error(`${provider}: no declared aggregator source in this script — add it before migrating`);
        return 1;
      }
      if (existsSync(join(CATALOG_DIR, `${provider}.overrides.json`))) {
        // The migration is one-off and would discard hand-authored rows: it
        // refuses to overwrite a sidecar that already exists.
        console.error(`${provider}: ${provider}.overrides.json exists — delete it first if you really mean to re-migrate`);
        return 1;
      }
      const { overrides, notes } = migrateOverrides({
        provider,
        source,
        previous,
        snapshots,
        stamp: { author: "moh migration (#959)", date: new Date().toISOString().slice(0, 10) },
      });
      writeFileSync(join(CATALOG_DIR, `${provider}.overrides.json`), serializeJson(overrides));
      written += 1;
      const byCode = new Map<string, number>();
      for (const note of notes) byCode.set(note.code, (byCode.get(note.code) ?? 0) + 1);
      console.log(
        `${provider}: ${Object.keys(overrides.rows).length} rows declared` +
          (byCode.size > 0 ? ` (${[...byCode].map(([code, count]) => `${code}=${count}`).join(", ")})` : ""),
      );
    }
    console.log(`\nmigrated ${written} catalogs — review the sidecars, then run without --migrate-overrides`);
    return 0;
  }

  // --- build ---
  const catalogs = [];
  const previousByProvider: Record<string, CatalogFileJson> = {};
  /** A guard error is a rebuild that still happened; a thrown fetch is not.
   * `--freshness` tolerates the first and reports it, and must not pretend
   * to report the second. */
  const failures: string[] = [];
  const guardFailures: string[] = [];
  let rebuilt = true;
  try {
    for (const provider of providers) {
      const overrides = readOverrides(provider);
      if (!overrides) continue;
      if (!overrides.source || Object.keys(overrides.source).length === 0) {
        guardFailures.push(`${provider}: the sidecar declares no aggregator source`);
        continue;
      }
      const previous = readCatalog(provider);
      if (previous) previousByProvider[provider] = previous;
      const built = buildCatalog(overrides, snapshots, previous ? { previous } : {});
      catalogs.push(built);
      for (const issue of built.issues) {
        if (issue.level === "error") guardFailures.push(`${provider}${issue.id ? `/${issue.id}` : ""}: ${issue.code}: ${issue.message}`);
      }
    }
    failures.push(...guardFailures);
  } catch (error) {
    // An aggregator that does not answer in the shape the builder expects:
    // "did not regenerate", and no compare to report.
    rebuilt = false;
    failures.push(`the rebuild aborted before it could compare: ${error instanceof Error ? error.message : String(error)}`);
  }

  // --- freshness mode: the same compare as --check, reported instead of
  // judged (#1005). The release pipeline runs this: at a 4-5 hour drift
  // window a red at every tag says nothing, so the tag-time job states the
  // facts — which release the data declares, how old it is against the
  // tagged commit, how far upstream has moved — and nothing it can report
  // makes it fail.
  //
  // A rebuild the guards reject shrinks the report, it does not kill it: the
  // age and the drifted-file count come from the committed manifest and the
  // compare, which need no accepted rebuild, while the row-level moves need
  // one. So the row counts read `--`, the file count is a lower bound, and
  // the guard findings are listed — because the release whose catalog no
  // longer reproduces is exactly the release whose freshness is worth
  // reading. That is what "never fails on drift" has to mean in practice:
  // there is no flavour of drift that turns this job red.
  //
  // The one failure left is not measuring at all — a source that could not
  // be fetched (thrown above), where there is nothing to compare and no
  // honest report to print.
  if (hasFlag("--freshness")) {
    if (!rebuilt) {
      console.error("the catalog could not be fetched, so there is nothing to report — this is 'did not regenerate', not 'up to date'");
      return 1;
    }
    const reference = argValue("--at") ?? new Date().toISOString();
    const drift = collectDrift(catalogs, committedManifest);
    const freshness = freshnessReport({
      manifest: committedManifest,
      reference,
      drift,
      totalFiles: committedCatalogFiles().length,
      rebuiltFiles: catalogs.length,
    });
    const rejected = guardFailures.length > 0;
    const changes = rejected
      ? undefined
      : buildReport({
          version,
          generatedAt: committedManifest?.generatedAt ?? reference,
          sources,
          catalogs,
          previous: previousByProvider,
        }).changes;
    console.log(
      formatFreshness(
        freshness,
        changes === undefined ? undefined : { pricing: changes.pricing.length, contextWindow: changes.contextWindow.length, reasoning: changes.reasoning.length },
        drift,
        changes === undefined
          ? []
          : [
              ...changes.pricing.map(
                (change) =>
                  `price: ${change.provider}/${change.id} ${change.from.input}/${change.from.output} → ${change.to.input}/${change.to.output} USD per 1M`,
              ),
              ...changes.contextWindow.map((change) => `context: ${change.provider}/${change.id} ${change.from} → ${change.to}`),
              ...changes.reasoning.map((change) => `reasoning: ${change.provider}/${change.id} ${change.from} → ${change.to}`),
            ],
      ),
    );
    for (const failure of guardFailures) console.log(`  guard: ${failure}`);
    console.log(
      drift.length === 0 && guardFailures.length === 0
        ? "advisory: the committed catalog matches the rebuild — nothing here gates the release"
        : `advisory: ${drift.length} committed file(s) differ and ${guardFailures.length} guard finding(s) — regenerate and commit before the tag if it matters for this release (the release ships the committed catalog); nothing here gates`,
    );
    return 0;
  }

  // --- check mode: rebuild and compare, never write ---
  if (hasFlag("--check")) {
    if (failures.length > 0) {
      console.error(`generation failed — ${failures.length} failure(s); nothing was written:`);
      for (const failure of failures) console.error(`  ${failure}`);
      return 1;
    }
    const drift = collectDrift(catalogs, committedManifest);
    if (drift.length > 0) {
      console.error(`catalog drift — ${drift.length} file(s):`);
      for (const entry of drift) console.error(`  ${entry.file}: ${entry.message}`);
      return 1;
    }
    console.log(`catalogs match the rebuild from ${sources.map((source) => source.url).join(" + ")} (${catalogs.length} files)`);
    return 0;
  }

  // --- write catalogs + manifest + report ---
  const hashes: Record<string, string> = {};
  for (const catalog of catalogs) {
    writeFileSync(join(CATALOG_DIR, `${catalog.provider}.json`), catalog.json);
    hashes[catalog.provider] = sha256(catalog.json);
  }
  const manifest = buildManifest({
    version,
    generatedAt: new Date().toISOString(),
    sources,
    catalogs,
    hashes,
  });
  writeFileSync(MANIFEST_FILE, serializeJson(manifest));

  const report = buildReport({
    version,
    generatedAt: manifest.generatedAt,
    sources,
    catalogs,
    previous: previousByProvider,
  });
  writeFileSync(REPORT_FILE, serializeJson(report));

  const warnings = catalogs.flatMap((catalog) => catalog.issues.filter((issue) => issue.level === "warning"));
  console.log(`wrote ${catalogs.length} catalogs + manifest.json + generation-report.json (moh ${version})`);
  console.log(
    `rows: ${report.totals.rows} — exact ${report.totals.exact}, via join keys ${report.totals.baseModel}, hand-maintained ${report.totals.absent}`,
  );
  console.log(
    `changes vs the committed catalog: ${report.changes.pricing.length} prices, ${report.changes.contextWindow.length} context windows, ${report.changes.reasoning.length} reasoning flags`,
  );
  if (report.contextWindowShrinks.length > 0) {
    console.log(`contextWindow corrections accepted: ${report.contextWindowShrinks.length} (see generation-report.json)`);
  }
  for (const warning of warnings) console.warn(`warning: ${warning.provider}/${warning.id}: ${warning.message}`);
  return 0;
}

if (import.meta.main) process.exit(await main());
