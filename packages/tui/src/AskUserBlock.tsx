import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "./themes";
import { Dim } from "./ui";
import type { AskUserGate } from "./ask-user-gate";
import type { AskUserAnswer, AskUserQuestion, AskUserSetResult } from "@moh/core";
import { sanitizeForDisplay } from "@moh/core";
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
const ASK_COMPACT_WIDTH = 72;

/** Indent of description lines under an option row (#426): one space per
 * border column, one padding space, the marker column, one space — the
 * description text starts exactly under the option label. */
const DESC_INDENT_A = "      "; // "│ " + "❯ 1 " → label column
const DESC_INDENT_C = "     ";  // "❯ 1 " under the ▌header layout

/** Preview content rows a preview box may show before truncating (#414):
 * keeps an extreme preview from consuming the whole block; the row
 * reservation in askUserBlockRows uses the same ceiling. */
const PREVIEW_ROW_CAP = 20;

/** #874: max option rows (options + the Other row) a question screen shows
 * at once. A pathological question (dozens of options, huge wrapped
 * descriptions) once pushed the block past the terminal height, which
 * puts Ink on its fullscreen path — a clear+full-reprint per frame. Past
 * the window the list scrolls internally around the focused option (with
 * ↑ N more / ↓ N more markers), like every other height-aware moh menu. */
const ASK_MAX_OPTION_ROWS = 12;
/** Each visible option description is bounded too: a single model-provided
 * essay must not defeat the option-window height cap. */
const ASK_DESCRIPTION_ROW_CAP = 2;

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
interface AskScreenFit {
  /** Option rows the internal window renders (never above ASK_MAX_OPTION_ROWS). */
  window: number;
  /** Wrapped description rows kept per option (never above ASK_DESCRIPTION_ROW_CAP). */
  descriptionRows: number;
  /** Wrapped question rows on screen at once. The question is never cut
   * (#1512): this is the full wrapped height unless `questionScroll`. */
  questionRows: number;
  /** #1512: the whole question does not fit even with the option floor —
   * it scrolls inside the block (pgup/pgdn) behind one position row. */
  questionScroll: boolean;
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
/** The render's text area: one margin column each side plus "│ " … " │". */
const screenInner = (width: number): number => width - 6;

/** #1512: the width the question wraps at — shared by the model and the
 * render (one leading space per line), so the full question height the
 * model reserves is the height the frame shows. */
const screenQuestionWidth = (width: number): number => Math.max(1, screenInner(width) - 1);

/** Layout C renders its descriptions at a different indent than A, so the
 * two layouts wrap them differently — the model must not share one width.
 * The same widths the render wraps at. */
const screenDescWidth = (width: number): number =>
  screenCompact(width)
    ? Math.max(1, screenInner(width) - DESC_INDENT_C.length - 2)
    : Math.max(1, screenInner(width) - DESC_INDENT_A.length - 6);

const screenHasPreview = (q: AskScreen, width: number): boolean =>
  !screenCompact(width) && q.options.some((o) => o.preview !== undefined);

/** Rows one screen renders for a given plan. */
function screenRows(q: AskScreen, width: number, plan: Omit<AskScreenFit, "rows">): number {
  const compact = screenCompact(width);
  const visibleOptions = q.options.length > plan.window ? plan.window : q.options.length;
  const questionArea = plan.questionRows + (plan.questionScroll ? 1 : 0);
  if (screenHasPreview(q, width)) {
    // Side-by-side (#414): the option column (labels, markers, Other) and
    // the preview box share their rows, and no blank row follows the
    // question — summing the two overstated the screen, which made a
    // question that fits scroll (#1512).
    const preview = Math.min(PREVIEW_ROW_CAP, Math.max(...q.options.map((o) => (o.preview ? o.preview.split("\n").length : 1)))) + 3;
    return CHROME_A - 2 + questionArea + Math.max(visibleOptions + plan.markers + 1, preview);
  }
  let optionArea = visibleOptions; // one label row each
  const descWidth = screenDescWidth(width);
  for (const option of q.options.slice(0, visibleOptions)) {
    const desc = option.description ?? "";
    if (desc.trim() === "") continue;
    const wraps = wrapText(desc, descWidth).length;
    optionArea += Math.min(plan.descriptionRows, wraps) + (wraps > plan.descriptionRows ? 1 : 0);
  }
  return (compact ? CHROME_C : CHROME_A) + questionArea + optionArea + plan.markers;
}

/** Wrapped height of the full question at this width (#1512). */
const questionHeight = (q: AskScreen, width: number): number =>
  wrapText(q.question, screenQuestionWidth(width)).length;

/** #1512: the fewest rows the question can take — all of it when it is
 * one or two lines (a scroll row would save nothing), else one visible
 * line plus the scroll position row. */
const questionFloor = (lines: number): Pick<AskScreenFit, "questionRows" | "questionScroll"> =>
  lines >= 3 ? { questionRows: 1, questionScroll: true } : { questionRows: lines, questionScroll: false };

/** #1512: the option window's floor. A question that could scroll (three or
 * more lines) takes the option rows first — down to the focused option
 * alone, ↑/↓ still reach the rest — before it scrolls; a shorter one is
 * shown whole at any budget Chat grants and keeps three options. */
const optionFloor = (lines: number): number => (lines >= 3 ? 1 : ASK_MIN_OPTION_ROWS);

/**
 * The largest plan that fits `maxRows`, or the natural one when no budget
 * is given (#874). The question is never cut (#1512): the space comes from
 * the description rows first, then the option window — the user answering
 * a question needs the options more than their prose. When even the option
 * floor (`optionFloor`, no descriptions) leaves too little room for the
 * whole question, the question scrolls inside the block (pgup/pgdn) — every
 * word stays reachable. Below the block's floor (`askBlockMinRows`) the plan
 * overflows still: the question must stay answerable, and the caller's
 * transcript budget already floors at one row.
 */
function fitAskScreen(q: AskScreen, width: number, maxRows?: number): AskScreenFit {
  const lines = questionHeight(q, width);
  const natural: Omit<AskScreenFit, "rows"> = {
    window: Math.min(q.options.length, ASK_MAX_OPTION_ROWS),
    descriptionRows: ASK_DESCRIPTION_ROW_CAP,
    questionRows: lines,
    questionScroll: false,
    markers: q.options.length > ASK_MAX_OPTION_ROWS ? 2 : 0,
  };
  const naturalRows = screenRows(q, width, natural);
  if (maxRows === undefined || naturalRows <= maxRows) return { ...natural, rows: naturalRows };
  const minWindow = optionFloor(lines);
  for (let window = natural.window; window >= minWindow; window--) {
    for (let descriptionRows = natural.descriptionRows; descriptionRows >= 0; descriptionRows--) {
      const markers = q.options.length > window ? 2 : 0;
      const plan = { ...natural, window, descriptionRows, markers };
      const rows = screenRows(q, width, plan);
      if (rows <= maxRows) return { ...plan, rows };
    }
  }
  const window = Math.min(natural.window, minWindow);
  const floorPlan = { ...natural, window, descriptionRows: 0, markers: q.options.length > window ? 2 : 0 };
  const floorRows = screenRows(q, width, floorPlan);
  if (!questionFloor(lines).questionScroll) return { ...floorPlan, rows: floorRows };
  // The whole question would push the floor plan past the budget: show as
  // many question lines as the budget leaves, minus the scroll position row.
  const questionRows = Math.max(1, lines - (floorRows - maxRows) - 1);
  const scrollPlan = { ...floorPlan, questionRows, questionScroll: true };
  return { ...scrollPlan, rows: screenRows(q, width, scrollPlan) };
}

/** Summary-screen rows for `count` questions inside a row budget. */
function fitAskSummary(count: number, width: number, maxRows?: number): { window: number; markers: number; rows: number } {
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
 * The smallest row count the block can render at this width: the question
 * floor (one scrolling line plus its position row, or the whole question
 * when it is shorter, #1512), the minimum option window (labels plus their truncation markers),
 * the window markers and the chrome — for the TALLEST question screen, so
 * whichever question is showing fits. A caller asking for less than this
 * cannot be honoured: the question must stay answerable, so the block wins
 * over the transcript budget (which floors at one row anyway). Callers use
 * it to avoid granting an impossible budget. Derived from the same
 * `screenRows` model the renderer budgets with, so the two cannot drift.
 */
export function askBlockMinRows(questions: ReadonlyArray<AskScreen>, width: number): number {
  const blockWidth = Math.max(40, width);
  const screens = questions.map((q) => {
    const lines = questionHeight(q, blockWidth);
    const window = Math.min(q.options.length, optionFloor(lines));
    return screenRows(q, blockWidth, {
      window,
      descriptionRows: 0,
      ...questionFloor(lines),
      markers: q.options.length > window ? 2 : 0,
    });
  });
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

/** The summary screen's answer rows, windowed by the same plan the budget
 * uses (#874): one shared renderer for both layouts, so the two can never
 * disagree about how many rows the summary occupies. */
function SummaryRows({
  questions,
  answers,
  window,
  compact,
}: {
  questions: readonly AskUserQuestion[];
  answers: readonly AskUserAnswer[];
  window: { start: number; count: number; above: number; below: number };
  compact: boolean;
}) {
  const theme = useTheme();
  return (
    <>
      {window.above > 0 && <Text color={theme.dim}>{compact ? ` ↑ ${window.above} more` : `  ↑ ${window.above} more`}</Text>}
      {questions.slice(window.start, window.start + window.count).map((q, i) => {
        const value = answerText(answers[window.start + i]);
        return compact ? (
          <Text key={q.question}>
            <Text bold>{`${sanitizeForDisplay(q.header)}: `}</Text>
            <Text color={theme.fg}>{sanitizeForDisplay(value)}</Text>
          </Text>
        ) : (
          <Text key={q.question}>
            <Text bold>{` ✓ ${pad(sanitizeForDisplay(q.header), 12)} — `}</Text>
            <Text color={theme.fg}>{sanitizeForDisplay(value)}</Text>
          </Text>
        );
      })}
      {window.below > 0 && <Text color={theme.dim}>{compact ? ` ↓ ${window.below} more` : `  ↓ ${window.below} more`}</Text>}
    </>
  );
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
  /** #1512: first visible question line when the question scrolls. */
  const [questionScroll, setQuestionScroll] = useState(0);

  const question: AskUserQuestion | undefined = questions[index];
  const textMode = !summary && "other" in focused;

  // #874: the visible slice of the option list around the focused option —
  // a many-option question scrolls internally instead of growing past the
  // viewport (Ink's fullscreen path). The plan is the SAME model the caller
  // budgets with (`fitAskScreen`): window size, description cap and
  // question rows come from one place, so render and reservation can't drift.
  const fit = question
    ? fitAskScreen({ question: question.question, options: question.options }, blockWidth, maxRows)
    : undefined;
  // #1512: the question is never cut — wrapped in full, and windowed only
  // when even the option floor leaves no room for all of it.
  const allQuestionLines = question ? wrapText(question.question, screenQuestionWidth(blockWidth)) : [];
  const maxQuestionScroll = fit?.questionScroll ? allQuestionLines.length - fit.questionRows : 0;
  const questionStart = Math.min(questionScroll, maxQuestionScroll);

  // New set → reset all navigation and collection state.
  useEffect(() => {
    setIndex(0);
    setAnswers([]);
    setFocused({ option: 0 });
    setSelected([]);
    setText("");
    setSummary(false);
    setQuestionScroll(0);
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
      setQuestionScroll(0);
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
      setQuestionScroll(0);
    }
  };

  useInput((input, key) => {
    if (!question) return;
    // #1512: a question taller than the block scrolls a page at a time
    // (one line of overlap), in option and free-text focus alike.
    if (!summary && (key.pageUp || key.pageDown)) {
      const page = Math.max(1, (fit?.questionRows ?? 1) - 1);
      setQuestionScroll(key.pageUp
        ? Math.max(0, questionStart - page)
        : Math.min(maxQuestionScroll, questionStart + page));
      return;
    }
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

  if (!question || !fit) return null;

  const window = optionWindow(question.options.length, "option" in focused ? focused.option : 0, fit.window);
  const summaryFit = fitAskSummary(questions.length, blockWidth, maxRows);
  const questionLines = allQuestionLines.slice(questionStart, questionStart + fit.questionRows);
  /** #1512: where the scrolling question is — a position, not a cut: the
   * rest of the question is one pgup/pgdn away. */
  const questionPosition = fit.questionScroll && (
    <Text color={theme.dim}>
      {`  lines ${questionStart + 1}–${questionStart + questionLines.length}/${allQuestionLines.length} · pgup/pgdn`}
    </Text>
  );
  /** The windowed option rows, rendered at the caller's layout width. */
  const renderOptionRows = (descWidth: number, sideBySide: boolean, descIndent: string) => {
    const visible = question.options.slice(window.start, window.start + window.count);
    const rows = visible.map((option, i) => {
      const optionIndex = window.start + i;
      const isFocused = "option" in focused && focused.option === optionIndex;
      const checked = question.multiSelect && selected.includes(option.label);
      const isSuggested = option.label === question.suggested;
      const marker = question.multiSelect ? (checked ? "[x]" : "[ ]") : isFocused ? "❯ " : "  ";
      const number = question.multiSelect ? "  " : `${optionIndex + 1} `;
      const label = sanitizeForDisplay(option.label);
      // An option without a description renders no description row — the
      // row model counts none (#1512: wrapText("") is one blank line).
      const description = sanitizeForDisplay(option.description ?? "");
      const fullDescription = sideBySide || description.trim() === "" ? [] : wrapText(description, descWidth);
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

  // ——— Layout C (narrow terminals): borderless, compact ———
  if (compact) {
    return (
      <Box flexDirection="column">
        <Text> </Text>
        {summary ? (
          <Box flexDirection="column">
            <Text bold color={theme.purple}>Review your answers</Text>
            <SummaryRows
              questions={questions}
              answers={answers}
              window={optionWindow(questions.length, Math.min(index, questions.length - 1), summaryFit.window)}
              compact
            />
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
            {questionPosition}
            {renderOptionRows(screenDescWidth(blockWidth), false, DESC_INDENT_C)}
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
          <SummaryRows
            questions={questions}
            answers={answers}
            window={optionWindow(questions.length, Math.min(index, questions.length - 1), summaryFit.window)}
            compact={false}
          />
        </Box>
      ) : hasPreview(question) ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.purple} paddingX={1} width={panelWidth}>
          <Text>
            <Text color={theme.dim}>{` ${chipLine}`}</Text>
          </Text>
          <Text color={theme.dim}>{` ${divider}`}</Text>
          <Text bold>{questionLines.map((line) => ` ${line}`).join("\n")}</Text>
          {questionPosition}
          <Box flexDirection="row" gap={2} paddingLeft={1}>
            <Box flexDirection="column" width={Math.min(32, Math.max(20, Math.floor((innerWidth - 2) * 0.4)))}>
              {renderOptionRows(0, true, DESC_INDENT_A)}
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
          <Text bold>{questionLines.map((line) => ` ${line}`).join("\n")}</Text>
          {questionPosition}
          <Text> </Text>
          {renderOptionRows(screenDescWidth(blockWidth), false, DESC_INDENT_A)}
          {otherRow}
        </Box>
      )}
      <Dim>{summary ? (index === 0 ? FOOTER_SUMMARY_FIRST : FOOTER_SUMMARY) : textMode ? FOOTER_OTHER : question.multiSelect ? FOOTER_MULTI : FOOTER}</Dim>
      <Text> </Text>
    </Box>
  );
}
