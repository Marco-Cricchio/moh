/**
 * PROTOTYPE (throwaway, issue #749 follow-up — theme editor redesign):
 * four radically different theme-customization panels, all mounted on the
 * real `Theme`/`THEMES` model from ../themes and the real picker grammar.
 * Run with `bun packages/tui/src/prototype/theme-editor-prototype.tsx`,
 * flip variants with ←/→. Not for merge — the verdict lands on the issue;
 * the winner's lessons go into the real SettingsPanel.
 *
 * The question: the current theme editor (commit dcaf0ea) forces users to
 * type raw hex codes with no preview of what they're changing. What should
 * the customization surface look like instead?
 *
 * Variants:
 *   A — "swatch grid": roles as a navigable color-swatch grid (enter opens
 *       a hue lightness slider), live transcript/dialog mock preview beside
 *   B — "live form + preview pane": list of roles with cursor-editable
 *       value, RIGHT half of the screen is a live mini-transcript that
 *       repaints per keystroke; presets cycled, not typed
 *   C — "wizard": step-by-step (pick base → pick fg/accent from curated
 *       ramps → fine-tune dim/muted → review), one decision per screen
 *   D — "everything visual": no hex anywhere — roles chosen from generated
 *       ramps anchored to a single seed hue; preview is the whole screen
 */
import React, { useState } from "react";
import { render, Box, Text, useInput } from "ink";
import { THEMES, THEME_ORDER, type ColorRole, type Theme } from "../themes";
import { themeLabelFor } from "../user-themes";
import { Dim } from "../ui";

// ---------------------------------------------------------------------------
// Shared synthetic state: a draft theme derived from tokyo-night
// ---------------------------------------------------------------------------
const BASE = "tokyo-night";

/** Perceptual-ish helpers: hex → hsl → hex, no deps (throwaway quality). */
function hexToHsl(hex: string): [number, number, number] {
  const n = hex.replace("#", "");
  const r = parseInt(n.slice(0, 2), 16) / 255, g = parseInt(n.slice(2, 4), 16) / 255, b = parseInt(n.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(v * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A ramp of N lightness steps at the same hue/chroma as `hex`. */
function ramp(hex: string, steps = 7): string[] {
  const [h, s] = hexToHsl(hex);
  return Array.from({ length: steps }, (_, i) => hslToHex(h, s, 0.12 + (i / (steps - 1)) * 0.78));
}

type Draft = { name: string; base: string; colors: Partial<Record<ColorRole, string>> };
const initialDraft = (): Draft => ({ name: "My Theme", base: BASE, colors: {} });
const resolve = (d: Draft): Theme => ({ ...THEMES[d.base as keyof typeof THEMES], label: d.name, ...d.colors }) as Theme;

/** The roles a user actually wants to touch, in decision order. */
const EDITABLE: ColorRole[] = ["fg", "accent", "dim", "muted", "ok", "warn", "err", "purple"];

// ---------------------------------------------------------------------------
// Shared live preview: a mini transcript + footer painted with the draft
// ---------------------------------------------------------------------------
function LivePreview({ theme, compact = false }: { theme: Theme; compact?: boolean }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} width={compact ? 44 : 56}>
      <Text color={theme.dim}> preview — repaints live </Text>
      <Text color={theme.warn}>› you</Text>
      <Text color={theme.dim}>  check this color</Text>
      <Text color={theme.accent}>◆ moh</Text>
      <Text color={theme.fg}>  here is plain body text, the token </Text>
      <Text color={theme.fg}>  you move repaints this pane now.</Text>
      <Text color={theme.muted}>  muted: secondary answer text (#426)</Text>
      <Text color={theme.dim}>  dim: chrome and timestamps</Text>
      <Box marginTop={0}>
        <Text backgroundColor={theme.selection} color={theme.fg}>{` selected row on selection `}</Text>
      </Box>
      <Text> </Text>
      <Text>
        <Text backgroundColor={theme.accent} color={theme.bg}>{` ⏎ `}</Text>
        <Text color={theme.dim}>{` send `}</Text>
        <Text backgroundColor={theme.surfaceRaised} color={theme.fg}>{` esc `}</Text>
        <Text color={theme.dim}>{` stop `}</Text>
      </Text>
      <Text> </Text>
      <Text>
        <Text color={theme.ok}>✓ ok </Text>
        <Text color={theme.warn}>⚠ warn </Text>
        <Text color={theme.err}>✗ err </Text>
        <Text color={theme.purple}>◆ purple</Text>
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Variant A — "swatch grid": navigable swatch grid + preview beside
// ---------------------------------------------------------------------------
function VariantA() {
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [cursor, setCursor] = useState(0);
  const [picking, setPicking] = useState<number | null>(null); // ramp index
  const theme = resolve(draft);
  const role = EDITABLE[cursor]!;
  const currentHex = (theme as unknown as Record<string, string>)[role];

  useInput((input, key) => {
    if (picking !== null) {
      if (key.upArrow) setPicking((p) => Math.max(0, p! - 1));
      if (key.downArrow) setPicking((p) => Math.min(6, p! + 1));
      if (key.leftArrow) setPicking((p) => Math.max(0, p! - 1));
      if (key.rightArrow) setPicking((p) => Math.min(6, p! + 1));
      if (key.return || input === "\r") {
        const hex = ramp(THEMES[BASE as keyof typeof THEMES].accent)[picking]!;
        setDraft((d) => ({ ...d, colors: { ...d.colors, [role]: hex } }));
        setPicking(null);
      }
      if (key.escape) setPicking(null);
      return;
    }
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(EDITABLE.length - 1, c + 1));
    if (key.leftArrow || key.rightArrow) {
      const r = ramp(THEMES[BASE as keyof typeof THEMES].accent);
      const idx = r.indexOf(currentHex);
      const next = clamp((idx === -1 ? 3 : idx) + (key.rightArrow ? 1 : -1), 0, r.length - 1);
      setDraft((d) => ({ ...d, colors: { ...d.colors, [role]: r[next]! } }));
    }
    if (key.return) setPicking(3);
  });

  return (
    <Box gap={2} paddingX={1}>
      <Box flexDirection="column">
        <Text bold color={theme.accent}>{` A · swatch grid — ${draft.name} `}</Text>
        <Text> </Text>
        {EDITABLE.map((r, i) => {
          const hex = (theme as unknown as Record<string, string>)[r];
          const selected = i === cursor && picking === null;
          return (
            <Text key={r} color={selected ? theme.bg : undefined} backgroundColor={selected ? theme.accent : undefined}>
              {` ${i === cursor ? "›" : " "} ${r.padEnd(8)}`}
              <Text key="swatch" backgroundColor={hex} color={hex}>{`      `}</Text>
              {` ${hex} `}
            </Text>
          );
        })}
        <Text> </Text>
        {picking === null ? (
          <Dim>↑↓ role · ←→ nudge lightness · ⏎ open ramp · esc</Dim>
        ) : (
          <Box flexDirection="column">
            <Dim>{` ramp for ${role} — ←→ pick · ⏎ set · esc `}</Dim>
            <Text>
              {ramp(currentHex).map((hex, i) => (
                <Text key={i} backgroundColor={hex} color={i === picking ? theme.bg : hex}>{` ${i} `}</Text>
              ))}
            </Text>
          </Box>
        )}
      </Box>
      <LivePreview theme={theme} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Variant B — "live form + big preview": two columns, repaint on keystroke
// ---------------------------------------------------------------------------
function VariantB() {
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [cursor, setCursor] = useState(0);
  const theme = resolve(draft);
  const role = EDITABLE[cursor]!;

  useInput((input, key) => {
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(EDITABLE.length - 1, c + 1));
    if (key.leftArrow || key.rightArrow) {
      const r = ramp(THEMES[BASE as keyof typeof THEMES].fg);
      const cur = (theme as unknown as Record<string, string>)[role];
      const idx = r.indexOf(cur);
      const next = clamp((idx === -1 ? 3 : idx) + (key.rightArrow ? 1 : -1), 0, r.length - 1);
      setDraft((d) => ({ ...d, colors: { ...d.colors, [role]: r[next]! } }));
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={theme.accent}>{` B · live form — every keystroke repaints the pane `}</Text>
      <Text> </Text>
      <Box gap={3}>
        <Box flexDirection="column" width={34}>
          {EDITABLE.map((r, i) => {
            const selected = i === cursor;
            return (
              <Text key={r} color={selected ? theme.bg : undefined} backgroundColor={selected ? theme.accent : undefined}>
                {` ${i === cursor ? "›" : " "} ${r.padEnd(8)}${(theme as unknown as Record<string, string>)[r]} `}
              </Text>
            );
          })}
          <Text> </Text>
          <Dim>↑↓ role · ←→ shade · preview repaints →</Dim>
        </Box>
        <LivePreview theme={theme} />
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Variant C — "wizard": one decision per screen, 4 steps
// ---------------------------------------------------------------------------
const STEPS = ["base preset", "body text (fg)", "accent", "review & save"] as const;

function VariantC() {
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [step, setStep] = useState(0);
  const [sel, setSel] = useState(0);
  const theme = resolve(draft);

  useInput((input, key) => {
    if (key.leftArrow) return setStep((s) => Math.max(0, s - 1));
    if (key.rightArrow) return setStep((s) => Math.min(STEPS.length - 1, s + 1));
    if (step === 0) {
      if (key.downArrow) setSel((s) => Math.min(THEME_ORDER.length - 1, s + 1));
      if (key.upArrow) setSel((s) => Math.max(0, s - 1));
      if (key.return || input === "\r") setDraft((d) => ({ ...d, base: THEME_ORDER[sel]! }));
    } else if (step === 1 || step === 2) {
      const role: ColorRole = step === 1 ? "fg" : "accent";
      const r = ramp(THEMES[BASE as keyof typeof THEMES].accent);
      if (key.leftArrow) {
        const cur = (theme as unknown as Record<string, string>)[role];
        const idx = r.indexOf(cur);
        const next = clamp((idx === -1 ? 3 : idx) - 1, 0, r.length - 1);
        setDraft((d) => ({ ...d, colors: { ...d.colors, [role]: r[next]! } }));
      }
      if (key.rightArrow) {
        const cur = (theme as unknown as Record<string, string>)[role];
        const idx = r.indexOf(cur);
        const next = clamp((idx === -1 ? 3 : idx) + 1, 0, r.length - 1);
        setDraft((d) => ({ ...d, colors: { ...d.colors, [role]: r[next]! } }));
      }
    }
  });

  return (
    <Box gap={2} paddingX={1} flexDirection="column">
      <Text bold color={theme.accent}>{` C · wizard — step ${step + 1}/${STEPS.length}: ${STEPS[step]} `}</Text>
      <Text> </Text>
      <Box gap={2}>
        {step === 0 && (
          <Box flexDirection="column">
            {THEME_ORDER.map((name, i) => (
              <Text key={name} color={i === sel ? theme.bg : undefined} backgroundColor={i === sel ? theme.accent : undefined}>
                {` ${i === sel ? "›" : " "} ${themeLabelFor(name, "/nonexistent").replace(" · built-in", "")} `}
              </Text>
            ))}
          </Box>
        )}
        {(step === 1 || step === 2) && (
          <Box flexDirection="column">
            <Dim>{` ${step === 1 ? "fg" : "accent"} — ←→ move along the lightness ramp `}</Dim>
            <Text>
              {ramp(THEMES[BASE as keyof typeof THEMES].accent).map((hex, i) => (
                <Text key={i} backgroundColor={hex} color={hex}>{`    `}</Text>
              ))}
            </Text>
            <Text color={theme.fg}>{` current: ${(theme as unknown as Record<string, string>)[step === 1 ? "fg" : "accent"]} `}</Text>
          </Box>
        )}
        {step === 3 && (
          <Text color={theme.ok}>{` ✓ "${draft.name}" on ${draft.base} — enter saves (prototype: no-op) `}</Text>
        )}
        <LivePreview theme={theme} compact />
      </Box>
      <Text> </Text>
      <Dim>←→ steps · the preview never leaves the screen</Dim>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Variant D — "seed hue": one hue slider drives the whole palette
// ---------------------------------------------------------------------------
function VariantD() {
  // Sliders (↑↓ moves the focused one, ←→ adjusts it; shift = coarse step):
  //   hue        — rotates the whole palette around the color wheel
  //   brightness — global lightness shift
  //   contrast   — pushes lightness away from / toward the mid point
  //   saturation — 0 = grayscale, 1 = vivid
  //   warmth     — splits hue for text (warm) vs chrome (cool) tones
  //
  // Signal colors (ok/warn/err/purple) have two modes:
  //   auto — the global sliders determine them (no per-role overrides)
  //   split — each signal role picks from basic color chips, but the chips
  //           are TINTED LIVE by hue/brightness/contrast/etc, so a chosen
  //           "green" stays in equilibrium with the main settings.
  type Slider = "hue" | "brightness" | "contrast" | "saturation" | "warmth"
    | "ok" | "warn" | "err" | "purple";
  const MAIN: Slider[] = ["hue", "brightness", "contrast", "saturation", "warmth"];
  const SIGNALS: { role: "ok" | "warn" | "err" | "purple"; glyph: string }[] = [
    { role: "ok", glyph: "✓" }, { role: "warn", glyph: "⚠" },
    { role: "err", glyph: "✗" }, { role: "purple", glyph: "◆" },
  ];
  const [slider, setSlider] = useState<Slider>("hue");
  const [splitMode, setSplitMode] = useState(false);
  // Per-signal base chip index (0..7); null = follow the global sliders.
  const [signalPicks, setSignalPicks] = useState<Partial<Record<string, number>>>({});
  const [hue, setHue] = useState(210);
  const [lightShift, setLightShift] = useState(0);
  const [contrast, setContrast] = useState(0);      // -0.5 … +0.5
  const [saturation, setSaturation] = useState(0.6); // 0 … 1
  const [warmth, setWarmth] = useState(0);           // -60 … +60 degrees

  /** Basic color families the user picks from — names, not hex codes. */
  const BASIC_HUES: { name: string; h: number }[] = [
    { name: "red", h: 0 }, { name: "orange", h: 30 }, { name: "yellow", h: 55 },
    { name: "green", h: 130 }, { name: "cyan", h: 185 }, { name: "blue", h: 225 },
    { name: "violet", h: 270 }, { name: "pink", h: 320 },
  ];

  const theme: Theme = (() => {
    const base = THEMES[BASE as keyof typeof THEMES];
    const tint = (hex: string, lBoost: number, warm: number): string => {
      const [h, s, l] = hexToHsl(hex);
      // contrast: push lightness away from the 0.5 midpoint
      const lc = clamp(0.5 + (l + lBoost + lightShift - 0.5) * (1 + contrast), 0.04, 0.95);
      return hslToHex((hue + warm + 360) % 360, saturation * clamp(s, 0.25, 0.85) / 0.6, lc);
    };
    /** A signal color: either the global derivation or a chosen basic hue —
     * both pass through brightness/contrast/saturation so the pick stays in
     * equilibrium with the main settings. */
    const signal = (role: "ok" | "warn" | "err" | "purple", fallbackHex: string): string => {
      const pick = signalPicks[role];
      if (pick === undefined) return tint(fallbackHex, 0, warmth * 0.3);
      const family = BASIC_HUES[pick];
      if (!family) return tint(fallbackHex, 0, warmth * 0.3); // out-of-range pick: fall back to auto
      const [/*h*/, s, l] = hexToHsl(fallbackHex);
      const lc = clamp(0.5 + (l + lightShift - 0.5) * (1 + contrast), 0.25, 0.75);
      return hslToHex(family.h, clamp(saturation, 0.45, 0.95), lc);
    };
    // warmth: text/semantic roles go warm, chrome (bg/surface/border) goes cool
    return {
      ...base,
      label: `Hue ${hue}`,
      fg: tint(base.fg, 0, warmth),
      accent: tint(base.accent, 0, warmth),
      dim: tint(base.dim, 0, warmth * 0.5),
      muted: tint(base.muted, 0, warmth * 0.5),
      ok: signal("ok", base.ok),
      warn: signal("warn", base.warn),
      err: signal("err", base.err),
      purple: signal("purple", base.purple),
      border: tint(base.border, 0, -warmth * 0.5),
      bg: tint(base.bg, 0, -warmth),
      surface: tint(base.surface, 0, -warmth),
      surfaceRaised: tint(base.surfaceRaised, 0, -warmth),
      selection: tint(base.selection, 0, -warmth),
    };
  })();

  useInput((input, key) => {
    const fine = key.shift ? 0.08 : 0.02;
    const all: Slider[] = splitMode ? [...MAIN, ...SIGNALS.map((x) => x.role)] : MAIN;
    if (key.upArrow) setSlider((cur) => all[clamp(all.indexOf(cur) - 1, 0, all.length - 1)]!);
    if (key.downArrow) setSlider((cur) => all[clamp(all.indexOf(cur) + 1, 0, all.length - 1)]!);
    const bump = (set: (n: number) => void, get: number, step: number, lo: number, hi: number, wrap = false) =>
      set(key.leftArrow ? (wrap ? get - step : clamp(get - step, lo, hi)) : key.rightArrow ? (wrap ? get + step : clamp(get + step, lo, hi)) : get);
    if (slider === "hue") bump((n) => setHue(Math.round(((n % 360) + 360) % 360)), hue, key.shift ? 30 : 6, 0, 359, true);
    if (slider === "brightness") bump(setLightShift, lightShift, fine, -0.3, 0.6);
    if (slider === "contrast") bump(setContrast, contrast, fine, -0.5, 0.5);
    if (slider === "saturation") bump(setSaturation, saturation, fine, 0, 1);
    if (slider === "warmth") bump(setWarmth, warmth, key.shift ? 15 : 5, -60, 60);
    // Signal roles: ←→ walks the basic color chips; enter clears back to auto.
    if (SIGNALS.some((x) => x.role === slider)) {
      const role = slider as "ok" | "warn" | "err" | "purple";
      if (key.return || input === "\r") {
        setSignalPicks((p) => { const { [role]: _drop, ...rest } = p; return rest; });
      } else if (key.leftArrow || key.rightArrow) {
        // From auto (-1): ← lands on the last chip, → on the first — never
        // store a sentinel; only real chip indices reach state.
        const cur = signalPicks[role] ?? -1;
        const next = key.leftArrow
          ? (cur === -1 ? BASIC_HUES.length - 1 : (cur - 1 + BASIC_HUES.length) % BASIC_HUES.length)
          : (cur === -1 ? 0 : (cur + 1) % BASIC_HUES.length);
        setSignalPicks((p) => ({ ...p, [role]: next }));
      }
    }
    // s toggles split/auto for the signal colors as a whole.
    if (input === "s") {
      setSplitMode((m) => !m);
      setSlider("hue");
    }
  });

  const value = (s: Slider): string => {
    const sig = SIGNALS.find((x) => x.role === s);
    if (sig) {
      const pick = signalPicks[sig.role];
      return pick === undefined ? "auto" : BASIC_HUES[pick]!.name;
    }
    return s === "hue" ? `${hue}°` :
      s === "brightness" ? `${lightShift >= 0 ? "+" : ""}${Math.round(lightShift * 100)}%` :
      s === "contrast" ? `${contrast >= 0 ? "+" : ""}${Math.round(contrast * 100)}%` :
      s === "saturation" ? `${Math.round(saturation * 100)}%` :
      `${warmth >= 0 ? "+" : ""}${warmth}°`;
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={theme.accent}>{` D · five sliders, zero hex — the screen IS the preview `}</Text>
      <Text> </Text>
      {MAIN.map((s) => {
        const focused = slider === s;
        return (
          <Text key={s} color={focused ? theme.bg : undefined} backgroundColor={focused ? theme.accent : undefined}>
            {` ${focused ? "›" : " "} ${s.padEnd(12)}${value(s).padStart(5)} ${focused ? "←→ adjusts · shift = coarse" : ""} `}
          </Text>
        );
      })}
      <Text> </Text>
      <Text color={splitMode ? theme.accent : theme.muted}>{` signal colors (✓ ⚠ ✗ ◆): ${splitMode ? "split — pick per role" : "auto — follow the sliders above"} (s toggles)`}</Text>
      {splitMode && SIGNALS.map(({ role, glyph }) => {
        const focused = slider === role;
        const pick = signalPicks[role];
        return (
          <Text key={role} color={focused ? theme.bg : undefined} backgroundColor={focused ? theme.accent : undefined}>
            {` ${focused ? "›" : " "} ${glyph} ${role.padEnd(11)}${value(role).padStart(5)} ${focused ? "←→ basic colors · ⏎ back to auto" : ""} `}
          </Text>
        );
      })}
      {splitMode && slider === SIGNALS.find((x) => x.role === slider)?.role && (
        <Text>
          {BASIC_HUES.map(({ name, h }, i) => {
            // Chips tinted with the CURRENT brightness/contrast/saturation
            const [/*h0*/, s0, l0] = hexToHsl(THEMES[BASE as keyof typeof THEMES].ok);
            const lc = clamp(0.5 + (l0 + lightShift - 0.5) * (1 + contrast), 0.25, 0.75);
            const hex = hslToHex(h, clamp(saturation, 0.45, 0.95), lc);
            return <Text key={i} backgroundColor={hex} color={i === signalPicks[slider as "ok"] ? theme.bg : hex}>{name.slice(0, 2)}</Text>;
          })}
        </Text>
      )}
      <Text> </Text>
      <LivePreview theme={theme} />
      <Text> </Text>
      <Text color={theme.muted}>{` ↑↓ slider · ←→ value (shift = coarse) · s split/auto signals — everything repaints live `}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Prototype switcher (bottom bar) — same grammar as tree-prototype
// ---------------------------------------------------------------------------
const VARIANTS: [string, string, React.FC][] = [
  ["A", "swatch grid + ramp picker", VariantA],
  ["B", "live form + preview pane", VariantB],
  ["C", "wizard, one decision per step", VariantC],
  ["D", "seed hue, zero hex", VariantD],
];

function Switcher({ v, setV }: { v: number; setV: (n: number) => void }) {
  // ←/→ belong to the variants' own interaction; variant switching lives on
  // tab / shift+tab (and [ ] as aliases) so both layers never collide.
  useInput((input, key) => {
    if (key.tab && !key.shift) setV((v + 1) % VARIANTS.length);
    if (key.tab && key.shift) setV((v - 1 + VARIANTS.length) % VARIANTS.length);
    if (input === "]") setV((v + 1) % VARIANTS.length);
    if (input === "[") setV((v - 1 + VARIANTS.length) % VARIANTS.length);
  });
  const [key, name] = VARIANTS[v];
  return (
    <Box justifyContent="center">
      <Box borderStyle="round" paddingX={1}>
        <Text>⇥ </Text>
        <Text color="cyan">{`${key} (${name})`}</Text>
        <Text> ⇥</Text>
      </Box>
    </Box>
  );
}

export function ThemeEditorPrototype() {
  const [v, setV] = useState(() => Number.parseInt(process.env.PROTO_V ?? "0", 10) || 0);
  const Variant = VARIANTS[v][2];
  return (
    <Box flexDirection="column">
      <Variant />
      <Switcher v={v} setV={setV} />
    </Box>
  );
}

if (import.meta.main) render(<ThemeEditorPrototype />);
