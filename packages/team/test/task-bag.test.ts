/**
 * The task bag (#1223, ADR-0074): plan → claim → complete as chrome events,
 * replay from the log alone, blocked-by gating at claim time, and the
 * self-serve loop end to end through the `team` tool.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExtensionRuntime,
  MockProvider,
  createSession,
  type AgentEvent,
  type ExtensionConsentRequest,
} from "@moh/core";
import { createTeamExtension, TEAM_NAME, teamManifestAuthority } from "../src/index";
import { replayBoard, TASK_CLAIMED, TASK_COMPLETED, TASK_CREATED, TaskBag } from "../src/task-bag";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "moh-team-bag-"));
}

function tap(session: { events: AsyncIterable<AgentEvent> }): AgentEvent[] {
  const events: AgentEvent[] = [];
  void (async () => {
    for await (const event of session.events) events.push(event);
  })();
  return events;
}

describe("task bag unit (#1223)", () => {
  test("claim returns the next open task whose blockers are all done, in plan order", () => {
    const bag = new TaskBag();
    bag.create([
      { title: "a" },
      { title: "b", blockedBy: ["t1"] },
      { title: "c", blockedBy: ["t1", "t2"] },
    ]);
    expect(bag.claimable()?.id).toBe("t1");
    bag.claim("t1", "builder");
    expect(bag.claimable()).toBeNull();
    bag.complete("t1", "done");
    expect(bag.claimable()?.id).toBe("t2");
  });

  test("a non-done completion releases the claim back to open", () => {
    const bag = new TaskBag();
    bag.create([{ title: "a" }]);
    bag.claim("t1", "builder");
    bag.complete("t1", "error");
    const task = bag.tasks.get("t1")!;
    expect(task.status).toBe("open");
    expect(task.claimedBy).toBeNull();
  });

  test("a dangling blockedBy ref refuses the whole plan", () => {
    const bag = new TaskBag();
    expect(() => bag.create([{ title: "a" }, { title: "b", blockedBy: ["t9"] }])).toThrow("t9");
    expect(bag.tasks.size).toBe(0);
  });

  test("the board reconstructs from the log events alone", () => {
    const board = replayBoard([
      { type: "session_start" },
      { type: "extension_event", name: TASK_CREATED, payload: { id: "t1", title: "a" } },
      { type: "extension_event", name: TASK_CREATED, payload: { id: "t2", title: "b", blockedBy: ["t1"] } },
      { type: "extension_event", name: TASK_CLAIMED, payload: { id: "t1", member: "builder" } },
      { type: "extension_event", name: TASK_COMPLETED, payload: { id: "t1", member: "builder", outcome: "done" } },
      { type: "extension_event", name: TASK_CLAIMED, payload: { id: "t2", member: "builder" } },
      { type: "extension_event", name: TASK_COMPLETED, payload: { id: "t2", member: "builder", outcome: "error" } },
    ] as never);
    expect(board).toHaveLength(2);
    expect(board[0]).toMatchObject({ id: "t1", status: "done", claimedBy: "builder" });
    // The failed completion released the claim — a reopened session sees it.
    expect(board[1]).toMatchObject({ id: "t2", status: "open", blockedBy: ["t1"], claimedBy: null });
  });
});

describe("task bag through the team tool (#1223)", () => {
  async function bagSession(
    leadScript: Parameters<typeof MockProvider.scripted>[0],
    childScript: Parameters<typeof MockProvider.scripted>[0],
  ) {
    const rt = new ExtensionRuntime({ mohHome: tempDir(), consent: (_: ExtensionConsentRequest) => true });
    await rt.register(createTeamExtension(), { manifest: teamManifestAuthority() });
    const session = createSession({
      provider: MockProvider.scripted(leadScript),
      extensions: rt,
      subagents: { home: tempDir(), provider: MockProvider.scripted(childScript) },
      permissions: { unrestrictedTools: true },
    });
    const events = tap(session);
    const turn = await session.send("run the team");
    await session.dispose();
    return { events, turn };
  }

  const planCall = {
    deltas: ["planning"],
    finish: "tool_calls" as const,
    toolCalls: [
      {
        name: "team",
        args: {
          plan: [
            { title: "rename the export" },
            { title: "update the manual", blockedBy: ["t1"] },
          ],
        },
      },
    ],
  };
  const workCall = {
    deltas: ["working the bag"],
    finish: "tool_calls" as const,
    toolCalls: [{ name: "team", args: { work: "do the named task well" } }],
  };

  test("plan creates the bag as chrome events; work runs the member through every claimable task unprompted", async () => {
    const { events, turn } = await bagSession(
      [planCall, workCall, { deltas: ["reported"], finish: "stop" }],
      [
        { deltas: ["first task answer"], finish: "stop" },
        { deltas: ["second task answer"], finish: "stop" },
      ],
    );

    expect(turn.status).toBe("done");
    const created = events.filter((e) => e.type === "extension_event" && (e as { name?: string }).name === TASK_CREATED);
    expect(created).toHaveLength(2);
    expect((created[1] as { payload?: { blockedBy?: string[] } }).payload?.blockedBy).toEqual(["t1"]);

    // Two claim/complete pairs, one per task, in dependency order.
    const claimed = events.filter((e) => e.type === "extension_event" && (e as { name?: string }).name === TASK_CLAIMED);
    const completed = events.filter((e) => e.type === "extension_event" && (e as { name?: string }).name === TASK_COMPLETED);
    expect(claimed.map((e) => (e as { payload?: { id?: string } }).payload?.id)).toEqual(["t1", "t2"]);
    expect(completed.map((e) => (e as { payload?: { outcome?: string } }).payload?.outcome)).toEqual(["done", "done"]);

    // The board reconstructs from these events alone.
    const board = replayBoard(events as never);
    expect(board).toHaveLength(2);
    expect(board.every((task) => task.status === "done")).toBe(true);

    // The child ran two turns: one per task, spawned once then steered.
    const spawns = events.filter((e) => e.type === "subagent_spawn");
    expect(spawns).toHaveLength(1);
    const steers = events.filter((e) => e.type === "subagent_steer");
    expect(steers).toHaveLength(1);

    // The result text carries both outcomes back to the lead.
    const toolResult = events.filter((e) => e.type === "tool_result").at(-1) as { output?: string };
    expect(toolResult.output).toContain("2 tasks — 2 done");
    expect(toolResult.output).toContain("second task answer");
  });

  test("blocked-by gates the loop: a failed first task leaves the blocked second unclaimed", async () => {
    const { events } = await bagSession(
      [planCall, workCall, { deltas: ["reported"], finish: "stop" }],
      [{ deltas: ["broken"], finish: "stop", error: { kind: "overloaded", message: "mock failure" } }],
    );

    const claimed = events.filter((e) => e.type === "extension_event" && (e as { name?: string }).name === TASK_CLAIMED);
    expect(claimed.map((e) => (e as { payload?: { id?: string } }).payload?.id)).toEqual(["t1"]);
    const completed = events.filter((e) => e.type === "extension_event" && (e as { name?: string }).name === TASK_COMPLETED);
    expect((completed[0] as { payload?: { outcome?: string } }).payload?.outcome).toBe("error");
    const board = replayBoard(events as never);
    expect(board.find((task) => task.id === "t2")?.status).toBe("open");
  });

  test("work with an empty bag is refused didactically", async () => {
    const { events } = await bagSession(
      [
        {
          deltas: ["working?"],
          finish: "tool_calls",
          toolCalls: [{ name: "team", args: { work: "go" } }],
        },
        { deltas: ["refused"], finish: "stop" },
      ],
      [{ deltas: ["c"], finish: "stop" }],
    );
    const result = events.find((e) => e.type === "tool_result") as { output?: string };
    expect(result.output).toContain("task bag is empty");
    expect(events.some((e) => e.type === "subagent_spawn")).toBe(false);
  });

  test("a plan with a dangling blockedBy ref is refused whole — no task is created", async () => {
    const { events } = await bagSession(
      [
        {
          deltas: ["planning"],
          finish: "tool_calls",
          toolCalls: [
            {
              name: "team",
              args: { plan: [{ title: "a" }, { title: "b", blockedBy: ["t7"] }] },
            },
          ],
        },
        { deltas: ["refused"], finish: "stop" },
      ],
      [{ deltas: ["c"], finish: "stop" }],
    );
    const result = events.find((e) => e.type === "tool_result") as { output?: string };
    expect(result.output).toContain("t7");
    expect(events.some((e) => e.type === "extension_event" && (e as { name?: string }).name === TASK_CREATED)).toBe(false);
  });

  test("star-shaped: the member's prompts name one task each — never the whole bag", async () => {
    const prompts: string[] = [];
    const rt = new ExtensionRuntime({ mohHome: tempDir(), consent: () => true });
    await rt.register(createTeamExtension(), { manifest: teamManifestAuthority() });
    const childProvider = {
      name: "mock",
      async *stream(messages: unknown) {
        const lastUser = (messages as { role: string; parts: { type: string; text?: string }[] }[])
          .filter((m) => m.role === "user")
          .at(-1);
        prompts.push(lastUser?.parts.map((p) => p.text ?? "").join("") ?? "");
        yield { type: "model_call_start", model: "mock" };
        yield { type: "text_delta", text: "task answer" };
        yield { type: "finish", reason: "stop" };
      },
    } as unknown as import("@moh/core").Provider;
    const session = createSession({
      provider: MockProvider.scripted([planCall, workCall, { deltas: ["done"], finish: "stop" }]),
      extensions: rt,
      subagents: { home: tempDir(), provider: childProvider },
      permissions: { unrestrictedTools: true },
    });
    const events = tap(session);
    await session.send("run the team");
    await session.dispose();

    // The child-toolset star (no `team` tool) is #1221's covered claim; here:
    // each prompt is exactly one task — the member sees its work, never the
    // whole bag (the steering write rides the member's kept context, which
    // the child-side message list holds internally).
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Task t1: rename the export");
    expect(prompts[0]).not.toContain("update the manual");
    expect(prompts[1]).toContain("Task t2: update the manual");
    expect(prompts[1]).not.toContain("rename the export");
    void events;
  });

  test("the member name is the lead's choice and steering reaches it by name afterwards", async () => {
    const planWork = {
      deltas: ["go"],
      finish: "tool_calls" as const,
      toolCalls: [
        { name: "team", args: { plan: [{ title: "a" }] } },
        { name: "team", args: { work: "do it", member: "reviewer" } },
      ],
    };
    const { events } = await bagSession(
      [planWork, { deltas: ["reported"], finish: "stop" }],
      [{ deltas: ["answer"], finish: "stop" }],
    );
    const spawn = events.find((e) => e.type === "subagent_spawn") as Extract<AgentEvent, { type: "subagent_spawn" }>;
    expect(spawn?.name).toBe("reviewer");
    void TEAM_NAME;
  });
});
