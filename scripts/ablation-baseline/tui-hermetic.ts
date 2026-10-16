// B5 hermeticity (#1517): baselines never touch the network.
//
// On launch the TUI fetches the skills index from GitHub `main` and compares
// it with the bundled skills (`updateCheck` opt-out, App.tsx). Two layers
// keep B5 independent of the network and of the remote `main`:
//
//  - every scenario runs its child with a dead proxy (fails closed: any
//    outbound HTTP(S) request is refused; loopback — the fake provider
//    servers — bypasses the proxy);
//  - every scenario also sets the `updateCheck: false` opt-out, except the
//    two whose frames render the Settings "Update check" row
//    (overlay-walk, settings-submodal-return): they keep the default `on`,
//    which the reference records, so they rely on the dead proxy alone.
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

/** Applies the dead proxy to a scenario spec (never drops its own env). */
export function hermetic(spec: PtySpec): PtySpec {
  return { ...spec, env: { ...spec.env, ...NET_BLOCKED_ENV } };
}
