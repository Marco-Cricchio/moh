/**
 * Guardrail session state (#786): the judged state (command + git branch +
 * dirty/clean) and the session-scoped verdict cache keyed on it.
 *
 * Ratified: session-scoped ONLY — no persistence, no cross-session learning.
 * A branch switch or a dirty-flip invalidates every cached verdict (the same
 * command means a different thing on a different tree). Outside a git repo
 * the key is the command alone. The cache serves full verdicts: an "ask"
 * served from cache still prompts normally.
 */
import { spawnSync } from "node:child_process";

/** One judged bash command + its environment snapshot. */
export interface GuardrailState {
  readonly command: string;
  readonly cwd: string;
  /** Compact git status: "branch:dirty" | "branch:clean" | null (no repo). */
  readonly git: string | null;
}

export function guardrailStateKey(state: GuardrailState): string {
  return state.git === null ? state.command : `${state.git}\u0000${state.command}`;
}

/** Reads the compact git snapshot for a cwd; null outside a git repo. */
export function gitSnapshot(cwd: string): string | null {
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 1000 });
  if (branch.status !== 0) return null;
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd, timeout: 1000 });
  if (dirty.status !== 0) return null;
  return `${branch.stdout.toString().trim()}:${dirty.stdout.length > 0 ? "dirty" : "clean"}`;
}

/** A cached verdict. `ask` carries the ratified modal badge text ("Jev: caso
 * incerto (destructive 0.42)") and its key probability; a cached ask still
 * prompts normally when served. */
export type GuardrailVerdict =
  | { verdict: "deny"; reason: string }
  | { verdict: "ask"; badge: string; keyProbability: number }
  | { verdict: "pass" };

export interface GuardrailCache {
  /** Returns the cached verdict, or undefined when the key is unseen. */
  get(key: string): GuardrailVerdict | undefined;
  set(key: string, verdict: GuardrailVerdict): void;
  /** Drops every entry (branch switch, dirty-flip, session end). */
  clear(): void;
}

export function createGuardrailCache(): GuardrailCache {
  const map = new Map<string, GuardrailVerdict>();
  return {
    get: (key) => map.get(key),
    set: (key, verdict) => {
      // A full cache is not a realistic turn shape; drop-all keeps the
      // invariant trivially bounded per session.
      if (map.size >= 1000) map.clear();
      map.set(key, verdict);
    },
    clear: () => map.clear(),
  };
}
