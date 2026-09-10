import { randomBytes } from "node:crypto";

/**
 * #575: ULID identity for session events (format decision 2).
 *
 * A ULID is a 26-character Crockford base32 string: 10 chars of
 * millisecond timestamp + 16 chars (80 bits) of randomness. Lexicographic
 * order equals chronological order, and ids are unique across writers
 * (crypto-seeded random component — no per-writer counters, which collide
 * under the multi-machine divergence the tree legitimizes).
 *
 * Zero external dependencies: the Crockford alphabet excludes I, L, O, U.
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const RANDOM_MASK = (1n << 80n) - 1n;


/** Strict ULID shape: 26 Crockford-base32 characters, first char ≤ 7. */
export const ULID_RE = /^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/;

/** True when `ref` is a well-formed ULID (as opposed to a `line:N` ref). */
export function isUlid(ref: string): boolean {
  return ULID_RE.test(ref);
}

/** 80-bit random component, seeded from crypto (never zero) so two
 * writers minting in the same millisecond (#400 divergence) cannot
 * collide — identity must not depend on the writer (format d2). */
function randomSeed(): bigint {
  const bytes = randomBytes(10);
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

/**
 * Generates a ULID. Monotonic within the process: two ids generated in
 * the same millisecond (or after a clock step backwards) still sort in
 * generation order — the crypto-seeded random suffix is incremented,
 * mirroring the `newSessionId()` stamp discipline. Cross-process
 * uniqueness comes from the 80 random bits, not from any per-writer
 * counter (format decision 2).
 */
export function newUlid(now: Date = new Date()): string {
  let ms = now.getTime();
  if (ms <= lastMs) ms = lastMs;
  lastMs = ms;
  if (ms !== lastEncodedMs) {
    lastEncodedMs = ms;
    lastRandom = randomSeed();
  } else {
    // Same-millisecond bump: increment the random part so ids stay
    // monotonic and unique. A 80-bit space makes a collision between two
    // writers' seeds (plus increments) negligible.
    lastRandom = (lastRandom + 1n) & RANDOM_MASK;
  }
  return encodeTime(ms) + encodeRandom(lastRandom);
}

let lastMs = -1;
let lastEncodedMs = -1;
let lastRandom = 0n;

function encodeTime(ms: number): string {
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i -= 1) {
    out = ENCODING[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

function encodeRandom(rand: bigint): string {
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    out = ENCODING[Number(rand % 32n)] + out;
    rand /= 32n;
  }
  return out;
}
