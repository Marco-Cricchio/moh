import { expect, test } from "bun:test";
import { checkScope } from "../src/check-scope";

test("shared authorization keeps scope families distinct in mixed grants", () => {
  const scopes = ["path:**", "host:api.example.com", "credential:token", "tool:read", "endpoint:main"];
  for (const [kind, ref] of [["credential", "token"], ["tool", "read"], ["endpoint", "main"]] as const) {
    expect(checkScope({ kind, ref }, scopes)).toEqual({ ok: true });
    expect(checkScope({ kind, ref: "missing" }, scopes)).toEqual({ ok: false, reason: "outside_scope" });
  }
  // Prefixes of the same length must not authorize another family.
  expect(checkScope({ kind: "tool", ref: "api.example.com" }, scopes).ok).toBe(false);
  expect(checkScope({ kind: "endpoint", ref: "secret" }, ["garbage::secret"]).ok).toBe(false);
  expect(checkScope({ kind: "host", url: new URL("https://api.example.com"), isDenied: () => false }, scopes).ok).toBe(true);
  expect(checkScope({ kind: "host", url: new URL("https://api.example.com"), isDenied: () => true }, scopes)).toMatchObject({ ok: false, reason: "denied" });
});
