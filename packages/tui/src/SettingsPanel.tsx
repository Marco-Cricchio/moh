import React, { useMemo, useRef, useState } from "react";
import { Text, useInput } from "ink";
import { join } from "node:path";
import { endpointModelCatalog, loadMohConfig, loadMergedConfig, listOpenAiCompatModels, MAX_ITERATIONS_UNLIMITED, readUserProviderConfig, removeUserEndpoint, renderTosCard, saveUserProviderRef, tosCardFor, writeMohConfig, userConfigFile, DEFAULT_MAX_ITERATIONS, type MohConfig } from "@moh/core";
import { setIcons } from "./icons";
import { THEME_ORDER, THEMES, type ThemeName } from "./themes";
import type { AnswerLanguage, DefaultPermissionMode, FilePreview, UserConfig, VibeMode } from "./user-config";
import { useTheme } from "./themes";
import { Dialog, Dim, truncate } from "./ui";
import { dialogWidth, homeListCycleValues, useViewport, windowing } from "./viewport";
import { fetchedToCatalog, filterCatalog, freeTextRow, modelRow } from "./model-picker";

/**
 * Settings overlay (issue #33 / style guide §10 Q15): mode, theme, icons,
 * file preview, provider-reasoning display, answer language, telemetry,
 * default permission mode — plus in-panel provider management (switch / add / remove endpoints in
 * moh.json). Changes persist to `~/.moh/config` immediately.
 */
export interface SettingsPanelProps {
  cwd: string;
  /** User home override for merged provider config/tests. */
  home?: string;
  config: UserConfig;
  /** Persisted field update (App owns the config file). */
  onChange: (patch: Partial<UserConfig>) => void;
  modelLabel: string;
  /** Provider reference switched in-panel (updates the live label). */
  onProviderSwitch: (ref: string) => void;
  /** Opens the add-provider wizard overlay. */
  onStartWizard: () => void;
  /** Opens the per-project session-handoff transport chooser. */
  onConfigureHandoff?: () => void;
  onToast: (text: string) => void;
  onClose: () => void;
}

interface Row {
  key: string;
  label: string;
  value: string;
}

/** #498: the preset cycle for the max-iterations row. "unlimited" is the
 * 0 sentinel; presets are a UI concern — moh.json accepts any integer. */
const MAX_ITERATION_PRESETS = [50, 100, 200, 500, MAX_ITERATIONS_UNLIMITED] as const;

const maxIterationsLabel = (v: number) => (v === MAX_ITERATIONS_UNLIMITED ? "unlimited" : String(v));

/** #444: render a provider's bundled ToS card for the endpoint section.
 * Unknown/custom providers get a one-line "no bundled card" note. */
function renderTosCardText(provider: string, width: number): string[] {
  const card = tosCardFor(provider);
  if (!card) return [`(no bundled ToS summary for "${provider}")`];
  return renderTosCard(card).split("\n").map((l) => truncate(l, width));
}

export function SettingsPanel({ cwd, home, config, onChange, modelLabel, onProviderSwitch, onStartWizard, onConfigureHandoff, onToast, onClose }: SettingsPanelProps) {
  const theme = useTheme();
  const viewport = useViewport();
  const configFile = useMemo(() => join(cwd, "moh.json"), [cwd]);
  const userFile = useMemo(() => userConfigFile(home), [home]);
  const [moh, setMoh] = useState<MohConfig>(() => {
    // #129 merged view (project + user endpoints): the switch list must
    // show user-level endpoints too. Invalid provider config stays loud;
    // the guardian's strict-when-present contract must not be masked by
    // falling back to a partial project-only view.
    return loadMergedConfig(cwd, { home });
  });
  const [cursor, setCursor] = useState(0);
  const handoffTransport = loadMohConfig(configFile).handoff?.transport;
  // #181 hierarchical provider picker: endpoint → its catalog models
  // (free-text fallback for unknown types). Selecting a model rewrites
  // `defaultModel` on the project moh.json endpoint (user-level endpoints
  // are display-only here) and switches the default `provider` ref.
  type Sub =
    | { kind: "endpoint"; cursor: number }
    | { kind: "model"; name: string; type: string; baseUrl?: string; current?: string; userOwned: boolean; cursor: number; query: string }
    | { kind: "model-free"; name: string; userOwned: boolean; value: string }
    | { kind: "remove"; options: string[]; cursor: number }
    | { kind: "tos"; provider: string };
  const [sub, setSub] = useState<Sub | null>(null);
  // #498 max-iterations warning: shown when "unlimited" is selected in the
  // row; any later keypress dismisses it, and it stays dismissed while the
  // value remains unlimited — it reappears only if the value moves away
  // and back to unlimited.
  const [unlimitedWarning, setUnlimitedWarning] = useState(false);
  const unlimitedDismissedRef = useRef(false);
  // Live-fetched model lists for openai-compat endpoints (#181 follow-up):
  // `GET <baseUrl>/models`, shown in the model level like a vendored
  // catalog. Failure = free-text entry only, as before.
  const [remote, setRemote] = useState<Record<string, string[] | "error" | "loading">>({});

  const fetchRemoteModels = (endpoint: { name: string; baseUrl?: string; apiKey?: string }) => {
    if (!endpoint.baseUrl || remote[endpoint.name]) return;
    setRemote((r) => ({ ...r, [endpoint.name]: "loading" }));
    listOpenAiCompatModels(endpoint.baseUrl, endpoint.apiKey)
      .then((ids) => setRemote((r) => ({ ...r, [endpoint.name]: ids })))
      .catch(() => setRemote((r) => ({ ...r, [endpoint.name]: "error" })));
  };

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
      { key: "handoff", label: "Session handoff", value: handoffTransport === "gist" ? "GitHub Gist" : handoffTransport === "none" ? "Disabled" : "Not Set" },
      { key: "maxIterations", label: "Max iterations/turn", value: maxIterationsLabel(moh.maxIterations ?? DEFAULT_MAX_ITERATIONS) },
      { key: "homeListMax", label: "Home list rows", value: String(config.homeListMax) },
      { key: "showReasoning", label: "Provider reasoning", value: config.showReasoning ? "show" : "hide" },
      { key: "updateCheck", label: "Update check", value: config.updateCheck ? "on" : "off" },
    ],
    [config, modelLabel, moh, handoffTransport],
  );

  // Endpoints defined in the project moh.json (editable defaultModel);
  // user-level merged endpoints are display-only (#181, #129).
  const projectNames = useMemo(
    () => new Set((loadMohConfig(configFile).endpoints ?? []).map((e) => e.name)),
    [configFile, moh],
  );

  // Keep the dialog inside the terminal: title, spacing, footer and borders
  // consume roughly eight rows, leaving the settings list a scroll window
  // that follows the cursor (#64).
  const win = windowing(rows.length, cursor, Math.max(3, viewport.rows - 8));
  const visibleRows = rows.slice(win.start, win.start + win.count);
  // Rows never overflow the dialog interior (border 2 + paddingX 4).
  const innerWidth = dialogWidth(viewport) - 6;
  // Sub-menu rows for the current level (endpoint list / model list).
  const subOptions = useMemo((): string[] => {
    if (!sub) return [];
    if (sub.kind === "endpoint")
      return ["mock", ...(moh.endpoints ?? []).map((e) => (projectNames.has(e.name) ? e.name : `${e.name} (user)`))];
    if (sub.kind === "model") {
      // Vendored catalog when one exists; otherwise the fetched list.
      const vendored = endpointModelCatalog(sub.type, sub.baseUrl);
      const list = vendored.length > 0 ? vendored : Array.isArray(remote[sub.name]) ? fetchedToCatalog(remote[sub.name] as string[]) : [];
      const rows = filterCatalog(list, sub.query).map((m) => modelRow(m, m.id === sub.current));
      rows.push(sub.query.trim() ? freeTextRow(sub.query) : "+ other… (type a model id)");
      return rows;
    }
    if (sub.kind === "model-free") return [];
    if (sub.kind === "remove") return sub.options;
    return (moh.endpoints ?? []).map((e) => e.name);
  }, [sub, moh, projectNames, remote]);

  const subCursor = sub && (sub.kind === "endpoint" || sub.kind === "remove" || sub.kind === "model") ? sub.cursor : 0;
  const subWin = windowing(
    subOptions.length,
    subCursor,
    Math.max(3, viewport.rows - 8 - win.count),
  );

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
      case "showReasoning":
        return onChange({ showReasoning: !config.showReasoning });
      case "filePreview":
        return onChange({ filePreview: cycle<FilePreview>(["on-demand", "always", "none"], config.filePreview) });
      case "answerLanguage":
        return onChange({ answerLanguage: cycle<AnswerLanguage>(["auto", "en", "it"], config.answerLanguage) });
      case "telemetry":
        return onChange({ telemetry: !config.telemetry });
      case "updateCheck":
        return onChange({ updateCheck: !config.updateCheck });
      case "permissionMode":
        return onChange({
          permissionMode: cycle<DefaultPermissionMode>(["normal", "auto-accept"], config.permissionMode),
        });
      case "homeListMax": {
        const next = cycle(homeListCycleValues(), config.homeListMax);
        onChange({ homeListMax: next });
        return onToast(`home list rows: ${next}`);
      }
      case "provider":
        return setSub({ kind: "endpoint", cursor: 0 });
      case "provider-add":
        return onStartWizard();
      case "provider-remove":
        if ((moh.endpoints ?? []).length === 0) return onToast("no endpoints to remove");
        return setSub({ kind: "remove", options: (moh.endpoints ?? []).map((e) => e.name), cursor: 0 });
      case "handoff":
        return onConfigureHandoff?.();
      case "maxIterations": {
        // #498: → (enter) cycles forward, shift+tab cycles backward.
        const current = moh.maxIterations ?? DEFAULT_MAX_ITERATIONS;
        const index = MAX_ITERATION_PRESETS.indexOf(current as (typeof MAX_ITERATION_PRESETS)[number]);
        const at = index === -1 ? 0 : index;
        return setMaxIterations(MAX_ITERATION_PRESETS[(at + 1) % MAX_ITERATION_PRESETS.length]!);
      }
    }
  };

  /** #498: persist the preset to project moh.json; selecting unlimited
   * shows the one-time inline warning (re-armed only when the value moves
   * away and back). */
  const setMaxIterations = (next: number) => {
    const project = loadMohConfig(configFile);
    writeMohConfig(configFile, { ...project, maxIterations: next });
    setMoh((m) => ({ ...m, maxIterations: next }));
    if (next === MAX_ITERATIONS_UNLIMITED) {
      if (!unlimitedDismissedRef.current) setUnlimitedWarning(true);
    } else {
      unlimitedDismissedRef.current = false;
      setUnlimitedWarning(false);
    }
    onToast(`max iterations: ${maxIterationsLabel(next)} (new sessions)`);
  };

  const cycleMaxIterationsBackward = () => {
    const current = moh.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const index = MAX_ITERATION_PRESETS.indexOf(current as (typeof MAX_ITERATION_PRESETS)[number]);
    const at = index === -1 ? 0 : index;
    setMaxIterations(MAX_ITERATION_PRESETS[(at + MAX_ITERATION_PRESETS.length - 1) % MAX_ITERATION_PRESETS.length]!);
  };

  /** #181: model committed for one endpoint — rewrites `defaultModel` in
   * the project moh.json (user endpoints display-only) and switches the
   * default `provider` ref. moh.json only; user config untouched. */
  const commitModel = (name: string, modelId: string, userOwned: boolean) => {
    const project = loadMohConfig(configFile);
    const ref = `${name}/${modelId}`;
    if (!userOwned) {
      writeMohConfig(configFile, {
        ...project,
        endpoints: (project.endpoints ?? []).map((e) => (e.name === name ? { ...e, defaultModel: modelId } : e)),
        provider: ref,
      });
      setMoh({
        ...moh,
        endpoints: (moh.endpoints ?? []).map((e) => (e.name === name ? { ...e, defaultModel: modelId } : e)),
        provider: ref,
      });
    } else {
      writeMohConfig(configFile, { ...project, provider: ref });
      setMoh({ ...moh, provider: ref });
    }
    onProviderSwitch(ref);
    onToast(`provider: ${ref} (new sessions)${userOwned ? " · user endpoint, default not editable here" : " · default saved in moh.json"}`);
  };

  useInput((input, key) => {
    if (key.escape) {
      if (sub && sub.kind !== "tos") {
        if (sub.kind === "model") return setSub({ kind: "endpoint", cursor: 0 });
        if (sub.kind === "model-free") return setSub({ kind: "endpoint", cursor: 0 });
        return setSub(null);
      }
      if (sub?.kind === "tos") return setSub({ kind: "endpoint", cursor: 0 });
      return onClose();
    }
    if (sub?.kind === "model-free") {
      if (key.backspace || key.delete) return setSub({ ...sub, value: sub.value.slice(0, -1) });
      if ((key.return || input === "\n") && sub.value.trim()) {
        commitModel(sub.name, sub.value.trim(), sub.userOwned);
        return setSub(null);
      }
      if (input && !key.ctrl && !key.meta) return setSub({ ...sub, value: sub.value + input });
      return;
    }
    if (sub) {
      // #444: `t` on the endpoint level opens the provider's ToS card.
      if (sub.kind === "endpoint" && input === "t") {
        const option = subOptions[sub.cursor];
        if (!option) return;
        if (option === "mock") return onToast('no bundled ToS summary for "mock"');
        const name = option.replace(/ \(user\)$/, "");
        const endpoint = (moh.endpoints ?? []).find((e) => e.name === name);
        if (!endpoint) return;
        return setSub({ kind: "tos", provider: endpoint.type });
      }
      if (key.upArrow) {
        if (sub.kind === "endpoint" || sub.kind === "remove") return setSub({ ...sub, cursor: Math.max(0, sub.cursor - 1) });
        if (sub.kind === "tos") return;
        return setSub({ ...sub, cursor: Math.max(0, sub.cursor - 1) });
      }
      if (key.downArrow) {
        if (sub.kind === "endpoint" || sub.kind === "remove") return setSub({ ...sub, cursor: Math.min(subOptions.length - 1, sub.cursor + 1) });
        if (sub.kind === "tos") return;
        return setSub({ ...sub, cursor: Math.min(subOptions.length - 1, sub.cursor + 1) });
      }
      // Typing inside the model level filters incrementally (#181).
      if (sub.kind === "model" && input && !key.ctrl && !key.meta && !key.return && input !== "\n") {
        return setSub({ ...sub, query: sub.query + input, cursor: 0 });
      }
      if (sub.kind === "model" && (key.backspace || key.delete)) {
        return setSub({ ...sub, query: sub.query.slice(0, -1), cursor: 0 });
      }
      if (key.return || input === "\n") {
        const index = sub.kind === "endpoint" || sub.kind === "remove" || sub.kind === "model" ? sub.cursor : 0;
        const option = subOptions[index];
        if (option === undefined) return;
        if (sub.kind === "endpoint") {
          if (option === "mock") {
            const project = loadMohConfig(configFile);
            writeMohConfig(configFile, { ...project, provider: "mock" });
            setMoh({ ...moh, provider: "mock" });
            onProviderSwitch("mock");
            onToast("provider: mock (new sessions)");
            return setSub(null);
          }
          const name = option.replace(/ \(user\)$/, "");
          const endpoint = (moh.endpoints ?? []).find((e) => e.name === name);
          if (!endpoint) return;
          const userOwned = !projectNames.has(name);
          const catalog = endpointModelCatalog(endpoint.type, endpoint.baseUrl);
          if (catalog.length === 0 && !endpoint.baseUrl) {
            // Unknown types without a base URL (custom): free text only,
            // as in the wizard (acceptance).
            return setSub({ kind: "model-free", name, userOwned, value: endpoint.defaultModel ?? "" });
          }
          if (catalog.length === 0) fetchRemoteModels(endpoint);
          return setSub({ kind: "model", name, type: endpoint.type, baseUrl: endpoint.baseUrl, current: endpoint.defaultModel, userOwned, cursor: 0, query: "" });
        }
        if (sub.kind === "model") {
          const vendored = endpointModelCatalog(sub.type, sub.baseUrl);
          const list = vendored.length > 0 ? vendored : Array.isArray(remote[sub.name]) ? fetchedToCatalog(remote[sub.name] as string[]) : [];
          const catalog = filterCatalog(list, sub.query);
          if (index < catalog.length) {
            commitModel(sub.name, catalog[index]!.id, sub.userOwned);
            return setSub(null);
          }
          // Free-text row (last): catalog rows + 1.
          if (index === catalog.length) {
            const typed = sub.query.trim();
            if (typed) {
              commitModel(sub.name, typed, sub.userOwned);
              return setSub(null);
            }
            return setSub({ kind: "model-free", name: sub.name, userOwned: sub.userOwned, value: "" });
          }
          return;
        }
        // remove
        {
          const optionName = option;
          const project = loadMohConfig(configFile);
          const inProject = (project.endpoints ?? []).some((e) => e.name === optionName);
          const inUser = (readUserProviderConfig(userFile).endpoints ?? []).some((e) => e.name === optionName);
          const remaining = (moh.endpoints ?? []).filter((e) => e.name !== optionName);
          const refDangling = moh.provider && moh.provider !== "mock" &&
            (moh.provider === optionName || moh.provider.startsWith(`${optionName}/`));
          const fallback = remaining[0];
          const nextRef = refDangling
            ? (fallback?.defaultModel ? `${fallback.name}/${fallback.defaultModel}` : fallback?.name) ?? "mock"
            : moh.provider;
          if (inProject) {
            writeMohConfig(configFile, {
              ...project,
              endpoints: (project.endpoints ?? []).filter((e) => e.name !== optionName),
              ...((project.provider === optionName || project.provider?.startsWith(`${optionName}/`)) && nextRef ? { provider: nextRef } : {}),
            });
          }
          if (inUser) {
            removeUserEndpoint(userFile, optionName);
            if (refDangling && nextRef) saveUserProviderRef(userFile, nextRef);
          }
          setMoh({ ...moh, endpoints: remaining, ...(refDangling && nextRef ? { provider: nextRef } : {}) });
          onToast(`removed endpoint ${optionName}`);
        }
        return setSub(null);
      }
      return;
    }
    // #498: any keypress dismisses the unlimited warning (before any
    // early-returning navigation handler).
    if (unlimitedWarning) {
      unlimitedDismissedRef.current = true;
      setUnlimitedWarning(false);
    }
    if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) return setCursor((c) => Math.min(rows.length - 1, c + 1));
    // #498: → on the max-iterations row cycles presets forward.
    if (key.rightArrow) {
      if (rows[cursor]?.key === "maxIterations") return activate(rows[cursor]!);
      return;
    }
    // #498: shift+tab on the max-iterations row cycles presets backward.
    if (key.tab && key.shift) {
      if (rows[cursor]?.key === "maxIterations") return cycleMaxIterationsBackward();
      return;
    }
    if (key.return || input === "\n") return activate(rows[cursor]!);
  });

  return (
    <Dialog title=" settings " color={theme.ok}>
      {win.above > 0 && <Dim>{` ↑ ${win.above} more`}</Dim>}
      {visibleRows.map((row, i) => {
        const index = win.start + i;
        const selected = index === cursor;
        const line = ` ${selected ? "›" : " "} ${row.label.padEnd(26)}${row.value}${selected ? " " : ""}`;
        return (
          <Text key={row.key} color={selected ? theme.bg : undefined} backgroundColor={selected ? theme.accent : undefined}>
            {truncate(line, innerWidth)}
          </Text>
        );
      })}
      {win.below > 0 && <Dim>{` ↓ ${win.below} more`}</Dim>}
      <Text> </Text>
      {unlimitedWarning && (
        <>
          <Text color={theme.warn}>
            {truncate(" warning: running without a cap removes the anti-runaway", innerWidth)}
          </Text>
          <Text color={theme.warn}>
            {truncate(" safety net; API costs can grow unbounded", innerWidth)}
          </Text>
          <Text> </Text>
        </>
      )}
      {sub ? (
        <>
          {sub.kind === "tos" ? (
            <>
              {renderTosCardText(sub.provider, innerWidth).map((line: string, idx: number) => (
                <Text key={idx}>{truncate(line, innerWidth)}</Text>
              ))}
            </>
          ) : sub.kind === "model-free" ? (
            <>
              <Text bold>{`model id: ${sub.value}▏`}</Text>
              <Text> </Text>
              <Dim>{sub.userOwned ? "user endpoint — the default is not editable here" : "saved as defaultModel in moh.json"}</Dim>
            </>
          ) : (
            <>
              {subWin.above > 0 && <Dim>{` ↑ ${subWin.above} more`}</Dim>}
              {subOptions.slice(subWin.start, subWin.start + subWin.count).map((option, i) => {
                const index = subWin.start + i;
                const selected = index === subCursor;
                return (
                  <Text key={`${index}-${option}`} color={selected ? theme.bg : undefined} backgroundColor={selected ? theme.accent : undefined}>
                    {truncate(` ${selected ? "›" : " "} ${option}${selected ? " " : ""}`, innerWidth)}
                  </Text>
                );
              })}
              {subWin.below > 0 && <Dim>{` ↓ ${subWin.below} more`}</Dim>}
              {sub.kind === "model" && endpointModelCatalog(sub.type, sub.baseUrl).length === 0 && remote[sub.name] === "loading" && (
                <Dim> fetching models…</Dim>
              )}
              {sub.kind === "model" && endpointModelCatalog(sub.type, sub.baseUrl).length === 0 && remote[sub.name] === "error" && (
                <Dim> no list from this endpoint — free text works</Dim>
              )}
            </>
          )}
          <Text> </Text>
          <Dim>
            {sub.kind === "tos"
              ? "esc back"
              : sub.kind === "endpoint"
              ? "↑↓ · enter · t ToS · esc — switch endpoint"
              : sub.kind === "model"
                ? "type to filter · enter select · esc back — set default model"
                : sub.kind === "model-free"
                  ? "type a model id · enter save · esc back"
                  : "↑↓ select · enter confirm · esc back — remove endpoint"}
          </Dim>
        </>
      ) : (
        <Dim>
          {rows[cursor]?.key === "maxIterations"
            ? "enter/→ next · shift+tab back · iterations are send→tools→reply cycles, not tool calls"
            : "enter change · esc close"}
        </Dim>
      )}
    </Dialog>
  );
}
