import { z } from "zod";
import type { Tool } from "./types";
import type { FilesystemScope } from "./permissions";
import { resolve, isAbsolute, relative, join, dirname } from "node:path";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * All built-in tools, keyed by name. Pure contract: name, description,
 * Zod inputSchema, execute(args, ctx) with AbortSignal and cwd.
 * Permissions (#24) gate execution; this module only implements behaviour.
 */

const MAX_OUTPUT = 50_000;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… [truncated]` : text;
}

/**
 * Resolves `path` against the project root and asserts the *resolved*
 * location is inside it (SEC-03): the nearest existing ancestor is
 * realpath'd, so a lexical in-root path that traverses a symlink pointing
 * outside (e.g. `link/file` with `root/link -> /outside`) is rejected —
 * the tool's view matches the permission resolver's. New files resolve
 * through their deepest existing directory, and a tail containing `..`
 * can never land inside by accident (the realpath of the ancestor already
 * absorbed it).
 */
export function resolvedInRoot(path: string, root: string): string {
  const abs = isAbsolute(path) ? path : resolve(root, path);
  let real: string;
  try {
    // Existing final paths must be realpath'd too: otherwise `root/file`
    // could itself be a symlink to an outside file.
    real = realpathSync(abs);
  } catch {
    // For a new path, walk up to the deepest existing ancestor, realpath
    // it, then reattach the non-existing tail (starting at the filename).
    let dir = dirname(abs);
    const tail: string[] = [abs.slice(dir.length + 1)];
    while (true) {
      try {
        dir = realpathSync(dir);
        break;
      } catch {
        const parent = dirname(dir);
        if (parent === dir) throw new Error(`path outside project root: ${path}`);
        tail.unshift(dir.slice(parent.length + 1));
        dir = parent;
      }
    }
    real = join(dir, ...tail);
  }
  const rel = relative(realpathish(root), real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path outside project root: ${path}`);
  }
  return real;
}

/** realpath of the root when it exists, the lexical root otherwise. */
function realpathish(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/** Resolves a user-supplied path inside the session cwd; throws on escapes. */
function inRoot(path: string, cwd: string, scope: FilesystemScope | undefined = undefined): string {
  return scope === "unrestricted" ? resolvedUnrestricted(path, cwd) : resolvedInRoot(path, cwd);
}

/** Like inRoot, but the path may fall inside any of the given roots. */
function inAnyRoot(path: string, roots: readonly string[], scope: FilesystemScope | undefined = undefined): string {
  if (scope === "unrestricted") return resolvedUnrestricted(path, roots[0]!);
  const abs = isAbsolute(path) ? path : resolve(roots[0]!, path);
  for (const root of roots) {
    try {
      const resolved = resolvedInRoot(abs, root);
      const rel = relative(realpathish(root), resolved);
      if (!rel.startsWith("..") && !isAbsolute(rel)) return resolved;
    } catch {
      // A read may be outside cwd but inside a declared skill directory.
    }
  }
  throw new Error(`path outside project root: ${path}`);
}

/**
 * #377 (yolo): canonical resolution without the containment check. The
 * path is realpath'd exactly like `resolvedInRoot` (SEC-03's
 * symlink-awareness is preserved — the path is resolved, never trusted
 * lexically); only the final under-root assertion is skipped.
 */
export function resolvedUnrestricted(path: string, cwd: string): string {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  try {
    return realpathSync(abs);
  } catch {
    // New path: resolve through the deepest existing ancestor.
    let dir = dirname(abs);
    const tail: string[] = [abs.slice(dir.length + 1)];
    while (true) {
      try {
        dir = realpathSync(dir);
        break;
      } catch {
        const parent = dirname(dir);
        if (parent === dir) throw new Error(`cannot resolve path: ${path}`);
        tail.unshift(dir.slice(parent.length + 1));
        dir = parent;
      }
    }
    return join(dir, ...tail);
  }
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

/** #300: bash's effective timeout — the valid arg, else the default.
 * The tool applies it at execution and the runner stamps the same value
 * on the `tool_call` event before validation, so both paths must resolve
 * identically or a rendered limit would lie about the real one. */
const BASH_TIMEOUT_MS = 30_000;
const bashTimeoutMs = (args: unknown): number => {
  const raw = (args as { timeoutMs?: unknown } | null | undefined)?.timeoutMs;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : BASH_TIMEOUT_MS;
};

/**
 * #304: redundant re-run ledger, per session. Expensive *successful*
 * suite-like runs record their full output to a temp file; an identical
 * re-run against an unchanged tree inside the window is short-circuited
 * with a pointer to that file. Every guard exists to protect legitimate
 * re-runs (false positives are worse than the waste they cause).
 */
const RERUN_MIN_MS = 10_000;
const RERUN_WINDOW_MS = 10 * 60_000;
const FRESH_MARK = "# fresh";
/** Escape hatch: a trailing `# fresh` always forces a real run. */
function splitFresh(command: string): { command: string; fresh: boolean } {
  const trimmed = command.trimEnd();
  if (!trimmed.endsWith(FRESH_MARK)) return { command, fresh: false };
  return { command: trimmed.slice(0, trimmed.length - FRESH_MARK.length).trimEnd(), fresh: true };
}
/** Whitespace-normalized command identity: same tokens, any spacing. */
const normalizeCommand = (command: string): string => command.trim().split(/\s+/).join(" ");

/**
 * Suite-like commands (#304): the only class the interception considers —
 * deterministic over the working tree, no external state. Anything else
 * (`gh api`, `curl`, watchers) always runs. Token match, not substring:
 * `grep bun test` must not count.
 */
const SUITE_PREFIXES = ["bun", "npm", "pnpm", "yarn", "npx", "jest", "vitest", "pytest", "cargo", "go", "make", "mvn", "gradle", "composer", "dotnet"];
export function isSuiteLike(command: string): boolean {
  const tokens = normalizeCommand(command).split(" ");
  // Walk past the wrappers the model actually writes: env assignments,
  // `cd pkg &&`, `;`, `timeout N`, `env X=y`, `command`/`exec`. The head
  // found after them decides; anything on a pipe after it is output
  // shaping and doesn't matter.
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || token === "&&" || token === ";" || token === "(" || token === "{") { i++; continue; }
    if (token === "cd" || token === "env" || token === "timeout" || token === "command" || token === "exec") { i += 2; continue; }
    break;
  }
  const head = tokens[i]?.split("/").pop() ?? "";
  const second = tokens[i + 1] ?? "";
  if (SUITE_PREFIXES.includes(head)) {
    if (head === "make" || head === "cargo" || head === "go" || head === "composer" || head === "dotnet") return ["test", "check", "t"].includes(second);
    return true; // bun/npm/pnpm/yarn/npx/jest/vitest/pytest/mvn/gradle: test-shaped by default
  }
  return false;
}

interface RecordedRun {
  /** Normalized command identity. */
  command: string;
  /** Wall-clock duration of the recorded run. */
  durationMs: number;
  /** Output file holding the full, untruncated capture. */
  file: string;
  at: number;
  /** `rev-parse HEAD` + `status --porcelain` at record time. */
  gitState: string;
}
interface RunLedger {
  readonly runs: Map<string, RecordedRun>;
  /** Lazily created per session, so sessions without long runs leave no trace. */
  outputDir?: string;
  readonly root: string;
}

/** Remove abandoned per-session ledgers after their reuse window expires. */
function pruneRunLedgers(root: string, now = Date.now()): void {
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("bash-")) continue;
      const dir = join(root, entry.name);
      if (now - statSync(dir).mtimeMs > RERUN_WINDOW_MS) rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ledger capture and its cleanup are deliberately best-effort.
  }
}

function ledgerOutputDir(ledger: RunLedger): string {
  if (ledger.outputDir) return ledger.outputDir;
  mkdirSync(ledger.root, { recursive: true, mode: 0o700 });
  pruneRunLedgers(ledger.root);
  const dir = mkdtempSync(join(ledger.root, "bash-"));
  // mkdtemp is normally 0700, but make the promise explicit across runtimes.
  chmodSync(dir, 0o700);
  ledger.outputDir = dir;
  return dir;
}

function createRunLedger(root?: string): RunLedger {
  // Direct builtinTools() callers retain a secure mkdtemp-based fallback;
  // normal session builders supply ~/.moh so captures follow moh-home policy.
  const ledgerRoot = root ?? tmpdir();
  pruneRunLedgers(ledgerRoot);
  return { runs: new Map(), root: ledgerRoot };
}

/** Best-effort git snapshot; null when not a repo or git fails → never intercept. */
function gitSnapshot(cwd: string): string | null {
  try {
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe", stderr: "ignore" });
    if (head.exitCode !== 0) return null;
    const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd, stdout: "pipe", stderr: "ignore" });
    if (status.exitCode !== 0) return null;
    return `${head.stdout.toString().trim()}|${status.stdout.toString().trim()}`;
  } catch {
    return null;
  }
}

const bashTool = (ledger: RunLedger): Tool<z.infer<typeof bashSchema>> => ({
  name: "bash",
  description:
    "Run a shell command in the project root and capture its output. " +
    "Successful runs of 10s+ save their full output to a file (pointer appended); " +
    "grep that file instead of re-running. An identical suite-like re-run on an unchanged " +
    "tree within 10 minutes is short-circuited with a pointer to the saved output — " +
    `append "${FRESH_MARK}" to the command to force a real run.`,
  inputSchema: bashSchema,
  timeoutMs: bashTimeoutMs,
  async execute(args, ctx) {
    const { command: rawCommand, fresh } = splitFresh(args.command);
    const normalized = normalizeCommand(rawCommand);
    const started = Date.now();
    // #304 interception: only identical, suite-like commands on an
    // unchanged git tree, within the window, never after #fresh. Missing
    // ledger info (no git, different duration) → run for real.
    const recorded = ledger.runs.get(normalized);
    if (
      !fresh &&
      recorded &&
      isSuiteLike(normalized) &&
      Date.now() - recorded.at <= RERUN_WINDOW_MS &&
      gitSnapshot(ctx.cwd) === recorded.gitState
    ) {
      const age = Math.round((Date.now() - recorded.at) / 1000);
      return [
        `bash: identical suite-like command already run ${age}s ago (${Math.round(recorded.durationMs / 1000)}s, exit 0, tree unchanged) — not re-executed.`,
        `Full output saved at: ${recorded.file}`,
        `Grep/read that file instead of re-running. Append "${FRESH_MARK}" to this command to force a real run.`,
      ].join("\n");
    }
    const timeout = bashTimeoutMs(args);
    // After the parent exits, background descendants may still hold the
    // output pipes; the drain waits this long past exit before force-closing
    // the streams and returning whatever output arrived.
    const EXIT_GRACE_MS = 500;
    const proc = Bun.spawn(
      hasSetsid() ? ["setsid", "bash", "-c", rawCommand] : ["bash", "-c", rawCommand],
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
    const durationMs = Date.now() - started;
    // #304: capture the full output of expensive successful suite-like
    // runs and record them for interception. Failures/aborts/cheap runs
    // never record — the ledger only ever short-circuits a proven-green
    // expensive rerun.
    let pointer = "";
    if (durationMs >= RERUN_MIN_MS && isSuiteLike(rawCommand)) {
      try {
        const dir = ledgerOutputDir(ledger);
        const file = join(dir, `run-${started}-${Math.random().toString(36).slice(2)}.log`);
        writeFileSync(file, `$ ${rawCommand}\n\n${output}\n`, { mode: 0o600 });
        const gitState = gitSnapshot(ctx.cwd);
        if (gitState !== null) {
          ledger.runs.set(normalized, { command: normalized, durationMs, file, at: started, gitState });
        }
        pointer = `\n[full output saved: ${file}]`;
      } catch {
        // Capture is best-effort; a failure never affects the run result.
      }
    }
    return truncate(output) + pointer;
  },
});

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
    const abs = inAnyRoot(args.path, [ctx.cwd, ...(ctx.skillDirs ?? [])], ctx.filesystemScope);
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
    const abs = inRoot(args.path, ctx.cwd, ctx.filesystemScope);
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
    const abs = inRoot(args.path, ctx.cwd, ctx.filesystemScope);
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
    // SEC-07: patterns must stay lexically inside the root — absolute
    // patterns and any `..` segment are rejected up front (Bun's glob
    // honors `..`, which would enumerate outside the project). Yolo
    // (#377) lifts the containment: an absolute or `..`-prefixed pattern
    // retargets the scan onto its literal leading directory instead.
    let scanRoot = ctx.cwd;
    let pattern = args.pattern;
    if (ctx.filesystemScope !== "unrestricted") {
      if (isAbsolute(pattern.replace(/^!+/, "")) || pattern.split(/[/\\]/).includes("..")) {
        throw new Error(`glob pattern escapes the project root: ${args.pattern}`);
      }
    } else {
      const retarget = globRetarget(pattern, ctx.cwd);
      scanRoot = retarget.root;
      pattern = retarget.pattern;
    }
    const globber = new Bun.Glob(pattern);
    const matches: string[] = [];
    // Defense in depth: results are re-resolved canonically (SEC-03) so a
    // matched symlink target outside the root never leaks an outside
    // listing in project scope; in yolo the resolution stays canonical
    // but is not filtered.
    for await (const path of globber.scan({ cwd: scanRoot, onlyFiles: true })) {
      try {
        inRoot(path, scanRoot, ctx.filesystemScope);
      } catch {
        continue;
      }
      matches.push(path);
    }
    return truncate(matches.sort().join("\n"));
  },
};

/**
 * #377 (yolo): split a possibly out-of-root glob pattern into a literal
 * leading directory (resolved canonically) and the remaining glob
 * sub-pattern. Absolute patterns retarget from the filesystem root,
 * relative ones from the session cwd; leading `..` segments resolve.
 */
function globRetarget(pattern: string, cwd: string): { root: string; pattern: string } {
  const raw = pattern.replace(/^!+/, "");
  const parts = raw.split(/[/\\]+/).filter((s) => s.length > 0);
  const literal: string[] = [];
  let i = 0;
  if (isAbsolute(raw)) {
    literal.push("/");
    while (i < parts.length && !/[*?[{]/.test(parts[i]!)) { literal.push(parts[i]!); i++; }
  } else {
    while (i < parts.length && (parts[i] === ".." || parts[i] === "." || !/[*?[{]/.test(parts[i]!))) {
      if (parts[i] !== ".") literal.push(parts[i]!);
      i++;
    }
  }
  const root = resolvedUnrestricted(literal.join("/") || ".", isAbsolute(raw) ? "/" : cwd);
  const rest = parts.slice(i);
  return { root, pattern: rest.length ? rest.join("/") : "*" };
}

const grepSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
});
const grep: Tool<z.infer<typeof grepSchema>> = {
  name: "grep",
  description: "Search file contents with a regular expression (case-sensitive).",
  inputSchema: grepSchema,
  async execute(args, ctx) {
    const root = args.path ? inRoot(args.path, ctx.cwd, ctx.filesystemScope) : ctx.cwd;
    const re = new RegExp(args.pattern);
    const out: string[] = [];
    const globber = new Bun.Glob("**/*");
    outer: for await (const rel of globber.scan({ cwd: root, onlyFiles: true })) {
      let abs: string;
      try {
        // SEC-03: grep is a read primitive too — never follow an in-root
        // symlink to content outside its selected root (#377: in yolo the
        // resolution stays canonical, the containment filter drops).
        abs = inRoot(rel, root, ctx.filesystemScope);
      } catch {
        continue;
      }
      const file = Bun.file(abs);
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

/** SEC-05: maximum followed redirects. */
const FETCH_MAX_REDIRECTS = 3;

/**
 * SEC-05: private/loopback/link-local hostnames and address literals —
 * blocked for fetch unless `MOH_FETCH_ALLOW_PRIVATE` is set (explicit
 * opt-in for local endpoints).
 */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h === "0.0.0.0") return true;
  // IPv4 literal (incl. IPv4-mapped IPv6 tail).
  const v4 = h.includes(":") ? (h.match(/(?<=:)(\d+\.\d+\.\d+\.\d+)$/) ?? [])[1] : h;
  if (v4) {
    const parts = v4.split(".").map(Number);
    if (parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)) {
      const [a, b] = parts as [number, number, number, number];
      return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 255;
    }
  }
  // IPv6 literal: loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10).
  if (h.includes(":")) {
    const first = Number.parseInt(h.split(":")[0] || "0", 16);
    if (h === "::" || h === "::1") return true;
    if (!Number.isNaN(first)) return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

/** True when the operator explicitly allowed private-network fetches. */
const fetchAllowsPrivate = (): boolean =>
  ["1", "true", "yes"].includes((process.env.MOH_FETCH_ALLOW_PRIVATE ?? "").toLowerCase());

/** SEC-05: scheme + network checks on one URL (throws on violation). */
async function assertFetchable(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`fetch: invalid URL: ${rawUrl}`);
  }
  // file:// and data:// would turn fetch into a local-file read primitive
  // that bypasses the read tool's root containment.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`fetch: only http/https URLs are supported (got "${url.protocol}")`);
  }
  if (fetchAllowsPrivate()) return url;
  const host = url.hostname;
  if (isPrivateHost(host)) {
    throw new Error(`fetch: private/loopback address "${host}" is blocked by default; set MOH_FETCH_ALLOW_PRIVATE=1 to allow it`);
  }
  // DNS-rebinding style SSRF: a public hostname that resolves private.
  const { lookup } = await import("node:dns/promises");
  try {
    const addresses = await lookup(host, { all: true });
    const bad = addresses.find((a) => isPrivateHost(a.address));
    if (bad) {
      throw new Error(`fetch: "${host}" resolves to private address ${bad.address}; blocked by default (set MOH_FETCH_ALLOW_PRIVATE=1 to allow)`);
    }
  } catch (err) {
    if (err instanceof Error && !err.message.startsWith("fetch:")) {
      // Unresolvable here: let the request itself surface the real error.
    } else {
      throw err;
    }
  }
  return url;
}

const fetchTool: Tool<z.infer<typeof fetchSchema>> = {
  name: "fetch",
  description:
    "Fetch an http/https URL and return the response body as text. " +
    "Private/loopback targets are blocked unless MOH_FETCH_ALLOW_PRIVATE=1 is set.",
  inputSchema: fetchSchema,
  async execute(args, ctx) {
    let url = await assertFetchable(args.url);
    // SEC-05: redirects are followed manually (capped) so every hop
    // re-passes the scheme/private-network checks — a public URL can't
    // bounce the fetch into 169.254.169.254 or file://.
    let res = await globalThis.fetch(url, { signal: ctx.signal, redirect: "manual" });
    for (let hop = 0; hop < FETCH_MAX_REDIRECTS && [301, 302, 303, 307, 308].includes(res.status); hop++) {
      const location = res.headers.get("location");
      res.body?.cancel().catch(() => {});
      if (!location) break;
      url = await assertFetchable(new URL(location, url).toString());
      res = await globalThis.fetch(url, { signal: ctx.signal, redirect: "manual" });
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      throw new Error(`fetch: too many redirects (> ${FETCH_MAX_REDIRECTS}) for ${args.url}`);
    }
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

export interface BuiltinToolsOptions {
  /** Root for secure, per-session bash capture directories. */
  ledgerRoot?: string;
}

export function builtinTools(options: BuiltinToolsOptions = {}): Record<string, Tool> {
  // Per-session ledgers: the read tool's re-read nudge (#196) and the bash
  // tool's re-run interception (#304) share this session scope only.
  const readLedger = new Map<string, ServedRead>();
  const runLedger = createRunLedger(options.ledgerRoot);
  const all = [bashTool(runLedger), readTool(readLedger), write, edit, glob, grep, fetchTool, todo, askUser];
  return Object.fromEntries(all.map((t) => [t.name, t as Tool]));
}
