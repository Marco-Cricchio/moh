/**
 * Theme studio modal (#749 redesign, from prototype variant D): a visual
 * theme editor — five global sliders, live previews, and per-element color
 * picks from basic color families. No hex codes anywhere.
 *
 * Opened from Settings → "My themes…". Everything repaints live; nothing is
 * persisted until the user names the theme and saves (save = apply).
 */
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { THEMES, paintable, type Theme } from "./themes";
import { colorEnabled } from "./color";
import { Dialog, Dim } from "./ui";
import { deleteUserTheme, guessExtendsOf, listUserThemes } from "./user-themes";

const slugify = (v: string): string => v.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");

// --- color math (from the prototype; throwaway-grade but dependency-free) ---
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
/** Blend two hex colors (prototype mix()): amount of `a` over `b`. */
function mix(a: string, b: string, amount: number): string {
  const rgb = (value: string) => [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
  const aa = rgb(a), bb = rgb(b);
  return `#${aa.map((value, i) => Math.round(value * amount + bb[i]! * (1 - amount)).toString(16).padStart(2, "0")).join("")}`;
}

/** Basic color families the user picks from — names, not hex codes. */
const BASIC_HUES: { name: string; h: number }[] = [
  { name: "red", h: 0 }, { name: "vermilion", h: 15 }, { name: "orange", h: 30 },
  { name: "amber", h: 45 }, { name: "yellow", h: 55 }, { name: "lime", h: 90 },
  { name: "green", h: 130 }, { name: "teal", h: 165 }, { name: "cyan", h: 185 },
  { name: "azure", h: 205 }, { name: "blue", h: 225 }, { name: "indigo", h: 250 },
  { name: "violet", h: 270 }, { name: "pink", h: 320 },
];

type Main = "hue" | "brightness" | "contrast" | "saturation" | "warmth";
const MAIN: Main[] = ["hue", "brightness", "contrast", "saturation", "warmth"];
const SIGNALS: { role: "ok" | "warn" | "err" | "purple"; glyph: string }[] = [
  { role: "ok", glyph: "✓" }, { role: "warn", glyph: "⚠" },
  { role: "err", glyph: "✗" }, { role: "purple", glyph: "◆" },
];
/** Chat box families — ids carry a "box:" prefix so they can never collide
 * with signal role names (that collision once made the box rows unreachable). */
const BOXES: { id: string; label: string }[] = [
  { id: "box:user", label: "› you" },
  { id: "box:moh", label: "◆ moh" },
  { id: "box:tool-run", label: "◌ running" },
  { id: "box:ok", label: "✓ ok" },
  { id: "box:fail", label: "✗ failed" },
  { id: "box:error", label: "✗ error" },
  { id: "box:code", label: "⌨ code" },
  { id: "box:diff", label: "⌨ diff" },
  { id: "box:thinking", label: "◌ thinking" },
  { id: "box:chrome", label: "◌ cancel" },
  { id: "box:subagent", label: "◐ subagent" },
];

export interface ThemeStudioModalProps {
  home: string;
  /** The preset the studio derives from. */
  base: string;
  /** The currently active theme ref — deleting it falls back to its base. */
  activeRef: string;
  onToast: (message: string) => void;
  /** Persist + apply the draft: receives the resolved colors per role. */
  onSave: (id: string, name: string, colors: Record<string, string>) => void;
  /** Apply another theme ref (delete fallback for the active theme). */
  onApplyRef: (ref: string) => void;
  onClose: () => void;
}

export function ThemeStudioModal({ home, base, activeRef, onToast, onSave, onApplyRef, onClose }: ThemeStudioModalProps) {
  type Row = Main | "ok" | "warn" | "err" | "purple" | string; // box ids in split mode
  const [row, setRow] = useState<Row>("hue");
  const [splitMode, setSplitMode] = useState(false);
  const [signalPicks, setSignalPicks] = useState<Partial<Record<string, number>>>({});
  const [boxPicks, setBoxPicks] = useState<Partial<Record<string, number>>>({});
  const [hue, setHue] = useState(210);
  const [lightShift, setLightShift] = useState(0);
  const [contrast, setContrast] = useState(0);
  const [saturation, setSaturation] = useState(0.6);
  const [warmth, setWarmth] = useState(0);
  const [naming, setNaming] = useState(false);
  const [nameBuf, setNameBuf] = useState("");
  // Manage view: list personal themes for rename/delete (r toggles it).
  const [managing, setManaging] = useState(false);
  const [manageCursor, setManageCursor] = useState(0);

  const baseTheme = THEMES[base as keyof typeof THEMES] ?? THEMES["tokyo-night"];

  const theme: Theme = (() => {
    const tint = (hex: string, warm: number): string => {
      const [h, s, l] = hexToHsl(hex);
      const lc = clamp(0.5 + (l + lightShift - 0.5) * (1 + contrast), 0.04, 0.95);
      return hslToHex((hue + warm + 360) % 360, saturation * clamp(s, 0.25, 0.85) / 0.6, lc);
    };
    const pickedHex = (pick: number | undefined, fallbackHex: string, lo = 0.25, hi = 0.75): string => {
      if (pick === undefined) return tint(fallbackHex, warmth * 0.3);
      const family = BASIC_HUES[pick];
      if (!family) return tint(fallbackHex, warmth * 0.3);
      const [/*h*/, s, l] = hexToHsl(fallbackHex);
      const lc = clamp(0.5 + (l + lightShift - 0.5) * (1 + contrast), lo, hi);
      return hslToHex(family.h, clamp(saturation, 0.45, 0.95), lc);
    };
    // warmth: text/semantic roles go warm, chrome (bg/surface/border) goes cool
    return {
      ...baseTheme,
      label: `Hue ${hue}`,
      fg: tint(baseTheme.fg, warmth),
      accent: tint(baseTheme.accent, warmth),
      dim: tint(baseTheme.dim, warmth * 0.5),
      muted: tint(baseTheme.muted, warmth * 0.5),
      ok: pickedHex(signalPicks.ok, baseTheme.ok),
      warn: pickedHex(signalPicks.warn, baseTheme.warn),
      err: pickedHex(signalPicks.err, baseTheme.err),
      purple: pickedHex(signalPicks.purple, baseTheme.purple),
      border: tint(baseTheme.border, -warmth * 0.5),
      bg: tint(baseTheme.bg, -warmth),
      surface: tint(baseTheme.surface, -warmth),
      surfaceRaised: tint(baseTheme.surfaceRaised, -warmth),
      selection: tint(baseTheme.selection, -warmth),
    };
  })();

  /**
   * #880: the studio *paints* the palette under construction, so it is a
   * color surface by nature. With `NO_COLOR` it shows its previews uncolored
   * — tokens through the projection, derived hues and tints suppressed — and
   * the draft stays intact: only what reaches the screen is affected, never
   * what `onSave` persists.
   */
  const paint = paintable(theme);
  const colorOn = colorEnabled();
  /** A swatch is color: without it the cell keeps its character (a hue
   * letter, a family name) instead of a filled block. */
  const swatch = (hex: string): string | undefined => (colorOn ? hex : undefined);

  /** Resolved color of one chat box (box pick > signal pick > theme token). */
  const boxColor = (id: string): string | undefined => {
    const short = id.replace(/^box:/, "");
    const direct = boxPicks[id];
    if (direct !== undefined && colorOn) {
      const family = BASIC_HUES[direct];
      if (family) {
        const [/*h*/, s, l] = hexToHsl(baseTheme.fg);
        const lc = clamp(0.5 + (l + lightShift - 0.5) * (1 + contrast), 0.3, 0.75);
        return hslToHex(family.h, clamp(saturation, 0.45, 0.95), lc);
      }
    }
    if (short === "ok") return paint.ok;
    if (short === "fail" || short === "error") return paint.err;
    if (short === "user") return paint.warn;
    if (short === "code" || short === "diff") return paint.purple;
    if (short === "moh" || short === "tool-run" || short === "subagent") return paint.accent;
    return paint.dim;
  };

  useInput((input, key) => {
    if (naming) {
      if (key.escape) return setNaming(false);
      if (key.backspace || key.delete) return setNameBuf((b) => b.slice(0, -1));
      if (key.return || input === "\n") {
        const name = nameBuf.trim();
        if (!name) return onToast("theme name required — esc cancels");
        const id = slugify(name);
        if (!id) return onToast("name must contain a slug-able word");
        onSave(id, name, {
          fg: theme.fg, accent: theme.accent, dim: theme.dim, muted: theme.muted,
          ok: theme.ok, warn: theme.warn, err: theme.err, purple: theme.purple,
          border: theme.border, bg: theme.bg, surface: theme.surface,
          surfaceRaised: theme.surfaceRaised, selection: theme.selection,
        });
        return onClose();
      }
      if (input && !key.ctrl && !key.meta) return setNameBuf((b) => b + input);
      return;
    }
    if (managing) {
      const themes = listUserThemes(home);
      if (key.escape) return setManaging(false);
      if (key.upArrow) return setManageCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) return setManageCursor((c) => Math.min(Math.max(0, themes.length - 1), c + 1));
      if (input === "d" && !key.ctrl && !key.meta) {
        const target = themes[manageCursor];
        if (!target) return;
        const wasActive = activeRef === `user:${target.id}`;
        // Read the extends base BEFORE deleting — afterwards the file is
        // gone and the guess falls back to tokyo-night.
        const extendsBase = guessExtendsOf(home, target.id);
        deleteUserTheme(home, target.id);
        if (wasActive) onApplyRef(extendsBase);
        onToast(`theme deleted: ${target.name}${wasActive ? " — fell back to its base" : ""}`);
        // Keep the manage view open; clamp the cursor to the shorter list.
        setManageCursor((c) => Math.min(c, Math.max(0, themes.length - 2)));
        return;
      }
      return;
    }
    // r opens the manage view (list personal themes; d deletes there).
    if (input === "r" && !key.ctrl && !key.meta) {
      if (listUserThemes(home).length === 0) return onToast("no personal themes yet — save one with n");
      setManaging(true);
      setManageCursor(0);
      return;
    }
    // n names & saves the draft — global, handled before per-row dispatch so
    // override rows can't swallow it.
    if (input === "n" && !key.ctrl && !key.meta) return setNaming(true);
    // s toggles split/auto from any row; enabling split moves the focus to
    // the first override row (ok) so the next ↓ continues down the list.
    if (input === "s" && !key.ctrl && !key.meta) {
      setSplitMode((m) => {
        if (!m) setRow(SIGNALS[0]!.role);
        return !m;
      });
      return;
    }
    const fine = key.shift ? 0.08 : 0.02;
    const splitRows: Row[] = splitMode ? [...SIGNALS.map((x) => x.role), ...BOXES.map((b) => b.id)] : [];
    const all: Row[] = [...MAIN, ...splitRows];
    if (key.escape) return onClose();
    if (key.upArrow) return setRow((cur) => all[clamp(all.indexOf(cur) - 1, 0, all.length - 1)]!);
    if (key.downArrow) return setRow((cur) => all[clamp(all.indexOf(cur) + 1, 0, all.length - 1)]!);
    if (row === "hue") {
      if (key.leftArrow) return setHue((h) => (h + 360 - (key.shift ? 30 : 6)) % 360);
      if (key.rightArrow) return setHue((h) => (h + (key.shift ? 30 : 6)) % 360);
    }
    const bump = (set: (n: number) => void, get: number, step: number, lo: number, hi: number) =>
      set(key.leftArrow ? clamp(get - step, lo, hi) : key.rightArrow ? clamp(get + step, lo, hi) : get);
    if (row === "brightness") return bump(setLightShift, lightShift, fine, -0.3, 0.6);
    if (row === "contrast") return bump(setContrast, contrast, fine, -0.5, 0.5);
    if (row === "saturation") return bump(setSaturation, saturation, fine, 0, 1);
    if (row === "warmth") return bump(setWarmth, warmth, key.shift ? 15 : 5, -60, 60);
    // Signal & box rows: ←→ walks the basic color chips; enter clears to auto.
    const picking = SIGNALS.some((x) => x.role === row) ? signalPicks : BOXES.some((b) => b.id === row) ? boxPicks : null;
    if (picking) {
      const store = SIGNALS.some((x) => x.role === row) ? setSignalPicks : setBoxPicks;
      if (key.return || input === "\n") {
        store((p) => { const { [row]: _drop, ...rest } = p; return rest; });
      } else if (key.leftArrow || key.rightArrow) {
        // From auto (-1): ← lands on the last chip, → on the first — never
        // store a sentinel; only real chip indices reach state.
        const cur = picking[row] ?? -1;
        const next = key.leftArrow
          ? (cur === -1 ? BASIC_HUES.length - 1 : (cur - 1 + BASIC_HUES.length) % BASIC_HUES.length)
          : (cur === -1 ? 0 : (cur + 1) % BASIC_HUES.length);
        store((p) => ({ ...p, [row]: next }));
      }
      return;
    }
  });

  const pickOf = (r: Row): number | undefined => signalPicks[r] ?? boxPicks[r];
  const value = (r: Row): string => {
    if (r === "hue" || r === "brightness" || r === "contrast" || r === "saturation" || r === "warmth") {
      return r === "hue" ? `${hue}°` :
        r === "brightness" ? `${lightShift >= 0 ? "+" : ""}${Math.round(lightShift * 100)}%` :
        r === "contrast" ? `${contrast >= 0 ? "+" : ""}${Math.round(contrast * 100)}%` :
        r === "saturation" ? `${Math.round(saturation * 100)}%` :
        `${warmth >= 0 ? "+" : ""}${warmth}°`;
    }
    const pick = pickOf(r);
    return pick === undefined ? "auto" : BASIC_HUES[pick]!.name;
  };
  const isSplitRow = (r: Row): boolean => SIGNALS.some((x) => x.role === r) || BOXES.some((b) => b.id === r);

  const mainRow = (sl: Main) => {
    const focused = row === sl;
    return (
      <Box key={sl} flexDirection="column">
        {!(focused && sl === "hue") && (
          <Text color={focused ? paint.bg : undefined} backgroundColor={focused ? paint.accent : undefined}>
            {` ${focused ? "›" : " "} ${sl.padEnd(12)}${value(sl).padStart(6)}`.padEnd(24)}
          </Text>
        )}
        {focused && sl === "hue" && (
          // "hue" is plain text on the strip's left cells; a │ marker at the
          // strip center marks the current value (the color window slides
          // under it when ←→ rotates); the ←→ hint rides the right end.
          <Box width={24}>
            <Text color={paint.muted}>{` › `}</Text>
            <Text>
              {Array.from({ length: 20 }, (_, i) => {
                const h = (hue + (i - 9) * 6 + 3600) % 360;
                const hex = hslToHex(h, clamp(saturation, 0.45, 0.95), 0.55);
                const inLabel = i >= 1 && i <= 3;
                const isMarker = i === 9;
                const inHint = i >= 17 && i <= 18;
                const ch = inLabel ? "hue"[i - 1] : isMarker ? "│" : inHint ? "←→"[i - 17] : " ";
                const onCell = inLabel || isMarker || inHint;
                return <Text key={i} backgroundColor={swatch(hex)} color={onCell ? paint.bg : swatch(hex)}>{ch}</Text>;
              })}
            </Text>
          </Box>
        )}
      </Box>
    );
  };

  const overrideRow = (key: string, label: string, val: string, focused: boolean) => (
    <Text key={key} color={focused ? paint.bg : undefined} backgroundColor={focused ? paint.accent : undefined}>
      {` ${focused ? "›" : " "} ${label}${val.padStart(7)}`.padEnd(24)}
    </Text>
  );

  // A tint is color: without it the gallery rows keep their glyphs and text.
  const tintOf = (semantic: string | undefined, amount: number): string | undefined =>
    semantic === undefined || paint.surface === undefined || !colorOn ? undefined : mix(semantic, paint.surface, amount);
  const galleryBoxes = [
    { id: "box:user", color: boxColor("box:user"), tintAmount: 0.14, head: "› you", detail: "fix the login redirect" },
    { id: "box:moh", color: boxColor("box:moh"), tintAmount: 0.14, head: "◆ moh", detail: "checked the router" },
    { id: "box:tool-run", color: boxColor("box:tool-run"), tintAmount: 0.14, head: "◌ bash ⏱ 2.1s", detail: "running rg 'jwt'" },
    { id: "box:ok", color: boxColor("box:ok"), tintAmount: 0.14, head: "✓ edit", detail: "src/auth.ts · 12 lines" },
    { id: "box:fail", color: boxColor("box:fail"), tintAmount: 0.2, head: "✗ test", detail: "2 assertions failed" },
    { id: "box:error", color: boxColor("box:error"), tintAmount: 0.2, head: "✗ error", detail: "provider unreachable" },
    { id: "box:code", color: boxColor("box:code"), tintAmount: 0.14, head: "⌨ preview", detail: "auth.ts · 40–52" },
    { id: "box:diff", color: boxColor("box:diff"), tintAmount: 0.14, head: "⌨ diff", detail: "+ refresh · − retry" },
    { id: "box:thinking", color: boxColor("box:thinking"), tintAmount: 0, head: "◌ thinking", detail: "tracing the path…" },
    { id: "box:chrome", color: boxColor("box:chrome"), tintAmount: 0.07, head: "◌ cancelled", detail: "turn interrupted" },
    { id: "box:subagent", color: boxColor("box:subagent"), tintAmount: 0.07, head: "◐ explore", detail: "child · running" },
  ];

  return (
    <Dialog title=" theme studio " color={paint.accent}>
      {naming ? (
        <Box flexDirection="column">
          <Text bold>{`theme name: ${nameBuf}▏`}</Text>
          <Text> </Text>
          <Dim>enter save &amp; apply · esc back to the studio</Dim>
        </Box>
      ) : managing ? (
        <Box flexDirection="column">
          <Text bold>my themes</Text>
          <Text> </Text>
          {listUserThemes(home).map((t, i) => {
            const selected = i === manageCursor;
            return (
              <Text key={t.id} color={selected ? paint.bg : undefined} backgroundColor={selected ? paint.accent : undefined}>
                {` ${selected ? "›" : " "} ${t.name.padEnd(24)}${activeRef === `user:${t.id}` ? "active" : ""}`}
              </Text>
            );
          })}
          <Text> </Text>
          <Dim>d delete{activeRef.startsWith("user:") ? " (active falls back to its base)" : ""} · esc back to the studio</Dim>
        </Box>
      ) : (
        <Box flexDirection="column">
          {/* main sliders, two columns: hue+brightness left, the rest right */}
          <Box gap={2}>
            <Box flexDirection="column">{MAIN.slice(0, 2).map(mainRow)}</Box>
            <Box flexDirection="column">{MAIN.slice(2).map(mainRow)}</Box>
          </Box>
          <Text> </Text>
          <Text color={splitMode ? paint.accent : paint.muted}>{` overrides: ${splitMode ? "split — pick per element" : "auto — follow the sliders above"} (s toggles)`}</Text>
          {splitMode && (() => {
            const BOX_COL1 = BOXES.slice(0, 5);
            const BOX_COL2 = BOXES.slice(5);
            const rows = Math.max(SIGNALS.length, BOX_COL1.length, BOX_COL2.length);
            const cells: React.ReactNode[] = [];
            for (let i = 0; i < rows; i++) {
              const sig = SIGNALS[i];
              const b1 = BOX_COL1[i];
              const b2 = BOX_COL2[i];
              cells.push(
                <Box key={`orow-${i}`} gap={2}>
                  <Box>{sig ? overrideRow(sig.role, `${sig.glyph} ${sig.role.padEnd(8)}`, value(sig.role), row === sig.role) : <Text>{" ".repeat(24)}</Text>}</Box>
                  <Box>{b1 ? overrideRow(b1.id, `box ${b1.label.padEnd(11)}`, value(b1.id), row === b1.id) : <Text>{" ".repeat(24)}</Text>}</Box>
                  <Box>{b2 ? overrideRow(b2.id, `box ${b2.label.padEnd(11)}`, value(b2.id), row === b2.id) : <Text>{" ".repeat(24)}</Text>}</Box>
                </Box>,
              );
            }
            return cells;
          })()}
          {splitMode && isSplitRow(row) && (
            <Text>
              {BASIC_HUES.map(({ name, h }, i) => {
                // Chips tinted with the CURRENT brightness/contrast/saturation
                const [/*h0*/, s0, l0] = hexToHsl(baseTheme.ok);
                const lc = clamp(0.5 + (l0 + lightShift - 0.5) * (1 + contrast), 0.25, 0.75);
                const hex = hslToHex(h, clamp(saturation, 0.45, 0.95), lc);
                return <Text key={i} backgroundColor={swatch(hex)} color={i === pickOf(row) ? paint.bg : swatch(hex)}>{name.slice(0, 3)}</Text>;
              })}
            </Text>
          )}
          <Text> </Text>
          {/* previews side by side: transcript mini-pane + chat-box gallery */}
          <Box gap={2}>
            <Box flexDirection="column" borderStyle="round" borderColor={paint.border} paddingX={1} width={35}>
              <Text color={paint.dim}> preview </Text>
              <Text color={paint.warn}>› you</Text>
              <Text color={paint.dim}>  check this color</Text>
              <Text color={paint.accent}>◆ moh</Text>
              <Text color={paint.fg}>  body text repaints live</Text>
              <Text color={paint.muted}>  muted: secondary text</Text>
              <Text color={paint.dim}>  dim: chrome, timestamps</Text>
              <Text> </Text>
              <Text>
                <Text backgroundColor={paint.accent} color={paint.bg}>{` ⏎ `}</Text>
                <Text color={paint.dim}>{` send `}</Text>
                <Text backgroundColor={paint.surfaceRaised} color={paint.fg}>{` esc `}</Text>
                <Text color={paint.dim}>{` stop `}</Text>
              </Text>
              <Text> </Text>
              <Text>
                <Text color={paint.ok}>✓ ok </Text>
                <Text color={paint.warn}>⚠ warn </Text>
                <Text color={paint.err}>✗ err </Text>
                <Text color={paint.purple}>◆ purple</Text>
              </Text>
            </Box>
            <Box flexDirection="column" borderStyle="round" borderColor={paint.border} paddingX={1} width={40}>
              <Text color={paint.dim}> chat command boxes </Text>
              <Text> </Text>
              {galleryBoxes.map((b) => (
                <Box key={b.id} backgroundColor={b.tintAmount > 0 ? tintOf(b.color, b.tintAmount) : undefined} paddingLeft={1}>
                  <Text color={b.color}>{b.head}</Text>
                  <Text color={paint.dim}>{` ${b.detail}`}</Text>
                </Box>
              ))}
            </Box>
          </Box>
          <Text> </Text>
          <Text color={paint.muted}>{` ↑↓ row · ←→ value (shift = coarse) · s split/auto · ⏎ auto · n name & save · r my themes `}</Text>
          <Dim>{` deriving from "${base}" — nothing is saved until you name it`}</Dim>
        </Box>
      )}
    </Dialog>
  );
}
