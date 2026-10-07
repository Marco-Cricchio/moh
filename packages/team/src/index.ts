/**
 * `moh-extension-team`: the first-party team extension (ADR-0074, #1220).
 *
 * Scope of this layer (ticket #1224, slice 4): composition by complexity.
 * The `team` tool grows a `compose` shape: the model judges the ask and
 * names the members — builders with disjoint path scopes (enforced by the
 * permission spine, `pathScopes` on the spawn), optional lane pins
 * (ADR-0060: the member works its whole blocked-by chain inside its own
 * worktree) and model routes (ADR-0050); reviewers are read-only by
 * scope. A single unscoped builder composes one member — the hybrid keeps
 * the plain `task` spawn for the ask that needs none of it. The
 * composition lands in a `team_composed` chrome event (recorded, never
 * silent), the roster then drives `work`'s self-serve loop round-robin.
 *
 * Scope of the earlier layers: the one-member team (#1221), steering
 * (#1222), the task bag (#1223). Boundary: the core never learns about
 * teams — roles live entirely in this extension; the envelope (10
 * children, no grandchildren, restrict-only) is the ADR-0055 grant the
 * enable consent signs. The panel is #1225.
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
import { createTeamPanel, createTeamPanelState, markMemberWorking, settleMember, type TeamPanelState } from "./panel";
export { createTeamPanelState, type PanelMember, type PanelMemberStatus, type TeamPanelState } from "./panel";
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
 * One member spec of a `compose` call (#1224): the role plus its
 * optional envelope fields and, at dispatch time, its own task.
 */
export const memberSpecSchema = z.object({
  role: z.enum(["builder", "reviewer"]),
  name: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  lane: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  task: z.string().min(1).optional(),
});
export type MemberSpec = z.infer<typeof memberSpecSchema>;

/**
 * The `team` tool's argument shape, checked before anything happens: a
 * spawn supplies the `task`; a steering write-into-child (#1222) supplies
 * the `member` and the `message` — the two are exclusive; `plan` (#1223)
 * decomposes the brief into bag tasks and `work` runs a member through
 * the bag (self-serve); `compose` (#1224) registers a team of scoped
 * members and dispatches the ones that carry a task.
 */
const teamArgsSchema = z.object({
  task: z.string().min(1).optional(),
  member: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
  plan: z.array(z.object({ title: z.string().min(1), blockedBy: z.array(z.string()).optional() })).min(1).optional(),
  work: z.string().min(1).optional(),
  compose: z.array(memberSpecSchema).min(1).optional(),
  brief: z.string().min(1).optional(),
});

/**
 * One composed member of the team (#1224): an envelope preset in the
 * ADR-0055 shape — builders carry a write-path scope and may pin a lane
 * (ADR-0060) and a model route (ADR-0050); the reviewer is read-only by
 * scope (empty `pathScopes` on the spawn — `write`/`edit` are denied by
 * the permission spine, not by prompt discipline; a bash write is
 * outside the spine's path rules and is covered by the parent's own
 * permission posture, as for any child). A pinned lane that does not
 * exist degrades visibly (#1224 follow-up): the member works un-laned,
 * `team_lane_skipped` records the skip, and the tool result names
 * `/lanes` — never a hard error at the end of the chain.
 */
export interface TeamMember {
  readonly name: string;
  readonly role: "builder" | "reviewer";
  readonly scope?: string;
  readonly lane?: string;
  readonly model?: string;
}

/** The chrome event the composition decision lands in — recorded, never silent. */
export const TEAM_COMPOSED = "team_composed";
/**
 * The visible degradation of a pinned lane that does not exist (#1224
 * follow-up): the member works un-laned, this event records `{ member,
 * lane }`, and the tool result names the agent door (bash `moh lanes
 * start`, consented per the session mode: ask in normal — once, then
 * the "always" session rule covers the next lane command; auto-accept
 * lifts it; yolo runs it) and `/lanes` as the human door — an error at
 * the end of the chain is the one friction this never gives the user.
 */
export const TEAM_LANE_SKIPPED = "team_lane_skipped";

/**
 * Validates and names a composition (#1224). Refusals are loud: a
 * reviewer carries no scope or lane (read-only is the role), two scoped
 * builders must be disjoint, names must be unique. Default names count
 * per role (`builder-1`, `reviewer-1`, …). The spec order is preserved —
 * callers may index back into the original `compose` array.
 */
export function normalizeComposition(specs: readonly MemberSpec[]): TeamMember[] {
  const counters = { builder: 0, reviewer: 0 };
  const members: TeamMember[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    if (spec.role === "reviewer" && (spec.scope !== undefined || spec.lane !== undefined)) {
      throw new Error(`member "${spec.name ?? "(unnamed)"}": a reviewer carries no scope or lane — read-only is the role itself`);
    }
    counters[spec.role] += 1;
    const name = spec.name ?? `${spec.role}-${counters[spec.role]}`;
    if (seen.has(name)) throw new Error(`duplicate member name: ${name}`);
    seen.add(name);
    members.push({
      name,
      role: spec.role,
      ...(spec.scope !== undefined ? { scope: spec.scope } : {}),
      ...(spec.lane !== undefined ? { lane: spec.lane } : {}),
      ...(spec.model !== undefined ? { model: spec.model } : {}),
    });
  }
  // Two scoped builders must not overlap: a file both could write is a
  // conflict the composition, not the model at write time, must settle.
  const scoped = members.filter((m) => m.scope !== undefined);
  for (let i = 0; i < scoped.length; i++) {
    for (let j = i + 1; j < scoped.length; j++) {
      const a = scoped[i]!.scope!;
      const b = scoped[j]!.scope!;
      // Composition-time conflict check, not enforcement: glob-vs-glob
      // matching is approximate (a pattern compared as a path), so an
      // exotic pair could pass as disjoint here — the spine still denies
      // any write at write time; this keeps the obvious collisions out.
      if (a === b || new Bun.Glob(a).match(b) || new Bun.Glob(b).match(a)) {
        throw new Error(`overlapping builder scopes: "${a}" (${scoped[i]!.name}) and "${b}" (${scoped[j]!.name}) — builders must be disjoint`);
      }
    }
  }
  return members;
}

/** The role prompts: restriction is enforced by the spine; the prompt orients. */
const ROLE_PROMPTS: Record<TeamMember["role"], string> = {
  builder: "You are a team builder member. Implement your assigned task precisely and summarize what you changed. Stay inside your assigned path scope; writes outside it are denied by the permission rules.",
  reviewer: "You are a team reviewer member. You cannot modify anything: read the code in question and report findings, risks and a verdict. File writes and edits are denied by the permission rules.",
};

/**
 * The lead's view of one settled member: the child-tail activity (never
 * the provider reasoning) recorded once, so the log holds what the
 * extension read. The task words ride the payload, not duplicated prose.
 */
function recordMemberDone(
  ctx: import("@moh/extension").ExtensionSetupContext,
  payload: { callId: string; member: string; role?: string; task: string; status: string; outputChars: number; activity?: unknown },
): void {
  ctx.appendEvent({ name: "team_member_done", payload: payload as Record<string, unknown> });
}

/**
 * One member spawn with the visible-degradation guarantee (#1224
 * follow-up): the pinned lane rides the first prompt, and when the core
 * refuses it because no active lane matches, the member is spawned
 * un-laned instead — one `team_lane_skipped` chrome event records the
 * skip and the caller's report names `/lanes` as the fix. The failed
 * probe burns nothing: the core refuses before any child exists.
 */
async function spawnMemberLaned(
  ctx: import("@moh/extension").ExtensionSetupContext,
  m: TeamMember,
  prompt: string,
  panelState: TeamPanelState | undefined,
): Promise<{ result: { callId: string; status: "done" | "error" | "cancelled"; output: string; error?: string }; laneSkipped: boolean }> {
  // The panel's live roster rides the same paths the tool drives (#1225):
  // dispatched here, settled below, never a second bookkeeping channel.
  markMemberWorking(panelState, m, lastLine(prompt));
  const buildSpec = (task: string) => ({
    name: m.name,
    task,
    systemPrompt: ROLE_PROMPTS[m.role],
    // The reviewer is read-only by scope: an empty scope list denies
    // write/edit through the permission spine.
    ...(m.role === "reviewer" ? { pathScopes: [] as readonly string[] } : m.scope !== undefined ? { pathScopes: [m.scope] } : {}),
    ...(m.model !== undefined ? { model: m.model } : {}),
  });
  const result = await ctx.spawnSubagent!(buildSpec(m.lane !== undefined ? `${prompt}\n\nlane: ${m.lane}` : prompt));
  if (m.lane === undefined || !/no active lane for branch/.test(result.error ?? "")) {
    settleMember(panelState, m.name, result.status, { outputChars: result.output.length, error: result.error, currentTool: (await ctx.subagentActivity?.(result.callId))?.currentTool ?? null });
    return { result, laneSkipped: false };
  }
  ctx.appendEvent({ name: TEAM_LANE_SKIPPED, payload: { member: m.name, lane: m.lane } });
  const retried = await ctx.spawnSubagent!(buildSpec(prompt));
  settleMember(panelState, m.name, retried.status, { outputChars: retried.output.length, error: retried.error, currentTool: (await ctx.subagentActivity?.(retried.callId))?.currentTool ?? null });
  return { result: retried, laneSkipped: true };
}

/** The roster line's task text: the prompt's own last line. */
function lastLine(text: string): string {
  const line = text.trimEnd().split("\n").at(-1) ?? text;
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/**
 * The self-serve loop (#1223, #1224): the members work through the bag —
 * the extension claims the next claimable task, spawns or steers a
 * builder with that one task, records the transition, and hands it the
 * next one until nothing claimable remains. Builders rotate through the
 * composed roster (a member's lane rides its first spawn's prompt, so
 * every spawn of a lane-bound member runs in that member's own worktree;
 * with one lane builder the whole blocked-by chain lands there);
 * reviewers never claim bag work. Each turn's task text names only that
 * task: the member sees its work, never the bag or another member.
 */
async function selfServeLoop(
  ctx: import("@moh/extension").ExtensionSetupContext,
  members: Map<string, string>,
  bag: TaskBag,
  roster: readonly TeamMember[],
  work: string,
  panelState?: TeamPanelState,
): Promise<string> {
  const reports: string[] = [];
  // A failed completion releases the task back to open; without a guard the
  // loop would re-claim the same failing task forever. One pass: each task
  // is attempted at most once per `work` call, so the loop terminates after
  // at most as many iterations as there are tasks.
  const skipped = new Set<string>();
  // Lanes that failed to bind this call (#1224 follow-up): reported once,
  // visibly, at the end — never a silent un-laned member.
  const skippedLanes = new Map<string, string>();
  const builders = roster.filter((m) => m.role === "builder");
  let nextBuilder = 0;
  for (;;) {
    const next = [...bag.tasks.values()].find((task) => !skipped.has(task.id) && task.id === bag.claimable()?.id);
    if (!next) break;
    // Round-robin over the roster's builders; a reviewer never claims.
    const memberSpec = builders[nextBuilder % builders.length]!;
    nextBuilder += 1;
    const member = memberSpec.name;
    if (!bag.claim(next.id, member)) break;
    const callId = members.get(member);
    const prompt = `${work}\n\nTask ${next.id}: ${next.title}`;
    markMemberWorking(panelState, memberSpec, `Task ${next.id}: ${next.title}`);
    const steered = callId !== undefined ? await ctx.steerSubagent!(callId, prompt) : null;
    const spawned = steered !== null ? { result: steered, laneSkipped: false } : await spawnMemberLaned(ctx, memberSpec, prompt, panelState);
    const outcome = spawned.result;
    const loopActivity = await ctx.subagentActivity?.(outcome.callId);
    settleMember(panelState, member, outcome.status, { outputChars: outcome.output.length, error: outcome.error, currentTool: loopActivity?.currentTool ?? null });
    if (spawned.laneSkipped) skippedLanes.set(member, memberSpec.lane!);
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
  const laneNotes = [...skippedLanes].map(([m, lane]) => `${m} works without its lane "${lane}" — no active lane matched. To isolate it: create the lane (CLI door: moh lanes group <group> + moh lanes start <group> <branch>; in the TUI: /lanes) and re-run the dispatch for that member`);
  return `${bag.summary()}\n${reports.join("\n")}${laneNotes.length > 0 ? `\n${laneNotes.join("\n")}` : ""}`;
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
    capabilities: ["spawn-subagent", "contribute-tool:team", "contribute-panels"],
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
      // The panel's live roster (#1225): the same paths the tool drives
      // mark and settle the members, and the render reads this state per
      // frame. No second bookkeeping channel; never provider reasoning.
      const panelState = createTeamPanelState();
      const toolState = ctx.state as { bag?: TaskBag; roster?: TeamMember[] };
      ctx.registerTool({
        name: "team",
        description:
          "Delegate work to the team, compose it by complexity, or steer an existing member. " +
          "Spawn: pass `task` — spawns a builder member as a child session that works on the task and returns its result (the simple, one-member ask). " +
          "Compose: pass `compose` — a list of members (`role: builder|reviewer`, optional `name`, `scope` path glob, `lane` branchRef, `model` route, `task`) plus an optional `brief`; builders are scoped to disjoint paths, reviewers are read-only, members with a task are dispatched in parallel, and the roster then drives `work`. A member whose lane does not exist yet works un-laned: to give it isolation, create the lane yourself (bash: moh lanes group <group> && moh lanes start <group> <branch> — it asks for consent per the session mode) and re-dispatch the member. " +
          "Plan: pass `plan` — decomposes the brief into bag tasks; then pass `work` (and optionally `member`) to run the team through the bag. " +
          "Steer: pass `member` + `message` — relays a follow-up instruction to that member's next turn (it keeps its context) and returns the new outcome. " +
          "Use when the user asks to work on something with the team, or to correct or redirect one of its members.",
        inputSchema: teamArgsSchema,
        execute: async (args) => {
          const parsed = teamArgsSchema.safeParse(args);
          if (!parsed.success) return `team: refused — ${parsed.error.issues[0]?.message ?? "invalid arguments"}`;
          const { task, member, message, plan, work, compose, brief } = parsed.data as {
            task?: string;
            member?: string;
            message?: string;
            plan?: { title: string; blockedBy?: string[] }[];
            work?: string;
            compose?: { role: "builder" | "reviewer"; name?: string; scope?: string; lane?: string; model?: string; task?: string }[];
            brief?: string;
          };
          // The bag and the composed roster survive hot-reloads in the
          // per-extension durable state; a fresh session starts empty.
          const state = ctx.state as { bag?: TaskBag; roster?: TeamMember[] };
          if (!(state.bag instanceof TaskBag)) state.bag = new TaskBag();
          const bag = state.bag;
          if (compose !== undefined) {
            if (task !== undefined || member !== undefined || message !== undefined || plan !== undefined) {
              return "team: refused — `compose` takes the member list, an optional `brief` and optionally `work`, not another team shape";
            }
            // #1224: composition by complexity. The model judges the ask and
            // names the members; the extension validates the envelope
            // (disjoint scopes, read-only reviewers), registers the roster,
            // and records the decision — a composition is never silent.
            let roster: TeamMember[];
            try {
              roster = normalizeComposition(compose);
            } catch (error) {
              return `team: refused — ${(error as Error).message}`;
            }
            state.roster = roster;
            ctx.appendEvent({
              name: TEAM_COMPOSED,
              payload: {
                members: roster.map((m) => ({
                  name: m.name,
                  role: m.role,
                  ...(m.scope !== undefined ? { scope: m.scope } : {}),
                  ...(m.lane !== undefined ? { lane: m.lane } : {}),
                  ...(m.model !== undefined ? { model: m.model } : {}),
                })),
                dispatched: compose.filter((m) => m.task !== undefined).length,
              },
            });
            const dispatched = roster
              .map((m, i) => ({ m, memberTask: compose[i]!.task }))
              .filter((entry): entry is { m: TeamMember; memberTask: string } => entry.memberTask !== undefined);
            if (dispatched.length === 0 && work === undefined) {
              return `team: composed ${roster.length} members — ${roster.map((m) => `${m.name} (${m.role}${m.scope !== undefined ? `, ${m.scope}` : ""}${m.lane !== undefined ? `, lane ${m.lane}` : ""})`).join(", ")}. Pass a task on a member to dispatch it, or work to run the bag.`;
            }
            if (dispatched.length > 0) {
            const outcomes = await Promise.all(
              dispatched.map(async ({ m, memberTask }) => {
                const prompt = brief !== undefined ? `${brief}\n\n${memberTask}` : memberTask;
                const { result, laneSkipped } = await spawnMemberLaned(ctx, m, prompt, panelState);
                if (result.callId) members.set(m.name, result.callId);
                const activity = await ctx.subagentActivity?.(result.callId);
                recordMemberDone(ctx, {
                  callId: result.callId,
                  member: m.name,
                  role: m.role,
                  task: memberTask,
                  status: result.status,
                  outputChars: result.output.length,
                  ...(activity ? { activity } : {}),
                });
                return { m, result, laneSkipped };
              }),
            );
            const lines = outcomes.map(({ m, result, laneSkipped }) =>
              (result.status === "done"
                ? `${m.name} (${m.role}): ${result.output}`
                : `${m.name} (${m.role}): ${result.status}${result.error ? ` — ${result.error}` : ""}`)
                + (laneSkipped ? ` — works without its lane "${m.lane}" (no active lane matched). To isolate it: create the lane (moh lanes group <group> + moh lanes start <group> <branch>; TUI: /lanes) and re-dispatch this member` : ""),
            );
            if (work === undefined) return `team of ${roster.length} settled:\n${lines.join("\n")}`;
            // `compose` + `work`: the roster is registered and immediately
            // runs the bag — fall through to the self-serve loop below.
            }
          }
          if (plan !== undefined) {
            if (compose !== undefined || task !== undefined || member !== undefined || message !== undefined) {
              return "team: refused — pass either `plan` (decompose the brief into tasks) or `task`/`member`/`compose`, not both";
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
            // The composed roster drives the loop when a `compose` named
            // one; otherwise the single unnamed builder keeps #1223's shape.
            const roster = state.roster ?? [{ name: member ?? "builder", role: "builder" as const }];
            if (roster.every((m) => m.role !== "builder")) {
              return "team: refused — the composed team has no builder members; reviewers cannot claim bag work";
            }
            // #1223 self-serve loop: the members claim the next claimable
            // task, work it, and the extension hands the next one until
            // nothing claimable remains (dependencies or the bag's end).
            // Star-shaped: a member's prompt names only its own task —
            // never the bag, never another member.
            return await selfServeLoop(ctx, members, bag, roster, work, panelState);
          }
          if (member !== undefined || message !== undefined) {
            if (compose !== undefined || plan !== undefined || work !== undefined) {
              return "team: refused — pass either `member` + `message` (steer) or `plan`/`work`/`compose` (bag), not both";
            }
            if (task !== undefined) return "team: refused — pass either `task` (spawn) or `member` + `message` (steer), not both";
            if (member === undefined || message === undefined) return "team: refused — steering needs both `member` and `message`";
            const callId = members.get(member);
            if (callId === undefined) {
              const known = [...members.keys()];
              return `team: no member "${member}"${known.length > 0 ? ` — members: ${known.join(", ")}` : " — the team has no members yet"}`;
            }
            const known = state.roster?.find((m) => m.name === member);
            if (known) markMemberWorking(panelState, known, lastLine(message));
            const result = await ctx.steerSubagent!(callId, message);
            if (!result) {
              if (known) settleMember(panelState, member, "error", { error: "not reachable for steering" });
              return `team: refused — member "${member}" is not reachable for steering`;
            }
            // The lead's view of the member: the post-steering outcome
            // recorded once, so the log holds what the extension read.
            const activity = await ctx.subagentActivity?.(callId);
            settleMember(panelState, member, result.status, { outputChars: result.output.length, error: result.error, currentTool: activity?.currentTool ?? null });
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
            return "team: refused — pass `task` to spawn a member, `compose` to compose the team, `plan` to decompose the brief, `work` to run the bag, or `member` + `message` to steer";
          }
          if (compose !== undefined) {
            return "team: refused — pass either `task` (spawn) or `compose` (the team), not both";
          }
          if (plan !== undefined) {
            return "team: refused — pass either `task` (spawn) or `plan` (decompose the brief), not both";
          }
          markMemberWorking(panelState, { name: "builder", role: "builder" }, lastLine(task));
          const result = await ctx.spawnSubagent!({ name: "builder", task });
          if (result.callId) members.set("builder", result.callId);
          const activity = await ctx.subagentActivity?.(result.callId);
          settleMember(panelState, "builder", result.status, { outputChars: result.output.length, error: result.error, currentTool: activity?.currentTool ?? null });
          recordMemberDone(ctx, {
            callId: result.callId,
            member: "builder",
            task,
            status: result.status,
            outputChars: result.output.length,
            ...(activity ? { activity } : {}),
          });
          return result.status === "done"
            ? `team member builder finished:\n${result.output}`
            : `team member builder ${result.status}${result.error ? `: ${result.error}` : ""}`;
        },
      });
      // The rail panel (#1225, ADR-0062 as amended): only with the
      // `contribute-panels` grant (enforcement by absence). One panel,
      // the roster with the detail view inside it; keys reach it only
      // through the client's focus-mode forwarding.
      if (typeof ctx.registerPanel === "function") {
        ctx.registerPanel(createTeamPanel(panelState, () => (toolState.bag instanceof TaskBag ? [...toolState.bag.tasks.values()] : [])));
      }
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
    capabilities: ["spawn-subagent", "contribute-tool:team", "contribute-panels"] as string[],
    // ADR-0066: the NOT-do list rides the enable question.
    reasoning:
      "The team extension coordinates child sessions as one team: up to 10 concurrent children, per-role path scopes, one stop for everything it started, and one live panel in the extensions rail (roster and member detail, read-only). It does not add peer messaging between members — steering flows through the team lead — and its children never spawn grandchildren.",
  },
  // ADR-0074: the enable consent names the envelope — the user grants it,
  // the stored answer remembers it. Shipping in the binary does not grant it.
  consentRequired: true,
  activate(): unknown {
    return createTeamExtension();
  },
};
