import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { createRequire } from "node:module";
import { ThemeProvider, THEMES } from "../src/themes";
import { Home } from "../src/Home";
import { Logo } from "../src/ui";
import { LOGO_BANNER, SPLASH_BANNERS, pickSplashFont, type SplashFontName } from "../src/ui";
import { LogoIntro } from "../src/LogoIntro";
import { stripAnsi } from "./helpers";
import { RAMP_PRESETS, lerpHex, pickRampPreset, rampLogoRows, rampText, type RampPresetName } from "../src/logo-ramp";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inkChalk = createRequire(import.meta.resolve("ink"))("chalk").default as { level: 0 | 1 | 2 | 3 };
let previousLevel: typeof inkChalk.level;
let previousNoColor: string | undefined;
beforeEach(() => {
  previousLevel = inkChalk.level;
  previousNoColor = process.env.NO_COLOR;
  inkChalk.level = 3;
  delete process.env.NO_COLOR;
});
afterEach(() => {
  inkChalk.level = previousLevel;
  if (previousNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = previousNoColor;
});

const isolatedHome = () => mkdtempSync(join(tmpdir(), "moh-tui-logo-ramp-"));

describe("intro={false} fast-path (#1304 regression)", () => {
  test("a static Home renders no intro banner rows", () => {
    const { lastFrame } = render(
      <Home intro={false} cwd={process.cwd()} home={isolatedHome()} mode="vibe" onOpen={() => {}} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    // A splash font's first row can never appear: only the settled canonical
    // banner or the one-liner is on a static Home, never the scatter noise.
    expect(frame).not.toContain(SPLASH_BANNERS.Ghost![0]!.trimEnd());
  });
});

/** Extracts the truecolor escape sequences from a frame. */
const escapes = (s: string): string[] => s.match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? [];

describe("logo ramp (#1304)", () => {
  test("rampText interpolates from the first to the last character without ANSI", () => {
    expect(rampText("abc", "#000000", "#ffffff")).toEqual([
      { text: "a", color: "#000000" },
      { text: "b", color: "#808080" },
      { text: "c", color: "#ffffff" },
    ]);
    expect(rampText("", "#000000", "#ffffff")).toEqual([]);
    expect(rampText("x", "#000000", "#ffffff")).toEqual([{ text: "x", color: "#ffffff" }]);
  });

  test("rampText leaves spaces unpainted and groups adjacent equal colors", () => {
    expect(rampText("ab cd", "#102030", "#102030")).toEqual([
      { text: "ab", color: "#102030" }, { text: " " }, { text: "cd", color: "#102030" },
    ]);
  });

  test("two-row continuity: tagline's last color equals version's first color", () => {
    for (const preset of Object.keys(RAMP_PRESETS) as RampPresetName[]) {
      const { tagline, version } = rampLogoRows("My Own Harness", "v1.42.0", preset);
      expect(tagline.at(-1)?.color).toBe(version![0]?.color);
      expect(tagline.map(part => part.text).join("")).toBe("My Own Harness");
      expect(version!.map(part => part.text).join("")).toBe("v1.42.0");
    }
  });

  test("lerpHex clamps out-of-range t", () => {
    expect(lerpHex("#000000", "#ffffff", -1)).toBe("#000000");
    expect(lerpHex("#000000", "#ffffff", 2)).toBe("#ffffff");
  });

  test("pickRampPreset and pickSplashFont return valid names", () => {
    expect(Object.keys(RAMP_PRESETS)).toContain(pickRampPreset());
    expect(Object.keys(SPLASH_BANNERS)).toContain(pickSplashFont());
  });
});

describe("splash banners (#1304)", () => {
  test("every allow-listed font composes MoH rows and includes the canonical Slant", () => {
    expect(SPLASH_BANNERS.Slant).toBe(LOGO_BANNER);
    for (const rows of Object.values(SPLASH_BANNERS)) {
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => typeof r === "string")).toBe(true);
    }
  });
});

describe("Logo ramp rendering (#1304)", () => {
  test("Logo under color paints the tagline and version rows with truecolor escapes", () => {
    const { lastFrame } = render(<Logo banner version="0.1.0" rampPreset="fruit" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("M");
    expect(frame).toContain("v");
    expect(escapes(frame).length).toBeGreaterThan(0);
  });

  test("settled Home renders plain dim rows under NO_COLOR, no escapes (#880)", () => {
    process.env.NO_COLOR = "1";
    try {
      const { lastFrame } = render(
        <Home intro={false} cwd={process.cwd()} home={isolatedHome()} mode="vibe" onOpen={() => {}} version="0.1.0" />,
      );
      const frame = lastFrame() ?? "";
      expect(frame).toContain("My Own Harness");
      expect(frame).toContain("v0.1.0");
      expect(escapes(frame)).toHaveLength(0);
    } finally {
      delete process.env.NO_COLOR;
    }
  });

  test("Logo with an injected preset: version row's first color equals tagline's last", () => {
    const { lastFrame } = render(<Logo banner version="0.1.0" rampPreset="mind" />);
    const frame = lastFrame() ?? "";
    const [from, to] = RAMP_PRESETS.mind;
    const mid = lerpHex(from, to, 0.5);
    const rgb = (hex: string) =>
      [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";");
    expect(frame).toContain(`\x1b[38;2;${rgb(RAMP_PRESETS.mind[0])}m`);
    expect(frame).toContain(`\x1b[38;2;${rgb(mid)}m`);
    expect(frame).toContain(`\x1b[38;2;${rgb(to)}m`);
  });
});

describe("LogoIntro splash (#1304)", () => {
  // The intro animates on chained `setTimeout`s (2.8 s of real time) and each
  // style completes rows in its own order. Bun 1.2 has no usable fake timers,
  // so the test owns the clock instead: while a view is mounted, `setTimeout`
  // is captured and the test fires the due callbacks itself, one animation
  // step per turn of the event loop. The settled frame no longer depends on
  // how fast the machine runs, only on how many steps the animation has.
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let pending: Map<number, () => void> | null = null;

  function holdTimers(): void {
    const timers = new Map<number, () => void>();
    let nextId = 1;
    pending = timers;
    globalThis.setTimeout = ((fn: () => void) => {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      timers.delete(id);
    }) as unknown as typeof clearTimeout;
  }

  function releaseTimers(): void {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    pending = null;
  }

  /** Steps the animation until the frame holds every banner row. A style that
   * never settles fails on a step budget (the longest style is ~25 frames),
   * not on a wall clock, and the failure names the rows still missing. */
  async function settledFrame(view: { lastFrame: () => string | undefined }, rows: string[]): Promise<string> {
    const MAX_STEPS = 200;
    for (let step = 0; step <= MAX_STEPS; step++) {
      const frame = view.lastFrame() ?? "";
      if (rows.every((r) => frame.includes(r))) return frame;
      const due = [...pending!.entries()];
      pending!.clear();
      for (const [, fn] of due) fn();
      // Let React commit the state update the callback scheduled.
      await new Promise<void>((r) => realSetTimeout(r, 0));
    }
    const frame = view.lastFrame() ?? "";
    const missing = rows.filter((r) => !frame.includes(r));
    throw new Error(`LogoIntro did not settle after ${MAX_STEPS} steps; missing rows: ${JSON.stringify(missing)}\nLast frame:\n${frame}`);
  }

  beforeEach(holdTimers);
  afterEach(releaseTimers);

  test(
    "each allow-listed font renders through the injected choice",
    async () => {
      for (const font of Object.keys(SPLASH_BANNERS) as SplashFontName[]) {
        const rows = SPLASH_BANNERS[font]!.map((r) => r.trimEnd()).filter((r) => r !== "");
        const view = render(<LogoIntro onSkip={() => {}} splashFont={font} />);
        const frame = await settledFrame(view, rows);
        for (const row of rows) expect(frame).toContain(row);
        view.unmount();
      }
    },
    30_000,
  );

  test("renders the injected font's banner rows once settled", async () => {
    const rows = SPLASH_BANNERS.Small!.map((r) => r.trimEnd());
    const view = render(<LogoIntro onSkip={() => {}} splashFont="Small" />);
    const frame = await settledFrame(view, rows);
    for (const row of rows) expect(frame).toContain(row);
    view.unmount();
  });

  test("a font name that is not in the allow-list falls back to LOGO_BANNER", async () => {
    const rows = LOGO_BANNER.map((r) => r.trimEnd());
    const view = render(
      <LogoIntro onSkip={() => {}} splashFont={"Nonexistent" as SplashFontName} />,
    );
    const frame = await settledFrame(view, rows);
    for (const row of rows) expect(frame).toContain(row);
    view.unmount();
  });

  test("banner=false (short-terminal gate) animates the fallback LOGO_BANNER rows", async () => {
    const rows = LOGO_BANNER.map((r) => r.trimEnd());
    const view = render(
      <LogoIntro onSkip={() => {}} splashFont="Ghost" banner={false} rampPreset="mind" />,
    );
    const frame = await settledFrame(view, rows);
    // No splash font's rows leak: the intro animates the canonical fallback.
    for (const row of rows) expect(frame).toContain(row);
    expect(frame).not.toContain(SPLASH_BANNERS.Ghost![0]!.trimEnd());
    // No ramp on the short-terminal intro (the tagline stays settled-only).
    expect(stripAnsi(frame)).not.toContain("My Own Harness");
    view.unmount();
  });

  test("intro tagline and settled Logo tagline share the injected preset", () => {
    const intro = render(<LogoIntro onSkip={() => {}} splashFont="Small" banner rampPreset="vice" />);
    const settled = render(<Logo banner rampPreset="vice" />);
    // Both paint from the same preset: the intro's one-liner and the settled
    // tagline open with the same first-stop escape.
    const taglineEsc = (frame: string) => escapes(frame.split("\n").find(line => stripAnsi(line).includes("My Own Harness")) ?? "")[0];
    const introEsc = taglineEsc(intro.lastFrame() ?? "");
    const settledEsc = taglineEsc(settled.lastFrame() ?? "");
    expect(introEsc).toBe("\x1b[38;2;94;231;223m");
    expect(settledEsc).toBe(introEsc);
    intro.unmount();
    settled.unmount();
  });
});


describe("logo color capability on every theme", () => {
  for (const level of [0, 1, 2, 3] as const) {
    test(`level ${level}: settled and intro gradients use only supported color sequences`, () => {
      inkChalk.level = level;
      for (const theme of Object.values(THEMES)) {
        for (const preset of Object.keys(RAMP_PRESETS) as RampPresetName[]) {
          const views = [
            render(<ThemeProvider value={theme}><Logo banner version="0.66.3" rampPreset={preset} /></ThemeProvider>),
            render(<ThemeProvider value={theme}><LogoIntro banner onSkip={() => {}} splashFont="Small" rampPreset={preset} /></ThemeProvider>),
          ];
          try {
            for (const view of views) {
              const frame = view.lastFrame() ?? "";
              expect(stripAnsi(frame)).toContain("My Own Harness");
              if (level < 3) expect(frame, `${theme.label}/${preset}`).not.toMatch(/\x1b\[(?:38|48);2;/);
              if (level < 2) expect(frame).not.toMatch(/\x1b\[(?:38|48);5;/);
              if (level === 0) expect(frame).not.toMatch(/\x1b\[(?:3[0-7]|9[0-7])m/);
              if (level === 2) expect(frame).toMatch(/\x1b\[38;5;/);
              if (level === 3) expect(frame).toMatch(/\x1b\[38;2;/);
            }
          } finally { for (const view of views) view.unmount(); }
        }
      }
    }, 15_000);
  }
});
