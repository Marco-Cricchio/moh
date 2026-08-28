/**
 * Per-user TUI settings, persisted as JSON at `~/.moh/config` (issue #33).
 * Sessions are project data and never live here; this file is user chrome:
 * mode, theme, icons, preview, language, telemetry, default permission
 * mode, and the onboarding-completed flag. The file itself is owned by the
 * core guardian (ADR-0006): every read/write goes through it, so unknown
 * sections (`mcpServers`, future ones) survive TUI writes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { clampHomeListMax, HOME_LIST_DEFAULT } from "./viewport";
import { readUserConfigFile, updateUserConfigFile, userConfigFile as coreUserConfigFile } from "@moh/core";
import { DEFAULT_THEME, THEMES, type ThemeName } from "./themes";

export type VibeMode = "vibe" | "dev";
export type FilePreview = "always" | "on-demand" | "none";
export type AnswerLanguage = "auto" | "en" | "it";
export type DefaultPermissionMode = "normal" | "auto-accept";

/** Workflow mode settings (#36): off by default — base behavior untouched. */
export interface WorkflowSettings {
  enabled: boolean;
  /** Opt-out of the background first-party skill update check. */
  upstreamCheck: boolean;
}

export const DEFAULT_WORKFLOW: WorkflowSettings = { enabled: false, upstreamCheck: true };

/** Opt out of the update check (ADR-0014): on by default, independent of workflow mode. */
export const DEFAULT_UPDATE_CHECK = true;

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
  /** $EDITOR override for the permission "edit" action. */
  editor?: string;
  /** Rows of the home recent-sessions list shown at once (3…10). */
  homeListMax: number;
  workflow: WorkflowSettings;
  /** The first-run workflow offer was already shown (skip on later runs). */
  workflowOffered: boolean;
  /** #242: render provider reasoning blocks in the transcript. Display is
   * pure projection — the persisted log is never affected. */
  showReasoning: boolean;
  /** #242: the one-shot persistence notice was already shown. */
  reasoningNoticeShown: boolean;
  /** Opt out of the background update check (#273 / ADR-0014). Default on. */
  updateCheck: boolean;
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
  homeListMax: HOME_LIST_DEFAULT,
  workflow: { ...DEFAULT_WORKFLOW },
  workflowOffered: false,
  showReasoning: false,
  reasoningNoticeShown: false,
  updateCheck: DEFAULT_UPDATE_CHECK,
};

/** `~/.moh/config` — the core guardian's path constant (re-exported). */
export const userConfigFile = coreUserConfigFile;

function coerce(raw: unknown): Partial<UserConfig> {
  if (typeof raw !== "object" || raw === null) return {};
  const src = raw as Record<string, unknown>;
  const out: Partial<UserConfig> = {};
  if (typeof src.onboarded === "boolean") out.onboarded = src.onboarded;
  if (src.mode === "vibe" || src.mode === "dev") out.mode = src.mode;
  if (typeof src.theme === "string") {
    // Migrate names removed from the curated catalog (#183).
    const migrated: Record<string, ThemeName> = {
      gruvbox: "gruvbox-material",
      nord: "tokyo-night",
      dracula: "neon-noir",
      solarized: "tokyo-night",
      c64: "phosphor",
      amiga: "phosphor",
      win95: "tokyo-night",
      dos: "phosphor",
      "mac-platinum": "catppuccin",
    };
    const candidate = migrated[src.theme] ?? src.theme;
    if (candidate in THEMES) out.theme = candidate as ThemeName;
  }
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
  out.homeListMax = clampHomeListMax(src.homeListMax);
  if (typeof src.workflowOffered === "boolean") out.workflowOffered = src.workflowOffered;
  if (typeof src.showReasoning === "boolean") out.showReasoning = src.showReasoning;
  if (typeof src.reasoningNoticeShown === "boolean") out.reasoningNoticeShown = src.reasoningNoticeShown;
  if (typeof src.updateCheck === "boolean") out.updateCheck = src.updateCheck;
  if (typeof src.workflow === "object" && src.workflow !== null) {
    const w = src.workflow as Record<string, unknown>;
    out.workflow = {
      enabled: w.enabled === true,
      upstreamCheck: w.upstreamCheck === undefined ? true : w.upstreamCheck !== false,
    };
  }
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
  return { ...DEFAULT_USER_CONFIG, ...coerce(readUserConfigFile(file, read)) };
}

/**
 * Writes the chrome fields back through the guardian (read-modify-write):
 * unrelated keys and unknown sections in the file are preserved.
 */
export function saveUserConfig(
  config: UserConfig,
  file: string = userConfigFile(),
  write: (file: string, data: string) => void = (f, d) => writeFileSync(f, d),
): void {
  updateUserConfigFile(
    file,
    (data) => {
      for (const key of Object.keys(config) as (keyof UserConfig)[]) data[key] = config[key];
    },
    { write },
  );
}

/** Immutable field update helper. */
export function withSetting<K extends keyof UserConfig>(config: UserConfig, key: K, value: UserConfig[K]): UserConfig {
  return { ...config, [key]: value };
}
