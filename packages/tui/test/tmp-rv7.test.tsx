import { test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Chat } from "./../src/Chat";
import { createSession, type Provider } from "@moh/core";
import { stripAnsi } from "./helpers";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
test("probe: reveal cursor across static+frame", async () => {
  const provider = {
    name: "rv7",
    stream: async function* () {
      yield { type: "model_call_start", model: "m" } as any;
      yield { type: "text_delta", text: ("the core owns the agent loop while clients display. ").repeat(120) } as any;
      await sleep(15000);
      yield { type: "finish", reason: "stop" } as any;
    },
  } as unknown as Provider;
  const session = createSession({ provider, memory: { enabled: false } });
  const done = session.send("probe");
  const ui = render(<Chat session={session} cwd={process.cwd()} mode="vibe" modelLabel="m" width={100} />);
  let lastText = "";
  for (let i = 0; i < 14; i++) {
    await sleep(700);
    const f = stripAnsi(ui.lastFrame() ?? "");
    // last occurrence of the phrase = reveal cursor position
    const idx = f.lastIndexOf("the core owns");
    console.log(`t=${((i+1)*0.7).toFixed(1)}s cursorNear="${idx>=0?f.slice(idx, idx+90).replace(/\n/g,'⏎'): "(none)"}"`);
    lastText = f;
  }
  ui.unmount();
  await done;
}, 40000);
