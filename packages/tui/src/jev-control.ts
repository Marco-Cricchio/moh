/**
 * #832: the client side of the uniform Jev control surface.
 *
 * One place owns the two facts every surface needs — the extension's name on
 * the ADR-0038 command channel, and the shape of what it answers with — so
 * the `/routing` command, the `/jev` modal and any future setter cannot
 * drift apart. Nothing here decides anything: the extension owns the seven
 * use cases, their availability, their live status and what a command means;
 * this module only speaks the grammar to it and reads the snapshot back.
 *
 * Everything a user can do from here is **session-warm**: the config is
 * written by the Settings panel (persistent) and by `moh jev <usecase>
 * on|off` in the CLI, never by a session command (ADR-0038 §1).
 */
import type { AgentSession } from "@moh/core";
import type { JevUseCase, JevUseCaseAction, JevUseCaseSnapshot } from "@moh/jev-guard";

/** The bundled extension every Jev surface talks to (ADR-0038). */
export const JEV_EXTENSION_NAME = "jev-guard";

/**
 * Reads one key of an extension's own `state` store. The client usually
 * passes the session's own seam; a caller that has one (tests, a preview
 * surface) can inject its own.
 */
export type ExtensionStateReader = (extension: string, key: string) => unknown;

/** Sends one use-case command on the ADR-0038 channel. */
export function setJevUseCase(
  session: Pick<AgentSession, "setExtensionState">,
  usecase: JevUseCase,
  action: JevUseCaseAction,
): void {
  session.setExtensionState(JEV_EXTENSION_NAME, { cmd: "usecase", usecase, action });
}

/**
 * Unwraps a `state` entry. The extension stores *readers* (its state can move
 * between registration and the moment a command runs) but a plain snapshot is
 * just as valid — accept both, and never throw at a keypress: a getter that
 * blows up is not something to crash a command over.
 */
function readStored(read: ExtensionStateReader | undefined, key: string): unknown {
  let stored: unknown;
  try {
    stored = read?.(JEV_EXTENSION_NAME, key);
  } catch {
    return undefined;
  }
  try {
    return typeof stored === "function" ? (stored as () => unknown)() : stored;
  } catch {
    return undefined;
  }
}

/**
 * The uniform per-use-case snapshot (#832): `null` when the extension is not
 * registered or has not answered yet — a caller shows "still starting", it
 * never guesses a status.
 */
export function readJevState(read: ExtensionStateReader | undefined): JevUseCaseSnapshot | null {
  const state = readStored(read, "jevState");
  if (state === null || typeof state !== "object" || Array.isArray(state)) return null;
  return state as JevUseCaseSnapshot;
}

/** The router's own view of its state, read from the extension's `state`. */
export interface RoutingState {
  paused: boolean;
  override: boolean;
  streak: number;
  streakTier: string | null;
  decidedModel: string | null;
  assignment: { targets: Record<string, string | undefined>; ignoredLabels: string[]; unpriced: string[] } | null;
}

/** Routing's richer reader — the tier assignment beside the uniform status. */
export function readRoutingState(read: ExtensionStateReader | undefined): RoutingState | null {
  const state = readStored(read, "routingState");
  if (state === null || typeof state !== "object") return null;
  return state as RoutingState;
}
