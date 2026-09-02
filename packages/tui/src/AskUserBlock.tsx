import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "./themes";
import { Dim } from "./ui";
import type { AskUserGate } from "./ask-user-gate";
import type { AskUserAnswer, AskUserQuestion, AskUserSetResult } from "@moh/core";
import { sanitizeForDisplay } from "./render-sanitize";
import { PreviewBox } from "./PreviewBox";

/**
 * Inline ask_user rendering (ADR-0019 / #412, redesigned #426): no modal,
 * no blocking Dialog — the block lives between the composer text area and
 * bottom-bar row 1 (one blank line of padding above and below), one
 * question at a time.
 *
 * Layout A (width ≥ COMPACT_WIDTH): a rounded-border panel whose top row
 * carries one tab-chip per question (✓ answered, ❯ current inverted,
 * pending dim) plus a right-aligned N/M counter. Layout C (narrow): no
 * border, no tab row, no side-by-side preview — a compact ▌header N/M
 * with numbered options.
 *
 * Keys: ↑/↓ moves through options (plus "Other", always last), tab/enter
 * advance, esc navigates back; a final summary screen collects everything
 * before submit. multiSelect: space toggles, Enter confirms. ctrl+x from
 * the summary cancels the set ("cancelled" tool result; `suggested`
 * renders as a visual chip only).
 */
type Focused = { option: number } | { other: true };

/** Below this width the panel regresses to the compact borderless layout
 * (#426): the border + chip row + side-by-side preview would leave too
 * little usable width. */
export const ASK_COMPACT_WIDTH = 72;

/** Indent of description lines under an option row (#426): one space per
 * border column, one padding space, the marker column, one space — the
 * description text starts exactly under the option label. */
const DESC_INDENT_A = "      "; // "│ " + "❯ 1 " → label column
const DESC_INDENT_C = "     ";  // "❯ 1 " under the ▌header layout

/** Preview content rows a preview box may show before truncating (#414):
 * keeps an extreme preview from consuming the whole block; the row
 * reservation in askUserBlockRows uses the same ceiling. */
export const PREVIEW_ROW_CAP = 20;

/** Manual word-wrap to a width (grapheme-safe for our purposes: splits on
 * spaces only, never mid-word — the terminal's own wrap is what produced
 * the mid-word breaks of the old single-line rows). */
function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += " " + word;
    else { lines.push(current); current = word; }
    while (current.length > width) { // pathological unbreakable word
      lines.push(current.slice(0, width));
      current = current.slice(width);
    }
  }
  lines.push(current);
  return lines;
}

/** Whether a question renders side-by-side (#414): only when any option
 * carries a preview — plain questions keep the stacked layout. */
function hasPreview(question: AskUserQuestion): boolean {
  return question.options.some((o) => o.preview !== undefined);
}

/** The block's row budget for one question screen (#413, #426): the
 * bordered panel adds 2 border rows; the tallest screen wins — question
 * screen (1 blank + border + chip row + divider + question rows +
 * per-option rows with wrapped descriptions + Other row + border +
 * 1 blank) or the summary screen. #414: a preview-bearing question
 * renders side-by-side (labels only), its screen reserves the tallest
 * preview box. Shared with Chat so the transcript-compression
 * arithmetic and the layout stay in one place. */
export function askUserBlockRows(
  questions: ReadonlyArray<{ question: string; options: ReadonlyArray<{ preview?: string }> }>,
  width?: number,
): number {
  const compact = width !== undefined && width < ASK_COMPACT_WIDTH;
  const chrome = (compact ? 0 : 2) + 2; // panel borders (A) + blank padding
  const previewRows = (q: { options: ReadonlyArray<{ preview?: string }> }): number => {
    if (compact || !q.options.some((o) => o.preview !== undefined)) return 0;
    return Math.min(
      PREVIEW_ROW_CAP,
      Math.max(...q.options.map((o) => (o.preview ? o.preview.split("\n").length : 1))),
    ) + 3; // top border + bottom border + truncation indicator
  };
  const inner = Math.max(50, (width ?? 100) - 6);
  const questionScreens = questions.map((q) => {
    const head = compact ? 2 : 4; // ▌header N/M + question  |  blank + border + chip + divider
    const question = wrapText(q.question, inner).length + (compact ? 0 : 1); // + blank after question (A)
    const options = q.options.length + 1; // + Other
    if (!compact && q.options.some((o) => o.preview !== undefined)) {
      // side-by-side: one row per option (label only), no descriptions
      return head + wrapText(q.question, inner).length + options + previewRows(q) + chrome;
    }
    const descriptions = q.options.reduce((sum, o) => {
      const desc = "description" in o ? String((o as { description?: string }).description ?? "") : "";
      return sum + wrapText(desc, inner - DESC_INDENT_A.trim().length - 1).length;
    }, 0);
    return head + question + options + descriptions + 1 + chrome; // + footer
  });
  return Math.max(...questionScreens, questions.length + 5 + chrome) + 1; // summary screen + footer line
}

const FOOTER = " ↑↓ options · enter/tab next question";
const FOOTER_MULTI = " space toggle · enter confirm · tab next";
const FOOTER_OTHER = " enter/tab send · esc back to options";
const FOOTER_SUMMARY = " enter submit · tab edit · esc back";
/** Shown when the summary was reached from question 1 — i.e. a
 * single-question set: esc goes straight back with nothing to re-edit,
 * so the explicit cancel affordance belongs here. */
const FOOTER_SUMMARY_FIRST = " enter submit · esc back · ctrl+x cancel";
const FOOTER_C = " ↑↓ · enter/tab next";

/** One summary row's answer text: selected labels plus a trailing
 * `Other: …` when free text was given (shared by both layouts). */
function answerText(a: AskUserAnswer | undefined): string {
  if (!a) return "";
  return [...(a.labels ?? []), ...(a.other !== undefined ? [`Other: ${a.other}`] : [])].join(", ");
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

export function AskUserBlock({ gate, width }: { gate: AskUserGate; width?: number }) {
  const theme = useTheme();
  const blockWidth = Math.max(40, width ?? 100);
  const compact = blockWidth < ASK_COMPACT_WIDTH;
  const panelWidth = blockWidth - 2; // one space of margin each side
  const innerWidth = panelWidth - 4;  // "│ " + content + " │"
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

  const optionRows = (descWidth: number, sideBySide: boolean, descIndent: string) =>
    question.options.map((option, i) => {
      const isFocused = "option" in focused && focused.option === i;
      const checked = question.multiSelect && selected.includes(option.label);
      const isSuggested = option.label === question.suggested;
      const marker = question.multiSelect ? (checked ? "[x]" : "[ ]") : isFocused ? "❯ " : "  ";
      const number = question.multiSelect ? "  " : `${i + 1} `;
      const label = sanitizeForDisplay(option.label);
      const desc = sideBySide ? [] : wrapText(sanitizeForDisplay(option.description ?? ""), descWidth);
      return (
        <React.Fragment key={option.label}>
          <Text>
            <Text color={isFocused ? theme.accent : theme.fg} bold={isFocused}>
              {`${marker}${number}${label}`}
            </Text>
            {isSuggested && <Text color={theme.warn}>{" ◂"}</Text>}
          </Text>
          {desc.length > 0 && desc.map((line, j) => (
            <Text key={`${option.label}-desc-${j}`} color={isFocused ? theme.muted : theme.dim}>{`${descIndent}${line}`}</Text>
          ))}
        </React.Fragment>
      );
    });

  // ——— Layout C (narrow terminals): borderless, compact ———
  if (compact) {
    return (
      <Box flexDirection="column">
        <Text> </Text>
        {summary ? (
          <Box flexDirection="column">
            <Text bold color={theme.purple}>Review your answers</Text>
            {questions.map((q, i) => {
              const a = answers[i];
              const value = answerText(a);
              return (
                <Text key={q.question}>
                  <Text bold>{`${sanitizeForDisplay(q.header)}: `}</Text>
                  <Text color={theme.fg}>{sanitizeForDisplay(value)}</Text>
                </Text>
              );
            })}
            <Text> </Text>
            <Dim>{FOOTER_SUMMARY_FIRST}</Dim>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text>
              <Text backgroundColor={theme.purple} color={theme.bg} bold>{` ${sanitizeForDisplay(question.header)} `}</Text>
              <Text color={theme.dim}>{` ${index + 1}/${questions.length}`}</Text>
            </Text>
            <Text bold>{sanitizeForDisplay(question.question)}</Text>
            {optionRows(innerWidth - DESC_INDENT_C.length - 2, false, DESC_INDENT_C)}
            <Text>
              {textMode ? (
                <>
                  <Text color={theme.accent}>{"❯ … "}</Text>
                  <Text underline>{text || " "}</Text>
                </>
              ) : (
                <Text color={"other" in focused ? theme.accent : theme.dim} bold={"other" in focused}>  … Other</Text>
              )}
            </Text>
            <Text> </Text>
            <Dim>{textMode ? FOOTER_OTHER : FOOTER_C}</Dim>
          </Box>
        )}
        <Text> </Text>
      </Box>
    );
  }

  // ——— Layout A (default): bordered panel with tab-chips ———
  const chipRow = questions
    .map((q, i) => {
      const answered = i < answers.length && answers[i] !== undefined;
      const current = i === index && !summary;
      const label = sanitizeForDisplay(q.header);
      return current ? `❯ ${label} ` : answered ? `✓ ${label} ` : `  ${label} `;
    })
    .join("·");

  const otherRow = (
    <Text>
      {textMode ? (
        <>
          <Text color={theme.accent}>{"❯ … "}</Text>
          <Text underline>{text || " "}</Text>
        </>
      ) : (
        <Text color={"other" in focused ? theme.accent : theme.dim} bold={"other" in focused}>{"  … Other"}</Text>
      )}
    </Text>
  );

  // Byte-exact chip row (#426): chips left, counter flush right — pad with
  // exactly the spaces the inner width leaves, truncating chips (never the
  // counter) when the headers are too wide to fit. innerWidth (panelWidth-4)
  // is the exact text area inside borders+padding: " " + chips + " " +
  // counter fills it with no slack, verified byte-exact in the PTY probe.
  const counter = `${index + 1}/${questions.length}`;
  // chipLine (with its leading space in the render) fills innerWidth: the
  // divider is the reference — same leading space, same width.
  const chipsBudget = innerWidth - 3 - counter.length;
  const chips = chipRow.length > chipsBudget
    ? chipRow.slice(0, Math.max(0, chipsBudget - 1)).trimEnd() + "…"
    : chipRow.padEnd(chipsBudget, " ");
  const chipLine = `${chips} ${counter}`;
  const divider = "─".repeat(Math.max(0, innerWidth - 2));

  return (
    <Box flexDirection="column">
      <Text> </Text>
      {summary ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingX={1} width={panelWidth}>
          <Text>
            <Text color={theme.dim}>{" "}</Text>
            <Text bold color={theme.purple}>Review your answers</Text>
          </Text>
          {questions.map((q, i) => {
            const a = answers[i];
            const value = answerText(a);
            return (
              <Text key={q.question}>
                <Text bold>{` ✓ ${pad(sanitizeForDisplay(q.header), 12)} — `}</Text>
                <Text color={theme.fg}>{sanitizeForDisplay(value)}</Text>
              </Text>
            );
          })}
        </Box>
      ) : hasPreview(question) ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingX={1} width={panelWidth}>
          <Text>
            <Text color={theme.dim}>{` ${chipLine}`}</Text>
          </Text>
          <Text color={theme.dim}>{` ${divider}`}</Text>
          <Text bold>{` ${sanitizeForDisplay(question.question)}`}</Text>
          <Box flexDirection="row" gap={2} paddingLeft={1}>
            <Box flexDirection="column" width={Math.min(32, Math.max(20, Math.floor((innerWidth - 2) * 0.4)))}>
              {optionRows(0, true, DESC_INDENT_A)}
              {otherRow}
            </Box>
            <Box flexDirection="column">
              {"option" in focused && question.options[focused.option]?.preview !== undefined ? (
                <PreviewBox
                  content={question.options[focused.option]!.preview!}
                  maxLines={PREVIEW_ROW_CAP}
                  minWidth={Math.max(20, Math.floor((innerWidth - 2) * 0.4))}
                  maxWidth={innerWidth - 4 - Math.min(32, Math.max(20, Math.floor((innerWidth - 2) * 0.4))) - 2}
                />
              ) : (
                <Text color={theme.dim}> </Text>
              )}
            </Box>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingX={1} width={panelWidth}>
          <Text>
            <Text color={theme.dim}>{` ${chipLine}`}</Text>
          </Text>
          <Text color={theme.dim}>{` ${divider}`}</Text>
          <Text bold>{` ${sanitizeForDisplay(question.question)}`}</Text>
          <Text> </Text>
          {optionRows(innerWidth - DESC_INDENT_A.length - 6, false, DESC_INDENT_A)}
          {otherRow}
        </Box>
      )}
      <Dim>{summary ? (index === 0 ? FOOTER_SUMMARY_FIRST : FOOTER_SUMMARY) : textMode ? FOOTER_OTHER : question.multiSelect ? FOOTER_MULTI : FOOTER}</Dim>
      <Text> </Text>
    </Box>
  );
}
