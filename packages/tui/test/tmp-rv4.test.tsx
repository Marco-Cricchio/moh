import { test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Chat } from "./../src/Chat";
import { createSession, type Provider } from "@moh/core";
import { stripAnsi } from "./helpers";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
test("probe: long freeze", async () => {
  const provider = {
    name: "rv4",
    stream: async function* () {
      yield { type: "model_call_start", model: "m" } as any;
      for (let i = 0; i < 45; i++) yield { type: "reasoning_delta", text: `R${i} checking the design.\n` } as any;
      yield { type: "reasoning_end" } as any;
      yield { type: "text_delta", text: "## Architecture\n\n1. **REPLY-FIRST-ROW** " } as any;
      for (let i = 0; i < 65; i++) {
        yield { type: "text_delta", text: `DETAIL-${String(i).padStart(2, "0")} the core owns the agent loop and the clients display its events. ` } as any;
        await sleep(20);
      }
      yield { type: "text_delta", text: "REPLY-LIVE-TAIL" } as any;
      await sleep(15000);
      yield { type: "finish", reason: "stop" } as any;
    },
  } as unknown as Provider;
  const session = createSession({ provider, memory: { enabled: false } });
  const done = session.send("explain the architecture");
  const ui = render(<Chat session={session} cwd={process.cwd()} mode="vibe" modelLabel="m" width={100} />);
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    const f = stripAnsi(ui.lastFrame() ?? "");
    console.log(`t=${((i + 1) * 0.5).toFixed(1)}s tail=${f.includes("REPLY-LIVE-TAIL")} len=${f.length} last=${JSON.stringify(f.slice(-40))}`);
  }
  ui.unmount();
  await done;
}, 40000);
