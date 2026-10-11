import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Home } from "../src/Home";
import { Logo } from "../src/ui";
import { LOGO_BANNER, SPLASH_BANNERS, pickSplashFont } from "../src/ui";
import { LogoIntro } from "../src/LogoIntro";
import { RAMP_PRESETS, lerpHex, pickRampPreset, rampLogoRows, rampText } from "../src/logo-ramp";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isolatedHome = () => mkdtempSync(join(tmpdir(), "moh-tui-logo-ramp-"));

/** Extracts the truecolor escape sequences from a frame. */
const escapes = (s: string): string[] => s.match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? [];

describe("logo ramp (#1304)", () => {
  test("rampText interpolates per character: first char from, last char to", () => {
    const out = rampText("abc", "#000000", "#ffffff");
    const m = out.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g);
    expect(m).not.toBeNull();
    // First painted char carries the `from` color, last the `to` color.
    expect(m![0]).toBe("\x1b[38;2;0;0;0m");
    expect(m![m!.length - 1]).toBe("\x1b[38;2;255;255;255m");
  });

  test("rampText leaves spaces unpainted and emits well-formed escapes", () => {
    const out = rampText("a b", "#102030", "#102030");
    // The space sits bare between two foreground resets: painted runs open
    // with 38;2 and close with 39, the space is never inside one.
    expect(out).toBe("\x1b[38;2;16;32;48ma\x1b[39m \x1b[38;2;16;32;48mb\x1b[39m");
    for (const e of escapes(out)) expect(e).toMatch(/^(\x1b\[38;2;\d+;\d+;\d+m)$/);
    // Every open is closed by a foreground reset.
    expect((out.match(/\x1b\[39m/g) ?? []).length).toBe((out.match(/\x1b\[38;2;/g) ?? []).length);
  });

  test("two-row continuity: tagline's last color equals version's first color", () => {
    for (const preset of Object.keys(RAMP_PRESETS) as Array<keyof typeof RAMP_PRESETS>) {
      const { tagline, version } = rampLogoRows("My Own Harness", "v1.42.0", preset);
      const tagEnd = tagline.match(/\x1b\[38;2;(\d+;\d+;\d+)m[^\x1b]*\x1b\[39m$/);
      const verStart = version!.match(/\x1b\[38;2;(\d+;\d+;\d+)m/);
      expect(tagEnd).not.toBeNull();
      expect(verStart).not.toBeNull();
      expect(verStart![1]).toBe(tagEnd![1]);
    }
  });

  test("rampText strips to bare text when NO_COLOR is set (#880)", () => {
    process.env.NO_COLOR = "1";
    try {
      expect(rampText("My Own Harness", ...RAMP_PRESETS.atlas)).toBe("My Own Harness");
    } finally {
      delete process.env.NO_COLOR;
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
  // The intro animates and each style completes rows in its own order:
  // poll until the frame contains every settled banner row (or time out).
  async function settledFrame(view: { lastFrame: () => string | undefined }, rows: string[]): Promise<string> {
    const deadline = Date.now() + 8000;
    for (;;) {
      const frame = view.lastFrame() ?? "";
      if (rows.every((r) => frame.includes(r))) return frame;
      if (Date.now() > deadline) return frame;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  test("renders the injected font's banner rows once settled", async () => {
    const rows = SPLASH_BANNERS.Small!.map((r) => r.trimEnd());
    const view = render(<LogoIntro onSkip={() => {}} splashFont="Small" />);
    const frame = await settledFrame(view, rows);
    for (const row of rows) expect(frame).toContain(row);
    view.unmount();
  });

  test("a font name that is not in the allow-list falls back to LOGO_BANNER", async () => {
    const rows = LOGO_BANNER.map((r) => r.trimEnd());
    const view = render(<LogoIntro onSkip={() => {}} splashFont="Nonexistent" />);
    const frame = await settledFrame(view, rows);
    for (const row of rows) expect(frame).toContain(row);
    view.unmount();
  });
});
