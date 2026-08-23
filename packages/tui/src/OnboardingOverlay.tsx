import React, { useEffect, useMemo, useRef, useState } from "react";
import { Text, useInput } from "ink";
import { join } from "node:path";
import {
  BUILTIN_PROVIDER_TYPES,
  TOS_WARNING,
  minimalConnectionTest,
  readAuthSection,
  runSubscriptionLogin,
  saveTokens,
  upsertUserEndpoint,
  saveUserProviderRef,
  type AuthToken,
  type AuthorizationIo,
  type BuiltinProviderType,
  type ConnectionTestResult,
  type ConnectionTester,
  type EndpointProfile,
} from "@moh/core";
import { userConfigFile } from "@moh/core";
import { detectEnvProviders, saveDetectedProvider, saveWizardProvider, saveWizardProviderUser, saveProviderRefProject, profileDiff, wizardSavePlan, readUserWizardEndpoints, projectConfigExists, type EnvCandidate } from "./onboarding";
import { useTheme } from "./themes";
import { TuiAuthorizationIo } from "./subscription-io";
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
  | { kind: "wizard-auth"; cursor: number }
  | { kind: "tos" }
  | { kind: "sub-login"; error?: string }
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
  /** Subscription grant seam (tests); default runs the real flow. */
  subscriptionLogin?: (io: AuthorizationIo) => Promise<AuthToken>;
  /** Browser opener (tests); default spawns the OS opener. */
  openUrl?: (url: string) => Promise<boolean>;
  onDone: (providerRef: string | null) => void;
}

const FIELD_LABELS: Record<"model" | "apiKey" | "baseUrl", { label: string; hint: string }> = {
  model: { label: "Default model", hint: "e.g. claude-sonnet-4-5, gpt-5, qwen3" },
  apiKey: { label: "API key (empty = env var / local, no key)", hint: "stored inline in moh.json — keep it gitignored" },
  baseUrl: { label: "Base URL", hint: "required for openai-compat, e.g. http://localhost:11434/v1" },
};

export function Onboarding({ cwd, home, env, tester = minimalConnectionTest, forceWizard, subscriptionLogin, openUrl, onDone }: OnboardingProps) {
  const theme = useTheme();
  const viewport = useViewport();
  const [authKind, setAuthKind] = useState<"api-key" | "subscription">("api-key");
  const [askValue, setAskValue] = useState("");
  const [, setTick] = useState(0);
  const authIo = useRef<TuiAuthorizationIo | null>(null);
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
        // Subscription: the endpoint was persisted right after login; the
        // wizard only completes it (model) and points the default ref at it.
        if (phase.profile.auth?.kind === "subscription") {
          upsertUserEndpoint(userFile, phase.profile);
          const ref = endpointRef(phase.profile);
          if (hasProject) saveProviderRefProject(configFile, ref);
          else saveUserProviderRef(userFile, ref);
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

  // Subscription login (issue #149): run the provider grant through the
  // overlay-backed AuthorizationIo. ToS was acknowledged on the previous
  // screen (spec invariant 4). On success, tokens are stored and the
  // endpoint stub persisted immediately (#142/#150 ordering: a later abort
  // never orphans tokens) — then model + connection test as usual.
  useEffect(() => {
    if (phase.kind !== "sub-login" || phase.error) return;
    const io = new TuiAuthorizationIo(openUrl);
    authIo.current = io;
    const unsubscribe = io.subscribe(() => setTick((t) => t + 1));
    let live = true;
    const type = (wizard.type ?? "anthropic") as "anthropic" | "openai" | "google";
    const login =
      subscriptionLogin ??
      ((io2: AuthorizationIo) => runSubscriptionLogin(type, io2, { overrides: readAuthSection(userFile).overrides }));
    void login(io)
      .then((token) => {
        if (!live) return;
        const name = wizard.name || type;
        saveTokens(userFile, name, token);
        upsertUserEndpoint(userFile, { name, type, auth: { kind: "subscription" } });
        setPhase({ kind: "wizard-text", field: "model", value: "" });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setPhase({ kind: "sub-login", error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      live = false;
      unsubscribe();
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
          // openai-compat has no subscription grant — the auth-method step
          // is never shown (byte-identical path, issue #149).
          if (type === "openai-compat") {
            setAuthKind("api-key");
            return setPhase({ kind: "wizard-text", field: "model", value: "" });
          }
          setPhase({ kind: "wizard-auth", cursor: 0 });
        }
        return;
      }
      case "wizard-auth": {
        if (key.escape) return setPhase({ kind: "wizard-type", cursor: 0 });
        if (key.upArrow) return setPhase({ ...phase, cursor: Math.max(0, phase.cursor - 1) });
        if (key.downArrow) return setPhase({ ...phase, cursor: Math.min(1, phase.cursor + 1) });
        if (input === "s") return onDone(null);
        if (key.return || input === "\n") {
          const kind = phase.cursor === 0 ? "api-key" : "subscription";
          setAuthKind(kind);
          return setPhase(kind === "subscription" ? { kind: "tos" } : { kind: "wizard-text", field: "model", value: "" });
        }
        return;
      }
      case "tos": {
        if (key.escape || input === "n") return setPhase({ kind: "wizard-auth", cursor: 1 });
        if (key.return || input === "y") return setPhase({ kind: "sub-login" });
        return;
      }
      case "sub-login": {
        if (phase.error) {
          if (input === "r") return setPhase({ kind: "sub-login" });
          if (input === "w") return setPhase({ kind: "wizard-auth", cursor: 1 });
          if (input === "s") return onDone(null);
          return;
        }
        const io = authIo.current;
        if (input === "s" && !io?.pendingPrompt) return onDone(null);
        if (io?.pendingPrompt) {
          if (key.escape) {
            io.answer(""); // empty line terminates a multi-line paste
            return setAskValue("");
          }
          if (key.backspace || key.delete) return setAskValue(askValue.slice(0, -1));
          if (key.return || input === "\n") {
            io.answer(askValue);
            return setAskValue("");
          }
          if (input && !key.ctrl && !key.meta) return setAskValue(askValue + input);
        }
        return;
      }
      case "wizard-text": {
        if (key.escape) return setPhase({ kind: "wizard-type", cursor: 0 });
        if (key.backspace || key.delete) return setPhase({ ...phase, value: phase.value.slice(0, -1) });
        if (key.return || input === "\n") return submitField(phase, wizard, setWizard, setPhase, authKind);
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
      {phase.kind === "wizard-auth" && (
        <>
          <Text>How does {wizard.type} authenticate?</Text>
          <Text> </Text>
          {["api-key — inline key or env var", "subscription — OAuth login (Claude Pro/Max, ChatGPT, Google)"].map((row, i) => (
            <Text key={row} color={i === phase.cursor ? theme.bg : undefined} backgroundColor={i === phase.cursor ? theme.accent : undefined}>
              {` ${i === phase.cursor ? "\u203a" : " "} ${row}${i === phase.cursor ? " " : ""}`}
            </Text>
          ))}
          <Text> </Text>
          <Dim>enter select · esc back · s skip</Dim>
        </>
      )}
      {phase.kind === "tos" && (
        <>
          <Text color={theme.warn}>Terms of service</Text>
          <Text> </Text>
          {TOS_WARNING.match(/.{1,64}(?:\s|$)/g)!.map((chunk) => (
            <Text key={chunk}>{chunk.trim()}</Text>
          ))}
          <Text> </Text>
          <Dim>y acknowledge and continue · n back</Dim>
        </>
      )}
      {phase.kind === "sub-login" && (
        <>
          {phase.error ? (
            <>
              <Text color={theme.warn}>✗ Login failed: {phase.error}</Text>
              <Text> </Text>
              <Dim>r retry · w choose another method · s skip</Dim>
            </>
          ) : (
            <>
              {(authIo.current?.log ?? []).slice(-Math.max(3, budget - 4)).map((line, idx) => (
                <Text key={`${idx}-${line.slice(0, 12)}`} wrap="truncate-middle">{` ${line}`}</Text>
              ))}
              <Text> </Text>
              {authIo.current?.pendingPrompt ? (
                <>
                  <Text>{authIo.current.pendingPrompt}</Text>
                  <Text>
                    <Text color={theme.accent}>{`› ${askValue.replace(/./g, "*")}`}</Text>
                    <Text color={theme.dim}>▊</Text>
                  </Text>
                </>
              ) : (
                <Dim>waiting for authorization… (pasted codes are masked)</Dim>
              )}
              <Text> </Text>
              <Dim>{authIo.current?.pendingPrompt ? "enter submit · esc empty line" : "s skip"}</Dim>
            </>
          )}
        </>
      )}
      {phase.kind === "wizard-text" && (
        <>
          {phase.field === "model" && authKind === "subscription" && (
            <Text color={theme.ok}>✓ Subscription login complete — tokens stored in ~/.moh/config</Text>
          )}
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
  authKind: "api-key" | "subscription",
): void {
  const value = phase.value.trim();
  if (phase.field === "model") {
    if (!value) return; // a model is required
    setWizard({ ...wizard, defaultModel: value });
    // Subscription never asks for a key (tokens are already stored);
    // openai-compat keeps its byte-identical model → key → base URL path.
    const next = authKind === "subscription" ? "baseUrl" : "apiKey";
    return setPhase({ kind: "wizard-text", field: next, value: "" });
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
    ...(authKind === "subscription" ? { auth: { kind: "subscription" } } : {}),
    ...(wizard.apiKey ? { apiKey: wizard.apiKey } : {}),
    ...(value ? { baseUrl: value } : {}),
    defaultModel: wizard.defaultModel!,
  };
  setPhase({ kind: "test", profile });
}
