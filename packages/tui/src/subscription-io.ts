/**
 * TUI wiring of the core `AuthorizationIo` seam (issue #149): the
 * subscription grants (auth/anthropic.ts, ...) drive an async
 * ask/info/openUrl sequence; this adapter surfaces it in the Ink overlay.
 *
 * - `info` lines are appended to a log the overlay renders (authorize
 *   URLs included — the terminal makes them copyable);
 * - `ask` parks a pending prompt whose answer the overlay resolves when
 *   the user presses enter (the manual-paste path);
 * - `openUrl` is the same best-effort spawn the CLI uses (never throws;
 *   false on headless boxes, where the paste path always works).
 *
 * Typed/pasted values are rendered masked by the overlay — token and
 * code material never reaches the screen (spec invariant 2).
 */
import { spawn } from "node:child_process";
import type { AuthorizationIo } from "@moh/core";

/** Best-effort browser open: never throws; false headless/unknown OS. */
export async function openUrlBestEffort(url: string): Promise<boolean> {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => resolve(true));
    } catch {
      resolve(false);
    }
  });
}

interface PendingAsk {
  prompt: string;
  resolve: (answer: string) => void;
}

/**
 * The overlay-backed `AuthorizationIo`. The overlay re-renders on every
 * `notify` (new info line or pending-prompt change) and calls `answer`
 * on enter. One instance per login attempt.
 */
export class TuiAuthorizationIo implements AuthorizationIo {
  private readonly lines: string[] = [];
  private pending: PendingAsk | null = null;
  private notifyChange: () => void = () => {};

  constructor(private readonly openUrlImpl: (url: string) => Promise<boolean> = openUrlBestEffort) {}

  /** Overlay hook: called after every state change. */
  subscribe(notify: () => void): () => void {
    this.notifyChange = notify;
    return () => {
      if (this.notifyChange === notify) this.notifyChange = () => {};
    };
  }

  /** Info lines to render (authorize URLs included — copyable). */
  get log(): readonly string[] {
    return this.lines;
  }

  /** The prompt awaiting an answer, if any (the manual-paste path). */
  get pendingPrompt(): string | null {
    return this.pending?.prompt ?? null;
  }

  /** Resolves the pending ask (enter in the overlay). No-op if none. */
  answer(value: string): void {
    const pending = this.pending;
    this.pending = null;
    this.notifyChange();
    pending?.resolve(value);
  }

  info = async (line: string): Promise<void> => {
    this.lines.push(...line.split("\n"));
    this.notifyChange();
  };

  ask = (prompt: string): Promise<string> =>
    new Promise<string>((resolve) => {
      this.pending = { prompt, resolve };
      this.notifyChange();
    });

  openUrl = (url: string): Promise<boolean> => this.openUrlImpl(url);
}
