import { describe, expect, test } from "bun:test";
import {
  MAX_MODEL_RETRY_ATTEMPTS,
  backoffFor,
  canRetry,
  exclusionKeyFor,
  isExcluded,
  newRetryState,
  nextCandidate,
  noteFailure,
  noteRefused,
  startTurn,
} from "../src/model-retry";
import type { TierAssignment } from "../src/routing";
import { assignTiers, type RoutingModel } from "../src/routing";

const pool: RoutingModel[] = [
  { ref: "a/cheap", price: 0.1 },
  { ref: "a/mid", price: 1 },
  { ref: "b/mid", price: 2 },
  { ref: "c/top", price: 10 },
];

const assignment = assignTiers(pool);

describe("model-retry exclusions (#1110)", () => {
  test("endpoint-level kinds exclude the whole endpoint, model-level only the model", () => {
    const state = newRetryState();
    noteFailure(state, "a/mid", "auth", 1_000);
    expect(isExcluded(state, "a/cheap", 1_001)).toBe(true);
    expect(isExcluded(state, "a/mid", 1_001)).toBe(true);
    // Another endpoint is untouched.
    expect(isExcluded(state, "b/mid", 1_001)).toBe(false);

    const other = newRetryState();
    noteFailure(other, "a/mid", "context_length", 1_000);
    expect(isExcluded(other, "a/cheap", 1_001)).toBe(false);
    expect(isExcluded(other, "a/mid", 1_001)).toBe(true);
  });

  test("the key vocabulary: endpoint kinds key the endpoint, others the ref", () => {
    expect(exclusionKeyFor("a/mid", "auth")).toBe("endpoint:a");
    expect(exclusionKeyFor("a/mid", "quota_exhausted")).toBe("endpoint:a");
    expect(exclusionKeyFor("a/mid", "content_filtered")).toBe("endpoint:a");
    expect(exclusionKeyFor("a/mid", "invalid_request")).toBe("model:a/mid");
    expect(exclusionKeyFor("a/mid", "context_length")).toBe("model:a/mid");
  });

  test("endpoint backoff is longer than model backoff, both exponential and capped", () => {
    expect(backoffFor("auth", 1)).toBe(300_000);
    expect(backoffFor("auth", 2)).toBe(600_000);
    expect(backoffFor("invalid_request", 1)).toBe(30_000);
    expect(backoffFor("invalid_request", 2)).toBe(60_000);
    // Cap: never a permanent ban.
    expect(backoffFor("auth", 20)).toBe(30 * 60_000);
  });

  test("exclusions expire — and a re-failure after expiry starts a fresh strike", () => {
    const state = newRetryState();
    noteFailure(state, "a/mid", "invalid_request", 0);
    expect(isExcluded(state, "a/mid", 29_999)).toBe(true);
    expect(isExcluded(state, "a/mid", 30_001)).toBe(false);
    // Expired, then failing again: the strike restarts (no doubling from
    // the dead exclusion).
    noteFailure(state, "a/mid", "invalid_request", 30_002);
    expect(isExcluded(state, "a/mid", 30_002 + 29_999)).toBe(true);
    expect(isExcluded(state, "a/mid", 30_002 + 60_001)).toBe(false);
  });

  test("a live exclusion doubles on repeat failures within the window", () => {
    const state = newRetryState();
    noteFailure(state, "a/mid", "invalid_request", 0);
    noteFailure(state, "a/mid", "invalid_request", 1);
    expect(isExcluded(state, "a/mid", 30_001)).toBe(true);
    expect(isExcluded(state, "a/mid", 60_001)).toBe(false);
  });
});

describe("model-retry candidates (#1110)", () => {
  test("the next candidate is the tier's next member in preference order", () => {
    // pool: economico=[a/cheap], bilanciato=[a/mid, b/mid], potente=[c/top].
    const state = newRetryState();
    expect(nextCandidate(assignment, "a/mid", state, 0)).toBe("b/mid");
  });

  test("excluded candidates are skipped; exhausted tier yields nothing", () => {
    const state = newRetryState();
    noteFailure(state, "b/mid", "invalid_request", 0);
    expect(nextCandidate(assignment, "a/mid", state, 1)).toBeUndefined();
    // After the exclusion expires, the tier is viable again.
    expect(nextCandidate(assignment, "a/mid", state, 999_999)).toBe("b/mid");
  });

  test("a candidate in a route cooldown is skipped (#852 gate)", () => {
    const state = newRetryState();
    expect(nextCandidate(assignment, "a/mid", state, 0, [{ ref: "b/mid", kind: "quota_exhausted" }])).toBeUndefined();
    expect(nextCandidate(assignment, "a/mid", state, 0, [{ ref: "other/x", kind: "quota_exhausted" }])).toBe("b/mid");
  });

  test("a model outside the pool has no candidates", () => {
    expect(nextCandidate(assignment, "other/model", newRetryState(), 0)).toBeUndefined();
  });
});

describe("model-retry budget (#1110)", () => {
  test("four attempts per turn, reset at the next turn", () => {
    const state = newRetryState();
    for (let i = 0; i < MAX_MODEL_RETRY_ATTEMPTS; i += 1) {
      expect(canRetry(state)).toBe(true);
      state.attempts += 1;
    }
    expect(canRetry(state)).toBe(false);
    startTurn(state);
    expect(canRetry(state)).toBe(true);
  });

  test("after a step-back, the next turn is not the exhausted one", () => {
    const state = newRetryState();
    state.exhausted = true;
    startTurn(state);
    expect(state.exhausted).toBe(false);
  });

  test("exclusions survive the turn reset", () => {
    const state = newRetryState();
    noteFailure(state, "a/mid", "auth", 0);
    startTurn(state);
    expect(isExcluded(state, "a/cheap", 1)).toBe(true);
  });

  test("noteRefused excludes only the refused model", () => {
    const state = newRetryState();
    noteRefused(state, "b/mid", 0);
    expect(isExcluded(state, "b/mid", 1)).toBe(true);
    expect(isExcluded(state, "a/mid", 1)).toBe(false);
    expect(isExcluded(state, "a/cheap", 1)).toBe(false);
  });
});
