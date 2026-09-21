# ADR-0042: the liveness scanner is the default turn-live indicator

Status: accepted · Date: 2026-09-21 · Parent: issue #876 · Related: #287, #622

## Context

Row 1's left slot was a braille cycle (`SPINNER_FRAMES`, ten frames) advanced
by a ~90 ms tick gated on the active turn. It says "something is happening" in
the least specific way a terminal can: the frames are a generic ambient glyph
with no relation to what the session is doing, and at a glance a live turn and
a stalled one look the same for as long as the tick keeps firing.

The style guide has been strict about animation since #287 removed the
animated rainbow separator as unwanted decoration, and #622's follow-up
confined every re-render timer to the states that justify it. A bracket
around decoration therefore applies: an animation earns its place only as a
**state indicator**, never as ornament, and never as a suggestion of progress.

## Decision

**Go: the scanner sweep replaces the braille cycle as the default liveness
indicator, for every session, with no configuration key.**

- **One strip, seven cells.** A single lit segment walks left→right and back
  (ping-pong, one cell per tick, no wrap), two cells of decaying trail behind
  it, the unlit track visible the whole time — KITT's light bar, because that
  shape reads as a *scan* rather than as a blink or a fill gauge. A full round
  trip is ~1.1 s on the existing 90 ms clock.
- **The intensity is in the glyph** (`▮ ▯ ▫ ·`, ASCII `# = - .` through the
  existing `ic` seam), so the beat survives a monochrome terminal; the bar
  adds the theme's true red (`err`) on the light and the trail, and `dim` on
  the unlit track. No new colour token, no hardcoded colour.
- **The clock does not change.** Same ~90 ms tick, same gating: only while a
  turn is live, never on stream events (so the beat survives event gaps), never
  while input is blocked (#622). The transcript's block-head animation and the
  update/quota-modal spinners stay out of scope.
- **No progress semantics.** The sweep encodes one bit — the turn is live —
  and never where the turn is going. It does not fill, it does not advance
  monotonically, and it is not a bar of completion: the honesty rule of §2
  ("no blinking cursor, no fake progress") is what makes this compatible with
  #287 instead of a replay of it.
- **The seam is unchanged.** A tick still produces one plain string, passed as
  the `spinner` prop; the bar colours each cell by the role its glyph means.
  No caller or test had to widen, and a caller still passing the older braille
  frame renders it unchanged.
- **Compact terminals keep the strip and drop the phase word** (< 70 columns),
  as before — the strip is seven cells in every class.

## Consequences

- The style guide's §2 "Liveness" paragraph and §4 row-1 description name the
  scanner; the braille cycle survives only in the `moh update` progress line
  and the quota modal (ADR-0014 territory, deliberately untouched).
- The trade-off against #287 is explicit and accepted: a live turn gets a
  moving light where an animated separator was removed, on the grounds that the
  light is a state readout gated on the turn, not ornament on an idle screen.
- The owner chose this at the #876 stage-C checkpoint after a throwaway
  prototype compared four widths and two glyph families (squares vs the
  vertical rectangles kept here); the prototype shipped nothing.
