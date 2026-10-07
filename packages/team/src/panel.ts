/**
 * The team panel (#1225, ADR-0062 as amended): the one panel this
 * extension contributes to the extensions rail. The roster is live state
 * the extension tracks around its own spawns and steering — the same
 * member set the `team` tool drives — and the detail view renders inside
 * the panel (never a modal), one member at a time. The client owns the
 * rail: keys reach `onKey` only in focus mode, and only the keys the
 * client does not consume itself (`n`/`p` select, `enter` toggles the
 * detail; `j`/`k` stay the client's scroll). Liveness rides the client's
 * frames: the render is pure per call and reads this state fresh.
 *
 * The panel draws plain text — the render returns a string, which the
 * client shows verbatim; this package takes no UI dependency.
 */
import type { ExtensionPanel, PanelKeyEvent } from "@moh/extension";

/** A member's live status, as the extension observed it. */
export type PanelMemberStatus = "working" | "done" | "error" | "cancelled" | "idle";

/** One member of the roster, in the panel's own words. */
export interface PanelMember {
  readonly name: string;
  readonly role: "builder" | "reviewer";
  readonly scope?: string;
  readonly lane?: string;
  readonly model?: string;
  status: PanelMemberStatus;
  /** The task the member was dispatched with, truncated for the roster. */
  task?: string;
  /** The child-tail activity (never the provider reasoning). */
  currentTool?: string | null;
  outputChars?: number;
  error?: string;
}

/** The panel's own state, mutated by the tool paths and read by render. */
export interface TeamPanelState {
  /** Insertion order is the roster order. */
  readonly members: Map<string, PanelMember>;
  /** The selected member's index into the roster. */
  selection: number;
  /** false = roster, true = the selected member's detail. */
  detail: boolean;
}

export function createTeamPanelState(): TeamPanelState {
  return { members: new Map(), selection: 0, detail: false };
}

/** Registers (or refreshes) a member as dispatched: status working. */
export function markMemberWorking(
  state: TeamPanelState | undefined,
  member: { name: string; role: "builder" | "reviewer"; scope?: string; lane?: string; model?: string },
  task: string,
): void {
  if (!state) return;
  const existing = state.members.get(member.name);
  state.members.set(member.name, {
    ...(existing ?? member),
    name: member.name,
    role: member.role,
    ...(member.scope !== undefined ? { scope: member.scope } : {}),
    ...(member.lane !== undefined ? { lane: member.lane } : {}),
    ...(member.model !== undefined ? { model: member.model } : {}),
    status: "working",
    task,
    currentTool: null,
  });
}

/** Records a settled outcome — or a steering re-entry (working again). */
export function settleMember(
  state: TeamPanelState | undefined,
  name: string,
  status: "working" | "done" | "error" | "cancelled",
  observation: { outputChars?: number; error?: string; currentTool?: string | null } = {},
): void {
  const member = state?.members.get(name);
  if (!member) return;
  member.status = status;
  member.currentTool = observation.currentTool ?? null;
  if (observation.outputChars !== undefined) member.outputChars = observation.outputChars;
  member.error = observation.error;
}

const GLYPH: Record<PanelMemberStatus, string> = { working: "●", done: "✓", error: "✗", cancelled: "◌", idle: "·" };

/** The rail body is 36 columns wide (38 minus the border pair); the
 * extension truncates its own text to stay inside. */
function clip(text: string, width = 36): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function bagCounts(tasks: readonly { status: string }[]): { done: number; claimed: number; open: number } {
  const counts = { done: 0, claimed: 0, open: 0 };
  for (const task of tasks) {
    if (task.status === "done") counts.done += 1;
    else if (task.status === "claimed") counts.claimed += 1;
    else counts.open += 1;
  }
  return counts;
}

/** The roster line for one member, roster mode. */
function rosterLine(member: PanelMember, selected: boolean): string {
  const head = clip(`${selected ? ">" : " "}${GLYPH[member.status]} ${member.name} — ${member.role}`, 26);
  const budget = 36 - head.length;
  const tail: string[] = [];
  if (member.lane !== undefined) tail.push(`lane ${member.lane}`);
  if (member.status === "working" && member.currentTool) tail.push(member.currentTool);
  else if (member.task !== undefined && member.status !== "idle") tail.push(member.task);
  // The envelope (lane) outranks the work text: if both cannot fit, the
  // task is dropped from the roster line — the detail view carries it.
  let suffix = tail.length > 0 ? ` · ${tail.join(" · ")}` : "";
  if (suffix.length > budget && tail.length > 1) {
    suffix = ` · ${tail[0]!}`;
  }
  return `${head}${suffix.length <= budget ? suffix : clip(suffix, budget)}`;
}

/** The detail view: the member's envelope and its last observation. */
function detailView(member: PanelMember): string {
  const lines = [
    `${member.name} · ${member.role}`,
    member.scope !== undefined ? `scope ${member.scope}` : "unscoped",
    ...(member.lane !== undefined ? [`lane ${member.lane}`] : []),
    ...(member.model !== undefined ? [`model ${member.model}`] : []),
    member.status === "working" && member.currentTool
      ? `working · ${member.currentTool}`
      : `${member.status}${member.outputChars !== undefined ? ` · ${member.outputChars} chars` : ""}`,
    ...(member.task !== undefined ? [clip(`task: ${member.task}`)] : []),
    ...(member.error ? [clip(`error: ${member.error}`)] : []),
  ];
  return `${lines.join("\n")}\nn/p member · enter back`;
}

/**
 * Builds the panel. `bagTasks` reads the live bag (the extension's own
 * durable state) so the header carries the board summary without the
 * panel owning any state of its own.
 */
export function createTeamPanel(state: TeamPanelState, bagTasks: () => readonly { status: string }[]): ExtensionPanel {
  const order = (): PanelMember[] => [...state.members.values()];
  return {
    name: "team",
    description: "live team roster and member detail",
    maxHeight: 12,
    render: () => {
      const members = order();
      if (members.length === 0) return "no members yet — ask the team to work";
      const bag = bagTasks();
      if (state.detail) {
        const member = members[Math.min(state.selection, members.length - 1)]!;
        return detailView(member);
      }
      const counts = bagCounts(bag);
      const head = clip(`team: ${members.length} member${members.length === 1 ? "" : "s"} · bag ${counts.done}/${bag.length} done`);
      const selected = Math.min(state.selection, members.length - 1);
      const lines = members.map((m, i) => rosterLine(m, i === selected));
      lines.push("n/p member · enter detail");
      return [clip(head), ...lines.map((line) => clip(line))].join("\n");
    },
    onKey: (input: string, key: PanelKeyEvent): boolean => {
      const count = state.members.size;
      if (key.return) {
        if (count === 0) return false;
        state.detail = !state.detail;
        return true;
      }
      if (input === "n") {
        if (count === 0) return false;
        state.selection = Math.min(state.selection + 1, count - 1);
        return true;
      }
      if (input === "p") {
        if (count === 0) return false;
        state.selection = Math.max(state.selection - 1, 0);
        return true;
      }
      return false;
    },
  };
}
