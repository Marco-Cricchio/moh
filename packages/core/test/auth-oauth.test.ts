import { describe, expect, test } from "bun:test";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import {
  TOS_WARNING,
  base64url,
  buildAuthorizeUrl,
  confirmToSWarning,
  generatePkce,
  generateState,
  raceForCode,
  startLoopbackCallback,
  type AuthorizationIo,
} from "../src/auth/oauth";

/** Unbuffered-hash helper for PKCE verification in tests. */
function sha256(input: string): string {
  return base64url(createHash("sha256").update(input).digest());
}

/** IO double: pre-scripted answers, recorded info lines, optional browser. */
function ioDouble(answers: string[], opts: { errorOnOpen?: Error } = {}): AuthorizationIo & {
  prompts: string[];
  infos: string[];
  openedUrls: string[];
} {
  let i = 0;
  const prompts: string[] = [];
  const infos: string[] = [];
  const openedUrls: string[] = [];
  return {
    ask: async (prompt) => {
      prompts.push(prompt);
      return answers[i++] ?? "";
    },
    info: async (line) => {
      infos.push(line);
    },
    openUrl: async (url) => {
      openedUrls.push(url);
      if (opts.errorOnOpen) throw opts.errorOnOpen;
      return true;
    },
    prompts,
    infos,
    openedUrls,
  };
}

describe("PKCE + state", () => {
  test("generatePkce: base64url verifier, S256 challenge = base64url(sha256(verifier))", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, no padding
    expect(challenge).toBe(sha256(verifier));
  });

  test("generatePkce: fresh pair each call", () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
  });

  test("generateState: 32 bytes base64url, unique", () => {
    const s = generateState();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateState()).not.toBe(s);
  });

  test("base64url strips padding", () => {
    expect(base64url(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))).not.toContain("=");
  });
});

describe("buildAuthorizeUrl", () => {
  test("appends query params to the authorize endpoint", () => {
    const url = buildAuthorizeUrl("https://example.com/authorize", {
      client_id: "cid",
      code_challenge: "chal",
      code_challenge_method: "S256",
      state: "st",
    });
    expect(url).toBe("https://example.com/authorize?client_id=cid&code_challenge=chal&code_challenge_method=S256&state=st");
  });

  test("encodes reserved characters", () => {
    expect(buildAuthorizeUrl("https://e/a", { scope: "a b" })).toBe("https://e/a?scope=a+b");
  });
});

describe("loopback callback server", () => {
  test("delivers the code on a valid callback; shuts down after", async () => {
    const state = generateState();
    const server = await startLoopbackCallback({ state });
    expect(server.redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/);

    const res = await fetch(`${server.redirectUri}?code=abc&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(200);
    await res.text();

    expect(await server.code).toBe("abc");
    // Listening socket is gone right after delivering the code (a fresh
    // TCP connection is refused; fetch can't be used here because undici
    // reuses the keep-alive socket).
    const refused = await new Promise<boolean>((resolve) => {
      const sock = createConnection(server.port, "localhost");
      sock.once("error", () => resolve(true));
      sock.once("connect", () => {
        sock.destroy();
        resolve(false);
      });
    });
    expect(refused).toBe(true);
  });

  test("rejects state mismatch with 400 and keeps waiting", async () => {
    const state = generateState();
    const server = await startLoopbackCallback({ state });
    const bad = await fetch(`${server.redirectUri}?code=evil&state=wrong`);
    expect(bad.status).toBe(400);
    server.cancel();
    await expect(server.code).rejects.toThrow();
  });

  test("honors explicit port order (allowlist ports first)", async () => {
    const state = generateState();
    const server = await startLoopbackCallback({ state, ports: [1455, 1457, 0] });
    expect(server.port).toBe(1455);
    server.code.catch(() => {});
    server.cancel();
  });

  test("falls through to the next port when one fails to bind", async () => {
    // Privileged port 1 refuses binding for non-root users, so we fall
    // through to the next entry. (A second server on the same port is not
    // enough: macOS + Bun double-binds via SO_REUSEPORT.)
    const server = await startLoopbackCallback({ state: generateState(), ports: [1, 1456] });
    expect(server.port).toBe(1456);
    server.code.catch(() => {});
    server.cancel();
  });

  test("cancel() rejects the pending code promise", async () => {
    const server = await startLoopbackCallback({ state: generateState() });
    server.cancel();
    await expect(server.code).rejects.toThrow(/cancel/i);
  });
});

describe("manual-paste race", () => {
  test("paste wins on a headless box (openUrl fails): manual URL shown, code read via ask", async () => {
    const io = ioDouble(["pasted-code", ""], { errorOnOpen: new Error("no browser") });
    const state = generateState();
    const server = await startLoopbackCallback({ state });
    const code = await raceForCode(io, { authorizeUrl: "https://host.example/authorize", callback: server, manualUrl: "https://host.example/callback-manual" });
    expect(code).toBe("pasted-code");
    expect(io.openedUrls).toHaveLength(1);
    expect(io.infos.join("\n")).toContain("https://host.example/callback-manual");
    // Paste lines end on an empty line.
    expect(io.prompts.length).toBeGreaterThanOrEqual(1);
  });

  test("multi-line paste is joined until the empty line", async () => {
    const io = ioDouble(["part1", "part2", "", ""], { errorOnOpen: new Error("no browser") });
    const server = await startLoopbackCallback({ state: generateState() });
    const code = await raceForCode(io, { authorizeUrl: "https://m/authorize", callback: server, manualUrl: "https://m/cb" });
    expect(code).toBe("part1part2");
  });

  test("browser path (openUrl succeeds): no paste prompt, callback delivers, narration shows", async () => {
    const io = ioDouble([]);
    const state = generateState();
    const server = await startLoopbackCallback({ state });
    const raced = raceForCode(io, { authorizeUrl: "https://m/authorize", callback: server, manualUrl: "https://m/cb" });
    await fetch(`${server.redirectUri}?code=browser-code&state=${encodeURIComponent(state)}`);
    expect(await raced).toBe("browser-code");
    expect(io.prompts).toEqual([]); // no paste prompt unless needed (issue #150)
    expect(io.infos.join("\n")).toContain("waiting for the authorization");
    expect(io.infos.join("\n")).toContain("✓ Authorization code received");
  });

  test("browser path failure (timeout) falls back to the manual paste prompt", async () => {
    const io = ioDouble(["late-paste", ""]);
    const server = await startLoopbackCallback({ state: generateState(), timeoutMs: 50 });
    const code = await raceForCode(io, { authorizeUrl: "https://m/authorize", callback: server, manualUrl: "https://m/cb" });
    expect(code).toBe("late-paste");
    expect(io.infos.join("\n")).toContain("https://m/cb");
    expect(io.prompts.length).toBeGreaterThanOrEqual(1);
  });

  test("empty paste on the headless path settles with NO_CODE after the attempts", async () => {
    const io = ioDouble(["", ""], { errorOnOpen: new Error("no browser") });
    const server = await startLoopbackCallback({ state: generateState() });
    const code = await raceForCode(io, { authorizeUrl: "https://m/authorize", callback: server, manualUrl: "https://m/cb" });
    expect(code).toBe("");
  });

  test("loopback redirect wins over a slow paste: server code returned, prompt visibly resolves", async () => {
    // Paste path blocks (user is off opening the browser); callback resolves.
    const io: AuthorizationIo = {
      ask: () => new Promise<string>(() => {}), // never answers
      info: async () => {},
    };
    const state = generateState();
    const server = await startLoopbackCallback({ state });
    const raced = raceForCode(io, { authorizeUrl: "https://m/authorize", callback: server, manualUrl: "https://m/cb" });
    await fetch(`${server.redirectUri}?code=browser-code&state=${encodeURIComponent(state)}`);
    expect(await raced).toBe("browser-code");
  });

  test("headless callback win narrates the received code while a paste is pending", async () => {
    const infos: string[] = [];
    const io: AuthorizationIo = {
      ask: () => new Promise<string>(() => {}), // never answers
      info: async (line) => {
        infos.push(line);
      },
    };
    const state = generateState();
    const server = await startLoopbackCallback({ state });
    const raced = raceForCode(io, { authorizeUrl: "https://m/a", callback: server, manualUrl: "https://m/cb" });
    await fetch(`${server.redirectUri}?code=cb-code&state=${encodeURIComponent(state)}`);
    expect(await raced).toBe("cb-code");
    expect(infos.join("\n")).toContain("✓ Authorization code received");
  });

  test("openUrl receives the authorize URL, not the loopback redirect", async () => {
    const io = ioDouble(["pasted", "", ""], { errorOnOpen: new Error("no browser") });
    const server = await startLoopbackCallback({ state: generateState() });
    await raceForCode(io, { authorizeUrl: "https://m/authorize", callback: server, manualUrl: "https://m/cb" });
    expect(io.openedUrls).toEqual(["https://m/authorize"]);
  });

  test("a stray empty paste is re-prompted before settling", async () => {
    // First paste attempt: accidental empty line. Second attempt: the code.
    const io = ioDouble(["", "second-attempt", ""], { errorOnOpen: new Error("no browser") });
    const server = await startLoopbackCallback({ state: generateState() });
    const code = await raceForCode(io, { authorizeUrl: "https://m/a", callback: server, manualUrl: "https://m/cb" });
    expect(code).toBe("second-attempt");
  });

  test("provider error param on the callback settles the race with NO_CODE", async () => {
    const io = ioDouble([]);
    const state = generateState();
    const server = await startLoopbackCallback({ state });
    const raced = raceForCode(io, { authorizeUrl: "https://m/a", callback: server, manualUrl: "https://m/cb" });
    await fetch(`${server.redirectUri}?error=access_denied&state=${encodeURIComponent(state)}`);
    expect(await raced).toBe("");
  });

  test("cancelled callback settles the race with NO_CODE", async () => {
    const io = ioDouble(["", ""]); // nothing pasted
    const server = await startLoopbackCallback({ state: generateState() });
    const raced = raceForCode(io, { authorizeUrl: "https://m/authorize", callback: server, manualUrl: "https://m/cb" });
    server.cancel();
    expect(await raced).toBe("");
  });

  test("works without openUrl on the io (older clients)", async () => {
    const io = ioDouble(["pasted", ""]);
    delete (io as Partial<AuthorizationIo>).openUrl;
    const server = await startLoopbackCallback({ state: generateState() });
    const code = await raceForCode(io, { authorizeUrl: "https://m/authorize", callback: server, manualUrl: "https://m/cb" });
    expect(code).toBe("pasted");
  });
});

describe("ToS warning", () => {
  test("requires explicit acknowledgement; y/yes pass, anything else fails", async () => {
    expect(await confirmToSWarning(ioDouble(["y"]))).toBe(true);
    expect(await confirmToSWarning(ioDouble(["yes"]))).toBe(true);
    expect(await confirmToSWarning(ioDouble(["n"]))).toBe(false);
  });

  test("the warning text mentions ToS / client_id reuse", () => {
    expect(TOS_WARNING).toMatch(/terms/i);
    expect(TOS_WARNING).toMatch(/client/i);
  });
});
