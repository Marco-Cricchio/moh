import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Text, useInput } from "ink";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";
import type { AskUserGate } from "./ask-user-gate";

/**
 * The blocking ask_user overlay (issue #70 / style guide §8): the question
 * with up to 4 options, the suggested answer visually distinct, arrow /
 * number navigation, and a free-text answer always available. The turn
 * loop is suspended in the core while this overlay is up.
 *
 * Keys: ↑/↓ move, 1–4 pick an option, enter confirms (option in option
 * mode, text in text mode), any printable character except the digits
 * 1–4 (option shortcuts) switches to free text — press tab first to type
 * an answer that starts with a digit. Tab toggles modes, esc answers
 * with the suggested option.
 */
export function AskUserModal({ gate, compact }: { gate: AskUserGate; compact: boolean }) {
  const theme = useTheme();
  useSyncExternalStore(gate.subscribe, gate.getSnapshot);
  const question = gate.current;
  // Default selection = the suggested option; resets whenever a new
  // question arrives (the gate's version bumps).
  const suggestedIndex = question
    ? Math.max(0, question.options.findIndex((o) => o.label === question.suggested))
    : 0;
  const [selected, setSelected] = useState(suggestedIndex);
  const [textMode, setTextMode] = useState(false);
  const [text, setText] = useState("");

  // New question → reset the picker to the suggested option.
  useEffect(() => {
    setSelected(suggestedIndex);
    setTextMode(false);
    setText("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate.version]);

  useInput((input, key) => {
    if (!question) return;
    if (textMode) {
      if (key.escape) {
        setTextMode(false);
        setText("");
        return;
      }
      if (key.tab) {
        setTextMode(false);
        return;
      }
      if (key.return) {
        const value = text.trim();
        if (value) return gate.resolve({ text: value });
        return; // empty text: nothing to submit
      }
      if (key.backspace || key.delete) {
        setText((t) => t.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) setText((t) => t + input);
      return;
    }
    const count = question.options.length;
    if (key.upArrow) return setSelected((s) => (s - 1 + count) % count);
    if (key.downArrow) return setSelected((s) => (s + 1) % count);
    if (key.escape) return gate.resolve({ choice: question.suggested });
    if (key.tab) return setTextMode(true);
    if (input >= "1" && input <= "4" && Number(input) <= count) {
      return gate.resolve({ choice: question.options[Number(input) - 1]!.label });
    }
    if (key.return) return gate.resolve({ choice: question.options[selected]!.label });
    if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow) {
      setTextMode(true);
      setText(input);
    }
  });

  if (!question) return null;

  return (
    <Dialog title=" question " color={theme.purple} width={compact ? "100%" : "62%"}>
      <Text bold>{question.question}</Text>
      <Text> </Text>
      {question.options.map((option, i) => {
        const isSuggested = option.label === question.suggested;
        const isSelected = i === selected;
        const line = `${isSelected ? ">" : " "} ${i + 1}  ${option.label}${
          isSuggested ? "  ← suggested" : ""
        } — ${option.description}`;
        return (
          <Text key={option.label} color={isSelected ? theme.accent : undefined} bold={isSuggested && !isSelected}>
            {line}
          </Text>
        );
      })}
      <Text> </Text>
      <Text>
        {textMode ? (
          <Text>
            <Text color={theme.accent}>{"> "}</Text>
            <Text underline>{text || " "}</Text>
          </Text>
        ) : (
          <Dim>{"  or type your answer"}</Dim>
        )}
      </Text>
      <Text> </Text>
      <Dim>
        {textMode
          ? " enter send · tab back to options · esc discard text"
          : " ↑↓/1-4 choose · enter confirm · esc suggested · tab free text (digits: tab first)"}
      </Dim>
    </Dialog>
  );
}
