import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools } from "../src/builtin-tools";
import type { ToolContext } from "../src/index";

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
