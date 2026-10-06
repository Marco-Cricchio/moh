/**
 * `moh-extension-team`: the first-party team extension (ADR-0074, #1220).
 *
 * Scope of this layer (ticket #1221, slice 2b): the one-member team, end
 * to end. The `team` tool is contributed to the session's model (ADR-0067);
 * when the user asks to work on something with the team, the model calls
 * it with the task and the extension composes the single builder member
 * through the ADR-0055 spawn API. The child runs as a real subagent
 * session (own route, ADR-0050), the extension reads its turn activity
 * (child-tail shape, never the provider reasoning) and the settled
 * outcome returns to the model as the tool result. The task bag (#1223),
 * the roles (#1224) and the panel (#1225) arrive later.
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
import { z } from "zod";

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
 * The `team` tool's argument shape, checked before anything spawns: the
 * task is the only thing the model must supply — the team composition is
 * the extension's judgment (ADR-0074), not the caller's.
 */
const teamArgsSchema = z.object({ task: z.string().min(1) });

/**
 * Builds the team extension's definition. A factory, not a ready-made
 * definition: later slices pass the seams only a session assembly owns.
 */
export function createTeamExtension(): ExtensionDefinition {
  return defineExtension({
    name: TEAM_NAME,
    version: TEAM_VERSION,
    apiVersion: MOH_EXTENSION_API_VERSION,
    capabilities: ["spawn-subagent", "contribute-tool:team"],
    setup: (ctx) => {
      // Ticket #1221 (slice 2b): the one-member team, end to end. The
      // model sees the `team` tool; when the user asks to work on
      // something with the team, the model calls it with the task and
      // this extension composes the single builder member through the
      // ADR-0055 spawn API. The child runs as a real subagent session
      // (own route, ADR-0050); its settled outcome returns to the model
      // as the tool result, so it flows into the parent's turn.
      if (typeof ctx.registerTool !== "function" || typeof ctx.spawnSubagent !== "function") {
        return; // enforcement by absence: no grant, no team (unreachable with the granted manifest)
      }
      ctx.registerTool({
        name: "team",
        description:
          "Delegate a task to the team: spawns a builder member as a child session that works on the task and returns its result. Use when the user asks to work on something with the team.",
        inputSchema: teamArgsSchema,
        execute: async (args) => {
          const parsed = teamArgsSchema.safeParse(args);
          if (!parsed.success) return `team: refused — ${parsed.error.issues[0]?.message ?? "invalid arguments"}`;
          const { task } = parsed.data as { task: string };
          const result = await ctx.spawnSubagent!({ name: "builder", task });
          // The child-tail activity (never the provider reasoning),
          // recorded once at settle so the log holds what the extension
          // read; the parent reconstructs who worked on what.
          const activity = ctx.subagentActivity?.(result.callId);
          ctx.appendEvent({
            name: "team_member_done",
            payload: {
              callId: result.callId,
              member: "builder",
              task,
              status: result.status,
              outputChars: result.output.length,
              ...(activity ? { activity } : {}),
            },
          });
          return result.status === "done"
            ? `team member builder finished:\n${result.output}`
            : `team member builder ${result.status}${result.error ? `: ${result.error}` : ""}`;
        },
      });
    },
  });
}

export default createTeamExtension;

/**
 * The bundled descriptor (ADR-0074): the client mounts this source and the
 * extension ships out of the box with the binary — always active, gated by
 * the enable consent, which names the envelope. No config block: the
 * enable question is the switch.
 *
 * Literals, not `teamManifestAuthority()`: inside the compiled binary
 * `import.meta.dir` is the bundler's virtual root and there is no physical
 * manifest to read — jev-guard declares its scopes the same way. The
 * anti-drift test pins these literals to the physical manifest.
 */
export const teamBundledSource = {
  name: TEAM_NAME,
  manifest: {
    capabilities: ["spawn-subagent", "contribute-tool:team"] as string[],
    // ADR-0066: the NOT-do list rides the enable question.
    reasoning:
      "The team extension coordinates child sessions as one team: up to 10 concurrent children, per-role path scopes, one stop for everything it started. It does not add peer messaging between members — steering flows through the team lead — and its children never spawn grandchildren.",
  },
  // ADR-0074: the enable consent names the envelope — the user grants it,
  // the stored answer remembers it. Shipping in the binary does not grant it.
  consentRequired: true,
  activate(): unknown {
    return createTeamExtension();
  },
};
