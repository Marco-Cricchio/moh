// PROTOTYPE (demo) — throwaway live-session simulator for the moh TUI mockup.
// Run: bun prototype/tui-demo.tsx
// Simulates a realistic session in a loop: user types → answer streams →
// tool call → 2 subagents (parallel, one finishes, one asks) → permission
// dialog → final answer. Keys: [space] pause/resume · [v] vibe/dev · [1-9] theme · [q] quit
import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";

const hexToRgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(";");

const THEMES = {
  "tokyo-night": { label: "Tokyo Night", accent: "#7aa2f7", dim: "#565f89", ok: "#9ece6a", warn: "#e0af68", purple: "#bb9af7", border: "#292e42", bg: "#16161e" },
  "catppuccin": { label: "Catppuccin Mocha", accent: "#89b4fa", dim: "#6c7086", ok: "#a6e3a1", warn: "#f9e2af", purple: "#cba6f7", border: "#45475a", bg: "#1e1e2e" },
  "gruvbox": { label: "Gruvbox Dark", accent: "#83a598", dim: "#7c6f64", ok: "#b8bb26", warn: "#fabd2f", purple: "#d3869b", border: "#504945", bg: "#282828" },
  "nord": { label: "Nord", accent: "#88c0d0", dim: "#4c566a", ok: "#a3be8c", warn: "##ebcb8b".slice(0,7) || "#ebcb8b", purple: "#b48ead", border: "#434c5e", bg: "#2e3440" },
  "dracula": { label: "Dracula", accent: "#bd93f9", dim: "#6272a4", ok: "#50fa7b", warn: "#f1fa8c", purple: "#ff79c6", border: "#44475a", bg: "#282a36" },
  "solarized": { label: "Solarized Dark", accent: "##268bd2".slice(0,7) || "#268bd2", dim: "#586e75", ok: "#859900", warn: "#b58900", purple: "#6c71c4", border: "#073642", bg: "#002b36" },
  "c64": { label: "Commodore 64", accent: "#7869c4", dim: "#5f5299", ok: "#94e089", warn: "#b8b445", purple: "#6c4fc9", border: "#7869c4", bg: "#40318d" },
  "amiga": { label: "Amiga OS", accent: "#aaaaaa", dim: "#8a8fa8", ok: "#ffffff", warn: "#ff9900", purple: "#ff9900", border: "#ffffff", bg: "#0055aa" },
  "phosphor": { label: "Green Phosphor", accent: "#00ff00", dim: "#008800", ok: "#00cc00", warn: "#00ff41", purple: "#00dd00", border: "#00aa00", bg: "#000000" },
} as const;
type ThemeName = keyof typeof THEMES;

type Mode = "vibe" | "dev";
const frame = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let ICONS = true;
const ic = (g: string, ascii: string) => (ICONS ? g : ascii);

// ---- script: the whole session as a timeline of state changes ----
type Turn = {
  user: string;
  answer: string;      // full markdown answer (streamed word by word)
  tool: { file: string; dur: string } | null;
  subs: { name: string; status: string }[] | null;
  perm: { cmd: string } | null;   // permission interrupts before answer completes
};

const SCRIPT: Turn[] = [
  {
    user: "where do you keep our conversation?",
    answer: "I keep a **diary** of it on your computer.\n\nClose any time — we pick up right where we left off.\n\n- saved automatically\n- private to you",
    tool: null, subs: null, perm: null,
  },
  {
    user: "is there anything slow in the session code?",
    answer: "Yes — one spot. When the log grows past a few thousand events, `resume()` re-parses **every line** before the first token.\n\nI'd cache the parsed prefix. Want me to fix it?",
    tool: { file: "agent-session.ts · L1-80", dur: "1.2s" },
    subs: [
      { name: "research-tui", status: "reading marked-terminal docs… 4.1k tok" },
      { name: "probe-ink", status: "Static + focus manager · done" },
    ],
    perm: null,
  },
  {
    user: "yes, and run the tests after",
    answer: "Fixed: the parsed prefix is now cached in `~/.moh/cache/`, so `resume()` starts streaming almost instantly.\n\nAll **42 tests** pass — the fix shaved ~900ms off a typical resume.",
    tool: { file: "agent-session.ts · L40-96", dur: "0.8s" },
    subs: null,
    perm: { cmd: "npm test -- --filter session" },
  },
];

// ---- app state machine ----
const a_txt = "yes"; // styled inline below
const y_txt = "y";
const App = () => {
  const { exit } = useApp();
  const [paused, setPaused] = useState(false);
  const [mode, setMode] = useState<Mode>("vibe");
  const [themeName, setThemeName] = useState<ThemeName>("tokyo-night");
  const theme = THEMES[themeName] as any;
  const [tick, setTick] = useState(0);

  // transcript: list of completed turns {user, answer, tool, subs, done}
  const [transcript, setTranscript] = useState<any[]>([]);
  // current partial turn
  const [typing, setTyping] = useState("");        // user typing chars
  const [phase, setPhase] = useState<"idle" | "typing" | "thinking" | "streaming" | "tool" | "subs" | "perm" | "done">("idle");
  const [partial, setPartial] = useState("");      // streamed answer so far
  const [turnIdx, setTurnIdx] = useState(0);
  const [perm, setPerm] = useState<{ cmd: string } | null>(null);

  useEffect(() => { const t = setInterval(() => setTick(x => x + 1), 90); return () => clearInterval(t); }, []);

  // the driver: advances the state machine
  useEffect(() => {
    if (paused) return;
    const turn = SCRIPT[turnIdx % SCRIPT.length];
    let timer: any;
    const step = (fn: () => void, ms: number) => { timer = setTimeout(fn, ms); return timer; };

    if (phase === "idle") {
      step(() => setPhase("typing"), 800);
    } else if (phase === "typing") {
      if (typing.length < turn.user.length) {
        step(() => setTyping(turn.user.slice(0, typing.length + 1)), 45 + Math.random() * 60);
      } else {
        step(() => { setPhase("thinking"); }, 500);
      }
    } else if (phase === "thinking") {
      step(() => {
        if (turn.tool) { setPhase("tool"); } else { setPhase("streaming"); }
      }, 1200);
    } else if (phase === "tool") {
      step(() => { if (turn.subs) setPhase("subs"); else if (turn.perm) { setPerm(turn.perm); setPhase("perm"); } else setPhase("streaming"); }, 1400);
    } else if (phase === "subs") {
      step(() => { if (turn.perm) { setPerm(turn.perm); setPhase("perm"); } else setPhase("streaming"); }, 2000);
    } else if (phase === "perm") {
      // auto-answered "yes" after a beat; dialog shows until then
      step(() => { setPerm(null); setPhase("streaming"); }, 2200);
    } else if (phase === "streaming") {
      if (partial.length < turn.answer.length) {
        step(() => {
          // stream word-wise
          const words = turn.answer.slice(partial.length).split(/(\s+)/);
          const n = words.slice(0, 2).join("");
          setPartial(turn.answer.slice(0, partial.length + n.length));
        }, 60);
      } else {
        step(() => setPhase("done"), 400);
      }
    } else if (phase === "done") {
      step(() => {
        setTranscript(t => [...t, { ...turn, partial: turn.answer }]);
        setTyping(""); setPartial("");
        setTurnIdx(i => i + 1);
        setPhase("idle");
      }, 2500);
    }
    return () => clearTimeout(timer);
  }, [phase, typing, partial, turnIdx, paused]);

  useInput((input: string, key: any) => {
    if (input === "q") return exit();
    if (input === " ") { setPaused(p => !p); return; }
    if (input === "v") return setMode(m => (m === "vibe" ? "dev" : "vibe"));
    if (input === "i") { ICONS = !ICONS; return; }
    if (["1","2","3","4","5","6","7","8","9"].includes(input)) {
      setThemeName((["tokyo-night","catppuccin","gruvbox","nord","dracula","solarized","c64","amiga","phosphor"] as ThemeName[])[+input - 1]);
    }
  });

  const A = ({ children }: any) => <Text color={theme.accent}>{children}</Text>;
  const D = ({ children }: any) => <Text color={theme.dim}>{children}</Text>;
  const f = frame[tick % frame.length];

  const md = new Marked(markedTerminal({ code: (code: string) => `\x1b[38;2;${hexToRgb(theme.accent)}m${code}\x1b[0m` }) as any);
  const MD = ({ text }: { text: string }) => {
    const fences = (text.match(/```/g) || []).length;
    const safe = fences % 2 === 1 ? text + "\n```" : text;
    return <Text>{(md.parse(safe) as string).replace(/\n+$/, "")}</Text>;
  };

  const MsgBox = ({ label, color, children }: any) => (
    <Box borderStyle="round" borderColor={color} flexDirection="column" width="100%" paddingX={1}>
      <Text color={color}>{label}</Text>
      {children}
    </Box>
  );

  const cur = SCRIPT[turnIdx % SCRIPT.length];
  const show = (t: any, isCurrent: boolean) => {
    const items: any[] = [];
    items.push(<MsgBox key="you" label=" you " color={theme.accent}><Text>{`  ${t.user}`}</Text></MsgBox>);
    if (t.tool) items.push(
      <MsgBox key="tool" label={mode === "vibe" ? " what I did " : " tool · read "} color={theme.border}>
        <Text><D>{` ${ic("📖", "read")} `}{mode === "vibe" ? "read the session file " + ic("✓", "ok") : `${t.tool.file} ${ic("✓", "ok")} ${t.tool.dur}`}</D></Text>
      </MsgBox>
    );
    if (t.subs) items.push(
      <MsgBox key="subs" label={mode === "vibe" ? " helpers " : " subagents "} color={theme.border}>
        {mode === "vibe" ? (
          <Text><D>{` ${ic("", "^")} I asked two helpers to check something — one is back, one is still looking…`}</D></Text>
        ) : (
          <Box flexDirection="column">
            <Text><D>{` ${ic(" ZEND", "spawn")} 2 subagents · depth 1 · parallel`}</D></Text>
            {t.subs.map((s: any, si: number) => (
              <Text key={`sub${si}`}>{`   ${ic("", "-")} ${s.name} · ${s.status}`}</Text>
            ))}
          </Box>
        )}
      </MsgBox>
    );
    items.push(
      <MsgBox key="moh" label=" moh " color={theme.purple}>
        <MD text={t.partial ?? t.answer} />
        {isCurrent && t.streaming ? (
          <Text><D>{`  ${f} ${mode === "vibe" ? "thinking…" : "streaming · 84 tok/s"} · esc to steer`}</D></Text>
        ) : null}
      </MsgBox>
    );
    return items;
  };

  // build render list from transcript + current turn state
  const currentRender: any[] = [];
  if (phase === "typing" || phase === "thinking" || phase === "tool" || phase === "subs" || phase === "perm" || phase === "streaming" || phase === "done") {
    const partialTurn: any = { ...cur, partial: partial || "" };
    if (phase === "streaming") partialTurn.streaming = true;
    if (phase === "tool" || phase === "subs" || phase === "perm") partialTurn.partial = "";
    if (phase === "typing" || phase === "thinking") partialTurn.partial = "";
    const toolVisible = ["tool", "subs", "perm", "streaming", "done"].includes(phase);
    const subsVisible = ["subs", "perm", "streaming", "done"].includes(phase);
    partialTurn.tool = toolVisible ? cur.tool : null;
    partialTurn.subs = subsVisible ? cur.subs : null;
    const items = show(partialTurn, true);
    items.forEach((el: any, i: number) => currentRender.push(<Box key={`cur${i}`}>{el}</Box>));
  }

  return (
    <Box flexDirection="column" height="100%" key={paused ? "p" : "r"}>
      <Box justifyContent="space-between" paddingX={2}>
        <Text bold color={theme.accent}>{`${ic("", "*")} moh`}</Text>
        {mode === "dev" ? <D>{`claude-sonnet-4-5 · ${12 + turnIdx * 4}k/200k tok · normal`}</D> : null}
      </Box>
      <Text>{"\u0020"}</Text>
      <Box flexDirection="column" flexGrow={1} width="100%" gap={0}>
        {phase === "idle" ? <Text><D>{`  ${f}`}</D></Text> : null}
        {transcript.map((t: any, i: number) => {
          const its = show(t, false);
          return its.map((el: any, j: number) => <Box key={`t${i}-${j}`}>{el}</Box>);
        })}
        {currentRender}
      </Box>
      <Text>{"\u00a0"}</Text>
      <Box borderStyle="round" borderColor={theme.border} width="100%" paddingX={1}>
        <Text color={theme.accent} bold>› </Text>
        {phase === "typing"
          ? <Text>{typing}<D>▊</D></Text>
          : <D>type… (ctrl+e long text)</D>}
      </Box>
      {perm ? (
        <Box flexDirection="column" alignItems="center" justifyContent="center" position="absolute" width="100%" height="100%">
          <Box borderStyle="round" borderColor={theme.warn} width="60%" flexDirection="column" padding={2} backgroundColor={theme.bg}>
            {mode === "vibe"
              ? <Text>{`\n ${ic("", "!")} Quick check\n\n  I'd like to run the project's tests\n  to make sure nothing broke.\n`}</Text>
              : <Text>{`\n ${ic("", "!")} Permission — bash\n\n  ${perm.cmd}\n\n  matcher shell-token npm+test · tier ask\n`}</Text>}
          </Box>
        </Box>
      ) : null}
      <Box justifyContent="center">
        <D>{` ${paused ? "PAUSED — space resume" : "space pause"} · v mode (${mode}) · 1-9 theme (${THEMES[themeName].label}) · i icons · q quit `}</D>
      </Box>
    </Box>
  );
};

const origErr = console.error;
console.error = (...a: any[]) => {
  const all = a.map(String).join(" ");
  if (all.includes("Encountered") || all.includes("same key")) {
    origErr("KEYWARN stack:", new Error().stack?.split("\n").slice(2,8).join(" | "));
    process.exit(0);
  }
  origErr(...a);
};
render(<App />, { exitOnCtrlC: true });
