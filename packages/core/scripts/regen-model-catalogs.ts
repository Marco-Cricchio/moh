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

const target = join(import.meta.dir, "../src/model-catalogs");
const files = ["anthropic.json", "openai-codex.json", "google.json"];

const arg = process.argv[2];
if (!arg) {
  console.error("usage: bun run regen-model-catalogs.ts <path-to-pi-ai>");
  process.exit(2);
}

for (const base of [join(arg, "dist/providers/data"), join(arg, "providers/data")]) {
  if (!existsSync(join(base, files[0]!))) continue;
  for (const file of files) copyFileSync(join(base, file), join(target, file));
  const version = JSON.parse(readFileSync(join(arg, "package.json"), "utf8")).version as string;
  console.log(`copied ${files.join(", ")} from ${base} (pi-ai ${version})`);
  console.log(`update the source-version note in ${target}/README.md`);
  process.exit(0);
}

console.error(`no providers/data/{${files.join(",")}} under ${arg}`);
process.exit(1);
