/** Process-isolated filesystem boundary: drop every native notification. */
import { mock } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nativeWatch = fs.watch;
let watches = 0;
mock.module("node:fs", () => ({
  ...fs,
  watch: (file: string) => {
    watches += 1;
    return nativeWatch(file, () => { /* deliberately not delivered */ });
  },
}));
const { ExtensionRuntime } = await import("../../src/extensions");
const home = fs.mkdtempSync(join(tmpdir(), "moh-watch-probe-"));
const file = join(home, "ext.mjs");
const marker = join(home, "evaluated.txt");
const source = (version: string) => `
  import {writeFileSync} from "node:fs";
  writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(version)});
  export default {name:"hot",version:${JSON.stringify(version)},apiVersion:"1.0",
    setup(ctx){ctx.state.loads=(ctx.state.loads??0)+1;ctx.onToolCall(()=>({veto:true}));}};
`;
let approve!: (yes: boolean) => void;
const approval = new Promise<boolean>((resolve) => { approve = resolve; });
let asks = 0;
const warnings: string[] = [];
const rt = new ExtensionRuntime({
  mohHome: home,
  consent: () => ++asks === 1 ? true : asks === 2 ? approval : false,
  onWarning: (message) => warnings.push(message),
});
async function until(step: string, ready: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000;
  while (!ready() && performance.now() < deadline) await Bun.sleep(10);
  assert.ok(ready(), `watch reconciliation stuck at: ${step}; asks=${asks}; warnings=${JSON.stringify(warnings)}`);
}
try {
  fs.writeFileSync(join(home, "moh.extension.json"), JSON.stringify({
    name: "hot", version: "1.0.0", entry: ["ext.mjs"], capabilities: [],
  }));
  fs.writeFileSync(file, source("1.0.0"));
  assert.equal(await rt.registerFile(file), true);
  rt.startWatch();
  rt.startWatch(); // idempotent: no second watcher or reconciliation loop
  fs.writeFileSync(file, source("2.0.0"));
  await until("pre-import consent", () => asks === 2);
  assert.equal(fs.readFileSync(marker, "utf8"), "1.0.0");
  assert.equal(rt.instances[0]!.def.version, "1.0.0");
  // Negative interval: unchanged bytes cannot repeat a pending consent ask.
  await Bun.sleep(1100);
  assert.equal(asks, 2);
  approve(true);
  await until("approved replacement", () => rt.instances[0]?.def.version === "2.0.0");
  assert.equal(rt.instances[0]!.state.loads, 2);
  assert.equal(rt.instances[0]!.hooks.onToolCall.length, 1);
  assert.equal(fs.readFileSync(marker, "utf8"), "2.0.0");
  fs.writeFileSync(file, source("3.0.0"));
  await until("refused replacement", () => warnings.some((w) => w.includes("reload refused (consent)")));
  assert.equal(asks, 3);
  assert.equal(fs.readFileSync(marker, "utf8"), "2.0.0");
  rt.stopWatch();
  fs.writeFileSync(file, source("4.0.0"));
  // Negative interval spans two reconciliation ticks plus the debounce.
  await Bun.sleep(1100);
  assert.equal(asks, 3);
  console.log(JSON.stringify({ watches, asks, version: rt.instances[0]!.def.version, loads: rt.instances[0]!.state.loads }));
} finally {
  approve(false);
  rt.stopWatch();
  fs.rmSync(home, { recursive: true, force: true });
}
