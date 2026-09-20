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
 * its refusals (a use case this session cannot run). A refusal is shown as
 * a refusal, never silently swallowed and never as a state change.
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
 * What one flip did, in the user's words.
 *
 * `before` and `after` are the extension's own state on either side of the
 * command — the extension is the only thing that decides, so the answer is
 * read from the *move*, never from a single glance: a state that did not
 * move is a refusal (the one this surface can still produce is a use case
 * this session cannot run at all), a state that moved is the change, and
 * the asymmetry against the config rides along because the next session
 * goes back to it.
 *
 * The two reads must be the state *after* the command had its chance:
 * `setExtensionState` appends the event and dispatches it asynchronously, so
 * a state read in the same tick as the send is still the old one — the
 * caller's job (see `flip`), not this function's.
 */
export function flipOutcome(usecase: JevUseCase, action: JevUseCaseAction, before: JevUseCaseState, after: JevUseCaseState): string {
  if (after.status === before.status) {
    if (after.status === "inert") return `${usecase}: refused — not available in this session`;
    return `${usecase}: not applied — the extension kept it ${after.status}`;
  }
  if (after.sessionOnly) {
    const why = after.note ?? `the config still says ${after.config ? "on" : "off"}`;
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
   * Reads the state again after a short beat, and hands what it read to the
   * caller. The control channel is asynchronous on purpose (the event is
   * appended, then dispatched), so a read taken in the same tick as the send
   * is still the state that *preceded* the command — the answer lands one
   * dispatch later.
   */
  const reread = useCallback(
    (delay: number, onRead?: (snapshot: JevUseCaseSnapshot) => void) => {
      timers.current.push(
        setTimeout(() => {
          const next = readJevState(read);
          if (!next) return;
          setSnapshot(next);
          onRead?.(next);
        }, delay),
      );
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
      // The answer belongs to the extension, and it arrives one dispatch
      // later — so nothing is claimed from the state the command was sent
      // against. The first beat reads what the command did; only if the
      // state has still not moved does a second, later read call it a
      // refusal. A refusal and a slow host look identical at the first beat,
      // and the difference is one the user can see.
      const settle = (next: JevUseCaseSnapshot): boolean => {
        setSnapshot(next);
        if (next[usecase].status === before.status) return false;
        setMessage(flipOutcome(usecase, action, before, next[usecase]));
        return true;
      };
      reread(0, (next) => {
        if (settle(next)) return;
        reread(60, (second) => {
          if (settle(second)) return;
          setMessage(flipOutcome(usecase, action, before, second[usecase]));
        });
      });
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
