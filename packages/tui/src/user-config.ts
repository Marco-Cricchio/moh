/**
 * Per-user TUI settings, persisted as JSON at `~/.moh/config` (issue #33).
 * Sessions are project data and never live here; this file is user chrome:
 * mode, theme, icons, preview, language, telemetry, default permission
 * mode, and the onboarding-completed flag.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_THEME, type ThemeName } from "./themes";

export type VibeMode = "vibe" | "dev";
export type FilePreview = "always" | "on-demand" | "none";
export type AnswerLanguage = "auto" | "en" | "it";
export type DefaultPermissionMode = "normal" | "auto-accept";

export interface UserConfig {
  /** First-run onboarding completed (skip or connect both count). */
  onboarded: boolean;
  mode: VibeMode;
  theme: ThemeName;
  icons: boolean;
  /** Contextual tool-call viewer policy (style guide §1 Q7). */
  filePreview: FilePreview;
  answerLanguage: AnswerLanguage;
  /** Opt-in only; never asked interactively outside the settings panel. */
  telemetry: boolean;
  /** Permission mode for new sessions; bypass stays CLI-flag-only. */
  permissionMode: DefaultPermissionMode;
  /** $EDITOR override for ctrl+e and permission "edit". */
  editor?: string;
}

export const DEFAULT_USER_CONFIG: UserConfig = {
  onboarded: false,
  mode: "vibe",
  theme: DEFAULT_THEME,
  icons: true,
  filePreview: "on-demand",
  answerLanguage: "auto",
  telemetry: false,
  permissionMode: "normal",
};

/** `~/.moh/config` (or `<home>/.moh/config` when home is injected). */
export function userConfigFile(home?: string): string {
  return join(home ?? homedir(), ".moh", "config");
}

function coerce(raw: unknown): Partial<UserConfig> {
  if (typeof raw !== "object" || raw === null) return {};
  const src = raw as Record<string, unknown>;
  const out: Partial<UserConfig> = {};
  if (typeof src.onboarded === "boolean") out.onboarded = src.onboarded;
  if (src.mode === "vibe" || src.mode === "dev") out.mode = src.mode;
  if (typeof src.theme === "string") out.theme = src.theme as ThemeName;
  if (typeof src.icons === "boolean") out.icons = src.icons;
  if (src.filePreview === "always" || src.filePreview === "on-demand" || src.filePreview === "none") {
    out.filePreview = src.filePreview;
  }
  if (src.answerLanguage === "auto" || src.answerLanguage === "en" || src.answerLanguage === "it") {
    out.answerLanguage = src.answerLanguage;
  }
  if (typeof src.telemetry === "boolean") out.telemetry = src.telemetry;
  if (src.permissionMode === "normal" || src.permissionMode === "auto-accept") {
    out.permissionMode = src.permissionMode;
  }
  if (typeof src.editor === "string" && src.editor.trim() !== "") out.editor = src.editor.trim();
  return out;
}

/**
 * Reads `~/.moh/config`. Missing, empty or partially invalid files fall
 * back to defaults field-by-field — user chrome never hard-fails.
 */
export function loadUserConfig(
  file: string = userConfigFile(),
  read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): UserConfig {
  let raw: string;
  try {
    raw = read(file);
  } catch {
    return { ...DEFAULT_USER_CONFIG };
  }
  if (!raw.trim()) return { ...DEFAULT_USER_CONFIG };
  try {
    return { ...DEFAULT_USER_CONFIG, ...coerce(JSON.parse(raw)) };
  } catch {
    return { ...DEFAULT_USER_CONFIG };
  }
}

/** Pretty-prints and writes the config back. */
export function saveUserConfig(
  config: UserConfig,
  file: string = userConfigFile(),
  write: (file: string, data: string) => void = (f, d) => writeFileSync(f, d),
): void {
  mkdirSync(dirname(file), { recursive: true });
  write(file, `${JSON.stringify(config, null, 2)}\n`);
}

/** Immutable field update helper. */
export function withSetting<K extends keyof UserConfig>(config: UserConfig, key: K, value: UserConfig[K]): UserConfig {
  return { ...config, [key]: value };
}
