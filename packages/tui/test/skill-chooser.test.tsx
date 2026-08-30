import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { SkillChooser } from "../src/SkillChooser";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(props: Partial<React.ComponentProps<typeof SkillChooser>> = {}) {
  return render(
    <ThemeProvider value={THEMES[DEFAULT_THEME]}>
      <SkillChooser
        issue={{ id: "123", title: "Fix thing", state: "open", labels: ["enhancement"], assignees: ["@me"], blockedBy: [] }}
        onChoose={() => {}}
        onBack={() => {}}
        onJustClaim={() => {}}
        {...props}
      />
    </ThemeProvider>,
  );
}

describe("SkillChooser", () => {
  test("selecting a recommendation supplies an unsent minimal prefill", async () => {
    const chosen: string[] = [];
    const i = mount({ onChoose: (text) => chosen.push(text) });
    await sleep(20);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("/implement #123");
    i.stdin.write("\r");
    await sleep(20);
    expect(chosen).toEqual(["/implement #123"]);
    i.unmount();
  });

  test("escape returns to Frontier while retaining the claim", async () => {
    let back = 0;
    const i = mount({ onBack: () => back++ });
    await sleep(20);
    i.stdin.write("\u001b");
    await sleep(20);
    expect(back).toBe(1);
    i.unmount();
  });

  test("no match offers Just claim without another skill", async () => {
    let exited = 0;
    const i = mount({ issue: { id: "9", title: "Unmapped", state: "open", labels: [], assignees: ["@me"], blockedBy: [] }, onJustClaim: () => exited++ });
    await sleep(20);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Just claim");
    i.stdin.write("j");
    await sleep(20);
    expect(exited).toBe(1);
    i.unmount();
  });
});
