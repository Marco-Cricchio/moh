// PROTOTYPE (v4) — throwaway TUI mockup for moh (wayfinder ticket #14).
// Run: bun prototype/tui-mockup.tsx
// Keys: [tab] screens · [v] vibe/dev · [p] permission · [f] preview · [w] wayfinder
//       [s] settings · [d] tool detail (dev) · [q] quit
// v4: real markdown rendering (marked-terminal, streaming-safe), Tokyo Night
// palette tokens, OSC 8 links, rhythm scale 1-2-4, Nerd Font glyphs w/ fallback.
import React, { useState, useEffect } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";

const md = new Marked(
  markedTerminal({
    code: (code: string) => `\x1b[38;2;${hexToRgb(theme.accent)}m${code}\x1b[0m`,
  }) as any,
);
const hexToRgb = (hex: string) =>
  [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(";");

// ---- palette: Tokyo Night, semantic tokens (rule: no raw hex in components)
// ---- themes: semantic tokens (rule: no raw hex in components) ----
const THEMES = {
  "tokyo-night": { label: "Tokyo Night", accent: "#7aa2f7", dim: "#565f89", ok: "#9ece6a", warn: "#e0af68", purple: "#bb9af7", border: "#292e42", bg: "#16161e" },
  "catppuccin": { label: "Catppuccin Mocha", accent: "#89b4fa", dim: "#6c7086", ok: "#a6e3a1", warn: "#f9e2af", purple: "#cba6f7", border: "#45475a", bg: "#1e1e2e" },
  "gruvbox": { label: "Gruvbox Dark", accent: "#83a598", dim: "#7c6f64", ok: "#b8bb26", warn: "#fabd2f", purple: "#d3869b", border: "#504945", bg: "#282828" },
  "nord": { label: "Nord", accent: "#88c0d0", dim: "#4c566a", ok: "#a3be8c", warn: "#ebcb8b", purple: "#b48ead", border: "#434c5e", bg: "#2e3440" },
  "dracula": { label: "Dracula", accent: "#bd93f9", dim: "#6272a4", ok: "#50fa7b", warn: "#f1fa8c", purple: "#ff79c6", border: "#44475a", bg: "#282a36" },
  "solarized": { label: "Solarized Dark", accent: "#268bd2", dim: "#586e75", ok: "#859900", warn: "#b58900", purple: "#6c71c4", border: "#073642", bg: "#002b36" },
  // retro themes — researched hex in research/retro-theme-palettes.md
  "c64": { label: "Commodore 64", accent: "#7869c4", dim: "#5f5299", ok: "#94e089", warn: "#b8b445", purple: "#6c4fc9", border: "#7869c4", bg: "#40318d", mono: false, retro: "pepto VIC-II PAL palette: border/text light blue #7869C4 on blue #40318D" },
  "amiga": { label: "Amiga OS", accent: "#aaaaaa", dim: "#8a8fa8", ok: "#ffffff", warn: "#ff9900", purple: "#ff9900", border: "#ffffff", bg: "#0055aa", mono: false, retro: "Workbench 1.3 four-color: blue #0055AA, white, black, orange #FF9900" },
  "phosphor": { label: "Green Phosphor", accent: "#00ff00", dim: "#008800", ok: "#00cc00", warn: "#00ff41", purple: "#00dd00", border: "#00aa00", bg: "#000000", mono: true, retro: "P1 phosphor: pure green #00FF00 on black, all roles green shades" },
} as const;
type ThemeName = keyof typeof THEMES;
let theme = THEMES["tokyo-night"] as any;
let currentTheme: ThemeName = "tokyo-night";
const ThemeCtx = React.createContext(THEMES["tokyo-night"]);
const useTheme = () => React.useContext(ThemeCtx);
type Mode = "vibe" | "dev";
const A = ({ children }: any) => { const t = useTheme(); return <Text color={t.accent}>{children}</Text>; };
const D = ({ children }: any) => { const t = useTheme(); return <Text color={t.dim}>{children}</Text>; };
// Nerd Font glyph with ASCII fallback (detected in real build; toggled here with [i])
let ICONS = true;
const ic = (g: string, ascii: string) => (ICONS ? g : ascii);
const link = (label: string, _url: string) => `\u001b[4m${label}\u001b[0m`; // OSC 8 breaks Ink's width calc → plain underline in prototype

// streaming-safe markdown: unterminated fence → plain indented text
const MD = ({ text }: { text: string }) => {
  const fences = (text.match(/```/g) || []).length;
  const safe = fences % 2 === 1 ? text + "\n```" : text;
  const out = (md.parse(safe) as string).replace(/\n+$/, "");
  return <Text>{out}</Text>;
};

// pi-style labelled message box: single border, speaker label on top row
const MsgBox = ({ label, color, children }: any) => (
  <Box borderStyle="round" borderColor={color} flexDirection="column" width="100%" paddingX={1}>
    <Text color={color}>{label}</Text>
    {children}
  </Box>
);

const frame = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ---------- HOME (filter-first) ----------
const Home = ({ mode }: { mode: Mode }) => {
  const [q, setQ] = useState("");
  const sessions = [
    ["fix the login", "2h ago"],
    ["project spec", "yesterday"],
    ["stream flicker bug", "3d ago"],
  ];
  const hits = sessions.filter(([n]) => n.toLowerCase().includes(q.toLowerCase()));
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} paddingY={2}>
      <Text bold color={theme.accent}>{ic("", "*")} <Text bold underline>moh{ic("", ">")}</Text></Text>
      <Text>{"\n\n"}</Text>
      <Box borderStyle="round" borderColor={theme.border} width={46} paddingX={1}>
        <Text>{q ? q : "search or start something new…"}<D>▊</D></Text>
      </Box>
      <Text>{"\n\n"}</Text>
      <Box flexDirection="column" width={46} gap={0}>
        {hits.map(([n, t]) => (
          <Box key={n} justifyContent="space-between">
            <Text>{ic("", "-")} {n}</Text>
            <D>{t}</D>
            <Text>{" "}</Text>
          </Box>
        ))}
        {q && hits.length === 0 && <Text>  <A>{ic("", ">")} start “{q}”</A></Text>}
        <Text>{"\n"}</Text>
        <D>{q ? "enter resume · esc clear" : "type to filter · n new session"}</D>
      </Box>
    </Box>
  );
};

// ---------- CHAT ----------
const ToolLine = ({ mode, open }: any) =>
  mode === "dev" ? (
    <Box flexDirection="column">
      <Text><D>{` ${ic("📖", "read")}`}</D><D> agent-session.ts · L1-80 {open ? "" : "· d detail "}</D>{ic("✓", "ok")}<D> 1.2s</D></Text>
      {open && (
        <Box flexDirection="column" paddingLeft={4}>
          <Text color={theme.accent}>{" 42│ export class AgentSession {"}</Text>
          <Text color={theme.accent}>{" 43│   private events: AsyncIterable<SessionEvent>;"}</Text>
          <Text color={theme.dim}>{" …  36 more lines"}</Text>
        </Box>
      )}
    </Box>
  ) : (
    <Text><D> {ic("📖", "read")} read the session file {ic("✓", "ok")}</D></Text>
  );

const Subagents = ({ mode, open }: { mode: Mode; open: boolean }) =>
  mode === "dev" ? (
    <Box flexDirection="column">
      <Text><D>{" "}{ic(" ZEND", "spawn")} 2 subagents · depth 1 · parallel</D></Text>
      <Box flexDirection="column" paddingLeft={4}>
        <Text><D>{""}</D>{ic("", "-")}<A> research-tui</A><D> · reading marked-terminal docs… 4.1k tok</D></Text>
        <Text><D>{""}</D>{ic("", "-")}<A> probe-ink</A><D> · Static + focus manager · done ✓ 1.8k tok</D></Text>
        {open && (
          <Box flexDirection="column" paddingLeft={2}>
            <D>{" ┈ result probe-ink: \"Ink <Static> keeps scrollback outside"}</D>
            <D>{"   the render loop; safe for 10k+ lines.\" (2 lines, 0.4s)"}</D>
            <D> ┈ logs: ~/.moh/projects/moh/subagents/</D>
          </Box>
        )}
      </Box>
      <Text><D>{" "}{ic("", "=")} research-tui still running · ask routed to you</D></Text>
    </Box>
  ) : (
    <Box flexDirection="column">
      <Text><D>{" "}{ic("", "^")} I asked two helpers to check something for me</D></Text>
      <Text><D>{" "}{" "}— one is back, one is still looking…</D></Text>
    </Box>
  );

const Chat = ({ mode, overlay }: { mode: Mode; overlay: string | null }) => {
  const [tick, setTick] = useState(0);
  const [toolOpen, setToolOpen] = useState(false);
  const [toast, setToast] = useState("memory updated");
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 90);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (toast) { const t = setTimeout(() => setToast(""), 3000); return () => clearTimeout(t); }
  }, [toast]);
  const f = frame[tick % frame.length];
  useInput((input: string, key: any) => {
    if (input === "d") setToolOpen(o => !o);
  });
  const answer =
    mode === "vibe"
      ? `I keep a **diary** of it on your computer.\n\nClose any time — we pick up right where we left off.\n\n- saved automatically\n- private to you`
      : `Append-only **JSONL** in \`~/.moh/projects/moh/\`.\n\nresume = *append*, fork = copy prefix. See ${link("the session doc", "https://github.com/Marco-Cricchio/moh")}.`;
  return (
    <Box flexDirection="column" height="100%">
      <Box justifyContent="space-between" paddingX={2}>
        <Text bold color={theme.accent}>{ic("", "*")} moh</Text>
        {mode === "dev" && <D>claude-sonnet-4-5 · 12k/200k tok · normal</D>}
      </Box>
      <Text>{" "}</Text>
      <Text>{" "}</Text>

      {/* conversation: each turn in its own labelled box (pi-style) */}
      <Box flexDirection="column" flexGrow={1} width="100%" gap={0}>
        <MsgBox label={" you "} color={theme.accent}>
          <Text>  where do you keep our conversation?</Text>
        </MsgBox>
        <MsgBox label={" moh "} color={theme.purple}>
          <MD text={answer} />
          <Text>{" "}</Text>
          <Text><D>  {f} {mode === "vibe" ? "thinking…" : "streaming · 84 tok/s"} · esc to steer</D></Text>
        </MsgBox>
        <MsgBox label={mode === "vibe" ? " what I did " : " tool · read "} color={theme.border}>
          <ToolLine mode={mode} open={toolOpen} />
        </MsgBox>
        <MsgBox label={mode === "vibe" ? " helpers " : " subagents "} color={theme.border}>
          <Subagents mode={mode} open={toolOpen} />
        </MsgBox>
      </Box>
      <Text>{" "}</Text>
      <Text>{" "}</Text>

      <Box borderStyle="round" borderColor={theme.border} width="100%" paddingX={1}>
        <Text color={theme.accent} bold>› </Text><D>type… (ctrl+e long text)</D>
      </Box>
      <Text>{" "}</Text>
      {toast ? <Box justifyContent="center"><D>· {toast} ·</D></Box> : null}
      <Box justifyContent="center">
        <D> {mode === "vibe"
          ? `${ic("", "p")} permission · ${ic("", "w")} roadmap · ${ic("", "s")} settings · ${ic("", "v")} dev mode`
          : "p permission · f preview · d tool+subagent detail · w wayfinder · s settings · v vibe mode"} </D>
      </Box>

      {overlay === "p" && <Perm mode={mode} />}
      {overlay === "f" && <Preview mode={mode} />}
      {overlay === "w" && <Wayfinder mode={mode} />}
      {overlay === "s" && <Settings mode={mode} />}
    </Box>
  );
};

// ---------- overlays ----------
const Dialog = ({ children, color = theme.warn, w = 56 }: any) => (
  <Box flexDirection="column" alignItems="center" justifyContent="center" position="absolute" width="100%" height="100%">
    <Box borderStyle="round" borderColor={color} width={`100%`} flexDirection="column" padding={2} backgroundColor={theme.bg}>{children}</Box>
  </Box>
);

const Perm = ({ mode }: { mode: Mode }) =>
  mode === "vibe" ? (
    <Dialog w={50}>
      <Text>{ic("️", "!")} Quick check</Text>
      <Text>{" "}</Text>
      <Text>  I'd like to run the project's tests</Text>
      <Text>  to make sure nothing broke.</Text>
      <Text>{" "}</Text>
      <Text>  <A bold>yes</A> <D>· always for this project · no</D></Text>
    </Dialog>
  ) : (
    <Dialog>
      <Text>{ic("️", "!")} Permission — bash</Text>
      <Text>{" "}</Text>
      <Text>  <A bold>npm test -- --filter auth</A></Text>
      <Text>{" "}</Text>
      <D>  matcher shell-token npm+test · tier ask</D>
      <Text>{" "}</Text>
      <Text>  <A bold>y</A> once <D>· a always (→ moh.json) · e edit · n deny</D></Text>
    </Dialog>
  );

const Preview = ({ mode }: { mode: Mode }) => (
  <Dialog color={theme.accent} w={62}>
    <Box justifyContent="space-between">
      <Text color={theme.accent} bold>{ic("", "f")} {mode === "vibe" ? "file I'm reading" : "agent-session.ts"}</Text>
      <D>esc close</D>
    </Box>
    <Text>{" "}</Text>
    <Text color={theme.dim}>{" 42│ export class AgentSession {"}</Text>
    <Text color={theme.accent}>{" 43│   private events: AsyncIterable<SessionEvent>;"}</Text>
    <Text color={theme.dim}>{" 44│   async *stream(prompt) {"}</Text>
    <Text color={theme.dim}>{" …  "}</Text>
  </Dialog>
);

const Wayfinder = ({ mode }: { mode: Mode }) => (
  <Dialog color={theme.purple} w={54}>
    <Text color={theme.purple} bold>{ic("", "^")} {mode === "vibe" ? "The road ahead" : "Wayfinder — moh v1 spec"}</Text>
    <Text>{" "}</Text>
    <Text>  Next up: <A>{mode === "vibe" ? "how we'll test everything" : "#16 Testing strategy"}</A></Text>
    <Text>{" "}</Text>
    <D>  {mode === "vibe" ? "5 more decisions to go" : "3 blocked · #17 assemble"}</D>
    <Text>{" "}</Text>
    <D>  esc close</D>
  </Dialog>
);

const Settings = ({ mode }: { mode: Mode }) => (
  <Dialog color={theme.ok} w={58}>
    <Text color={theme.ok} bold>{ic("", "*")} Settings</Text>
    <Text>{" "}</Text>
    <Text>  Mode           <A>{mode === "vibe" ? "simple" : "developer"}</A></Text>
    <Text>  Theme          <A>{THEMES[currentTheme].label}</A></Text>
    <Text>{" "}</Text>
    <Text>  File preview   {mode === "vibe" ? "on demand" : "always"}</Text>
    <Text>  Icons          {ICONS ? "on (nerd font)" : "off (ascii)"}</Text>
    <Text>{" "}</Text>
    <D>  1-9 theme · i icons · v mode · esc close</D>
  </Dialog>
);

const App = () => {
  const { exit } = useApp();
  const [screen, setScreen] = useState<"home" | "chat">(process.env.MOCK_SCREEN === "chat" ? "chat" : "home");
  const [mode, setMode] = useState<Mode>(process.env.MOCK_MODE === "dev" ? "dev" : "vibe");
  const [overlay, setOverlay] = useState<string | null>(null);
  const [themeTick, setThemeTick] = useState(0);
  useInput((input, key) => {
    if (input === "q") return exit();
    if (key.escape) return setOverlay(null);
    if (input === "v") return setMode(m => (m === "vibe" ? "dev" : "vibe"));
    if (input === "i") { ICONS = !ICONS; return; }
    if (["1", "2", "3", "4", "5", "6", "7", "8", "9"].includes(input)) {
      currentTheme = (["tokyo-night", "catppuccin", "gruvbox", "nord", "dracula", "solarized", "c64", "amiga", "phosphor"] as ThemeName[])[+input - 1];
      theme = THEMES[currentTheme];
      setThemeTick(t => t + 1);
      return;
    }
    if (key.tab) { setOverlay(null); setScreen(s => (s === "home" ? "chat" : "home")); return; }
    if (overlay) return;
    if (screen === "chat" && "pfws".includes(input)) setOverlay(input);
  });
  return (
    <ThemeCtx.Provider value={theme}>
    <Box flexDirection="column" height="100%" key={themeTick}>
      {screen === "home" ? (
        <>
          <Home mode={mode} />
          <Box justifyContent="center">
            <Text backgroundColor={mode === "vibe" ? theme.accent : theme.purple} color={theme.bg} bold> {mode} </Text>
            <D> · tab = chat · v mode · 1-9 theme ({THEMES[currentTheme].label}) · i icons · q quit</D>
          </Box>
        </>
      ) : (
        <Chat mode={mode} overlay={overlay} />
      )}
    </Box>
    </ThemeCtx.Provider>
  );
};

render(<App />, { exitOnCtrlC: true });
