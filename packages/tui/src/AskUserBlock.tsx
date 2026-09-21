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

/** #874: max option rows (options + the Other row) a question screen shows
 * at once. A pathological question (dozens of options, huge wrapped
 * descriptions) once pushed the block past the terminal height, which
 * puts Ink on its fullscreen path — a clear+full-reprint per frame. Past
 * the window the list scrolls internally around the focused option (with
 * ↑ N more / ↓ N more markers), like every other height-aware moh menu. */
export const ASK_MAX_OPTION_ROWS = 12;
/** Each visible option description is bounded too: a single model-provided
 * essay must not defeat the option-window height cap. */
export const ASK_DESCRIPTION_ROW_CAP = 2;

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

/** The visible option-row window around the focused option (#874): at
 * most ASK_MAX_OPTION_ROWS of the option list (the Other row included)
 * render at once, with the count of rows hidden above/below. Keeps a
 * many-option question inside the block's height budget so Ink never
 * crosses its fullscreen threshold (the #622/#874 flicker mechanism). */
export function optionWindow(
  total: number,
  focused: number,
  budget = ASK_MAX_OPTION_ROWS,
): { start: number; count: number; above: number; below: number } {
  const count = Math.max(1, Math.min(budget, total));
  const start = Math.min(Math.max(0, focused - (count - 1)), Math.max(0, total - count));
  return { start, count, above: start, below: Math.max(0, total - start - count) };
}

/** One question screen's height model (#874). Every number here mirrors a
 * row the render below actually emits; the measurement tests
 * (`ask-user-block.test.tsx`, "row budget") pin them against real frames.
 * A reservation that understates the block would let the volatile region
 * cross the terminal height — the exact condition of this issue. */
export interface AskScreenFit {
  /** Option rows the internal window renders (never above ASK_MAX_OPTION_ROWS). */
  window: number;
  /** Wrapped description rows kept per option (never above ASK_DESCRIPTION_ROW_CAP). */
  descriptionRows: number;
  /** Wrapped question rows kept. */
  questionRows: number;
  /** Hidden-row marker rows the window still needs. */
  markers: number;
  /** Total rows this plan renders. */
  rows: number;
}

/** Layout A chrome rows: blank + top border + chip row + divider + blank
 * after the question + Other row + bottom border + footer + trailing blank. */
const CHROME_A = 9;
/** Layout C chrome rows: blank + header + Other + blank + footer + trailing blank. */
const CHROME_C = 6;
/** Summary screen chrome: A = blank + border + title + border + footer +
 * trailing blank; C = blank + title + blank + footer + trailing blank. */
const SUMMARY_CHROME_A = 6;
const SUMMARY_CHROME_C = 5;
/** Floor for the option window when a tiny viewport forces it down. */
const ASK_MIN_OPTION_ROWS = 3;

type AskScreen = { question: string; options: ReadonlyArray<{ description?: string; preview?: string }> };

const screenCompact = (width: number): boolean => width < ASK_COMPACT_WIDTH;
const screenInner = (width: number): number => Math.max(50, width - 6);

/** Layout C renders its descriptions at a different indent than A, so the
 * two layouts wrap them differently — the model must not share one width. */
const screenDescWidth = (width: number, inner: number): number =>
  screenCompact(width) ? Math.max(1, inner - DESC_INDENT_C.length - 2) : Math.max(1, inner - DESC_INDENT_A.length - 2);

const screenHasPreview = (q: AskScreen, width: number): boolean =>
  !screenCompact(width) && q.options.some((o) => o.preview !== undefined);

/** Rows one screen renders for a given plan. */
function screenRows(q: AskScreen, width: number, plan: Omit<AskScreenFit, "rows">): number {
  const inner = screenInner(width);
  const compact = screenCompact(width);
  const visibleOptions = q.options.length > plan.window ? plan.window : q.options.length;
  let optionArea = visibleOptions; // one label row each
  if (!screenHasPreview(q, width)) {
    const descWidth = screenDescWidth(width, inner);
    for (const option of q.options.slice(0, visibleOptions)) {
      const desc = option.description ?? "";
      if (desc.trim() === "") continue;
      const wraps = wrapText(desc, descWidth).length;
      optionArea += Math.min(plan.descriptionRows, wraps) + (wraps > plan.descriptionRows ? 1 : 0);
    }
  }
  const preview = screenHasPreview(q, width)
    ? Math.min(PREVIEW_ROW_CAP, Math.max(...q.options.map((o) => (o.preview ? o.preview.split("\n").length : 1)))) + 3
    : 0;
  return (compact ? CHROME_C : CHROME_A) + plan.questionRows + optionArea + plan.markers + preview;
}

/**
 * The largest plan that fits `maxRows`, or the natural one when no budget
 * is given (#874). Preference order: keep as many question rows as
 * possible, then options, then description rows — the user answering a
 * question needs the options, not the prose. Shrinking to the floor
 * overflows still: a viewport too small to show three options cannot be
 * honoured, and the caller's transcript budget already floors at one row.
 */
export function fitAskScreen(q: AskScreen, width: number, maxRows?: number): AskScreenFit {
  const natural: Omit<AskScreenFit, "rows"> = {
    window: Math.min(q.options.length, ASK_MAX_OPTION_ROWS),
    descriptionRows: ASK_DESCRIPTION_ROW_CAP,
    questionRows: wrapText(q.question, Math.max(1, screenInner(width))).length,
    markers: q.options.length > ASK_MAX_OPTION_ROWS ? 2 : 0,
  };
  const naturalRows = screenRows(q, width, natural);
  if (maxRows === undefined || naturalRows <= maxRows) return { ...natural, rows: naturalRows };
  const questionRows = Math.max(1, Math.min(natural.questionRows, maxRows - (screenCompact(width) ? CHROME_C : CHROME_A) - ASK_MIN_OPTION_ROWS));
  for (let window = natural.window; window >= ASK_MIN_OPTION_ROWS; window--) {
    for (let descriptionRows = natural.descriptionRows; descriptionRows >= 0; descriptionRows--) {
      const markers = q.options.length > window ? 2 : 0;
      const plan = { window, descriptionRows, questionRows, markers };
      const rows = screenRows(q, width, plan);
      if (rows <= maxRows) return { ...plan, rows };
    }
  }
  const floorPlan = { ...natural, window: Math.min(natural.window, ASK_MIN_OPTION_ROWS), descriptionRows: 0, questionRows, markers: q.options.length > ASK_MIN_OPTION_ROWS ? 2 : 0 };
  return { ...floorPlan, rows: screenRows(q, width, floorPlan) };
}

/** Summary-screen rows for `count` questions inside a row budget. */
export function fitAskSummary(count: number, width: number, maxRows?: number): { window: number; markers: number; rows: number } {
  const compact = screenCompact(width);
  const chrome = compact ? SUMMARY_CHROME_C : SUMMARY_CHROME_A;
  const naturalWindow = Math.min(count, ASK_MAX_OPTION_ROWS);
  const naturalMarkers = count > naturalWindow ? 2 : 0;
  const naturalRows = chrome + naturalWindow + naturalMarkers;
  if (maxRows === undefined || naturalRows <= maxRows) return { window: naturalWindow, markers: naturalMarkers, rows: naturalRows };
  let window = naturalWindow;
  while (window > 1) {
    const markers = count > window ? 2 : 0;
    if (chrome + window + markers <= maxRows) return { window, markers, rows: chrome + window + markers };
    window--;
  }
  const markers = count > 1 ? 2 : 0;
  return { window: 1, markers, rows: chrome + 1 + markers };
}

/**
 * The smallest row count the block can render at this width: one question
 * row, the minimum option window (labels plus their truncation markers),
 * the window markers and the chrome — for the TALLEST question screen, so
 * whichever question is showing fits. A caller asking for less than this
 * cannot be honoured: the question must stay answerable, so the block wins
 * over the transcript budget (which floors at one row anyway). Callers use
 * it to avoid granting an impossible budget. Derived from the same
 * `screenRows` model the renderer budgets with, so the two cannot drift.
 */
export function askBlockMinRows(questions: ReadonlyArray<AskScreen>, width: number): number {
  const blockWidth = Math.max(40, width);
  const screens = questions.map((q) =>
    screenRows(q, blockWidth, {
      window: Math.min(q.options.length, ASK_MIN_OPTION_ROWS),
      descriptionRows: 0,
      questionRows: 1,
      markers: q.options.length > ASK_MIN_OPTION_ROWS ? 2 : 0,
    }));
  return Math.max(...screens, fitAskSummary(questions.length, blockWidth).rows);
}

/** The block's row budget for the tallest screen it can render (#413,
 * #426, #874). Shared with Chat so the transcript-compression arithmetic
 * and the layout stay in one place; `maxRows` is the height the caller
 * allows (viewport minus the composer/footer chrome) and is enforced by
 * the renderer through the same `fitAskScreen` plans. */
export function askUserBlockRows(
  questions: ReadonlyArray<AskScreen>,
  width?: number,
  maxRows?: number,
): number {
  const blockWidth = Math.max(40, width ?? 100);
  const screens = questions.map((q) => fitAskScreen(q, blockWidth, maxRows).rows);
  const summary = fitAskSummary(questions.length, blockWidth, maxRows).rows;
  return Math.max(...screens, summary);
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

export function AskUserBlock({ gate, width, maxRows }: { gate: AskUserGate; width?: number; maxRows?: number }) {
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

  // #874: the visible slice of the option list around the focused option —
  // a many-option question scrolls internally instead of growing past the
  // viewport (Ink's fullscreen path). The plan is the SAME model the caller
  // budgets with (`fitAskScreen`): window size, description cap and
  // question cap come from one place, so render and reservation can't drift.
  const fit = fitAskScreen(
    { question: question.question, options: question.options },
    blockWidth,
    maxRows,
  );
  const window = optionWindow(question.options.length, "option" in focused ? focused.option : 0, fit.window);
  const summaryFit = fitAskSummary(questions.length, blockWidth, maxRows);
  const questionLines = wrapText(question.question, Math.max(1, innerWidth - 1)).slice(0, fit.questionRows);
  const questionHidden = questionLines.length < wrapText(question.question, Math.max(1, innerWidth - 1)).length;
  const optionRows = (descWidth: number, sideBySide: boolean, descIndent: string) => {
    const visible = question.options.slice(window.start, window.start + window.count);
    const rows = visible.map((option, i) => {
      const optionIndex = window.start + i;
      const isFocused = "option" in focused && focused.option === optionIndex;
      const checked = question.multiSelect && selected.includes(option.label);
      const isSuggested = option.label === question.suggested;
      const marker = question.multiSelect ? (checked ? "[x]" : "[ ]") : isFocused ? "❯ " : "  ";
      const number = question.multiSelect ? "  " : `${optionIndex + 1} `;
      const label = sanitizeForDisplay(option.label);
      const fullDescription = sideBySide ? [] : wrapText(sanitizeForDisplay(option.description ?? ""), descWidth);
      const descriptionHidden = fullDescription.length > fit.descriptionRows;
      const desc = fullDescription.slice(0, fit.descriptionRows).map((line, index) =>
        descriptionHidden && index === fit.descriptionRows - 1 ? `${line.slice(0, Math.max(0, descWidth - 1))}…` : line,
      );
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
          {descriptionHidden && <Text color={theme.dim}>{`${descIndent}… description truncated`}</Text>}
        </React.Fragment>
      );
    });
    if (window.above > 0) rows.unshift(<Text key="more-above" color={theme.dim}>{`  ↑ ${window.above} more`}</Text>);
    if (window.below > 0) rows.push(<Text key="more-below" color={theme.dim}>{`  ↓ ${window.below} more`}</Text>);
    return rows;
  };
  /** The question, clipped to its budget (#874): a model-provided wall of
   * text must not push the block past the viewport. */
  const questionText = (prefix = "") => (
    <>
      {questionLines.map((line, i) => (
        <Text key={`q-${i}`} bold={i === 0}>{`${prefix}${line}`}</Text>
      ))}
      {questionHidden && <Text color={theme.dim}>{`${prefix}… question truncated`}</Text>}
    </>
  );

  // ——— Layout C (narrow terminals): borderless, compact ———
  if (compact) {
    return (
      <Box flexDirection="column">
        <Text> </Text>
        {summary ? (
          <Box flexDirection="column">
            <Text bold color={theme.purple}>Review your answers</Text>
            {(() => {
              const w = optionWindow(questions.length, Math.min(index, questions.length - 1), summaryFit.window);
              return (
                <>
                  {w.above > 0 && <Text color={theme.dim}>{` ↑ ${w.above} more`}</Text>}
                  {questions.slice(w.start, w.start + w.count).map((q, i) => {
                    const a = answers[w.start + i];
                    const value = answerText(a);
                    return (
                      <Text key={q.question}>
                        <Text bold>{`${sanitizeForDisplay(q.header)}: `}</Text>
                        <Text color={theme.fg}>{sanitizeForDisplay(value)}</Text>
                      </Text>
                    );
                  })}
                  {w.below > 0 && <Text color={theme.dim}>{` ↓ ${w.below} more`}</Text>}
                </>
              );
            })()}
            <Text> </Text>
            <Dim>{FOOTER_SUMMARY_FIRST}</Dim>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text>
              <Text backgroundColor={theme.purple} color={theme.bg} bold>{` ${sanitizeForDisplay(question.header)} `}</Text>
              <Text color={theme.dim}>{` ${index + 1}/${questions.length}`}</Text>
            </Text>
            <Text bold>{questionLines.join("\n")}</Text>
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
          {/* #874: windowed like the question screens — a huge set shows a
              bounded slice (no navigation here; the model gets all answers). */}
          {(() => {
            const w = optionWindow(questions.length, Math.min(index, questions.length - 1), summaryFit.window);
            return (
              <>
                {w.above > 0 && <Text color={theme.dim}>{` ↑ ${w.above} more`}</Text>}
                {questions.slice(w.start, w.start + w.count).map((q, i) => {
                  const a = answers[w.start + i];
                  const value = answerText(a);
                  return (
                    <Text key={q.question}>
                      <Text bold>{` ✓ ${pad(sanitizeForDisplay(q.header), 12)} — `}</Text>
                      <Text color={theme.fg}>{sanitizeForDisplay(value)}</Text>
                    </Text>
                  );
                })}
                {w.below > 0 && <Text color={theme.dim}>{` ↓ ${w.below} more`}</Text>}
              </>
            );
          })()}
        </Box>
      ) : hasPreview(question) ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingX={1} width={panelWidth}>
          <Text>
            <Text color={theme.dim}>{` ${chipLine}`}</Text>
          </Text>
          <Text color={theme.dim}>{` ${divider}`}</Text>
          <Text bold>{` ${questionLines.join("\n")}`}</Text>
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
          <Text bold>{` ${questionLines.join("\n")}`}</Text>
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
