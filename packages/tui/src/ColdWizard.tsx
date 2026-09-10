import React, { useState } from "react";
import { Text, useInput } from "ink";
import {
  cloneHandoffRepo,
  pullHandoffTo,
  ghUsername,
  spawnGh,
  isHandoffStale,
  type GistHandoffOffer,
  type RawHandoff,
} from "@moh/core";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";

/** Injectable clone/pull seams (tests); production uses the core defaults. */
export interface ColdWizardSeams {
  clone?: typeof cloneHandoffRepo;
  pull?: typeof pullHandoffTo;
  /** Gist payload fetch for the pull step (tests); production lets the
   * core default pull fetch nothing (payload already known) or callers
   * pass a payload via pull's own options. */
  fetchPayload?: (url: string) => Promise<{ ok: true; payload: RawHandoff } | { ok: false }>;
  /** Author check seam; production resolves gh's logged-in user. */
  ghUser?: () => Promise<{ ok: true; user: string } | { ok: false }>;
}

export interface ColdWizardProps {
  offers: GistHandoffOffer[];
  /** The directory moh was launched in: the proposed clone destination. */
  cwd: string;
  home?: string;
  seams?: ColdWizardSeams;
  /** Opens the seeded session in the clone (the App's open() on the new cwd). */
  onProceed: (args: { path: string; payload: RawHandoff; stale: boolean }) => void;
  onClose: () => void;
  onToast?: (message: string) => void;
}

type Phase =
  | { step: "pick" }
  | { step: "location"; offer: GistHandoffOffer; pathBuf: string }
  | { step: "working"; offer: GistHandoffOffer; label: string }
  | { step: "error"; offer: GistHandoffOffer; message: string };

function offerTitle(offer: GistHandoffOffer): string {
  const at = new Date(offer.updatedAt);
  const stamp = Number.isNaN(at.getTime()) ? offer.updatedAt : at.toISOString().slice(0, 16).replace("T", " ");
  return `${offer.projectSlug} · ${stamp} UTC${offer.git?.branch ? ` · ${offer.git.branch}` : ""}`;
}

/**
 * Cold-directory wizard (#595): offer picker → location prompt → clone →
 * pull → seeded session through the existing reception path. Cancel at
 * any step leaves nothing half-done beyond the clone itself, which is a
 * plain git clone the user owns.
 */
export function ColdWizard({ offers, cwd, home, seams, onProceed, onClose, onToast }: ColdWizardProps) {
  const theme = useTheme();
  const [phase, setPhase] = useState<Phase>({ step: "pick" });
  const [cursor, setCursor] = useState(0);
  const clone = seams?.clone ?? cloneHandoffRepo;
  const pull = seams?.pull ?? pullHandoffTo;

  const run = async (offer: GistHandoffOffer, dest: string) => {
    setPhase({ step: "working", offer, label: `cloning ${offer.repoUrl ?? "(no repoUrl — using the given path)"}` });
    // With a repoUrl the destination receives the clone; the legacy
    // fallback (no repoUrl) takes the user-typed path of an existing
    // clone and skips straight to pull.
    let path: string;
    if (offer.repoUrl) {
      const cloned = await clone({ repoUrl: offer.repoUrl, dest });
      if (!cloned.ok) {
        return setPhase({
          step: "error",
          offer,
          message: cloned.reason === "exists" ? `${cloned.path} already exists — remove it or choose another location` : cloned.message,
        });
      }
      path = cloned.path;
    } else {
      path = dest;
    }
    setPhase({ step: "working", offer, label: "pulling the handoff" });
    const resolveUser = seams?.ghUser ?? (async () => {
      const name = await ghUsername(spawnGh);
      return name.ok ? { ok: true as const, user: name.user } : { ok: false as const };
    });
    const user = await resolveUser();
    const fetchByUrl = seams?.fetchPayload
      ? async () => {
          const fetched = await seams.fetchPayload!(offer.url);
          return fetched.ok
            ? { ok: true as const, payload: fetched.payload }
            : { ok: false as const, error: { reason: "failed" as const, message: "fetch failed" } };
        }
      : undefined;
    const pulled = await pull({
      cwd: path,
      home,
      offer,
      ...(user.ok ? { expectedAuthor: user.user } : {}),
      ...(fetchByUrl ? { fetchByUrl } : {}),
    });
    if (!pulled.ok) {
      return setPhase({ step: "error", offer, message: pulled.message });
    }
    onToast?.("session handoff pulled — opening the seeded session");
    onProceed({
      path,
      payload: pulled.payload,
      stale: isHandoffStale(pulled.payload, path),
    });
  };

  useInput((input, key) => {
    if (phase.step === "pick") {
      if (key.escape) return onClose();
      if (key.upArrow) return setCursor((value) => Math.max(0, value - 1));
      if (key.downArrow) return setCursor((value) => Math.min(offers.length - 1, value + 1));
      if (key.return || input === "\n") {
        const offer = offers[cursor]!;
        if (offer.repoUrl) setPhase({ step: "location", offer, pathBuf: cwd });
        else setPhase({ step: "location", offer, pathBuf: "" });
        return;
      }
      return;
    }
    if (phase.step === "location") {
      if (key.escape) return setPhase({ step: "pick" });
      if (key.return || input === "\n") {
        const dest = phase.pathBuf.trim();
        if (!dest) return; // a location is required (repoUrl flow) — do nothing on empty
        void run(phase.offer, dest);
        return;
      }
      if (key.backspace || key.delete) return setPhase({ ...phase, pathBuf: phase.pathBuf.slice(0, -1) });
      if (input && !key.ctrl && !key.meta) return setPhase({ ...phase, pathBuf: phase.pathBuf + input });
      return;
    }
    if (phase.step === "error") {
      if (key.return || key.escape) return setPhase({ step: "pick" });
    }
    // "working": input is ignored — the steps own the screen until they finish.
  });

  return (
    <Dialog title=" resume from another machine " color={theme.purple}>
      {phase.step === "pick" && (
        <>
          <Text>Sessions published from your other machines (secret gists):</Text>
          <Text> </Text>
          {offers.map((offer, index) => (
            <Text key={offer.url} color={index === cursor ? theme.bg : undefined} backgroundColor={index === cursor ? theme.accent : undefined}>
              {` ${index === cursor ? "›" : " "} ${offerTitle(offer)}${offer.repoUrl ? "" : " · no repoUrl"}`}
            </Text>
          ))}
          <Text> </Text>
          <Dim>{"↑↓ select · enter choose · esc cancel"}</Dim>
        </>
      )}
      {phase.step === "location" && (
        <>
          {phase.offer.repoUrl ? (
            <>
              <Text>clone where?</Text>
              <Text> </Text>
              <Text color={theme.accent}>{phase.pathBuf}</Text><Text color={theme.dim}>▊</Text>
              <Text> </Text>
              <Dim>enter clone here · esc back</Dim>
            </>
          ) : (
            <>
              <Text>This handoff predates repoUrl — no clone URL is known.</Text>
              <Text>{offerTitle(phase.offer)}</Text>
              <Text> </Text>
              <Text color={theme.accent}>path of the already-cloned repo (or a git URL): </Text><Text>{phase.pathBuf}</Text><Text color={theme.dim}>▊</Text>
              <Text> </Text>
              <Dim>enter continue (pull + seeded session only) · esc back</Dim>
            </>
          )}
        </>
      )}
      {phase.step === "working" && (
        <>
          <Text>{phase.label}…</Text>
          <Text> </Text>
          <Dim>{"this may take a moment"}</Dim>
        </>
      )}
      {phase.step === "error" && (
        <>
          <Text color={theme.warn}>{phase.message}</Text>
          <Text> </Text>
          <Dim>{"enter/esc back to the offers · nothing was half-done beyond the clone"}</Dim>
        </>
      )}
    </Dialog>
  );
}
