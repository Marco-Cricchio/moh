import React, { useMemo, useState } from "react";
import { Text, useInput, useStdout } from "ink";
import { join } from "node:path";
import { loadMohConfig, writeMohConfig, type MohConfig } from "@moh/core";
import { setIcons } from "./icons";
import { THEME_ORDER, THEMES, type ThemeName } from "./themes";
import type { AnswerLanguage, DefaultPermissionMode, FilePreview, UserConfig, VibeMode } from "./user-config";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";

/**
 * Settings overlay (issue #33 / style guide §10 Q15): mode, theme, icons,
 * file preview, answer language, telemetry, default permission mode —
 * plus in-panel provider management (switch / add / remove endpoints in
 * moh.json). Changes persist to `~/.moh/config` immediately.
 */
export interface SettingsPanelProps {
  cwd: string;
  config: UserConfig;
  /** Persisted field update (App owns the config file). */
  onChange: (patch: Partial<UserConfig>) => void;
  modelLabel: string;
  /** Provider reference switched in-panel (updates the live label). */
  onProviderSwitch: (ref: string) => void;
  /** Opens the add-provider wizard overlay. */
  onStartWizard: () => void;
  onToast: (text: string) => void;
  onClose: () => void;
}

interface Row {
  key: string;
  label: string;
  value: string;
}

export function SettingsPanel({ cwd, config, onChange, modelLabel, onProviderSwitch, onStartWizard, onToast, onClose }: SettingsPanelProps) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const configFile = useMemo(() => join(cwd, "moh.json"), [cwd]);
  const [moh, setMoh] = useState<MohConfig>(() => {
    try {
      return loadMohConfig(configFile);
    } catch {
      return {};
    }
  });
  const [cursor, setCursor] = useState(0);
  const [sub, setSub] = useState<{ kind: "switch" | "remove"; options: string[]; cursor: number } | null>(null);

  const cycle = <T,>(values: readonly T[], current: T): T => values[(values.indexOf(current) + 1) % values.length]!;

  const rows: Row[] = useMemo(
    () => [
      { key: "mode", label: "Mode", value: config.mode },
      { key: "theme", label: "Theme", value: THEMES[config.theme]?.label ?? config.theme },
      { key: "icons", label: "Icons", value: config.icons ? "on" : "off" },
      { key: "filePreview", label: "File preview", value: config.filePreview },
      { key: "answerLanguage", label: "Answer language", value: config.answerLanguage },
      { key: "telemetry", label: "Telemetry", value: config.telemetry ? "on (opt-in)" : "off" },
      { key: "permissionMode", label: "Default permission mode", value: config.permissionMode },
      { key: "provider", label: "Provider", value: modelLabel },
      { key: "provider-add", label: "Add provider", value: "" },
      { key: "provider-remove", label: "Remove provider", value: `${moh.endpoints?.length ?? 0} endpoint(s)` },
    ],
    [config, modelLabel, moh],
  );

  const persistMoh = (next: MohConfig) => {
    writeMohConfig(configFile, next);
    setMoh(next);
  };

  const endpointRefs = (moh.endpoints ?? []).map((e) => (e.defaultModel ? `${e.name}/${e.defaultModel}` : e.name));

  // Keep the dialog inside the terminal: title, spacing, footer and borders
  // consume roughly eight rows, leaving the settings list a small viewport.
  const viewportSize = Math.max(3, (stdout.rows ?? 24) - 8);
  const viewportStart = Math.min(Math.max(0, cursor - viewportSize + 1), Math.max(0, rows.length - viewportSize));
  const visibleRows = rows.slice(viewportStart, viewportStart + viewportSize);

  const activate = (row: Row) => {
    if (sub) return;
    switch (row.key) {
      case "mode":
        return onChange({ mode: cycle<VibeMode>(["vibe", "dev"], config.mode) });
      case "theme": {
        const next = cycle<ThemeName>(THEME_ORDER, config.theme);
        onChange({ theme: next });
        return onToast(`theme: ${THEMES[next].label}`);
      }
      case "icons": {
        const next = !config.icons;
        setIcons(next);
        onChange({ icons: next });
        return;
      }
      case "filePreview":
        return onChange({ filePreview: cycle<FilePreview>(["on-demand", "always", "none"], config.filePreview) });
      case "answerLanguage":
        return onChange({ answerLanguage: cycle<AnswerLanguage>(["auto", "en", "it"], config.answerLanguage) });
      case "telemetry":
        return onChange({ telemetry: !config.telemetry });
      case "permissionMode":
        return onChange({
          permissionMode: cycle<DefaultPermissionMode>(["normal", "auto-accept"], config.permissionMode),
        });
      case "provider":
        return setSub({ kind: "switch", options: ["mock", ...endpointRefs], cursor: 0 });
      case "provider-add":
        return onStartWizard();
      case "provider-remove":
        if ((moh.endpoints ?? []).length === 0) return onToast("no endpoints to remove");
        return setSub({ kind: "remove", options: (moh.endpoints ?? []).map((e) => e.name), cursor: 0 });
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      if (sub) return setSub(null);
      return onClose();
    }
    if (sub) {
      if (key.upArrow) return setSub({ ...sub, cursor: Math.max(0, sub.cursor - 1) });
      if (key.downArrow) return setSub({ ...sub, cursor: Math.min(sub.options.length - 1, sub.cursor + 1) });
      if (key.return || input === "\n") {
        const option = sub.options[sub.cursor]!;
        if (sub.kind === "switch") {
          const next = { ...moh, provider: option };
          persistMoh(next);
          onProviderSwitch(option);
          onToast(`provider: ${option} (new sessions)`);
        } else {
          const remaining = (moh.endpoints ?? []).filter((e) => e.name !== option);
          const next = { ...moh, endpoints: remaining };
          // Never leave the default provider dangling on a removed endpoint.
          if (moh.provider && moh.provider !== "mock" && moh.provider.startsWith(`${option}/`)) {
            const fallback = remaining[0];
            next.provider = fallback?.defaultModel ? `${fallback.name}/${fallback.defaultModel}` : fallback?.name;
          }
          persistMoh(next);
          onToast(`removed endpoint ${option}`);
        }
        return setSub(null);
      }
      return;
    }
    if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) return setCursor((c) => Math.min(rows.length - 1, c + 1));
    if (key.return || input === "\n") return activate(rows[cursor]!);
  });

  return (
    <Dialog title=" settings " color={theme.ok}>
      {viewportStart > 0 && <Dim>{` ↑ ${viewportStart} more`}</Dim>}
      {visibleRows.map((row, i) => {
        const index = viewportStart + i;
        const selected = index === cursor;
        return (
          <Text key={row.key} color={selected ? theme.bg : undefined} backgroundColor={selected ? theme.accent : undefined}>
            {` ${selected ? "›" : " "} ${row.label.padEnd(26)}${row.value}${selected ? " " : ""}`}
          </Text>
        );
      })}
      {viewportStart + visibleRows.length < rows.length && <Dim>{` ↓ ${rows.length - viewportStart - visibleRows.length} more`}</Dim>}
      <Text> </Text>
      {sub ? (
        <>
          {sub.options.map((option, i) => (
            <Text key={option} color={i === sub.cursor ? theme.bg : undefined} backgroundColor={i === sub.cursor ? theme.accent : undefined}>
              {` ${i === sub.cursor ? "›" : " "} ${option}${i === sub.cursor ? " " : ""}`}
            </Text>
          ))}
          <Text> </Text>
          <Dim>{`↑↓ select · enter confirm · esc back — ${sub.kind === "switch" ? "switch provider" : "remove endpoint"}`}</Dim>
        </>
      ) : (
        <Dim>enter change · esc close</Dim>
      )}
    </Dialog>
  );
}
