import React, { useState } from "react";
import { Text, useInput } from "ink";
import { ghUsername, loadMohConfig, spawnGh, writeMohConfig, type HandoffTransportError } from "@moh/core";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";

export type GhVerification = () => { ok: true; user: string } | { ok: false; error: HandoffTransportError };

export interface HandoffActivationModalProps {
  cwd: string;
  /** Startup has only an activation/dismissal decision. Settings exposes all states. */
  startup?: boolean;
  verifyGh?: GhVerification;
  onDone: (transport: "gist" | "none" | undefined) => void;
  onClose?: () => void;
}

const options = ["GitHub Gist", "Disabled", "Not Set"] as const;
type Option = (typeof options)[number];

function writeTransport(cwd: string, transport: "gist" | "none" | undefined, onboarding?: "dismissed" | "reminded") {
  const file = `${cwd}/moh.json`;
  const config = loadMohConfig(file);
  // An explicit choice settles the one-time offer. Only startup dismissal
  // carries pending reminder state; a Settings reset is Not Set by policy,
  // not a request to restart first-run onboarding.
  const handoff = transport
    ? { transport }
    : onboarding
      ? { onboarding }
      : { onboarding: "reminded" as const };
  writeMohConfig(file, { ...config, handoff });
}

function verificationMessage(error: HandoffTransportError): string {
  switch (error.reason) {
    case "gh-missing": return "GitHub CLI (gh) is not installed. Install it, then try again.";
    case "not-logged-in": return "GitHub CLI is not logged in. Run `gh auth login`, then try again.";
    case "timeout": return "GitHub verification timed out. Try again.";
    case "no-artifact": return "GitHub verification failed.";
    case "failed": return `GitHub verification failed: ${error.message}`;
  }
}

/** Per-project session-handoff transport choice (#438). Gist activation is
 * deliberately preflighted before moh.json changes, so an active setting
 * never starts life known-broken. */
export function HandoffActivationModal({ cwd, startup = false, verifyGh = () => ghUsername(spawnGh), onDone, onClose }: HandoffActivationModalProps) {
  const theme = useTheme();
  const [cursor, setCursor] = useState(0);
  const [notice, setNotice] = useState<string>();
  const choices: readonly Option[] = startup ? ["GitHub Gist"] : options;

  const choose = (choice: Option) => {
    if (choice === "GitHub Gist") {
      const verified = verifyGh();
      if (!verified.ok) return setNotice(verificationMessage(verified.error));
      writeTransport(cwd, "gist");
      return onDone("gist");
    }
    if (choice === "Disabled") {
      writeTransport(cwd, "none");
      return onDone("none");
    }
    writeTransport(cwd, undefined);
    return onDone(undefined);
  };

  useInput((input, key) => {
    if (key.upArrow) return setCursor((value) => Math.max(0, value - 1));
    if (key.downArrow) return setCursor((value) => Math.min(choices.length - 1, value + 1));
    if (key.return || input === "y") return choose(choices[cursor]!);
    // The startup dismissal is deliberately recorded separately from an
    // explicit Disabled policy: it earns exactly one end-session reminder.
    if (startup && (input === "n" || key.escape)) {
      writeTransport(cwd, undefined, "dismissed");
      return onDone(undefined);
    }
    if (!startup && key.escape) return onClose?.();
  });

  return (
    <Dialog title=" session handoff " color={theme.purple}>
      <Text>
        Continue work from this project on another computer? moh can publish a filtered handoff to a secret GitHub Gist
        when a session ends or you push. Gists are unlisted, not encrypted; full session logs and tool output stay local.
      </Text>
      <Text> </Text>
      <Text>Requires GitHub CLI (<Text color={theme.accent}>gh</Text>) installed and logged in with the same account on both machines.</Text>
      <Text> </Text>
      {choices.map((choice, index) => (
        <Text key={choice} color={index === cursor ? theme.bg : undefined} backgroundColor={index === cursor ? theme.accent : undefined}>
          {` ${index === cursor ? "›" : " "} ${choice}${index === cursor ? " " : ""}`}
        </Text>
      ))}
      {notice && <Text color={notice.startsWith("GitHub Gist enabled") ? theme.ok : theme.warn}>{notice}</Text>}
      <Text> </Text>
      <Dim>{startup ? "enter/y enable · n skip" : "↑↓ select · enter save · esc close"}</Dim>
    </Dialog>
  );
}
