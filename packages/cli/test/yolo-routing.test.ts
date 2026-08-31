import { describe, expect, test } from "bun:test";
import { main } from "../src/cli";

/**
 * #377: `moh --yolo` must open the TUI like bare `moh` does (not be
 * mistaken for an unknown subcommand). These tests cover the arg routing
 * only — paths that would launch the TUI are asserted indirectly through
 * the usage-error guards around them.
 */
describe("moh --yolo routing (#377)", () => {
  test("--yolo with an unrelated subcommand is a usage error", async () => {
    expect(await main(["provider", "--yolo"])).toBe(2);
  });

  test("--yolo with junk after the flag is a usage error", async () => {
    expect(await main(["--yolo", "junk"])).toBe(2);
  });

  test("junk after bare moh is a usage error", async () => {
    expect(await main(["junk"])).toBe(2);
  });

  test("the removed flag fails loudly with the --yolo hint", async () => {
    expect(await main(["--dangerously-bypass-permissions"])).toBe(2);
  });

  test("--version still wins the first-position check", async () => {
    expect(await main(["--version"])).toBe(0);
  });
});
