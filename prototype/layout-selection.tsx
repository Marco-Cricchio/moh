// PROTOTYPE (throwaway) — layout alternatives for multi-line mouse text selection.
// Question: "which session-screen layout makes multi-line text selection work?"
// Run: bun prototype/layout-selection.tsx
// Keys: [←/→] or [1][2][3] switch variant · [q] quit
//
// Variant 1 "dashboard"   — the current 3-column framed layout (baseline: the problem)
// Variant 2 "scrollback"  — pi-style: transcript written to native terminal scrollback
//                           via Ink <Static> (printed once, never repainted), full-width,
//                           one-line header, input at the bottom, panels become overlays
// Variant 3 "frameless"   — centered ~100-col column, no borders around the transcript,
//                           no permanent sidebars (compromise: window still fixed-height)
//
// TRY SELECTING the multi-line code block in each variant with the mouse.
import React, { useState } from "react";
import { render, Box, Text, useInput, useApp, Static } from "ink";

type Variant = "dashboard" | "scrollback" | "frameless";
const VARIANTS: Variant[] = ["dashboard", "scrollback", "frameless"];
const LABELS: Record<Variant, string> = {
  dashboard: "1 — Dashboard (current, baseline)",
  scrollback: "2 — Native scrollback (Static)",
  frameless: "3 — Frameless centered column",
};

const C = { accent: "#7aa2f7", dim: "#565f89", ok: "#9ece6a", warn: "#e0af68", border: "#292e42", fg: "#c0caf5" };

// Fake transcript with content that stresses selection: wrapped paragraphs,
// a multi-line code block, a tool call.
const TURNS: Array<{ who: "you" | "moh"; body: string[] }> = [
  { who: "you", body: ["Come mai il layout attuale non permette la selezione multi-riga del testo?"] },
  {
    who: "moh",
    body: [
      "Perché il transcript vive in una finestra ad altezza fissa dentro un frame a tre colonne: la storia oltre la finestra non è nello scrollback nativo, e ogni riga selezionata trascina con sé i bordi dei pannelli e il testo delle sidebar. Inoltre Ink ridipinge il frame a ogni tick di streaming, il che può interrompere una selezione in corso.",
      "",
      "```ts",
      "// blocco multi-riga: prova a selezionarmi col mouse",
      "export function chatWindowRows(v: Viewport, inputLines = 1): number {",
      "  const total = layoutClass(v) === \"dashboard\" ? bodyRows(v) : v.rows;",
      "  const extra = Math.max(0, Math.max(1, inputLines) - 1);",
      "  return Math.max(CHAT_WINDOW_MIN_ROWS, total - CHAT_CHROME_ROWS - extra);",
      "}",
      "```",
      "",
      "La riga lunga va a capo alla larghezza della colonna: se ci sono pannelli a fianco, la selezione cattura anche i loro caratteri — prova qui sopra e poi nella variante 2.",
    ],
  },
  { who: "you", body: ["Mostrami le alternative."] },
  {
    who: "moh",
    body: [
      "Tre varianti in questo prototipo. La 2 è l'unica in cui la selezione multi-riga funziona davvero: il testo è output terminale puro, scritto una volta sola e mai ridipinto.",
    ],
  },
];

const STATIC_ITEM = { id: "all", turns: TURNS };

const Turn = ({ t }: { t: (typeof TURNS)[number] }) => (
  <Box paddingX={1} flexDirection="column">
    <Text color={t.who === "you" ? C.warn : C.accent}>{t.who === "you" ? "you" : "moh"}</Text>
    {t.body.map((line, i) => (
      <Text key={i} color={C.fg} wrap="truncate-end">
        {line === "" ? " " : line}
      </Text>
    ))}
    <Text> </Text>
  </Box>
);

function Switcher({ v }: { v: Variant }) {
  return (
    <Box borderStyle="round" borderColor={C.warn} paddingX={1} flexShrink={0} alignSelf="center">
      <Text color={C.warn}>‹ PROTOTYPE › {LABELS[v]} [←/→] switch · [q] quit</Text>
    </Box>
  );
}

// ── Variant 2: Static scrollback + bottom input ───────────────────────────
function Scrollback() {
  const [draft, setDraft] = useState("");
  useInput((input, key) => {
    if (input && !key.return && !key.escape) setDraft((d) => (d + input).slice(0, 60));
    if (key.backspace || key.delete) setDraft((d) => d.slice(0, -1));
    if (key.return) setDraft("");
  });
  return (
    <Box flexDirection="column">
      {/* Printed ONCE into native scrollback — never repainted, fully selectable. */}
      <Static items={[STATIC_ITEM]}>
        {({ turns }) => (
          <Box flexDirection="column">
            {turns.map((t, i) => (
              <Turn key={i} t={t} />
            ))}
          </Box>
        )}
      </Static>
      <Box flexDirection="column" flexShrink={0}>
        <Box paddingX={1}>
          <Text color={C.dim}>moh · claude-sonnet · 12,340 tok · vibe</Text>
        </Box>
        <Box borderStyle="round" borderColor={C.border} paddingX={1}>
          <Text color={C.fg}>› {draft}</Text>
        </Box>
      </Box>
    </Box>
  );
}

// ── Variant 3: frameless centered column ──────────────────────────────────
function Frameless() {
  return (
    <Box flexDirection="column" alignItems="center">
      <Box flexDirection="column" width={100}>
        <Box paddingX={1} justifyContent="space-between" flexShrink={0}>
          <Text color={C.dim}>moh · claude-sonnet</Text>
          <Text color={C.dim}>12,340 tok · ^f frontier · ^o mode</Text>
        </Box>
        <Text> </Text>
        {TURNS.map((t, i) => (
          <Turn key={i} t={t} />
        ))}
        <Box borderStyle="round" borderColor={C.border} paddingX={1}>
          <Text color={C.fg}>› </Text>
        </Box>
      </Box>
    </Box>
  );
}

// ── Variant 1: current dashboard (baseline) ───────────────────────────────
function DashboardBaseline() {
  const menu = ["Dashboard", "Sessions", "Wayfinder", "Settings", "Help"];
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" paddingX={1} flexShrink={0}>
        <Text color={C.accent}>moh</Text>
        <Text color={C.dim}>claude-sonnet · 12,340 tok</Text>
      </Box>
      <Box gap={1} height={16}>
        <Box flexDirection="column" width={16} borderStyle="round" borderColor={C.border}>
          {menu.map((m) => (
            <Box key={m} paddingX={1}>
              <Text color={m === "Dashboard" ? C.accent : C.fg}>{m === "Dashboard" ? "› " : "  "}{m}</Text>
            </Box>
          ))}
        </Box>
        <Box flexGrow={1} flexDirection="column">
          <Box flexDirection="column" borderStyle="round" borderColor={C.border} height={10} paddingX={1}>
            {TURNS.slice(0, 2).map((t, i) => (
              <Turn key={i} t={t} />
            ))}
          </Box>
          <Box borderStyle="round" borderColor={C.border} paddingX={1}>
            <Text color={C.fg}>› </Text>
          </Box>
        </Box>
        <Box width={24} borderStyle="round" borderColor={C.border} flexDirection="column" paddingX={1}>
          <Text color={C.accent}>Activity</Text>
          <Text color={C.fg}>read packages/tui/src/…</Text>
          <Text color={C.dim}>bash: bun test</Text>
          <Text color={C.accent}>Tokens</Text>
          <Text color={C.fg}>in 11,204 · out 1,136</Text>
        </Box>
      </Box>
    </Box>
  );
}

function App() {
  const { exit } = useApp();
  const [idx, setIdx] = useState(1);
  const v = VARIANTS[idx]!;
  useInput((input, key) => {
    if (input === "q") return exit();
    if (input === "1") return setIdx(0);
    if (input === "2") return setIdx(1);
    if (input === "3") return setIdx(2);
    if (key.leftArrow) return setIdx((i) => (i + VARIANTS.length - 1) % VARIANTS.length);
    if (key.rightArrow) return setIdx((i) => (i + 1) % VARIANTS.length);
  });
  return (
    <Box flexDirection="column">
      {v === "dashboard" && <DashboardBaseline />}
      {v === "frameless" && <Frameless />}
      {v === "scrollback" && <Scrollback />}
      <Text> </Text>
      <Switcher v={v} />
    </Box>
  );
}

render(<App />, { exitOnCtrlC: true });
