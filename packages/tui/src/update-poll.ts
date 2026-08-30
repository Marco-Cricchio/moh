/**
 * Background update polling (#348): a single 30-minute scheduler drives
 * both the binary-release check (ADR-0014) and the first-party skill
 * upstream check, gated by the shared `updateCheck` user-config opt-out
 * (checked by the caller). The poller itself is UI-free and clock-free:
 * timers are injectable so tests observe scheduling directly, and `fire`
 * is one tick — the caller decides what a tick checks.
 *
 * Anti-overlap contract: a tick that is still in flight (its `fire`
 * promise unsettled) suppresses the next tick rather than piling a
 * second request on top. Fail-silence contract: a throwing (or
 * rejecting) fire never kills the scheduler.
 */

/** One check of everything per 30 minutes (#348). */
export const UPDATE_POLL_INTERVAL_MS = 30 * 60_000;

/** Injectable timer surface (defaults to the globals). */
export interface PollTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
}

export interface UpdatePollOptions {
  /** One tick: perform the checks. Sync or async. */
  fire: () => void | Promise<void>;
  intervalMs?: number;
  timers?: PollTimers;
}

/**
 * Starts the poller. Returns the stop function (clears the timer; the
 * caller is responsible for discarding in-flight results via its own
 * liveness flag). Never fires immediately: the launch-time check belongs
 * to the caller.
 */
export function startUpdatePoll(options: UpdatePollOptions): () => void {
  const timers: PollTimers = options.timers ?? {
    set: (fn, ms) => setInterval(fn, ms),
    clear: (id) => clearInterval(id as ReturnType<typeof setInterval>),
  };
  const intervalMs = options.intervalMs ?? UPDATE_POLL_INTERVAL_MS;
  let inFlight = false;
  const tick = () => {
    if (inFlight) return; // #348: never overlap requests
    inFlight = true;
    try {
      const result = options.fire();
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).then(
          () => { inFlight = false; },
          () => { inFlight = false; }, // fail-silent: a rejected tick never kills the poller
        );
      } else {
        inFlight = false;
      }
    } catch {
      inFlight = false; // sync throw: same fail-silent contract
    }
  };
  const id = timers.set(tick, intervalMs);
  return () => timers.clear(id);
}

/** Row-2 / toast wording for discovered skill updates (#348). */
export function skillUpdateNoticeText(count: number): string {
  return `${count} skill update${count === 1 ? "" : "s"} available (/skills update)`;
}

/**
 * Projection of both discovery results onto the status row 2 notice
 * (#348): the binary notice keeps its wording; a skill notice joins it
 * after a " · " separator. `null`/absent/zero discoveries project to no
 * notice at all.
 */
export function statusRowUpdateText(binaryNotice: string | null | undefined, skillUpdateCount: number | null): string | undefined {
  const parts: string[] = [];
  if (binaryNotice) parts.push(binaryNotice);
  if (skillUpdateCount && skillUpdateCount > 0) parts.push(skillUpdateNoticeText(skillUpdateCount));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
