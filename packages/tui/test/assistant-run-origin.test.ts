import { expect, test } from "bun:test";
import type { AgentEvent } from "@moh/core";
import { assistantRunOrigin, projectTranscript } from "../src/transcript";

const delta = (text: string): AgentEvent => ({ type: "assistant_delta", text });

test("a mid-run slice preserves canonical segment identity and formatting", () => {
  const events: AgentEvent[] = [
    { type: "user_message", text: "architecture" },
    delta("Introduction.\n\n"),
    delta("1. **Core** first item\n"),
    delta("2. **Client** second item\n\n"),
    delta("Closing paragraph."),
  ];
  const full = projectTranscript(events);
  for (const start of [2, 3, 4]) {
    const origin = assistantRunOrigin(events, start);
    const slice = projectTranscript(events.slice(start), { keyBase: start, initialAssistantRun: origin });
    for (const block of slice) {
      const canonical = full.find((candidate) => candidate.key === block.key);
      expect(canonical).toBeDefined();
      expect(block.markdown).toBe(canonical!.markdown);
      expect(block.continuation).toBe(canonical!.continuation);
      expect(block.tight).toBe(canonical!.tight);
    }
  }
});

test("identical text in separate replies has separate identity", () => {
  const events: AgentEvent[] = [
    { type: "user_message", text: "first" }, delta("- **Same** legitimate repeated text"),
    { type: "user_message", text: "again" }, delta("- **Same** legitimate repeated text"),
  ];
  const replies = projectTranscript(events).filter((block) => block.markdown);
  expect(replies).toHaveLength(2);
  expect(replies[0]!.markdown).toBe(replies[1]!.markdown);
  expect(replies[0]!.key).not.toBe(replies[1]!.key);
  expect(assistantRunOrigin(events, 3)).toBeUndefined();
});
