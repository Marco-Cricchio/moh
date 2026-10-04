import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools, fetchUrlText, requestPinnedUrl, resolveVerifiedUrl, type PinnedResponse } from "../src/builtin-tools";
// #304: classification unit-tested directly.
import { isSuiteLike } from "../src/builtin-tools";
import type { ToolContext } from "../src/types";

const cwd = mkdtempSync(join(tmpdir(), "moh-tools-"));
const ctx: ToolContext = {
  signal: new AbortController().signal,
  cwd,
  onProgress: () => {},
};

const tools = builtinTools();

describe("built-in tools", () => {
  test("bash runs a command and captures output", async () => {
    const out = await tools.bash.execute({ command: "echo hello-tools" }, ctx);
    expect(out.trim()).toBe("hello-tools");
  });

  test("bash non-zero exit is a failed tool_result", async () => {
    await expect(
      tools.bash.execute({ command: "exit 3" }, ctx),
    ).rejects.toThrow(/exit code 3/);
  });

  // #237: helper so a hung tool fails the test instead of hanging the suite.
  const withDeadline = <T>(p: PromiseLike<T>, ms = 4_000): Promise<T> =>
    Promise.race([
      Promise.resolve(p),
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error("test deadline exceeded — tool never settled")), ms)),
    ]);

  test("bash timeout kills a fast-reaping parent's descendants (#297)", async () => {
    // #297: on macOS (no setsid) killTree raced — the parent was SIGKILLed
    // before the async killer enumerated its children, so re-parented
    // descendants survived the timeout as orphans.
    // The child reports its own pid: `pgrep -f` self-matches its checking
    // wrapper on Linux, so it cannot be used as the survival probe.
    const dir = mkdtempSync(join(tmpdir(), "moh-297-"));
    const pidFile = join(dir, "child.pid");
    const pending = tools.bash.execute(
      {
        command: `bun -e 'const t=setInterval(()=>{},1000); setTimeout(()=>clearInterval(t),60000)' & echo $! > ${pidFile}; wait`,
        timeoutMs: 400,
      },
      { ...ctx, cwd: dir },
    );
    await expect(withDeadline(Promise.resolve(pending), 4_000)).rejects.toThrow(/timed out/);
    const childPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    expect(Number.isInteger(childPid)).toBe(true);
    let alive = true;
    for (let i = 0; i < 10 && alive; i++) {
      await Bun.sleep(150);
      try { process.kill(childPid, 0); } catch { alive = false; }
    }
    expect(alive).toBe(false); // the descendant died with the timed-out command
  });

  test("bash abort settles the tool promptly and kills the process tree (#237)", async () => {
    const controller = new AbortController();
    const abortCtx: ToolContext = { ...ctx, signal: controller.signal };
    const MARKER = "moh-237-orphan-marker";
    const pending = tools.bash.execute(
      { command: `sleep 60 # ${MARKER}\nsleep 60 & # ${MARKER}\necho started` },
      abortCtx,
    );
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    // Settles (rejects) promptly instead of hanging on pipes held by children.
    await expect(withDeadline(Promise.resolve(pending), 3_000)).rejects.toThrow(/cancelled/);
    // The children (foreground + background sleep) are dead shortly after.
    let survivors = "";
    for (let i = 0; i < 10 && survivors === ""; i++) {
      await Bun.sleep(150);
      survivors = Bun.spawnSync(["bash", "-c", `pgrep -f "^sleep 60 # ${MARKER}" || true`]).stdout.toString().trim();
    }
    expect(survivors).toBe("");
  });

  test("bash resolves normally when a background child still holds the pipes (#237)", async () => {
    const out = await withDeadline(
      Promise.resolve(tools.bash.execute({ command: "sleep 60 & echo hi" }, ctx)),
      3_000,
    );
    expect(out.trim()).toBe("hi");
  });

  test("bash timeout rejects instead of hanging on pipe holders (#237)", async () => {
    await expect(
      withDeadline(
        Promise.resolve(tools.bash.execute({ command: "sleep 60 & sleep 60", timeoutMs: 300 }, ctx)),
        3_000,
      ),
    ).rejects.toThrow(/timed out/);
  });

  test("read returns file content; write then edit replace exactly", async () => {
    const path = join(cwd, "f.txt");
    await tools.write.execute({ path, content: "alpha beta gamma" }, ctx);
    expect(await tools.read.execute({ path }, ctx)).toBe("alpha beta gamma");

    await tools.edit.execute(
      { path, oldText: "beta", newText: "BETA" },
      ctx,
    );
    expect(await tools.read.execute({ path }, ctx)).toBe("alpha BETA gamma");

    // Non-matching edit fails with a helpful message.
    await expect(
      tools.edit.execute({ path, oldText: "nope", newText: "x" }, ctx),
    ).rejects.toThrow(/not found/);
  });

  test("read rejects out-of-tree and missing paths", async () => {
    await expect(
      tools.read.execute({ path: join(tmpdir(), "..", "..", "etc", "hostname") }, ctx),
    ).rejects.toThrow();
    await expect(tools.read.execute({ path: join(cwd, "missing") }, ctx)).rejects.toThrow();
  });

  // #1186: a directory `path` and a nonexistent `path` used to surface as
  // raw errno lines (EISDIR / ENOENT from the raw open). Name the miss so
  // the model can correct course without re-probing.
  test("read names a directory path and a missing path instead of throwing errno", async () => {
    mkdirSync(join(cwd, "adir"), { recursive: true });
    await expect(
      tools.read.execute({ path: join(cwd, "adir") }, ctx),
    ).rejects.toThrow(/path is a directory, not a file/);
    await expect(
      tools.read.execute({ path: join(cwd, "adir", "missing.ts") }, ctx),
    ).rejects.toThrow(/no such path: /);
  });

  test("grep names a nonexistent path instead of a raw ENOENT (#1186)", async () => {
    await expect(
      tools.grep.execute({ path: join(cwd, "no", "such", "dir"), pattern: "x" }, ctx),
    ).rejects.toThrow(/no such path: /);
  });

  test("glob finds files by pattern", async () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "1");
    writeFileSync(join(cwd, "src", "b.md"), "2");
    const out = await tools.glob.execute({ pattern: "src/*.ts" }, ctx);
    expect(out).toContain("a.ts");
    expect(out).not.toContain("b.md");
  });

  test("grep matches lines by regex across files", async () => {
    writeFileSync(join(cwd, "src", "a.ts"), "const x = 1;\n// TODO fix\n");
    const out = await tools.grep.execute({ pattern: "TODO" }, ctx);
    expect(out).toContain("TODO fix");
    const none = await tools.grep.execute({ pattern: "zzzz" }, ctx);
    expect(none.trim()).toBe("");
  });

  // #731: a file `path` is searched directly — previously the scan threw
  // ENOTDIR, which was ~40% of all observed tool failures.
  test("grep with a single file as path searches that file (#731)", async () => {
    const out = await tools.grep.execute({ path: "src/a.ts", pattern: "TODO" }, ctx);
    expect(out).toContain("src/a.ts:2:// TODO fix");
    const none = await tools.grep.execute({ path: "src/a.ts", pattern: "zzzz" }, ctx);
    expect(none.trim()).toBe("");
  });

  // #731 (yolo): a meta-free pattern naming a single file answered the
  // ENOTDIR of scanning with a file as cwd instead of the file itself.
  test("glob with a literal file pattern returns the file (#731)", async () => {
    const out = await tools.glob.execute({ pattern: "src/a.ts" }, ctx);
    expect(out).toContain("a.ts");
    const miss = await tools.glob.execute({ pattern: "src/missing.ts" }, ctx);
    expect(miss.trim()).toBe("");
  });

  // SEC-03 regression: symlink escape at execution time.
  test("write through an in-root symlink pointing outside is rejected (SEC-03)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "moh-outside-"));
    const link = join(cwd, "evil-link");
    // A directory symlink makes `link/f.txt` a genuine valid write outside
    // the project without the execution-time resolved-path guard.
    try { symlinkSync(outside, link); } catch { return; } // no symlink permission → skip
    await expect(
      tools.write.execute({ path: join(cwd, "evil-link", "f.txt"), content: "x" }, ctx),
    ).rejects.toThrow(/outside project root/);
    await expect(
      tools.read.execute({ path: "evil-link/f.txt" }, ctx),
    ).rejects.toThrow(/outside project root/);
    expect(Bun.file(join(outside, "f.txt")).size).toBe(0);
  });

  test("plain in-root writes still work, including new nested dirs (SEC-03)", async () => {
    await tools.write.execute({ path: join(cwd, "new-dir", "sub", "f.txt"), content: "ok" }, ctx);
    expect(await tools.read.execute({ path: join(cwd, "new-dir", "sub", "f.txt") }, ctx)).toBe("ok");
  });

  // SEC-07 regression: glob pattern escape.
  test("glob rejects patterns escaping the root (SEC-07)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "moh-outside2-"));
    writeFileSync(join(outside, "secret.txt"), "x");
    await expect(tools.glob.execute({ pattern: "../out/**" }, ctx)).rejects.toThrow(/escapes the project root/);
    await expect(tools.glob.execute({ pattern: outside + "/**" }, ctx)).rejects.toThrow(/escapes the project root/);
  });

  test("glob filters symlinked matches pointing outside the root (SEC-07)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "moh-outside3-"));
    writeFileSync(join(outside, "leak.txt"), "x");
    try { symlinkSync(join(outside, "leak.txt"), join(cwd, "leak-link.txt")); } catch { return; }
    const out = await tools.glob.execute({ pattern: "leak*" }, ctx);
    expect(out).not.toContain("leak-link.txt");
  });

  test("grep does not read an in-root symlink pointing outside (SEC-03)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "moh-outside-grep-"));
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "SECRETMARKER");
    try { symlinkSync(secret, join(cwd, "grep-leak.txt")); } catch { return; }
    expect(await tools.grep.execute({ pattern: "SECRETMARKER" }, ctx)).not.toContain("SECRETMARKER");
  });

  // #377: yolo scope — canonical resolution stays, containment lifts.
  const yoloCtx: ToolContext = { ...ctx, filesystemScope: "unrestricted" };

  test("yolo: read/write/edit outside the project root succeed (#377)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "moh-yolo-"));
    const file = join(outside, "f.txt");
    await tools.write.execute({ path: file, content: "yolo" }, yoloCtx);
    expect(await tools.read.execute({ path: file }, yoloCtx)).toContain("yolo");
    await tools.edit.execute({ path: file, oldText: "yolo", newText: "yolo2" }, yoloCtx);
    expect(readFileSync(file, "utf8")).toBe("yolo2");
    // project scope is unchanged for the same paths.
    await expect(tools.read.execute({ path: file }, ctx)).rejects.toThrow(/outside project root/);
  });

  test("yolo: grep targets an outside directory (#377)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "moh-yolo-grep-"));
    writeFileSync(join(outside, "s.txt"), "YOLOMARKER");
    expect(await tools.grep.execute({ pattern: "YOLOMARKER", path: outside }, yoloCtx)).toContain("YOLOMARKER");
    await expect(tools.grep.execute({ pattern: "YOLOMARKER", path: outside }, ctx)).rejects.toThrow(/outside project root/);
  });

  test("yolo: glob enumerates an outside directory via absolute pattern (#377)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "moh-yolo-glob-"));
    writeFileSync(join(outside, "findme.txt"), "x");
    const out = await tools.glob.execute({ pattern: join(outside, "*.txt") }, yoloCtx);
    expect(out).toContain("findme.txt");
    await expect(tools.glob.execute({ pattern: join(outside, "*.txt") }, ctx)).rejects.toThrow(/escapes the project root/);
  });

  test("yolo: paths are still resolved canonically — a lexical in-root path that traverses an outside symlink resolves to the target (#377)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "moh-yolo-link-"));
    writeFileSync(join(outside, "target.txt"), "CANONICAL");
    const link = join(cwd, "yolo-link");
    try { symlinkSync(outside, link); } catch { return; } // no symlink permission → skip
    expect(await tools.read.execute({ path: "yolo-link/target.txt" }, yoloCtx)).toContain("CANONICAL");
  });

  test("todo stores and returns the task list", async () => {
    const todos = [{ content: "first", status: "pending" as const }, { content: "second", status: "in_progress" as const }];
    const out = await tools.todo.execute({ todos }, ctx);
    expect(out).toContain("[ ] first");
    expect(out).toContain("[~] second");
    const next = await tools.todo.execute(
      { todos: [{ content: "first", status: "done" as const }] },
      ctx,
    );
    expect(next).toContain("[x] first");
  });

  test("fetch retrieves a URL body through the integrated pinned path", async () => {
    const out = await fetchUrlText(
      { url: "https://example.test/" },
      ctx.signal,
      {
        lookup: async () => [{ address: "203.0.113.7", family: 4 }],
        requestPinned: async (_url, address) => ({
          status: 200,
          headers: new Headers(),
          readBody: async () => `Example body from ${address.address}`,
          discard: () => {},
        }),
      },
    );
    expect(out).toBe("Example body from 203.0.113.7");
  });

  // #1079: the failure text of a fetch that must reject.
  const failureOf = (pending: Promise<string>): Promise<string> =>
    pending.then(
      () => { throw new Error("expected the fetch to fail"); },
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );

  // #1079: a non-2xx is a diagnostic, not a blank refusal. What the server
  // said (body + the headers that carry the reason) is what lets the model
  // tell a quota wall from a typo, instead of re-dialling blindly.
  describe("non-2xx failures carry the server's explanation (#1079)", () => {
    const failing = (status: number, headers: Record<string, string>, body: string) =>
      fetchUrlText(
        { url: "https://api.example.test/repos/x/issues/1" },
        ctx.signal,
        {
          lookup: async () => [{ address: "203.0.113.7", family: 4 }],
          requestPinned: async (): Promise<PinnedResponse> => ({
            status,
            headers: new Headers(headers),
            readBody: async () => body,
            discard: () => {},
          }),
        },
      );

    test("a rate-limited 403 keeps the body, the quota headers and a verdict", async () => {
      const text = await failureOf(failing(
        403,
        { "content-type": "application/json", "retry-after": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790708565" },
        JSON.stringify({ message: "API rate limit exceeded for 1.2.3.4." }),
      ));
      // The classifier in the tool runner matches this line's exact shape.
      expect(text.split("\n")[0]).toBe("HTTP 403 for https://api.example.test/repos/x/issues/1 · rate-limited");
      expect(text).toContain("API rate limit exceeded for 1.2.3.4.");
      expect(text).toContain("retry-after: 60");
      expect(text).toContain("x-ratelimit-remaining: 0");
    });

    test("a 401 names the missing credential and the challenge header", async () => {
      const text = await failureOf(failing(401, { "www-authenticate": 'Bearer realm="api"' }, "Unauthorized"));
      expect(text).toContain("requires authentication");
      expect(text).toContain("www-authenticate");
      expect(text).toContain("Unauthorized");
    });

    test("a 404 explains what a missing ref means without inventing a cause", async () => {
      const text = await failureOf(failing(404, { "content-type": "application/json" }, JSON.stringify({ message: "Branch not found" })));
      expect(text).toContain("not found");
      expect(text).toContain("Branch not found");
    });

    test("a 500 after the retry is marked transient and names the attempt count", async () => {
      let dials = 0;
      const text = await failureOf(fetchUrlText(
        { url: "https://api.example.test/x" },
        ctx.signal,
        {
          lookup: async () => [{ address: "203.0.113.7", family: 4 }],
          requestPinned: async (): Promise<PinnedResponse> => {
            dials++;
            return { status: 500, headers: new Headers(), readBody: async () => "boom", discard: () => {} };
          },
        },
      ));
      expect(dials).toBe(2);
      expect(text.split("\n")[0]).toBe("HTTP 500 for https://api.example.test/x · transient");
      expect(text).toContain("failed twice in a row");
      expect(text).toContain("boom");
    });

    test("the body excerpt is capped so one error page cannot flood the turn", async () => {
      const text = await failureOf(failing(500, {}, "x".repeat(50_000)));
      expect(text).toContain("… [truncated]");
      expect(text.length).toBeLessThan(5_000);
    });

    test("an unreadable error body still reports the status and headers", async () => {
      const text = await fetchUrlText(
        { url: "https://api.example.test/x" },
        ctx.signal,
        {
          lookup: async () => [{ address: "203.0.113.7", family: 4 }],
          requestPinned: async (): Promise<PinnedResponse> => ({
            status: 502,
            headers: new Headers({ "content-type": "text/html" }),
            readBody: async () => { throw new Error("fetch response aborted"); },
            discard: () => {},
          }),
        },
      ).then(
        () => { throw new Error("expected the fetch to fail"); },
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(text).toMatch(/^HTTP 502 for/);
      expect(text).toContain("content-type: text/html");
      expect(text).not.toContain("fetch response aborted");
    });
  });

  // #1079: one retry on a transient failure, and a redirect budget that
  // matches real site chains. Both are bounded: no retry loop, no hop loop.
  describe("retry and redirect budgets (#1079)", () => {
    test("a transport failure is dialled once more, then reported as transient", async () => {
      let dials = 0;
      const text = await fetchUrlText(
        { url: "https://api.example.test/x" },
        ctx.signal,
        {
          lookup: async () => [{ address: "203.0.113.7", family: 4 }],
          requestPinned: async (): Promise<PinnedResponse> => {
            dials++;
            throw new Error("ECONNRESET: the socket was closed");
          },
        },
      ).then(
        () => { throw new Error("expected the fetch to fail"); },
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(dials).toBe(2);
      expect(text).toMatch(/^fetch: transient network failure after 2 attempts: ECONNRESET/);
    });

    test("a 5xx whose retry dies in transport is two dials, not three", async () => {
      let dials = 0;
      const text = await failureOf(fetchUrlText(
        { url: "https://api.example.test/x" },
        ctx.signal,
        {
          lookup: async () => [{ address: "203.0.113.7", family: 4 }],
          requestPinned: async (): Promise<PinnedResponse> => {
            dials++;
            if (dials === 1) return { status: 503, headers: new Headers({ "retry-after": "0" }), readBody: async () => "down", discard: () => {} };
            throw new Error("ECONNRESET: the socket was closed");
          },
        },
      ));
      expect(dials).toBe(2);
      expect(text).toBe("fetch: transient network failure after 2 attempts: ECONNRESET: the socket was closed");
    });

    test("a recovered retry returns the body with no scar on the result", async () => {
      let dials = 0;
      const text = await fetchUrlText(
        { url: "https://api.example.test/x" },
        ctx.signal,
        {
          lookup: async () => [{ address: "203.0.113.7", family: 4 }],
          requestPinned: async (): Promise<PinnedResponse> => {
            dials++;
            if (dials === 1) return { status: 503, headers: new Headers({ "retry-after": "0" }), readBody: async () => "later", discard: () => {} };
            return { status: 200, headers: new Headers(), readBody: async () => "RECOVERED", discard: () => {} };
          },
        },
      );
      expect(text).toBe("RECOVERED");
      expect(dials).toBe(2);
    });

    test("a 404 is never retried — the URL will not change its mind", async () => {
      let dials = 0;
      await fetchUrlText(
        { url: "https://api.example.test/x" },
        ctx.signal,
        {
          lookup: async () => [{ address: "203.0.113.7", family: 4 }],
          requestPinned: async (): Promise<PinnedResponse> => {
            dials++;
            return { status: 404, headers: new Headers(), readBody: async () => "nope", discard: () => {} };
          },
        },
      ).catch(() => undefined);
      expect(dials).toBe(1);
    });

    test("a cancelled turn is not retried", async () => {
      const controller = new AbortController();
      let dials = 0;
      const text = await fetchUrlText(
        { url: "https://api.example.test/x" },
        controller.signal,
        {
          lookup: async () => [{ address: "203.0.113.7", family: 4 }],
          requestPinned: async (): Promise<PinnedResponse> => {
            dials++;
            controller.abort();
            throw new Error("fetch aborted");
          },
        },
      ).then(
        () => { throw new Error("expected the fetch to fail"); },
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(dials).toBe(1);
      expect(text).toBe("fetch aborted");
    });

    test("a failure after a redirect names the URL that actually failed", async () => {
      const text = await failureOf(fetchUrlText(
        { url: "https://loop.test/0" },
        ctx.signal,
        {
          lookup: async () => [{ address: "203.0.113.7", family: 4 }],
          requestPinned: async (url: URL): Promise<PinnedResponse> =>
            url.pathname === "/0"
              ? { status: 302, headers: new Headers({ location: "https://loop.test/moved" }), readBody: async () => "hop", discard: () => {} }
              : { status: 404, headers: new Headers(), readBody: async () => "gone", discard: () => {} },
        },
      ));
      expect(text).toContain("fetched: https://loop.test/moved");
      expect(text).toContain("not found");
    });

    test("a chain of ten redirects is followed and an eleventh hop is refused", async () => {
      const chain = (status: number | null) => async (url: URL): Promise<PinnedResponse> => {
        const hop = Number(new URL(url).pathname.slice(1));
        if (status !== null && hop === 10) return { status: 200, headers: new Headers(), readBody: async () => "END", discard: () => {} };
        return {
          status: 302,
          headers: new Headers({ location: `https://loop.test/${hop + 1}` }),
          readBody: async () => "hop",
          discard: () => {},
        };
      };
      const deps = (fn: (url: URL) => Promise<PinnedResponse>) => ({
        lookup: async () => [{ address: "203.0.113.7", family: 4 }],
        requestPinned: (url: URL) => fn(url),
      });
      expect(await fetchUrlText({ url: "https://loop.test/0" }, ctx.signal, deps(chain(200)))).toBe("END");
      const text = await failureOf(fetchUrlText({ url: "https://loop.test/0" }, ctx.signal, deps(chain(null))));
      expect(text).toContain("too many redirects (> 10)");
    });
  });

  // SEC-05 regression suite.
  test("fetch rejects non-http schemes (file:, data:)", async () => {
    await expect(tools.fetch.execute({ url: "file:///etc/hosts" }, ctx)).rejects.toThrow(
      /only http\/https URLs are supported \(got "file:"\) — use the read tool for local files/,
    );
    await expect(tools.fetch.execute({ url: "data:text/plain,x" }, ctx)).rejects.toThrow(/got "data:"/);
  });

  test("fetch blocks private/loopback hosts by default (SEC-05)", async () => {
    await expect(tools.fetch.execute({ url: "http://localhost:1/" }, ctx)).rejects.toThrow(/private\/loopback/);
    await expect(tools.fetch.execute({ url: "http://169.254.169.254/latest/meta-data" }, ctx)).rejects.toThrow(/private\/loopback/);
    await expect(tools.fetch.execute({ url: "http://10.0.0.5/x" }, ctx)).rejects.toThrow(/private\/loopback/);
    await expect(tools.fetch.execute({ url: "http://[fe80::1]/" }, ctx)).rejects.toThrow(/private\/loopback/);
  });

  test("fetch re-checks redirects (SEC-05): a hop to a private target is blocked", async () => {
    // A local listener that answers with a redirect to the metadata IP.
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/x" } }),
    });
    try {
      await expect(tools.fetch.execute({ url: `http://localhost:${server.port}/redir` }, ctx)).rejects.toThrow();
    } finally {
      server.stop(true);
    }
  });

  test("the pinned transport is hermetic and settles its body repeatedly (#922)", async () => {
    // No DNS and no public network: the URL keeps a fake hostname while
    // the transport must dial the already-verified loopback address. This
    // exercises the real Host/SNI-preserving pin seam, not global fetch.
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => new Response(`${new URL(request.url).pathname}:${request.headers.get("host")}`),
    });
    try {
      for (let i = 0; i < 50; i++) {
        const response = await requestPinnedUrl(
          new URL(`http://verified.invalid:${server.port}/body-${i}`),
          { address: "127.0.0.1", family: 4 },
          ctx.signal,
        );
        expect(response.status).toBe(200);
        expect(await response.readBody()).toBe(`/body-${i}:verified.invalid:${server.port}`);
      }
    } finally {
      server.stop(true);
    }
  });

  test("the pinned transport decodes compressed response bodies (#922)", async () => {
    const compressed = gzipSync("COMPRESSED-OK");
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(compressed, { headers: { "content-encoding": "gzip" } }),
    });
    try {
      const response = await requestPinnedUrl(
        new URL(`http://verified.invalid:${server.port}/gzip`),
        { address: "127.0.0.1", family: 4 },
        ctx.signal,
      );
      expect(await response.readBody()).toBe("COMPRESSED-OK");
    } finally {
      server.stop(true);
    }
  });

  test("abort after headers rejects a pinned body read promptly (#922)", async () => {
    const server = createNetServer((socket) => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n");
        // Deliberately never finish the chunked body.
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("test server has no TCP address");
    const controller = new AbortController();
    try {
      const response = await requestPinnedUrl(
        new URL(`http://verified.invalid:${address.port}/slow`),
        { address: "127.0.0.1", family: 4 },
        controller.signal,
      );
      const started = Date.now();
      const body = response.readBody();
      setTimeout(() => controller.abort(), 25);
      await expect(body).rejects.toThrow(/fetch (?:response )?aborted/);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // #1075: #922 promises that a truncated compressed response rejects instead
  // of hanging — not *which* phase reports it. The reset can land after the
  // head is assembled (readBody rejects, as the original assertion assumed) or
  // while the response is still being built (requestPinnedUrl itself rejects,
  // so readBody is never reached and the outer await threw). The split rides
  // the server's write coalescing, not the scheduler, so no timing of the test
  // can pin one phase for good. Both paths report the reset itself — the
  // transport's "socket connection was closed" or its "fetch response
  // aborted" recorded for the header→consume gap — so assert the invariant
  // that holds in both: settling with a value is the failure, and a rejection
  // naming the truncation from either phase is the pass.
  const truncationOf = async (
    port: number,
    path: string,
  ): Promise<{ settled: string } | { rejection: string }> => {
    let response: Awaited<ReturnType<typeof requestPinnedUrl>>;
    try {
      response = await requestPinnedUrl(
        new URL(`http://verified.invalid:${port}${path}`),
        { address: "127.0.0.1", family: 4 },
        ctx.signal,
      );
    } catch (error) {
      return { rejection: String(error) };
    }
    try {
      return { settled: await response.readBody() };
    } catch (error) {
      return { rejection: String(error) };
    }
  };

  test("a truncated compressed response rejects instead of hanging (#922)", async () => {
    const server = createNetServer((socket) => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 100\r\n\r\n");
        socket.write(Buffer.from([0x1f, 0x8b, 0x08]));
        socket.destroy();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("test server has no TCP address");
    try {
      // The hang half of the claim: a transport that never settles must fail
      // here rather than park the suite.
      const outcome = await withDeadline(truncationOf(address.port, "/truncated"));
      expect("rejection" in outcome, `truncation settled: ${JSON.stringify(outcome)}`).toBe(true);
      // The truncation must be the *reported* cause, not an incidental error:
      // the transport's own reset, or the gzip decoder's truncated stream.
      expect(outcome).toMatchObject({
        rejection: expect.stringMatching(/socket connection was closed|aborted|unexpected end of file/),
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  /**
   * #1075: this is where #922's fifth transport claim — a *mid-body*
   * truncation — was asserted with its own server, pumping the head plus
   * three gzip bytes before `destroy()`. It was red about one run in six, and
   * it was not the transport forgetting to fail: the reset lands either after
   * the head is assembled (`readBody` rejects, the path that test asserted
   * exclusively) or while the response is still being built
   * (`requestPinnedUrl` itself rejects, so `readBody` is never reached and
   * the outer `await` threw). That second phase is request-construction, not
   * body consumption — a boundary #1075's brief deliberately leaves alone —
   * and controlling it is not a matter of timing: a census over ~800 resets
   * of the exact recipe with no delay, 5 ms, 10 ms and 20 ms before
   * `destroy()` gives 0–7% response-phase rejections for *every* delay,
   * including zero, so neither a delay nor a synchronisation in the test can
   * pin the phase. The claim is a strict subset of "a truncated compressed
   * response rejects instead of hanging", which the test above asserts across
   * both phases, and of this one, asserted deterministically for the sibling
   * case.
   */
  test("a response reset before readBody is remembered and rejects later (#922)", async () => {
    const server = createNetServer((socket) => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial");
        setTimeout(() => socket.destroy(), 10);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("test server has no TCP address");
    try {
      const response = await requestPinnedUrl(
        new URL(`http://verified.invalid:${address.port}/reset`),
        { address: "127.0.0.1", family: 4 },
        ctx.signal,
      );
      await Bun.sleep(25);
      await expect(response.readBody()).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("fetch resolution is single-shot and rejects every private answer (#697)", async () => {
    let calls = 0;
    const resolveOnce = (answers: { address: string; family: number }[]) =>
      resolveVerifiedUrl("https://rebind.test/x", async (host) => {
        calls++;
        expect(host).toBe("rebind.test");
        return answers;
      });

    const verified = await resolveOnce([{ address: "203.0.113.7", family: 4 }]);
    expect(verified?.address).toEqual({ address: "203.0.113.7", family: 4 });
    expect(calls).toBe(1);

    // If any answer is private, reject the entire resolution: choosing a
    // public sibling while retaining a private alternative is unsafe.
    await expect(resolveOnce([
      { address: "203.0.113.7", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ])).rejects.toThrow(/resolves to private address/);
    expect(calls).toBe(2);
  });

  test("the integrated redirect loop verifies every hop before dialling it (#697)", async () => {
    const resolved: string[] = [];
    const dialled: string[] = [];
    const discarded: string[] = [];
    const response = (status: number, headers: Record<string, string>, body: string): PinnedResponse => ({
      status,
      headers: new Headers(headers),
      readBody: async () => body,
      discard: () => discarded.push(body),
    });

    const text = await fetchUrlText(
      { url: "https://first.test/start" },
      ctx.signal,
      {
        lookup: async (host) => {
          resolved.push(host);
          return [{ address: host === "first.test" ? "203.0.113.7" : "198.51.100.9", family: 4 }];
        },
        requestPinned: async (url, address) => {
          dialled.push(`${url.hostname}@${address.address}`);
          return url.hostname === "first.test"
            ? response(302, { location: "https://second.test/final" }, "discard-me")
            : response(200, {}, "OK");
        },
      },
    );

    expect(text).toBe("OK");
    expect(resolved).toEqual(["first.test", "second.test"]);
    expect(dialled).toEqual(["first.test@203.0.113.7", "second.test@198.51.100.9"]);
    expect(discarded).toEqual(["discard-me"]);
  });

  test("a failed or empty DNS verification never falls through to another resolver (#697)", async () => {
    let dials = 0;
    const requestPinned = async (): Promise<PinnedResponse> => {
      dials++;
      throw new Error("must not dial");
    };
    await expect(fetchUrlText(
      { url: "https://missing.test/x" },
      ctx.signal,
      { lookup: async () => { throw new Error("NXDOMAIN"); }, requestPinned },
    )).rejects.toThrow(/DNS lookup failed.*NXDOMAIN/);
    await expect(fetchUrlText(
      { url: "https://empty.test/x" },
      ctx.signal,
      { lookup: async () => [], requestPinned },
    )).rejects.toThrow(/returned no addresses/);
    expect(dials).toBe(0);
  });

  test("MOH_FETCH_ALLOW_PRIVATE keeps resolving normally (no pinning) (#697)", async () => {
    // Opt-out path: no dispatcher pinning, behavior unchanged — a numeric
    // private URL is allowed through the plain fetch path.
    const { mock } = await import("bun:test");
    const prev = process.env.MOH_FETCH_ALLOW_PRIVATE;
    process.env.MOH_FETCH_ALLOW_PRIVATE = "1";
    try {
      let lookups = 0;
      mock.module("node:dns/promises", () => ({
        lookup: async () => {
          lookups++;
          return [{ address: "127.0.0.1", family: 4 }];
        },
      }));
      const srv = Bun.serve({ port: 0, fetch: () => new Response("LOCAL-OK") });
      try {
        const out = await tools.fetch.execute({ url: `http://127.0.0.1:${srv.port}/x` }, ctx);
        expect(out).toContain("LOCAL-OK");
        expect(lookups).toBe(0); // numeric host: no resolution, no pinning
      } finally {
        srv.stop(true);
      }
    } finally {
      if (prev === undefined) delete process.env.MOH_FETCH_ALLOW_PRIVATE;
      else process.env.MOH_FETCH_ALLOW_PRIVATE = prev;
      mock.restore();
    }
  });
});

describe("bash effective timeout (#300)", () => {
  test("resolver returns the valid arg, the default, and never a bogus value", () => {
    const resolve = tools.bash.timeoutMs as (args: unknown) => number;
    expect(resolve({ command: "sleep 1", timeoutMs: 120_000 })).toBe(120_000);
    expect(resolve({ command: "sleep 1" })).toBe(30_000);
    expect(resolve({ command: "sleep 1", timeoutMs: "soon" })).toBe(30_000);
    expect(resolve(null)).toBe(30_000);
  });

  test("execute applies the same resolution as the stamped event (invalid arg falls back to the default)", async () => {
    // A schema-invalid timeout must fail validation with 30000 as the
    // stamped limit, not the bogus value — resolver and execute agree.
    const resolve = tools.bash.timeoutMs as (args: unknown) => number;
    expect(resolve({ command: "ls", timeoutMs: -5 })).toBe(30_000);
  });
});

describe("bash re-run guard (#304)", () => {
  // A git repo cwd: the guard requires a stable git snapshot. A fake
  // Makefile makes `make test` (allowlisted suite head) slow-and-green
  // without running a real test framework.
  const repo = mkdtempSync(join(tmpdir(), "moh-304-"));
  const repoCtx: ToolContext = { ...ctx, cwd: repo };
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  Bun.spawnSync(["git", "config", "user.email", "t@t"], { cwd: repo });
  Bun.spawnSync(["git", "config", "user.name", "t"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "v1");
  const fakeSuite = (target: string, body: string) =>
    writeFileSync(join(repo, "Makefile"), `\n${target}:\n\t${body}\n`);
  const commit = (msg: string) => {
    Bun.spawnSync(["git", "add", "-A"], { cwd: repo });
    Bun.spawnSync(["git", "commit", "-qm", msg], { cwd: repo });
  };
  commit("init");

  // The rerunMinMs seam drops the #304 expense threshold to 100ms: the
  // fake suites run in ~200ms instead of the real 10s sleep.
  const guardTools = builtinTools({ rerunMinMs: 100 });

  test("an expensive successful suite-like run saves full output and intercepts the identical re-run", async () => {
    fakeSuite("test", "sleep 0.2 && echo '(pass) one'");
    const out = await guardTools.bash.execute({ command: "make test" }, repoCtx);
    expect(out).toContain("(pass) one");
    expect(out).toMatch(/\[full output saved: .+\]/);
    const file = out.match(/\[full output saved: (.+)\]/)?.[1]!;
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
    const again = await guardTools.bash.execute({ command: "make   test" }, repoCtx); // whitespace-normalized identity
    expect(again).toContain("not re-executed");
    expect(again).toMatch(/Full output saved at: .+/);
  }, 10_000);

  test("# fresh forces a real run and refreshes the saved output", async () => {
    fakeSuite("fresh", "sleep 0.2 && echo fresh-green");
    await guardTools.bash.execute({ command: "make fresh" }, repoCtx);
    const fresh = await guardTools.bash.execute({ command: "make fresh # fresh" }, repoCtx);
    expect(fresh).toContain("fresh-green");
    expect(fresh).not.toContain("not re-executed");
  }, 10_000);

  test("a different command runs for real even in the interception class", async () => {
    fakeSuite("other", "sleep 0.2 && echo other-green");
    await guardTools.bash.execute({ command: "make other" }, repoCtx);
    fakeSuite("other", "sleep 0.2 && echo other-green-2");
    commit("tweak");
    const out = await guardTools.bash.execute({ command: "make other" }, repoCtx);
    expect(out).toContain("other-green-2");
    expect(out).not.toContain("not re-executed");
  }, 10_000);

  test("no git repo: capture still helps, but nothing is ever intercepted", async () => {
    const plain = mkdtempSync(join(tmpdir(), "moh-304-nogit-"));
    const plainCtx: ToolContext = { ...ctx, cwd: plain };
    writeFileSync(join(plain, "Makefile"), "\ntest:\n\tsleep 0.2 && echo nogit\n");
    const out = await guardTools.bash.execute({ command: "make test" }, plainCtx);
    expect(out).toContain("nogit");
    const again = await guardTools.bash.execute({ command: "make test" }, plainCtx);
    expect(again).toContain("nogit");
    expect(again).not.toContain("not re-executed");
  }, 10_000);

  test("new sessions prune stale capture directories without affecting live pointers", () => {
    const root = mkdtempSync(join(tmpdir(), "moh-ledger-root-"));
    const stale = join(root, "bash-stale");
    mkdirSync(stale, { mode: 0o700 });
    utimesSync(stale, new Date(Date.now() - 11 * 60_000), new Date(Date.now() - 11 * 60_000));
    builtinTools({ ledgerRoot: root });
    expect(existsSync(stale)).toBe(false);
  });

  test("cheap commands never capture and never intercept", async () => {
    fakeSuite("cheap", "echo cheap-target");
    const out = await guardTools.bash.execute({ command: "make cheap" }, repoCtx);
    expect(out).not.toMatch(/\[full output saved/);
    const again = await guardTools.bash.execute({ command: "make cheap" }, repoCtx);
    expect(again).toContain("cheap-target");
    expect(again).not.toContain("not re-executed");
  });

  test("failed runs never record — the retry after red runs for real", async () => {
    fakeSuite("red", "sleep 0.2 && echo oops >&2 && exit 1");
    await expect(guardTools.bash.execute({ command: "make red" }, repoCtx)).rejects.toThrow(/exit code/);
    fakeSuite("red", "sleep 0.2 && echo now-green");
    const out = await guardTools.bash.execute({ command: "make red" }, repoCtx);
    expect(out).toContain("now-green");
    expect(out).not.toContain("not re-executed");
  }, 10_000);

  test("a tree change defeats interception — the re-run is legitimate", async () => {
    fakeSuite("tree", "sleep 0.2 && echo tree-green");
    await guardTools.bash.execute({ command: "make tree" }, repoCtx);
    writeFileSync(join(repo, "c.txt"), "uncommitted change");
    const out = await guardTools.bash.execute({ command: "make tree" }, repoCtx);
    expect(out).toContain("tree-green");
    expect(out).not.toContain("not re-executed");
  }, 10_000);
});

describe("suite-like classification (#304)", () => {
  // The walk must cross the wrappers the model really uses (session
  // 20260829T043600309Z): cd && timeout pipes were the norm.
  const cases: Array<[string, boolean]> = [
    ["bun test", true],
    ["cd packages/tui && timeout 400 bun test 2>&1 | tail -4", true],
    ["cd packages/core && timeout 300 bun test > /tmp/x.log 2>&1; echo exit=$?", true],
    ["FOO=1 npm test", true],
    ["timeout 420 bun test", true],
    ["yarn jest", true], // yarn-family head: suite-like
    ["make test", true],
    ["make build", false],
    ["go build ./...", false],
    ["cargo test", true],
    ["grep bun test file.txt", false],
    ["gh api repos/x/y --jq .name", false],
    ["curl -s http://localhost:9", false],
    ["echo bun test", false],
    ["git status --porcelain", false],
  ];
  for (const [command, expected] of cases) {
    test(`"${command.slice(0, 48)}" → ${expected}`, () => {
      expect(isSuiteLike(command)).toBe(expected);
    });
  }
});
