/**
 * ADR-0067: the `tool:<name|*>` and `contribute-tool:<name>` scopes —
 * pure-module tests for validation, whole-tool grants, effect sentences
 * and the known-slot registry.
 */
import { describe, expect, test } from "bun:test";
import {
  isToolScope,
  validateToolScope,
  toolScopeName,
  toolScopesOf,
  checkToolScope,
  toolEffectSentence,
  TOOL_SCOPE_WILDCARD,
  isContributeToolScope,
  validateContributeToolScope,
  contributeToolName,
  contributeToolScopesOf,
  contributesTool,
  contributeToolEffectSentence,
  TOOL_SCOPE_PREFIX,
  CONTRIBUTE_TOOL_SCOPE_PREFIX,
} from "../src/tool-scope";
import { scopeEffectSentence } from "../src/scope-effect";
import { isKnownCapability } from "../src/extension-registry";

describe("tool scope validation", () => {
  test("a named scope is valid with its name", () => {
    const check = validateToolScope("tool:bash");
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.name).toBe("bash");
      expect(check.wildcard).toBe(false);
    }
  });

  test("the wildcard scope is valid and marked", () => {
    const check = validateToolScope("tool:*");
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.wildcard).toBe(true);
  });

  test("empty, whitespace and NUL names are malformed", () => {
    expect(validateToolScope("tool:").ok).toBe(false);
    expect(validateToolScope("tool:my tool").ok).toBe(false);
    expect(validateToolScope("tool:a\0b").ok).toBe(false);
  });

  test("toolScopesOf filters in order", () => {
    expect(toolScopesOf(["observe", "tool:bash", "tool:read"])).toEqual(["tool:bash", "tool:read"]);
    expect(toolScopesOf(["observe"])).toEqual([]);
  });

  test("accessors and predicates", () => {
    expect(isToolScope("tool:bash")).toBe(true);
    expect(isToolScope("toolkit")).toBe(false);
    expect(toolScopeName("tool:read")).toBe("read");
    expect(TOOL_SCOPE_PREFIX).toBe("tool:");
    expect(TOOL_SCOPE_WILDCARD).toBe("*");
  });
});

describe("contribute-tool scope validation", () => {
  test("a named contribution is valid with its name", () => {
    const check = validateContributeToolScope("contribute-tool:search");
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.name).toBe("search");
  });

  test("empty names and the wildcard are malformed", () => {
    expect(validateContributeToolScope("contribute-tool:").ok).toBe(false);
    expect(validateContributeToolScope("contribute-tool:my tool").ok).toBe(false);
    expect(validateContributeToolScope("contribute-tool:*").ok).toBe(false);
  });

  test("accessors and filters", () => {
    expect(isContributeToolScope("contribute-tool:search")).toBe(true);
    expect(isContributeToolScope("tool:search")).toBe(false);
    expect(contributeToolName("contribute-tool:search")).toBe("search");
    expect(contributeToolScopesOf(["contribute-tool:a", "tool:b"])).toEqual(["contribute-tool:a"]);
    expect(CONTRIBUTE_TOOL_SCOPE_PREFIX).toBe("contribute-tool:");
  });

  test("contributesTool matches the registered name only", () => {
    expect(contributesTool("search", ["contribute-tool:search"])).toBe(true);
    expect(contributesTool("other", ["contribute-tool:search"])).toBe(false);
  });
});

describe("whole-tool grant (ADR-0067)", () => {
  test("a named scope covers that tool exactly", () => {
    expect(checkToolScope("bash", ["tool:bash"]).ok).toBe(true);
    expect(checkToolScope("read", ["tool:bash"])).toEqual({ ok: false, reason: "outside_scope" });
  });

  test("no argv sub-scoping: the grant covers the tool entire", () => {
    expect(checkToolScope("bash", ["tool:bash"]).ok).toBe(true);
  });

  test("the wildcard covers built-in and MCP tool names", () => {
    expect(checkToolScope("bash", ["tool:*"]).ok).toBe(true);
    expect(checkToolScope("mcp__srv__query", ["tool:*"]).ok).toBe(true);
  });

  test("multiple scopes cover any one of them", () => {
    expect(checkToolScope("read", ["tool:bash", "tool:read"]).ok).toBe(true);
  });

  test("an empty grant refuses", () => {
    expect(checkToolScope("bash", [])).toEqual({ ok: false, reason: "outside_scope" });
  });
});

describe("consent effect sentences (ADR-0067)", () => {
  test("an invocation scope says ask-the-host through the gate", () => {
    expect(toolEffectSentence("tool:bash")).toBe("may ask the host to run the `bash` tool through moh's normal permission gate");
  });

  test("the wildcard states its perimeter plainly", () => {
    expect(toolEffectSentence("tool:*")).toBe("may run any session tool, including MCP calls");
  });

  test("a contribution has its own trust shape", () => {
    expect(contributeToolEffectSentence("search")).toBe("will add a `search` tool the model can call; its code runs when the model invokes it");
  });

  test("the shared consent renderer speaks both scopes", () => {
    expect(scopeEffectSentence("tool:bash")).toBe(toolEffectSentence("tool:bash"));
    expect(scopeEffectSentence("tool:*")).toBe(toolEffectSentence("tool:*"));
    expect(scopeEffectSentence("contribute-tool:search")).toBe(contributeToolEffectSentence("search"));
  });
});

describe("known capability slots (ADR-0071 phase F3a)", () => {
  test("the tool prefixes are known slots now", () => {
    expect(isKnownCapability("tool:bash")).toBe(true);
    expect(isKnownCapability("tool:*")).toBe(true);
    expect(isKnownCapability("contribute-tool:search")).toBe(true);
  });
});
