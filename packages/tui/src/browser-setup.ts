/**
 * The browser tool as the TUI reads it: the diagnostic (#936) and the
 * project's own activation setting (#934).
 *
 * The core appends one `browser_unavailable` chrome event at session open
 * when the browser tool is enabled but its toolchain is missing (#774,
 * #935). Two different questions are asked of that event, and they must
 * not be conflated:
 *
 *  - **the transcript** renders *history*: every diagnostic in the log is
 *    a block, including the ones an earlier open produced (a resumed
 *    session keeps its warning).
 *  - **the action chip** states the *present*: whether this open observed
 *    a missing toolchain, which is what `currentBrowserDiagnostic` answers.
 *    A resumed session whose toolchain has since been installed must not
 *    keep offering setup.
 *
 * The rule is the log's own grammar: the diagnostic belongs to the current
 * open when it is appended after the last `session_start` (a fresh open) or
 * `session_resumed` (a resume) — both of which the core appends *before*
 * the startup chrome. Everything older is history.
 *
 * Activation is **per project** (ADR-0029 decision 6): `browser.enabled`
 * lives in that project's `moh.json`, so project A can have the tool while
 * project B does not. The *toolchain* is user-level — one install under
 * `<home>/.moh/browser-toolchain` serves every project, and a project-local
 * `playwright-core` still wins. The Settings row (#934) therefore states
 * both halves: `on (this project) · toolchain ready`.
 *
 * The project's `moh.json` is written the same read-modify-write way the
 * rest of the settings panel writes it (`loadMohConfig` + `writeMohConfig`),
 * so unrelated keys survive and a broken file throws instead of being
 * silently rewritten.
 */
import { join } from "node:path";
import { loadMohConfig, writeMohConfig, type AgentEvent, type BrowserToolchainStatus } from "@moh/core";

/** The TUI's action line under the transcript warning. The core's reason
 * already names the CLI command and the Settings path; this names the door
 * that always exists in the TUI — the block is history, so it must not
 * advertise a key that only works while the warning is current (the footer
 * alarm and the `install` chip carry that one). */
export const BROWSER_SETUP_ACTION = "install now: /browser";

/**
 * The `browser_unavailable` reason this open observed, or null when the
 * current open has none (nothing enabled, a working toolchain, or only an
 * older diagnostic in the log).
 */
export function currentBrowserDiagnostic(events: readonly AgentEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    // The open marker is the boundary: a diagnostic above it belongs to an
    // earlier open and describes an environment this session never saw.
    if (event.type === "session_start" || event.type === "session_resumed") return null;
    if (event.type === "browser_unavailable") return event.reason;
  }
  return null;
}

/** #934: the project's browser activation, as its `moh.json` declares it. */
export interface BrowserSetting {
  /** `browser.enabled`; absent = off (the opt-in default, ADR-0029). */
  enabled: boolean;
  /** `browser.headless`; absent = true (headless, the default). */
  headless: boolean;
  /** `browser.allowedHosts`; empty = the default SSRF policy (loopback only). */
  allowedHosts: string[];
}

/** The project file the Browser row reads and writes. */
export function projectMohConfigFile(cwd: string): string {
  return join(cwd, "moh.json");
}

/**
 * The project's browser setting, with the file's readability stated rather
 * than guessed: `broken` is set when `moh.json` exists but does not
 * validate, so the row can say "unreadable" instead of claiming "off" for a
 * file it never managed to read.
 */
export interface BrowserSettingWithState extends BrowserSetting {
  /** The project `moh.json` could not be parsed/validated. */
  broken: boolean;
}

/** The project's setting, plus whether the file could be read at all. */
export function readBrowserSettingWithState(cwd: string): BrowserSettingWithState {
  try {
    const browser = loadMohConfig(projectMohConfigFile(cwd)).browser;
    return {
      enabled: browser?.enabled === true,
      headless: browser?.headless ?? true,
      allowedHosts: browser?.allowedHosts ?? [],
      broken: false,
    };
  } catch {
    // A settings *row* must not throw over a file it is not about to touch;
    // the write path is where it is loud. `broken` keeps the row honest.
    return { enabled: false, headless: true, allowedHosts: [], broken: true };
  }
}

/**
 * The project's browser setting alone (the modal's own view): a broken file
 * reads as the conservative default, and the first write reports it.
 */
export function readBrowserSetting(cwd: string): BrowserSetting {
  const { broken: _broken, ...setting } = readBrowserSettingWithState(cwd);
  return setting;
}

/**
 * Persists one browser setting into the project's `moh.json`, preserving
 * every other key. What is written is exactly what the user chose:
 * `enabled` always (a deliberate on/off must be durable — omitting it would
 * leave a previously-enabled project on), `headless` only when it is the
 * non-default `false`, `allowedHosts` only when non-empty (clearing the last
 * host drops the key rather than storing an empty list). One read of the
 * file is both the merge base and the current setting, so they cannot
 * disagree. Throws on an invalid `moh.json` — never a silent rewrite of a
 * file it could not read.
 */
export function writeBrowserSetting(cwd: string, patch: Partial<BrowserSetting>): BrowserSetting {
  const file = projectMohConfigFile(cwd);
  const config = loadMohConfig(file);
  const current: BrowserSetting = {
    enabled: config.browser?.enabled === true,
    headless: config.browser?.headless ?? true,
    allowedHosts: config.browser?.allowedHosts ?? [],
  };
  const next: BrowserSetting = { ...current, ...patch };
  const browser = {
    enabled: next.enabled,
    ...(next.headless ? {} : { headless: false }),
    ...(next.allowedHosts.length > 0 ? { allowedHosts: next.allowedHosts } : {}),
  };
  writeMohConfig(file, { ...config, browser });
  return next;
}

/** `192.168.1.1, 10.0.0.5` → the trimmed, de-duplicated host list. */
export function parseAllowedHosts(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,]+/)) {
    const host = raw.trim();
    if (host) seen.add(host);
  }
  return [...seen];
}

/**
 * One phrase for the toolchain as the probe found it, in the mode the
 * project will actually launch in: a headless launch needs the shell, a
 * headful one the full build — so "ready" never overstates either.
 */
export function browserToolchainLabel(status: BrowserToolchainStatus, headless = true): string {
  if (!status.package.available) return "toolchain missing";
  if (!headless) return status.chromium.available ? "toolchain ready" : "full Chromium missing";
  return status.chromiumHeadlessShell.available ? "toolchain ready" : "headless shell missing";
}

/** The Settings row's value (#934): the project's state, then the
 * user-level toolchain's — `off (this project) · toolchain ready`. An
 * unreadable `moh.json` says so instead of claiming the default. */
export function browserRowValue(setting: BrowserSetting, status: BrowserToolchainStatus, broken = false): string {
  if (broken) return "moh.json is invalid — fix the file";
  const state = setting.enabled ? "on (this project)" : "off (this project)";
  return `${state} · ${browserToolchainLabel(status, setting.headless)}`;
}
