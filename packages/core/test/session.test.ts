import { describe, expect, test } from "bun:test";
import { createSession, MockProvider } from "../src/index";

describe("core agent loop", () => {
  test("send() on a scripted MockProvider streams text_delta events and ends with done", async () => {
    const provider = MockProvider.scripted([
      { deltas: ["Hello", " world"], finish: "stop" },
    ]);
    const session = createSession({ provider });

    const streamed: unknown[] = [];
    void (async () => {
      for await (const event of session.events) streamed.push(event);
    })();

    const result = await session.send("hi");
    await Bun.sleep(10);

    expect(result.status).toBe("done");
    expect(streamed.map((e: any) => e.type)).toEqual([
      "session_start",
      "user_message",
      "assistant_delta",
      "assistant_delta",
      "done",
    ]);
    const text = streamed
      .filter((e: any) => e.type === "assistant_delta")
      .map((e: any) => e.text)
      .join("");
    expect(text).toBe("Hello world");
  });
});
