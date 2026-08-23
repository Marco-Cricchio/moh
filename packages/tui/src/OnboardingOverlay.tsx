import React, { useEffect, useMemo, useState } from "react";
import { Text, useInput } from "ink";
import { join } from "node:path";
import {
  BUILTIN_PROVIDER_TYPES,
  minimalConnectionTest,
  type BuiltinProviderType,
  type ConnectionTestResult,
  type ConnectionTester,
  type EndpointProfile,
} from "@moh/core";
import { userConfigFile } from "@moh/core";
import { detectEnvProviders, saveDetectedProvider, saveWizardProvider, saveWizardProviderUser, saveProviderRefProject, profileDiff, wizardSavePlan, readUserWizardEndpoints, projectConfigExists, type EnvCandidate } from "./onboarding";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";
import { useViewport, windowing } from "./viewport";

/**
 * Hybrid onboarding overlay (issue #33): detected env credentials are
 * confirmed in one step; with nothing detected, the full wizard runs
 * (type → model → key → base URL → mandatory connection test). `s` skips
 * (mock demo); the chosen profile lands in moh.json as the default
 * provider.
 */
type Phase =
  | { kind: "detect"; cursor: number }
  | { kind: "wizard-type"; cursor: number }
  | { kind: "wizard-text"; field: "model" | "apiKey" | "baseUrl"; value: string }
  | { kind: "test"; profile: EndpointProfile; envCandidate?: EnvCandidate; result?: ConnectionTestResult }
  | { kind: "save-scope"; profile: EndpointProfile; cursor: number }
  | { kind: "conflict"; profile: EndpointProfile; existing: EndpointProfile }
  | { kind: "duplicate"; profile: EndpointProfile; existing: EndpointProfile };

export interface OnboardingProps {
  cwd: string;
  /** Home dir for the user-level config (#129); default os homedir. */
  home?: string;
  /** Injected for tests; default process.env. */
  env?: Record<string, string | undefined>;
  /** Injected connection test; default one real minimal request. */
  tester?: ConnectionTester;
  /** Skip detection (settings-panel "add provider"). */
  forceWizard?: boolean;
  onDone: (providerRef: string | null) => void;
}

const FIELD_LABELS: Record<"model" | "apiKey" | "baseUrl", { label: string; hint: string }> = {
  model: { label: "Default model", hint: "e.g. claude-sonnet-4-5, gpt-5, qwen3" },
  apiKey: { label: "API key (empty = env var / local, no key)", hint: "stored inline in moh.json — keep it gitignored" },
  baseUrl: { label: "Base URL", hint: "required for openai-compat, e.g. http://localhost:11434/v1" },
};

export function Onboarding({ cwd, home, env, tester = minimalConnectionTest, forceWizard, onDone }: OnboardingProps) {
  const theme = useTheme();
  const viewport = useViewport();
  const configFile = useMemo(() => join(cwd, "moh.json"), [cwd]);
  const userFile = useMemo(() => userConfigFile(home), [home]);
  // Broken user provider sections surface at assembly; the wizard reads them
  // best-effort so it stays reachable.
  const userEndpoints = useMemo(() => {
    try {
      return readUserWizardEndpoints(home);
    } catch {
      return [];
    }
  }, [home]);
  const hasProject = useMemo(() => projectConfigExists(cwd), [cwd]);
  const candidates = useMemo(() => detectEnvProviders(env ?? process.env), [env]);
  const [phase, setPhase] = useState<Phase>(
    forceWizard || candidates.length === 0 ? { kind: "wizard-type", cursor: 0 } : { kind: "detect", cursor: 0 },
  );
  const [wizard, setWizard] = useState<Partial<EndpointProfile>>({ name: "", type: "anthropic" });

  // Height-aware lists (#64): intro, skip row, footer and borders ≈ 10 rows.
  const budget = Math.max(3, viewport.rows - 10);
  const detectWin = windowing(candidates.length + 1, phase.kind === "detect" ? phase.cursor : 0, budget);
  const typeWin = windowing(BUILTIN_PROVIDER_TYPES.length, phase.kind === "wizard-type" ? phase.cursor : 0, budget);

  // Where the default provider ref lands after a wizard save/reuse (#129):
  // project moh.json when one exists, user config otherwise.
  const endpointRef = (profile: EndpointProfile): string => `${profile.name}/${profile.defaultModel}`;
  const setRef = (profile: EndpointProfile): string => {
    const ref = endpointRef(profile);
    if (hasProject) {
      saveProviderRefProject(configFile, ref);
      return ref;
    }
    return saveWizardProviderUser(userFile, profile);
  };

  // Kick off the connection test as soon as a profile is ready.
  useEffect(() => {
    if (phase.kind !== "test" || phase.result) return;
    let live = true;
    void tester(phase.profile).then((result) => {
      if (!live) return;
      if (result.ok) {
        if (phase.envCandidate) {
          const ref =
            saveDetectedProvider(configFile, phase.envCandidate, phase.profile.defaultModel!)?.provider ??
            endpointRef(phase.profile);
          return onDone(ref);
        }
        // Wizard save semantics (#129 decision 7).
        const plan = wizardSavePlan(phase.profile, userEndpoints, hasProject);
        if (plan.kind === "reuse") return onDone(setRef(plan.existing));
        if (plan.kind === "new") return setPhase({ kind: "save-scope", profile: phase.profile, cursor: plan.defaultScope === "user" ? 0 : 1 });
        if (plan.kind === "key-conflict") return setPhase({ kind: "conflict", profile: phase.profile, existing: plan.existing });
        return setPhase({ kind: "duplicate", profile: phase.profile, existing: plan.existing });
      } else {
        setPhase({ ...phase, result });
      }
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useInput((input, key) => {
    switch (phase.kind) {
      case "detect": {
        const rows = candidates.length + 1; // + skip
        if (key.upArrow) return setPhase({ ...phase, cursor: Math.max(0, phase.cursor - 1) });
        if (key.downArrow) return setPhase({ ...phase, cursor: Math.min(rows - 1, phase.cursor + 1) });
        if (input === "s") return onDone(null);
        if (input === "w") return setPhase({ kind: "wizard-type", cursor: 0 });
        if (key.return || input === "\n") {
          if (phase.cursor === candidates.length) return onDone(null);
          const candidate = candidates[phase.cursor]!;
          setWizard({ name: candidate.type, type: candidate.type });
          setPhase({
            kind: "test",
            envCandidate: candidate,
            profile: { name: candidate.type, type: candidate.type, defaultModel: candidate.defaultModel },
          });
        }
        return;
      }
      case "wizard-type": {
        if (key.upArrow) return setPhase({ ...phase, cursor: Math.max(0, phase.cursor - 1) });
        if (key.downArrow)
          return setPhase({ ...phase, cursor: Math.min(BUILTIN_PROVIDER_TYPES.length - 1, phase.cursor + 1) });
        if (input === "s") return onDone(null);
        if (key.return || input === "\n") {
          const type = BUILTIN_PROVIDER_TYPES[phase.cursor]!;
          setWizard({ name: type, type });
          setPhase({ kind: "wizard-text", field: "model", value: "" });
        }
        return;
      }
      case "wizard-text": {
        if (key.escape) return setPhase({ kind: "wizard-type", cursor: 0 });
        if (key.backspace || key.delete) return setPhase({ ...phase, value: phase.value.slice(0, -1) });
        if (key.return || input === "\n") return submitField(phase, wizard, setWizard, setPhase);
        if (input && !key.ctrl && !key.meta) setPhase({ ...phase, value: phase.value + input });
        return;
      }
      case "test": {
        if (phase.result && !phase.result.ok) {
          if (input === "r") return setPhase({ kind: "test", profile: phase.profile, envCandidate: phase.envCandidate });
          if (input === "w") return setPhase({ kind: "wizard-type", cursor: 0 });
          if (input === "s") return onDone(null);
        }
        return;
      }
      case "save-scope": {
        if (key.upArrow) return setPhase({ ...phase, cursor: Math.max(0, phase.cursor - 1) });
        if (key.downArrow) return setPhase({ ...phase, cursor: Math.min(1, phase.cursor + 1) });
        if (input === "s") return onDone(null);
        if (key.return || input === "\n") {
          if (phase.cursor === 0) return onDone(saveWizardProviderUser(userFile, phase.profile));
          return onDone(saveWizardProvider(configFile, phase.profile)?.provider ?? endpointRef(phase.profile));
        }
        return;
      }
      case "conflict": {
        if (input === "r") return onDone(setRef(phase.existing)); // reuse the global endpoint
        if (input === "p") return onDone(saveWizardProvider(configFile, phase.profile)?.provider ?? endpointRef(phase.profile));
        if (input === "s") return onDone(null);
        return;
      }
      case "duplicate": {
        if (input === "u") return onDone(setRef(phase.existing)); // use the existing endpoint
        if (input === "a") return setPhase({ kind: "save-scope", profile: phase.profile, cursor: hasProject ? 1 : 0 });
        if (input === "s") return onDone(null);
        return;
      }
    }
  });

  return (
    <Dialog title=" connect a provider " color={theme.ok}>
      {phase.kind === "detect" && (
        <>
          <Text>Found credentials in your environment:</Text>
          <Text> </Text>
          {detectWin.above > 0 && <Dim>{` ↑ ${detectWin.above} more`}</Dim>}
          {candidates.slice(detectWin.start, detectWin.start + detectWin.count - (detectWin.start + detectWin.count > candidates.length ? 1 : 0)).map((c, i) => {
            const index = detectWin.start + i;
            return (
            <Text key={c.envVar} color={index === phase.cursor ? theme.bg : undefined} backgroundColor={index === phase.cursor ? theme.accent : undefined} wrap="truncate-end">
              {` ${index === phase.cursor ? "›" : " "} ${c.type} via ${c.envVar} · ${c.defaultModel}${index === phase.cursor ? " " : ""}`}
            </Text>
            );
          })}
          {detectWin.start + detectWin.count > candidates.length && (
            <Text color={phase.cursor === candidates.length ? theme.bg : undefined} backgroundColor={phase.cursor === candidates.length ? theme.dim : undefined}>
              {` ${phase.cursor === candidates.length ? "›" : " "} skip — use the built-in mock demo`}
            </Text>
          )}
          {detectWin.below > 0 && <Dim>{` ↓ ${detectWin.below} more`}</Dim>}
          <Text> </Text>
          <Dim>enter confirm (connection test runs) · w wizard · s skip</Dim>
        </>
      )}
      {phase.kind === "wizard-type" && (
        <>
          <Text>Pick a provider type:</Text>
          <Text> </Text>
          {typeWin.above > 0 && <Dim>{` ↑ ${typeWin.above} more`}</Dim>}
          {BUILTIN_PROVIDER_TYPES.slice(typeWin.start, typeWin.start + typeWin.count).map((t, i) => {
            const index = typeWin.start + i;
            return (
            <Text key={t} color={index === phase.cursor ? theme.bg : undefined} backgroundColor={index === phase.cursor ? theme.accent : undefined}>
              {` ${index === phase.cursor ? "›" : " "} ${t}${index === phase.cursor ? " " : ""}`}
            </Text>
            );
          })}
          {typeWin.below > 0 && <Dim>{` ↓ ${typeWin.below} more`}</Dim>}
          <Text> </Text>
          <Dim>enter select · s skip</Dim>
        </>
      )}
      {phase.kind === "wizard-text" && (
        <>
          <Text>{FIELD_LABELS[phase.field].label}</Text>
          <Text> </Text>
          <Text>
            <Text color={theme.accent}>{`› ${phase.field === "apiKey" ? phase.value.replace(/./g, "*") : phase.value}`}</Text>
            <Text color={theme.dim}>▊</Text>
          </Text>
          <Text> </Text>
          <Dim>{FIELD_LABELS[phase.field].hint} · enter next · esc back</Dim>
        </>
      )}
      {phase.kind === "test" && (
        <>
          <Text>
            {phase.result === undefined
              ? `Testing connection to ${phase.profile.name} (${phase.profile.defaultModel})…`
              : phase.result.ok
                ? `✓ Connected`
                : `✗ Connection test failed: ${phase.result.error}`}
          </Text>
          <Text> </Text>
          {phase.result && !phase.result.ok ? <Dim>r retry · w wizard · s skip</Dim> : <Dim> </Dim>}
        </>
      )}
      {phase.kind === "save-scope" && (
        <>
          <Text>Where should {phase.profile.name} be saved?</Text>
          <Text> </Text>
          {["user — ~/.moh/config (available in every project)", "project — moh.json (this project only)"].map((row, i) => (
            <Text
              key={row}
              color={i === phase.cursor ? theme.bg : undefined}
              backgroundColor={i === phase.cursor ? theme.accent : undefined}
            >
              {` ${i === phase.cursor ? "\u203a" : " "} ${row}${i === phase.cursor ? " " : ""}`}
            </Text>
          ))}
          <Text> </Text>
          <Dim>enter save · s skip</Dim>
        </>
      )}
      {phase.kind === "conflict" && (
        <>
          <Text color={theme.warn}>
            ~/.moh/config already has an endpoint "{phase.existing.name}" with different settings
            {profileDiff(phase.existing, phase.profile).length ? ` (${profileDiff(phase.existing, phase.profile).join(", ")})` : ""}.
          </Text>
          <Text>Keeping both is legal (project fields win) but usually a mistake.</Text>
          <Text> </Text>
          <Dim>r reuse the global one · p save project-level anyway · s skip</Dim>
        </>
      )}
      {phase.kind === "duplicate" && (
        <>
          <Text>
            Your user config has "{phase.existing.name}" with the same type, base URL and model
            {phase.profile.name === phase.existing.name ? "" : ` as "${phase.profile.name}"`}.
          </Text>
          <Text> </Text>
          <Dim>u use the existing one · a save anyway (choose scope) · s skip</Dim>
        </>
      )}
    </Dialog>
  );
}

function submitField(
  phase: Extract<Phase, { kind: "wizard-text" }>,
  wizard: Partial<EndpointProfile>,
  setWizard: (w: Partial<EndpointProfile>) => void,
  setPhase: (p: Phase) => void,
): void {
  const value = phase.value.trim();
  if (phase.field === "model") {
    if (!value) return; // a model is required
    setWizard({ ...wizard, defaultModel: value });
    return setPhase({ kind: "wizard-text", field: "apiKey", value: "" });
  }
  if (phase.field === "apiKey") {
    setWizard({ ...wizard, ...(value ? { apiKey: value } : {}) });
    return setPhase({ kind: "wizard-text", field: "baseUrl", value: wizard.baseUrl ?? "" });
  }
  // baseUrl
  if (wizard.type === "openai-compat" && !value) return; // required for compat
  const profile: EndpointProfile = {
    name: wizard.name || wizard.type || "endpoint",
    type: (wizard.type ?? "anthropic") as string,
    ...(wizard.apiKey ? { apiKey: wizard.apiKey } : {}),
    ...(value ? { baseUrl: value } : {}),
    defaultModel: wizard.defaultModel!,
  };
  setPhase({ kind: "test", profile });
}
