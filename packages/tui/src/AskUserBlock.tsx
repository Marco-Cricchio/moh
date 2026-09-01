import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "./themes";
import { Dim } from "./ui";
import type { AskUserGate } from "./ask-user-gate";
import type { AskUserAnswer, AskUserQuestion, AskUserSetResult } from "@moh/core";
import { sanitizeForDisplay } from "./render-sanitize";
import { PreviewBox } from "./PreviewBox";

/**
 * Inline ask_user rendering (ADR-0019 / #412): no modal, no blocking
 * Dialog — the block lives between the composer text area and bottom-bar
 * row 1 (one blank line of padding above and below), one question at a
 * time. ↑/↓ moves through options (plus "Other", always last, reachable
 * by arrows or by typing), tab moves to the next question (from the
 * summary it goes back to edit the last one), a final summary screen
 * collects everything before submit; Enter advances. multiSelect: space
 * toggles, Enter confirms (Enter toggles while nothing is selected yet).
 * Esc navigates back a question; from the summary, an explicit cancel
 * (ctrl+x) aborts the set with a "cancelled" tool result (the old
 * esc=suggested behavior is gone — `suggested` renders as a visual chip
 * only).
 */
type Focused = { option: number } | { other: true };

/** One option row, shared by the stacked and the side-by-side layout
 * (#414): the side-by-side left panel omits descriptions (they would
 * crowd the narrow column) and keeps one label per row. */
function PreviewOptionRow({
  question,
  option,
  index,
  focused,
  selected,
  sideBySide,
}: {
  question: AskUserQuestion;
  option: { label: string; description: string };
  index: number;
  focused: Focused;
  selected: string[];
  sideBySide?: boolean;
}) {
  const theme = useTheme();
  const isFocused = "option" in focused && focused.option === index;
  const checked = question.multiSelect && selected.includes(option.label);
  const isSuggested = option.label === question.suggested;
  const marker = question.multiSelect ? (checked ? "[x]" : "[ ]") : isFocused ? "›" : " ";
  return (
    <Box>
      <Text color={isFocused ? theme.accent : theme.fg} bold={isFocused}>
        {`${marker} ${index + 1} ${sanitizeForDisplay(option.label)}`}
      </Text>
      {isSuggested && <Text color={theme.warn}>{" ◂ recommended"}</Text>}
      {!sideBySide && <Text color={theme.dim}>{` — ${sanitizeForDisplay(option.description)}`}</Text>}
    </Box>
  );
}


/** Preview content rows a preview box may show before truncating (#414):
 * keeps an extreme preview from consuming the whole block; the row
 * reservation in askUserBlockRows uses the same ceiling. */
export const PREVIEW_ROW_CAP = 20;

/** Whether a question renders side-by-side (#414): only when any option
 * carries a preview — plain questions keep the classic stacked layout. */
function hasPreview(question: AskUserQuestion): boolean {
  return question.options.some((o) => o.preview !== undefined);
}

/** The block's row budget for one question screen (#413): question rows
 * contribute the tallest single screen (header chip + question text +
 * one row per option + the Other row + footer), the summary screen shows
 * one row per question. #414: a preview-bearing question renders
 * side-by-side, favoring height — its screen reserves the tallest
 * preview box (content rows + 2 borders + the truncation indicator).
 * Blank-line padding above and below (the +3) is part of the block
 * itself. Shared with Chat so the transcript-compression arithmetic and
 * the layout stay in one place. */
export function askUserBlockRows(
  questions: ReadonlyArray<{ question: string; options: ReadonlyArray<{ preview?: string }> }>,
): number {
  const previewRows = (q: { options: ReadonlyArray<{ preview?: string }> }): number => {
    if (!q.options.some((o) => o.preview !== undefined)) return 0;
    // Longest preview line budget: each rendered preview row, clamped to
    // the box's truncation ceiling so the reservation matches the render.
    return Math.min(
      PREVIEW_ROW_CAP,
      Math.max(...q.options.map((o) => (o.preview ? o.preview.split("\n").length : 1))),
    ) + 3; // top border + bottom border + truncation indicator
  };
  const questionScreens = questions.map((q) => q.options.length + 5 + previewRows(q));
  return Math.max(...questionScreens, questions.length + 4) + 3;
}

const FOOTER = " ↑↓ options · enter/tab next question";const FOOTER_MULTI = " space toggle · enter confirm · tab next";
const FOOTER_OTHER = " enter/tab send · esc back to options";
const FOOTER_SUMMARY = " enter submit · tab edit · esc back";
const FOOTER_SUMMARY_FIRST = " enter submit · esc back · ctrl+x cancel";

export function AskUserBlock({ gate, width }: { gate: AskUserGate; width?: number }) {
  const theme = useTheme();
  const blockWidth = Math.max(40, width ?? 100);
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
      if (key.return || key.tab) {
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
    // tab advances to the next question / summary (ADR-0019 §2), carrying
    // the current answer: focused option, toggled multiSelect labels, or
    // the typed free text.
    if (key.tab) {
      if ("other" in focused) {
        const value = text.trim();
        if (value) next([...answers.slice(0, index), { other: value }]);
      } else if (question.multiSelect) {
        if (selected.length > 0) next([...answers.slice(0, index), { labels: selected }]);
        else setSelected((s) => [...s, question.options[focused.option]!.label]);
      } else {
        next([...answers.slice(0, index), { labels: [question.options[focused.option]!.label] }]);
      }
      return;
    }
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
          {/* #414: preview-bearing questions render side-by-side — the
              option list on the left, the focused option's preview in a
              bordered box on the right. Plain questions stack as before. */}
          {hasPreview(question) ? (
            <Box flexDirection="row" gap={2}>
              <Box flexDirection="column" width={Math.min(32, Math.max(20, Math.floor((blockWidth - 4) * 0.4)))}>
                {question.options.map((option, i) => (
                  <PreviewOptionRow key={option.label} question={question} option={option} index={i} focused={focused} selected={selected} sideBySide />
                ))}
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
              </Box>
              <Box flexDirection="column">
                {"option" in focused && question.options[focused.option]?.preview !== undefined ? (
                  <PreviewBox
                    content={question.options[focused.option]!.preview!}
                    maxLines={PREVIEW_ROW_CAP}
                    minWidth={Math.max(20, Math.floor((blockWidth - 4) * 0.4))}
                    maxWidth={blockWidth - 4 - Math.min(32, Math.max(20, Math.floor((blockWidth - 4) * 0.4))) - 2}
                  />
                ) : (
                  <Text color={theme.dim}> </Text>
                )}
              </Box>
            </Box>
          ) : (
            <>
              {question.options.map((option, i) => (
                <PreviewOptionRow key={option.label} question={question} option={option} index={i} focused={focused} selected={selected} />
              ))}
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
            </>
          )}
          <Text> </Text>
          <Dim>{textMode ? FOOTER_OTHER : question.multiSelect ? FOOTER_MULTI : FOOTER}</Dim>
        </Box>
      )}
      <Text> </Text>
    </Box>
  );
}
