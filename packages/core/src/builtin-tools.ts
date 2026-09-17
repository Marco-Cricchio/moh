import { z } from "zod";
import type { AskUserAnswer, AskUserQuestion, AskUserSetResult, Tool } from "./types";
import type { FilesystemScope } from "./permissions";
import { resolve, isAbsolute, relative, join, dirname } from "node:path";
import type { BrowserSession } from "./browser";

declare module "bun" {}
// `require` for the lazy browser peer (see builtinTools below). Loaded
// through a runtime-resolved path so the optional dependency stays
// optional — the module is only touched when `browser.enabled` is true.
const lazyRequire: (id: string) => unknown =
  typeof require === "function"
    ? (require as unknown as (id: string) => unknown)
    : (id: string) => {
        throw new Error(`browser: cannot load "${id}" on this runtime`);
      };
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const bashTool = (ledger: RunLedger, rerunMinMs = RERUN_MIN_MS): Tool<z.infer<typeof bashSchema>> => ({
  name: "bash",
  description:
    "Run a shell command in the project root and capture its output. " +
    "Successful runs of 10s+ save their full output to a file (pointer appended); " +
    "grep that file instead of re-running. An identical suite-like re-run on an unchanged " +
    "tree within 10 minutes is short-circuited with a pointer to the saved output — " +
    `append "${FRESH_MARK}" to the command to force a real run. ` +
    "Long-running commands (test suites, installs, builds) should pass `timeoutMs` " +
    "(up to 600000) — the default 30s limit kills them mid-flight.",
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
        const decoded = decoder.decode(read.value, { stream: true });
        // Live progress (#liveness): relay each chunk as it arrives so
        // clients can render a scrolling tail while the command runs.
        // Fire-and-forget: the tool result remains the sole persisted record.
        if (decoded) ctx.onProgress(decoded);
        text += decoded;
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
      // #731: exit 127 ("command not found") gets an actionable hint — the
      // model repeatedly shells to `rg`, which is not installed here, and
      // burns a turn discovering it.
      const hint =
        exitCode === 127 && /^\s*(rg|grep -P)\b/.test(rawCommand)
          ? " (command not installed — use the built-in grep tool instead)"
          : "";
      throw new Error(`exit code ${exitCode}${hint}: ${truncate(output || "(no output)")}`);
    }
    const durationMs = Date.now() - started;
    // #304: capture the full output of expensive successful suite-like
    // runs and record them for interception. Failures/aborts/cheap runs
    // never record — the ledger only ever short-circuits a proven-green
    // expensive rerun.
    let pointer = "";
    if (durationMs >= rerunMinMs && isSuiteLike(rawCommand)) {
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
  // #731: models occasionally send null/""/0 for offset — coalesced below
  // instead of failing the whole call (20+ observed validation failures).
  offset: z.coerce.number().int().positive().optional().nullable(),
  limit: z.coerce.number().int().positive().optional().nullable(),
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
    // #731: a meta-free pattern may name a single *file* — retargeting
    // would scan with a file as cwd (ENOTDIR). Answer directly instead:
    // return the path when it exists, a clear miss otherwise.
    if (scanRoot !== ctx.cwd && pattern === "*") {
      const st = statSyncSafe(scanRoot);
      if (st?.isFile()) {
        const shown = isAbsolute(args.pattern.replace(/^!+/, ""))
          ? scanRoot
          : relative(ctx.cwd, scanRoot) || scanRoot;
        return truncate(shown);
      }
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

/** statSync without throwing — null on any error (missing path, ENOTDIR parent…). */
function statSyncSafe(path: string): { isFile: () => boolean; isDirectory: () => boolean } | null {
  try {
    return statSync(realpathSync(path));
  } catch {
    return null;
  }
}

const grepSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
});
const grep: Tool<z.infer<typeof grepSchema>> = {
  name: "grep",
  description:
    "Search file contents with a regular expression (case-sensitive). " +
    "`path` may be a directory (searched recursively — default) or a single file (searched directly).",
  inputSchema: grepSchema,
  async execute(args, ctx) {
    const target = args.path ? inRoot(args.path, ctx.cwd, ctx.filesystemScope) : ctx.cwd;
    const re = new RegExp(args.pattern);
    // #731: a file `path` is searched directly — scanning with a file as
    // cwd throws ENOTDIR, which accounted for ~40% of all observed tool
    // failures (the model legitimately points grep at single files).
    if (args.path !== undefined && (await Bun.file(target).exists())) {
      const text = await Bun.file(target).text();
      const out: string[] = [];
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) out.push(`${args.path}:${i + 1}:${lines[i]}`);
        if (out.length >= 500) break;
      }
      return truncate(out.join("\n"));
    }
    const out: string[] = [];
    const globber = new Bun.Glob("**/*");
    outer: for await (const rel of globber.scan({ cwd: target, onlyFiles: true })) {
      let abs: string;
      try {
        // SEC-03: grep is a read primitive too — never follow an in-root
        // symlink to content outside its selected root (#377: in yolo the
        // resolution stays canonical, the containment filter drops).
        abs = inRoot(rel, target, ctx.filesystemScope);
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

/**
 * #697: undici must be loaded as the real package. Bun resolves the bare
 * specifier `undici` to an internal shim whose fetch ignores the
 * `dispatcher` option entirely — the pinning seam below would silently
 * degrade to a plain (re-resolving) fetch. Requiring the resolved package
 * path bypasses the shim on both runtimes.
 */
let undiciPromise: Promise<typeof import("undici")> | undefined;
function loadUndici(): Promise<typeof import("undici")> {
  undiciPromise ??= (async () => {
    if (typeof Bun !== "undefined") {
      // Bun maps the bare specifier (and import.meta.resolve of it) to an
      // internal shim; load the package's real entry instead. The runtime
      // variable specifier keeps TS (and bundlers) from rewriting it.
      const spec: string = ["../../node_modules/undici/index.js", "../../../node_modules/undici/index.js"].find(
        (p) => existsSync(join(import.meta.dir, p)),
      )!;
      if (spec) {
        const real = (await import(spec).catch(() => null)) as typeof import("undici") | null;
        if (real) return real;
      }
    }
    try {
      // Node: resolve through this module's own node_modules.
      const url = import.meta.resolve("undici");
      if (url && url.startsWith("file:") && url.includes("node_modules/undici/")) {
        return await import(url);
      }
    } catch {
      // fall through to the bare specifier
    }
    return await import("undici");
  })();
  return undiciPromise;
}

/**
 * SEC-05 + #697: scheme + host checks on one URL, ONE DNS resolution,
 * and a dispatcher pinned to the verified address. Closes the
 * DNS-rebinding TOCTOU: the legacy code resolved inside the check and let
 * `globalThis.fetch` re-resolve independently at connect time, so a
 * short-TTL name could answer public for the check and private for the
 * dial. Here the single resolution result feeds the undici Agent's
 * `connect.lookup` hook — every socket (redirect hops included) dials
 * the verified address with no further DNS traffic.
 *
 * Returns null when no pinning applies (numeric/private hosts under the
 * explicit `MOH_FETCH_ALLOW_PRIVATE=1` opt-out resolve normally).
 */
async function verifiedDispatcher(
  rawUrl: string,
): Promise<{ url: URL; dispatcher: unknown } | null> {
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
  if (fetchAllowsPrivate()) return null;
  const host = url.hostname;
  if (isPrivateHost(host)) {
    throw new Error(`fetch: private/loopback address "${host}" is blocked by default; set MOH_FETCH_ALLOW_PRIVATE=1 to allow it`);
  }
  if (isNumericHost(host)) return null;
  // The single resolution: verification and pinning share this answer.
  const { lookup } = await import("node:dns/promises");
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    // Unresolvable here: let the request itself surface the real error.
    return null;
  }
  const bad = addresses.find((a) => isPrivateHost(a.address));
  if (bad) {
    throw new Error(`fetch: "${host}" resolves to private address ${bad.address}; blocked by default (set MOH_FETCH_ALLOW_PRIVATE=1 to allow)`);
  }
  const good = addresses[0]!;
  const { Agent } = await loadUndici();
  return {
    url,
    dispatcher: new Agent({
      connect: { lookup: (_h: string, _o: unknown, cb: unknown) => (cb as (e: null, a: { address: string; family: number }[]) => void)(null, [good]) },
      // Each fetch call gets a fresh agent; don't keep sockets pooled after.
      connections: 8,
    }),
  };
}

/** A bare IPv4/IPv6 address literal needs no DNS and no pinning. */
function isNumericHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
}

/** One fetch with the (optional) pinned dispatcher; always manual-redirect. */
async function doFetch(
  url: URL,
  pin: { dispatcher: unknown } | null,
  signal: AbortSignal,
): Promise<Response> {
  if (!pin) return globalThis.fetch(url, { signal, redirect: "manual" });
  const { fetch: undiciFetch } = await loadUndici();
  return (await undiciFetch(url, {
    signal,
    redirect: "manual",
    dispatcher: pin.dispatcher,
  } as never)) as unknown as Response;
}


/** SEC-05: scheme + literal-host checks on one URL (throws on violation).
 * DNS resolution lives in verifiedDispatcher (#697) — one resolution per
 * URL, shared by verification and the pinned connection. */
function assertFetchable(rawUrl: string): URL {
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
  return url;
}

const fetchTool: Tool<z.infer<typeof fetchSchema>> = {
  name: "fetch",
  description:
    "Fetch an http/https URL and return the response body as text. " +
    "Private/loopback targets are blocked unless MOH_FETCH_ALLOW_PRIVATE=1 is set. " +
    "Connections are pinned to the DNS-verified address (#697): a rebinding host cannot " +
    "pass verification as public and connect as private.",
  inputSchema: fetchSchema,
  async execute(args, ctx) {
    // #697: one DNS resolution per URL — the same answer both verifies the
    // host and pins the dial; every redirect hop re-checks and re-pins.
    const pin = await verifiedDispatcher(args.url);
    let url = assertFetchable(args.url);
    // SEC-05: redirects are followed manually (capped) so every hop
    // re-passes the scheme/private-network checks — a public URL can't
    // bounce the fetch into 169.254.169.254 or file://.
    let res = await doFetch(url, pin, ctx.signal);
    for (let hop = 0; hop < FETCH_MAX_REDIRECTS && [301, 302, 303, 307, 308].includes(res.status); hop++) {
      const location = res.headers.get("location");
      res.body?.cancel().catch(() => {});
      if (!location) break;
      const next = new URL(location, url).toString();
      const nextPin = await verifiedDispatcher(next);
      url = assertFetchable(next);
      res = await doFetch(url, nextPin, ctx.signal);
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

const askUserQuestionSchema = z.object({
  question: z.string().min(1),
  header: z.string().min(1),
  options: z
    .array(
      z.object({
        label: z.string().min(1),
        description: z.string(),
        preview: z.string().optional(),
      }),
    )
    .min(2)
    .max(4),
  multiSelect: z.boolean().optional(),
  // Optional by contract (suggested is purely visual): GLM-class models
  // routinely omit it and a hard failure here costs a full retry round —
  // observed twice in a row in production (sessions a1dfb4c8/9695c69c).
  suggested: z.string().min(1).optional(),
});

/**
 * #731: tolerate the two observed model mistakes instead of failing the
 * whole ask_user call (~80 validation failures in production): a header
 * over 12 characters is trimmed to the 12-char budget, and a `suggested`
 * that does not exactly match an option label is snapped to a
 * case-insensitive/prefix match when unambiguous, dropped otherwise.
 * Both are purely visual fields — normalizing them is strictly better
 * than a failed round trip. Applied in execute (not a schema transform —
 * JSON Schema cannot represent transforms).
 */
function tolerantAskUserQuestions(questions: Array<z.infer<typeof askUserQuestionSchema>>) {
  return questions.map((q) => {
    let header = q.header;
    if (header.length > 12) {
      const trimmed = header.trim();
      if (trimmed.length > 0) header = trimmed.slice(0, 12);
    }
    let suggested = q.suggested;
    if (suggested !== undefined) {
      const labels = q.options.map((o) => o.label);
      if (!labels.includes(suggested)) {
        const lower = suggested.toLowerCase();
        const matches = labels.filter(
          (l) => l.toLowerCase() === lower || l.toLowerCase().startsWith(lower) || lower.startsWith(l.toLowerCase()),
        );
        if (matches.length === 1) suggested = matches[0]!;
        else if (matches.length === 0 && labels.length === 1) suggested = labels[0]!;
        else suggested = undefined;
      }
    }
    return { ...q, header, suggested, ...(suggested !== undefined ? {} : { suggested: undefined }) };
  });
}

const askUserSchema = z
  .object({ questions: z.array(askUserQuestionSchema).min(1).max(4) })
  .superRefine((args, ctx) => {
    const seenQuestions = new Set<string>();
    for (const q of args.questions) {
      if (seenQuestions.has(q.question)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["questions"],
          message: `duplicate question text: "${q.question}"`,
        });
      }
      seenQuestions.add(q.question);
      const labels = new Set(q.options.map((o) => o.label));
      if (labels.size !== q.options.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["questions"],
          message: `option labels must be unique within a question ("${q.question}")`,
        });
      }
    }
  });

/** Rejects a settled-but-invalid answer with a precise message (#68:
 * never silently substitute a default). */
function askUserAnswerError(detail: string): never {
  throw new Error(`ask_user: ${detail}`);
}

/** Normalizes one answer against its question: validates labels and the
 * single/multi shape, and produces the result's answer line. */
function askUserAnswerLine(question: AskUserQuestion, answer: AskUserAnswer): string {
  const offered = new Set(question.options.map((o) => o.label));
  const labels = answer.labels ?? [];
  if (labels.some((l) => !offered.has(l))) {
    askUserAnswerError(
      `answer for "${question.question}" includes a label that was not offered (${labels.filter((l) => !offered.has(l)).join(", ")})`,
    );
  }
  if (!question.multiSelect && labels.length > 1) {
    askUserAnswerError(`answer for "${question.question}" carries multiple labels but the question is single-select`);
  }
  if (question.multiSelect && labels.length === 0 && answer.other === undefined) {
    askUserAnswerError(`answer for "${question.question}" carries neither a selection nor "Other" text`);
  }
  if (!question.multiSelect && labels.length > 0 && answer.other !== undefined) {
    askUserAnswerError(`answer for "${question.question}" combines a choice with "Other" text in single-select mode`);
  }
  const parts: string[] = [];
  if (labels.length > 0) parts.push(labels.join(", "));
  if (answer.other !== undefined) parts.push(`Other: ${answer.other}`);
  if (parts.length === 0) askUserAnswerError(`answer for "${question.question}" is empty`);
  // #414: the chosen option's preview is echoed to the model — it saw the
  // box only on the user's screen, so the selection carries its content.
  const previews = labels
    .map((label) => question.options.find((o) => o.label === label)?.preview)
    .filter((p): p is string => p !== undefined);
  return previews.length > 0 ? `${parts.join(" + ")}\n${previews.join("\n---\n")}` : parts.join(" + ");
}

/** The settled result of one ask_user set (ADR-0019): question → answer
 * lines, or an explicit "cancelled" when the user aborted the set. */
export function formatAskUserSetResult(
  questions: AskUserQuestion[],
  result: AskUserSetResult,
): string {
  if (result.cancelled) return "cancelled";
  const { answers } = result;
  if (answers.length !== questions.length) {
    askUserAnswerError(`expected ${questions.length} answers, got ${answers.length}`);
  }
  return questions
    .map((q, i) => `${q.question}: ${askUserAnswerLine(q, answers[i]!)}`)
    .join("\n");
}

const askUser: Tool<z.infer<typeof askUserSchema>> = {
  name: "ask_user",
  interactive: true,
  description:
    "Ask the user 1–4 questions in one round. Each question has full text (unique in the set), a required short header (≤12 chars, a chip label shown ABOVE the question — never repeat the header or the keybinding inside the question text), 2–4 options (label + short description, optional preview), optional multiSelect, and an optional `suggested` — the recommended option label, purely visual. The user may answer with an option, options (multiSelect), or free text ('Other'). How many questions per round is your decision; prefer fewer. Prefer this over asking in plain chat when a decision has clear alternatives.",
  inputSchema: askUserSchema,
  async execute(args, ctx) {
    if (!ctx.askUser) {
      throw new Error(
        "ask_user: no interactive user is attached (headless mode). " +
          "Proceed without asking — rephrase or make the decision yourself.",
      );
    }
    // #731: normalization lives here (not in a schema transform) — JSON
    // Schema cannot represent transforms, and the provider-facing schema
    // must stay expressible.
    const result = await ctx.askUser({ questions: tolerantAskUserQuestions(args.questions) });
    return formatAskUserSetResult(args.questions, result);
  },
};

function joinSafe(root: string, rel: string): string {
  return `${root}/${rel.split("\\").join("/")}`;
}

export interface BuiltinToolsOptions {
  /** Root for secure, per-session bash capture directories. */
  ledgerRoot?: string;
  /** #304 test seam: minimum duration for a run to count as expensive
   * (default 10s). Tests inject a small value so the capture/re-run
   * paths run against sub-second fake suites. */
  rerunMinMs?: number;
  /** #774 / ADR-0029: moh.json `browser` section. Absent or
   * `enabled: false` → the tool is not registered at all (zero-config
   * silence). When enabled but the toolchain is missing, the tool is
   * still not registered and `diagnostics` carries the install hint. */
  browser?: { enabled?: boolean; headless?: boolean; allowedHosts?: string[] };
  /** Out-param: why the browser tool is absent (toolchain missing), for
   * the session-start diagnostic. Always null when enabled is falsy. */
  diagnostics?: string[];
  /** Out-param: the live browser session, present only when the tool
   * registered. The caller disposes it with the session (#774). */
  browserSession?: BrowserSession;
}

export function builtinTools(options: BuiltinToolsOptions = {}): Record<string, Tool> {
  const readLedger = new Map<string, ServedRead>();
  const runLedger = createRunLedger(options.ledgerRoot);
  const all: Tool[] = [bashTool(runLedger, options.rerunMinMs), readTool(readLedger), write, edit, glob, grep, fetchTool, todo, askUser];
  // #774 / ADR-0029: the browser tool registers only when explicitly
  // enabled. A missing toolchain is a visible diagnostic, never a turn
  // error and never a session failure — the other tools stay untouched.
  if (options.browser?.enabled) {
    const { browserAvailability, BrowserSession, BROWSER_INSTALL_HINT } = lazyRequire("./browser") as typeof import("./browser");
    const { browserTool } = lazyRequire("./browser-tool") as typeof import("./browser-tool");
    const availability = browserAvailability();
    if (availability.available) {
      const session = new BrowserSession({
        home: options.ledgerRoot ? dirname(dirname(options.ledgerRoot)) : undefined,
        headless: options.browser.headless ?? true,
      });
      all.push(browserTool({ session, allowedHosts: options.browser.allowedHosts }));
      // Session-lifecycle seam: the caller (from-config) reads it to reap
      // the browser at session dispose.
      (options as { browserSession?: BrowserSession }).browserSession = session;
    } else {
      (options.diagnostics ??= []).push(
        `browser tool disabled: ${availability.reason}. Install with: ${BROWSER_INSTALL_HINT}`,
      );
    }
  }
  return Object.fromEntries(all.map((t) => [t.name, t as Tool]));
}
