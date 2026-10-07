/**
 * `moh-extension-team`: the first-party team extension (ADR-0074, #1220).
 *
 * Scope of this layer (ticket #1220, slice 2a): the skeleton up to a working
 * enable consent — the manifest declares the `spawn-subagent` grant, the
 * enable question names the envelope (children cap, scopes, stop; the
 * NOT-do list rides the manifest's `reasoning`), and after enable the
 * context exposes the ADR-0055 spawn API. Nothing orchestrates yet: a
 * disabled extension contributes nothing, and no UI is contributed, so a
 * session without it is byte-identical.
 *
 * Boundary: the core never learns about teams — it knows only the generic
 * `spawn-subagent` capability (ADR-0053/0055) and the manifest authority
 * the consent signs. Roles, the task bag, and the panel belong to later
 * tickets (#1223, #1224, #1225).
 *
 * The default export is the factory below; the registration helper pairs it
 * with the manifest authority so a client enables the extension through the
 * consented in-memory door — never the bundled one, which would skip the
 * enable question the envelope is named in.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineExtension, MOH_EXTENSION_API_VERSION, type ExtensionDefinition } from "@moh/extension";

/** The extension's name, as stamped in the log and shown in /extensions. */
export const TEAM_NAME = "team";
/** The definition's version, reported by the `extension_loaded` event. */
export const TEAM_VERSION = "0.1.0";

/**
 * The manifest authority the consent signs (ADR-0061): derived from the
 * package's own `moh.extension.json` — the physical file is what a registry
 * install verifies, and this reads its exact bytes once, so the hash the
 * question shows is the hash on disk.
 */
export function teamManifestAuthority(): {
  hash: string;
  path: string;
  capabilities: readonly string[];
  reasoning: string;
} {
  const file = join(dirname(import.meta.dir), "moh.extension.json");
  if (!existsSync(file)) {
    throw new Error(`the team extension's ${"moh.extension.json"} is missing beside ${import.meta.dir} — the consent has nothing to sign`);
  }
  const bytes = readFileSync(file);
  const parsed = JSON.parse(bytes.toString("utf8")) as { capabilities?: string[]; reasoning?: string };
  return {
    hash: createHash("sha256").update(bytes).digest("hex"),
    path: file,
    capabilities: parsed.capabilities ?? [],
    reasoning: parsed.reasoning ?? "",
  };
}

/**
 * Builds the team extension's definition. A factory, not a ready-made
 * definition: later slices pass the seams only a session assembly owns.
 */
export function createTeamExtension(): ExtensionDefinition {
  return defineExtension({
    name: TEAM_NAME,
    version: TEAM_VERSION,
    apiVersion: MOH_EXTENSION_API_VERSION,
    capabilities: ["spawn-subagent"],
    setup: () => {
      // Ticket #1220 stops here: nothing orchestrates yet. The granted
      // `spawn-subagent` slot puts `ctx.spawnSubagent`/`ctx.subagentActivity`
      // on the context (enforcement by absence); consumers arrive with the
      // task bag (#1223) and the roles (#1224).
    },
  });
}

export default createTeamExtension;
