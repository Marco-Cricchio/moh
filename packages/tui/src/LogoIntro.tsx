import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { LOGO_BANNER } from "./ui";
import { useTheme } from "./themes";

/** The startup intro duration: snappy on purpose — long enough to read as
 * an animation, short enough never to feel like a gate (~3s, skippable). */
const DURATION_MS = 2800;
const GLYPHS = "!@#$%&*+=~^?:.oO0123456789abcdef";

type Frame = string[];

/** Pick one glyph uniformly. */
const noise = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]!;

/**
 * Scatter/settle: every banner cell is random noise resolving to the real
 * character in a random order — a Matrix-style composition.
 */
function scatterFrames(): Frame[] {
  const cols = Math.max(...LOGO_BANNER.map((r) => r.length));
  const chars: Array<string | null> = [];
  const live: number[] = [];
  for (let y = 0; y < LOGO_BANNER.length; y++) {
    const row = LOGO_BANNER[y]!.padEnd(cols);
    for (let x = 0; x < cols; x++) {
      const c = row[x] === " " ? null : row[x]!;
      chars.push(c);
      if (c !== null) live.push(y * cols + x);
    }
  }
  const order = live.sort(() => Math.random() - 0.5);
  const steps = 20;
  const frames: Frame[] = [];
  for (let s = 0; s <= steps; s++) {
    const settled = new Set(order.slice(0, Math.floor((s / steps) * order.length)));
    frames.push(
      Array.from({ length: LOGO_BANNER.length }, (_, y) => {
        let line = "";
        for (let x = 0; x < cols; x++) {
          const i = y * cols + x;
          const target = chars[i];
          line += target === null ? " " : settled.has(i) ? target : noise();
        }
        return line;
      }),
    );
  }
  return frames;
}

/** Typewriter: the banner carves itself line by line. */
function typewriterFrames(): Frame[] {
  const text = LOGO_BANNER.join("\n");
  const total = text.length;
  const frames: Frame[] = [];
  for (let n = 0; n <= total; n += Math.max(2, Math.floor(total / 24))) {
    const done = text.slice(0, n).split("\n");
    frames.push(LOGO_BANNER.map((_, y) => done[y] ?? ""));
  }
  frames.push([...LOGO_BANNER]);
  return frames;
}

/** Glitch: the settled banner flickers — sheared slices and glyph swaps
 * decaying to zero, like a signal locking in. */
function glitchFrames(): Frame[] {
  const frames: Frame[] = [];
  for (let s = 0; s < 22; s++) {
    const intensity = 1 - s / 22;
    frames.push(
      LOGO_BANNER.map((row) => {
        if (Math.random() > intensity * 0.9) return row;
        const shift = Math.floor((Math.random() - 0.5) * 8 * intensity);
        const body = row
          .slice(0, Math.max(0, row.length - shift))
          .split("")
          .map((c) => (c !== " " && Math.random() < intensity * 0.4 ? noise() : c))
          .join("");
        return " ".repeat(Math.max(0, shift)) + body;
      }),
    );
  }
  frames.push([...LOGO_BANNER]);
  return frames;
}

/** Slide: the four rows slide in from alternating edges with easing. */
function slideFrames(): Frame[] {
  const W = 26;
  const frames: Frame[] = [];
  for (let s = 0; s <= 16; s++) {
    const ease = 1 - Math.pow(1 - s / 16, 3);
    frames.push(
      LOGO_BANNER.map((row, y) => {
        const offset = Math.round((1 - ease) * W * (y % 2 === 0 ? 1 : -1));
        if (offset > 0) return row.slice(offset) + " ".repeat(Math.min(offset, W));
        if (offset < 0) return " ".repeat(Math.min(-offset, W)) + row.slice(0, Math.max(0, W + offset));
        return row;
      }),
    );
  }
  return frames;
}

/** Rain: glyph columns fall from above; where a drop lands, the real
 * character remains — the banner "prints" from the top down, column by
 * column with jitter. */
function rainFrames(): Frame[] {
  const cols = Math.max(...LOGO_BANNER.map((r) => r.length));
  const chars: Array<string | null> = [];
  for (let y = 0; y < LOGO_BANNER.length; y++) {
    const row = LOGO_BANNER[y]!.padEnd(cols);
    for (let x = 0; x < cols; x++) chars.push(row[x] === " " ? null : row[x]!);
  }
  // Each column gets a random landing step.
  const land = Array.from({ length: cols }, (_, x) => 3 + Math.floor(Math.random() * 14));
  const steps = 18;
  const frames: Frame[] = [];
  for (let s = 0; s <= steps; s++) {
    frames.push(
      Array.from({ length: LOGO_BANNER.length }, (_, y) => {
        let line = "";
        for (let x = 0; x < cols; x++) {
          const target = chars[y * cols + x];
          if (target === null) { line += " "; continue; }
          if (s >= land[x]!) line += target;
          else if (s === land[x]! - 1) line += noise(); // the falling drop
          else line += " ";
        }
        return line;
      }),
    );
  }
  return frames;
}

/** Unveil: a solid block sweeps left→right; behind it the banner is
 * revealed, ahead of it faint noise hints at what is coming. */
function unveilFrames(): Frame[] {
  const cols = Math.max(...LOGO_BANNER.map((r) => r.length));
  const chars: Array<string | null> = [];
  for (let y = 0; y < LOGO_BANNER.length; y++) {
    const row = LOGO_BANNER[y]!.padEnd(cols);
    for (let x = 0; x < cols; x++) chars.push(row[x] === " " ? null : row[x]!);
  }
  const steps = 20;
  const frames: Frame[] = [];
  for (let s = 0; s <= steps; s++) {
    const edge = Math.floor((s / steps) * (cols + 4)) - 2;
    frames.push(
      Array.from({ length: LOGO_BANNER.length }, (_, y) => {
        let line = "";
        for (let x = 0; x < cols; x++) {
          const target = chars[y * cols + x];
          if (target === null) { line += " "; continue; }
          if (x <= edge) line += target;
          else if (x <= edge + 3) line += GLYPHS[0]!; // dim preview fringe
          else line += " ";
        }
        return line;
      }),
    );
  }
  return frames;
}

/** Pulse: the banner fades in as expanding blocks from the center rows
 * outward, breathing (grow → shrink → grow) before locking. */
function pulseFrames(): Frame[] {
  const frames: Frame[] = [];
  const rows = LOGO_BANNER.length;
  const seq = [0.2, 0.4, 0.6, 0.8, 1, 0.6, 0.8, 1, 1, 1]; // breathe, then hold
  for (const level of seq) {
    const mid = (rows - 1) / 2;
    frames.push(
      LOGO_BANNER.map((_, y) => {
        const proximity = 1 - Math.abs(y - mid) / ((rows + 1) / 2);
        return proximity >= level ? LOGO_BANNER[y]! : "";
      }),
    );
  }
  return frames;
}

/** Wave: a horizontal sine wobble rolls across the banner, amplitude
 * decaying to zero — the logo "sways" into place. */
function waveFrames(): Frame[] {
  const cols = Math.max(...LOGO_BANNER.map((r) => r.length));
  const steps = 18;
  const frames: Frame[] = [];
  for (let s = 0; s <= steps; s++) {
    const amp = (1 - s / steps) * 6;
    frames.push(
      LOGO_BANNER.map((row) => {
        const padded = row.padEnd(cols);
        let line = "";
        for (let x = 0; x < cols; x++) {
          const shift = Math.round(Math.sin((x / cols) * Math.PI * 4 + s * 0.9) * amp);
          const src = Math.min(cols - 1, Math.max(0, x + shift));
          const c = padded[src]!;
          line += c === " " ? " " : amp > 0.5 && Math.abs(shift) > 2 ? noise() : c;
        }
        return line;
      }),
    );
  }
  return frames;
}

const STYLES = [
  { name: "scatter", make: scatterFrames },
  { name: "typewriter", make: typewriterFrames },
  { name: "glitch", make: glitchFrames },
  { name: "slide", make: slideFrames },
  { name: "rain", make: rainFrames },
  { name: "unveil", make: unveilFrames },
  { name: "pulse", make: pulseFrames },
  { name: "wave", make: waveFrames },
];

/**
 * The startup intro (#Home): a random ASCII animation of the logo, centered
 * in the home area, then settles into the static banner position. Any
 * keystroke skips to the settled logo. Style is picked once per mount, so
 * every launch looks different.
 */
export function LogoIntro({ onSkip }: { onSkip: () => void }) {
  const theme = useTheme();
  const style = useMemo(
    () => STYLES[Math.floor(Math.random() * STYLES.length)] ?? STYLES[0]!,
    [],
  );
  const frames = useMemo(() => {
    const made = style.make();
    // A style that yields nothing must not crash the render: fall back to
    // the settled banner as a single frame.
    return made.length > 0 ? made : [[...LOGO_BANNER]];
  }, [style]);
  const [tick, setTick] = useState(0);
  const total = frames.length;
  const delay = DURATION_MS / total;
  const settled = tick >= total - 1;
  // Skip can arrive twice (settle timer racing a keystroke); fire once.
  const skippedRef = React.useRef(false);
  const skip = React.useCallback(() => {
    if (skippedRef.current) return;
    skippedRef.current = true;
    onSkip();
  }, [onSkip]);

  useEffect(() => {
    if (settled) {
      const t = setTimeout(skip, 350);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setTick((n) => n + 1), delay);
    return () => clearTimeout(t);
  }, [tick, settled, delay, skip]);

  useInput(() => {
    if (!settled) skip();
  });

  const frame = frames[Math.min(tick, total - 1)] ?? frames[0]!;
  // Render purity: the per-row flicker is seeded per frame, not re-rolled
  // inside the render body (nested updates from render crash Ink).
  const flicker = useMemo(() => frames.map(() => Math.random() > 0.2), [frames]);
  return (
    <Box flexDirection="column" alignItems="center">
      {frame.map((line, i) => (
        <Text key={i} color={settled ? theme.accent : flicker[i] ? theme.accent : theme.dim}>
          {line}
        </Text>
      ))}
    </Box>
  );
}
