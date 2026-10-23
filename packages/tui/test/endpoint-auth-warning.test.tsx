/**
 * #1317: the TUI's half of the withdrawn-subscription diagnostic. An
 * endpoint still authenticated with a subscription login moh's onboarding
 * no longer offers (anthropic) cannot serve inference, so the transcript
 * renders the core's warning — remedy included — and an open whose
 * endpoint is in that state shows it at startup. Chrome only: it never
 * becomes provider context.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, type AgentEvent } from "@moh/core";
import { App } from "../src/App";
import { projectTranscript } from "../src/transcript";
import { stripAnsi, waitForFrame } from "./helpers";

const REASON =
  "endpoint \"anthropic\" is authenticated with anthropic subscription login, which moh's onboarding no longer offers and which does not serve inference — add an API-key endpoint instead (`moh provider add` → anthropic → api-key) and drop the stored tokens with `moh provider logout anthropic`.";

describe("endpoint_auth_withdrawn in the transcript (#1317)", () => {
  test("renders the core reason as a visible chrome warning, never a turn", () => {
    const blocks = projectTranscript([
      { type: "endpoint_auth_withdrawn", endpoint: "anthropic", reason: REASON } as AgentEvent,
    ]);
    const block = blocks.find((b) => b.type === "endpoint")!;
    expect(block.kind).toBe("info");
    expect(block.glyph).toBe("!");
    expect(block.detail).toBe("anthropic · subscription auth withdrawn");
    expect(block.lines).toEqual([REASON]);
    expect(blocks.filter((b) => b.kind === "user" || b.kind === "moh")).toHaveLength(0);
  });
});

describe("the warning at startup (#1317)", () => {
  test("an anthropic subscription endpoint is visible in the open session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-endpoint-warning-"));
    writeFileSync(
      join(cwd, "moh.json"),
      JSON.stringify({
        provider: "mock",
        endpoints: [{ name: "anthropic", type: "anthropic", defaultModel: "claude-sonnet-4-5", auth: { kind: "subscription" } }],
      }),
    );
    const i = render(
      <App intro={false} cwd={cwd} home={mkdtempSync(join(tmpdir(), "moh-endpoint-home-"))} provider={MockProvider.demo()} skipOnboarding startInChat />,
    );
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await waitForFrame(frame, "auth withdrawn");
    // The reason wraps at this width, so assert on the fragments that stay
    // on one line: the verdict and the start of the remedy.
    expect(frame()).toContain("does not serve inference");
    expect(frame()).toContain("moh provider logout");
    i.unmount();
  }, 20000);
});
