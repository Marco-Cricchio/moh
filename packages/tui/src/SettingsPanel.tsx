import React, { useEffect, useMemo, useRef, useState } from "react";
import { Text, useInput } from "ink";
import { join } from "node:path";
import { homedir } from "node:os";
import { endpointModelCatalog, fetchLiveCatalogs, loadMohConfig, loadMergedConfig, listOpenAiCompatModels, maskApiKey, MAX_ITERATIONS_UNLIMITED, readTypesafeConfig, readUserProviderConfig, removeTypesafeApiKey, removeUserEndpoint, renderTosCard, resolveTypesafeConfig, saveTypesafeApiKey, saveTypesafeInjection, saveTypesafeLint, saveTypesafeRerank, saveTypesafeRouting, saveTypesafeSkills, saveUserProviderRef, TYPESAFE_TIMEOUT_MS_DEFAULT, tosCardFor, writeMohConfig, userConfigFile, DEFAULT_MAX_ITERATIONS, type LiveModelListing, type MohConfig } from "@moh/core";
import { validateJevKey, type JevKeyValidation } from "@moh/jev-guard";
import { setIcons } from "./icons";
import { THEMES, THEME_ORDER } from "./themes";
import { deleteUserTheme, guessExtendsOf, listUserThemes, loadUserTheme, saveUserTheme, themeLabelFor } from "./user-themes";
import type { AnswerLanguage, DefaultPermissionMode, FilePreview, ThemeRef, UserConfig, VibeMode } from "./user-config";
import { useTheme } from "./themes";
import { ThemeStudioModal } from "./ThemeStudioModal";
import { Dialog, Dim, truncate } from "./ui";
import { dialogWidth, homeListCycleValues, useViewport, windowing } from "./viewport";
import { fetchedToCatalog, filterCatalog, freeTextRow, mergePickCatalog, modelRow } from "./model-picker";

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
  /** Reports whether the theme studio modal is open, so the App-level
   * escape handler stands down while the studio owns the keyboard. */
  onStudioActive?: (active: boolean) => void;
  /** #784: the one real validation call the Jev entry makes on key save.
   * Injectable so tests never touch the network. */
  validateKey?: (key: string) => Promise<JevKeyValidation>;
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

/** MPM per-project setting display (ADR-0026). */
const mpmSettingLabel = (s: "inherit" | "on" | "off") =>
  s === "inherit" ? "inherit (global default)" : s === "on" ? "on (this project)" : "off (this project)";

/** #444: render a provider's bundled ToS card for the endpoint section.
 * Unknown/custom providers get a one-line "no bundled card" note. */
function renderTosCardText(provider: string, width: number): string[] {
  const card = tosCardFor(provider);
  if (!card) return [`(no bundled ToS summary for "${provider}")`];
  return renderTosCard(card).split("\n").map((l) => truncate(l, width));
}

/** All selectable theme refs in cycle order: built-ins, then user themes. */
function allThemeRefs(home?: string): ThemeRef[] {
  return [...THEME_ORDER, ...listUserThemes(home ?? homedir()).map((t) => `user:${t.id}` as ThemeRef)];
}

/** Lowercase slug normalization for editor ids. */
const slugify = (v: string): string => v.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");

/** #784: the Jev entry's view of the user config (never a live probe). */
interface JevState {
  active: boolean;
  keyHint?: string;
  timeoutMs: number;
  /** #787: the model-routing opt-in (off by default). */
  routing: boolean;
  /** #791: the anti-injection opt-in (off by default). */
  injection: boolean;
  /** #789: the quality-gate opt-in (off by default). */
  lint: boolean;
  /** #790: the MPM seed-rerank opt-in (off by default). */
  rerank: boolean;
  /** #793: the skill-suggestion opt-in (off by default). */
  skills: boolean;
  /** The `typesafe` section is malformed: loud on the next save, still
   * rendered as inactive rather than crashing the whole panel. */
  broken?: boolean;
}

/** #784: the ratified disclosure line, shown under the Jev entry. */
const JEV_DISCLOSURE =
  "judgments send the command, working directory and git branch/state to TypeSafe (US). TypeSafe declares no training on inputs.";

/**
 * #787/#791: the Jev entry's sub-menu — the key, the two per-use-case
 * opt-ins (both off by default), status, remove.
 */
const JEV_OPTIONS = ["API key", "Model routing", "Anti-injection", "Quality gate", "Seed rerank", "Skill suggestion", "Status", "Remove"] as const;

/** #791: what the anti-injection opt-in sends, stated where it is toggled. */
const JEV_INJECTION_DISCLOSURE =
  "anti-injection sends your message text (up to 4 KiB) and the text of every web result (up to 8 KiB) to TypeSafe.";

/** #789: what the quality-gate opt-in sends, stated where it is toggled. */
const JEV_LINT_DISCLOSURE =
  "the quality gate sends the diff of the changed code (up to 32 KiB) plus the project's convention docs to TypeSafe.";

/** #790: what the seed-rerank opt-in sends, stated where it is toggled. */
const JEV_RERANK_DISCLOSURE =
  "seed rerank sends the task text plus the over-threshold candidate paths, their top symbols and provenance to TypeSafe (only when the orientation plan would otherwise be discarded).";

/** #793: what the skill-suggestion opt-in sends, stated where it is toggled. */
const JEV_SKILLS_DISCLOSURE =
  "skill suggestion sends your message (up to 4 KiB) plus the skill names and descriptions to TypeSafe, twice per turn while it runs.";

export function SettingsPanel({ cwd, home, config, onChange, modelLabel, onProviderSwitch, onStartWizard, onConfigureHandoff, onToast, onStudioActive, validateKey, onClose }: SettingsPanelProps) {
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
  // MPM per-project setting (ADR-0026): inherit / on / off. Reads the
  // project moh.json's explicit `enabled` (absent = inherit); writing
  // goes through writeMohConfig so the rest of the file is preserved.
  type MpmSetting = "inherit" | "on" | "off";
  const readMpmSetting = (): MpmSetting => {
    try {
      const enabled = loadMohConfig(configFile).mpm?.enabled;
      return enabled === true ? "on" : enabled === false ? "off" : "inherit";
    } catch {
      return "inherit";
    }
  };
  const [mpmSetting, setMpmSetting] = useState<MpmSetting>(readMpmSetting);
  const cycleMpmSetting = () => {
    const next: MpmSetting = mpmSetting === "inherit" ? "on" : mpmSetting === "on" ? "off" : "inherit";
    try {
      const project = loadMohConfig(configFile);
      if (next === "inherit") {
        const { mpm: _dropped, ...rest } = project;
        writeMohConfig(configFile, rest);
      } else {
        writeMohConfig(configFile, { ...project, mpm: { ...project.mpm, enabled: next === "on" } });
      }
      setMpmSetting(next);
      setMoh((m) => (next === "inherit" ? { ...m, mpm: undefined } : { ...m, mpm: { ...m.mpm, enabled: next === "on" } }));
      onToast(`moh project map: ${mpmSettingLabel(next)} (new sessions)`);
    } catch (e) {
      onToast(`moh project map: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  // #181 hierarchical provider picker: endpoint → its catalog models
  // (free-text fallback for unknown types). Selecting a model rewrites
  // `defaultModel` on the project moh.json endpoint (user-level endpoints
  // are display-only here) and switches the default `provider` ref.
  // #784: the Jev (TypeSafe) entry — key input, status, remove, disclosure.
  const jevFile = userFile;
  const readJev = (): JevState => {
    try {
      const resolved = resolveTypesafeConfig(readTypesafeConfig(jevFile));
      return {
        active: resolved.active,
        ...(resolved.apiKey ? { keyHint: maskApiKey(resolved.apiKey) } : {}),
        timeoutMs: resolved.timeoutMs,
        routing: resolved.routing,
        injection: resolved.injection,
        lint: resolved.lint,
        rerank: resolved.rerank,
        skills: resolved.skills,
      };
    } catch {
      return { active: false, timeoutMs: TYPESAFE_TIMEOUT_MS_DEFAULT, routing: false, injection: false, lint: false, rerank: false, skills: false, broken: true };
    }
  };
  const [jev, setJev] = useState<JevState>(readJev);
  const jevLabel = jev.broken
    ? "invalid config section"
    : jev.active
      ? `active (key ${jev.keyHint ?? "…"}, timeout ${jev.timeoutMs}ms)`
      : "inactive";
  const validate = validateKey ?? ((key: string) => validateJevKey(key, { timeoutMs: jev.timeoutMs }));
  type Sub =
    | { kind: "endpoint"; cursor: number }
    | { kind: "jev"; cursor: number }
    | { kind: "jev-key"; value: string; busy: boolean; message?: string }
    | { kind: "model"; name: string; type: string; baseUrl?: string; current?: string; userOwned: boolean; cursor: number; query: string }
    | { kind: "model-free"; name: string; userOwned: boolean; value: string }
    | { kind: "remove"; options: string[]; cursor: number }
    | { kind: "tos"; provider: string }
    | { kind: "theme-pick"; options: ThemeRef[]; cursor: number }
    const [sub, setSub] = useState<Sub | null>(null);
  // "My themes…" opens the theme studio modal (variant-D redesign): a full
  // screen visual editor — global sliders + per-element picks + live previews.
  // Kept outside `sub` because it owns its own key handling end to end.
  const [studio, setStudio] = useState<{ base: string } | null>(null);
  useEffect(() => {
    onStudioActive?.(studio !== null);
  }, [studio]);
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

  // #551: the same live overlay /model uses, for catalog-backed
  // endpoints. Fetched once per panel mount (cache-backed, never
  // blocking); vendored entries still win on collision.
  const [liveCatalog, setLiveCatalog] = useState<Record<string, LiveModelListing[]>>({});
  useEffect(() => {
    let live = true;
    const endpoints = [...(moh.endpoints ?? [])].map((e) => ({ name: e.name, type: e.type, baseUrl: e.baseUrl, apiKey: e.apiKey }));
    if (endpoints.length > 0) {
      fetchLiveCatalogs(endpoints)
        .then((result) => {
          if (live && Object.keys(result).length > 0) setLiveCatalog((prev) => ({ ...prev, ...result }));
        })
        .catch(() => {
          // Silent degradation is the #551 contract.
        });
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The model list for one endpoint: vendored catalog + live overlay. */
  const modelListFor = (type: string, baseUrl: string | undefined, name: string) =>
    mergePickCatalog(endpointModelCatalog(type, baseUrl), liveCatalog[name] ?? []);

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
      { key: "theme", label: "Theme", value: themeLabelFor(config.theme, home) },
      { key: "themes", label: "My themes…", value: `${listUserThemes(home ?? homedir()).length} personal` },
      { key: "icons", label: "Icons", value: config.icons ? "on" : "off" },
      { key: "filePreview", label: "File preview", value: config.filePreview },
      { key: "answerLanguage", label: "Answer language", value: config.answerLanguage },
      { key: "telemetry", label: "Telemetry", value: config.telemetry ? "on (opt-in)" : "off" },
      { key: "permissionMode", label: "Default permission mode", value: config.permissionMode },
      { key: "provider", label: "Provider", value: modelLabel },
      { key: "provider-add", label: "Add provider", value: "" },
      { key: "provider-remove", label: "Remove provider", value: `${moh.endpoints?.length ?? 0} endpoint(s)` },
      { key: "jev", label: "Jev (TypeSafe)", value: jevLabel },
      { key: "handoff", label: "Session handoff", value: handoffTransport === "gist" ? "GitHub Gist" : handoffTransport === "none" ? "Disabled" : "Not Set" },
      { key: "mpm", label: "Moh Project Map", value: mpmSettingLabel(mpmSetting) },
      { key: "maxIterations", label: "Max iterations/turn", value: maxIterationsLabel(moh.maxIterations ?? DEFAULT_MAX_ITERATIONS) },
      { key: "homeListMax", label: "Home list rows", value: String(config.homeListMax) },
      { key: "showReasoning", label: "Provider reasoning", value: config.showReasoning ? "show" : "hide" },
      { key: "updateCheck", label: "Update check", value: config.updateCheck ? "on" : "off" },
    ],
    [config, modelLabel, moh, handoffTransport, mpmSetting, jevLabel],
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
      // Vendored catalog + #551 live overlay; otherwise the fetched list.
      const vendored = modelListFor(sub.type, sub.baseUrl, sub.name);
      const list = vendored.length > 0 ? vendored : Array.isArray(remote[sub.name]) ? fetchedToCatalog(remote[sub.name] as string[]) : [];
      const rows = filterCatalog(list, sub.query).map((m) => modelRow(m, m.id === sub.current));
      rows.push(sub.query.trim() ? freeTextRow(sub.query) : "+ other… (type a model id)");
      return rows;
    }
    if (sub.kind === "model-free") return [];
    if (sub.kind === "jev") return [...JEV_OPTIONS];
    if (sub.kind === "remove") return sub.options;
    return (moh.endpoints ?? []).map((e) => e.name);
  }, [sub, moh, projectNames, remote]);

  const subCursor = sub && (sub.kind === "endpoint" || sub.kind === "remove" || sub.kind === "model" || sub.kind === "jev") ? sub.cursor : 0;
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
        const refs = allThemeRefs(home);
        return setSub({ kind: "theme-pick", options: refs, cursor: Math.max(0, refs.indexOf(config.theme)) });
      }
      case "themes":
        return setStudio({ base: config.theme.startsWith("user:") ? guessExtendsOf(home ?? homedir(), config.theme.slice("user:".length)) : (config.theme as string) });
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
      case "mpm":
        return cycleMpmSetting();
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
      case "jev":
        return setSub({ kind: "jev", cursor: 0 });
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

  /**
   * #784: validate with one real call, then persist. The order matters: a
   * key the service rejects must never reach the config (it would read as
   * active while being useless) and must never overwrite a good stored key.
   * The two failure modes stay distinct on purpose — an unreachable service
   * IS persisted, because the user typed what they meant and moh fails open.
   */
  const submitJevKey = (key: string) => {
    const trimmed = key.trim();
    if (!trimmed) return setSub({ kind: "jev-key", value: "", busy: false });
    setSub({ kind: "jev-key", value: trimmed, busy: true, message: "validating…" });
    void validate(trimmed)
      .then((result) => {
        if (result.status === "invalid") {
          setSub({ kind: "jev-key", value: trimmed, busy: false, message: "invalid key — not saved" });
          return onToast("jev: invalid key — not saved");
        }
        // Active or unverified: both are the user's decision to store.
        try {
          saveTypesafeApiKey(jevFile, trimmed);
        } catch (e) {
          setSub({
            kind: "jev-key",
            value: trimmed,
            busy: false,
            message: `could not save: ${e instanceof Error ? e.message : String(e)}`,
          });
          return;
        }
        setJev((j) => ({ ...j, active: true, keyHint: maskApiKey(trimmed) }));
        if (result.status === "active") {
          onToast("jev: active");
          return setSub({ kind: "jev", cursor: 0 });
        }
        onToast("jev: could not verify — saved, will activate when reachable");
        return setSub({ kind: "jev", cursor: 0 });
      })
      .catch((e: unknown) => {
        // `validateJevKey` never throws; a custom seam might.
        setSub({ kind: "jev-key", value: trimmed, busy: false, message: e instanceof Error ? e.message : String(e) });
      });
  };

  /** #784: Remove — clears the key; the extension is unregistered from the
   * next session on (nothing to disable in the running one). */
  const removeJevKey = () => {
    try {
      removeTypesafeApiKey(jevFile);
    } catch (e) {
      return onToast(`jev: could not remove the key (${e instanceof Error ? e.message : String(e)})`);
    }
    setJev((j) => ({ ...j, active: false }));
    onToast("jev: key removed — inactive");
    setSub({ kind: "jev", cursor: 0 });
  };

  /**
   * #787: the model-routing opt-in. Off by default; the flag is read when
   * a session is assembled, so the running one keeps what it started with
   * (the router is built once, with the session).
   */
  const toggleJevRouting = () => {
    const next = !jev.routing;
    try {
      saveTypesafeRouting(jevFile, next);
    } catch (e) {
      return onToast(`routing: could not save (${e instanceof Error ? e.message : String(e)})`);
    }
    setJev((j) => ({ ...j, routing: next }));
    onToast(next ? "routing on · from your next session" : "routing off · from your next session");
    setSub({ kind: "jev", cursor: 0 });
  };

  /**
   * #791: the anti-injection opt-in. Off by default because it is the one
   * use case that sends the user's own message text; like the routing flag
   * it is read at session assembly.
   */
  const toggleJevInjection = () => {
    const next = !jev.injection;
    try {
      saveTypesafeInjection(jevFile, next);
    } catch (e) {
      return onToast(`anti-injection: could not save (${e instanceof Error ? e.message : String(e)})`);
    }
    setJev((j) => ({ ...j, injection: next }));
    onToast(next ? "anti-injection on · from your next session" : "anti-injection off · from your next session");
    setSub({ kind: "jev", cursor: 0 });
  };

  /**
   * #789: the quality-gate opt-in. Off by default because it sends the
   * changed code's diff; like the other flags it is read at session
   * assembly.
   */
  const toggleJevLint = () => {
    const next = !jev.lint;
    try {
      saveTypesafeLint(jevFile, next);
    } catch (e) {
      return onToast(`quality gate: could not save (${e instanceof Error ? e.message : String(e)})`);
    }
    setJev((j) => ({ ...j, lint: next }));
    onToast(next ? "quality gate on · from your next session" : "quality gate off · from your next session");
    setSub({ kind: "jev", cursor: 0 });
  };

  /**
   * #790: the MPM seed-rerank opt-in. Off by default: it sends the task
   * text plus candidate metadata to TypeSafe whenever an orientation plan
   * would otherwise be discarded as over-threshold; like the other flags
   * it is read at session assembly.
   */
  const toggleJevRerank = () => {
    const next = !jev.rerank;
    try {
      saveTypesafeRerank(jevFile, next);
    } catch (e) {
      return onToast(`seed rerank: could not save (${e instanceof Error ? e.message : String(e)})`);
    }
    setJev((j) => ({ ...j, rerank: next }));
    onToast(next ? "seed rerank on · from your next session" : "seed rerank off · from your next session");
    setSub({ kind: "jev", cursor: 0 });
  };

  /**
   * #793: the skill-suggestion opt-in. Off by default: it sends the user's
   * message plus the skill roster to TypeSafe, twice per judged turn; like
   * the other flags it is read at session assembly.
   */
  const toggleJevSkills = () => {
    const next = !jev.skills;
    try {
      saveTypesafeSkills(jevFile, next);
    } catch (e) {
      return onToast(`skill suggestion: could not save (${e instanceof Error ? e.message : String(e)})`);
    }
    setJev((j) => ({ ...j, skills: next }));
    onToast(next ? "skill suggestion on · from your next session" : "skill suggestion off · from your next session");
    setSub({ kind: "jev", cursor: 0 });
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

  // The studio modal owns the keyboard while open: Ink fans every key out
  // to all mounted useInput handlers, so this one must stand down or
  // enter/esc would drive the settings list underneath the modal.
  useInput((input, key) => {
    if (key.escape) {
      if (sub && sub.kind !== "tos") {
        if (sub.kind === "jev-key") return setSub({ kind: "jev", cursor: 0 });
        if (sub.kind === "model") return setSub({ kind: "endpoint", cursor: 0 });
        if (sub.kind === "model-free") return setSub({ kind: "endpoint", cursor: 0 });
        return setSub(null);
      }
      if (sub?.kind === "tos") return setSub({ kind: "endpoint", cursor: 0 });
      return onClose();
    }
    if (sub?.kind === "jev-key") {
      if (sub.busy) return; // one validation call at a time
      if (key.backspace || key.delete) return setSub({ ...sub, value: sub.value.slice(0, -1) });
      if ((key.return || input === "\n") && sub.value.trim()) return submitJevKey(sub.value);
      if (input && !key.ctrl && !key.meta) return setSub({ ...sub, value: sub.value + input, message: undefined });
      return;
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
    if (sub?.kind === "theme-pick") {
      if (key.escape) return setSub(null);
      if (key.upArrow) return setSub({ ...sub, cursor: Math.max(0, sub.cursor - 1) });
      if (key.downArrow) return setSub({ ...sub, cursor: Math.min(sub.options.length - 1, sub.cursor + 1) });
      if (key.return || input === "\n") {
        const ref = sub.options[sub.cursor];
        if (!ref) return;
        onChange({ theme: ref });
        onToast(`theme: ${themeLabelFor(ref, home)}`);
        return setSub(null);
      }
      if (input === "e" && sub.options[sub.cursor]?.startsWith("user:")) {
        const id = sub.options[sub.cursor]!.slice("user:".length);
        const fileTheme = loadUserTheme(home ?? homedir(), id);
        if (!fileTheme) return onToast("theme file unreadable");
        setSub(null);
        return setStudio({ base: guessExtendsOf(home ?? homedir(), id) });
      }
      if (input === "d" && sub.options[sub.cursor]?.startsWith("user:")) {
        const id = sub.options[sub.cursor]!.slice("user:".length);
        const wasActive = config.theme === `user:${id}`;
        // #749: deleting the active theme falls back to its extends base
        // preset first, then the default — never a hardcoded one.
        const base = guessExtendsOf(home ?? homedir(), id);
        deleteUserTheme(home ?? homedir(), id);
        const fallback: ThemeRef = wasActive ? (base as ThemeRef) : config.theme;
        if (config.theme !== fallback) onChange({ theme: fallback });
        onToast(`theme deleted${wasActive ? ` — fell back to ${base}` : ""}`);
        return setSub(null);
      }
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
        if (sub.kind === "tos") return;
        return setSub({ ...sub, cursor: Math.max(0, sub.cursor - 1) });
      }
      if (key.downArrow) {
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
        const index =
          sub.kind === "endpoint" || sub.kind === "remove" || sub.kind === "model" || sub.kind === "jev" ? sub.cursor : 0;
        const option = subOptions[index];
        if (option === undefined) return;
        if (sub.kind === "jev") {
          // Status is a read-only row: enter on it is a no-op (no probe, no
          // toast spam) — the panel already shows the live value.
          if (option === "API key") return setSub({ kind: "jev-key", value: "", busy: false });
          if (option === "Model routing") return toggleJevRouting();
          if (option === "Anti-injection") return toggleJevInjection();
          if (option === "Quality gate") return toggleJevLint();
          if (option === "Seed rerank") return toggleJevRerank();
          if (option === "Skill suggestion") return toggleJevSkills();
          if (option === "Remove") return removeJevKey();
          return;
        }
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
          const vendored = modelListFor(sub.type, sub.baseUrl, sub.name);
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
  }, { isActive: !studio });

  if (studio) {
    return (
      <ThemeStudioModal
        home={home ?? homedir()}
        base={studio.base}
        activeRef={config.theme}
        onApplyRef={(ref) => onChange({ theme: ref as ThemeRef })}
        onToast={onToast}
        onSave={(id, name, colors) => {
          saveUserTheme(home ?? homedir(), { version: 1, id, name, extends: studio.base, colors });
          onChange({ theme: `user:${id}` as ThemeRef });
          onToast(`theme saved: ${name} — applied`);
        }}
        onClose={() => setStudio(null)}
      />
    );
  }
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
          ) : sub.kind === "jev" ? (
            <>
              {JEV_OPTIONS.map((option, i) => {
                const selected = i === sub.cursor;
                const value =
                  option === "API key"
                    ? jev.active
                      ? "replace the stored key"
                      : "enter the key"
                    : option === "Model routing"
                      ? jev.routing
                        ? "on"
                        : "off"
                      : option === "Anti-injection"
                        ? jev.injection
                          ? "on"
                          : "off"
                        : option === "Quality gate"
                          ? jev.lint
                            ? "on"
                            : "off"
                          : option === "Seed rerank"
                            ? jev.rerank
                              ? "on"
                              : "off"
                            : option === "Skill suggestion"
                              ? jev.skills
                                ? "on"
                                : "off"
                              : option === "Status"
                          ? jevLabel
                          : jev.active
                            ? "clear the key"
                            : "nothing to remove";
                return (
                  <Text key={option} color={selected ? theme.bg : undefined} backgroundColor={selected ? theme.accent : undefined}>
                    {truncate(` ${selected ? "›" : " "} ${option.padEnd(15)}${value}${selected ? " " : ""}`, innerWidth)}
                  </Text>
                );
              })}
              <Text> </Text>
              <Text color={theme.dim} wrap="wrap">
                {JEV_DISCLOSURE}
                {jev.injection ? ` ${JEV_INJECTION_DISCLOSURE}` : ""}
                {jev.lint ? ` ${JEV_LINT_DISCLOSURE}` : ""}
                {jev.rerank ? ` ${JEV_RERANK_DISCLOSURE}` : ""}
                {jev.skills ? ` ${JEV_SKILLS_DISCLOSURE}` : ""}
              </Text>
            </>
          ) : sub.kind === "jev-key" ? (
            <>
              <Text bold>{`api key: ${"•".repeat(Math.min(24, sub.value.length))}▏`}</Text>
              <Text> </Text>
              <Dim>
                {sub.busy
                  ? "validating with one real call…"
                  : (sub.message ??
                    (jev.broken
                      ? "the typesafe section is invalid — saving a key here rewrites it"
                      : "saved to ~/.moh/config, then validated with one real call"))}
              </Dim>
            </>
          ) : sub.kind === "theme-pick" ? (
            <>
              {sub.options.map((ref, i) => {
                const selected = i === sub.cursor;
                return (
                  <Text key={ref} color={selected ? theme.bg : undefined} backgroundColor={selected ? theme.accent : undefined}>
                    {truncate(` ${selected ? "›" : " "} ${themeLabelFor(ref, home)}${selected ? " " : ""}`, innerWidth)}
                  </Text>
                );
              })}
              <Text> </Text>
              <Dim>↑↓ select · enter apply · e edit · d delete (personal) · esc back</Dim>
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
              : sub.kind === "jev"
                ? "↑↓ select · enter confirm · esc back — Jev (TypeSafe)"
                : sub.kind === "jev-key"
                  ? "type the key · enter save and validate · esc back"
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
            : rows[cursor]?.key === "jev"
              ? JEV_DISCLOSURE
              : "enter change · esc close"}
        </Dim>
      )}
    </Dialog>
  );
}
