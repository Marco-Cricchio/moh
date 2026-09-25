/**
 * `moh-extension-jev-guard`: the bundled first-party Jev (TypeSafe)
 * extension (#784).
 *
 * Scope of this layer: the *infrastructure* only. It owns the HTTP client,
 * the offline signal and one home for use-case questions; the judgments
 * themselves belong to their own issues (#786 guardrail, #787 routing,
 * #788–#793), which call the same client.
 *
 * Boundaries (ratified, vision note 35 + #784):
 * - `@moh/core` never learns about Jev: it knows only the generic
 *   `appendEvent` / `setStatus` / `ask` contract additions this layer needs.
 * - The endpoint and the model are hardcoded (no override, no env var).
 * - No npm dependency: one `fetch`, so no dependency-authorization friction.
 * - The key lives in the user config; present = active. No toggle.
 *
 * The default export is the factory below: a definition needs the resolved
 * `apiKey`/`timeoutMs`, which only the assembly (the owner of the user
 * config) has — so the module exports a producer of definitions rather
 * than one ready-made definition.
 */
import { defineExtension, MOH_EXTENSION_API_VERSION, type ExtensionDefinition, type ExtensionSetupContext } from "@moh/extension";
import type {
  CompactionHook,
  CompactionHookContext,
  CompactionHookResult,
  CompactionSection,
} from "@moh/extension";
import { createJevClient, type JevClientOptions } from "./client";
import { createGuardrailJudge, GUARDRAIL_TOOL } from "./guardrail-judge";
import { createCompactionJudge } from "./compaction-judge";
import { createRoutingJudge, OWNER_SESSION, type RoutingPool } from "./routing-judge";
import { createInjectionJudge } from "./injection-judge";
import { INJECTION_TOOLS } from "./injection";
import { createLintGate } from "./lint-gate";
import { createLintJudge } from "./lint-judge";
import { createClassificationJudge, classificationQuestions } from "./classification-judge";
import { createRerankJudge } from "./rerank-judge";
import { createSkillSuggestJudge } from "./skill-judge";
import type { SkillCandidate } from "./skills";
import {
  createUseCaseControl,
  type JevUseCaseOutcome,
  type JevUseCaseState,
  type UseCaseControl,
} from "./use-cases";
import type { RoutingJudge } from "./routing-judge";

/** The extension's name, as stamped in the log and shown in the footer. */
export const JEV_GUARD_NAME = "jev-guard";
/** The definition's version, reported by the `extension_loaded` event. */
export const JEV_GUARD_VERSION = "0.1.0";

/** #787: the model-routing use case's inputs, resolved by the core. */
export interface JevRoutingOptions {
  /** The models this session can actually reach (core-resolved pool). */
  pool: () => Promise<RoutingPool>;
  /** Explicit tier labels (`typesafe.tiers`): `<endpoint>/<model-id>` → tier. */
  labels?: Record<string, string>;
  /**
   * #868 (option B): a moh.json-declared pool of `<endpoint>/<model-id>`
   * refs the router may rotate through when the tier target cannot serve.
   * Absent: tier-bounded rotation only (the default).
   */
  declaredPool?: readonly string[];
}

export interface JevGuardOptions {
  /** TypeSafe API key (from the user config's `typesafe.apiKey`). */
  apiKey: string;
  /** Hook timeout for one Jev call, ms. Default `JEV_TIMEOUT_MS_DEFAULT`. */
  timeoutMs?: number;
  /** Test seam: the fetch implementation handed to the client. */
  fetchImpl?: typeof fetch;
  /**
   * #787: model routing. Present = the router is registered; absent = the
   * whole use case is unavailable (a caller that never wants it).
   * `enabled` is the *config* opt-in: false means the router starts paused,
   * and `/routing on` can still enable it for the session (ratified).
   */
  routing?: JevRoutingOptions;
  /** The config opt-in (`typesafe.routing`). Default false. */
  enabled?: boolean;
  /**
   * #791: the anti-injection opt-in (`typesafe.injection`). Off by
   * default, and it is the only anti-injection switch: the check sends the
   * user's message text (≤ 4 KiB) to TypeSafe on every turn and the text
   * of every `fetch`/`browser` result (≤ 8 KiB), which is a bigger privacy
   * step than the guardrail's command + cwd + git state.
   */
  injection?: boolean;
  /**
   * #789: the end-of-task quality gate (off by default — it sends the
   * changed code's diff to TypeSafe, the strongest privacy step in the
   * pack). Needs the project root for rubric discovery and the git diff;
   * absent = the use case is unavailable (a caller that never wants it).
   *
   * #832: `enabled` is the *config* opt-in — the state the session starts
   * in. The option's presence is availability: with the root supplied, a
   * warm `on` can start judging even though the config says off.
   */
  lint?: { root: string; enabled?: boolean };
  /**
   * #788: prompt classification. On by default (`typesafe.classification`,
   * an explicit `false` in the config turns it off): Jev classifies the
   * last user message (≤ 2 KiB) each turn into a task type plus a
   * codebase-oriented probability. Outputs: a per-turn task-type hint in
   * the subordinate `turn_notes` section (ADR-0036), and the MPM gate
   * opinion this extension exposes through `state.mpmGate` — the session
   * assembly wires it into `SessionConfig.mpm.turnGate`. The projection,
   * the `mpm_query` tool and the manual commands are never gated.
   */
  classification?: boolean;
  /**
   * #790: MPM seed rerank. Off by default (`typesafe.rerank`): when the
   * orientation plan's seed set resolves to more than five mapped paths,
   * the extension asks Jev to rank the candidates and keeps the best few
   * instead of dropping the plan entirely. One fan-out request per
   * over-threshold seed set, one noul per candidate (never an aggregated
   * Score — a calibration lesson paid for in note 35). When the use case
   * is on, the extension publishes a `rerank` hook on `state` so the
   * core's orientation module can call it.
   */
  rerank?: boolean;
  /**
   * #793: per-turn skill suggestion. Off by default (`typesafe.skills`):
   * needs the session's skill roster (bundled first-party + user skills),
   * which only the assembly has; absent = the use case is unavailable
   * (a caller that never wants it). `enabled` (#832) is the config opt-in:
   * the presence of the roster makes the use case *available* to a warm
   * command, the flag only decides where the session starts.
   *
   * Two Jev calls per judged turn — rank the whole roster plus a
   * "does this turn need a skill at all?" gate, then re-read the top-3
   * finalists — yield at most ONE suggested skill, contributed as the
   * turn's `setPromptNote` line (the ADR-0036 `turn_notes` section, so the
   * roster itself never enters the prompt). Every record is a
   * `jev_skill_suggest` event, one per call.
   */
  skills?: { roster: () => Promise<readonly SkillCandidate[]>; enabled?: boolean };
}

/**
 * Builds the bundled extension definition. `setup` constructs the client
 * and wires its two observation seams to the generic contract (ADR-0032):
 * every judgment rides `appendEvent` (stamped, redacted, per-turn capped)
 * and the connectivity signal rides `setStatus` (ephemeral, one per
 * transition). No hook is registered here — an active extension with no use
 * case enabled costs exactly zero calls.
 */
export function createJevGuardExtension(options: JevGuardOptions): ExtensionDefinition {
  const clientOptions: JevClientOptions = {
    apiKey: options.apiKey,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };
  return defineExtension({
    name: JEV_GUARD_NAME,
    version: JEV_GUARD_VERSION,
    apiVersion: MOH_EXTENSION_API_VERSION,
    setup(ctx: ExtensionSetupContext) {
      const client = createJevClient({
        ...clientOptions,
        onJudgment: (record) => ctx.appendEvent({ name: "jev_judgment", payload: record }),
        onStatus: (text) => ctx.setStatus(text),
      });

      // ---- #832: the uniform control surface ---------------------------
      // One vocabulary for the seven use cases: which are *available* in
      // this session (they have everything they need), which the config
      // opted in (the state a session starts in) and which a warm command
      // moved (session-only). Every hook below asks `control.isOn(...)` and
      // nothing else, so a command takes effect from the next turn without
      // re-registering anything.
      const lintOptions = options.lint;
      const skillsOptions = options.skills;
      /** Session mode, tracked from the log's `session_mode` chrome. */
      let mode: "normal" | "auto-accept" | "yolo" = "normal";
      /**
       * The routing judge (created below): the one use case whose live state
       * has more than on/off, because switching model by hand suspends it.
       */
      let router: RoutingJudge | undefined;
      const control: UseCaseControl = createUseCaseControl({
        mode: () => mode,
        available: {
          guardrail: true,
          routing: options.routing !== undefined,
          classification: true,
          injection: true,
          lint: lintOptions !== undefined,
          rerank: true,
          skills: skillsOptions !== undefined,
        },
        config: {
          // #784: the guardrail has no config opt-in — a stored key *is* the
          // switch. It is therefore on in every session this extension runs
          // in, and a warm `off` is session-only by construction.
          guardrail: true,
          routing: options.enabled === true,
          classification: options.classification !== false,
          injection: options.injection === true,
          // "The config says" is a claim about the *user's* file: an option
          // the caller never supplied is ours to read as off, not as on
          // (the use case is unavailable anyway, and the refusal says that).
          lint: lintOptions !== undefined && lintOptions.enabled !== false,
          rerank: options.rerank === true,
          skills: skillsOptions !== undefined && skillsOptions.enabled !== false,
        },
        routing: {
          control: (action) => router?.control(action),
          state: () => router?.snapshot() ?? { paused: false, override: false },
          // Nothing to choose = inert — but only once the assignment
          // resolved: a router that has not looked yet is not yet anything.
          inert: () => {
            const resolution = router?.peekResolution();
            return resolution ? resolution.assignment === null : false;
          },
        },
      });
      /**
       * #832: the one visible line a control change leaves in the log. A
       * resumed session must be able to read why a use case went quiet
       * while the config says otherwise, so the asymmetry travels with the
       * line — never a bare "off".
       */
      const appendOutcome = (outcome: JevUseCaseOutcome): void => {
        const state = outcome.state;
        ctx.appendEvent({
          name: "jev_usecase",
          payload: {
            usecase: outcome.usecase,
            action: outcome.action,
            ...(outcome.refused ? { refused: outcome.refused } : {}),
            status: state.status,
            config: state.config,
            ...(state.sessionOnly ? { sessionOnly: true } : {}),
            // The guardrail has no persistent switch to contrast with;
            // "the config still says on" would invent one.
            ...(outcome.usecase === "guardrail" && outcome.refused === undefined
              ? { note: "the guardrail has no persistent switch" }
              : {}),
          },
        });
      };

      // ---- #792 compaction cut guide: one noul per section ------------
      // ADR-0035: at compaction time (auto and forced paths alike), Jev
      // answers "can this section be safely dropped?" per turn body; the
      // highs are handed back as drops. The core applies its own 60%
      // survival floor afterwards — the judge cannot talk itself past it —
      // and reports the floor application back so the aggregate
      // `compact-cut` record carries it. No opt-in beyond the key: the
      // judged state is section previews only (shape, never bodies), and
      // compaction itself is automatic.
      //
      // #979: the span is what grows until compaction runs, so the judge
      // is given the hook's own window and its abandonment signal — it
      // judges largest-first with bounded concurrency and stops inside the
      // window, and whatever it judged lands in ONE aggregate record (the
      // old per-section shape flooded the per-turn event cap by itself).
      const compactionJudge = createCompactionJudge({
        client,
        append: (payload) => ctx.appendEvent({ name: "jev_judgment", payload }),
      });
      ctx.onCompaction(async (ctxHook) => {
        const run = await compactionJudge.judge(ctxHook.sections, {
          ...(ctxHook.hookTimeoutMs !== undefined ? { hookTimeoutMs: ctxHook.hookTimeoutMs } : {}),
          ...(ctxHook.signal !== undefined ? { signal: ctxHook.signal } : {}),
        });
        return run;
      });

      // ---- #786 guardrail: the first use case --------------------------
      // Jev judges EVERY bash call (before rules, ADR-0031 gate order):
      // deny → veto, ask → the human consent flow (never auto-accepted,
      // never "always"), pass → nothing. Yolo narrows an armed guardrail
      // to lethal checks only; a warm `off` disarms it entirely, in yolo
      // too (#850, ADR-0041) — from the next call.
      const judge = createGuardrailJudge(
        { client, state: ctx.state ?? {}, append: (record) => ctx.appendEvent({ name: "jev_judgment", payload: record }) },
        {
          mode: () => mode,
          cwd: (args) => {
            const a = (args ?? {}) as Record<string, unknown>;
            return typeof a.cwd === "string" ? a.cwd : process.cwd();
          },
        },
      );

      ctx.onSessionStart(() => {
        judge.invalidateOnGitChange();
      });
      ctx.onEvent(({ event }) => {
        if (event.type === "session_mode" && (event.mode === "normal" || event.mode === "auto-accept" || event.mode === "yolo")) {
          // #849: a mid-session rotation invalidates cached verdicts — a
          // verdict judged in one mode's narrowing (yolo = lethal-only)
          // must not survive into another (the cache key is command+git).
          mode = event.mode;
          judge.invalidateCache();
        }
      });
      ctx.afterTurn(() => {
        // #846: the turn's passing judgments land as one aggregate record —
        // one line per turn instead of one per bash call keeps an ordinary
        // tool-heavy turn far below the per-turn event cap.
        judge.flushPasses();
        judge.invalidateOnGitChange();
      });
      ctx.onSessionEnd(() => judge.reset());
      ctx.onToolCall(async (call) => {
        if (!control.isOn("guardrail")) return;
        if (call.name !== GUARDRAIL_TOOL) return;
        const result = await judge.judge(call.callId, call.args);
        const v = result.verdict.verdict;
        if (v === "deny") {
          return { veto: true, reason: result.verdict.reason };
        }
        if (v === "ask") {
          // ask = human confirmation, not a grant: auto-accept evaluates it
          // before its allow branch (ADR-0031), yolo ignores it, headless
          // denies it — all core behaviour, nothing to do here but ask.
          return { ask: true, reason: result.verdict.badge };
        }
        // #867: a yolo pass softened by the in_scope contradiction shows a
        // one-line ephemeral status — the lethal check fired and was waived;
        // the user must see that even where asking is impossible.
        if (v === "pass" && result.verdict.note) {
          ctx.setStatus(result.verdict.note);
        }
        return;
      });
      // ---- #791 anti-injection: two halves, two seams -------------------
      // Opt-in and off by default (`typesafe.injection`): the check sends
      // the user's own message text to TypeSafe, which is a choice, not a
      // side effect of having a key. Both halves ask the same two
      // questions; `sensitive` never blocks, only `injection` above 0.95
      // does — a confirmation before a turn, a withheld result after a
      // fetch.
      // #832: the judge is built whatever the config says (building one
      // costs nothing — it is one closure until it judges), so
      // `typesafe.injection: false` becomes a *starting* state a warm `on`
      // can leave from the next turn. Both seams ask the live state first.
      const injection = createInjectionJudge({
        client,
        append: (payload) => ctx.appendEvent({ name: "jev_judgment", payload }),
      });
      // Half 1: the user's turn input, through the pre-send confirmation
      // of ADR-0033. The band's `confirm` is the only one that reports
      // back: the record waits for the answer, so a cancelled turn leaves
      // exactly one entry in the log and no `user_message`.
      ctx.beforeTurn(async ({ text }) => {
        if (!control.isOn("injection")) return;
        const verdict = await injection.judgeInput(text);
        if (!verdict || verdict.band !== "confirm" || verdict.reason === undefined) return;
        return {
          confirm: {
            reason: verdict.reason,
            ...(verdict.resolve ? { onResolved: verdict.resolve } : {}),
          },
        };
      });
      // Half 2: external content, through the post-tool seam of ADR-0034,
      // registered for the two tools whose output a third party controls.
      // A host older than apiVersion 1.4 has no `onToolResult`: the half
      // does not exist there (the versioning policy: fail-open, never an
      // error) — hence the guard, like `requestTurn` below.
      if (typeof ctx.onToolResult === "function") {
        ctx.onToolResult(INJECTION_TOOLS, async ({ name, output }) => {
          if (!control.isOn("injection")) return;
          const verdict = await injection.judgeToolResult(name, output);
          if (!verdict?.withhold) return;
          return { withhold: { reason: verdict.withhold } };
        });
      }

      // ---- #789 quality gate: the end-of-task semantic lint -----------
      // Opt-in and off by default (`typesafe.lint`): the one use case that
      // sends the changed code's diff to TypeSafe — the strongest privacy
      // step in the pack, disclosed in the Settings entry. On a "done"
      // turn that changed files (never a cancelled or errored one), the
      // discovered convention documents plus the task's unified diff are
      // judged with three fixed questions; a finding asks the core for a
      // synthetic correction turn (ADR-0037), re-judges, and hard-stops
      // after two cycles.
      // #832: available whenever the assembly could supply the project root
      // — the config only decides where the session starts, so a warm `on`
      // starts judging from the next turn that ends.
      if (lintOptions) {
        const gate = createLintGate({
          judge: createLintJudge({
            client,
            append: (payload) => ctx.appendEvent({ name: "jev_judgment", payload }),
          }),
          root: lintOptions.root,
          // ADR-0037: the core-mediated synthetic turn. Absent on a 1.5-
          // or-older runtime — the gate degrades to judgment-only (the
          // record still lands, no correction turn is requested).
          requestTurn:
            typeof ctx.requestTurn === "function"
              ? (text) => ctx.requestTurn(text)
              : async () => false,
          // The stop is one event, not a judgment: the probabilities were
          // never re-measured, so a fake `jev_judgment` would lie.
          reportStop: (reason, findings) =>
            ctx.appendEvent({ name: "jev_lint_stopped", payload: { reason, findings: [...findings] } }),
        });
        ctx.onToolCall(async (call) => {
          // Observation only: record the paths the task writes/edits for
          // the diff; never a decision, so nothing is returned. Gated with
          // the gate itself: an off use case pays nothing.
          if (!control.isOn("lint")) return;
          gate.observeToolCall(call.name, call.args);
        });
        ctx.afterTurn(async ({ result, synthetic }) => {
          // Ratified trigger: the end of a *done* turn only. A cancelled
          // or errored turn is never judged (its work may be partial by
          // interruption, not by omission), and a synthetic turn the gate
          // itself requested is never re-gated — that is the no-recursion
          // rule, enforced by skipping here.
          if (!control.isOn("lint")) return;
          if (synthetic === true || result.status !== "done") return;
          // `requestTurn` resolves when the correction turn settles (the
          // queue runs it like any turn), so cycle 2 re-diffs the
          // corrected tree — no polling (ADR-0037 §5).
          await gate.onTaskEnd();
        });
        ctx.onSessionEnd(() => gate.reset());
      }

      // ---- #788 prompt classification: task type + MPM gate -----------
      // On unless the config opted out (`typesafe.classification: false`).
      // Jev classifies the last user message each turn; the hint rides the
      // ADR-0036 `turn_notes` section (subordinate to the project's own
      // instructions, replaced — never accumulated) and the MPM gate
      // opinion is published through `state.mpmGate` for the assembly to
      // wire into `SessionConfig.mpm.turnGate`.
      // #832: the judge always exists (classification needs nothing the
      // session might lack) and the hook asks the live state, so a warm
      // `off`/`on` applies from the next turn.
      const classificationJudge = createClassificationJudge({
        client,
        append: (payload) => ctx.appendEvent({ name: "jev_judgment", payload }),
      });
      // The assembly reads this (the `routingState` pattern): the current
      // turn's MPM gate opinion — `null` = no opinion. The note itself needs
      // no cleanup hook: the core clears every turn note at the next turn's
      // start (ADR-0036 §2).
      ctx.state.mpmGate = null;

      // ---- #790 MPM seed rerank: over-threshold rescue ----------------
      // Opt-in and off by default (`typesafe.rerank`). The orientation
      // module in `@moh/core` owns the over-threshold branch and the
      // candidate list; it asks Jev to rank the candidates and uses the
      // kept paths to assemble a rescued plan. One fan-out request per
      // over-threshold seed set, one noul per candidate — never an
      // aggregated Score (a calibration lesson paid for in note 35).
      // Absent = the rerank use case is unavailable (today's behavior).
      // #832: rerank needs nothing the session might lack, so the hook is
      // always published and the config only decides the starting state — a
      // warm `on` rescues the next over-threshold plan.
      const rerankJudge = createRerankJudge({
        client,
        append: (payload) => ctx.appendEvent({ name: "jev_judgment", payload }),
      });
      // The core reads this hook from `state` (the `mpmGate` pattern): a
      // function the orientation module calls when an over-threshold seed set
      // needs ranking. Null while the request is in flight is impossible —
      // the orientation module awaits this single promise. An off use case
      // answers `null` without spending a call, which is exactly what the
      // orientation module does with an absent hook.
      ctx.state.rerank = async (request: Parameters<typeof rerankJudge.rerank>[0]) => {
        if (!control.isOn("rerank")) return null;
        const verdict = await rerankJudge.rerank(request);
        if (!verdict) return null;
        // The core only needs the kept paths (it owns the candidate list and
        // the freshness re-hashing); a `Set<string>` is the narrowest
        // contract that preserves insertion order. Empty when fewer than two
        // candidates cleared the floor (orientation degrades to no plan).
        return new Set(verdict.kept.map((c) => c.path));
      };

      // ---- #787 routing: one tier per turn -----------------------------
      // Opt-in and off by default (`typesafe.routing`). Jev judges the last
      // user message only, answers with a tier, and the session switches to
      // that tier's model through the same resolution as a manual `/model`
      // — never to a model the user has not configured. Inert when there is
      // nothing to choose (fewer than two reachable tiers).
      if (options.routing) {
        const routing = options.routing;
        const enabled = options.enabled === true;
        const judge = createRoutingJudge(
          { client, state: ctx.state ?? {} },
          {
            pool: routing.pool,
            labels: routing.labels ?? {},
            // #868 (option B): the moh.json-declared rotation pool, when
            // one was declared — the user's explicit consent to rotation
            // beyond the tier bound.
            declaredPool: routing.declaredPool,
            // #788: when the router makes its per-turn call, the
            // classification rides it — one state, one round trip, both
            // consumers reading their own answers. #832: the rider stays
            // wired whatever the classification's live state is; its own
            // judge decides whether to read the answers (an off
            // classification rides nothing and reads nothing).
            rider: {
              questions: classificationQuestions,
              onSharedCall: () => {
                // The routing call covers this turn (success or
                // failure): never a second request for it.
                ctx.state.classificationShared = true;
              },
              onAnswers: (answers, meta, text) => {
                ctx.state.classificationShared = true;
                if (!control.isOn("classification")) return;
                const verdict = classificationJudge.judgeShared(answers, meta, text);
                if (verdict?.hint !== undefined) ctx.setPromptNote(verdict.hint);
              },
            },
            // The serving model is not the one the router picked: say so
            // once per episode and stay out of the way (no call, no switch).
            onMismatch: (currentModel, expected) => {
              ctx.appendEvent({
                name: "jev_routing",
                payload: { kind: "mismatch", current: currentModel, expected },
              });
            },
            // One visible line per resolved problem, once per session —
            // never a turn error, never silence about a misconfiguration.
            onResolved: (resolution) => {
              for (const warning of resolution.warnings) {
                ctx.appendEvent({ name: "jev_routing", payload: { kind: "listing-failed", message: warning } });
              }
              if (!resolution.assignment) {
                ctx.appendEvent({ name: "jev_routing", payload: { kind: "inert" } });
                return;
              }
              for (const ref of resolution.assignment.ignoredLabels) {
                ctx.appendEvent({ name: "jev_routing", payload: { kind: "ignored-label", ref } });
              }
              const unpriced = resolution.assignment.unpriced;
              if (unpriced.length > 0) {
                ctx.appendEvent({
                  name: "jev_routing",
                  payload: { kind: "unpriced", count: unpriced.length, models: unpriced.slice(0, 5) },
                });
              }
            },
          },
        );
        router = judge;
        ctx.beforeTurn(async (call) => {
          if (!control.isOn("routing")) return;
          // #944: whose turn this is. A subagent child runs its turns
          // through the parent's runtime, so the router keys its state by
          // this identity — a child's turns can never advance the parent's
          // streak, set the parent's expectation, or make the parent's
          // model move. An older host (apiVersion < 1.8) sends no session:
          // that reads as the owner, i.e. the pre-#944 behavior.
          const session = call.session ?? OWNER_SESSION;
          // #852: the route's cooled-down chain stops ride the context —
          // the judge refuses a switch targeting a known-unhealthy model.
          const verdict = await judge.decide(call.text, call.model, call.endpointCooldowns ?? [], session);
          if (!verdict || verdict.decision !== "switch" || verdict.ref === undefined) return;
          // Arm the switch before returning: the `model_switched` it causes
          // is the router's, not the user taking the wheel.
          judge.noteSwitch(verdict.ref, call.model, session);
          return { model: verdict.ref };
        });
        // #832: routing's own notices (a mismatch, a manual override, a
        // misconfigured label). The *commands* are handled once, for all
        // seven use cases, by the uniform channel registered at the end of
        // this setup.
        ctx.onEvent(({ event }) => {
          // #868: a decided switch that failed to apply (an unresolvable
          // ref at switch time) is never silence — the skip is an explicit,
          // visible outcome naming what was attempted.
          if (event.type === "extension_failed") {
            const reason = (event as { reason?: unknown }).reason;
            if (reason !== "invalid_model" || !judge.switchPending()) return;
            judge.dropPendingSwitch();
            ctx.appendEvent({
              name: "jev_routing",
              payload: {
                kind: "switch-skipped",
                reason: "invalid_model",
                target: judge.snapshot().decidedModel,
              },
            });
            return;
          }
          if (event.type !== "model_switched" || typeof event.to !== "string") return;
          judge.clearPendingSwitch();
          if (!judge.noteModelSwitched(event.to)) return;
          // The user picked a model by hand: the router steps aside and
          // says so. `/routing auto` (or `/model auto`) hands it back.
          ctx.appendEvent({ name: "jev_routing", payload: { kind: "override", model: event.to } });
        });
        // The config opt-in is the *starting* state, not a gate: the router
        // exists either way, so `/routing on` can enable it for a session
        // that never opted in (ratified) — and while it is off it still
        // costs nothing, because `decide` returns before any call.
        if (!enabled) judge.control("off");
        // Resolve the assignment at session start only when it can matter:
        // an off router must not fetch a listing either.
        ctx.onSessionStart(() => {
          if (ctx.state.routingState && !(ctx.state.routing as { paused?: boolean } | undefined)?.paused) void judge.resolution();
        });
        // The client asks for the resolved state on demand (`/routing`).
        // `state` is the one channel that answers *synchronously*: the
        // status is ephemeral and `appendEvent` is a transcript line, not a
        // return value — and the request may well arrive before the pool
        // resolved, in which case the answer says so instead of waiting.
        ctx.state.routingState = (): Record<string, unknown> | null => {
          const resolution = judge.peekResolution();
          const snapshot = judge.snapshot();
          if (!resolution) return { ...snapshot, assignment: null, ...(routing.declaredPool !== undefined ? { declaredPool: [...routing.declaredPool] } : {}) };
          const assignment = resolution.assignment;
          const tierTargets = assignment ? assignment.targets : undefined;
          return {
            ...snapshot,
            assignment: assignment
              ? {
                  targets: { ...tierTargets },
                  members: assignment.members,
                  ignoredLabels: [...assignment.ignoredLabels],
                  unpriced: [...assignment.unpriced],
                }
              : null,
            warnings: [...resolution.warnings],
            // #868: the declared rotation pool, as wired (option B audit).
            ...(routing.declaredPool !== undefined ? { declaredPool: [...routing.declaredPool] } : {}),
          };
        };
      }

      // ---- #788 classification: the own-call turn-start hook ----------
      // Registered after the routing hook on purpose: hooks run in
      // registration order, so the routing hook decides first whether it
      // will make the shared call (and the rider has consumed the turn);
      // only when routing did nothing does the classification spend its
      // own request. Either way the hint lands in this turn's
      // `turn_notes` and the gate opinion is published.
      ctx.beforeTurn(async ({ text }) => {
        // #832: an off classification rides nothing and judges nothing —
        // and the gate opinion must go back to "no opinion", never linger
        // from the previous turn (`mpmGate` is read once per turn).
        if (!control.isOn("classification")) {
          ctx.state.classificationShared = false;
          ctx.state.mpmGate = null;
          return;
        }
        if (ctx.state.classificationShared === true) {
          // The routing call judged this turn already; consume the flag.
          ctx.state.classificationShared = false;
        } else {
          const verdict = await classificationJudge.judge(text);
          if (verdict?.hint !== undefined) ctx.setPromptNote(verdict.hint);
        }
        const gate = classificationJudge.mpmAllowed();
        ctx.state.mpmGate = gate === undefined ? null : gate;
      });
      // ---- #793 skill suggestion: the two-call cookbook ----------------
      // Opt-in and off by default (`typesafe.skills`): it needs the
      // session's skill roster, resolved lazily by the assembly (fresh
      // discovery semantics — a mid-session workflow toggle is picked
      // up). Registered LAST on purpose: hooks run in registration order
      // and `setPromptNote` is one replacing slot per instance, so a turn
      // that produced both a task-type hint and a skill suggestion keeps
      // the skill suggestion — the more specific line.
      // Fail-open end to end: no roster, an outage, a gate or floor miss
      // all leave the turn exactly as today.
      // #832: available whenever the assembly could supply the roster; the
      // config only chooses the starting state, so a warm `on` starts
      // suggesting from the next turn.
      if (skillsOptions) {
        const roster = skillsOptions.roster;
        const judge = createSkillSuggestJudge({
          client,
          append: (payload) => ctx.appendEvent({ name: "jev_skill_suggest", payload }),
        });
        ctx.beforeTurn(async ({ text }) => {
          if (!control.isOn("skills")) return;
          const index = await roster();
          if (!index || index.length === 0) return;
          const verdict = await judge.suggest(text, index);
          if (verdict) ctx.setPromptNote(verdict.line);
        });
      }

      // ---- #832 the uniform command channel (ADR-0038) -----------------
      // Registering this once, for all seven use cases, is the point of the
      // generalization: the client sends one grammar, the extension answers
      // through the live state, and every accepted change leaves exactly one
      // visible line in the log. The routing-only form ADR-0038 shipped
      // (`{ cmd: "on" | "off" | "auto" }`) stays accepted — a client that
      // predates #832 keeps working, and it is the same code path.
      ctx.onEvent(({ event }) => {
        if (event.type !== "extension_control") return;
        const payload = asRecord(event.payload);
        if (payload === undefined) return;
        if (payload.cmd === "usecase") {
          const usecase = typeof payload.usecase === "string" ? payload.usecase : "";
          const action = typeof payload.action === "string" ? payload.action : "";
          const outcome = control.command(usecase, action);
          if (outcome) {
            appendOutcome(outcome);
          } else {
            // A name this extension does not know: the client may be newer
            // than the extension. Say so instead of doing nothing.
            ctx.appendEvent({
              name: "jev_usecase",
              payload: { usecase, action, refused: "unknown-usecase" },
            });
          }
          return;
        }
        if (typeof payload.cmd === "string") {
          // `command("routing", …)` answers `null` only for a name it does
          // not know — "routing" is one of the seven, so an outcome is
          // always there (an unknown command comes back as a refusal).
          const outcome = control.command("routing", payload.cmd);
          if (outcome) appendOutcome(outcome);
        }
      });

      // ---- #832: the live snapshot the client reads ---------------------
      // The uniform reader a client asks for all seven states at once
      // (`state` is the one channel that answers synchronously). `routing`
      // keeps its richer `routingState` reader beside it: this one says
      // whether the router is on, paused or inert, that one says what it
      // resolved to.
      ctx.state.jevState = (): Record<string, JevUseCaseState> => control.snapshot();
    },
  });
}

/** A JSON object as an inspectable record; anything else is not a payload. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export default createJevGuardExtension;

export {
  createJevClient,
  validateJevKey,
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_OFFLINE_STATUS,
  JEV_RETRY_AFTER_MAX_MS,
  JEV_RETRY_DELAY_MS,
  JEV_TIMEOUT_MS_DEFAULT,
} from "./client";
export type {
  JevAnswer,
  JevChoiceAnswer,
  JevChoiceQuestion,
  JevClient,
  JevClientOptions,
  JevFailureKind,
  JevKeyValidation,
  JevJudgeInput,
  JevJudgmentMeta,
  JevNoulAnswer,
  JevNoulQuestion,
  JevOutcome,
  JevQuestion,
  JevScoreAnswer,
  JevScoreQuestion,
} from "./client";
export { questions } from "./questions-core";
export {
  COMPACTION_CUT_QUESTION,
  COMPACTION_CUT_QUESTIONS,
  COMPACTION_CUT_THRESHOLDS,
  type CompactionCutSectionVerdict,
} from "./compaction";
export {
  COMPACTION_JUDGE_CONCURRENCY,
  COMPACTION_JUDGE_SECTION_BUDGET,
  createCompactionJudge,
  type CompactionCutRun,
  type CompactionJudge,
  type CompactionUnjudgedReason,
  type JudgedSection,
} from "./compaction-judge";
export {
  INJECTION_INPUT_MAX_BYTES,
  INJECTION_QUESTIONS,
  INJECTION_THRESHOLDS,
  INJECTION_TOOL_MAX_BYTES,
  INJECTION_TOOLS,
  SENSITIVE_ADVICE,
  injectionBand,
  injectionConfirmReason,
  injectionWithholdReason,
  sliceForJudgment,
  type InjectionBand,
  type InjectionDecision,
  type InjectionSignals,
  type InjectionSource,
} from "./injection";
export {
  createInjectionJudge,
  type InjectionInputVerdict,
  type InjectionJudge,
  type InjectionToolVerdict,
} from "./injection-judge";
export {
  CLASSIFICATION_MESSAGE_MAX_BYTES,
  CLASSIFICATION_QUESTIONS,
  CLASSIFICATION_THRESHOLDS,
  TASK_TYPES,
  TASK_TYPE_HINTS,
  classificationSignals,
  hintFor,
  mpmGate,
  taskTypeFromAnswer,
  type ClassificationSignals,
  type TaskType,
} from "./classification";
export {
  classificationQuestions,
  createClassificationJudge,
  type ClassificationJudge,
  type ClassificationVerdict,
} from "./classification-judge";
export {
  decideGuardrail,
  GUARDRAIL_QUESTIONS,
  GUARDRAIL_THRESHOLDS,
  type GuardrailDecision,
  type GuardrailSignals,
  type GuardrailVerdict as GuardrailRuleVerdict,
} from "./guardrail";
export {
  assignTiers,
  decideRouting,
  nextStreak,
  routableTierCount,
  routingQuestions,
  tierOfModel,
  truncateToBytes,
  ROUTING_CONFIDENCE_MIN,
  ROUTING_MESSAGE_MAX_BYTES,
  ROUTING_STREAK_REQUIRED,
  ROUTING_TIERS,
  type RoutingDecision,
  type RoutingModel,
  type RoutingSignals,
  type RoutingStayReason,
  type RoutingTier,
  type TierAssignment,
  type TierLabels,
} from "./routing";
export {
  createRoutingJudge,
  type RoutingJudge,
  type RoutingJudgeState,
  type RoutingPool,
  type RoutingResolution,
  type RoutingVerdict,
} from "./routing-judge";
export {
  askBadge,
  createGuardrailJudge,
  GUARDRAIL_TOOL,
  type GuardrailJudgeResult,
} from "./guardrail-judge";
export {
  createGuardrailCache,
  gitSnapshot,
  guardrailStateKey,
  type GuardrailCache,
  type GuardrailState,
  type GuardrailVerdict,
} from "./session-state";
export {
  LINT_COMPLETENESS_QUESTION,
  LINT_CONVENTIONS_QUESTION,
  LINT_DIMENSION_LABELS,
  LINT_DIFF_MAX_BYTES,
  LINT_DIFF_TRUNCATION_MARKER,
  LINT_ERROR_HANDLING_QUESTION,
  LINT_QUESTIONS,
  LINT_THRESHOLDS,
  correctionText,
  type LintQuestionId,
} from "./lint";
export {
  LINT_MAX_CYCLES,
  createLintGate,
  createLintTaskState,
  type LintGate,
  type LintTaskState,
} from "./lint-gate";
export { createLintJudge, lintFindings, type LintJudge, type LintState, type LintVerdict } from "./lint-judge";
export {
  discoverRubrics,
  RUBRIC_MAX_BYTES,
  RUBRIC_MAX_FILES,
  RUBRIC_NAMES,
  RUBRIC_TRUNCATION_MARKER,
  type RubricDoc,
} from "./rubrics";
export { captureHead, inGitRepo, taskDiff } from "./diff";
// #790: MPM seed rerank — per-candidate noul fan-out over the over-threshold
// seed set. One question per candidate, never an aggregated Score; the kept
// candidates are returned to the orientation module to assemble a rescued
// plan from them.
export {
  RERANK_CANDIDATES_MAX,
  RERANK_KEEP,
  RERANK_MIN,
  RERANK_THRESHOLDS,
  candidatesDroppedByCap,
  candidatesForRerank,
  keepFromAnswers,
  rerankQuestionsFor,
  rerankSignals,
  rerankStateFor,
  type RerankCandidate,
  type RerankRequest,
} from "./rerank";
export { createRerankJudge, type RerankJudge, type RerankJudgeDeps, type RerankVerdict } from "./rerank-judge";
// #793: per-turn skill suggestion — the two-call cookbook. Call 1 ranks the
// whole roster (bundled first-party + user skills, the session's own index)
// plus the "does this turn need a skill at all?" gate; call 2 re-reads the
// top-3 finalists with full descriptions. At most ONE suggested skill per
// turn, riding the ADR-0036 turn_notes section — the roster itself never
// enters the prompt.
export {
  NEEDS_SKILL_MIN,
  SKILLS_RANK_MAX,
  SKILL_RELEVANCE_MIN,
  SKILL_SUGGEST_KEEP,
  SKILL_THRESHOLDS,
  buildRelevance,
  candidatesForRank,
  rankQuestionsFor,
  rankStateFor,
  relevanceQuestionsFor,
  relevanceStateFor,
  rosterFromIndex,
  type RankedSkill,
  type SkillCandidate,
} from "./skills";
export { createSkillSuggestJudge, type SkillSuggestJudge, type SkillSuggestJudgeDeps, type SkillSuggestVerdict } from "./skill-judge";

// #826: the integration descriptor and the config surface this package owns
// (moved out of `@moh/core`). A client mounts `jevBundledSource` into
// `sessionFromConfig({ bundledExtensions })`; nothing in the core names Jev.
export { jevBundledSource } from "./integration";
// #832: the uniform per-use-case control surface — the vocabulary a client
// speaks to the extension with (the snapshot it reads, the ids and actions
// it sends) and the pure state machine behind it.
export {
  JEV_USE_CASE_ACTIONS,
  JEV_USE_CASES,
  createUseCaseControl,
  type JevRoutingHost,
  type JevUseCase,
  type JevUseCaseAction,
  type JevUseCaseOutcome,
  type JevUseCaseRefusal,
  type JevUseCaseSnapshot,
  type JevUseCaseState,
  type JevUseCaseStatus,
  type UseCaseControl,
  type UseCaseControlDeps,
} from "./use-cases";
export {
  TYPESAFE_SETTINGS_HINT,
  TYPESAFE_TIMEOUT_MS_DEFAULT,
  TYPESAFE_TIERS,
  maskApiKey,
  readTypesafeConfig,
  removeTypesafeApiKey,
  resolveTypesafeConfig,
  saveTypesafeApiKey,
  saveTypesafeClassification,
  saveTypesafeInjection,
  saveTypesafeLint,
  saveTypesafeRerank,
  saveTypesafeRouting,
  saveTypesafeSkills,
  typesafeConfigSchema,
  type ResolvedTypesafeConfig,
  type TypesafeConfig,
  type TypesafeTier,
} from "./typesafe";
