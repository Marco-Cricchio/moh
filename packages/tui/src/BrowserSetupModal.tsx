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

/**
 * The guided browser-toolchain setup (#936), the one setup flow in the
 * TUI: the `browser_unavailable` warning opens it with `install now`, and
 * the Settings Browser row (#934, not built yet) is meant to open this
 * same surface rather than grow a second one. It is a thin
 * client over the core seam (#935) like every other client: the probe
 * reports the truth, the installer does the work, and this component owns
 * only what to show and which optional pieces the user asked for.
 *
 * The headless shell is the plan's floor — it is what a headless launch
 * needs. The full Chromium build (headful) and Playwright's system
 * dependencies are explicit, never implicit: both are downloads the user
 * must choose, and the second may ask for the administrator password.
 *
 * On success the client re-assembles the session (the tool registers at
 * assembly time), so `onInstalled` closes the modal and hands over.
 */
export interface BrowserSetupModalProps {
  /** Project root: its own `node_modules` wins over the moh toolchain. */
  cwd: string;
  /** User home; the moh-owned toolchain lives under `<home>/.moh` (#935). */
  home?: string;
  /** Test seam: the core probe (default `probeBrowserToolchain`). */
  probe?: (options: BrowserToolchainOptions) => BrowserToolchainStatus;
  /** Test seam: the core installer (default `installBrowserToolchain`). */
  install?: (options: BrowserToolchainInstallOptions) => Promise<BrowserToolchainInstallResult>;
  /** A successful install: the version now in the moh root. */
  onInstalled: (result: { version: string }) => void;
  onClose: () => void;
}

/** The two optional pieces, in the order the installer runs them. */
const OPTIONS = [
  { key: "chromium" as const, label: `full Chromium build (${FULL_CHROMIUM_DOWNLOAD_SIZE}) — browser.headless: false` },
  { key: "deps" as const, label: "system dependencies (may ask for your administrator password)" },
];

export function BrowserSetupModal({ cwd, home, probe, install, onInstalled, onClose }: BrowserSetupModalProps) {
  const theme = useTheme();
  const probeFn = probe ?? probeBrowserToolchain;
  const installFn = install ?? installBrowserToolchain;
  const [status, setStatus] = useState<BrowserToolchainStatus>(() => probeFn({ cwd, ...(home ? { home } : {}) }));
  const [withChromium, setWithChromium] = useState(false);
  const [withDeps, setWithDeps] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  // Spinner only while an install runs: the phases can be minutes long
  // (a 200 MB download on a slow line), and a frozen modal reads as a hang.
  useEffect(() => {
    if (busy === null) return;
    const timer = setInterval(() => setTick((n) => n + 1), 90);
    return () => clearInterval(timer);
  }, [busy]);

  const recheck = () => setStatus(probeFn({ cwd, ...(home ? { home } : {}) }));

  const start = async () => {
    setError(null);
    setBusy("starting");
    let phase = "";
    const result = await installFn({
      cwd,
      ...(home ? { home } : {}),
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
    if (result.ok) return onInstalled({ version: result.version });
    setError(result.message);
    // The probe is the status truth after any outcome: show what is
    // actually on disk now (the installer's own status, never a guess).
    setStatus(result.status);
  };

  useInput((input, key) => {
    if (busy !== null) return;
    if (key.escape) return onClose();
    if (key.upArrow || key.downArrow) {
      const delta = key.upArrow ? -1 : 1;
      return setCursor((c) => Math.min(OPTIONS.length - 1, Math.max(0, c + delta)));
    }
    if (input === " ") {
      return cursor === 0 ? setWithChromium((v) => !v) : setWithDeps((v) => !v);
    }
    if (input === "r") return recheck();
    if (key.return || input === "i") return void start();
  });

  const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;
  const row = (ok: boolean, label: string, value: string) => (
    <Text key={label}>
      {"  "}
      <Text color={ok ? theme.ok : theme.err}>{ok ? "✓" : "✗"}</Text> {label}
      {value ? <Dim>{`  ${value}`}</Dim> : null}
    </Text>
  );
  const packageValue = status.package.available
    ? `${status.package.version ?? "unknown"} · ${status.package.source === "project" ? "project node_modules" : "moh toolchain"}`
    : "";
  const shellValue = status.chromiumHeadlessShell.available ? status.chromiumHeadlessShell.version ?? "" : "";
  const fullValue = status.chromium.available ? status.chromium.version ?? "" : "";

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
      ) : (
        <>
          <Dim>{`installs playwright-core and the Chromium headless shell (${HEADLESS_SHELL_DOWNLOAD_SIZE}) — what a headless launch needs`}</Dim>
          {OPTIONS.map((option, index) => {
            const on = option.key === "chromium" ? withChromium : withDeps;
            return (
              <Text key={option.key} inverse={index === cursor}>
                {` ${index === cursor ? "▸" : " "} [${on ? "x" : " "}] ${option.label} `}
              </Text>
            );
          })}
          {error !== null && <Text color={theme.err}>{`✗ ${error}`}</Text>}
          <Text> </Text>
          <Text color={theme.ok}>[enter / i] {error !== null ? "retry the install" : "install"}</Text>
          <Dim>↑↓ select · space toggle · r re-check · esc close</Dim>
        </>
      )}
    </Dialog>
  );
}
