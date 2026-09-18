/**
 * The blocking pre-send confirmation modal (ADR-0033 §4, #791): an
 * extension asked the user to confirm a turn before it is sent — the
 * anti-injection guardrail above its threshold, in practice. The core's
 * turn loop is suspended while this is up, and *nothing* has been logged
 * yet: cancelling means the turn never happened.
 *
 * Two answers only, because there is nothing to grant: `[send anyway]`
 * proceeds and records the confirmation, `[cancel]` returns the text to
 * the composer and records the cancellation. Neither writes a rule — an
 * extension can never be disarmed by an answer to its own question.
 */
import React, { useSyncExternalStore } from "react";
import { Text, useInput } from "ink";
import { useTheme } from "./themes";
import { Dialog, Dim, truncate } from "./ui";
import { sanitizeForDisplay } from "./render-sanitize";
import type { ConfirmTurnGate } from "./confirm-turn-gate";

export function ConfirmTurnModal({ gate }: { gate: ConfirmTurnGate }) {
  const theme = useTheme();
  useSyncExternalStore(gate.subscribe, gate.getSnapshot);
  const current = gate.current;

  useInput((input, key) => {
    if (!current) return;
    if (input === "y" || key.return) return gate.resolve("send");
    if (input === "n" || key.escape) return gate.resolve("cancel");
  });

  if (!current) return null;

  const { reason, by, text } = current.request;
  return (
    <Dialog title=" ⚠ possible injection " color={theme.warn}>
      <Text>{`${by}: ${sanitizeForDisplay(reason)}`}</Text>
      <Text> </Text>
      <Dim>This message may be trying to steer the agent. Nothing has been sent yet.</Dim>
      <Text wrap="truncate-end">{truncate(sanitizeForDisplay(text), 200)}</Text>
      <Text> </Text>
      <Text>
        <Text color={theme.ok}>[y] send anyway</Text>
        {"   "}
        <Text color={theme.err}>[n] cancel</Text>
      </Text>
      <Text> </Text>
      <Dim>Cancelling returns the text to the composer and sends nothing.</Dim>
    </Dialog>
  );
}
