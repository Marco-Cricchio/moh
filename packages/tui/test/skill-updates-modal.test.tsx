import React from "react";
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { SkillUpdatesModal } from "../src/SkillUpdatesModal";

const sleep = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

const updates = [
  { name: "tdd", currentHash: "a", upstreamHash: "b", files: { "SKILL.md": "new tdd" } },
  { name: "review", currentHash: "c", upstreamHash: "d", files: { "SKILL.md": "new review" } },
];

describe("SkillUpdatesModal", () => {
  test("projects every update and the selected skill's complete diff", async () => {
    const ui = render(
      <SkillUpdatesModal
        updates={updates}
        readInstalled={() => ({ "SKILL.md": "old" })}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );

    expect(ui.lastFrame()).toContain("2 skill updates available");
    expect(ui.lastFrame()).toContain("tdd");
    expect(ui.lastFrame()).toContain("review");
    expect(ui.lastFrame()).toContain("-old");
    expect(ui.lastFrame()).toContain("+new tdd");

    ui.stdin.write("\u001b[B");
    await sleep();
    expect(ui.lastFrame()).toContain("+new review");
  });

  test("offers explicit apply and cancel actions", async () => {
    let applied = 0;
    let closed = 0;
    const ui = render(
      <SkillUpdatesModal
        updates={updates}
        readInstalled={() => ({})}
        onApply={() => { applied++; }}
        onClose={() => { closed++; }}
      />,
    );

    expect(ui.lastFrame()).toContain("Apply updates");
    expect(ui.lastFrame()).toContain("Cancel / Not now");
    ui.stdin.write("a");
    await sleep();
    expect(applied).toBe(1);
    ui.stdin.write("\u001b");
    await sleep();
    expect(closed).toBe(1);
  });
});
