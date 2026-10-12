import { describe, expect, test } from "bun:test";
import { MockProvider, createSession } from "../src";

describe("AgentSession.id (#1355)", () => {
  test("exposes a stable session-<uuid8> identity", () => {
    const session = createSession({ provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]), memory: { enabled: false } });
    expect(session.id).toMatch(/^session-[0-9a-f]{8}$/);
    expect(session.id).toBe(session.id);
  });

  test("two sessions hold distinct ids", () => {
    const provider = MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]);
    const a = createSession({ provider, memory: { enabled: false } });
    const b = createSession({ provider, memory: { enabled: false } });
    expect(a.id).not.toBe(b.id);
  });
});
