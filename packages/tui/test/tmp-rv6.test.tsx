import { test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Chat } from "./../src/Chat";
import { createSession, type Provider } from "@moh/core";
import { stripAnsi } from "./helpers";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
test("probe: owner scenario — giant burst", async () => {
  const provider = {
    name: "rv6",
    stream: async function* () {
      yield { type: "model_call_start", model: "m" } as any;
      // ONE giant burst (GLM-style aggregated chunk), then long hold.
      yield { type: "text_delta", text: ("the core owns the agent loop while clients display. ").repeat(120) } as any;
      await sleep(15000);
      yield { type: "finish", reason: "stop" } as any;
    },
  } as unknown as Provider;
  const session = createSession({ provider, memory: { enabled: false } });
  const done = session.send("probe");
  const ui = render(<Chat session={session} cwd={process.cwd()} mode="vibe" modelLabel="m" width={100} />);
  for (let i = 0; i < 14; i++) {
    await sleep(700);
    const f = stripAnsi(ui.lastFrame() ?? "");
    const lines = f.split("\n").filter(l => l.includes("the core owns"));
    const shown = lines.length;
    const partial = lines.length ? lines[lines.length-1].slice(0,40) : "";
    console.log(`t=${((i+1)*0.7).toFixed(1)}s rows=${shown} last="${partial}"`);
  }
  ui.unmount();
  await done;
}, 40000);
