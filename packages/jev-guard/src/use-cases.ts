/**
 * #832: the uniform per-use-case control surface — one vocabulary, one
 * command grammar, one snapshot, for all seven Jev use cases.
 *
 * Why it exists: routing (#787, ADR-0038) was the only use case governable
 * at session-warm time, because it was the only one that separated *being
 * available* (the session has a model pool) from *being opted in* (the
 * config says on). The other six were registered straight from the config
 * booleans at assembly, so `off` in `~/.moh/config` was a build-time fact:
 * no command could reach them, and a warm `on` for an opt-in use case had
 * nowhere to land.
 *
 * The split this module encodes, per use case:
 *
 * - **available** — this session has everything the use case needs (the
 *   model pool, the skill roster, the project root, or nothing at all).
 *   Not available = warm commands are refused and the status is `inert`:
 *   never a silent no-op, never a lie about what a command did.
 * - **config** — the opt-in in the user config: the state a fresh session
 *   starts in. It is reported next to the live status, because the whole
 *   point of a warm command is that it is *not* persistent, and a resumed
 *   session must be able to read why a use case is quiet while the config
 *   says otherwise.
 * - **warm** — the session-only override a command sets. Absent = the
 *   config decides.
 *
 * Routing is the one use case whose live state has more than on/off
 * (a manual model switch suspends it, and `auto` releases that); it is
 * injected here as a small host object rather than special-cased, so the
 * snapshot can report `paused` honestly without this module knowing what a
 * router is.
 *
 * The module is pure: it never touches `ctx`, the log or the network. The
 * caller appends the visibility line and routes the command.
 */

/** The seven use cases this surface governs, in the order clients show them. */
export const JEV_USE_CASES = [
  "guardrail",
  "routing",
  "classification",
  "injection",
  "lint",
  "rerank",
  "skills",
] as const;
export type JevUseCase = (typeof JEV_USE_CASES)[number];

/** The actions a client may send. `auto` is routing's own (release an override). */
export const JEV_USE_CASE_ACTIONS = ["on", "off", "auto"] as const;
export type JevUseCaseAction = (typeof JEV_USE_CASE_ACTIONS)[number];

/**
 * The live status of one use case:
 *
 * - `on` — it judges this session;
 * - `off` — it does not (by config, or by a warm command);
 * - `paused` — on, but suspended by session state of its own (routing's
 *   manual override);
 * - `inert` — on (or wanted), but structurally unable to act in this
 *   session: no pool, no roster, no root, or nothing to choose.
 */
export type JevUseCaseStatus = "on" | "off" | "paused" | "inert";

/** One use case, as a client reads it: the live status plus the contrast. */
export interface JevUseCaseState {
  readonly status: JevUseCaseStatus;
  /** The config's own value for this use case (what the next session starts in). */
  readonly config: boolean;
  /** A warm command moved the state away from the config: session-only. */
  readonly sessionOnly?: boolean;
  /** One plain-language line for a status that is not a plain `on`. */
  readonly note?: string;
}

/** The whole surface: one entry per use case, in `JEV_USE_CASES` order. */
export type JevUseCaseSnapshot = Readonly<Record<JevUseCase, JevUseCaseState>>;

/** Why a command was not applied — always rendered, never swallowed. */
export type JevUseCaseRefusal = "unavailable" | "unknown-action" | "unsupported" | "yolo";

/** What one command did. `null` (from `command`) = the use case is not ours. */
export interface JevUseCaseOutcome {
  readonly usecase: JevUseCase;
  /** The action as sent (narrowed to the grammar when it parsed). */
  readonly action: string;
  /** The state the command left behind (`config`/`sessionOnly` included). */
  readonly state: JevUseCaseState;
  /** Present only when the command changed nothing. */
  readonly refused?: JevUseCaseRefusal;
}

/** Routing's own session state machine, as this module needs to see it. */
export interface JevRoutingHost {
  /** Applies one action to the router (`on`/`off`/`auto`). */
  control(action: JevUseCaseAction): void;
  /** The router's live state: paused (a warm `off`) and the manual override. */
  state(): { paused: boolean; override: boolean };
  /** True when the router resolved to nothing to choose — fewer than two tiers. */
  inert(): boolean;
}

export interface UseCaseControlDeps {
  /** The config opt-in per use case: the starting state of a fresh session. */
  config: Readonly<Record<JevUseCase, boolean>>;
  /** The use cases this session has everything for. */
  available: Readonly<Record<JevUseCase, boolean>>;
  /** The permission mode; the guardrail cannot be disarmed in `yolo`. */
  mode?: () => string;
  /** Routing only: its own state machine (absent when routing is unavailable). */
  routing?: JevRoutingHost;
}

export interface UseCaseControl {
  /**
   * The gate: may this use case judge right now? Every hook asks this and
   * nothing else, so a warm command takes effect from the next hook call
   * without any re-registration.
   */
  isOn(usecase: JevUseCase): boolean;
  /** One use case's live state (the snapshot's building block). */
  state(usecase: JevUseCase): JevUseCaseState;
  /** The whole surface, for the `jevState` reader a client asks. */
  snapshot(): JevUseCaseSnapshot;
  /**
   * Applies one command from the uniform grammar. Returns `null` when the
   * name is not one of the seven — the caller decides how visible that is
   * (never a throw: a client may be newer than this extension).
   */
  command(usecase: string, action: string): JevUseCaseOutcome | null;
}

const isUseCase = (value: string): value is JevUseCase =>
  (JEV_USE_CASES as readonly string[]).includes(value);

const isAction = (value: string): value is JevUseCaseAction =>
  (JEV_USE_CASE_ACTIONS as readonly string[]).includes(value);

export function createUseCaseControl(deps: UseCaseControlDeps): UseCaseControl {
  /** The session-only overrides: present = a warm command spoke. */
  const warm = new Map<JevUseCase, boolean>();

  /** The effective on/off, before routing's own suspension is considered. */
  const enabled = (usecase: JevUseCase): boolean =>
    warm.has(usecase) ? warm.get(usecase)! : deps.config[usecase];

  /** True when the live state is a warm command's doing, not the config's. */
  const sessionOnly = (usecase: JevUseCase): boolean =>
    warm.has(usecase) && warm.get(usecase) !== deps.config[usecase];

  const isOn = (usecase: JevUseCase): boolean => {
    if (!deps.available[usecase] || !enabled(usecase)) return false;
    if (usecase === "routing") {
      const live = deps.routing?.state();
      // The router's own pause mirrors the warm/config flag; the override is
      // its own state (the user took the wheel by switching model by hand),
      // and an inert router has nothing to choose between.
      if (live?.paused || live?.override || deps.routing?.inert()) return false;
    }
    return true;
  };

  const state = (usecase: JevUseCase): JevUseCaseState => {
    const config = deps.config[usecase];
    const solo = sessionOnly(usecase);
    const base = { config, ...(solo ? { sessionOnly: true as const } : {}) };
    if (!deps.available[usecase]) {
      return { ...base, status: "inert", note: "not available in this session" };
    }
    if (!enabled(usecase)) {
      return { ...base, status: "off", note: solo ? "off for this session" : "off in the config" };
    }
    if (usecase === "routing") {
      const live = deps.routing?.state();
      if (live?.override) {
        return {
          ...base,
          status: "paused",
          note: "suspended — you picked the model by hand (auto hands it back)",
        };
      }
      if (live?.paused) return { ...base, status: "paused", note: "paused for this session" };
      if (deps.routing?.inert()) {
        return { ...base, status: "inert", note: "fewer than two tiers to choose from" };
      }
    }
    if (usecase === "guardrail" && deps.mode?.() === "yolo") {
      // Yolo narrows the guardrail to the lethal checks; saying so is the
      // difference between a filter and a decoration.
      return { ...base, status: "on", note: "yolo — the lethal checks only" };
    }
    return { ...base, status: "on" };
  };

  const command = (usecase: string, action: string): JevUseCaseOutcome | null => {
    if (!isUseCase(usecase)) return null;
    const refused = (refusal: JevUseCaseRefusal, over?: string): JevUseCaseOutcome => ({
      usecase,
      action: over ?? action,
      state: state(usecase),
      refused: refusal,
    });
    if (!isAction(action)) return refused("unknown-action");
    if (!deps.available[usecase]) return refused("unavailable");
    // ADR-0031, strictly: in yolo the guardrail is the only thing standing
    // between a lethal command and the machine, and a filter that can be
    // switched off in the mode that needs it most is not a filter.
    if (usecase === "guardrail" && action === "off" && deps.mode?.() === "yolo") {
      return refused("yolo");
    }
    // `auto` releases a manual override — routing's own concept. Anywhere
    // else it is a client bug, and it says so instead of doing something
    // plausible.
    if (action === "auto" && usecase !== "routing") return refused("unsupported");
    if (usecase === "routing") {
      // The router owns pause/override; the controller's flag is set in
      // lockstep so `isOn` needs no second source of truth for on/off.
      deps.routing?.control(action);
      if (action !== "auto") warm.set(usecase, action === "on");
    } else {
      warm.set(usecase, action === "on");
    }
    return { usecase, action, state: state(usecase) };
  };

  return {
    isOn,
    state,
    command,
    snapshot(): JevUseCaseSnapshot {
      const out = {} as Record<JevUseCase, JevUseCaseState>;
      for (const usecase of JEV_USE_CASES) out[usecase] = state(usecase);
      return out;
    },
  };
}
