import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { CommandsPanel } from "../src/CommandsPanel";
import { actUntilFrame, stripAnsi, unmountSettled } from "./helpers";

describe("CommandsPanel key column (#1691)", () => {
  test("a 24-character key is still separated from its description", async () => {
    const i = render(<CommandsPanel onClose={() => {}} />);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    try {
      // Scroll the list down until the 24-character subagent-chip key shows.
      await actUntilFrame(() => i.stdin.write("\u001b[B"), frame, "enter on a subagent chip", { timeoutMs: 5_000 });
      const row = frame().split("\n").find((r) => r.includes("enter on a subagent chip"));
      expect(row).toMatch(/enter on a subagent chip +\S/);
    } finally {
      await unmountSettled(i);
    }
  });
});
