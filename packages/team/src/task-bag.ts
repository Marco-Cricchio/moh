/**
 * The task bag (#1223, ADR-0074): the team extension's coordination seam.
 * Extension-owned state — not a core subsystem — whose every transition
 * (created, claimed, completed) is recorded as chrome events, so the board
 * reconstructs from the session log alone (`replayBoard`). Dependencies
 * (`blockedBy`) gate claiming: a task whose blockers are not done is not
 * claimable, which is also what terminates the self-serve loop on a cycle.
 */

/** The three transitions the log records; a non-done completion releases the claim. */
export type BagTaskStatus = "open" | "claimed" | "done";

export interface BagTask {
  readonly id: string;
  readonly title: string;
  readonly blockedBy: readonly string[];
  status: BagTaskStatus;
  /** The member holding the claim, when claimed. */
  claimedBy: string | null;
}

/** Chrome event names the bag writes through the extension's appendEvent. */
export const TASK_CREATED = "team_task_created";
export const TASK_CLAIMED = "team_task_claimed";
export const TASK_COMPLETED = "team_task_completed";

/** A board-shaped event: an `extension_event` entry from the session log. */
export interface BagEvent {
  readonly type: string;
  readonly name?: string;
  readonly payload?: {
    id?: string;
    title?: string;
    blockedBy?: string[];
    member?: string;
    callId?: string;
    outcome?: string;
    outputChars?: number;
  };
}

export class TaskBag {
  readonly tasks = new Map<string, BagTask>();
  #seq = 0;

  /** Validates refs against the whole plan up front — a bag is created whole or not at all. */
  static planIds(count: number): string[] {
    return Array.from({ length: count }, (_, i) => `t${i + 1}`);
  }

  create(tasks: readonly { title: string; blockedBy?: readonly string[] }[]): BagTask[] {
    const ids = TaskBag.planIds(tasks.length);
    const known = new Set([...this.tasks.keys(), ...ids]);
    // Whole or nothing: validate every spec before any mutation.
    for (const spec of tasks) {
      const unknown = (spec.blockedBy ?? []).filter((ref) => !known.has(ref));
      if (unknown.length > 0) {
        throw new Error(`unknown task reference: ${unknown.join(", ")}`);
      }
    }
    const created: BagTask[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const spec = tasks[i]!;
      const task: BagTask = { id: ids[i]!, title: spec.title, blockedBy: spec.blockedBy ?? [], status: "open", claimedBy: null };
      this.tasks.set(task.id, task);
      created.push(task);
    }
    return created;
  }

  /** The next task a member may claim: open, and every blocker done. */
  claimable(): BagTask | null {
    for (const task of this.tasks.values()) {
      if (task.status !== "open") continue;
      if (task.blockedBy.every((ref) => this.tasks.get(ref)?.status === "done")) return task;
    }
    return null;
  }

  claim(id: string, member: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== "open" || !task.blockedBy.every((ref) => this.tasks.get(ref)?.status === "done")) {
      return false;
    }
    task.status = "claimed";
    task.claimedBy = member;
    return true;
  }

  /** A done completion closes the task; anything else releases the claim back to open. */
  complete(id: string, outcome: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    if (outcome === "done") {
      task.status = "done";
    } else {
      task.status = "open";
      task.claimedBy = null;
    }
  }

  summary(): string {
    if (this.tasks.size === 0) return "the task bag is empty";
    const counts = { open: 0, claimed: 0, done: 0 } as Record<BagTaskStatus, number>;
    for (const task of this.tasks.values()) counts[task.status]++;
    return `task bag: ${this.tasks.size} tasks — ${counts.done} done, ${counts.claimed} in progress, ${counts.open} open`;
  }
}

/**
 * The board from the log alone: folds `team_task_*` chrome events into the
 * tasks and their statuses. The events are already stamped, redacted and
 * ordered by the log — this reads, never writes.
 */
export function replayBoard(events: readonly BagEvent[]): BagTask[] {
  const tasks = new Map<string, BagTask>();
  for (const event of events) {
    if (event.type !== "extension_event") continue;
    const payload = event.payload ?? {};
    if (event.name === TASK_CREATED && typeof payload.id === "string" && typeof payload.title === "string") {
      tasks.set(payload.id, {
        id: payload.id,
        title: payload.title,
        blockedBy: payload.blockedBy ?? [],
        status: "open",
        claimedBy: null,
      });
    } else if (event.name === TASK_CLAIMED && typeof payload.id === "string" && typeof payload.member === "string") {
      const task = tasks.get(payload.id);
      if (task && task.status === "open") {
        task.status = "claimed";
        task.claimedBy = payload.member;
      }
    } else if (event.name === TASK_COMPLETED && typeof payload.id === "string") {
      const task = tasks.get(payload.id);
      if (task && task.status === "claimed") {
        if (payload.outcome === "done") {
          task.status = "done";
        } else {
          task.status = "open";
          task.claimedBy = null;
        }
      }
    }
  }
  return [...tasks.values()];
}
