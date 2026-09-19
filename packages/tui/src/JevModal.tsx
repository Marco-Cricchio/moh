import React, { useCallback, useEffect, useRef, useState } from "react";
import { Text, useInput } from "ink";
import { JEV_USE_CASES, type JevUseCase, type JevUseCaseAction, type JevUseCaseSnapshot, type JevUseCaseState } from "@moh/jev-guard";
import { useTheme } from "./themes";
import { Dialog, Dim, Footer, truncate } from "./ui";
import { readJevState, type ExtensionStateReader } from "./jev-control";

/**
 * The Jev use-case modal (#833): `/jev` from chat. One row per use case with
 * the **live** status the extension reports (#832) — `on`, `off`, `paused`,
 * `inert` — plus what the configuration says, because the two are different
 * things: a flip here is session-warm, the config is what the next session
 * starts in.
 *
 * The modal owns no state of its own beyond the cursor and the last line: it
 * sends the extension's own command and re-reads the extension's own
 * snapshot, so what is on screen is what the extension thinks — including
 * its refusals (a guardrail `off` in yolo, a use case this session cannot
 * run). A refusal is shown as a refusal, never silently swallowed and never
 * as a state change.
 */
export interface JevModalProps {
  /**
   * True when the bundled extension is registered at all (a stored API key).
   * Without it there is no state to read and no command to send — the modal
   * becomes the way to the Settings entry instead of an error.
   */
  active: boolean;
  /** The extension's `state` reader (the session's own seam). */
  read?: ExtensionStateReader;
  /** The command seam (the session's ADR-0038 channel). */
  send?: (usecase: JevUseCase, action: JevUseCaseAction) => void;
  onClose: () => void;
}

/** The status glyph: scannable without reading the word. */
const STATUS_GLYPH: Record<string, string> = { on: "●", off: "○", paused: "❙❙", inert: "—" };

const NAME_COL = 16;
const STATUS_COL = 9;

/**
 * What one flip did, in the user's words. The extension is the source of
 * truth (it answers with its state), so this reads the state it left behind:
 * a status that did not move is a refusal, and the two refusals this surface
 * can produce have exactly one cause each — the guardrail in yolo, and a use
 * case this session cannot run at all.
 */
export function flipOutcome(usecase: JevUseCase, action: JevUseCaseAction, state: JevUseCaseState): string {
  if (usecase === "guardrail" && action === "off" && state.status === "on") {
    return "guardrail: off refused — yolo keeps the lethal checks on";
  }
  if (state.status === "inert") return `${usecase}: refused — not available in this session`;
  if (state.sessionOnly) {
    const why = state.note ?? `the config still says ${state.config ? "on" : "off"}`;
    return `${usecase}: ${action} for this session — ${why}`;
  }
  return `${usecase}: ${action} for this session`;
}

/** One row's right-hand text: the extension's note, or the config contrast. */
function rowDetail(state: JevUseCaseState): string {
  const config = `config ${state.config ? "on" : "off"}`;
  return state.note !== undefined ? `${config} · ${state.note}` : config;
}

/**
 * The asymmetry line under a row whose state a session command moved: the
 * config is not what it looks like from here, and the next session goes back
 * to it. `null` when there is nothing session-only to say (the config is
 * where the state is, or the extension gave its own note in the row).
 */
export function sessionOnlyNote(state: JevUseCaseState): string | null {
  if (!state.sessionOnly || state.note !== undefined) return null;
  return `${state.status === "on" ? "on" : "off"} for this session — the config still says ${state.config ? "on" : "off"}`;
}

export function JevModal({ active, read, send, onClose }: JevModalProps) {
  const theme = useTheme();
  const [cursor, setCursor] = useState(0);
  const [snapshot, setSnapshot] = useState<JevUseCaseSnapshot | null>(() => readJevState(read));
  const [message, setMessage] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
  }, []);

  const refresh = useCallback(() => {
    setSnapshot(readJevState(read));
  }, [read]);

  /**
   * Reads the state again after a short beat. The control channel is
   * asynchronous on purpose (the event is appended, then dispatched), so an
   * immediate re-read can still see the state the command is about to
   * change — the answer lands one dispatch later. Two beats cover a slow
   * host without ever holding the modal open on a timer of its own.
   */
  const reread = useCallback(
    (delays: number[]) => {
      for (const delay of delays) {
        timers.current.push(
          setTimeout(() => {
            const next = readJevState(read);
            if (next) setSnapshot(next);
          }, delay),
        );
      }
    },
    [read],
  );

  const flip = useCallback(
    (usecase: JevUseCase) => {
      const before = snapshot?.[usecase];
      if (!before) return;
      // The only two directions: a use case that judges is switched off, and
      // anything else is switched on (`paused` included: routing's `on`
      // resumes it and hands an override back).
      const action: JevUseCaseAction = before.status === "on" ? "off" : "on";
      send?.(usecase, action);
      const after = readJevState(read);
      if (after) setSnapshot(after);
      setMessage(flipOutcome(usecase, action, after?.[usecase] ?? before));
      // The extension answers the command by leaving its state where the
      // command put it: read it back once it had the chance.
      reread([0, 40]);
    },
    [snapshot, read, send, reread],
  );

  useInput((input, key) => {
    if (key.escape) return onClose();
    if (key.upArrow || input === "k") return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow || input === "j") return setCursor((c) => Math.min(JEV_USE_CASES.length - 1, c + 1));
    if (input === "r") return refresh();
    if (key.return || input === " ") return flip(JEV_USE_CASES[cursor]!);
  });

  const statusColor = (status: string) =>
    status === "on" ? theme.ok : status === "off" ? theme.muted : status === "paused" ? theme.warn : theme.dim;

  if (!active) {
    return (
      <Dialog title=" jev " color={theme.purple} width="60%">
        <Text> Jev is not active in this session.</Text>
        <Text> </Text>
        <Text>A stored API key is what activates it — there is no separate toggle:</Text>
        <Text color={theme.accent}> settings (ctrl+s) → Jev (TypeSafe) → API key</Text>
        <Text> </Text>
        <Dim>Nothing is registered without it, so there is nothing here to switch.</Dim>
        <Text> </Text>
        <Dim>esc close</Dim>
      </Dialog>
    );
  }

  return (
    <Dialog title=" jev use cases " color={theme.purple} width="72%">
      <Dim>this session only — the Settings entry is what the next session starts in</Dim>
      <Text> </Text>
      {snapshot === null && <Dim> the extension is still starting — no state to read yet (r tries again)</Dim>}
      {snapshot !== null &&
        JEV_USE_CASES.map((usecase, i) => {
          const state = snapshot[usecase];
          const selected = i === cursor;
          const color = statusColor(state.status);
          const asymmetry = sessionOnlyNote(state);
          return (
            <React.Fragment key={usecase}>
              <Text>
                <Text color={selected ? theme.accent : theme.fg} bold={selected}>
                  {selected ? "› " : "  "}
                  {usecase.padEnd(NAME_COL)}
                </Text>
                <Text color={color}>
                  {`${STATUS_GLYPH[state.status] ?? "?"} ${state.status.padEnd(STATUS_COL)}`}
                </Text>
                <Dim>{truncate(rowDetail(state), 42)}</Dim>
              </Text>
              {asymmetry !== null && <Dim>{`      ${asymmetry}`}</Dim>}
            </React.Fragment>
          );
        })}
      <Text> </Text>
      {message !== null && <Text color={theme.accent}> {message}</Text>}
      {message !== null && <Text> </Text>}
      <Footer keys="↑↓ move · enter/space flip · r refresh · esc close" />
    </Dialog>
  );
}
