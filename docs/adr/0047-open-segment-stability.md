# ADR-0047: What may print while a reply streams — the open-segment stability rule

Status: accepted · Date: 2026-09-25 · Related: #972, #970, #950, #205, #226, #183/#194/#526, ADR-0002 (headless core, thin clients)

## Context

A streamed reply leaves the volatile area for native scrollback row by row
(#183/#194/#526): `<Static>` is append-only, so a row that prints once can
never be revised. The live promotion therefore had to decide *what may print*
before the semantic closure of a segment, and it decided conservatively: only
rows of paragraphs already closed by a **blank line inside the block's own
source**, with the last row withheld (`Chat.tsx`, open-tail branch).

#970 fixed the ordering half of that rule (a closed block prints whole, in
reply order) but left the open-tail half alone, and the blank-line rule turned
out to be unsound in the other direction: a reply whose closing paragraph
carries **no blank line of its own** renders no stable prefix at all
(`stable = 0`), so *zero* rows promote while it streams. The volatile area is
viewport-capped (`transcriptTail`, #950), and its clip keeps the newest rows:
once the paragraph grows past the budget its beginning is neither on screen nor
in scrollback, and the whole paragraph appears in one burst when it closes
(#972). Measured at 100×24 with a ~5 KB paragraph: 18 sampled frames with the
first marker absent from both the static and the volatile output.

Two facts constrain the fix:

- **Streaming only appends.** Text arrives at the end of the source, so a
  character can only be re-read by something written *after* it, and a greedy
  wrap is left-to-right: a row's content depends on the text before it.
- **Some constructs do reach backwards**, and they are exactly what makes a
  row unsafe to freeze: inline delimiters pair across a soft break, and a
  block-start line re-reads the line above it (a setext underline turns the
  preceding paragraph into a heading; a table delimiter row makes the line
  above a header).

## Decision

**A row of an open segment may print when nothing after it can re-read it.**
The rule is `openBlockStableRows` in `transcript.tsx`, beside
`closedPrefixLength`/`assistantSegments` — one definition of what may print,
shared by the projection and the promotion:

1. **A closed block is frozen** (#970) and promotes whole; so does a block
   whose turn has stopped streaming (`pending === false`) — nothing can grow
   any more, and that path keeps the pre-#972 behaviour byte for byte.
2. **An open block promotes the rows of its inert prefix, minus the prefix's
   last row.** The inert prefix (`inertPrefixLength`) is the source up to the
   first character that can re-read it: an inline-significant character
   (`` ` `` `*` `_` `[` `]` `<` `>` `|` `&` `\`, one class shared with
   `isPlainStreamingProse`), a hard break, or a line start that reads back (a
   setext underline, thematic break, heading, quote, fence or list marker — the
   *in-progress* setext line `-`/`--`/`=` counts, since one dash already turns
   the line above into a heading). The prefix's last row is withheld because it
   can still absorb text the reveal cursor has not delivered.
3. **The blank-line boundary (#205) still applies**, as the deeper of the two
   cuts: `cut = max(inertPrefixLength, lastIndexOf("\n\n") + 1)`. Rows behind a
   blank line stay promotable for markdown-bearing text.
4. **The prefix must render the row identically to the full source.** The
   promoted count stops at the first row the prefix and the full render
   disagree on, so a row that later text has re-read (a setext underline over
   the line above) is never promoted *as new*. This check is what makes the
   rule safe by construction rather than by enumeration of markdown cases.

### No repaint on the plain → Markdown transition

The dead plain-prose path (`proseChainRef`, `nextProseHead`) carried a repaint
seam for the moment a source stops being plain text after a physical head was
printed: `if (chars > 0) repaintRef.current = true`. Both the seam and the path
are **deleted in this change**: the arm could not fire (`proseChainRef` was only
ever assigned `null`), and re-arming it would be a regression. A repaint
remounts `<Static>`, clears the ledgers, and re-derives
the open block from a source that is no longer inert — under this rule it would
reprint *fewer* rows than the reader already had, losing the head of the
paragraph mid-turn. That is worse than the residue it would fix, which is
purely cosmetic:

**Accepted residue:** a setext underline that arrives after a row printed
restyles the line above it (paragraph → heading). The row's **text** is
unchanged, so what the reader has is still the reply's text, printed once;
only its emphasis is stale, and the log and the final transcript are complete.
The append-only property test in `transcript.test.tsx` asserts the text
invariant across six kinds of appended text, and pins this case explicitly.

## Consequences

- A long paragraph of ordinary prose grows native scrollback while it streams,
  in order, once — the promise of #183/#194/#526 now holds for the *last*
  paragraph of a reply, not only for its closed blocks.
- Markdown-bearing open paragraphs promote up to their first significant
  character, which is strictly more than before and still never a row that can
  be re-read. A paragraph that opens with emphasis or a link promotes little;
  that is the price of append-only output, not a bug.
- `isPlainStreamingProse` and the inert scan share one character class
  (`INLINE_SIGNIFICANT`), so the "cannot re-read" vocabulary has one home.
- The retired plain-prose promotion path is **deleted** in the same change
  (`ProseHeadChain`/`SealedProseHead`, `nextProseHead`,
  `promotablePlainPrefix`, `trimProseHead`, `embedProseHeads`,
  `isPlainStreamingProse`, the `proseChainRef`/`proseHeadsRef` state and its
  two clear sites, `markdownHeadsRef` — a per-block cursor nothing ever
  wrote — and the plain→Markdown repaint arm that could not fire). It was
  224 lines of GFM-blind wrapping maintained against no call site; its only
  consumer was its own unit test, which goes with it. The rule that replaced
  it reads the same markdown pipeline the settled view renders with.

## Alternatives rejected

- **Keep the blank-line rule and accept the burst.** It is the reported bug.
- **Promote every row but the last unconditionally.** Prints rows the next
  delta can re-read (a `---` underline over an already printed line, emphasis
  pairing across a soft break) — with append-only Static, stale forever.
- **Unify by widening `closedPrefixLength`/`assistantSegments`.** They are
  segment definitions; `closedPrefixLength` is `0` for a reply with no blank
  line, so a wider promotion cannot come from them — it comes from a row-level
  stability rule, which is why the rule lives beside them instead.
- **Repaint the transcript on the plain → Markdown transition.** Loses the
  already printed head mid-turn (see above).
