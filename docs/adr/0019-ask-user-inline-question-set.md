# ADR-0019: ask_user inline question set

Status: accepted · Date: 2026-09-01 · Parent: vision note 29

## Context

The `ask_user` tool today renders through a blocking centered `Dialog`
(`packages/tui/src/AskUserModal.tsx`, issue #70 / style guide §8): one question at a
time, up to 4 options, a visually distinct `suggested` answer, arrow/1–4 navigation,
free-text behind tab, esc = accept the suggested option. The turn loop in the core is
suspended while the overlay is active (`ask-user-gate.ts`). Vision note 29 asks for the
modal to be eliminated and the feature redesigned after Claude Code's
`AskUserQuestion` tool (reference source: `/Users/mc/Documents/AI_Projects/claude-code-main`,
`tools/AskUserQuestionTool`, `components/permissions/AskUserQuestionPermissionRequest`),
following a dedicated grilling session (2026-09-01).

## Decision

1. **Tool contract (public surface change, ADR-0004).** The tool keeps its name
   (`ask_user`); its schema becomes a **question set**: 1–4 questions per call, each
   with `question` (full text, unique within the batch), `header` (required chip label,
   ≤ 12 chars), `options` (2–4, each `label` + `description`, optional `preview`:
   markdown/text content shown in a side box when the option is focused, echoed to the
   model on selection), optional `multiSelect`, and the retained `suggested` (a purely
   visual "recommended" chip per question — never a default, never marked in the
   result when not chosen). Validation mirrors Claude Code's spec exactly: duplicate
   question texts or duplicate labels within a question are `invalid_request` errors.
   There is no conditional batching in the contract: how many questions per round is
   decided by the caller (e.g. the grilling skill's frontier), not the tool. The result
   returns question → answer (label list for multiSelect) plus the free-text "Other"
   answer when given; a cancelled set returns a "cancelled" tool result.
2. **Inline rendering, not a modal.** The interaction lives in an inline block between
   the composer text area and row 1 of the bottom bar (with one empty line of padding
   above and below), resizing dynamically as needed — up to compressing the transcript,
   with a side-by-side layout for preview-bearing questions. One question at a time:
   ↑/↓ moves through options, tab moves between questions, a final summary screen
   collects all answers before submit. "Other" is always the last option of every
   question, reachable by arrows, with an inline free-text input inside the block
   (one additional free-text field for the whole multiSelect set). multiSelect uses
   space to toggle and Enter to confirm. Esc navigates back a question; from the
   summary, an explicit cancel aborts the set with a "cancelled" tool result —
   the old "esc = suggested" behavior is removed with the modal. On resolution the
   volatile block projects as a compact Static tool_call→tool_result block (one line
   per question), per #194 and #183.
3. **Core seam.** `ask-user-gate.ts` remains the single headless/TUI seam: the payload
   widens from one question to a question set, and the turn resumes only after all
   answers are collected. The CLI stays headless: fail-fast (or flag-driven) with no UI.
4. **Replay compatibility.** Session files are never rewritten: old single-question
   `ask_user` events are translated in memory at replay time into the new compact
   projection. The event log stays append-only and integral.

## Consequences

- The modal path (`AskUserModal.tsx`) and its esc=suggested semantics are deleted; the
  style guide §8 modal exemption for ask_user lapses. Implemented by #412
  (`AskUserBlock.tsx`): the summary screen's explicit cancel is `ctrl+x`; `tab` on
  the summary edits the last question again.
- First-party skills are not altered by this change: the name is unchanged and the
  single-question call shape degrades gracefully (a 1-question batch is valid).
- `preview` is in scope: the side-by-side view ships with the redesign, implemented
  after the Claude Code reference (`PreviewQuestionView`, `PreviewBox`,
  `QuestionNavigationBar`).
- Out of scope, tracked separately: paste/images in free-text (note 4), shared UI lock
  for concurrent popups (note 12).
