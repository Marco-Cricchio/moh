import React, { useEffect, useRef, useState } from "react";
import { Text, useInput } from "ink";
import {
  FULL_CHROMIUM_DOWNLOAD_SIZE,
  HEADLESS_SHELL_DOWNLOAD_SIZE,
  installBrowserToolchain,
  probeBrowserToolchain,
  type BrowserToolchainInstallOptions,
  type BrowserToolchainInstallResult,
  type BrowserToolchainOptions,
  type BrowserToolchainStatus,
} from "@moh/core";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";
import { SPINNER_FRAMES } from "./icons";
import {
  parseAllowedHosts,
  readBrowserSetting,
  writeBrowserSetting,
  type BrowserSetting,
} from "./browser-setup";

/**
 * The one browser surface (#936, completed by #934): the transcript
 * warning's `install now`, `/browser`, ctrl+b and the Settings Browser row
 * all open this modal, so the TUI never grows a second installer path or a
 * second place that decides what `browser.enabled` means.
 *
 * It is a thin client over the core seam (#935) — the probe reports the
 * truth, the installer does the work — plus the two things the core
 * deliberately does not own: the *project* setting (`browser.enabled`,
 * `browser.headless`, `browser.allowedHosts` in that project's moh.json,
 * written the same read-modify-write way the rest of the settings panel
 * writes it) and what to show.
 *
 * Three planes, stated separately because they are separate:
 *
 *  - **the project** — activation is per project (ADR-0029 decision 6):
 *    enabling here writes *this* project's moh.json, and the tool is
 *    registered when a session is assembled, so the client re-assembles the
 *    live one on the way out.
 *  - **the toolchain** — user-level, one install for every project: the
 *    headless shell (~200 MB) is the plan's floor because it is what a
 *    headless launch runs; the full Chromium build (~500 MB, headful) and
 *    Playwright's system dependencies (which may ask for the administrator
 *    password) are explicit choices, never implicit.
 *  - **the effect** — nothing happens to the running session until the modal
 *    leaves the screen: it reports what it did once, through `onDone`, and
 *    the client decides (reload now, or the next session picks it up).
 *
 * A successful install closes the modal by itself (the download is over; the
 * user's next act is to use the browser). A setting change waits for esc, so
 * several toggles cost one re-assembly instead of one each.
 */
export interface BrowserSetupModalProps {
  /** Project root: its own `node_modules` wins over the moh toolchain. */
  cwd: string;
  /** User home; the moh-owned toolchain lives under `<home>/.moh` (#935). */
  home?: string;
  /** Whether a live session exists — decides whether a change is live now
   * (the client re-assembles) or waits for the next session. */
  hasSession?: boolean;
  /** Test seam: the core probe (default `probeBrowserToolchain`). */
  probe?: (options: BrowserToolchainOptions) => BrowserToolchainStatus;
  /** Test seam: the core installer (default `installBrowserToolchain`). */
  install?: (options: BrowserToolchainInstallOptions) => Promise<BrowserToolchainInstallResult>;
  /** Called once, when the modal leaves the screen. */
  onDone: (outcome: BrowserSetupOutcome) => void;
}

/**
 * What the modal did, reported exactly once — so the client can re-assemble
 * the session (the browser registers at assembly time) or say that the next
 * session picks the change up, without having watched the modal's keys.
 */
export type BrowserSetupOutcome =
  /** Nothing was changed: nothing to apply. */
  | { kind: "none" }
  /** The project setting moved; `note` is the sentence to show. */
  | { kind: "config"; note: string }
  /** The toolchain was installed; `note` describes the resulting state. */
  | { kind: "installed"; version: string; note: string };

/** The interactive rows, in cursor order: the project's three, the plan's
 * two, then the action. */
const ROWS = ["enabled", "headless", "hosts", "chromium", "deps", "install"] as const;
type RowKey = (typeof ROWS)[number];

export function BrowserSetupModal({ cwd, home, hasSession = false, probe, install, onDone }: BrowserSetupModalProps) {
  const theme = useTheme();
  const probeFn = probe ?? probeBrowserToolchain;
  const installFn = install ?? installBrowserToolchain;
  const probeOptions: BrowserToolchainOptions = { cwd, ...(home ? { home } : {}) };
  const [setting, setSetting] = useState<BrowserSetting>(() => readBrowserSetting(cwd));
  const [status, setStatus] = useState<BrowserToolchainStatus>(() => probeFn(probeOptions));
  const [withChromium, setWithChromium] = useState(false);
  const [withDeps, setWithDeps] = useState(false);
  const [cursor, setCursor] = useState(0);
  /** Non-null while the allowed-hosts line is being typed. */
  const [hosts, setHosts] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const live = useRef(true);
  /** The last persisted change, as a sentence — what the client shows. */
  const changed = useRef<string | null>(null);

  // Spinner only while an install runs: the phases can be minutes long
  // (a 200 MB download on a slow line), and a frozen modal reads as a hang.
  useEffect(() => {
    if (busy === null) return;
    const timer = setInterval(() => setTick((n) => n + 1), 90);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => () => { live.current = false; }, []);

  const recheck = () => setStatus(probeFn(probeOptions));

  /** The tail of every note: whether the change is live now or waits. A
   * disable has nothing to register, so it carries no tail. */
  const tail = (next: BrowserSetting): string =>
    hasSession
      ? next.enabled
        ? " — the browser tool is registered"
        : ""
      : " — your next session picks it up";

  /** Persists one setting change and remembers how to say it. A broken
   * moh.json is shown, never swallowed and never rewritten blind. */
  const apply = (patch: Partial<BrowserSetting>, describe: (next: BrowserSetting) => string) => {
    try {
      const next = writeBrowserSetting(cwd, patch);
      setSetting(next);
      setError(null);
      changed.current = describe(next);
    } catch (e) {
      setError(`moh.json: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const toggleEnabled = () =>
    apply({ enabled: !setting.enabled }, (next) =>
      `browser ${next.enabled ? `on for this project (${next.headless ? "headless" : "headful"})` : "off for this project"}${tail(next)}`,
    );

  const toggleHeadless = () =>
    apply({ headless: !setting.headless }, (next) =>
      `browser ${next.headless ? "headless" : `headful (needs the full Chromium build, ${FULL_CHROMIUM_DOWNLOAD_SIZE})`} for this project${tail(next)}`,
    );

  const saveHosts = (text: string) =>
    apply({ allowedHosts: parseAllowedHosts(text) }, (next) =>
      `browser allowed hosts: ${next.allowedHosts.join(", ") || "none"}${tail(next)}`,
    );

  const finish = (outcome: BrowserSetupOutcome) => {
    live.current = false;
    onDone(outcome);
  };

  const close = () =>
    finish(changed.current !== null ? { kind: "config", note: changed.current } : { kind: "none" });

  const start = async () => {
    setError(null);
    setBusy("starting");
    let phase = "";
    const result = await installFn({
      ...probeOptions,
      withChromium,
      withDeps,
      onProgress: (event) => {
        // One open line per phase: the subprocess lines inside a phase are
        // that line's detail, not extra rows.
        if (event.phase === phase) return;
        phase = event.phase;
        if (live.current) setBusy(event.message);
      },
    });
    if (!live.current) return;
    setBusy(null);
    setStatus(result.status);
    if (!result.ok) {
      // The probe is the status truth after any outcome: the installer's
      // own status, never a guess. The message is the core's, actionable.
      setError(result.message);
      return;
    }
    const base = `browser toolchain ready (playwright-core ${result.version})`;
    finish({
      kind: "installed",
      version: result.version,
      note: setting.enabled ? `${base}${tail(setting)}` : `${base} — enable it for this project to use it`,
    });
  };

  const act = (row: RowKey) => {
    if (row === "enabled") return toggleEnabled();
    if (row === "headless") return toggleHeadless();
    if (row === "hosts") return setHosts(setting.allowedHosts.join(", "));
    if (row === "chromium") return setWithChromium((v) => !v);
    if (row === "deps") return setWithDeps((v) => !v);
    return void start();
  };

  useInput((input, key) => {
    // An install owns the modal while it runs: abandoning a 200 MB download
    // by a stray key would be the one unrecoverable act on this screen.
    if (busy !== null) return;
    if (hosts !== null) {
      if (key.escape) return setHosts(null);
      if (key.backspace || key.delete) return setHosts(hosts.slice(0, -1));
      if (key.return || input === "\n") {
        saveHosts(hosts);
        return setHosts(null);
      }
      if (input && !key.ctrl && !key.meta) return setHosts(hosts + input);
      return;
    }
    if (key.escape) return close();
    if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) return setCursor((c) => Math.min(ROWS.length - 1, c + 1));
    if (input === "i") return void start();
    if (input === "r") return recheck();
    if (input === " " || key.return || input === "\n") return act(ROWS[cursor]!);
  });

  const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;
  const row = (ok: boolean, label: string, value: string) => (
    <Text key={label}>
      {"  "}
      <Text color={ok ? theme.ok : theme.err}>{ok ? "✓" : "✗"}</Text> {label}
      {value ? <Dim>{`  ${value}`}</Dim> : null}
    </Text>
  );
  const option = (key: RowKey, label: string, on: boolean) => {
    const selected = ROWS.indexOf(key) === cursor;
    return (
      <Text key={key} inverse={selected}>
        {` ${selected ? "▸" : " "} [${on ? "x" : " "}] ${label} `}
      </Text>
    );
  };
  const action = (key: RowKey, label: string) => {
    const selected = ROWS.indexOf(key) === cursor;
    return (
      <Text key={key} inverse={selected}>
        {` ${selected ? "▸" : " "} ${label} `}
      </Text>
    );
  };

  const packageValue = status.package.available
    ? `${status.package.version ?? "unknown"} · ${status.package.source === "project" ? "project node_modules" : "moh toolchain"}`
    : "";
  const shellValue = status.chromiumHeadlessShell.available ? status.chromiumHeadlessShell.version ?? "" : "";
  const fullValue = status.chromium.available ? status.chromium.version ?? "" : "";
  // Headful without the full build is the one combination that cannot work:
  // said here, where the option that fixes it is one row away.
  const headfulWithoutBuild = !setting.headless && !status.chromium.available;

  return (
    <Dialog title=" browser setup " color={theme.purple}>
      <Dim>{`toolchain  ${status.root}`}</Dim>
      {row(status.package.available, "playwright-core", packageValue)}
      {row(status.chromiumHeadlessShell.available, "chromium headless shell", shellValue)}
      {row(status.chromium.available, "chromium (full build)", fullValue)}
      <Text> </Text>
      {busy !== null ? (
        <>
          <Text color={theme.accent}>{`${spinner} ${busy}`}</Text>
          <Dim>the download runs on moh's own runtime — no npm, no system Bun; this can take a few minutes</Dim>
          <Dim>leaving it interrupted is safe: a working toolchain is never replaced by a broken one</Dim>
        </>
      ) : hosts !== null ? (
        <>
          <Text bold>{`allowed hosts: ${hosts}▏`}</Text>
          <Text> </Text>
          <Dim>comma or space separated exact hosts (e.g. 192.168.1.10) — the SSRF escape hatch</Dim>
          <Dim>loopback is always allowed; other private and link-local ranges are blocked without an entry</Dim>
          <Text> </Text>
          <Text color={theme.ok}>[enter] save · [esc] cancel</Text>
          <Dim>an empty line clears the list back to the default policy</Dim>
        </>
      ) : (
        <>
          <Dim>this project — moh.json</Dim>
          {option("enabled", "enable the browser tool for this project", setting.enabled)}
          {option("headless", "headless — a real Chrome window when off", setting.headless)}
          {action("hosts", `allowed hosts: ${setting.allowedHosts.join(", ") || "none"} — enter to edit`)}
          <Text> </Text>
            <Dim>all install options below are user-level: one toolchain serves every project</Dim>
          {option("chromium", `full Chromium build (${FULL_CHROMIUM_DOWNLOAD_SIZE}) — browser.headless: false`, withChromium)}
          {option("deps", "system dependencies (may ask for your administrator password)", withDeps)}
          {action("install", `install playwright-core + the Chromium headless shell (${HEADLESS_SHELL_DOWNLOAD_SIZE})`)}
          {headfulWithoutBuild && (
            <Text color={theme.warn}>
              {` ⚠ headful needs the full Chromium build (${FULL_CHROMIUM_DOWNLOAD_SIZE}) — select it above, then install`}
            </Text>
          )}
          {error !== null && <Text color={theme.err}>{`✗ ${error}`}</Text>}
          <Text> </Text>
          <Text color={theme.ok}>[enter / space] change · [i] install</Text>
          <Dim>↑↓ select · r re-check · esc {changed.current !== null ? "apply and close" : "close"}</Dim>
        </>
      )}
    </Dialog>
  );
}
