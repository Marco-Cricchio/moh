/**
 * #1317: an endpoint whose stored credential is a subscription login moh's
 * onboarding no longer offers (anthropic) cannot serve inference. Session
 * open records exactly one visible `endpoint_auth_withdrawn` chrome event —
 * on resume too — and changes nothing else: no conversion, no deletion, no
 * network call.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, createSession, sessionFromConfig, type MohConfig } from "../src/index";
import { SessionStore } from "../src/session-store";
import type { AgentEvent } from "../src/types";

const anthropicSubscription = {
  name: "anthropic",
  type: "anthropic",
  defaultModel: "claude-sonnet-4-5",
  auth: { kind: "subscription" as const },
};

function tempProject(): { cwd: string; home: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "moh-auth-withdrawn-"));
  return { cwd: dir, home: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function load(file: string): AgentEvent[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AgentEvent);
}

const diagnostics = (events: readonly AgentEvent[]) => events.filter((e) => e.type === "endpoint_auth_withdrawn");

describe("endpoint_auth_withdrawn at session open (#1317)", () => {
  test("one visible diagnostic, and the stored tokens are left alone", () => {
    const { cwd, home, cleanup } = tempProject();
    try {
      const authFile = join(home, ".moh", "config");
      mkdirSync(join(home, ".moh"), { recursive: true });
      writeFileSync(authFile, JSON.stringify({ auth: { tokens: { anthropic: { accessToken: "acc-x", refreshToken: "ref-x", updatedAt: 1 } } } }));
      const config: MohConfig = { provider: "mock", endpoints: [anthropicSubscription] };
      const before = JSON.stringify(config);
      const events: AgentEvent[] = [];
      const result = sessionFromConfig({ cwd, home, config, overrides: { sink: (e) => events.push(e) } });
      expect("error" in result).toBe(false);
      const diags = diagnostics(events);
      expect(diags).toHaveLength(1);
      expect(diags[0]).toMatchObject({ type: "endpoint_auth_withdrawn", endpoint: "anthropic" });
      const reason = (diags[0] as { reason: string }).reason;
      // Honest and actionable: what changed, and both halves of the remedy.
      expect(reason).toContain("no longer offers");
      expect(reason).toContain("does not serve inference");
      expect(reason).toContain("moh provider add");
      expect(reason).toContain("moh provider logout anthropic");
      // No conversion, no deletion.
      expect(JSON.stringify(config)).toBe(before);
      expect(JSON.parse(readFileSync(authFile, "utf8")).auth.tokens.anthropic.accessToken).toBe("acc-x");
    } finally {
      cleanup();
    }
  });

  test("a resume records it again — the endpoint is still that way in the resumed open", () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-auth-withdrawn-"));
    try {
      const store = SessionStore.create(dir, dir);
      createSession({ provider: MockProvider.demo(), endpoints: [anthropicSubscription], sink: (e) => store.append(e) });
      const first = load(store.file);
      expect(diagnostics(first)).toHaveLength(1);
      createSession({
        provider: MockProvider.demo(),
        endpoints: [anthropicSubscription],
        sessionFile: store.file,
        sink: (e) => store.append(e),
        resume: { events: first },
      });
      const after = load(store.file);
      expect(diagnostics(after)).toHaveLength(2);
      // The new one belongs to this open: it follows the resume marker.
      const resumedAt = after.findIndex((e) => e.type === "session_resumed");
      const lastDiagAt = after.map((e) => e.type).lastIndexOf("endpoint_auth_withdrawn");
      expect(resumedAt).toBeGreaterThanOrEqual(0);
      expect(lastDiagAt).toBeGreaterThan(resumedAt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every other endpoint opens silently: api-key, and a kind whose offer is live", () => {
    const { cwd, home, cleanup } = tempProject();
    try {
      const events: AgentEvent[] = [];
      const result = sessionFromConfig({
        cwd,
        home,
        config: {
          provider: "mock",
          endpoints: [
            { name: "anthropic-key", type: "anthropic", defaultModel: "claude-sonnet-4-5" },
            { name: "mygoogle", type: "google", defaultModel: "gemini-3-pro", auth: { kind: "subscription" } },
          ],
        },
        overrides: { sink: (e) => events.push(e) },
      });
      expect("error" in result).toBe(false);
      expect(diagnostics(events)).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
