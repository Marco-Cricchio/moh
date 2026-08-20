import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { SessionStore, type AgentEvent } from "@moh/core";

/** One row of the home screen's resume list. */
export interface SessionSummary {
  /** Absolute JSONL path. */
  file: string;
  id: string;
  /** First user message, trimmed; placeholder when absent/unreadable. */
  title: string;
  /** Modification time (ms). */
  mtimeMs: number;
}

const titleFrom = (file: string): string => {
  const raw = readFileSync(file, "utf8");
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let event: AgentEvent;
    try {
      event = JSON.parse(line) as AgentEvent;
    } catch {
      break; // corrupt tail: stop at the first bad line
    }
    if (event.type === "user_message") {
      const text = event.text.replace(/\s+/g, " ").trim();
      return text.length > 60 ? text.slice(0, 57) + "…" : text || "(empty session)";
    }
  }
  return "(empty session)";
};

/**
 * Lists the project's persisted sessions, newest first, with a summary
 * title peeked from the log's first user_message. An unreadable file
 * degrades to a placeholder title — the home screen never crashes on user
 * data.
 */
export function listSessionSummaries(cwd: string, home?: string): SessionSummary[] {
  return SessionStore.list(cwd, home)
    .map((store) => {
      let title = "(unreadable session)";
      try {
        title = titleFrom(store.file);
      } catch {
        // keep placeholder
      }
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(store.file).mtimeMs;
      } catch {
        // keep 0
      }
      return { file: store.file, id: basename(store.file, ".jsonl"), title, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}
