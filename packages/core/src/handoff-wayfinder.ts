/**
 * Session Handoff T6 (#439): read-only Wayfinder enrichment. Raw links
 * are persisted by the post-turn runner; this module resolves their titles,
 * URLs and the exact parent-map frontier only immediately before a manual
 * or automatic publish. Failure deliberately leaves the raw handoff intact.
 */
import type { RawHandoff } from "./handoff";
import { projectFrontier, type TrackerBackend } from "./tracker";

/** Best-effort, read-only projection. No tracker operation here writes. */
export async function enrichHandoffWithWayfinder(
  handoff: RawHandoff,
  tracker: TrackerBackend | null,
): Promise<RawHandoff> {
  if (!tracker || !handoff.wayfinderLinks?.length || !tracker.wayfinderSnapshot) return handoff;
  try {
    const snapshot = await tracker.wayfinderSnapshot(handoff.wayfinderLinks.map((link) => link.id));
    if (!snapshot) return handoff;
    const byId = new Map(snapshot.issues.map((issue) => [issue.id, issue]));
    const tickets = handoff.wayfinderLinks.flatMap((link) => {
      const issue = byId.get(link.id);
      // Only Wayfinder tickets belonging to the single resolved map travel.
      if (!issue || !issue.labels.some((label) => label.startsWith("wayfinder:"))) return [];
      return [{ ...link, title: issue.title, ...(issue.url ? { url: issue.url } : {}) }];
    });
    if (!tickets.length) return handoff;
    const frontier = projectFrontier(snapshot.issues);
    return {
      ...handoff,
      wayfinder: {
        tickets,
        frontier: {
          ready: frontier.ready.length,
          inProgress: frontier.inProgress.length,
          blocked: frontier.blocked.length,
        },
      },
    };
  } catch {
    return handoff;
  }
}

/** One deliberate tracker write path: called only by `moh handoff --notify-ticket`.
 * Mentioned tickets are context only; only a successful claimed link is notified. */
export async function notifyClaimedWayfinderTickets(
  handoff: RawHandoff,
  tracker: TrackerBackend | null,
  handoffUrl: string,
): Promise<number> {
  if (!tracker?.comment || !handoff.wayfinder) return 0;
  const claimed = handoff.wayfinder.tickets.filter((ticket) => ticket.relations.includes("claimed"));
  const frontier = handoff.wayfinder.frontier;
  const body = `moh session handoff published: ${handoffUrl}\n\nWayfinder frontier: ${frontier.ready} ready · ${frontier.inProgress} in progress · ${frontier.blocked} blocked.`;
  let notified = 0;
  for (const ticket of claimed) {
    await tracker.comment(ticket.id, body);
    notified += 1;
  }
  return notified;
}
