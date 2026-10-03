import { describe, expect, test } from "bun:test";
import {
  isEndpointScope,
  validateEndpointScope,
  endpointScopesOf,
  checkEndpointScope,
  endpointEffectSentence,
  ENDPOINT_SCOPE_PREFIX,
} from "../src/endpoint-scope";
import { scopeEffectSentence } from "../src/host-scope";

describe("endpoint scope validation (ADR-0068)", () => {
  test("recognizes endpoint: prefixed capabilities", () => {
    expect(isEndpointScope("endpoint:zen")).toBe(true);
    expect(isEndpointScope("path:src/**")).toBe(false);
    expect(isEndpointScope("tool:bash")).toBe(false);
    expect(isEndpointScope("host:api.example.com")).toBe(false);
  });

  test("a valid ref is an endpoint name", () => {
    expect(validateEndpointScope("endpoint:zen")).toEqual({ ok: true, ref: "zen" });
  });

  test("empty, whitespace, NUL and slash refs refuse loudly", () => {
    for (const bad of ["endpoint:", "endpoint:my zen", "endpoint:zen/model", "endpoint:a\nb", "endpoint:\0"]) {
      const check = validateEndpointScope(bad);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.message).toContain(bad);
    }
  });

  test("endpointScopesOf picks endpoint scopes in order", () => {
    expect(endpointScopesOf(["path:src/**", "endpoint:zen", "endpoint:go"])).toEqual(["endpoint:zen", "endpoint:go"]);
  });

  test("per-call check: one ref per grant, exact match", () => {
    const scopes = ["endpoint:zen"];
    expect(checkEndpointScope("zen", scopes)).toEqual({ ok: true });
    expect(checkEndpointScope("go", scopes)).toEqual({ ok: false, reason: "outside_scope" });
    // A model id is not part of the grant — the endpoint name decides.
    expect(checkEndpointScope("zen/model", scopes)).toEqual({ ok: false, reason: "outside_scope" });
    expect(checkEndpointScope("", scopes)).toEqual({ ok: false, reason: "outside_scope" });
  });

  test("the consent sentence states both powers and the bounded override", () => {
    expect(endpointEffectSentence("zen")).toBe(
      "may call and list the models of `zen`; may choose the reasoning level per call, within those supported",
    );
    expect(scopeEffectSentence("endpoint:zen")).toBe(endpointEffectSentence("zen"));
  });

  test("prefix constant", () => {
    expect(ENDPOINT_SCOPE_PREFIX).toBe("endpoint:");
  });
});
