// B5 hermeticity (#1517): baselines never touch the network.
//
// On launch the TUI fetches the skills index from GitHub `main` and compares
// it with the bundled skills (`updateCheck` opt-out, App.tsx). Two layers
// keep B5 independent of the network and of the remote `main`:
//
//  - every scenario runs its child with a dead proxy (fails closed: any
//    outbound HTTP(S) request is refused; loopback — the fake provider
//    servers — bypasses the proxy);
//  - scenarios whose frames do not render the Settings "Update check" row
//    also set the `updateCheck: false` opt-out. The two that do render it
//    (overlay-walk, settings-submodal-return) keep the default `on`, which
//    the reference records, so they rely on the dead proxy alone.
import type { PtySpec } from "../../packages/tui/test/pty/pty-runner";

const DEAD = "http://127.0.0.1:9";

/** Child environment that refuses every non-loopback request. */
export const NET_BLOCKED_ENV: Record<string, string> = {
  HTTP_PROXY: DEAD,
  HTTPS_PROXY: DEAD,
  ALL_PROXY: DEAD,
  http_proxy: DEAD,
  https_proxy: DEAD,
  all_proxy: DEAD,
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};

/** Scenarios whose recorded frames show the Settings "Update check" value. */
export const SHOWS_UPDATE_CHECK = new Set(["overlay-walk", "settings-submodal-return"]);

/** Applies the dead proxy to a scenario spec (never drops its own env). */
export function hermetic(spec: PtySpec): PtySpec {
  return { ...spec, env: { ...spec.env, ...NET_BLOCKED_ENV } };
}

/** True when the spec cannot reach the network: dead proxy and/or opt-out. */
export function isHermetic(spec: PtySpec): { proxy: boolean; optOut: boolean } {
  const env = spec.env ?? {};
  const proxy = Object.entries(NET_BLOCKED_ENV).every(([k, v]) => env[k] === v);
  const optOut = spec.config?.updateCheck === false;
  return { proxy, optOut };
}
