/**
 * Skill prompt seam (ADR-0011): a turn-scoped skill prompt attached to
 * `send(text, { prompt })` rides the system prompt (skills section, in
 * full, framed), never the user message; the log records a discreet
 * `skill_invoked` chrome event; the next turn composes the ordinary
 * skills index again.
 */
import { describe, expect, test } from "bun:test";
import { createSession } from "../src/index";
import type { Message, Provider, StreamEvent } from "../src/types";

/** Captures the first (system) message of every provider call. */
function captureProvider(): { systems: string[]; users: string[]; provider: Provider } {
  const systems: string[] = [];
  const users: string[] = [];
  const provider: Provider = {
    name: "capture",
    async *stream(messages: Message[]): AsyncIterable<StreamEvent> {
      systems.push(String(messages[0]?.parts[0]?.kind === "text" ? (messages[0].parts[0] as { text: string }).text : ""));
      const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.parts.some((p) => p.kind === "text"));
      users.push(String((lastUser?.parts.find((p) => p.kind === "text") as { text: string } | undefined)?.text ?? ""));
      yield { type: "finish", reason: "stop" } as const;
    },
  };
  return { systems, users, provider };
}

describe("skill prompt seam (ADR-0011)", () => {
  test("the skill body lands in the system prompt, the user message stays the clean text", async () => {
    const { systems, users, provider } = captureProvider();
    const session = createSession({ provider });

    await session.send("which skill for a bug?", {
      prompt: { name: "ask-moh", text: "## Router body\nPoint at /diagnosing-bugs." },
    });

    expect(users).toEqual(["which skill for a bug?"]); // clean — no SKILL.md blob
    expect(systems[0]).toContain('Follow the "ask-moh" skill for this turn');
    expect(systems[0]).toContain("## Router body");
    expect(systems[0]).toContain("Point at /diagnosing-bugs.");
  });

  test("the log records skill_invoked as chrome right before the user_message", async () => {
    const { provider } = captureProvider();
    const session = createSession({ provider });

    await session.send("route me", { prompt: { name: "ask-moh", text: "body" } });

    const log = session.history().map((e) => e.type);
    const invokedAt = log.indexOf("skill_invoked");
    expect(invokedAt).toBeGreaterThanOrEqual(0);
    expect(log[invokedAt + 1]).toBe("user_message"); // adjacent, before the turn opens
    const events = session.history();
    expect((events[invokedAt] as { name: string }).name).toBe("ask-moh");
  });

  test("the injection lives one turn: the next send composes the ordinary skills index again", async () => {
    const { systems, users, provider } = captureProvider();
    const session = createSession({ provider });

    await session.send("with skill", { prompt: { name: "ask-moh", text: "one-turn body" } });
    await session.send("plain follow-up");

    expect(users).toEqual(["with skill", "plain follow-up"]);
    expect(systems[0]).toContain("one-turn body");
    expect(systems[1]).not.toContain("one-turn body");
    expect(systems[1]).not.toContain('Follow the "ask-moh" skill');
  });

  test("a cancelled turn still drops the skill prompt (steering away from a skill turn)", async () => {
    const systems: string[] = [];
    let call = 0;
    const provider: Provider = {
      name: "slow-then-fast",
      async *stream(messages: Message[], signal: AbortSignal): AsyncIterable<StreamEvent> {
        call += 1;
        systems.push(String(messages[0]?.parts[0]?.kind === "text" ? (messages[0].parts[0] as { text: string }).text : ""));
        yield { type: "model_call_start", model: "stf" };
        if (call === 1) await Bun.sleep(60); // slow first call: abortable window
        if (signal.aborted) return;
        yield { type: "finish", reason: "stop" };
      },
    };
    const session = createSession({ provider });

    const first = session.send("first", { prompt: { name: "ask-moh", text: "skill body" } });
    await Bun.sleep(10); // mid-stream
    session.abort();
    expect((await first).status).toBe("cancelled");

    await session.send("follow-up"); // fresh turn, same session
    expect(systems[0]).toContain("skill body"); // it was there during the aborted turn
    expect(systems[1]).not.toContain("skill body"); // gone after the turn settled
  });

  test("an empty skill body renders no skills section override (index stays)", async () => {
    const { systems, provider } = captureProvider();
    const session = createSession({ provider });

    await session.send("empty body", { prompt: { name: "ask-moh", text: "   " } });

    expect(systems[0]).not.toContain('Follow the "ask-moh" skill');
  });
});

describe("skill prompt seam — steering (ADR-0011 gap)", () => {
  test("a skill send that steers an active turn keeps its prompt for the new turn", async () => {
    const systems: string[] = [];
    let call = 0;
    const provider: Provider = {
      name: "slow",
      async *stream(messages: Message[], signal: AbortSignal): AsyncIterable<StreamEvent> {
        call += 1;
        systems.push(String(messages[0]?.parts[0]?.kind === "text" ? (messages[0].parts[0] as { text: string }).text : ""));
        yield { type: "model_call_start", model: "s" };
        if (call === 1) await Bun.sleep(80); // slow first turn: steering window
        if (signal.aborted) return;
        yield { type: "finish", reason: "stop" };
      },
    };
    const session = createSession({ provider });

    const first = session.send("first turn");
    await Bun.sleep(10); // mid-stream
    const second = session.send("steered skill turn", { prompt: { name: "ask-moh", text: "STEERED-SKILL-BODY" } });
    expect((await first).status).toBe("cancelled");
    expect((await second).status).toBe("done");

    // Turn 1 had no skill; the steering turn MUST carry the skill body.
    expect(systems[0]).not.toContain("STEERED-SKILL-BODY");
    expect(systems[1]).toContain("STEERED-SKILL-BODY");
    expect(systems[1]).toContain('Follow the "ask-moh" skill');
  });
});
