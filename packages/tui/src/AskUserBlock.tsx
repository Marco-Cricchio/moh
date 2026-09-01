import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "./themes";
import { Dim } from "./ui";
import type { AskUserGate } from "./ask-user-gate";
import type { AskUserAnswer, AskUserQuestion, AskUserSetResult } from "@moh/core";
import { sanitizeForDisplay } from "./render-sanitize";

/**
 * Inline ask_user rendering (ADR-0019 / #412): no modal, no blocking
 * Dialog — the block lives between the composer text area and bottom-bar
 * row 1 (one blank line of padding above and below), one question at a
 * time. ↑/↓ moves through options (plus "Other", always last, reachable
 * by arrows), tab moves to the next question (enters its free-text input
 * when focused), a final summary screen collects everything before
 * submit; Enter advances. multiSelect: space toggles, Enter confirms
 * (Enter toggles while nothing is selected yet). Esc navigates back a
 * question; from the summary, an explicit cancel aborts the set with a
 * "cancelled" tool result (the old esc=suggested behavior is gone —
 * `suggested` renders as a visual chip only).
 */
type Focused = { option: number } | { other: true };

const FOOTER = " ↑↓ options · tab other · enter next";
const FOOTER_MULTI = " space toggle · enter confirm · tab other";
const FOOTER_OTHER = " enter send · esc back to options";
const FOOTER_SUMMARY = " enter submit · tab edit · esc back";
const FOOTER_SUMMARY_FIRST = " enter submit · esc back · ctrl+x cancel";

export function AskUserBlock({ gate }: { gate: AskUserGate }) {
  const theme = useTheme();
  useSyncExternalStore(gate.subscribe, gate.getSnapshot);
  const set = gate.current;
  const questions = set?.questions ?? [];
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<AskUserAnswer[]>([]);
  const [focused, setFocused] = useState<Focused>({ option: 0 });
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [summary, setSummary] = useState(false);

  const question: AskUserQuestion | undefined = questions[index];
  const textMode = !summary && "other" in focused;

  // New set → reset all navigation and collection state.
  useEffect(() => {
    setIndex(0);
    setAnswers([]);
    setFocused({ option: 0 });
    setSelected([]);
    setText("");
    setSummary(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate.version]);

  const settle = (result: AskUserSetResult) => gate.resolve(result);

  const next = (nextAnswers: AskUserAnswer[]): void => {
    if (index + 1 < questions.length) {
      setIndex(index + 1);
      setAnswers(nextAnswers);
      setFocused({ option: 0 });
      setSelected([]);
      setText("");
    } else {
      setAnswers(nextAnswers);
      setSummary(true);
    }
  };

  const back = (): void => {
    if (summary) {
      setSummary(false);
      return;
    }
    if (index > 0) {
      const prev = index - 1;
      const prevAnswer = answers[prev];
      setIndex(prev);
      setFocused({ option: 0 });
      setSelected(prevAnswer?.labels ?? []);
      setText(prevAnswer?.other ?? "");
    }
  };

  useInput((input, key) => {
    if (!question) return;
    if (summary) {
      if (key.escape || key.tab) return back();
      if (key.ctrl && input === "x") return settle({ answers: [], cancelled: true });
      if (key.return) return settle({ answers });
      return;
    }
    if (textMode) {
      if (key.escape) {
        setFocused({ option: 0 });
        return;
      }
      if (key.return) {
        const value = text.trim();
        if (value) next([...answers.slice(0, index), { other: value }]);
        return; // empty text: nothing to submit
      }
      if (key.backspace || key.delete) {
        setText((t) => t.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) setText((t) => t + input);
      return;
    }
    if (key.upArrow) {
      setFocused((f) => ("option" in f && f.option > 0 ? { option: f.option - 1 } : { other: true }));
      return;
    }
    if (key.downArrow) {
      setFocused((f) =>
        "other" in f ? { option: 0 } : f.option < question.options.length - 1 ? { option: f.option + 1 } : { other: true });
      return;
    }
    if (key.escape) return back();
    if (key.tab) return setFocused({ other: true });
    if (input === " " && key.shift === false && "option" in focused && focused.option < question.options.length) {
      if (question.multiSelect) {
        const label = question.options[focused.option]!.label;
        setSelected((s) => (s.includes(label) ? s.filter((l) => l !== label) : [...s, label]));
      }
      return;
    }
    if (key.return) {
      if ("other" in focused) return; // empty free text on Other
      const label = question.options[focused.option]!.label;
      if (question.multiSelect) {
        // Enter confirms the pending selection; with nothing toggled yet
        // it toggles the focused option (discoverability).
        if (selected.length === 0) setSelected((s) => [...s, label]);
        else next([...answers.slice(0, index), { labels: selected }]);
      } else {
        next([...answers.slice(0, index), { labels: [label] }]);
      }
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setFocused({ other: true });
      setText(input);
    }
  });

  if (!question) return null;

  return (
    <Box flexDirection="column">
      <Text> </Text>
      {summary ? (
        <Box flexDirection="column">
          <Text bold color={theme.purple}>Review your answers</Text>
          {questions.map((q, i) => {
            const a = answers[i];
            const value = a
              ? [...(a.labels ?? []), ...(a.other !== undefined ? [`Other: ${a.other}`] : [])].join(", ")
              : "";
            return (
              <Text key={q.question}>
                <Text bold>{`${sanitizeForDisplay(q.header)}: `}</Text>
                <Text color={theme.fg}>{sanitizeForDisplay(value)}</Text>
              </Text>
            );
          })}
          <Text> </Text>
          <Dim>{index + 1 < questions.length ? FOOTER_SUMMARY : FOOTER_SUMMARY_FIRST}</Dim>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text>
            <Text backgroundColor={theme.purple} color={theme.bg} bold>{` ${sanitizeForDisplay(question.header)} `}</Text>
            <Text color={theme.dim}>{` ${index + 1}/${questions.length}`}</Text>
          </Text>
          <Text bold>{sanitizeForDisplay(question.question)}</Text>
          {question.options.map((option, i) => {
            const isFocused = "option" in focused && focused.option === i;
            const checked = question.multiSelect && selected.includes(option.label);
            const isSuggested = option.label === question.suggested;
            const marker = question.multiSelect ? (checked ? "[x]" : "[ ]") : isFocused ? "›" : " ";
            return (
              <Box key={option.label}>
                <Text color={isFocused ? theme.accent : theme.fg} bold={isFocused}>
                  {`${marker} ${i + 1} ${sanitizeForDisplay(option.label)}`}
                </Text>
                {isSuggested && <Text color={theme.warn}>{" ◂ recommended"}</Text>}
                <Text color={theme.dim}>{` — ${sanitizeForDisplay(option.description)}`}</Text>
              </Box>
            );
          })}
          <Text>
            {textMode ? (
              <>
                <Text color={theme.accent}>{"› Other "}</Text>
                <Text underline>{text || " "}</Text>
              </>
            ) : (
              <Text color={"other" in focused ? theme.accent : theme.dim} bold={"other" in focused}>› Other…</Text>
            )}
          </Text>
          <Text> </Text>
          <Dim>{textMode ? FOOTER_OTHER : question.multiSelect ? FOOTER_MULTI : FOOTER}</Dim>
        </Box>
      )}
      <Text> </Text>
    </Box>
  );
}
