/**
 * `moh serve` (#525): RPC mode driving one session over stdin/stdout
 * LF-delimited JSON lines. One process, one session, one client — the
 * transport is the process's stdio, so there is no auth surface.
 *
 * Protocol v1 is minimal and closed (see docs/serve-protocol.md): the
 * client drives with `initialize`/`send`/`permission_response`/
 * `interrupt`/`ping`, moh answers with `ready`/`event`/`permission_request`/
 * `result`/`error`/`pong`. Events ride the existing AgentEvent envelope
 * verbatim — the protocol does not redefine event shapes. Assembly goes
 * through the core's single path (`sessionFromConfig`, ADR-0005); the
 * core does not know RPC exists.
 */
import { resolve as pathResolve } from "node:path";
import { createInterface } from "node:readline";
import {
  MockProvider,
  RuleError,
  SessionStore,
  sessionFromConfig,
  overridesFromFlags,
  type AgentEvent,
  type AgentSession,
} from "@moh/core";
import { ArgError, parseArgs } from "./args";
import { BUNDLED_EXTENSION_SOURCES } from "../../tui/src/bundled-extensions";

export const SERVE_USAGE = `usage: moh serve [options]

RPC mode: drive one session over stdin/stdout as LF-delimited JSON
lines (protocol v1, see docs/serve-protocol.md). Events stream to
stdout interleaved with protocol messages; stderr stays for human
warnings. The session persists to the same JSONL log as moh run, so a
session can move between moh run --session, moh serve, and TUI resume.

options:
  --provider <ref>           "mock", a custom id, or endpoint/model-id (moh.json)
  --session <file>           resume an existing session JSONL (append)
  --allow <rule>             grant a permission rule (repeatable)
  --deny <rule>              deny a permission rule (repeatable)
  --auto-accept              auto-accept every permission prompt
  --yolo                     no permission prompts, unrestricted filesystem
  --cwd <dir>                project root (default: process.cwd())

notes:
  - initialize (the first client message) may override cwd, provider
    and permission rules per connection; launch flags are the defaults.
  - exit code: 0 on clean stdin EOF, 2 on startup errors.`;

export const PROTOCOL_VERSION = 1;

type Json = Record<string, unknown>;

export interface ServeOptions {
  argv: string[];
  cwd?: string;
  /** Isolated home for tests; defaults to the real user home. */
  home?: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

interface PendingPermission {
  resolve: (decision: "yes" | "always" | "no") => void;
}

/** Control-flow sentinel: handleInitialize already answered bad_message. */
const badMessageSentinel = Symbol("bad-message");

export async function serveCommand(options: ServeOptions): Promise<number> {
  const out = options.stdout ?? process.stdout;
  const err = options.stderr ?? process.stderr;
  const input = options.stdin ?? process.stdin;
  let parsed;
  try {
    parsed = parseArgs(options.argv, {
      strings: ["provider", "session", "cassette", "cwd"],
      lists: ["allow", "deny"],
      booleans: ["auto-accept", "yolo"],
    });
  } catch (e) {
    err.write(e instanceof ArgError ? `moh serve: ${e.message}\n` : String(e));
    return 2;
  }
  if (parsed.positionals.length > 0) {
    err.write("moh serve: unexpected positional arguments\n");
    return 2;
  }

  // ── Protocol state ────────────────────────────────────────────────────
  let initialized = false;
  let disposed = false;
  let busy = false;
  let permissionSeq = 0;
  const pendingPermissions = new Map<number, PendingPermission>();

  const write = (msg: Json) => {
    out.write(JSON.stringify(msg) + "\n");
  };
  const writeError = (message: string, code: string, id?: unknown) => {
    write({ type: "error", ...(id !== undefined ? { id } : {}), code, message });
  };

  let session: AgentSession | undefined;

  const disposeSession = async () => {
    if (disposed) return;
    disposed = true;
    // Unresolved permission asks must not hang the gate: deny them.
    for (const p of pendingPermissions.values()) p.resolve("no");
    pendingPermissions.clear();
    try {
      await session?.dispose();
    } catch {
      // Disposal must never fail the RPC shutdown path.
    }
  };

  // ── Consent seam: permission round-trip over the protocol ────────────
  const onPermissionRequest = (tool: string, args: unknown) =>
    new Promise<"yes" | "always" | "no">((resolve) => {
      const id = ++permissionSeq;
      pendingPermissions.set(id, { resolve });
      write({ type: "permission_request", id, tool, args });
    });

  // ── Message handling ─────────────────────────────────────────────────
  const startTurn = async (id: unknown, text: string) => {
    busy = true;
    let result;
    try {
      result = await session!.send(text);
    } catch (e) {
      busy = false;
      writeError(e instanceof Error ? e.message : String(e), "send_failed", id);
      return;
    }
    busy = false;
    const exitCode =
      result.status === "error" ? 1 : result.status === "cancelled" ? 130 : 0;
    write({
      type: "result",
      id,
      status: result.status,
      exitCode,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.message ? { message: result.message } : {}),
    });
  };

  const handleMessage = async (msg: Json) => {
    const type = typeof msg.type === "string" ? msg.type : undefined;
    const id = msg.id;
    if (!type) {
      writeError("missing message type", "bad_message", typeof id === "number" ? id : undefined);
      return;
    }
    if (type === "ping") {
      write({ type: "pong", ...(id !== undefined ? { id } : {}) });
      return;
    }
    if (type === "initialize") {
      await routeInitialize(msg);
      return;
    }
    if (!initialized) {
      writeError(`expected "initialize" as the first message, got "${type}"`, "not_initialized", id);
      return;
    }
    if (type === "send") {
      if (typeof msg.text !== "string" || msg.text.trim() === "") {
        writeError('"send" requires a non-empty "text" string', "bad_message", id);
        return;
      }
      if (busy) {
        writeError("a turn is already in flight; wait for its result", "busy", id);
        return;
      }
      await startTurn(id, msg.text);
      return;
    }
    if (type === "permission_response") {
      const reqId = msg.id;
      const decision = msg.decision;
      const pending = typeof reqId === "number" ? pendingPermissions.get(reqId) : undefined;
      if (!pending) {
        writeError(`no pending permission request with id ${JSON.stringify(reqId ?? null)}`, "unknown_permission", reqId);
        return;
      }
      if (decision !== "yes" && decision !== "always" && decision !== "no") {
        writeError('"decision" must be "yes", "always" or "no"', "bad_message", reqId);
        return;
      }
      pendingPermissions.delete(reqId as number);
      pending.resolve(decision);
      return;
    }
    if (type === "interrupt") {
      if (!busy) {
        writeError("no turn in flight", "not_pending", id);
        return;
      }
      session!.abort();
      // No direct ack: the in-flight send's `result` (status "cancelled")
      // is the confirmation, mirroring moh run's exit-130 semantics.
      return;
    }
    writeError(`unknown message type "${type}"`, "bad_message", typeof id === "number" ? id : undefined);
  };

  /** Route the already-gated `initialize` message. */
  const routeInitialize = async (msg: Json): Promise<boolean> => {
    if (initialized) {
      writeError("session already initialized", "already_initialized", msg.id);
      return false;
    }
    await handleInitialize(msg);
    return true;
  };

  const handleInitialize = async (msg: Json) => {
    const requested = msg.protocolVersion ?? PROTOCOL_VERSION;
    if (requested !== PROTOCOL_VERSION) {
      writeError(`unsupported protocol version ${JSON.stringify(requested)} (this build speaks ${PROTOCOL_VERSION})`, "version", msg.id);
      return;
    }
    const cwd = pathResolve(
      typeof msg.cwd === "string" ? msg.cwd : parsed.strings["cwd"] ?? options.cwd ?? process.cwd(),
    );
    const allow: string[] = [...(parsed.lists["allow"] ?? [])];
    const deny: string[] = [...(parsed.lists["deny"] ?? [])];
    // Fail-loud (#525): a non-string rule in the initialize body is a
    // bad message, never a silently dropped entry (no silent fallbacks).
    const collectRules = (key: "allow" | "deny") => {
      const raw = msg[key];
      if (raw === undefined) return;
      if (!Array.isArray(raw)) {
        writeError(`"${key}" must be an array of rule strings`, "bad_message", msg.id);
        throw badMessageSentinel;
      }
      for (const r of raw) {
        if (typeof r !== "string") {
          writeError(`"${key}" must contain only rule strings, got ${JSON.stringify(r)}`, "bad_message", msg.id);
          throw badMessageSentinel;
        }
        (key === "allow" ? allow : deny).push(r);
      }
    };
    try {
      collectRules("allow");
      collectRules("deny");
    } catch (e) {
      if (e === badMessageSentinel) return;
      throw e;
    }
    let cliOverrides;
    try {
      cliOverrides = overridesFromFlags(allow, deny);
    } catch (e) {
      writeError(e instanceof RuleError || e instanceof Error ? e.message : String(e), "bad_rule", msg.id);
      return;
    }
    const providerRef =
      typeof msg.provider === "string" ? msg.provider : parsed.strings["provider"];
    let resumeStore: SessionStore | undefined;
    try {
      if (parsed.strings["session"]) {
        resumeStore = SessionStore.open(pathResolve(cwd, parsed.strings["session"]!));
      }
    } catch (e) {
      writeError(e instanceof Error ? e.message : String(e), "session", msg.id);
      return;
    }
    const cassetteProvider = (() => {
      try {
        return parsed.strings["cassette"]
          ? MockProvider.cassette(pathResolve(cwd, parsed.strings["cassette"]!))
          : undefined;
      } catch (e) {
        writeError(e instanceof Error ? e.message : String(e), "cassette", msg.id);
        return "failed" as const;
      }
    })();
    if (cassetteProvider === "failed") return;
    let assembled;
    try {
      assembled = sessionFromConfig({
        cwd,
        // #826: the bundled first-party extensions this client ships.
        bundledExtensions: BUNDLED_EXTENSION_SOURCES,
        ...(options.home ? { home: options.home } : {}),
        ...(cassetteProvider ? { provider: cassetteProvider } : {}),
        ...(providerRef ? { providerRef } : {}),
        overrides: {
          permissionFlags: cliOverrides,
          permissions: {
            mode: parsed.booleans["auto-accept"] ? "auto-accept" : "normal",
            unrestrictedTools: parsed.booleans["yolo"] || undefined,
          },
          // #525: events ride the sink, same single-writer ordering as
          // `moh run` — resume-seeded events are not re-emitted.
          sink: (event: AgentEvent) => write({ type: "event", event }),
          ...(resumeStore ? { store: resumeStore } : {}),
        },
        consent: { onPermissionRequest },
      });
    } catch (e) {
      writeError(e instanceof Error ? e.message : String(e), "config", msg.id);
      return;
    }
    if ("error" in assembled) {
      writeError(assembled.error.message, assembled.error.kind, msg.id);
      return;
    }
    session = assembled.session;
    initialized = true;
    write({
      type: "ready",
      protocolVersion: PROTOCOL_VERSION,
      sessionFile: (resumeStore ?? assembled.store).file,
    });
  };

  // ── Framing: strict LF-delimited JSON lines over stdin ───────────────
  const rl = createInterface({ input: input as NodeJS.ReadableStream, terminal: false });
  const closed = new Promise<void>((resolveClose) => {
    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      let msg: Json;
      try {
        const value: unknown = JSON.parse(trimmed);
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new Error("message must be a JSON object");
        }
        msg = value as Json;
      } catch (e) {
        writeError(`malformed JSON line: ${e instanceof Error ? e.message : String(e)}`, "bad_json");
        return;
      }
      void handleMessage(msg).catch((e: unknown) => {
        writeError(e instanceof Error ? e.message : String(e), "internal", typeof msg.id === "number" ? msg.id : undefined);
      });
    });
    rl.on("close", () => resolveClose());
  });

  await closed;
  await disposeSession();
  return 0;
}
