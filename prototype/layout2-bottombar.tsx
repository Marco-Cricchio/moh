// PROTOTYPE (throwaway) — layout 2: scrollback nativo + bottom bar.
// Run:   NODE_ENV=production bun prototype/layout2-bottombar.tsx
//        (NODE_ENV=production azzera i falsi warning duplicate-key di Ink/Static in dev)
// Keys:  [y] tema · [b] bottom bar on/off · [q] quit
//
// Regola d'oro del layout: NESSUN carattere di cornice attorno al transcript
// (niente │┌╰): qualunque glifo sulla riga finirebbe nel copia-incolla. La
// firma visiva di ogni tipologia è data da struttura, colore e ritmo:
//
//   glyph tipo                    ← riga etichetta (glifo colore + tipo + dettaglio)
//     corpo indentato di 2        ← contenuto selezionabile pulito
//                                   ← riga vuota di separazione tra blocchi
//
// Cambio tema: remount dell'albero (key), il transcript si ristampa nella
// nuova palette — stessa strategia del themeTick dell'App reale.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { render, Box, Text, useInput, useApp, useStdout, Static } from "ink";

// NB: temi vendorati da packages/tui/src/themes.ts (l'import cross-package
// triggera il quirk duplicate-key di Ink — prototipo, la copia va bene).
export interface Theme {
  label: string;
  fg: string;
  accent: string;
  dim: string;
  ok: string;
  warn: string;
  err: string;
  purple: string;
  border: string;
  bg: string;
}

export const THEMES = {
  "tokyo-night": { label: "Tokyo Night", fg: "#c0caf5", accent: "#7aa2f7", dim: "#565f89", ok: "#9ece6a", warn: "#e0af68", err: "#f7768e", purple: "#bb9af7", border: "#292e42", bg: "#16161e" },
  "catppuccin": { label: "Catppuccin Mocha", fg: "#cdd6f4", accent: "#89b4fa", dim: "#6c7086", ok: "#a6e3a1", warn: "#f9e2af", err: "#f38ba8", purple: "#cba6f7", border: "#45475a", bg: "#1e1e2e" },
  "gruvbox-material": { label: "Gruvbox · Material", fg: "#d4be98", accent: "#89b482", dim: "#7c6f64", ok: "#a9b665", warn: "#d8a657", err: "#ea6962", purple: "#d3869b", border: "#45403d", bg: "#1d2021" },
  "phosphor": { label: "Green Phosphor", fg: "#00ff00", accent: "#00ff00", dim: "#008800", ok: "#00cc00", warn: "#00ff41", err: "#ff5555", purple: "#00dd00", border: "#00aa00", bg: "#000000" },
  "phosphor-amber": { label: "Amber Phosphor (P3)", fg: "#ffb000", accent: "#ffb000", dim: "#8a6000", ok: "#ffd000", warn: "#ff7b00", err: "#ff5555", purple: "#ff9500", border: "#a07000", bg: "#100800" },
  "neon-noir": { label: "Neon Noir", fg: "#e8f0ff", accent: "#00e5ff", dim: "#5a7a9a", ok: "#00ff9d", warn: "#ffb300", err: "#ff2e63", purple: "#ff2ec4", border: "#2a3f5a", bg: "#0a0e1a" },
  "lava": { label: "Lava", fg: "#ffe8d6", accent: "#ff6a00", dim: "#8a4a2a", ok: "#ffd23f", warn: "#ff2e2e", err: "#ff1a1a", purple: "#ff4fa3", border: "#5a2c18", bg: "#1c0e08" },
  "candy": { label: "Candy Pop", fg: "#fff0fa", accent: "#ff4fa3", dim: "#9a6a8a", ok: "#3dffb0", warn: "#ffe14d", err: "#ff5f7a", purple: "#7a5cff", border: "#5a2a48", bg: "#1a0d16" },
} as const satisfies Record<string, Theme>;

export type ThemeName = keyof typeof THEMES;
const THEME_ORDER = Object.keys(THEMES) as ThemeName[];

// ── Tema corrente (per-componenti statici, passata per prop) ──────────────
let T: Theme = THEMES["tokyo-night"];
const t = () => T;

/** Miscela due colori hex (0…1 = quanto del primo). */
const mix = (a: string, b: string, k: number): string => {
  const h = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const [r1, g1, b1] = h(a), [r2, g2, b2] = h(b);
  const c = (x: number, y: number) => Math.round(x * k + y * (1 - k)).toString(16).padStart(2, "0");
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
};

/** Tint di sfondo per tipologia di blocco: il colore semantico del tipo
 *  miscelato al bg del tema (leggero, mai pieno). Il colore vive solo nello
 *  sfondo: i caratteri restano puliti nel copia-incolla. */
const tint = (type: "user" | "moh" | "code" | "diff" | "tool" | "error" | "chrome"): string => {
  const th = t();
  const k = 0.14; // intensità del tint
  switch (type) {
    case "user": return mix(th.warn, th.bg, k);
    case "moh": return mix(th.accent, th.bg, k);
    case "code": case "diff": return mix(th.purple, th.bg, k);
    case "tool": return mix(th.dim, th.bg, k);
    case "error": return mix(th.warn, th.bg, k + 0.06); // un filo più presente
    case "chrome": return mix(th.dim, th.bg, k / 2); // quasi impercettibile
  }
};

// ── Struttura a blocchi ───────────────────────────────────────────────────
// Ogni tipologia di output è un blocco: riga etichetta (glifo + tipo +
// dettaglio) + corpo indentato di 2. La riga vuota tra i blocchi dà il ritmo.

// Larghezza del terminale: impostata da Session (useStdout) prima del build.
let WIDTH = 80;

// ── Responsive breakpoints ─────────────────────────────────────────────────
// compact  < 70  : tutto si comprime: status essenziale, chip compatti, bar 8
// regular 70–109 : layout standard
// wide     ≥ 110 : status completa, tutti i chip grafici, bar 16
export type WidthClass = "compact" | "regular" | "wide";
function widthClass(): WidthClass {
  if (WIDTH < 70) return "compact";
  return WIDTH < 110 ? "regular" : "wide";
}

/** Viewport live: ritriggera il render a ogni resize del terminale. */
function useViewport(): void {
  const { stdout } = useStdout();
  const [, bump] = useState(0);
  useEffect(() => {
    const onResize = () => bump((x) => x + 1);
    stdout?.on("resize", onResize);
    return () => {
      stdout?.off("resize", onResize);
    };
  }, [stdout]);
  WIDTH = stdout?.columns ?? 80;
}

/** Riga di blocco con tint a tutta larghezza: Box a larghezza terminale —
 *  il bg copre il padding sinistro (parte dal glifo) e riempie fino al bordo
 *  destro (Ink taglia gli spazi finali dei Text, il Box invece li tinteggia).
 *  Il colore vive solo nello sfondo: i caratteri restano puliti nel copia-incolla. */
const Row = ({ bg, indent = 1, segs }: { bg?: string; indent?: number; segs: ReadonlyArray<readonly [string, string]> }) => (
  // width = terminale - 1: a larghezza esatta Ink entra nel wrap char-per-char.
  <Box width={WIDTH - 1} backgroundColor={bg} paddingLeft={indent} flexShrink={0}>
    {segs.map(([txt, c], i) => (
      <Text key={i} color={c}>{txt === "" ? " " : txt}</Text>
    ))}
  </Box>
);

/** Riga etichetta: glifo colorato + tipo + dettaglio dim — con tint a tutta larghezza. */
const Head = ({ glyph, type, detail, detailSegs, color, bg }: { glyph: string; type: string; detail?: string; detailSegs?: ReadonlyArray<readonly [string, string]>; color?: string; bg?: string }) => (
  <Row
    bg={bg}
    segs={[
      [glyph, color ?? t().accent],
      [` ${type}`, color ?? t().accent],
      ...(detailSegs ?? (detail ? [[` ${detail}`, t().dim]] : [])),
    ]}
  />
);

const Gap = () => <Text> </Text>;

// ── Thinking level (mock: la modalità non esiste ancora) ───────────────────
// Le linee di delimitazione dell'input comunicano il livello di thinking
// scelto per il modello: colore + intensità. "off" resta neutro (border).
export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";

/** Palette arcobaleno per xhigh: la linea cicla le Hue — effetto "massima
 *  energia". Indipendente dal tema: il rainbow È il messaggio. */
const RAINBOW = ["#ff0055", "#ff9500", "#ffd500", "#5dff5d", "#00c8ff", "#7a5cff", "#d94fff"];

/** Riga separator per livello: off/low = linea singola ─, medium/high = doppia
 *  ═ grassa, xhigh = arcobaleno animato (i colori scorrono). */
function Separator({ level }: { level: ThinkingLevel }) {
  const w = Math.max(1, WIDTH - 1); // guard: al primissimo render WIDTH può essere 0
  // Hooks SEMPRE in cima: il ramo xhigh non può chiamare useState/useEffect
  // dopo un return condizionale (Rules of Hooks — l'errore "Expected static
  // flag was missing" di React nasceva da qui).
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (level !== "xhigh") return;
    const id = setInterval(() => setPhase((x) => x + 1), 120);
    return () => clearInterval(id);
  }, [level]);
  if (level === "xhigh") {
    const cols = Array.from({ length: w }, (_, i) => RAINBOW[(i + phase) % RAINBOW.length]!);
    return (
      <Text bold>
        {cols.map((c, i) => (
          <Text key={i} color={c}>═</Text>
        ))}
      </Text>
    );
  }
  const single = level === "off" || level === "low";
  // off usa il dim (il border è quasi invisibile su molti temi): resta neutro
  // ma leggibile; low sale di un gradino col fg attenuato via dim → in off il
  // confine c'è ma non reclama attenzione.
  const color = level === "off" || level === "low" ? t().dim : level === "medium" ? t().accent : t().purple;
  return <Text color={color} bold={!single}>{(single ? "─" : "═").repeat(w)}</Text>;
}

const THINKING_ORDER: ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];

/** Emoji per livello di thinking — a destra del nome del modello, separata
 *  da uno spazio. Scala di "profondità del pensiero". */
function thinkingEmoji(level: ThinkingLevel): string {
  switch (level) {
    case "off": return "·"; // niente thinking: punto muto, non un emoji
    case "low": return "🌱";
    case "medium": return "⚙️";
    case "high": return "🧠✨";
    case "xhigh": return "🧠🔥";
  }
}

/** Suddivide una riga di output nei glifi di stato finali (✓ ✗ ◌) colorandoli
 *  per stato; il resto della riga resta dim. */
function splitGlyphs(line: string): ReadonlyArray<readonly [string, string]> {
  const m = line.match(/^([\s\S]*?)\s*([✓✗◌⊙]+)\s*$/);
  if (!m || m[1] === "") return [[line, t().dim]];
  const g = m[2]!;
  const color = g.includes("✓") ? t().ok : g.includes("✗") ? t().err : t().accent;
  return [[m[1]!, t().dim], [` ${g}`, color]];
}

// ── Tipologie di output ───────────────────────────────────────────────────

/** Messaggio utente: etichetta › you, corpo fg pieno. */
const UserMsg = ({ text }: { text: string }) => (
  <>
    <Head glyph="›" type="you" color={t().warn} bg={tint("user")} />
    <Row bg={tint("user")} indent={3} segs={[[text, t().fg]]} />
  </>
);

/** Prosa assistant: etichetta ◆ moh, corpo full. */
const Prose = ({ lines }: { lines: string[] }) => (
  <>
    <Head glyph="◆" type="moh" bg={tint("moh")} />
    {lines.map((l, i) => <Row key={i} bg={tint("moh")} indent={3} segs={[[l === "" ? " " : l, t().fg]]} />)}
  </>
);

/** Heading markdown dentro la prosa. */
const Heading = ({ text }: { text: string }) => (
  <>
    <Row bg={tint("moh")} indent={3} segs={[[text, t().accent]]} />
    <Row bg={tint("moh")} indent={3} segs={[["─".repeat(Math.min(text.length, 40)), t().border]]} />
  </>
);

const Bullets = ({ items }: { items: string[] }) => (
  <>
    {items.map((it, i) => (
      <Row key={i} bg={tint("moh")} indent={5} segs={[["· ", t().accent], [it, t().fg]]} />
    ))}
  </>
);

/** Codice: etichetta ⌨ code · linguaggio, corpo fg, nessuna cornice. */
const Code = ({ lang, code }: { lang: string; code: string[] }) => (
  <>
    <Head glyph="⌨" type="code" detail={lang} color={t().purple} bg={tint("code")} />
    {code.map((l, i) => <Row key={i} bg={tint("code")} indent={3} segs={[[l === "" ? " " : l, t().fg]]} />)}
  </>
);

/** Diff: etichetta ± diff · file, +/- verdi/rosse. */
const Diff = ({ file, lines }: { file: string; lines: string[] }) => (
  <>
    <Head glyph="±" type="diff" detail={file} color={t().purple} bg={tint("diff")} />
    {lines.map((l, i) => (
      <Row key={i} bg={tint("diff")} indent={3} segs={[[l, l.startsWith("+") ? t().ok : l.startsWith("-") ? t().err : t().dim]]} />
    ))}
  </>
);

/** Tool call + output: un solo blocco — etichetta con glifo di stato,
 *  corpo = output dim troncato. Stati: ◌ run · ✓ ok · ✗ fail. */
const Tool = ({ name, arg, state, out }: { name: string; arg: string; state: "run" | "ok" | "fail"; out?: string[] }) => {
  const glyph = state === "run" ? "◌" : state === "ok" ? "✓" : "✗";
  const color = state === "run" ? t().accent : state === "ok" ? t().ok : t().err;
  // Edit: +n/−n colorati per conto loro (verde/rosso), il resto dim.
  const detailSegs =
    name === "edit" && /[+−-]\d/.test(arg)
      ? arg.split(/(?=[+−])/g).filter(Boolean).map((part) =>
          [part, part.startsWith("+") ? t().ok : part.startsWith("−") || part.startsWith("-") ? t().err : t().dim] as const,
        )
      : undefined;
  return (
    <>
      <Head glyph={glyph} type={name} detail={arg} detailSegs={detailSegs} color={color} bg={tint("tool")} />
      {out && out.slice(0, 5).map((l, i) => (
        <Row key={i} bg={tint("tool")} indent={3} segs={splitGlyphs(l)} />
      ))}
    </>
  );
};

/** Anteprima file: etichetta ⌨ preview · percorso, righe numerate. */
const FilePreview = ({ path, lines }: { path: string; lines: Array<[number, string]> }) => (
  <>
    <Head glyph="⌨" type="preview" detail={path} color={t().purple} bg={tint("code")} />
    {lines.map(([n, l]) => (
      <Row key={n} bg={tint("code")} indent={3} segs={[[`${String(n).padStart(3)} │ `, t().dim], [l, t().fg]]} />
    ))}
  </>
);

/** Permesso: etichetta ✓/⊘ permission. */
const Permission = ({ tool, decision }: { tool: string; decision: "allow" | "deny" }) => (
  <Head
    glyph={decision === "allow" ? "✓" : "⊘"}
    type="permission"
    detail={`${tool} · ${decision === "allow" ? "allowed (always)" : "denied"}`}
    color={decision === "allow" ? t().ok : t().warn}
    bg={tint("tool")}
  />
);

/** Ask-user: blocco proprio — domanda purple, risposta dim. */
const AskUser = ({ q, a }: { q: string; a: string }) => (
  <>
    <Head glyph="?" type="ask" color={t().purple} bg={tint("moh")} />
    <Row bg={tint("moh")} indent={3} segs={[[q, t().purple]]} />
    <Row bg={tint("moh")} indent={3} segs={[[`↳ you: ${a}`, t().dim]]} />
  </>
);

/** Errore di turno: etichetta ✗ error, corpo warn. */
const Err = ({ text }: { text: string }) => (
  <>
    <Head glyph="✗" type="error" color={t().err} bg={tint("error")} />
    <Row bg={tint("error")} indent={3} segs={[[text, t().err]]} />
  </>
);

/** Turno annullato/steering. */
const Cancelled = ({ note }: { note: string }) => (
  <Head glyph="◌" type="cancelled" detail={note} color={t().dim} bg={tint("chrome")} />
);

/** Subagent. */
const Subagent = ({ who, note }: { who: string; note: string }) => (
  <Head glyph="◇" type={who} detail={note} color={t().purple} bg={tint("chrome")} />
);

/** Evento chrome discreto: memory, model switch, MCP. */
const Chrome = ({ text }: { text: string }) => (
  <Head glyph="◈" type={text} color={t().dim} bg={tint("chrome")} />
);

/** Chain-of-thought del modello: SENZA bg e in corsivo — visivamente "voce
 *  interiore", distinta da ogni blocco produttivo. Glifo ⋯ (ellissi):
 *  pensa, non agisce. Righe piene (full-width per il wrap) ma niente tint. */
const Cot = ({ lines }: { lines: string[] }) => (
  <>
    <Head glyph="⋯" type="thinking" color={t().dim} />
    {lines.map((l, i) => (
      <Box key={i} paddingLeft={3}>
        <Text italic color={t().dim}>{l === "" ? " " : l}</Text>
      </Box>
    ))}
  </>
);

/** Usage di fine turno. */
const Usage = ({ inTok, outTok }: { inTok: number; outTok: number }) => (
  <Row bg={tint("chrome")} segs={[[`─ ${inTok.toLocaleString()} in · ${outTok.toLocaleString()} out`, t().dim]]} />
);

// ── Conversazione fittizia completa ───────────────────────────────────────
// Ogni blocco è seguito da una riga vuota: il ritmo è la separazione.

function buildConversation(): React.ReactNode[] {
  const blocks: React.ReactNode[] = [];
  const add = (key: string, node: React.ReactNode) => {
    blocks.push(node, <Gap key={`gap-${key}`} />);
  };

  add("u1", <UserMsg key="u1" text="Ripassa il modulo session: aggiorna la documentazione e sistema i test che falliscono." />);
  add("t1", <Tool key="t1" name="read" arg="packages/core/src/session/event-log.ts" state="ok" />);
  add("fp1", <FilePreview
    key="fp1"
    path="event-log.ts · 1–7"
    lines={[
      [1, "export class EventLog {"],
      [2, "  private events: AgentEvent[] = [];"],
      [3, "  append(event: AgentEvent): void {"],
      [5, "  }"],
      [7, "}"],
    ]}
  />);
  add("t2", <Tool key="t2" name="bash" arg="bun test packages/core" state="ok" out={[
    "test/event-log.test.ts (14 tests)",
    "test/session.test.ts (22 tests)",
    "2 fail · event-log › sink fan-out ✓ · session › resume seeds ✗",
  ]} />);

  add("cot1", <Cot key="cot1" lines={[
    "L'utente chiede di ripassare il modulo session. Il fallimento dei test è",
    "sul seeding del resume: probabilmente seed() bypassa append(), quindi i",
    "sink non ricevono gli eventi in replay. Verifico leggendo event-log.ts,",
    "poi correggo e aggiorno i test. Per CONTEXT.md: è una precisazione, non",
    "una decisione architetturale — glossary.",
  ]} />);

  add("p1", <>
    <Head key="p1h" glyph="◆" type="moh" bg={tint("moh")} />
    <Row key="p1b" bg={tint("moh")} indent={3} segs={[["Due fallimenti, entrambi legati al seeding del resume. Il piano:", t().fg]]} />
    <Bullets key="p1l" items={[
      "correggere il seeding in event-log.ts",
      "aggiornare i due test al nuovo contratto",
      "riportare la semantica in CONTEXT.md",
    ]} />
  </>);

  add("perm1", <Permission key="perm1" tool="edit" decision="allow" />);
  add("t3", <Tool key="t3" name="edit" arg="event-log.ts · +3 −1" state="ok" />);
  add("d1", <Diff key="d1" file="event-log.ts" lines={[
    "-  seed(events: AgentEvent[]) { this.events = events; }",
    "+  seed(events: AgentEvent[]) {",
    "+    for (const e of events) this.append(e); // sink fan-out preserved",
    "+  }",
  ]} />);
  add("t4", <Tool key="t4" name="edit" arg="test/event-log.test.ts · +2 −2" state="ok" />);
  add("t5", <Tool key="t5" name="bash" arg="bun test packages/core" state="ok" out={[
    "test/event-log.test.ts (14 tests) ✓",
    "test/session.test.ts (24 tests) · 38 passed ✓",
  ]} />);

  add("ask1", <AskUser key="ask1" q="CONTEXT.md: sezione glossary o ADR separato?" a="glossary, è una precisazione non una decisione" />);

  add("cot2", <Cot key="cot2" lines={[
    "Ha scelto glossary — coerente. Ora: il blocco di riepilogo con heading,",
    "prosa breve e il frammento di codice finale. Il codice va senza cornice,",
    "come sempre: solo indent e tint.",
  ]} />);

  add("p2", <>
    <Head key="p2h" glyph="◆" type="moh" bg={tint("moh")} />
    <Heading key="p2hd" text="Cosa è cambiato" />
    <Row key="p2b" bg={tint("moh")} indent={3} segs={[["Il seeding ora passa da append(), quindi il fan-out scatta anche in resume.", t().fg]]} />
    <Code key="p2c" lang="ts · event-log.ts" code={[
      "// blocco multi-riga: prova a selezionarmi col mouse",
      "seed(events: AgentEvent[]): void {",
      "  for (const e of events) this.append(e);",
      "}",
    ]} />
  </>);
  add("us1", <Usage key="us1" inTok={14304} outTok={1876} />);
  add("ch1", <Chrome key="ch1" text="memory updated · session, testing" />);

  add("u2", <UserMsg key="u2" text="Ora prova l'estrazione della memoria con il subagent." />);
  add("sa1", <Subagent key="sa1" who="maintenance" note="spawn · memory extraction" />);
  add("t6", <Tool key="t6" name="bash" arg="ls ~/.moh/projects/moh/memory" state="fail" out={[
    "error: ENOENT — no such file or directory",
    "  at MemoryRunner.run (memory.ts:214)",
  ]} />);
  add("e1", <Err key="e1" text="memory extraction failed · retry scheduled next turn (fail-silent, not lossy)" />);

  add("u3", <UserMsg key="u3" text="Aspetta, prima cambia modello" />);
  add("cx1", <Cancelled key="cx1" note="steering · turn interrupted by user input" />);
  add("ch2", <Chrome key="ch2" text="model switched · claude-sonnet-4 → gpt-5.2 (next turn)" />);

  add("t7", <Tool key="t7" name="mcp__github__get_issue" arg="moh #183" state="ok" out={[
    "title: TUI restyle — scrollback layout",
    "labels: ready-for-agent",
  ]} />);
  add("p3", <Prose key="p3" lines={["Issue letta: il layout scrollback è proprio #183, posso partire da lì per l'implementazione."]} />);
  add("us2", <Usage key="us2" inTok={9430} outTok={842} />);

  return blocks;
}

// ── Bottom bar ────────────────────────────────────────────────────────────
// Tre zone in ordine di priorità visiva (dal basso verso l'alto si legge
// al contrario: prima l'input, poi lo stato, poi la tastiera):
//
//   riga 1 — keybind row: i tasti vivi RIGHT-aligned, discreti ma leggibili
//   riga 2 — status row:  modo · modello · token · sessione · throttle live
//   (il ticker attività vive nella riga 2 quando c'è un turno attivo, con
//    spinner animato e progress; a riposo mostra il riassunto di sessione)
//
// Niente cornici: la bar si riconosce dalla densità e dal dim, il contenuto
// del transcript resta l'unico protagonista colorato.

/** Spinner braille, 10 frame (~90ms). */
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function useSpin(active: boolean): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setI((x) => (x + 1) % SPIN.length), 90);
    return () => clearInterval(id);
  }, [active]);
  return active ? SPIN[i]! : "✓";
}

/** Riga di stato: live a sinistra (il presente), stato di sessione a destra
 *  (il contesto). A riposo la zona sinistra mostra ✓ done. */
/** Progress bar della context window: riempimento proporzionale, colore
 *  per soglia — ok (verde) fino al 60%, warn (ambra) fino all'80%, err
 *  (rosso) oltre. Larghezza fissa 12 celle: leggibile senza rubare riga. */
function ContextBar({ th, used, limit }: { th: Theme; used: number; limit: number }) {
  const W = widthClass() === "compact" ? 8 : widthClass() === "wide" ? 16 : 12;
  const ratio = Math.min(1, used / limit);
  const filled = Math.round(ratio * W);
  const color = ratio > 0.8 ? th.err : ratio > 0.6 ? th.warn : th.ok;
  return (
    <Text>
      <Text color={th.border}>[</Text>
      <Text color={color}>{"█".repeat(filled)}</Text>
      <Text color={th.border}>{"·".repeat(W - filled)}</Text>
      <Text color={th.border}>]</Text>
    </Text>
  );
}

/** Adatta una lista di segmenti al budget: elimina i segmenti marcati
 *  opzionali (dalla fine) finché entra; se non basta, tronca l'ultimo testo
 *  conservando il colore. priority: false = primo candidato alla caduta. */
function fitRow(
  segs: ReadonlyArray<readonly [string, string, boolean?]>, // [text, color, optional?]
  budget: number,
): Array<readonly [string, string]> {
  const w = (t: string) => t.length + 1; // +1 gap
  let total = segs.reduce((a, [t]) => a + w(t), -1);
  let keep = [...segs];
  while (total > budget && keep.some(([, , o]) => o)) {
    // drop l'ultimo opzionale
    for (let i = keep.length - 1; i >= 0; i--) {
      if (keep[i]![2]) { keep.splice(i, 1); break; }
    }
    total = keep.reduce((a, [t]) => a + w(t), -1);
  }
  // ancora fuori? tronca il segmento PIÙ LUNGO (il nome del modello, di regola)
  if (total > budget && keep.length >= 1) {
    const over = total - budget;
    let mi = 0;
    for (let i = 1; i < keep.length; i++) if (keep[i]![0].length > keep[mi]![0].length) mi = i;
    const t = keep[mi]![0]!;
    keep[mi] = [t.slice(0, Math.max(1, t.length - over)), keep[mi]![1]];
  }
  return keep.map(([t, c]) => [t, c] as const);
}

function StatusRow({ th, live }: { th: Theme; live: LiveState }) {
  // segmenti destra: [testo, colore, opzionale?] — gli opzionali cadono se non ci sta
  const right: Array<readonly [string, string, boolean?]> = [];
  if (live.tokens > 0) {
    right.push([`⊣ ${(live.tokens / 1000).toFixed(1)}k`, live.tokens > live.contextLimit * 0.8 ? th.err : live.tokens > live.contextLimit * 0.6 ? th.warn : th.dim, true]);
  }
  if (widthClass() !== "compact") right.push([`↻ ${live.turns}`, th.dim, true]);
  // NB: le emoji con VS16 (⚙️) occupano 2 celle ma Ink ne misura 1 — lo
  // spazio dopo viene visivamente assorbito dal glifo largo: serve un doppio
  // spazio perché il terminale ne renderizzi almeno uno.
  const sep = thinkingEmoji(live.level).includes("\uFE0F") ? "  " : " ";
  const wc = widthClass();
  if (wc !== "compact") {
    right.push([`◆ ${live.model} ${thinkingEmoji(live.level)}${sep}${live.level}`, live.level === "off" ? th.fg : live.level === "xhigh" || live.level === "high" ? th.purple : th.fg]);
  } else {
    right.push([`◆ ${live.model}`, th.fg]);
  }
  right.push([live.mode === "dev" ? "◉ dev" : "○ vibe", live.mode === "dev" ? th.accent : th.dim, true]); // cade solo sotto i 45 col
  const left: Array<readonly [string, string, boolean?]> = live.active
    ? ([[live.spin, th.accent], ...(widthClass() !== "compact" ? ([[live.phase, th.accent, true]] as Array<readonly [string, string, boolean?]>) : []), ...(live.progress != null ? ([[`${live.progress}%`, th.dim, true]] as Array<readonly [string, string, boolean?]>) : [])] as Array<readonly [string, string, boolean?]>)
    : [[live.turns > 0 ? "✓ done" : "· ready", th.dim]];
  // budget condiviso: sinistra ~1/3, destra il resto — mai oltre WIDTH-2
  const budget = WIDTH - 4; // paddingL/R(2) + gap(2) di sicurezza
  const leftFits = fitRow(left, Math.floor(budget / 3));
  const barW = widthClass() === "compact" ? 10 : 14;
  const rightFits = live.tokens > 0 ? fitRow(right, budget - leftFits.reduce((a, [t]) => a + t.length + 1, -1) - barW) : fitRow(right, budget - leftFits.reduce((a, [t]) => a + t.length + 1, -1));
  return (
    <Box flexDirection="row" flexShrink={0}>
      <Box paddingLeft={1} gap={1} flexGrow={1}>
        {leftFits.map(([txt, c], i) => (
          <Text key={i} color={c}>{txt}</Text>
        ))}
        {live.memoryFresh && !live.active && <Text color={th.purple}>{widthClass() === "wide" ? "◍ memory" : "◍"}</Text>}
      </Box>
      <Box paddingRight={1} gap={1} alignItems="center" flexWrap="nowrap">
        {live.tokens > 0 && <ContextBar th={th} used={live.tokens} limit={live.contextLimit} />}
        {rightFits.map(([txt, c], i) => (
          <Text key={i} color={c}>{txt}</Text>
        ))}
        {live.memoryFresh && live.active && <Text color={th.purple}>◍</Text>}
      </Box>
    </Box>
  );
}

/** Chip keybind: tasto e label DENTRO la stessa cornice round — la versione
 *  grafica dei chip della vecchia chip footer. `focused`: chip selezionato
 *  dalla navigazione tab — bordo accent e label accesa. */
function KeyChip({ th, k, label, color, focused }: { th: Theme; k: string; label: string; color?: string; focused?: boolean }) {
  const c = focused ? th.accent : color ?? th.dim;
  return (
    <Box
      borderStyle="round"
      borderColor={focused ? th.accent : th.border}
      paddingX={1}
      alignSelf="flex-start"
      flexShrink={0}
    >
      <Text color={focused ? th.accent : th.fg} bold>{k} </Text>
      <Text color={c}>{label}</Text>
    </Box>
  );
}

/** Larghezza di un chip keybind incorniciato: bordo(2) + padding(2) + key + spazio + label. */
const chipWidth = (k: string, label: string): number => 4 + k.length + 1 + label.length;

/** Azione di ogni chip (demo): cosa succede a ⏎ quando il chip è attivo. */
function chipAction(label: string, ctx: { cycleTheme: () => void; exit: () => void }): string {
  switch (label) {
    case "theme": ctx.cycleTheme(); return "→ theme cycled";
    case "frontier": return "→ frontier panel (demo)";
    default: return `→ ${label} (demo)`;
  }
}

/** Riga keybind: chip incorniciati centrati, navigabili con tab/shift-tab
 *  (focusChip = indice del chip attivo; ⏎ lo attiva). Sui terminali stretti
 *  degrada ai chip compatti (la navigazione resta: il chip compatto attivo
 *  viene evidenziato in accent). */
function KeyRow({ th, focusChip }: { th: Theme; focusChip: number | null }) {
  const chips: ReadonlyArray<readonly [string, string, string | undefined]> = [
    ["⏎", "send", undefined],
    ["esc", "stop", undefined],
    ["^o", "mode", th.dim],
    ["^t", "theme", th.dim],
    ["^k", "commands", th.dim],
    ["^s", "settings", th.dim],
    ["^f", "frontier", th.purple],
  ];
  const budget = WIDTH - 4;
  // compatto: i chip meno importanti saltano subito, restano i primi 4
  const list = widthClass() === "compact" ? chips.slice(0, 4) : chips;
  const full = list.reduce((a, [k, l]) => a + chipWidth(k, l) + 2, -2);
  if (full <= budget) {
    return (
      <Box flexDirection="row" justifyContent="center" gap={2} flexShrink={0} marginTop={1} flexWrap="nowrap">
        {list.map(([k, label, color], i) => (
          <KeyChip key={k} th={th} k={k} label={label} color={color} focused={focusChip === i} />
        ))}
      </Box>
    );
  }
  // compatto: ( key label ) stile chip footer, senza cornice
  const compact = (chips: typeof chips) => chips.map(([k, l]) => 5 + k.length + l.length).reduce((a, w) => a + 1 + w, -1);
  const keep = [...list];
  while (keep.length > 1 && compact(keep) > budget) keep.pop();
  return (
    <Box flexDirection="row" justifyContent="center" gap={1} flexShrink={0} marginTop={1} flexWrap="nowrap">
      {keep.map(([k, label, color], i) => {
        const f = focusChip === i;
        return (
          <Text key={k} backgroundColor={f ? th.accent : undefined}>
            <Text color={f ? th.bg : th.dim}>( </Text>
            <Text color={f ? th.bg : th.accent}>{k} </Text>
            <Text color={f ? th.bg : color ?? th.fg}>{label}</Text>
            <Text color={f ? th.bg : th.dim}> )</Text>
          </Text>
        );
      })}
    </Box>
  );
}

interface LiveState {
  level: ThinkingLevel;
  mode: "dev" | "vibe";
  model: string;
  tokens: number;
  contextLimit: number;
  turns: number;
  active: boolean;
  phase: string;
  progress: number | null;
  memoryFresh: boolean;
  spin: string;
}

function BottomBar({ live, focusChip }: { live: LiveState; focusChip: number | null }) {
  const th = t();
  return (
    <Box flexDirection="column" flexShrink={0}>
      <StatusRow th={th} live={live} />
      <KeyRow th={th} focusChip={focusChip} />
    </Box>
  );
}

// ── Sessione (remonta al cambio tema) ─────────────────────────────────────

const PHASES = ["thinking", "calling anthropic", "streaming", "running bash", "streaming"];

const CHIP_LABELS = ["send", "stop", "mode", "theme", "commands", "settings", "frontier"];

function Session({ showBar, paused, focusChip, draft, level }: {
  showBar: boolean;
  paused: boolean;
  focusChip: number | null;
  draft: string;
  level: ThinkingLevel;
}) {
  useViewport(); // live: ogni resize ritriggera il render (e il rebuild delle righe Static)
  const staticItems = useMemo(() => [{ id: "conversation", nodes: buildConversation() }], []);
  // demo live: alterna idle/turno attivo per vedere la bar nei due stati
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setTick((x) => x + 1), 1200);
    return () => clearInterval(id);
  }, [paused]);
  const active = !paused && Math.floor(tick / 3) % 2 === 1;
  const spin = useSpin(active);
  const inputFocused = focusChip === null;
  const live: LiveState = {
    level,
    mode: "dev",
    model: "claude-sonnet-4",
    tokens: 14304,
    contextLimit: 200000,
    turns: 3,
    active,
    phase: active ? PHASES[Math.min(tick % PHASES.length, PHASES.length - 1)]! : "",
    progress: active ? Math.min(96, 20 + (tick % 5) * 19) : null,
    memoryFresh: !active,
    spin,
  };
  return (
    <Box flexDirection="column">
      <Static items={staticItems}>
        {({ nodes }) => <Box key="conversation" flexDirection="column">{nodes}</Box>}
      </Static>
      {/* Input delimitato SOLO da linee orizzontali sopra e sotto: nessun │
          laterale finisce nel copia-incolla di testo multi-riga, ma l'area è
          chiara tra transcript (sopra) e bottom bar (sotto). */}
      <Separator level={level} />
      <Box paddingLeft={1} flexShrink={0}>
        <Text color={inputFocused ? t().warn : t().dim}>{"› "}</Text>
        <Text color={inputFocused ? t().fg : t().dim}>{draft}</Text>
        {inputFocused && <Text color={t().accent}>▏</Text>}
      </Box>
      <Separator level={level} />
      {showBar && (
        <Box flexDirection="column" flexShrink={0}>
          <Text> </Text>
          <BottomBar live={live} focusChip={focusChip} />
        </Box>
      )}
    </Box>
  );
}

// ── Modals (demo): lo stile Dialog dell'App reale, adattato ai token ──────
// Sovrastruttura BLOCCANTE sopra l'area live: il transcript resta nello
// scrollback sotto, intatto. Cornice round = chrome di interazione (qui è
// corretta: non c'è contenuto da copiare).

/** Cornice dialog: round border colorata, bg del tema, centrata, clampata. */
function Dialog({ title, color, children, w }: { title: string; color: string; children: React.ReactNode; w?: number }) {
  const width = Math.min(w ?? Math.round(WIDTH * 0.62), WIDTH - 2, 80);
  return (
    <Box flexDirection="column" alignItems="center" flexShrink={0}>
      <Box borderStyle="round" borderColor={color} backgroundColor={t().bg} width={width} paddingX={2} flexDirection="column">
        <Text color={color} bold>{title}</Text>
        <Text> </Text>
        {children}
      </Box>
    </Box>
  );
}

const MODALS = ["permission", "ask", "model", "settings", "commands", "onboarding", "frontier"] as const;
type ModalName = (typeof MODALS)[number];

function ModalDemo({ which, onClose }: { which: ModalName; onClose: () => void }) {
  const th = t();
  useInput((input, key) => {
    if (key.escape || key.return) onClose();
  });
  switch (which) {
    case "permission":
      return (
        <Dialog title=" permission " color={th.warn}>
          <Text color={th.fg}>A tool call needs your approval:</Text>
          <Text> </Text>
          <Text color={th.fg}>{"  bash · bun install --save-dev ink"}</Text>
          <Text color={th.dim}>{"  cwd: packages/tui"}</Text>
          <Text> </Text>
          <Text color={th.dim}>{"  “always” writes the session rule: bash:bun install*"}</Text>
          <Text> </Text>
          <Text><Text color={th.accent} bold>y</Text>{" yes  "}<Text color={th.accent}>a</Text>{" always  "}<Text color={th.accent}>e</Text>{" edit  "}<Text color={th.accent}>n</Text>{" deny"}</Text>
        </Dialog>
      );
    case "ask":
      return (
        <Dialog title=" ask " color={th.purple}>
          <Text color={th.fg}>CONTEXT.md: sezione glossary o ADR separato?</Text>
          <Text> </Text>
          <Text color={th.accent}>{">"} glossary (suggested)</Text>
          <Text color={th.fg}>  adr</Text>
          <Text color={th.fg}>  both</Text>
          <Text> </Text>
          <Text color={th.dim}>↑↓ move · 1–3 pick · tab free text · esc suggested</Text>
        </Dialog>
      );
    case "model":
      return (
        <Dialog title=" /model " color={th.accent}>
          <Text color={th.dim}>filter: claude…</Text>
          <Text> </Text>
          <Text color={th.fg}>◆ anthropic (subscription)</Text>
          <Text color={th.accent}>  ● claude-sonnet-4</Text>
          <Text color={th.fg}>  ○ claude-opus-4.5</Text>
          <Text color={th.fg}>◆ openai (subscription)</Text>
          <Text color={th.fg}>  ○ gpt-5.2</Text>
          <Text> </Text>
          <Text color={th.dim}>⏎ switch (next turn) · f free text · esc close</Text>
        </Dialog>
      );
    case "settings":
      return (
        <Dialog title=" settings " color={th.accent}>
          <Text color={th.fg}>theme      <Text color={th.accent}>{th.label}</Text></Text>
          <Text color={th.fg}>mode       dev</Text>
          <Text color={th.fg}>permission ask</Text>
          <Text color={th.fg}>editor     $EDITOR</Text>
          <Text color={th.fg}>provider   <Text color={th.accent}>w: wizard · s: switch</Text></Text>
          <Text> </Text>
          <Text color={th.dim}>↑↓ move · ⏎ change · esc close</Text>
        </Dialog>
      );
    case "commands":
      return (
        <Dialog title=" commands " color={th.accent}>
          {["/model — switch model (next turn)", "/theme — cycle theme", "/workflow on|off", "/skills update", "/memory — show memory index", "/help — all commands"].map((c, i) => (
            <Text key={i} color={th.fg}>{c}</Text>
          ))}
          <Text> </Text>
          <Text color={th.dim}>type / · ↑↓ · ⏎ run · esc close</Text>
        </Dialog>
      );
    case "onboarding":
      return (
        <Dialog title=" welcome to moh " color={th.accent}>
          <Text color={th.fg}>Pick a provider to start:</Text>
          <Text> </Text>
          <Text color={th.accent}>1. Claude (subscription · pro/max)</Text>
          <Text color={th.fg}>2. ChatGPT (subscription · plus/pro)</Text>
          <Text color={th.fg}>3. GitHub Copilot</Text>
          <Text color={th.fg}>4. Custom (openai-compat)</Text>
          <Text> </Text>
          <Text color={th.dim}>1–4 pick · esc later</Text>
        </Dialog>
      );
    case "frontier":
      return (
        <Dialog title=" wayfinder · frontier " color={th.purple}>
          <Text color={th.fg}>Next unblocked ticket:</Text>
          <Text> </Text>
          <Text color={th.accent}>#184 task — vendored catalog for kimi</Text>
          <Text color={th.dim}>  labels: ready-for-agent · no blockers</Text>
          <Text> </Text>
          <Text color={th.fg}>Queue: 3 research · 2 tasks · 1 blocked</Text>
          <Text> </Text>
          <Text color={th.dim}>⏎ claim · r refresh · esc close</Text>
        </Dialog>
      );
  }
}

function App() {
  const { exit } = useApp();
  const [themeIdx, setThemeIdx] = useState(0);
  const [showBar, setShowBar] = useState(true);
  const [paused, setPaused] = useState(false);
  // Focus model: null = textarea; 0..6 = chip (tab avanti, shift+tab indietro, ⏎ attiva).
  const [focusChip, setFocusChip] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [level, setLevel] = useState<ThinkingLevel>("medium");
  T = THEMES[THEME_ORDER[themeIdx]!];
  const cycleTheme = () => setThemeIdx((i) => (i + 1) % THEME_ORDER.length);
  const [modal, setModal] = useState<ModalName | null>(null);
  useInput((input, key) => {
    // i modal catturano TUTTO (bloccanti): esc/⏎ chiudono (in ModalDemo)
    if (modal !== null) return;
    if (input >= "1" && input <= "7") {
      const mi = Number(input) - 1;
      if (mi < MODALS.length) return setModal(MODALS[mi]!);
    }
    if (key.tab) {
      // navigazione: null → 0 → … → ultimo → null; shift+tab inverte
      const n = CHIP_LABELS.length;
      const fwd = (f: number | null) => (f === null ? 0 : f + 1 === n ? null : f + 1);
      const back = (f: number | null) => (f === null ? n - 1 : f === 0 ? null : f - 1);
      return setFocusChip(key.shift ? back : fwd);
    }
    if (key.escape && focusChip !== null) return setFocusChip(null);
    if (focusChip !== null) {
      if (key.return) {
        const label = CHIP_LABELS[focusChip]!;
        if (label === "theme") cycleTheme();
        setNote(`chip: ${label}`);
      }
      // ←/→ spostano il focus tra i chip senza tab
      if (key.leftArrow) return setFocusChip((f) => (f! + CHIP_LABELS.length - 1) % CHIP_LABELS.length);
      if (key.rightArrow) return setFocusChip((f) => (f! + 1) % CHIP_LABELS.length);
      return; // i chip mangiano tutto il resto
    }
    if (key.return) { setDraft(""); setNote("sent"); return; }
    if (key.backspace || key.delete) return setDraft((d) => d.slice(0, -1));
    if (input === "q") return exit();
    if (input === "y") return cycleTheme();
    if (input === "b") return setShowBar((b) => !b);
    if (input === "p") return setPaused((p) => !p);
    if (input === "x") {
      const next = THINKING_ORDER[(THINKING_ORDER.indexOf(level) + 1) % THINKING_ORDER.length]!;
      setLevel(next);
      setNote(`thinking: ${next}`);
      return;
    }
    if (input && !key.escape) setDraft((d) => (d + input).slice(0, 70));
  });
  const th = t();
  return (
    <Box flexDirection="column">
      {modal !== null && <ModalDemo which={modal} onClose={() => setModal(null)} />}
      {/* key: il remount ristampa il transcript nella palette nuova */}
      <Session
        key={themeIdx}
        showBar={showBar}
        paused={paused}
        focusChip={focusChip}
        draft={draft}
        level={level}
      />
      <Text color={th.warn}> </Text>
      <Box alignSelf="center" borderStyle="round" borderColor={th.warn} paddingX={1} flexShrink={0}>
        <Text color={th.warn}>{`‹ PROTOTYPE › ${note ? `${note} · ` : ""}[1-7] modals · [tab] chips · [x] thinking · [y] ${th.label} · [b] bar · [p] live · [q] quit`}</Text>
      </Box>
    </Box>
  );
}

render(<App />);
