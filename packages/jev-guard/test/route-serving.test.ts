/**
 * #945: the announced switch and the model actually serving are reconciled
 * at the moment the core records the divergence — the `route_serving`
 * event — not lazily at the next judged turn. A session that serves a
 * fallback right after a router switch (a one-turn subagent, for one) gets
 * a visible line then, and the router's expectation is released so it is
 * not frozen for the rest of the session.
 *
 * Feedback loop: red before the `route_serving` handler exists, green
 * after.
 */
import { describe, expect, test } from "bun:test";
import { createJevGuardExtension } from "../src/index";
import { fakeCtx, runTurn, routingJudgments } from "./extension.test-utils";

describe("#945: route_serving reconciles the announced switch with the serving model", () => {
  const pool = {
    models: [
      { ref: "a/cheap", price: 1 },
      { ref: "a/mid", price: 10 },
      { ref: "a/big", price: 100 },
    ],
  };
  const answers = (choice: string, confidence: number) => ({
    difficulty: { type: "choice", choice, probabilities: { [choice]: confidence }, confidence },
    needs_context: { type: "noul", noul: 0 },
  });
  const fetchOk = (body: Record<string, unknown>) =>
    (async () =>
      new Response(JSON.stringify({ model: "jev-latest", answers: body, usage: {} }), { status: 200 })) as unknown as typeof fetch;
  const setup = async (ctx: ReturnType<typeof fakeCtx>) => {
    await createJevGuardExtension({
      apiKey: "sk-test",
      fetchImpl: fetchOk(answers("potente", 0.9)),
      routing: { pool: async () => pool },
      enabled: true,
      classification: false,
    }).setup(ctx);
  };

  test("a fallback serving after a decided switch is noticed immediately, and the expectation is released", async () => {
    const ctx = fakeCtx();
    await setup(ctx);
    const emit = (event: { type: string } & Record<string, unknown>) => ctx.eventHooks.forEach((h) => h({ event }));

    // Two turns: the router decides to switch to a/big.
    await runTurn(ctx, "design", 1);
    await runTurn(ctx, "design more", 2);
    const decisions = ctx.events.filter((e) => e.name === "jev_judgment");
    expect(decisions.at(-1)!.payload).toMatchObject({ useCase: "routing", decision: "switch", target: "a/big" });

    // The switch could not be served: the core fell back and appends the
    // record that already knows both sides. A one-turn subagent ends here.
    emit({ type: "route_serving", selected: "a/big", serving: "a/cheap", previous: "a/cheap" });

    // One visible notice, at that moment, naming both sides.
    const notices = ctx.events.filter((e) => (e.payload as { kind?: string } | undefined)?.kind === "fallback");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.payload).toMatchObject({ serving: "a/cheap", expected: "a/big" });

    // The expectation is released: a later turn on the serving model is
    // judged again (no suspended-by-mismatch silence) and can re-route.
    await runTurn(ctx, "design again", 3, "a/cheap");
    expect(routingJudgments(ctx)).toHaveLength(3);
  });

  test("a coherent route_serving (serving the selected model) is silent", async () => {
    const ctx = fakeCtx();
    await setup(ctx);
    const emit = (event: { type: string } & Record<string, unknown>) => ctx.eventHooks.forEach((h) => h({ event }));

    await runTurn(ctx, "design", 1);
    await runTurn(ctx, "design more", 2);
    emit({ type: "route_serving", selected: "a/big", serving: "a/big", previous: "a/cheap" });
    expect(ctx.events.some((e) => (e.payload as { kind?: string } | undefined)?.kind === "fallback")).toBe(false);
  });

  test("no decided switch: a route_serving mismatch fires nothing", async () => {
    const ctx = fakeCtx();
    await setup(ctx);
    const emit = (event: { type: string } & Record<string, unknown>) => ctx.eventHooks.forEach((h) => h({ event }));

    emit({ type: "route_serving", selected: "a/cheap", serving: "a/big", previous: "a/cheap" });
    expect(ctx.events.some((e) => (e.payload as { kind?: string } | undefined)?.kind === "fallback")).toBe(false);
  });
});
