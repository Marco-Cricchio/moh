/**
 * Regenerate the vendored subscription model catalogs (#156) from an
 * installed copy of @earendil-works/pi-ai (MIT). Copies
 * providers/data/{anthropic,openai-codex,google}.json verbatim into
 * src/model-catalogs/ and prints the pi-ai version for the README.
 *
 * #338: pi-ai's data is inconsistent across catalogs — the same model id
 * may carry a `thinkingLevelMap` in one catalog and be missing it in
 * another. After the verbatim copy, `deriveThinkingLevelMaps` fills gaps
 * by EXACT model-id match AND same `api` (wire) against every other pi-ai
 * catalog: a map's native values are wire-specific, so a map transplant
 * across wires would send invalid effort strings. Exact+same-api only —
 * family/generation guesses are deliberately not derived; anything left
 * is genuinely unlabelled upstream and stays config-declared (#256).
 * The script reads only from the pi-ai source dir and writes to the
 * vendored target; never point it at an in-tree pi-ai copy.
 *
 * Usage: bun run packages/core/scripts/regen-model-catalogs.ts <pi-ai-dir>
 */
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const target = join(import.meta.dir, "../src/model-catalogs");
const files = [
  "anthropic.json",
  "openai-codex.json",
  "google.json",
  "github-copilot.json",
  "openrouter.json",
  "kimi-coding.json",
  "xai.json",
];
const zaiFile = "zai.json";

export type ModelEntry = {
  id?: string;
  reasoning?: boolean | Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null>;
};
export type Catalog = Record<string, Record<string, ModelEntry>>;

/** Lowercased alphanumerics — the id-normalization used for matching. */
export function normalizeModelId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The matching key for an OpenRouter-style id: vendor prefix and
 * `:variant` suffix removed (`anthropic/claude-haiku-4.5:batch` →
 * `claude-haiku-4.5`). Non-prefixed ids only lose the suffix. */
export function baseModelId(id: string): string {
  const noVariant = id.split(":")[0]!;
  return noVariant.includes("/") ? noVariant.split("/").slice(1).join("/") : noVariant;
}

/** Index of every model that HAS a thinkingLevelMap across all catalogs:
 * (normalized id, api) → the map — same wire only (native values are
 * wire-specific). First catalog wins (deterministic: files sorted). */
export function buildThinkingIndex(dataDir: string): Map<string, Record<string, string | null>> {
  const index = new Map<string, Record<string, string | null>>();
  for (const file of readdirSync(dataDir).sort()) {
    if (!file.endsWith(".json")) continue;
    let catalog: Catalog;
    try {
      catalog = JSON.parse(readFileSync(join(dataDir, file), "utf8")) as Catalog;
    } catch {
      console.warn(`${file}: malformed JSON, skipped`);
      continue;
    }
    for (const [api, models] of Object.entries(catalog)) {
      for (const [id, entry] of Object.entries(models ?? {})) {
        if (entry?.thinkingLevelMap && !index.has(`${normalizeModelId(id)}\0${api}`)) {
          index.set(`${normalizeModelId(id)}\0${api}`, entry.thinkingLevelMap);
        }
      }
    }
  }
  return index;
}

/** Fills `thinkingLevelMap` on reasoning-capable entries lacking one, by
 * exact base-id + same-`api` match against the index. Mutates `catalog`;
 * returns the number of entries derived. */
export function deriveThinkingLevelMaps(
  catalog: Catalog,
  index: Map<string, Record<string, string | null>>,
): number {
  let derived = 0;
  for (const [api, models] of Object.entries(catalog)) {
    for (const entry of Object.values(models ?? {})) {
      if (!entry?.reasoning || entry.thinkingLevelMap) continue;
      const hit = index.get(`${normalizeModelId(baseModelId(entry.id ?? ""))}\0${api}`);
      if (hit) {
        entry.thinkingLevelMap = hit;
        derived++;
      }
    }
  }
  return derived;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: bun run regen-model-catalogs.ts <path-to-pi-ai>");
    process.exit(2);
  }

  for (const base of [join(arg, "dist/providers/data"), join(arg, "providers/data")]) {
    if (!existsSync(join(base, files[0]!))) continue;
    const index = buildThinkingIndex(base);
    for (const file of files) {
      const catalog = JSON.parse(readFileSync(join(base, file), "utf8")) as Catalog;
      const derived = deriveThinkingLevelMaps(catalog, index);
      if (derived > 0) {
        await Bun.write(join(target, file), JSON.stringify(catalog));
        console.log(`${file}: derived thinkingLevelMap for ${derived} entries (#338)`);
      } else {
        copyFileSync(join(base, file), join(target, file));
      }
    }
    // Z.ai's pi-ai catalog is a provider module rather than a providers/data
    // JSON asset. Normalize it to the same `{ api: { id: entry } }` shape.
    const zaiModule = join(arg, "dist/providers/zai.models.js");
    if (!existsSync(zaiModule)) {
      console.error(`no ${zaiModule}; cannot regenerate ${zaiFile}`);
      process.exit(1);
    }
    const { ZAI_MODELS } = await import(pathToFileURL(zaiModule).href) as { ZAI_MODELS: unknown };
    await Bun.write(join(target, zaiFile), JSON.stringify({ "openai-completions": ZAI_MODELS }));
    const version = JSON.parse(readFileSync(join(arg, "package.json"), "utf8")).version as string;
    console.log(`copied ${files.join(", ")} and generated ${zaiFile} from ${base} (pi-ai ${version})`);
    console.log(`update the source-version note in ${target}/README.md`);
    process.exit(0);
  }

  console.error(`no providers/data/{${files.join(",")}} under ${arg}`);
  process.exit(1);
}

if (import.meta.main) await main();
