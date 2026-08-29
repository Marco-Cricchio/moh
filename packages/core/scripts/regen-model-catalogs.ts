/**
 * Regenerate the vendored subscription model catalogs (#156) from an
 * installed copy of @earendil-works/pi-ai (MIT). Copies
 * providers/data/{anthropic,openai-codex,google}.json verbatim into
 * src/model-catalogs/ and prints the pi-ai version for the README.
 *
 * Usage: bun run packages/core/scripts/regen-model-catalogs.ts <pi-ai-dir>
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
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

const arg = process.argv[2];
if (!arg) {
  console.error("usage: bun run regen-model-catalogs.ts <path-to-pi-ai>");
  process.exit(2);
}

for (const base of [join(arg, "dist/providers/data"), join(arg, "providers/data")]) {
  if (!existsSync(join(base, files[0]!))) continue;
  for (const file of files) copyFileSync(join(base, file), join(target, file));
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
