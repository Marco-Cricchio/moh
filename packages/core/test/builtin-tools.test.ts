import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools } from "../src/builtin-tools";
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

  test("fetch retrieves a URL body", async () => {
    const out = await tools.fetch.execute(
      { url: "https://example.com/" },
      ctx,
    );
    expect(out).toContain("Example Domain");
  });

  // SEC-05 regression suite.
  test("fetch rejects non-http schemes (file:, data:)", async () => {
    await expect(tools.fetch.execute({ url: "file:///etc/hosts" }, ctx)).rejects.toThrow(/only http\/https/);
    await expect(tools.fetch.execute({ url: "data:text/plain,x" }, ctx)).rejects.toThrow(/only http\/https/);
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

  const guardTools = builtinTools();

  test("an expensive successful suite-like run saves full output and intercepts the identical re-run", async () => {
    fakeSuite("test", "sleep 11 && echo '(pass) one'");
    const out = await guardTools.bash.execute({ command: "make test" }, repoCtx);
    expect(out).toContain("(pass) one");
    expect(out).toMatch(/\[full output saved: .+\]/);
    const again = await guardTools.bash.execute({ command: "make   test" }, repoCtx); // whitespace-normalized identity
    expect(again).toContain("not re-executed");
    expect(again).toMatch(/Full output saved at: .+/);
  }, 30_000);

  test("# fresh forces a real run and refreshes the saved output", async () => {
    fakeSuite("fresh", "sleep 11 && echo fresh-green");
    await guardTools.bash.execute({ command: "make fresh" }, repoCtx);
    const fresh = await guardTools.bash.execute({ command: "make fresh # fresh" }, repoCtx);
    expect(fresh).toContain("fresh-green");
    expect(fresh).not.toContain("not re-executed");
  }, 30_000);

  test("a different command runs for real even in the interception class", async () => {
    fakeSuite("other", "sleep 11 && echo other-green");
    await guardTools.bash.execute({ command: "make other" }, repoCtx);
    fakeSuite("other", "sleep 11 && echo other-green-2");
    commit("tweak");
    const out = await guardTools.bash.execute({ command: "make other" }, repoCtx);
    expect(out).toContain("other-green-2");
    expect(out).not.toContain("not re-executed");
  }, 30_000);

  test("no git repo: capture still helps, but nothing is ever intercepted", async () => {
    const plain = mkdtempSync(join(tmpdir(), "moh-304-nogit-"));
    const plainCtx: ToolContext = { ...ctx, cwd: plain };
    writeFileSync(join(plain, "Makefile"), "\ntest:\n\tsleep 11 && echo nogit\n");
    const out = await guardTools.bash.execute({ command: "make test" }, plainCtx);
    expect(out).toContain("nogit");
    const again = await guardTools.bash.execute({ command: "make test" }, plainCtx);
    expect(again).toContain("nogit");
    expect(again).not.toContain("not re-executed");
  }, 30_000);

  test("cheap commands never capture and never intercept", async () => {
    fakeSuite("cheap", "echo cheap-target");
    const out = await guardTools.bash.execute({ command: "make cheap" }, repoCtx);
    expect(out).not.toMatch(/\[full output saved/);
    const again = await guardTools.bash.execute({ command: "make cheap" }, repoCtx);
    expect(again).toContain("cheap-target");
    expect(again).not.toContain("not re-executed");
  });

  test("failed runs never record — the retry after red runs for real", async () => {
    fakeSuite("red", "sleep 11 && echo oops >&2 && exit 1");
    await expect(guardTools.bash.execute({ command: "make red" }, repoCtx)).rejects.toThrow(/exit code/);
    fakeSuite("red", "sleep 11 && echo now-green");
    const out = await guardTools.bash.execute({ command: "make red", timeoutMs: 20_000 }, repoCtx);
    expect(out).toContain("now-green");
    expect(out).not.toContain("not re-executed");
  }, 40_000);

  test("a tree change defeats interception — the re-run is legitimate", async () => {
    fakeSuite("tree", "sleep 11 && echo tree-green");
    await guardTools.bash.execute({ command: "make tree" }, repoCtx);
    writeFileSync(join(repo, "c.txt"), "uncommitted change");
    const out = await guardTools.bash.execute({ command: "make tree" }, repoCtx);
    expect(out).toContain("tree-green");
    expect(out).not.toContain("not re-executed");
  }, 40_000);
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
