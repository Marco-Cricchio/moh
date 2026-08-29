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

/**
 * Kills a spawned bash and, best-effort, its whole process tree (#237).
 * `Bun.spawn` offers no process-group option, so when `setsid` is
 * available the command runs as its own session leader and the tree dies
 * with one group kill (`kill(-pid)`). Without it, descendants are killed
 * recursively via `pgrep -P` — children first, then the parent, since
 * killing the parent first re-parents the children to init, past our
 * reach. Both paths are best-effort for descendants that escaped via a
 * new session of their own.
 */
function killTree(proc: Bun.Subprocess): void {
  try { process.kill(-proc.pid, "SIGKILL"); return; } catch { /* not a group leader */ }
  // #297: the enumeration+kill MUST complete before the parent dies —
  // killing the parent first re-parents the descendants to init (PPID 1),
  // and a later `pgrep -P` finds nothing to kill. Synchronous on purpose.
  Bun.spawnSync(
    [
      "bash",
      "-c",
      `kd() { for c in $(pgrep -P \"$1\"); do kd \"$c\"; done; kill -KILL \"$1\" 2>/dev/null; true; }; kd ${proc.pid}`,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
}

/** Cached probe: is util-linux `setsid` on PATH? (absent on stock macOS) */
let setsid: boolean | null = null;
function hasSetsid(): boolean {
  if (setsid === null) {
    setsid = Bun.spawnSync(["bash", "-c", "command -v setsid || true"]).stdout.toString().trim() !== "";
  }
  return setsid;
}

const bash: Tool<z.infer<typeof bashSchema>> = {
  name: "bash",
  description: "Run a shell command in the project root and capture its output.",
  inputSchema: bashSchema,
  async execute(args, ctx) {
    const timeout = args.timeoutMs ?? 30_000;
    // After the parent exits, background descendants may still hold the
    // output pipes; the drain waits this long past exit before force-closing
    // the streams and returning whatever output arrived.
    const EXIT_GRACE_MS = 500;
    const proc = Bun.spawn(
      hasSetsid() ? ["setsid", "bash", "-c", args.command] : ["bash", "-c", args.command],
      {
        cwd: ctx.cwd,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    // Why not `signal` on Bun.spawn: it only applies at spawn time — an abort
    // after spawn never reaches the live process. Cancellation is handled
    // here, explicitly.
    let reason: "aborted" | "timeout" | "grace" | null = null;
    let fireStop!: (r: "aborted" | "timeout" | "grace") => void;
    const stopped = new Promise<"aborted" | "timeout" | "grace">((r) => { fireStop = r; });
    const stop = (r: "aborted" | "timeout" | "grace"): void => {
      if (reason) return;
      reason = r;
      if (r !== "grace") killTree(proc); // grace: the command itself is done; only the streams close
      fireStop(r);
    };
    const timer = setTimeout(() => stop("timeout"), timeout);
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    // True once output drained and the parent exited: a late abort must not
    // turn a completed command into a cancellation.
    let finished = false;
    const onAbort = () => { if (!finished) stop("aborted"); };
    if (ctx.signal?.aborted) onAbort();
    else ctx.signal?.addEventListener("abort", onAbort, { once: true });
    // The parent exiting starts the grace clock for pipe-holding descendants.
    void proc.exited.then(() => { graceTimer = setTimeout(() => stop("grace"), EXIT_GRACE_MS); });

    const decoder = new TextDecoder();
    const readAll = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      const reader = stream.getReader();
      let text = "";
      for (;;) {
        const read = await Promise.race([reader.read(), stopped.then(() => null)]);
        if (read === null || read.done) {
          reader.cancel().catch(() => {}); // drop our end of a pipe still held by a descendant
          break;
        }
        text += decoder.decode(read.value, { stream: true });
      }
      return text + decoder.decode();
    };
    const [stdout, stderr, exitCode] = await Promise.all([
      readAll(proc.stdout as ReadableStream<Uint8Array>),
      readAll(proc.stderr as ReadableStream<Uint8Array>),
      proc.exited,
    ]).then((r) => { finished = true; return r; });
    clearTimeout(timer);
    if (graceTimer !== null) clearTimeout(graceTimer);
    ctx.signal?.removeEventListener("abort", onAbort);
    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    if (reason === "aborted") {
      throw new Error(`bash: turn cancelled before the command returned${output ? ` (partial output: ${truncate(output)})` : ""}`);
    }
    if (reason === "timeout") {
      throw new Error(`bash: timed out after ${timeout}ms${output ? `: ${truncate(output)}` : ""}`);
    }
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

/** One served read of an unchanged file: content hash, the line ranges
 * already handed to the model, and the turn that served them. */
interface ServedRead {
  hash: string;
  turn: number;
  ranges: Array<[number, number]>; // 1-based, inclusive
}

const sha = (text: string): string =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

/** True when [from, to] is fully covered by the (unmerged) range list. */
function covers(ranges: Array<[number, number]>, from: number, to: number): boolean {
  const merged: Array<[number, number]> = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  let at = from;
  for (const [a, b] of merged) {
    if (a > at) break;
    at = Math.max(at, b + 1);
    if (at > to) return true;
  }
  return at > to;
}

/** Read tool with the per-session read ledger (#196): within one turn, a
 * repeat read of an unchanged file whose requested range was already
 * served returns a short nudge instead of the content — the model
 * re-reads unchanged files out of habit, burning iteration budget and
 * context. Entries are turn-scoped (a later turn may legitimately need
 * the file again) and content-hash keyed, so an mtime-only touch still
 * nudges while a real edit re-serves in full. */
const readTool = (ledger: Map<string, ServedRead>): Tool<z.infer<typeof readSchema>> => ({
  name: "read",
  description: "Read a text file (optionally a line range) inside the project root or a skill directory.",
  inputSchema: readSchema,
  async execute(args, ctx) {
    const abs = inAnyRoot(args.path, [ctx.cwd, ...(ctx.skillDirs ?? [])]);
    const file = Bun.file(abs);
    if (!(await file.exists())) throw new Error(`file not found: ${args.path}`);
    const text = await file.text();
    const lines = text.split("\n");
    const from = args.offset ?? 1;
    const slice = lines.slice(from - 1, args.limit ? from - 1 + args.limit : undefined);
    const to = from - 1 + slice.length;
    const hash = sha(text);
    const served = ledger.get(abs);
    const sameTurn = served !== undefined && served.turn === ctx.turn;
    if (sameTurn && served.hash === hash && covers(served.ranges, from, to)) {
      return `[already read] ${args.path} is unchanged and lines ${from}–${to} were already served earlier in this turn. ` +
        "Reuse the earlier result instead of re-reading; read a different or narrower range only if you truly need it again.";
    }
    const output = slice.join("\n");
    // Only count the range as served when it was handed over whole — a
    // truncated read must stay re-readable (narrower) without a nudge.
    if (output.length <= MAX_OUTPUT) {
      ledger.set(abs, { hash, turn: ctx.turn ?? 0, ranges: sameTurn && served.hash === hash ? [...served.ranges, [from, to]] : [[from, to]] });
    }
    return truncate(output);
  },
});

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

const askUserSchema = z
  .object({
    question: z.string().min(1),
    options: z
      .array(z.object({ label: z.string().min(1), description: z.string() }))
      .min(1)
      .max(4),
    suggested: z.string().min(1),
  })
  .superRefine((args, ctx) => {
    const labels = new Set(args.options.map((o) => o.label));
    if (labels.size !== args.options.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "option labels must be unique" });
    }
    if (!labels.has(args.suggested)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "suggested must be one of the option labels" });
    }
  });

const askUser: Tool<z.infer<typeof askUserSchema>> = {
  name: "ask_user",
  interactive: true,
  description:
    "Ask the user one question with up to 4 options (label + short description); " +
    "exactly one option is the suggested answer. The user may also answer with free text. " +
    "Prefer this over asking in plain chat when a decision with clear alternatives is needed.",
  inputSchema: askUserSchema,
  async execute(args, ctx) {
    if (!ctx.askUser) {
      throw new Error(
        "ask_user: no interactive user is attached (headless mode). " +
          "Proceed without asking — rephrase or make the decision yourself.",
      );
    }
    const answer = await ctx.askUser({ question: args.question, options: args.options, suggested: args.suggested });
    if (answer.choice !== undefined && answer.text !== undefined) {
      throw new Error("ask_user: answer must be either a choice or free text, not both");
    }
    if (answer.choice !== undefined) {
      if (!args.options.some((o) => o.label === answer.choice)) {
        throw new Error(`ask_user: "${answer.choice}" is not one of the offered options`);
      }
      return answer.choice;
    }
    if (answer.text !== undefined) return answer.text;
    throw new Error("ask_user: answer carries neither a choice nor free text");
  },
};

function joinSafe(root: string, rel: string): string {
  return `${root}/${rel.split("\\").join("/")}`;
}

export function builtinTools(): Record<string, Tool> {
  // Per-session read ledger: shared by the read tool instances of this
  // session only (#196).
  const readLedger = new Map<string, ServedRead>();
  const all = [bash, readTool(readLedger), write, edit, glob, grep, fetchTool, todo, askUser];
  return Object.fromEntries(all.map((t) => [t.name, t as Tool]));
}
