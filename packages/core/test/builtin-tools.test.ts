import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools } from "../src/builtin-tools";
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
      { url: "data:text/plain,hello-fetch" },
      ctx,
    );
    expect(out).toContain("hello-fetch");
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
