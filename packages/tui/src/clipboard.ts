/**
 * Clipboard write seam (#672). Preference order: OSC 52 (works over
 * ssh, no external dependency — both clipboard and primary where the
 * terminal accepts it), then platform binaries (`pbcopy` / `wl-copy` /
 * `xclip` / `clip.exe` via WSL paths). Backend detection happens on
 * first use and is cached; a missing backend degrades to null and the
 * caller shows a warning line — never an error path.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export interface ClipboardBackend {
  kind: "osc52" | "binary";
  /** Writes `text` (never throws; the caller owns the feedback). */
  write(text: string): Promise<void>;
}

let cached: ClipboardBackend | null | undefined;

/** True under WSL: clip.exe lives on the Windows side. */
function isWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return existsSync("/proc/version") && readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

/** The platform binary commands, in preference order. */
function binaryCandidates(): { cmd: string; args: string[] }[] {
  if (process.platform === "darwin") return [{ cmd: "pbcopy", args: [] }];
  if (isWsl()) return [{ cmd: "clip.exe", args: [] }];
  if (process.platform === "linux") {
    const wayland = [{ cmd: "wl-copy", args: [] }, { cmd: "xclip", args: ["-selection", "clipboard"] }];
    const x11 = [{ cmd: "xclip", args: ["-selection", "clipboard"] }, { cmd: "wl-copy", args: [] }];
    return process.env.WAYLAND_DISPLAY ? wayland : x11;
  }
  if (process.platform === "win32") return [{ cmd: "clip", args: [] }];
  return [];
}

function onPath(cmd: string): boolean {
  if (cmd.includes("/")) return existsSync(cmd);
  return (process.env.PATH ?? "").split(":").some((dir) => dir && existsSync(`${dir}/${cmd}`));
}

/** First binary backend present on this system, or null. */
function detectBinary(): ClipboardBackend | null {
  for (const candidate of binaryCandidates()) {
    if (onPath(candidate.cmd)) {
      return {
        kind: "binary",
        write: (text) =>
          new Promise((resolve, reject) => {
            const child = execFile(candidate.cmd, candidate.args, (error) => (error ? reject(error) : resolve()));
            child.stdin?.end(text);
          }),
      };
    }
  }
  return null;
}

/** Base64-encoded OSC 52 write to stdout: the clipboard selection
 * (`c`) plus the primary selection (`p`) — terminals that ignore the
 * primary form just skip that sequence. */
export function writeOsc52(text: string): Promise<void> {
  const payload = Buffer.from(text, "utf8").toString("base64");
  return new Promise((resolve, reject) => {
    process.stdout.write(`\x1b]52;c;${payload}\x1b]52;p;${payload}\x07`, (error) => (error ? reject(error) : resolve()));
  });
}

const OSC52_BACKEND: ClipboardBackend = { kind: "osc52", write: writeOsc52 };

/** Detects and caches the backend at first use: OSC 52 first (the
 * spec's preference order — ssh-safe, dependency-free), falling back
 * to platform binaries when stdout is not a terminal (piped/embedded
 * runs, where the escape sequence has no reader) or the OSC 52 write
 * itself fails. Injectable backend overrides the cache (tests,
 * embedders). */
export function clipboardBackend(override?: ClipboardBackend | null): ClipboardBackend {
  if (override !== undefined) {
    cached = override;
    return override ?? OSC52_BACKEND;
  }
  cached ??= process.stdout.isTTY ? OSC52_BACKEND : detectBinary() ?? OSC52_BACKEND;
  return cached;
}

/** Convenience: copies the text and returns the backend kind used. */
export async function copyToClipboard(text: string): Promise<ClipboardBackend> {
  const backend = clipboardBackend();
  await backend.write(text);
  return backend;
}
