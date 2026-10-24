/**
 * #1424 (S3.2, tracking #1378): characterization of the scope modules before
 * they become one descriptor table. Every effect sentence, validation result,
 * refusal reason and credential-store command is pinned byte for byte, as the
 * pre-change code produces it (C6, C9). A test here changes only its import
 * lines when the modules move.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { scopeEffectSentence } from "../src/scopes";
import { checkScope } from "../src/scopes";
import {
  HOST_SCOPE_PREFIX,
  HOST_SCOPE_REASONING_KEY,
  PATH_SCOPE_PREFIX,
  TOTAL_HOST_WILDCARD,
  hostMatchesScope,
  hostScopesOf,
  isHostScope,
  isPathScope,
  matchesPathScopes,
  pathScopesOf,
  validateHostScope,
  validatePathGlob,
  validatePathScope,
} from "../src/scopes";
import { MAX_FETCH_BYTES, MAX_REDIRECTS, foldGlobCase } from "../src/host-scope";
import {
  CONTRIBUTE_TOOL_SCOPE_PREFIX,
  TOOL_SCOPE_PREFIX,
  TOOL_SCOPE_WILDCARD,
  contributeToolEffectSentence,
  contributeToolName,
  contributeToolScopesOf,
  contributesTool,
  isContributeToolScope,
  isToolScope,
  toolEffectSentence,
  toolScopeName,
  toolScopesOf,
  validateContributeToolScope,
  validateToolScope,
} from "../src/scopes";
import { ENDPOINT_SCOPE_PREFIX, endpointEffectSentence, endpointScopesOf, isEndpointScope, validateEndpointScope } from "../src/scopes";
import {
  CREDENTIAL_SCOPE_PREFIX,
  credentialScopeRef,
  credentialScopesOf,
  isCredentialScope,
  validateCredentialScope,
} from "../src/scopes";
import { defaultCredentialStore, fileCredentialStore, keychainAccount, keychainCredentialStore } from "../src/credential-store";
import { isKnownCapability, scopeGrammarValidity } from "../src/extension-registry";

type Kind = "credential" | "host" | "endpoint" | "contribute-tool" | "tool" | "path" | null;

/** The kind the pre-change predicates assign, tested in scopeEffectSentence's order. */
function kindOf(capability: string): Kind {
  if (isCredentialScope(capability)) return "credential";
  if (isHostScope(capability)) return "host";
  if (isEndpointScope(capability)) return "endpoint";
  if (isContributeToolScope(capability)) return "contribute-tool";
  if (isToolScope(capability)) return "tool";
  if (isPathScope(capability)) return "path";
  return null;
}

const VALIDATE: Record<Exclude<Kind, null>, (capability: string) => unknown> = {
  credential: validateCredentialScope,
  host: validateHostScope,
  endpoint: validateEndpointScope,
  "contribute-tool": validateContributeToolScope,
  tool: validateToolScope,
  path: validatePathScope,
};

/** [capability, kind, scopeEffectSentence, own-kind validate, scopeGrammarValidity, isKnownCapability] */
const CAPABILITIES: readonly (readonly [string, Kind, string | null, unknown, unknown, boolean])[] = [
  ["path:src/**", "path", "may read and modify files under `src/**`, including create, rename, delete", {"ok": true, "glob": "src/**"}, {"ok": true}, true],
  ["path:notes.txt", "path", "may read and modify files under `notes.txt`, including create, rename, delete", {"ok": true, "glob": "notes.txt"}, {"ok": true}, true],
  ["path:", "path", "may read and modify files under ``, including create, rename, delete", {"ok": false, "reason": "malformed", "message": "invalid path scope \"path:\": empty or malformed glob"}, {"ok": false, "message": "invalid scope \"path:\": invalid path scope \"path:\": empty or malformed glob"}, true],
  ["path:   ", "path", "may read and modify files under `   `, including create, rename, delete", {"ok": false, "reason": "malformed", "message": "invalid path scope \"path:   \": empty or malformed glob"}, {"ok": false, "message": "invalid scope \"path:   \": invalid path scope \"path:   \": empty or malformed glob"}, true],
  ["path:/etc/passwd", "path", "may read and modify files under `/etc/passwd`, including create, rename, delete", {"ok": false, "reason": "absolute", "message": "invalid path scope \"path:/etc/passwd\": absolute paths are not allowed — scopes are project-root-relative"}, {"ok": false, "message": "invalid scope \"path:/etc/passwd\": invalid path scope \"path:/etc/passwd\": absolute paths are not allowed — scopes are project-root-relative"}, true],
  ["path:a\0b", "path", "may read and modify files under `a\0b`, including create, rename, delete", {"ok": false, "reason": "malformed", "message": "invalid path scope \"path:a\0b\": empty or malformed glob"}, {"ok": false, "message": "invalid scope \"path:a\0b\": invalid path scope \"path:a\0b\": empty or malformed glob"}, true],
  ["path:!src/**", "path", "may read and modify files under `!src/**`, including create, rename, delete", {"ok": true, "glob": "!src/**"}, {"ok": true}, true],
  ["path:src/[!A-z].ts", "path", "may read and modify files under `src/[!A-z].ts`, including create, rename, delete", {"ok": true, "glob": "src/[!A-z].ts"}, {"ok": true}, true],
  ["path:../escape", "path", "may read and modify files under `../escape`, including create, rename, delete", {"ok": true, "glob": "../escape"}, {"ok": true}, true],
  ["path:SRC/**", "path", "may read and modify files under `SRC/**`, including create, rename, delete", {"ok": true, "glob": "SRC/**"}, {"ok": true}, true],
  ["host:api.example.com", "host", "may contact `api.example.com` over https", {"ok": true, "host": "api.example.com", "wildcard": false}, {"ok": true}, true],
  ["host:api.example.com:8443", "host", "may contact `api.example.com:8443` over https", {"ok": true, "host": "api.example.com", "port": 8443, "wildcard": false}, {"ok": true}, true],
  ["host:*.example.com", "host", "may contact any subdomain of `example.com` over https", {"ok": true, "host": "*.example.com", "wildcard": true}, {"ok": true}, true],
  ["host:*.example.com:8443", "host", "may contact any subdomain of `example.com` over https on port 8443", {"ok": true, "host": "*.example.com", "port": 8443, "wildcard": true}, {"ok": true}, true],
  ["host:*", "host", "may contact any host on the internet over https — total network access", {"ok": true, "host": "*", "wildcard": false}, {"ok": true}, true],
  ["host:*:443", "host", null, {"ok": false, "reason": "malformed", "message": "invalid host scope \"host:*:443\": the total wildcard takes no port"}, {"ok": false, "message": "invalid scope \"host:*:443\": invalid host scope \"host:*:443\": the total wildcard takes no port"}, true],
  ["host:", "host", null, {"ok": false, "reason": "malformed", "message": "invalid host scope \"host:\": empty or malformed host"}, {"ok": false, "message": "invalid scope \"host:\": invalid host scope \"host:\": empty or malformed host"}, true],
  ["host:Example.com", "host", null, {"ok": false, "reason": "malformed", "message": "invalid host scope \"host:Example.com\": not a hostname"}, {"ok": false, "message": "invalid scope \"host:Example.com\": invalid host scope \"host:Example.com\": not a hostname"}, true],
  ["host:a..b.com", "host", null, {"ok": false, "reason": "malformed", "message": "invalid host scope \"host:a..b.com\": not a hostname"}, {"ok": false, "message": "invalid scope \"host:a..b.com\": invalid host scope \"host:a..b.com\": not a hostname"}, true],
  ["host:*.*.example.com", "host", null, {"ok": false, "reason": "malformed", "message": "invalid host scope \"host:*.*.example.com\": not a hostname"}, {"ok": false, "message": "invalid scope \"host:*.*.example.com\": invalid host scope \"host:*.*.example.com\": not a hostname"}, true],
  ["host:example.com:0", "host", null, {"ok": false, "reason": "malformed", "message": "invalid host scope \"host:example.com:0\": port out of range"}, {"ok": false, "message": "invalid scope \"host:example.com:0\": invalid host scope \"host:example.com:0\": port out of range"}, true],
  ["host:api.example.com:443", "host", "may contact `api.example.com` over https", {"ok": true, "host": "api.example.com", "wildcard": false}, {"ok": true}, true],
  ["host:api.example.com:80", "host", "may contact `api.example.com:80` over http", {"ok": true, "host": "api.example.com", "port": 80, "wildcard": false}, {"ok": true}, true],
  ["host:*.example.com:80", "host", "may contact any subdomain of `example.com` over http on port 80", {"ok": true, "host": "*.example.com", "port": 80, "wildcard": true}, {"ok": true}, true],
  ["host:example.com:65535", "host", "may contact `example.com:65535` over https", {"ok": true, "host": "example.com", "port": 65535, "wildcard": false}, {"ok": true}, true],
  ["host:example.com:65536", "host", null, {"ok": false, "reason": "malformed", "message": "invalid host scope \"host:example.com:65536\": port out of range"}, {"ok": false, "message": "invalid scope \"host:example.com:65536\": invalid host scope \"host:example.com:65536\": port out of range"}, true],
  ["host:example.com:99999", "host", null, {"ok": false, "reason": "malformed", "message": "invalid host scope \"host:example.com:99999\": port out of range"}, {"ok": false, "message": "invalid scope \"host:example.com:99999\": invalid host scope \"host:example.com:99999\": port out of range"}, true],
  ["host:example.com:ab", "host", null, {"ok": false, "reason": "malformed", "message": "invalid host scope \"host:example.com:ab\": port must be numeric"}, {"ok": false, "message": "invalid scope \"host:example.com:ab\": invalid host scope \"host:example.com:ab\": port must be numeric"}, true],
  ["host:[::1]:8080", "host", null, {"ok": false, "reason": "malformed", "message": "invalid host scope \"host:[::1]:8080\": not a hostname"}, {"ok": false, "message": "invalid scope \"host:[::1]:8080\": invalid host scope \"host:[::1]:8080\": not a hostname"}, true],
  ["host:-bad.com", "host", null, {"ok": false, "reason": "malformed", "message": "invalid host scope \"host:-bad.com\": not a hostname"}, {"ok": false, "message": "invalid scope \"host:-bad.com\": invalid host scope \"host:-bad.com\": not a hostname"}, true],
  ["host:localhost:3000", "host", "may contact `localhost:3000` over https", {"ok": true, "host": "localhost", "port": 3000, "wildcard": false}, {"ok": true}, true],
  ["host:a*.example.com", "host", null, {"ok": false, "reason": "malformed", "message": "invalid host scope \"host:a*.example.com\": not a hostname"}, {"ok": false, "message": "invalid scope \"host:a*.example.com\": invalid host scope \"host:a*.example.com\": not a hostname"}, true],
  ["tool:bash", "tool", "may ask the host to run the `bash` tool through moh's normal permission gate", {"ok": true, "name": "bash", "wildcard": false}, {"ok": true}, true],
  ["tool:*", "tool", "may run any session tool, including MCP calls", {"ok": true, "name": "*", "wildcard": true}, {"ok": true}, true],
  ["tool:", "tool", null, {"ok": false, "reason": "malformed", "message": "invalid tool scope \"tool:\": a tool name is non-empty, without whitespace (\"tool:<name>\" or \"tool:*\")"}, {"ok": false, "message": "invalid scope \"tool:\": invalid tool scope \"tool:\": a tool name is non-empty, without whitespace (\"tool:<name>\" or \"tool:*\")"}, true],
  ["tool:a b", "tool", null, {"ok": false, "reason": "malformed", "message": "invalid tool scope \"tool:a b\": a tool name is non-empty, without whitespace (\"tool:<name>\" or \"tool:*\")"}, {"ok": false, "message": "invalid scope \"tool:a b\": invalid tool scope \"tool:a b\": a tool name is non-empty, without whitespace (\"tool:<name>\" or \"tool:*\")"}, true],
  ["tool:mcp__server__tool", "tool", "may ask the host to run the `mcp__server__tool` tool through moh's normal permission gate", {"ok": true, "name": "mcp__server__tool", "wildcard": false}, {"ok": true}, true],
  ["tool:a\0b", "tool", null, {"ok": false, "reason": "malformed", "message": "invalid tool scope \"tool:a\0b\": a tool name is non-empty, without whitespace (\"tool:<name>\" or \"tool:*\")"}, {"ok": false, "message": "invalid scope \"tool:a\0b\": invalid tool scope \"tool:a\0b\": a tool name is non-empty, without whitespace (\"tool:<name>\" or \"tool:*\")"}, true],
  ["contribute-tool:team", "contribute-tool", "will add a `team` tool the model can call; its code runs when the model invokes it", {"ok": true, "name": "team"}, {"ok": true}, true],
  ["contribute-tool:*", "contribute-tool", "will add a `*` tool the model can call; its code runs when the model invokes it", {"ok": false, "reason": "malformed", "message": "invalid contribute-tool scope \"contribute-tool:*\": a contributed tool is named exactly (\"contribute-tool:<name>\")"}, {"ok": false, "message": "invalid scope \"contribute-tool:*\": invalid contribute-tool scope \"contribute-tool:*\": a contributed tool is named exactly (\"contribute-tool:<name>\")"}, true],
  ["contribute-tool:", "contribute-tool", "will add a `` tool the model can call; its code runs when the model invokes it", {"ok": false, "reason": "malformed", "message": "invalid contribute-tool scope \"contribute-tool:\": a contributed tool is named exactly (\"contribute-tool:<name>\")"}, {"ok": false, "message": "invalid scope \"contribute-tool:\": invalid contribute-tool scope \"contribute-tool:\": a contributed tool is named exactly (\"contribute-tool:<name>\")"}, true],
  ["contribute-tool:a b", "contribute-tool", "will add a `a b` tool the model can call; its code runs when the model invokes it", {"ok": false, "reason": "malformed", "message": "invalid contribute-tool scope \"contribute-tool:a b\": a contributed tool is named exactly (\"contribute-tool:<name>\")"}, {"ok": false, "message": "invalid scope \"contribute-tool:a b\": invalid contribute-tool scope \"contribute-tool:a b\": a contributed tool is named exactly (\"contribute-tool:<name>\")"}, true],
  ["endpoint:openai", "endpoint", "may call and list the models of `openai`; may choose the reasoning level per call, within those supported", {"ok": true, "ref": "openai"}, {"ok": true}, true],
  ["endpoint:", "endpoint", "may call and list the models of ``; may choose the reasoning level per call, within those supported", {"ok": false, "reason": "malformed", "message": "invalid endpoint scope \"endpoint:\": the ref is an endpoint name from moh.json, without whitespace or \"/\" (\"endpoint:<endpoint>\")"}, {"ok": false, "message": "invalid scope \"endpoint:\": invalid endpoint scope \"endpoint:\": the ref is an endpoint name from moh.json, without whitespace or \"/\" (\"endpoint:<endpoint>\")"}, true],
  ["endpoint:a/b", "endpoint", "may call and list the models of `a/b`; may choose the reasoning level per call, within those supported", {"ok": false, "reason": "malformed", "message": "invalid endpoint scope \"endpoint:a/b\": the ref is an endpoint name from moh.json, without whitespace or \"/\" (\"endpoint:<endpoint>\")"}, {"ok": false, "message": "invalid scope \"endpoint:a/b\": invalid endpoint scope \"endpoint:a/b\": the ref is an endpoint name from moh.json, without whitespace or \"/\" (\"endpoint:<endpoint>\")"}, true],
  ["endpoint:a b", "endpoint", "may call and list the models of `a b`; may choose the reasoning level per call, within those supported", {"ok": false, "reason": "malformed", "message": "invalid endpoint scope \"endpoint:a b\": the ref is an endpoint name from moh.json, without whitespace or \"/\" (\"endpoint:<endpoint>\")"}, {"ok": false, "message": "invalid scope \"endpoint:a b\": invalid endpoint scope \"endpoint:a b\": the ref is an endpoint name from moh.json, without whitespace or \"/\" (\"endpoint:<endpoint>\")"}, true],
  ["credential:deploy-key", "credential", "may use the credential `deploy-key`", {"ok": true, "ref": "deploy-key"}, {"ok": true}, true],
  ["credential:", "credential", "may use the credential ``", {"ok": false, "reason": "malformed", "message": "invalid credential scope \"credential:\": a ref is a non-empty name without whitespace"}, {"ok": false, "message": "invalid scope \"credential:\": invalid credential scope \"credential:\": a ref is a non-empty name without whitespace"}, true],
  ["credential:a b", "credential", "may use the credential `a b`", {"ok": false, "reason": "malformed", "message": "invalid credential scope \"credential:a b\": a ref is a non-empty name without whitespace"}, {"ok": false, "message": "invalid scope \"credential:a b\": invalid credential scope \"credential:a b\": a ref is a non-empty name without whitespace"}, true],
  ["credential:   ", "credential", "may use the credential `   `", {"ok": false, "reason": "malformed", "message": "invalid credential scope \"credential:   \": a ref is a non-empty name without whitespace"}, {"ok": false, "message": "invalid scope \"credential:   \": invalid credential scope \"credential:   \": a ref is a non-empty name without whitespace"}, true],
  ["spawn-subagent", null, "may create up to 10 concurrent child sessions and steer or stop them", null, {"ok": true}, true],
  ["observe", null, null, null, {"ok": true}, true],
  ["veto", null, null, null, {"ok": true}, true],
  ["replace-prompt-section:environment", null, null, null, {"ok": true}, false],
  ["Path:src/**", null, null, null, {"ok": true}, false],
  ["TOOL:bash", null, null, null, {"ok": true}, false],
  ["Host:example.com", null, null, null, {"ok": true}, false],
  ["Credential:x", null, null, null, {"ok": true}, false],
  ["", null, null, null, {"ok": true}, false],
  [" path:x", null, null, null, {"ok": true}, false],
  ["spawn-subagent:x", null, null, null, {"ok": true}, false],
  ["Spawn-Subagent", null, null, null, {"ok": true}, false],
  ["tool :bash", null, null, null, {"ok": true}, false],
  ["custom:x", null, null, null, {"ok": true}, false],
];

describe("capability table", () => {
  test("kind, effect sentence, validation, grammar validity and known slot", () => {
    for (const [capability, kind, effect, validity, grammar, known] of CAPABILITIES) {
      const actual = kindOf(capability);
      expect([capability, actual]).toEqual([capability, kind]);
      expect([capability, scopeEffectSentence(capability)]).toEqual([capability, effect]);
      expect([capability, actual === null ? null : VALIDATE[actual](capability)]).toEqual([capability, validity]);
      expect<unknown[]>([capability, scopeGrammarValidity(capability)]).toEqual([capability, grammar]);
      expect([capability, isKnownCapability(capability)]).toEqual([capability, known]);
    }
  });

  test("the table holds one capability per kind, spawn-subagent, observe and unknown slots", () => {
    const kinds = new Set(CAPABILITIES.map(([, kind]) => kind));
    expect<unknown[]>([...kinds].sort()).toEqual(["contribute-tool", "credential", "endpoint", "host", "path", "tool", null].sort());
    const names = CAPABILITIES.map(([capability]) => capability);
    for (const name of ["spawn-subagent", "observe", "Path:src/**", "TOOL:bash", " path:x", "", "custom:x"]) expect(names).toContain(name);
  });

  test("no shipped prefix is a prefix of another, and spawn-subagent starts with none", () => {
    const prefixes = [CREDENTIAL_SCOPE_PREFIX, HOST_SCOPE_PREFIX, ENDPOINT_SCOPE_PREFIX, CONTRIBUTE_TOOL_SCOPE_PREFIX, TOOL_SCOPE_PREFIX, PATH_SCOPE_PREFIX];
    expect(prefixes).toEqual(["credential:", "host:", "endpoint:", "contribute-tool:", "tool:", "path:"]);
    for (const a of prefixes) for (const b of prefixes) if (a !== b) expect([a, b, a.startsWith(b)]).toEqual([a, b, false]);
    for (const p of prefixes) expect("spawn-subagent".startsWith(p)).toBe(false);
  });

  test("constants and name extractors", () => {
    expect([TOOL_SCOPE_WILDCARD, TOTAL_HOST_WILDCARD, HOST_SCOPE_REASONING_KEY, MAX_FETCH_BYTES, MAX_REDIRECTS]).toEqual(["*", "host:*", "reasoning", 1048576, 5]);
    expect(["tool:x", "tool:", "contribute-tool:x"].map(toolScopeName)).toEqual(["x", "", "ibute-tool:x"]);
    expect(["contribute-tool:x", "contribute-tool:"].map(contributeToolName)).toEqual(["x", ""]);
    expect(["credential:x", "credential:"].map(credentialScopeRef)).toEqual(["x", ""]);
  });

  test("direct effect-sentence helpers", () => {
    expect(["tool:bash", "tool:*", "tool:", "contribute-tool:x"].map(toolEffectSentence)).toEqual([
      "may ask the host to run the `bash` tool through moh's normal permission gate",
      "may run any session tool, including MCP calls",
      null,
      "may ask the host to run the `ibute-tool:x` tool through moh's normal permission gate",
    ]);
    expect([contributeToolEffectSentence("x"), contributeToolEffectSentence(""), endpointEffectSentence("e")]).toEqual([
      "will add a `x` tool the model can call; its code runs when the model invokes it",
      "will add a `` tool the model can call; its code runs when the model invokes it",
      "may call and list the models of `e`; may choose the reasoning level per call, within those supported",
    ]);
  });

  test("validatePathGlob on bare globs, with and without the original", () => {
    expect(validatePathGlob("src/**")).toEqual({ ok: true, glob: "src/**" });
    expect(validatePathGlob("")).toEqual({ ok: false, reason: "malformed", message: 'invalid path scope "": empty or malformed glob' });
    expect(validatePathGlob("  ", "path:  ")).toEqual({ ok: false, reason: "malformed", message: 'invalid path scope "path:  ": empty or malformed glob' });
    expect(validatePathGlob("/abs", "path:/abs")).toEqual({
      ok: false,
      reason: "absolute",
      message: 'invalid path scope "path:/abs": absolute paths are not allowed — scopes are project-root-relative',
    });
    expect(validatePathGlob("a\0b")).toEqual({ ok: false, reason: "malformed", message: 'invalid path scope "a\0b": empty or malformed glob' });
    expect(validatePathGlob("client/**", "client/**")).toEqual({ ok: true, glob: "client/**" });
  });

  test("grant filters keep order and family", () => {
    const grant = ["path:a", "host:b", "tool:c", "contribute-tool:d", "endpoint:e", "credential:f", "spawn-subagent", "tool:*", "path:g"];
    expect(pathScopesOf(grant)).toEqual(["path:a", "path:g"]);
    expect(hostScopesOf(grant)).toEqual(["host:b"]);
    expect(toolScopesOf(grant)).toEqual(["tool:c", "tool:*"]);
    expect(contributeToolScopesOf(grant)).toEqual(["contribute-tool:d"]);
    expect(endpointScopesOf(grant)).toEqual(["endpoint:e"]);
    expect(credentialScopesOf(grant)).toEqual(["credential:f"]);
  });
});

describe("checkScope", () => {
  test("exact kinds: tool, endpoint, credential, and kinds outside the dispatcher", () => {
    const cases: readonly (readonly [string, string, readonly string[], unknown])[] = [
      ["tool", "bash", ["tool:bash"], { ok: true }],
      ["tool", "bash", ["tool:*"], { ok: true }],
      ["tool", "read", ["tool:bash"], { ok: false, reason: "outside_scope" }],
      ["tool", "bash", ["contribute-tool:bash"], { ok: false, reason: "outside_scope" }],
      ["tool", "", ["tool:"], { ok: false, reason: "outside_scope" }],
      ["tool", "a b", ["tool:a b"], { ok: false, reason: "outside_scope" }],
      ["tool", "bash", ["Tool:bash", "TOOL:bash"], { ok: false, reason: "outside_scope" }],
      ["tool", "*", ["tool:*"], { ok: true }],
      ["tool", "bash", [], { ok: false, reason: "outside_scope" }],
      ["endpoint", "main", ["endpoint:main"], { ok: true }],
      ["endpoint", "other", ["endpoint:main"], { ok: false, reason: "outside_scope" }],
      ["endpoint", "a/b", ["endpoint:a/b"], { ok: false, reason: "outside_scope" }],
      ["endpoint", "", ["endpoint:"], { ok: false, reason: "outside_scope" }],
      ["endpoint", "main", ["endpoint:main/x", "endpoint:main"], { ok: true }],
      ["credential", "token", ["credential:token"], { ok: true }],
      ["credential", "other", ["credential:token"], { ok: false, reason: "outside_scope" }],
      // A malformed credential scope never matches, even its own ref (#1572).
      ["credential", "", ["credential:"], { ok: false, reason: "outside_scope" }],
      ["credential", "a b", ["credential:a b"], { ok: false, reason: "outside_scope" }],
      ["credential", "  ", ["credential:  "], { ok: false, reason: "outside_scope" }],
      ["credential", "token", ["path:token", "tool:token"], { ok: false, reason: "outside_scope" }],
      // Kinds the dispatcher does not route return undefined, not a refusal.
      ["contribute-tool", "team", ["contribute-tool:team"], undefined],
      ["unknown", "x", ["tool:x"], undefined],
      ["toString", "x", [], undefined],
      ["__proto__", "x", [], undefined],
      ["constructor", "x", [], undefined],
    ];
    for (const [kind, ref, scopes, expected] of cases) {
      expect<unknown[]>([kind, ref, scopes, checkScope({ kind, ref } as never, scopes)]).toEqual([kind, ref, scopes, expected]);
    }
  });

  test("host: scheme, port, wildcard label and deny", () => {
    const scopes = ["host:api.example.com", "host:*.example.org", "host:localhost:3000", "host:dev.example.net:8443", "host:bad host"];
    const cases: readonly (readonly [string, unknown])[] = [
      ["https://api.example.com/x", { ok: true }],
      ["https://API.EXAMPLE.COM/x", { ok: true }],
      ["https://api.example.com:443/x", { ok: true }],
      // A scope without a port admits any https port.
      ["https://api.example.com:8443/x", { ok: true }],
      ["http://api.example.com/x", { ok: false, reason: "outside_scope", target: "api.example.com" }],
      ["https://a.example.org/", { ok: true }],
      ["https://a.b.example.org/", { ok: false, reason: "outside_scope", target: "a.b.example.org" }],
      ["https://example.org/", { ok: false, reason: "outside_scope", target: "example.org" }],
      ["http://localhost:3000/", { ok: true }],
      ["https://localhost:3000/", { ok: true }],
      ["http://localhost:3001/", { ok: false, reason: "outside_scope", target: "localhost:3001" }],
      ["https://dev.example.net:8443/", { ok: true }],
      ["http://dev.example.net:8443/", { ok: true }],
      ["https://dev.example.net/", { ok: false, reason: "outside_scope", target: "dev.example.net" }],
      ["ftp://api.example.com/", { ok: false, reason: "invalid_url" }],
      ["file:///etc/passwd", { ok: false, reason: "invalid_url" }],
      ["https://evil.com/", { ok: false, reason: "outside_scope", target: "evil.com" }],
    ];
    for (const [url, expected] of cases) {
      expect<unknown[]>([url, checkScope({ kind: "host", url: new URL(url), isDenied: () => false }, scopes)]).toEqual([url, expected]);
    }
    for (const [url, host] of [["https://api.example.com/x", "api.example.com"], ["https://a.example.org/", "a.example.org"]] as const) {
      const seen: string[] = [];
      const result = checkScope({ kind: "host", url: new URL(url), isDenied: (h) => (seen.push(h), true) }, scopes);
      expect([result, seen]).toEqual([{ ok: false, reason: "denied", target: host }, [host]]);
    }
    // An out-of-scope request never consults the deny rules.
    const seen: string[] = [];
    checkScope({ kind: "host", url: new URL("https://evil.com/"), isDenied: (h) => (seen.push(h), true) }, scopes);
    expect(seen).toEqual([]);
    expect(["https://anything.io/", "http://anything.io/", "http://anything.io:8080/"].map((u) => checkScope({ kind: "host", url: new URL(u), isDenied: () => false }, ["host:*"]))).toEqual([
      { ok: true },
      { ok: false, reason: "outside_scope", target: "anything.io" },
      { ok: false, reason: "outside_scope", target: "anything.io:8080" },
    ]);
  });

  test("path: containment, `..`, symlinks, invalid paths and deny", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "moh-scope-char-")));
    const root = join(base, "root");
    const outside = join(base, "outside");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, "src", "a.ts"), "");
    writeFileSync(join(root, "notes.txt"), "");
    writeFileSync(join(root, "other.txt"), "");
    symlinkSync(outside, join(root, "link-out"));
    symlinkSync(join(root, "missing"), join(root, "dangling"));
    const scopes = ["path:src/**", "path:notes.txt", "path:link-out/**", "path:dangling", "host:x.com", "path:/abs"];
    const norm = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null).split(root).join("<root>").split(outside).join("<outside>"));
    const cases: readonly (readonly [string, unknown])[] = [
      ["src/a.ts", { ok: true, resolved: "<root>/src/a.ts" }],
      ["src/new.ts", { ok: true, resolved: "<root>/src/new.ts" }],
      ["src/deep/new.ts", { ok: true, resolved: "<root>/src/deep/new.ts" }],
      ["./src/a.ts", { ok: true, resolved: "<root>/src/a.ts" }],
      ["src//a.ts", { ok: true, resolved: "<root>/src/a.ts" }],
      ["notes.txt", { ok: true, resolved: "<root>/notes.txt" }],
      ["other.txt", { ok: false, reason: "outside_scope", resolved: "<root>/other.txt" }],
      ["../x", { ok: false, reason: "outside_scope" }],
      ["src/../notes.txt", { ok: false, reason: "outside_scope" }],
      ["/etc/passwd", { ok: false, reason: "outside_scope" }],
      [join(root, "notes.txt"), { ok: true, resolved: "<root>/notes.txt" }],
      [join(root, "src", "a.ts"), { ok: true, resolved: "<root>/src/a.ts" }],
      ["", { ok: false, reason: "invalid_path" }],
      ["  ", { ok: false, reason: "invalid_path" }],
      ["a\0b", { ok: false, reason: "invalid_path" }],
      [".", { ok: false, reason: "outside_scope", resolved: "<root>" }],
      ["link-out/f.txt", { ok: false, reason: "outside_scope", resolved: "<outside>/f.txt" }],
      ["dangling", { ok: true, resolved: "<root>/dangling" }],
      ["src\\a.ts", { ok: true, resolved: "<root>/src/a.ts" }],
    ];
    for (const [path, expected] of cases) {
      expect([path, norm(checkScope({ kind: "path", path, root, isDenied: () => false }, scopes))]).toEqual([path, expected]);
    }
    const seen: string[] = [];
    expect(norm(checkScope({ kind: "path", path: "notes.txt", root, isDenied: (p) => (seen.push(p), true) }, scopes))).toEqual({
      ok: false,
      reason: "denied",
      resolved: "<root>/notes.txt",
    });
    expect(norm(seen)).toEqual(["<root>/notes.txt"]);
    expect(norm(checkScope({ kind: "path", path: "other.txt", root, isDenied: () => true }, scopes))).toEqual({
      ok: false,
      reason: "outside_scope",
      resolved: "<root>/other.txt",
    });
  });
});

describe("matching helpers", () => {
  test("matchesPathScopes folds only when every component is insensitive", () => {
    const scopes = ["path:src/**", "path:notes.txt", "path:", "host:src"];
    const cases: readonly (readonly [string, boolean[], boolean])[] = [
      ["src/a.ts", [false], true],
      ["SRC/a.ts", [true, true], true],
      ["SRC/a.ts", [true, false], false],
      ["SRC/a.ts", [false, true], false],
      ["Src/A.ts", [true, true], true],
      ["SRC/a.ts", [], false],
      ["src/a.ts", [], true],
      ["NOTES.TXT", [true], true],
      ["notes.txt", [false], true],
      ["x/a.ts", [true, true], false],
    ];
    for (const [rel, insensitive, expected] of cases) {
      expect([rel, insensitive, matchesPathScopes(rel, scopes, insensitive)]).toEqual([rel, insensitive, expected]);
    }
    const negated: readonly (readonly [string, boolean[], boolean])[] = [
      ["src/a.ts", [true, true], false],
      ["SRC/a.ts", [true, true], false],
      ["SRC/a.ts", [false, false], true],
      ["lib/a.ts", [true, true], true],
    ];
    for (const [rel, insensitive, expected] of negated) {
      expect([rel, insensitive, matchesPathScopes(rel, ["path:!src/**"], insensitive)]).toEqual([rel, insensitive, expected]);
    }
  });

  test("foldGlobCase", () => {
    const cases: readonly (readonly [string, string | null])[] = [
      ["src/**", "[sS][rR][cC]/**"],
      ["[!A-z].txt", "[!A-z].[tT][xX][tT]"],
      ["a\\b", null],
      ["[]a]x", "[]a][xX]"],
      ["[!]a]Y", "[!]a][yY]"],
      ["{Ab,c}*", "{[aA][bB],[cC]}*"],
      ["[abc", "[[aA][bB][cC]"],
      ["**/*.TS", "**/*.[tT][sS]"],
      ["!src/**", "![sS][rR][cC]/**"],
      ["1-2_3", "1-2_3"],
    ];
    for (const [pattern, expected] of cases) expect([pattern, foldGlobCase(pattern)]).toEqual([pattern, expected]);
  });

  test("hostMatchesScope", () => {
    const match = (scope: string, url: string): boolean | "invalid" => {
      const validity = validateHostScope(scope);
      return validity.ok ? hostMatchesScope(validity, new URL(url)) : "invalid";
    };
    const cases: readonly (readonly [string, string, boolean | "invalid"])[] = [
      ["host:*", "https://x.io/", true],
      ["host:*", "http://x.io/", false],
      ["host:a.com", "https://a.com:443/", true],
      ["host:a.com", "https://a.com:444/", true],
      ["host:a.com:444", "https://a.com:444/", true],
      // URL drops the default port; a scope spelling it is the default-port form (#1574).
      ["host:a.com:443", "https://a.com/", true],
      ["host:a.com:443", "https://a.com:443/", true],
      ["host:a.com:443", "http://a.com/", false],
      ["host:a.com:80", "http://a.com/", true],
      ["host:a.com:80", "http://a.com:80/", true],
      ["host:a.com:80", "http://a.com:8080/", false],
      ["host:a.com:80", "https://a.com/", false],
      ["host:*.a.com:443", "https://b.a.com/", true],
      ["host:*.a.com:80", "http://b.a.com/", true],
      ["host:*.a.com", "https://b.a.com/", true],
      ["host:*.a.com", "https://a.com/", false],
      ["host:*.a.com", "https://c.b.a.com/", false],
      ["host:*.a.com:8080", "http://b.a.com:8080/", true],
      ["host:bad host", "https://x.io/", "invalid"],
    ];
    for (const [scope, url, expected] of cases) expect([scope, url, match(scope, url)]).toEqual([scope, url, expected]);
  });

  test("contributesTool", () => {
    const cases: readonly (readonly [string, string[], boolean])[] = [
      ["team", ["contribute-tool:team"], true],
      ["team", ["tool:team"], false],
      ["*", ["contribute-tool:*"], true],
      ["", ["contribute-tool:"], true],
      ["Team", ["contribute-tool:team"], false],
      ["team", [], false],
    ];
    for (const [tool, scopes, expected] of cases) expect([tool, scopes, contributesTool(tool, scopes)]).toEqual([tool, scopes, expected]);
  });
});

describe("credential stores (never the real keychain, #1504)", () => {
  const tempHome = (): string => realpathSync(mkdtempSync(join(tmpdir(), "moh-cred-char-")));

  test("fileCredentialStore: round trip, 0600, mode repair, corrupt and non-string entries", () => {
    const home = tempHome();
    const file = join(home, ".moh", "secrets.json");
    const store = fileCredentialStore({ home });
    expect([store.list(), store.get("a"), store.delete("a"), existsSync(file)]).toEqual([[], undefined, false, false]);
    store.set("b", "two");
    store.set("a", "one");
    expect(readFileSync(file, "utf8")).toBe('{\n  "b": "two",\n  "a": "one"\n}\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect([store.list(), store.get("a"), store.get("b")]).toEqual([["a", "b"], "one", "two"]);
    chmodSync(file, 0o644);
    store.set("c", "three");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(store.delete("b")).toBe(true);
    expect(readFileSync(file, "utf8")).toBe('{\n  "a": "one",\n  "c": "three"\n}\n');
    chmodSync(file, 0o644);
    expect(store.delete("missing")).toBe(false);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    writeFileSync(file, '{"n": 1, "s": "ok", "o": {}, "z": null}');
    expect([store.list(), store.get("n"), store.get("s")]).toEqual([["s"], undefined, "ok"]);
    writeFileSync(file, "not json");
    expect([store.list(), store.get("s")]).toEqual([[], undefined]);
  });

  test("defaultCredentialStore with MOH_SECRET_STORE=file is the file store under the given home", () => {
    const home = tempHome();
    const previous = process.env.MOH_SECRET_STORE;
    process.env.MOH_SECRET_STORE = "file";
    try {
      const store = defaultCredentialStore(home);
      store.set("deploy-key", "v");
      expect(readFileSync(join(home, ".moh", "secrets.json"), "utf8")).toBe('{\n  "deploy-key": "v"\n}\n');
      expect([store.list(), store.get("deploy-key"), store.delete("deploy-key"), store.list()]).toEqual([["deploy-key"], "v", true, []]);
    } finally {
      if (previous === undefined) delete process.env.MOH_SECRET_STORE;
      else process.env.MOH_SECRET_STORE = previous;
    }
  });

  test("keychainAccount digests the home", () => {
    expect([keychainAccount("/tmp/home-a", "deploy-key"), keychainAccount("/tmp/home-b", "deploy-key"), keychainAccount("", "")]).toEqual([
      "20ee833147a450f9:deploy-key",
      "07dad33b36f8c029:deploy-key",
      "e3b0c44298fc1c14:",
    ]);
  });

  type Reply = { ok: boolean; out: string; err: string; exit: number | null };
  /** A scripted runner: records every call and answers from the queue. */
  function scripted(replies: Reply[]) {
    const calls: { args: string[]; input: string | undefined }[] = [];
    const run = (args: string[], input?: string): Reply => {
      calls.push({ args, input });
      return replies.shift() ?? { ok: false, out: "", err: "unscripted", exit: 1 };
    };
    return { run, calls };
  }
  const OK = (out = ""): Reply => ({ ok: true, out, err: "", exit: 0 });
  const MISS: Reply = { ok: false, out: "", err: "not found", exit: 44 };

  test("keychainCredentialStore: exact command sequence for get, set, delete and list", () => {
    const home = tempHome();
    const account = keychainAccount(home, "deploy-key");
    const fake = scripted([OK("s3cret"), MISS, OK(""), OK(), OK(), MISS]);
    const store = keychainCredentialStore(home, fake.run)!;
    expect(store.get("deploy-key")).toBe("s3cret");
    expect(store.get("deploy-key")).toBeUndefined();
    expect(store.get("deploy-key")).toBeUndefined();
    store.set("deploy-key", 'v "q" \\b $d `t`');
    expect(store.list()).toEqual(["deploy-key"]);
    expect(readFileSync(join(home, ".moh", "secrets.json"), "utf8")).toBe('{\n  "deploy-key": ""\n}\n');
    expect(store.delete("deploy-key")).toBe(true);
    expect(store.delete("deploy-key")).toBe(false);
    expect(store.list()).toEqual([]);
    expect(fake.calls).toEqual([
      { args: ["find-generic-password", "-s", "moh-secret", "-a", account, "-w"], input: undefined },
      { args: ["find-generic-password", "-s", "moh-secret", "-a", account, "-w"], input: undefined },
      { args: ["find-generic-password", "-s", "moh-secret", "-a", account, "-w"], input: undefined },
      {
        args: ["-i"],
        input: `add-generic-password -s "moh-secret" -a "${account}" -w "v \\"q\\" \\\\b \\$d \\\`t\\\`" -U\n`,
      },
      { args: ["delete-generic-password", "-s", "moh-secret", "-a", account], input: undefined },
      { args: ["delete-generic-password", "-s", "moh-secret", "-a", account], input: undefined },
    ]);
  });

  test("keychainCredentialStore: refusal and failure messages", () => {
    const home = tempHome();
    const fake = scripted([{ ok: false, out: "", err: "boom", exit: 2 }, { ok: false, out: "", err: "denied", exit: 51 }]);
    const store = keychainCredentialStore(home, fake.run)!;
    for (const value of ["two\nlines", "cr\rhere", "tab\there", "trailing\\"]) {
      expect(() => store.set("deploy-key", value)).toThrow(
        'keychain write for "deploy-key" refused: the value contains a newline, a tab or a trailing backslash, which the keychain CLI cannot store without exposing it in process argv',
      );
    }
    expect(fake.calls).toEqual([]);
    expect(() => store.set("deploy-key", "v")).toThrow("keychain write failed (security exit 2): boom");
    expect(() => store.delete("deploy-key")).toThrow("keychain delete failed (security exit 51): denied");
    expect(store.list()).toEqual([]);
  });

  test("keychainCredentialStore: legacy bare-account lookup only from the ambient home, read-only", () => {
    const fake = scripted([MISS, OK("legacy")]);
    const store = keychainCredentialStore(homedir(), fake.run)!;
    expect(store.get("deploy-key")).toBe("legacy");
    expect(fake.calls.map((c) => c.args)).toEqual([
      ["find-generic-password", "-s", "moh-secret", "-a", keychainAccount(homedir(), "deploy-key"), "-w"],
      ["find-generic-password", "-s", "moh-secret", "-a", "deploy-key", "-w"],
    ]);
    const temp = scripted([MISS, OK("legacy")]);
    expect(keychainCredentialStore(tempHome(), temp.run)!.get("deploy-key")).toBeUndefined();
    expect(temp.calls.length).toBe(1);
  });
});
