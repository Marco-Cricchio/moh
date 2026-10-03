/**
 * #1110: the runtime-failure failover — the `onModelError` wiring. When a
 * model the router chose fails with a non-Route error, Jev proposes the
 * next candidate of the same tier (up to four per turn), excludes what
 * failed (endpoint-wide for endpoint-level kinds), and steps back
 * visibly when nothing viable remains. Fake context, fake fetch: no
 * network.
 */
import { describe, expect, test } from "bun:test";
import { createJevGuardExtension } from "../src/index";
import type { RoutingModel } from "../src/routing";
import type { RoutingPool } from "../src/routing-judge";
import { emitEvent, fakeCtx, runModelError, runTurn, type FakeCtx } from "./extension.test-utils";
import { transportFromFetch } from "../src/client";
const transportOf = (impl: unknown) => transportFromFetch(impl as Parameters<typeof transportFromFetch>[0]);

const pool: RoutingModel[] = [
  { ref: "a/cheap", price: 1 },
  { ref: "a/mid", price: 10 },
  { ref: "a/big", price: 100 },
];

/** The Jev judgment answer the fake client returns for every call. */
function jevAnswer(choice: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        model: "jev-latest",
        answers: { difficulty: { type: "choice", choice, confidence: 0.9 } },
        usage: { input_tokens: 400, output_tokens: 30 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

/** The wiring options: routing on, the given pool, the given tier labels. */
function options(pool: RoutingPool, labels?: Record<string, string>) {
  return {
        transport: transportOf(jevAnswer("potente")),
    routing: { pool: async () => pool, ...(labels ? { labels } : {}) },
    enabled: true,
    classification: false,
  };
}

/** Sets up the extension (hooks registered, session started). */
async function setup(pool: RoutingPool, labels?: Record<string, string>): Promise<FakeCtx> {
  const ctx = fakeCtx();
  await createJevGuardExtension(options(pool, labels)).setup(ctx);
  ctx.sessionStartHooks.forEach((h) => h());
  return ctx;
}

/** Arms a routing switch honestly: two confident judged turns + its chrome. */
async function routeTo(ctx: FakeCtx, from: string, to: string): Promise<void> {
  await runTurn(ctx, "design a module", 1);
  await runTurn(ctx, "still designing", 2);
  emitEvent(ctx, { type: "model_switched", from, to });
}

const TWO_MEMBER_POOL: RoutingPool = {
  models: [
    { ref: "a/cheap", price: 1 },
    { ref: "a/mid", price: 10 },
    { ref: "a/big", price: 100 },
    { ref: "b/big", price: 100 },
    { ref: "c/big", price: 100 },
    { ref: "d/big", price: 100 },
  ],
};
const POTENTE_FOUR = { "a/big": "potente", "b/big": "potente", "c/big": "potente", "d/big": "potente" };

describe("jev model-error retry wiring (#1110)", () => {
  test("a router-armed model that fails proposes the tier's next member, counts, publishes the footer", async () => {
    const ctx = await setup(TWO_MEMBER_POOL, POTENTE_FOUR);
    await routeTo(ctx, "a/cheap", "a/big");

    const out = await runModelError(ctx, { model: "a/big", errorKind: "invalid_request" });
    expect(out).toEqual({ model: "b/big" });
    expect(ctx.statuses.at(-1)).toBe("routing: tentativo 1/4…");
    const retry = ctx.events.filter((e) => e.name === "jev_routing" && (e.payload as { kind?: string }).kind === "model-retry");
    expect(retry).toHaveLength(1);
    expect(retry[0]!.payload).toMatchObject({ attempt: 1, failed: "a/big", errorKind: "invalid_request", next: "b/big" });
  });

  test("an endpoint-level error excludes the endpoint's other models too", async () => {
    const labeled: RoutingPool = {
      models: [
        { ref: "a/cheap", price: 1 },
        { ref: "a/mid", price: 10 },
        { ref: "a/big", price: 100 },
        { ref: "a/big-2", price: 100 },
        { ref: "b/big", price: 100 },
      ],
    };
    const ctx = await setup(labeled, { "a/big": "potente", "a/big-2": "potente", "b/big": "potente" });
    await routeTo(ctx, "a/cheap", "a/big");

    // auth on a/big: the whole endpoint a is excluded — a/big-2 is skipped,
    // b/big (a healthy endpoint) wins.
    const out = await runModelError(ctx, { model: "a/big", errorKind: "auth" });
    expect(out).toEqual({ model: "b/big" });
  });

  test("retries stop after four attempts; the step-back is visible, once, and clears the footer", async () => {
    const ctx = await setup(TWO_MEMBER_POOL, POTENTE_FOUR);
    await routeTo(ctx, "a/cheap", "a/big");

    expect(await runModelError(ctx, { model: "a/big", errorKind: "invalid_request" })).toEqual({ model: "b/big" });
    emitEvent(ctx, { type: "model_switched", from: "a/big", to: "b/big" });
    expect(await runModelError(ctx, { model: "b/big", errorKind: "invalid_request" })).toEqual({ model: "c/big" });
    emitEvent(ctx, { type: "model_switched", from: "b/big", to: "c/big" });
    expect(await runModelError(ctx, { model: "c/big", errorKind: "invalid_request" })).toEqual({ model: "d/big" });
    emitEvent(ctx, { type: "model_switched", from: "c/big", to: "d/big" });
    // The last same-tier candidate is a/mid (labeled members first, then
    // the tier's price-heuristic members — same tier, still ranked).
    expect(await runModelError(ctx, { model: "d/big", errorKind: "invalid_request" })).toEqual({ model: "a/mid" });
    emitEvent(ctx, { type: "model_switched", from: "d/big", to: "a/mid" });
    // The budget of 4 is spent: the fifth consultation returns nothing,
    // and no exhausted record exists — the budget itself ended the wave.
    expect(await runModelError(ctx, { model: "a/mid", errorKind: "invalid_request" })).toBeUndefined();
    const exhausted = ctx.events.filter((e) => e.name === "jev_routing" && (e.payload as { kind?: string }).kind === "model-retry-exhausted");
    expect(exhausted).toHaveLength(0);
    expect(ctx.statuses.at(-1)).toBe("routing: tentativo 4/4…");
  });

  test("the budget resets at the next turn; exclusions survive it", async () => {
    // A tier of exactly two: the failed model plus one fallback.
    const duo: RoutingPool = {
      models: [
        { ref: "a/cheap", price: 1 },
        { ref: "a/mid", price: 10 },
        { ref: "a/big", price: 100 },
        { ref: "b/big", price: 100 },
      ],
    };
    const ctx = await setup(duo, { "a/big": "potente", "b/big": "potente", "a/mid": "economico" });
    await routeTo(ctx, "a/cheap", "a/big");

    expect(await runModelError(ctx, { model: "a/big", errorKind: "invalid_request" })).toEqual({ model: "b/big" });
    for (const h of ctx.afterTurnHooks) await h();
    // The retry's own switch lands (the router's, not an override).
    emitEvent(ctx, { type: "model_switched", from: "a/big", to: "b/big" });
    // Next turn: b/big is router-chosen and still inside its backoff —
    // no viable candidate, a *fresh* turn with its own step-back record.
    expect(await runModelError(ctx, { model: "b/big", errorKind: "invalid_request" })).toBeUndefined();
    const exhausted = ctx.events.filter((e) => e.name === "jev_routing" && (e.payload as { kind?: string }).kind === "model-retry-exhausted");
    expect(exhausted).toHaveLength(1);
  });

  test("a context-fit refusal excludes the refused target for the next attempt", async () => {
    const ctx = await setup(TWO_MEMBER_POOL, POTENTE_FOUR);
    await routeTo(ctx, "a/cheap", "a/big");

    expect(await runModelError(ctx, { model: "a/big", errorKind: "context_length" })).toEqual({ model: "b/big" });
    // The core refused the proposal on context fit (its own switch_refused
    // chrome is the visible record); the target must not come back this turn.
    emitEvent(ctx, { type: "switch_refused", from: "a/big", to: "b/big", reason: "context_length" });
    expect(await runModelError(ctx, { model: "a/big", errorKind: "context_length" })).toEqual({ model: "c/big" });
  });

  test("the retry's own switches are the router's, not the user taking the wheel", async () => {
    const ctx = await setup(TWO_MEMBER_POOL, POTENTE_FOUR);
    await routeTo(ctx, "a/cheap", "a/big");

    expect(await runModelError(ctx, { model: "a/big", errorKind: "invalid_request" })).toEqual({ model: "b/big" });
    emitEvent(ctx, { type: "model_switched", from: "a/big", to: "b/big" });
    const overrides = ctx.events.filter((e) => e.name === "jev_routing" && (e.payload as { kind?: string }).kind === "override");
    expect(overrides).toHaveLength(0);
  });

  test("a single-member tier has no candidate: one visible step-back", async () => {
    const ctx = await setup({ models: pool }, { "a/big": "potente" });
    await routeTo(ctx, "a/cheap", "a/big");

    const out = await runModelError(ctx, { model: "a/big", errorKind: "content_filtered" });
    expect(out).toBeUndefined();
    const events = ctx.events.filter((e) => e.name === "jev_routing");
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ kind: "model-retry-exhausted", failed: "a/big", errorKind: "content_filtered" });
  });

  test("a manual pick is never retried: the seam stays silent", async () => {
    const ctx = await setup({ models: pool });
    emitEvent(ctx, { type: "model_switched", from: "a/cheap", to: "a/handpicked" });
    const out = await runModelError(ctx, { model: "a/handpicked", errorKind: "auth" });
    expect(out).toBeUndefined();
    // The only record is the override notice itself — never a retry.
    const kinds = ctx.events
      .filter((e) => e.name === "jev_routing")
      .map((e) => (e.payload as { kind: string }).kind);
    expect(kinds).toEqual(["override"]);
  });

  test("routing off (paused): the seam stays silent", async () => {
    const ctx = fakeCtx();
    await createJevGuardExtension({
      transport: transportOf(jevAnswer("potente")),
      routing: { pool: async () => ({ models: pool }) },
      // config off → the router starts paused
      classification: false,
    }).setup(ctx);
    ctx.sessionStartHooks.forEach((h) => h());
    await runTurn(ctx, "design a module", 1);
    const out = await runModelError(ctx, { model: "a/cheap", errorKind: "auth" });
    expect(out).toBeUndefined();
    expect(ctx.events.filter((e) => e.name === "jev_routing")).toHaveLength(0);
  });
});
