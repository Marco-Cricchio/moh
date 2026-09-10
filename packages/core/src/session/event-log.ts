import type { AgentEvent, ReasoningStreamEvent } from "../types";
import { newUlid } from "./ulid";

// Local copy of the `line:N` bridge shape (session-store owns the parser):
// a local import would close a module cycle (session-store → event-log).
const LINE_REF_RE = /^line:([1-9]\d*)$/;

/** Local `line:N` parser — same grammar as session-store's `parseLineRef`
 * (kept local for the same cycle-avoidance reason as LINE_REF_RE). */
function parseLineRefLocal(ref: string): number | null {
  const m = LINE_REF_RE.exec(ref);
  return m ? Number(m[1]) : null;
}

/** Whether `event`'s parent chain anchors at the log's root (`log[0]`):
 * true for legacy parentless events and for every node of a chain that
 * reaches the file's first event; false for orphan/divergence nodes whose
 * parent is absent (a #400 foreign tail, a #577 off-path write). A
 * parentless event whose preceding log is entirely legacy (no identified
 * ancestor exists to name) anchors too — it IS the identified branch tip
 * (format d8: no `line:N` is ever written). */
function activePathAnchored(event: AgentEvent, log: ReadonlyArray<AgentEvent>): boolean {
  const index = log.indexOf(event);
  const byId = new Map<string, AgentEvent>();
  for (let i = 0; i <= index; i++) {
    const e = log[i]!;
    if (e.id !== undefined) byId.set(e.id, e);
  }
  const seen = new Set<AgentEvent>();
  let cursor: AgentEvent | undefined = event;
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    if (cursor === log[0]) return true;
    const parentRef: string | undefined = cursor.parentId;
    if (parentRef === undefined) {
      // Anchor — unless an earlier identified event exists that this node
      // silently abandoned (an orphan dropped mid-file on an identified
      // log; on a legacy tail it is the legitimate identified tip).
      for (let i = 0; i < index; i++) {
        if (log[i]!.id !== undefined) return false;
      }
      return true;
    }
    const line = parseLineRefLocal(parentRef);
    cursor = line !== null ? log[line - 1] : byId.get(parentRef);
  }
  return false;
}

/** The dispatch surface EventLog needs from the extension runtime. */
export interface EventDispatcher {
  dispatchEvent(event: AgentEvent): Promise<AgentEvent[]>;
}

/**
 * #576 (head semantics d4): the head of the active path — the `to` of the
 * last `branch_switched` in the log, else the last event. A dangling `to`
 * (the referenced id is absent: truncation, corruption) falls back to the
 * last valid event and yields a `branch_dangling` warning so readers can
 * surface it visibly — never silent corruption.
 *
 * Returns `{ head, dangling }`: `head` is undefined on a purely legacy
 * tail (identity-less events — the degenerate linear tree); `dangling` is
 * the unmatched `to` when, and only when, the fallback fired.
 */
export function resolveHead(log: ReadonlyArray<AgentEvent>): {
  head: string | undefined;
  dangling: string | undefined;
} {
  let lastId: string | undefined;
  let switched: string | undefined;
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const event = log[i]!;
    // The fallback tip never lands on a switch event: on a dangling `to`
    // the head falls back to the last valid non-switch node (the branch
    // the file was actually on before the bad switch). Divergence-line
    // orphans (#400 foreign tails, #577 off-path writes) are skipped too:
    // their parent chains do not reach the root, so the head would
    // otherwise dangle into a discarded branch.
    if (lastId === undefined && event.id !== undefined && event.type !== "branch_switched" && activePathAnchored(event, log)) {
      lastId = event.id;
    }
    if (switched === undefined && event.type === "branch_switched") {
      switched = (event as { type: "branch_switched"; to: string }).to;
      if (lastId !== undefined) break;
    }
    if (lastId !== undefined && switched !== undefined) break;
  }
  if (switched === undefined) return { head: lastId, dangling: undefined };
  const known = log.some((e) => e.id === switched);
  // A `line:N` bridge target always resolves (it points at a written line
  // by construction — the writer validated it; an out-of-range bridge is
  // caught by resolveEventRef at the use site).
  if (known || LINE_REF_RE.test(switched)) return { head: switched, dangling: undefined };
  return { head: lastId, dangling: switched };
}

/**
 * #576: the id of the log's last identified event. Kept for the legacy
 * default-parent rule of direct appends (rename/fork stamping) where no
 * `branch_switched` exists; tree-aware callers use `resolveHead`.
 */
export function headId(log: ReadonlyArray<AgentEvent>): string | undefined {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (log[i]!.id !== undefined) return log[i]!.id;
  }
  return undefined;
}

/**
 * #577 (core spec d1): the active-path projection — one pass turns the
 * file's event array into the linear root→head path. The head follows
 * `resolveHead` (the `to` of the last `branch_switched`, else the last
 * event); within the path the order is file order. Every event is
 * on-path iff its `parentId` chain reaches the root (the first event);
 * orphans — parents not in the file or off-path — are excluded, never
 * silently merged. Chrome events stay in the path (they are tree nodes,
 * format d4); `replayMessages` already drops them downstream.
 *
 * A purely legacy tail (no ids) is the degenerate linear tree: the input
 * array projects to itself. A dangling switch target falls back per
 * `resolveHead`; the switch node itself stays on-path (it was appended on
 * the branch it interrupted), so the visible-warning marker survives to
 * replay.
 */
export function activePath(events: ReadonlyArray<AgentEvent>): AgentEvent[] {
  // Degenerate legacy log (or empty): identity-less events have no
  // chains to follow — the file order IS the path.
  if (events.length === 0 || events[0]!.id === undefined) return [...events];
  const { head, dangling } = resolveHead(events);
  if (head === undefined) return [...events];
  return pathTo(events, head) ?? [...events];
}

/**
 * #578 (core spec d7): the root→`nodeId` projection — the same
 * linearization as `activePath` but anchored at an explicit node instead
 * of the resolved head. The compaction producer uses it to summarize the
 * branch the turn was actually pinned to, even when the head has already
 * moved. Null when the node is unknown or its parent chain does not
 * anchor at the file's root (same certification rules as `activePath`).
 */
export function pathTo(events: ReadonlyArray<AgentEvent>, nodeId: string): AgentEvent[] | null {
  if (events.length === 0 || events[0]!.id === undefined) return null;
  const { dangling } = resolveHead(events);
  const head = nodeId;
  // The base chain is the root→head chain from the head's parent links.
  // byId + positional parent resolution (`line:N` bridges).
  const byId = new Map<string, AgentEvent>();
  for (const e of events) {
    if (e.id !== undefined) byId.set(e.id, e);
  }
  const parentOf = (e: AgentEvent): AgentEvent | null | undefined => {
    if (e.parentId === undefined) return null; // anchor reached
    const line = parseLineRefLocal(e.parentId);
    if (line !== null) return events[line - 1] ?? null;
    return byId.get(e.parentId!) ?? null; // null = dangling: chain broken
  };
  // Walks the parent chain from `start` back toward the root. Returns
  // null when the chain is broken or does not anchor at the file's root
  // (a parentless node other than `events[0]` is a foreign root — a #400
  // divergence tail, an orphan line — never a path of its own).
  const walk = (start: string): AgentEvent[] | null => {
    const chain: AgentEvent[] = [];
    const seen = new Set<AgentEvent>();
    let event = byId.get(start);
    while (event !== undefined && !seen.has(event)) {
      seen.add(event);
      chain.push(event);
      const parent = parentOf(event);
      if (parent === null) {
        chain.reverse();
        return chain[0] === events[0] ? chain : null;
      }
      event = parent ?? undefined;
    }
    return null; // cycle or broken chain: no certified path
  };
  const base = walk(head);
  if (base === null) return null;
  // An interior anchor (compaction of the turn's pinned branch, #578
  // d7) projects exactly the root→anchor chain: events after the anchor
  // in file order belong to later turns or other branches — the
  // summarized span ends at the anchor. Only the log's real head gets
  // the in-order continuation (that continuation IS `activePath`).
  const isActiveHead = nodeId === resolveHead(events).head;
  if (!isActiveHead) return base;
  // After the base chain's tip, the branch continues in file order: every
  // subsequent event whose parent is the running tip extends the path
  // (this is how appends follow a switch to an interior node — the head
  // id stays at the `to` until the next switch, but the writer chains to
  // the active-path tip). Chrome stays in the path (format d4); `switch`
  // lines ride the tip they interrupted. Anything that does not chain to
  // the running tip is off-path: excluded, never silently merged.
  // A `branch_switched` on this branch moves the projection's continuation
  // only when it is the log's active head (`activePath`); for an interior
  // anchor (compaction of a past branch, #578) switch markers after the
  // anchor end the path there — the summarized branch is what the turn
  // pinned, not where the head later went.
  const path = [...base];
  const started = new Set(base.map((e) => e.id!));
  for (const e of events.slice(events.indexOf(base[base.length - 1]!) + 1)) {
    if (e.id === undefined) continue; // legacy interleaved nodes: file order
    const isSwitch = e.type === "branch_switched";
    const parentRef = e.parentId;
    const parentOk =
      parentRef !== undefined &&
      (path[path.length - 1]!.id === parentRef || started.has(parentRef));
    if (isSwitch) {
      // A switch is a topological marker on the branch it interrupted:
      // on-path only when its parent is the current tip. The head then
      // moves to its `to` (unless dangling — resolveHead already fell
      // back and warned); the path from there follows new chaining.
      // For an interior anchor the summarized branch ends at the anchor:
      // switches past it describe where the *head* went, not the branch
      // the projection certifies (#578 d7).
      if (parentOk && isActiveHead) {
        path.push(e);
        started.add(e.id!);
        if (dangling === undefined) {
          const lineTo = parseLineRefLocal(e.to ?? "");
          const target = lineTo !== null ? events[lineTo - 1] : byId.get(e.to ?? "");
          if (target) {
            const targetChain = walk(target.id!);
            if (targetChain !== null) {
              path.length = 0;
              path.push(...targetChain);
            }
          }
        }
      }
      continue;
    }
    if (parentOk && !started.has(e.id!)) {
      path.push(e);
      started.add(e.id!);
    }
  }
  return path;
}

export interface EventLogOptions {
  /** Persistence sink: every appended (never seeded) event, in order. */
  sink?: (event: AgentEvent) => void;
  /** Extensions whose onEvent hooks receive appended events. */
  extensions?: EventDispatcher;
}

/**
 * The append-only event log (#89): in-memory storage, sink fan-out,
 * listener notification (the `events` async-iterator projection) and the
 * serial extension dispatch queue with reentrancy guard. `extension_failed`
 * events are terminal — dispatching them back to the hooks that produced
 * them would let a throwing hook loop forever.
 *
 * Seeded (resume) events are stored but never re-appended: the persisted
 * file already has them, so they never reach the sink or the hooks.
 */
export class EventLog {
  readonly #log: AgentEvent[] = [];
  readonly #sink: ((event: AgentEvent) => void) | undefined;
  readonly #extensions: EventDispatcher | undefined;
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  /** #253: live (ephemeral) reasoning listeners — notified without
   * storage, sink, or extension dispatch. The completed block still
   * lands as a persisted `reasoning` AgentEvent at call settlement. */
  readonly #liveListeners = new Set<(event: ReasoningStreamEvent) => void>();
  /** Serial queue of events pending onEvent dispatch (never dropped). */
  readonly #queue: AgentEvent[] = [];
  /** Reentrancy guard: events appended while hooks dispatch are not re-dispatched. */
  #dispatching = false;
  #dispatchTail: Promise<void> = Promise.resolve();

  constructor(options: EventLogOptions = {}) {
    this.#sink = options.sink;
    this.#extensions = options.extensions;
  }

  /** Stores resume events without sink, listeners or hook dispatch. */
  seed(events: Iterable<AgentEvent>): void {
    for (const event of events) this.#log.push(event);
  }

  /** Appends one event; returns the stamped event as stored (its ULID is
   * writer-minted, so callers that need to reference the event — e.g. the
   * local-tip tracking of #576 — read it here). */
  append(event: AgentEvent): AgentEvent {
    // #575: every appended event carries identity — a fresh ULID `id` and
    // a `parentId` chaining it to the branch head (the last identified
    // event in the log; legacy tails have none, so the field is simply
    // absent there — the degenerate linear tree). An explicitly supplied
    // `parentId` (mandatory when appending off-head, format decision 3)
    // is preserved; the `id` is always writer-stamped, never trusted from
    // the caller.
    const stamped: AgentEvent = {
      ...event,
      id: newUlid(),
      ...(event.parentId !== undefined
        ? { parentId: event.parentId }
        : (() => {
            const head = resolveHead(this.#log).head;
            return head !== undefined ? { parentId: head } : {};
          })()),
    };
    this.#log.push(stamped);
    this.#sink?.(stamped);
    for (const listener of this.#listeners) listener(stamped);
    if (this.#extensions && stamped.type !== "extension_failed") {
      this.#queue.push(stamped);
      this.#drain();
    }
    return stamped;
  }

  /** Snapshot of the append-only log. */
  history(): AgentEvent[] {
    return [...this.#log];
  }

  /**
   * The live log array — for the host session's internal use only
   * (e.g. the memory runner's transcript windowing). Do not mutate.
   */
  live(): ReadonlyArray<AgentEvent> {
    return this.#log;
  }

  /** Async-iterator projection: replays history, then streams appends. */
  get events(): AsyncIterable<AgentEvent> {
    let cursor = 0;
    let notify: (() => void) | null = null;
    const listener = () => notify?.();
    this.#listeners.add(listener);
    let done = false;
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            if (cursor < self.#log.length) return { value: self.#log[cursor++]!, done: false };
            if (done) return { value: undefined as never, done: true };
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            notify = null;
            if (cursor < self.#log.length) return { value: self.#log[cursor++]!, done: false };
            return { value: undefined as never, done: true };
          },
          async return() {
            self.#listeners.delete(listener);
            done = true;
            return { value: undefined as never, done: true };
          },
        };
      },
    };
  }

  /** Notifies live listeners only: no storage, sink, or hooks (#253). */
  emitLive(event: ReasoningStreamEvent): void {
    for (const listener of this.#liveListeners) listener(event);
  }

  /** Subscribes to live (ephemeral) events; returns an unsubscribe fn. */
  onLive(listener: (event: ReasoningStreamEvent) => void): () => void {
    this.#liveListeners.add(listener);
    return () => this.#liveListeners.delete(listener);
  }

  /** Resolves when the dispatch queue is empty (no extensions: immediately). */
  idle(): Promise<void> {
    const check = (): Promise<void> =>
      this.#dispatching || this.#queue.length > 0 ? this.#dispatchTail.then(check) : Promise.resolve();
    return check();
  }

  #drain(): void {
    if (this.#dispatching || this.#queue.length === 0 || !this.#extensions) return;
    this.#dispatching = true;
    const event = this.#queue.shift()!;
    // Dispatch starts immediately (no extra microtask); the tail records the
    // in-flight chain so idle() can await the full drain.
    this.#dispatchTail = this.#extensions
      .dispatchEvent(event)
      .then((errors) => {
        for (const e of errors) this.append(e);
      })
      .finally(() => {
        this.#dispatching = false;
        this.#drain();
      });
  }
}
