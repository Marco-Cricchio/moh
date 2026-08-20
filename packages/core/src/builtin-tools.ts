import { z } from "zod";
import type { Tool } from "./types";
import { resolve, isAbsolute, relative } from "node:path";

/**
 * All built-in tools, keyed by name. Pure contract: name, description,
 * Zod inputSchema, execute(args, ctx) with AbortSignal and cwd.
 * Permissions (#24) gate execution; this module only implements behaviour.
 */

const MAX_OUTPUT = 50_000;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… [truncated]` : text;
}

/** Resolves a user-supplied path inside the session cwd; throws on escapes. */
function inRoot(path: string, cwd: string): string {
  return inAnyRoot(path, [cwd]);
}

/** Like inRoot, but the path may fall inside any of the given roots. */
function inAnyRoot(path: string, roots: readonly string[]): string {
  const abs = isAbsolute(path) ? path : resolve(roots[0]!, path);
  for (const root of roots) {
    const rel = relative(root, abs);
    if (!rel.startsWith("..") && !isAbsolute(rel)) return abs;
  }
  throw new Error(`path outside project root: ${path}`);
}

const bashSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});
const bash: Tool<z.infer<typeof bashSchema>> = {
  name: "bash",
  description: "Run a shell command in the project root and capture its output.",
  inputSchema: bashSchema,
  async execute(args, ctx) {
    const proc = Bun.spawn(["bash", "-c", args.command], {
      cwd: ctx.cwd,
      signal: ctx.signal,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = args.timeoutMs ?? 30_000;
    const timer = setTimeout(() => proc.kill(), timeout);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    if (exitCode !== 0) {
      throw new Error(`exit code ${exitCode}: ${truncate(output || "(no output)")}`);
    }
    return truncate(output);
  },
};

const readSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});
const read: Tool<z.infer<typeof readSchema>> = {
  name: "read",
  description: "Read a text file (optionally a line range) inside the project root or a skill directory.",
  inputSchema: readSchema,
  async execute(args, ctx) {
    const file = Bun.file(inAnyRoot(args.path, [ctx.cwd, ...(ctx.skillDirs ?? [])]));
    if (!(await file.exists())) throw new Error(`file not found: ${args.path}`);
    const text = await file.text();
    const lines = text.split("\n");
    const slice = lines.slice((args.offset ?? 1) - 1, args.limit ? (args.offset ?? 1) - 1 + args.limit : undefined);
    return truncate(slice.join("\n"));
  },
};

const writeSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});
const write: Tool<z.infer<typeof writeSchema>> = {
  name: "write",
  description: "Create or overwrite a file inside the project root.",
  inputSchema: writeSchema,
  async execute(args, ctx) {
    const abs = inRoot(args.path, ctx.cwd);
    await Bun.write(abs, args.content);
    return `wrote ${args.content.length} bytes to ${args.path}`;
  },
};

const editSchema = z.object({
  path: z.string().min(1),
  oldText: z.string(),
  newText: z.string(),
});
const edit: Tool<z.infer<typeof editSchema>> = {
  name: "edit",
  description: "Replace an exact, unique text occurrence in a file.",
  inputSchema: editSchema,
  async execute(args, ctx) {
    const abs = inRoot(args.path, ctx.cwd);
    const file = Bun.file(abs);
    if (!(await file.exists())) throw new Error(`file not found: ${args.path}`);
    const text = await file.text();
    const count = text.split(args.oldText).length - 1;
    if (count === 0) throw new Error(`oldText not found in ${args.path}`);
    if (count > 1) throw new Error(`oldText is not unique (${count} occurrences) in ${args.path}`);
    await Bun.write(abs, text.replace(args.oldText, args.newText));
    return `edited ${args.path}`;
  },
};

const globSchema = z.object({ pattern: z.string().min(1) });
const glob: Tool<z.infer<typeof globSchema>> = {
  name: "glob",
  description: "List files matching a glob pattern inside the project root.",
  inputSchema: globSchema,
  async execute(args, ctx) {
    const globber = new Bun.Glob(args.pattern);
    const matches: string[] = [];
    for await (const path of globber.scan({ cwd: ctx.cwd, onlyFiles: true })) {
      matches.push(path);
    }
    return truncate(matches.sort().join("\n"));
  },
};

const grepSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
});
const grep: Tool<z.infer<typeof grepSchema>> = {
  name: "grep",
  description: "Search file contents with a regular expression (case-sensitive).",
  inputSchema: grepSchema,
  async execute(args, ctx) {
    const root = args.path ? inRoot(args.path, ctx.cwd) : ctx.cwd;
    const re = new RegExp(args.pattern);
    const out: string[] = [];
    const globber = new Bun.Glob("**/*");
    outer: for await (const rel of globber.scan({ cwd: root, onlyFiles: true })) {
      const file = Bun.file(joinSafe(root, rel));
      if (!(await file.exists())) continue;
      const text = await file.text();
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) out.push(`${rel}:${i + 1}:${lines[i]}`);
        if (out.length >= 500) break outer;
      }
    }
    return truncate(out.join("\n"));
  },
};

const fetchSchema = z.object({
  url: z.string().url(),
  maxLength: z.number().int().positive().optional(),
});
const fetchTool: Tool<z.infer<typeof fetchSchema>> = {
  name: "fetch",
  description: "Fetch a URL and return the response body as text.",
  inputSchema: fetchSchema,
  async execute(args, ctx) {
    const res = await globalThis.fetch(args.url, { signal: ctx.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${args.url}`);
    return truncate((await res.text()).slice(0, args.maxLength ?? MAX_OUTPUT));
  },
};

const todoStatuses = ["pending", "in_progress", "done"] as const;
const statusMark: Record<(typeof todoStatuses)[number], string> = {
  pending: "[ ]",
  in_progress: "[~]",
  done: "[x]",
};

const todoSchema = z.object({
  todos: z.array(
    z.object({
      content: z.string().min(1),
      status: z.enum(todoStatuses),
      activeForm: z.string().optional(),
    }),
  ),
});
const todo: Tool<z.infer<typeof todoSchema>> = {
  name: "todo",
  description: "Replace the session task list with a new state.",
  inputSchema: todoSchema,
  execute(args) {
    return args.todos.map((t) => `${statusMark[t.status]} ${t.content}`).join("\n");
  },
};

function joinSafe(root: string, rel: string): string {
  return `${root}/${rel.split("\\").join("/")}`;
}

export function builtinTools(): Record<string, Tool> {
  const all = [bash, read, write, edit, glob, grep, fetchTool, todo];
  return Object.fromEntries(all.map((t) => [t.name, t as Tool]));
}
