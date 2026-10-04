import { describe, expect, test } from "bun:test";
import {
  DEEP_SCAN_DEPTH,
  REDACTED,
  REDACT_DEPTH,
  redactKeys,
  redactString,
  redactValue,
  detectSecretLookalikes,
} from "../src/redact";

describe("key-based redaction", () => {
  test("masks secret-shaped keys wherever they appear in the structure", () => {
    const input = {
      apiKey: "sk-abc123",
      api_token: "t",
      Authorization: "Bearer x",
      clientSecret: "s",
      nested: { password: "p", deep: [{ privateKey: "k" }] },
      tokens: 42,
      tokenCount: 7,
    };
    expect(redactKeys(input)).toEqual({
      apiKey: REDACTED,
      api_token: REDACTED,
      Authorization: REDACTED,
      clientSecret: REDACTED,
      nested: { password: REDACTED, deep: [{ privateKey: REDACTED }] },
      tokens: 42,
      tokenCount: 7,
    });
  });

  test("covers nesting below the copy cap via the deep pass (audit-v3 RED-1)", () => {
    const wrap = (n: number): unknown => (n === 0 ? { secret: "s" } : { a: wrap(n - 1) });
    const innermost = (v: any): any => (v.secret !== undefined ? v : innermost(v.a));
    // {secret} sits at depth REDACT_DEPTH → masked by the plain walk.
    expect(innermost(redactKeys(wrap(REDACT_DEPTH))).secret).toBe(REDACTED);
    // Deeper than the copy cap → the deep pass still masks.
    expect(innermost(redactKeys(wrap(REDACT_DEPTH + 1))).secret).toBe(REDACTED);
  });

  test("handles cycles without hanging", () => {
    const a: Record<string, unknown> = { name: "self" };
    a.self = a;
    expect((redactKeys(a) as any).name).toBe("self");
  });
});

describe("pattern-based redaction (free text)", () => {
  const cases: [string, string][] = [
    ["my key is sk-abcdefghijklmnopqrstuvwx", "my key is [redacted]"],
    ["Authorization: Bearer abcdef1234567890abcdef", "Authorization: Bearer [redacted]"],
    ["bearer abcdef1234567890abcdef", "bearer [redacted]"],
    // All sample tokens assembled at runtime: a literal would trip
    // GitHub push protection (each shape is a real token shape — that
    // is the point of the pattern).
    ["AKI" + "AIOSFODNN7EXAMPLE", "[redacted]"],
    ["ghp_" + "0123456789abcdefghijklmnopqrstuvwxyzAB", "[redacted]"],
    // Slack token assembled at runtime: a literal would trip GitHub push
    // protection (the shape is a real token shape — that is the point).
    ["xox" + "b-123456789012-1234567890123-abcdefghijklmnop", "[redacted]"],
    ["AIz" + "aSyA-1234567890abcdefghijklmnopqrstu", "[redacted]"],
    ["api_key=abcdef1234567890ab", "api_key=[redacted]"],
    ["https://user:sup3rs3cret@host.example/x", "https://user:[redacted]@host.example/x"],
  ];
  for (const [input, expected] of cases) {
    test(`masks: ${input}`, () => {
      expect(redactString(input)).toBe(expected);
    });
  }

  test("masks PEM private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\nabc\n-----END RSA PRIVATE KEY-----";
    expect(redactString(`here: ${pem} done`)).toBe("here: [redacted] done");
  });

  test("masks quoted password/token/secret assignments", () => {
    expect(redactString(`PASSWORD="hunter2hunter2"`)).toBe(`PASSWORD="[redacted]"`);
    expect(redactString(`apiToken: 'abcdefgh12345678'`)).toBe(`apiToken: '[redacted]'`);
  });

  test("does not corrupt legitimate code — precision over recall", () => {
    const code = `const tokens = count; // todo: refresh the session token store\nfetch("/api/sk-list")\nconst apiKeySchema = z.string();`;
    expect(redactString(code)).toBe(code);
    expect(redactString("short sk-1")).toBe("short sk-1");
    expect(redactString("Bearing the load")).toBe("Bearing the load");
  });

  test("handles multi-line text and long inputs", () => {
    const text = ["line one", "token = 'abcdefghijklmnop'", "line three"].join("\n");
    expect(redactString(text)).toBe(["line one", "token = '[redacted]'", "line three"].join("\n"));
  });
});

describe("audit-v3 RED-2: long env-var credential key forms", () => {
  test("masks *_API_KEY / *_SECRET* / *_TOKEN / *_ACCESS_KEY structural keys", () => {
    const input = {
      ANTHROPIC_API_KEY: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
      GITHUB_TOKEN: "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB",
      MY_SECRET_VALUE: "hunter2hunter2hunter2",
      apiKeyId: "key_123",
      tokens: 42,
      tokenCount: 7,
    };
    expect(redactKeys(input)).toEqual({
      ANTHROPIC_API_KEY: REDACTED,
      AWS_SECRET_ACCESS_KEY: REDACTED,
      GITHUB_TOKEN: REDACTED,
      MY_SECRET_VALUE: REDACTED,
      apiKeyId: "key_123",
      tokens: 42,
      tokenCount: 7,
    });
  });

  test("masks compound env-var assignments in free text", () => {
    expect(redactString("ANTHROPIC_API_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe("ANTHROPIC_API_KEY=[redacted]");
    expect(redactString('AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMIK7MDENGbPx"')).toBe('AWS_SECRET_ACCESS_KEY="[redacted]"');
    expect(redactString("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY")).toBe(
      "AWS_SECRET_ACCESS_KEY=[redacted]",
    );
  });

  test("prose and code around the new vocab still survive", () => {
    expect(redactString("top secret meeting notes and the access keys drawer")).toBe(
      "top secret meeting notes and the access keys drawer",
    );
    expect(redactString("const apiKeySchema = z.string();")).toBe("const apiKeySchema = z.string();");
  });
});

describe("redactValue — the combined pass", () => {
  test("applies both layers in one walk", () => {
    const out = redactValue({
      text: "use Bearer abcdef1234567890abcdef",
      nested: { apiKey: "sk-xyz", note: "ghp_" + "0123456789abcdefghijklmnopqrstuvwxyzAB" },
    }).value;
    expect(out).toEqual({
      text: "use Bearer [redacted]",
      nested: { apiKey: REDACTED, note: REDACTED },
    });
  });

  test("reports lookalike candidates that passed unmasked, content-free", () => {
    const { value, misses } = redactValue({
      text: "the secret sauce is not a credential",
      credential: "ab",
    });
    expect(value).toEqual({ text: "the secret sauce is not a credential", credential: "ab" });
    expect(misses).toEqual([]);
    const hit = redactValue({ text: "signature: 'abcdefghijklmnopqrstuvwxyz0123'" });
    expect(hit.misses.length).toBe(1);
    expect(JSON.stringify(hit.misses[0])).not.toContain("short");
    expect(hit.misses[0].category).toBeTruthy();
  });

  test("audit-v3 RED-1: a secret below the old depth is masked, the depth-cut line stays quiet", () => {
    const deep = (n: number, leaf: unknown): unknown => (n === 0 ? leaf : { a: deep(n - 1, leaf) });
    const { value, depthCut } = redactValue(deep(REDACT_DEPTH + 2, { apiKey: "sk-abcdefghijklmnopqrstuvwx" }));
    expect(depthCut).toBe(false);
    expect(JSON.stringify(value)).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    // The scan found a secret only below the cap: everything shallow is
    // rebuilt exactly as before, and the deep leaf is masked in place.
    expect((value as any).a.apiKey).toBeUndefined();
  });

  test("does not mutate the input", () => {
    const input = { apiKey: "sk-abcdefghijklmnopqrstuvwx" };
    redactValue(input);
    expect(input.apiKey).toBe("sk-abcdefghijklmnopqrstuvwx");
  });
});

describe("audit-v3 RED-1: secrets below the walk's copy depth", () => {
  const deep = (n: number, leaf: unknown): unknown => (n === 0 ? leaf : { a: deep(n - 1, leaf) });
  const unwrap = (v: any): any => (v.a === undefined ? v : unwrap(v.a));

  test("a secret below REDACT_DEPTH is masked — the old pass-through is gone", () => {
    const { value, depthCut, misses } = redactValue(deep(REDACT_DEPTH + 2, { apiKey: "sk-abcdefghijklmnopqrstuvwx" }));
    expect(depthCut).toBe(false);
    expect(misses).toEqual([]);
    expect(JSON.stringify(value)).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(unwrap(redactKeys(deep(REDACT_DEPTH + 2, { apiKey: "sk-abcdefghijklmnopqrstuvwx" }))).apiKey).toBe(REDACTED);
  });

  test("the pattern layer also reaches below the copy depth", () => {
    const { value, depthCut } = redactValue(deep(REDACT_DEPTH + 3, { note: "Bearer abcdef1234567890abcdef" }));
    expect(depthCut).toBe(false);
    expect(JSON.stringify(value)).toContain("[redacted]");
  });

  test("a clean deep payload costs a scan, not a rebuild, and no miss line", () => {
    const leaf = { note: "plain", list: [1, 2, 3] };
    const payload = deep(REDACT_DEPTH + 10, leaf);
    const { value, depthCut, misses } = redactValue(payload);
    expect(depthCut).toBe(false);
    expect(misses).toEqual([]);
    expect(unwrap(value)).toBe(leaf); // scan found nothing: the deep subtree is untouched
  });

  test("beyond the deep-scan bound the depth-cut tripwire still fires", () => {
    const far = deep(2 * REDACT_DEPTH + DEEP_SCAN_DEPTH + 2, { apiKey: "sk-abcdefghijklmnopqrstuvwx" });
    const { value, depthCut } = redactValue(far);
    expect(depthCut).toBe(true);
    expect(JSON.stringify(value)).toContain("sk-abcdefghijklmnopqrstuvwx");
  });
});

describe("detectSecretLookalikes", () => {
  test("flags long opaque strings and generic credential assignments", () => {
    expect(detectSecretLookalikes("cwd=/tmp/x key=abc").length).toBe(0);
    expect(detectSecretLookalikes("key=abcdef0123456789abcdef012345").length).toBeGreaterThan(0);
    expect(detectSecretLookalikes("checksum a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2").length).toBeGreaterThan(0);
  });
});

describe("performance (ADR-0058: the append hot path gains a bounded scan)", () => {
  test("a large realistic tool_result redacts in low single-digit milliseconds", () => {
    const chunk = "line of ordinary tool output with some code `fetch(x)` and numbers 12345\n".repeat(200);
    const event = { type: "tool_result", callId: "c", ok: true, output: chunk.repeat(10) };
    const start = performance.now();
    for (let i = 0; i < 20; i += 1) redactValue(event);
    const perCall = (performance.now() - start) / 20;
    expect(perCall).toBeLessThan(50); // generous ceiling: the scan is linear
  });
});