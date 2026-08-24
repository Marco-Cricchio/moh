import { describe, expect, it } from "bun:test";
import { fitRow } from "../src/viewport";

describe("native scrollback layout geometry", () => {
  it("drops optional segments before wrapping", () => {
    expect(fitRow([
      { text: "live" },
      { text: "context 80%" },
      { text: "model", optional: true },
    ], 15)).toEqual(["live", "context 80%"]);
  });

  it("truncates required final segments", () => {
    expect(fitRow([{ text: "ready" }, { text: "0123456789" }], 8)).toEqual(["ready", "012"]);
  });
});
