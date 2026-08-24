/**
 * Generic RFC 8628 device-flow polling (issues #160/#162/#163). Shape and
 * semantics verified against pi-ai's `auth/oauth/device-code.js` (MIT,
 * 0.84.2): interval floor, RFC 3.5 slow_down handling (server-provided
 * interval wins; else +5s), deadline from `expires_in`, optional
 * first-poll wait. Headless core: the sleep seam is injectable so tests
 * run without real time.
 */

/** Minimal injectable clock: sleep + now. Tests script both. */
export interface DeviceFlowClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const defaultDeviceFlowClock: DeviceFlowClock = {
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
};

export type DevicePollResult<T> =
  | { status: "pending" }
  | { status: "slow_down"; intervalSeconds?: number }
  | { status: "failed"; message: string }
  | { status: "complete"; value: T };

export interface DevicePollOptions<T> {
  intervalSeconds?: number;
  expiresInSeconds?: number;
  waitBeforeFirstPoll?: boolean;
  poll(): Promise<DevicePollResult<T>>;
  clock?: DeviceFlowClock;
}

/** RFC 8628 §3.2: default interval when the server omits one. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const MINIMUM_INTERVAL_MS = 1000;
/** RFC 8628 §3.5: slow_down increases the interval by 5 seconds. */
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000;

export async function pollDeviceCodeFlow<T>(options: DevicePollOptions<T>): Promise<T> {
  const clock = options.clock ?? defaultDeviceFlowClock;
  const deadline = options.expiresInSeconds !== undefined ? clock.now() + options.expiresInSeconds * 1000 : Infinity;
  let intervalMs = Math.max(
    MINIMUM_INTERVAL_MS,
    Math.floor((options.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000),
  );
  if (options.waitBeforeFirstPoll && clock.now() < deadline) {
    await clock.sleep(Math.min(intervalMs, deadline - clock.now()));
  }
  let slowDownResponses = 0;
  while (clock.now() < deadline) {
    const result = await options.poll();
    if (result.status === "complete") return result.value;
    if (result.status === "failed") throw new Error(result.message);
    if (result.status === "slow_down") {
      slowDownResponses += 1;
      // Server-provided interval wins (GitHub reports the new minimum);
      // otherwise the RFC 3.5 increment. Guards against polling early
      // forever under clock drift.
      intervalMs =
        typeof result.intervalSeconds === "number" && Number.isFinite(result.intervalSeconds) && result.intervalSeconds > 0
          ? Math.max(MINIMUM_INTERVAL_MS, Math.floor(result.intervalSeconds * 1000))
          : Math.max(MINIMUM_INTERVAL_MS, intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS);
    }
    const remaining = deadline - clock.now();
    if (remaining <= 0) break;
    await clock.sleep(Math.min(intervalMs, remaining));
  }
  // A timeout after slow_down responses is usually clock drift (WSL/VM)
  // — a distinct message points the user at the right fix (pi's hint).
  throw new Error(
    slowDownResponses > 0
      ? "device flow timed out after slow_down responses — often clock drift in WSL/VM environments; sync the clock and retry"
      : "device flow timed out",
  );
}
