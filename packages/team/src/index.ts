/**
 * `moh-extension-team`: the first-party team extension (ADR-0074, #1220).
 *
 * Scope of this layer (ticket #1221, slice 2b; #1222, slice 2c): the
 * one-member team, end to end, plus steering. The `team` tool is
 * contributed to the session's model (ADR-0067); when the user asks to
 * work on something with the team, the model calls it with the task and
 * the extension composes the single builder member through the ADR-0055
 * spawn API. The child runs as a real subagent session (own route,
 * ADR-0050), the extension reads its turn activity (child-tail shape,
 * never the provider reasoning) and the settled outcome returns to the
 * model as the tool result. A follow-up call with `member` + `message`
 * steers the member (ADR-0055 write-into-child): its next turn keeps the
 * member's context and route, and the new outcome returns to the lead.
 * The task bag is slice 3 (#1223, this file + `task-bag.ts`);
 * the roles (#1224) and the panel (#1225) arrive later.
 *
 * Scope of the task bag (#1223): the extension-owned coordination seam
 * (ADR-0074). The `team` tool grows two shapes: `plan` decomposes the
 * brief into bag tasks (whole or nothing, `blockedBy` refs validated up
 * front) and `work` runs a member through the bag — the extension claims
 * the next claimable task, hands the member only that task (spawn, then
 * steering for the follow-ups), and records every transition
 * (`team_task_created`/`_claimed`/`_completed`) as chrome events, so the
 * board reconstructs from the log alone (`replayBoard`).
 *
 * Boundary: the core never learns about teams — it knows only the generic
 * `spawn-subagent` capability (ADR-0053/0055) and the manifest authority
 * the consent signs. Roles and the panel belong to later tickets
 * (#1224, #1225).
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
import { TASK_CLAIMED, TASK_COMPLETED, TASK_CREATED, TaskBag, type BagTask } from "./task-bag";
export { replayBoard, TASK_CLAIMED, TASK_COMPLETED, TASK_CREATED, TaskBag } from "./task-bag";

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
 * The `team` tool's argument shape, checked before anything happens: a
 * spawn supplies the `task`; a steering write-into-child (#1222) supplies
 * the `member` and the `message` — the two are exclusive; `plan` (#1223)
 * decomposes the brief into bag tasks and `work` runs a member through
 * the bag (self-serve).
 */
const teamArgsSchema = z.object({
  task: z.string().min(1).optional(),
  member: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
  plan: z.array(z.object({ title: z.string().min(1), blockedBy: z.array(z.string()).optional() })).min(1).optional(),
  work: z.string().min(1).optional(),
});

/**
 * The self-serve loop (#1223): the member works through the bag — the
 * extension claims the next claimable task, spawns or steers the member
 * with that one task, records the transition, and hands it the next one
 * until nothing claimable remains. Each turn's task text names only that
 * task: the member sees its work, never the bag or another member.
 */
async function selfServeLoop(
  ctx: import("@moh/extension").ExtensionSetupContext,
  members: Map<string, string>,
  bag: TaskBag,
  member: string,
  work: string,
): Promise<string> {
  const reports: string[] = [];
  // A failed completion releases the task back to open; without a guard the
  // loop would re-claim the same failing task forever. One pass: each task
  // is attempted at most once per `work` call, so the loop terminates after
  // at most as many iterations as there are tasks.
  const skipped = new Set<string>();
  for (;;) {
    const next = [...bag.tasks.values()].find((task) => !skipped.has(task.id) && task.id === bag.claimable()?.id);
    if (!next) break;
    if (!bag.claim(next.id, member)) break;
    const callId = members.get(member);
    const prompt = `${work}\n\nTask ${next.id}: ${next.title}`;
    const steered = callId !== undefined ? await ctx.steerSubagent!(callId, prompt) : null;
    const outcome = steered ?? (await ctx.spawnSubagent!({ name: member, task: prompt }));
    if (outcome.callId) members.set(member, outcome.callId);
    bag.complete(next.id, outcome.status);
    if (outcome.status !== "done") skipped.add(next.id);
    ctx.appendEvent({
      name: TASK_CLAIMED,
      payload: { id: next.id, member },
    });
    ctx.appendEvent({
      name: TASK_COMPLETED,
      payload: {
        id: next.id,
        member,
        outcome: outcome.status,
        outputChars: outcome.output.length,
        ...(outcome.error ? { error: outcome.error } : {}),
      },
    });
    reports.push(
      outcome.status === "done"
        ? `${next.id} (${next.title}): ${outcome.output}`
        : `${next.id} (${next.title}): ${outcome.status}${outcome.error ? ` — ${outcome.error}` : ""}`,
    );
  }
  return `${bag.summary()}\n${reports.join("\n")}`;
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
    capabilities: ["spawn-subagent", "contribute-tool:team"],
    setup: (ctx) => {
      // Ticket #1221 (slice 2b): the one-member team, end to end. The
      // model sees the `team` tool; when the user asks to work on
      // something with the team, the model calls it with the task and
      // this extension composes the single builder member through the
      // ADR-0055 spawn API. The child runs as a real subagent session
      // (own route, ADR-0050); its settled outcome returns to the model
      // as the tool result, so it flows into the parent's turn.
      // Ticket #1222 (slice 2c): steering — the lead relays a follow-up
      // message to a member it spawned (ADR-0055 write-into-child); the
      // member keeps its context and route, and the new turn's outcome
      // returns to the lead. Star-shaped by construction: the API only
      // reaches children this extension spawned, and the host excludes
      // the contributed `team` tool from every child's toolset, so a
      // member cannot address another member.
      if (typeof ctx.registerTool !== "function" || typeof ctx.spawnSubagent !== "function" || typeof ctx.steerSubagent !== "function") {
        return; // enforcement by absence: no grant, no team (unreachable with the granted manifest)
      }
      // The members this lead spawned: name → callId, the set steering
      // can reach. A member that is not here does not exist.
      const members = new Map<string, string>();
      ctx.registerTool({
        name: "team",
        description:
          "Delegate work to the team or steer an existing member. " +
          "Spawn: pass `task` — spawns a builder member as a child session that works on the task and returns its result. " +
          "Plan: pass `plan` — decomposes the brief into bag tasks; then pass `work` (and optionally `member`) to run a member through the bag. " +
          "Steer: pass `member` + `message` — relays a follow-up instruction to that member's next turn (it keeps its context) and returns the new outcome. " +
          "Use when the user asks to work on something with the team, or to correct or redirect one of its members.",
        inputSchema: teamArgsSchema,
        execute: async (args) => {
          const parsed = teamArgsSchema.safeParse(args);
          if (!parsed.success) return `team: refused — ${parsed.error.issues[0]?.message ?? "invalid arguments"}`;
          const { task, member, message, plan, work } = parsed.data as {
            task?: string;
            member?: string;
            message?: string;
            plan?: { title: string; blockedBy?: string[] }[];
            work?: string;
          };
          // The bag survives hot-reloads in the per-extension durable state;
          // a fresh session starts empty.
          const state = ctx.state as { bag?: TaskBag };
          if (!(state.bag instanceof TaskBag)) state.bag = new TaskBag();
          const bag = state.bag;
          if (plan !== undefined) {
            if (task !== undefined || member !== undefined || message !== undefined) {
              return "team: refused — pass either `plan` (decompose the brief into tasks) or `task`/`member` (spawn/steer), not both";
            }
            // Whole or nothing: `create` validates every `blockedBy` ref
            // before any mutation and throws on a dangling one.
            let created: BagTask[];
            try {
              created = bag.create(plan);
            } catch (error) {
              return `team: refused — ${(error as Error).message}`;
            }
            for (const task2 of created) {
              ctx.appendEvent({
                name: TASK_CREATED,
                payload: { id: task2.id, title: task2.title, blockedBy: [...task2.blockedBy] },
              });
            }
            return `team: planned ${created.length} tasks — ${bag.summary()}`;
          }
          if (work !== undefined) {
            if (task !== undefined || message !== undefined) {
              return "team: refused — `work` takes an optional `member` name for the new member, not a steering target";
            }
            if (bag.tasks.size === 0) {
              return "team: refused — the task bag is empty; pass `plan` first to decompose the brief into tasks";
            }
            // #1223 self-serve loop: the member claims the next claimable
            // task, works it, and the extension hands it the next one until
            // nothing claimable remains (dependencies or the bag's end).
            // Star-shaped: the member's prompt names only its own task —
            // never the bag, never another member.
            return await selfServeLoop(ctx, members, bag, member ?? "builder", work);
          }
          if (member !== undefined || message !== undefined) {
            if (plan !== undefined || work !== undefined) {
              return "team: refused — pass either `member` + `message` (steer) or `plan`/`work` (bag), not both";
            }
            if (task !== undefined) return "team: refused — pass either `task` (spawn) or `member` + `message` (steer), not both";
            if (member === undefined || message === undefined) return "team: refused — steering needs both `member` and `message`";
            const callId = members.get(member);
            if (callId === undefined) {
              const known = [...members.keys()];
              return `team: no member "${member}"${known.length > 0 ? ` — members: ${known.join(", ")}` : " — the team has no members yet"}`;
            }
            const result = await ctx.steerSubagent!(callId, message);
            if (!result) {
              return `team: refused — member "${member}" is not reachable for steering`;
            }
            // The lead's view of the member: the post-steering outcome
            // recorded once, so the log holds what the extension read.
            const activity = await ctx.subagentActivity?.(callId);
            ctx.appendEvent({
              name: "team_member_steer",
              payload: {
                member,
                callId,
                message,
                status: result.status,
                outputChars: result.output.length,
                ...(activity ? { activity } : {}),
              },
            });
            return result.status === "done"
              ? `team member ${member} took the steering:\n${result.output}`
              : `team member ${member} steering ${result.status}${result.error ? `: ${result.error}` : ""}`;
          }
          if (task === undefined) {
            return "team: refused — pass `task` to spawn a member, `plan` to decompose the brief, `work` to run the bag, or `member` + `message` to steer";
          }
          if (plan !== undefined) {
            return "team: refused — pass either `task` (spawn) or `plan` (decompose the brief), not both";
          }
          const result = await ctx.spawnSubagent!({ name: "builder", task });
          if (result.callId) members.set("builder", result.callId);
          // The child-tail activity (never the provider reasoning),
          // recorded once at settle so the log holds what the extension
          // read; the parent reconstructs who worked on what.
          const activity = await ctx.subagentActivity?.(result.callId);
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
