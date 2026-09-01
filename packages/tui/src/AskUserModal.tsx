import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Text, useInput } from "ink";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";
import { dialogWidth, useViewport } from "./viewport";
import type { AskUserGate } from "./ask-user-gate";
import type { AskUserAnswer, AskUserQuestion, AskUserSetResult } from "@moh/core";
import { sanitizeForDisplay } from "./render-sanitize";

/**
 * TRANSITIONAL renderer for the ADR-0019 question set (#411): keeps the
 * blocking Dialog while the core contract has widened to 1–4 questions.
 * The questions of one set are answered one at a time; "Other" free text
 * is available for every question; the last question's confirm releases
 * the whole set. multiSelect questions select the focused option on Enter
 * (full multi-select interaction, tab navigation, summary, and cancel
 * land with the inline rendering, #412 — this stopgap exists so the core
 * seam can ship and be tested end-to-end). The old "esc = suggested"
 * behavior is already gone: esc cancels the set.
 *
 * Keys: ↑/↓ move, enter confirms, tab switches to free text, esc cancels
 * the whole set.
 */
export function AskUserModal({ gate }: { gate: AskUserGate }) {
  const theme = useTheme();
  const viewport = useViewport();
  useSyncExternalStore(gate.subscribe, gate.getSnapshot);
  const set = gate.current;
  const questions = set?.questions ?? [];
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<AskUserAnswer[]>([]);
  const [selected, setSelected] = useState(0);
  const [textMode, setTextMode] = useState(false);
  const [text, setText] = useState("");

  const question: AskUserQuestion | undefined = questions[index];

  // New set → reset all navigation and collection state.
  useEffect(() => {
    setIndex(0);
    setAnswers([]);
    setSelected(0);
    setTextMode(false);
    setText("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate.version]);

  const settle = (result: AskUserSetResult) => gate.resolve(result);

  const confirm = (answer: AskUserAnswer) => {
    if (!question) return;
    const next = [...answers];
    next[index] = answer;
    setAnswers(next);
    if (index + 1 < questions.length) {
      setIndex(index + 1);
      setSelected(0);
      setTextMode(false);
      setText("");
    } else {
      settle({ answers: next });
    }
  };

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
        if (value) confirm({ other: value });
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
    if (key.escape) return settle({ answers: [], cancelled: true });
    if (key.tab) return setTextMode(true);
    if (key.return) return confirm({ labels: [question.options[selected]!.label] });
    if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow) {
      setTextMode(true);
      setText(input);
    }
  });

  if (!question) return null;

  return (
    <Dialog title={` ${question.header} (${index + 1}/${questions.length}) `} color={theme.purple} width={dialogWidth(viewport)}>
      <Text bold>{sanitizeForDisplay(question.question)}</Text>
      <Text> </Text>
      {question.options.map((option, i) => {
        const isSuggested = option.label === question.suggested;
        const isSelected = i === selected;
        const line = `${isSelected ? ">" : " "} ${i + 1}  ${sanitizeForDisplay(option.label)}${
          isSuggested ? "  ← suggested" : ""
        } — ${sanitizeForDisplay(option.description)}`;
        return (
          <Text key={option.label} color={isSelected ? theme.accent : undefined} bold={isSuggested && !isSelected}>
            {line}
          </Text>
        );
      })}
      {question.multiSelect ? <Dim>{"  multi-select"}</Dim> : null}
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
          : " ↑↓/enter choose · tab free text · esc cancel the set"}
      </Dim>
    </Dialog>
  );
}
