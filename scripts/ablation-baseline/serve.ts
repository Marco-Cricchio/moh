// S0.2/B4 `moh serve` transcripts.
//
//   bun scripts/ablation-baseline/serve.ts <outDir>
//
// Scripted stdin conversations over the RPC v1 protocol (initialize good
// and bad version, early send, ping, happy-path send, busy + interrupt,
// permission round-trip, session resume), recording the normalized
// stdout lines of each conversation under <outDir>/serve/.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Normalizer } from "./normalize";

const REPO = join(import.meta.dir, "..", "..");
const CLI = join(REPO, "packages/cli/src/cli.ts");

interface Client {
  writeLine(line: string): void;
  closeStdin(): void;
  readLine(timeoutMs?: number): Promise<string>;
  exited: Promise<number>;
}

function spawnServe(cwd: string, home: string, argv: string[]): Client {
  const proc = Bun.spawn([process.execPath, CLI, "serve", ...argv], {
    cwd,
    env: { ...process.env, HOME: home, TZ: "UTC", MOH_ENDPOINT_TEST_API_KEY: "" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout as ReadableStream).body!.pipeThrough(new TextDecoderStream());
  const stdin = proc.stdin as unknown as { write(s: string): number; flush(): void; end(): void };
  const queue: string[] = [];
  let notify: (() => void) | undefined;
  let done = false;
  void (async () => {
    let buffer = "";
    for await (const chunk of stdout) {
      buffer += chunk;
      for (;;) {
        const i = buffer.indexOf("\n");
        if (i < 0) break;
        queue.push(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        notify?.();
        notify = undefined;
      }
    }
    done = true;
    notify?.();
    notify = undefined;
  })();
  return {
    writeLine(line: string): void {
      stdin.write(line + "\n");
      stdin.flush();
    },
    closeStdin(): void {
      stdin.end();
    },
    readLine(timeoutMs = 20_000): Promise<string> {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      if (done) return Promise.resolve("");
      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          notify = undefined;
          resolve("");
        }, timeoutMs);
        notify = () => {
          clearTimeout(timer);
          resolve(queue.shift() ?? "");
        };
      });
    },
    exited: proc.exited.then((code: number) => code),
  };
}

async function readUntil(c: Client, pred: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  for (;;) {
    const line = await c.readLine();
    if (line === "") throw new Error("serve stdout closed before predicate matched");
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (pred(msg)) return msg;
  }
}

function fixture(base: string): { home: string; cwd: string } {
  const home = join(base, "home");
  const cwd = join(base, "project");
  mkdirSync(join(home, ".moh"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(cwd, "moh.json"),
    JSON.stringify({ provider: "mock", handoff: { transport: "none" } }, null, 2) + "\n",
  );
  return { home, cwd };
}

const INIT = JSON.stringify({ type: "initialize", protocolVersion: 1, provider: "mock" });

interface Conv {
  name: string;
  run: (ctx: { home: string; cwd: string; base: string }) => Promise<string[]>;
}

const CONVERSATIONS: Conv[] = [
  {
    name: "happy-path",
    run: async ({ home, cwd }) => {
      const lines: string[] = [];
      const c = spawnServe(cwd, home, []);
      c.writeLine(INIT);
      lines.push(...(await collectUntil(c, (m) => m.type === "ready")));
      c.writeLine(JSON.stringify({ type: "send", id: 1, text: "say hi" }));
      lines.push(...(await collectUntil(c, (m) => m.type === "result")));
      c.writeLine(JSON.stringify({ type: "ping", id: 42 }));
      lines.push(...(await collectUntil(c, (m) => m.type === "pong")));
      c.closeStdin();
      lines.push(`<exit:${await c.exited}>`);
      return lines;
    },
  },
  {
    name: "bad-protocol-version",
    run: async ({ home, cwd }) => {
      const lines: string[] = [];
      const c = spawnServe(cwd, home, []);
      c.writeLine(JSON.stringify({ type: "initialize", protocolVersion: 99 }));
      lines.push(...(await collectUntil(c, (m) => m.type === "error")));
      c.closeStdin();
      lines.push(`<exit:${await c.exited}>`);
      return lines;
    },
  },
  {
    name: "early-send-and-bad-message",
    run: async ({ home, cwd }) => {
      const lines: string[] = [];
      const c = spawnServe(cwd, home, []);
      c.writeLine(JSON.stringify({ type: "send", id: 0, text: "early" }));
      lines.push(...(await collectUntil(c, (m) => m.type === "error")));
      c.writeLine(JSON.stringify({ type: "frobnicate" }));
      c.writeLine(INIT);
      lines.push(...(await collectUntil(c, (m) => m.type === "ready")));
      c.closeStdin();
      lines.push(`<exit:${await c.exited}>`);
      return lines;
    },
  },
  {
    name: "busy-interrupt",
    run: async ({ home, cwd, base }) => {
      const lines: string[] = [];
      const cassette = join(base, "slow.json");
      writeFileSync(
        cassette,
        JSON.stringify([{ deltas: ["tick ", "tick ", "tick "], finish: "stop", deltaDelayMs: 400 }]),
      );
      const c = spawnServe(cwd, home, ["--cassette", cassette]);
      c.writeLine(INIT);
      lines.push(...(await collectUntil(c, (m) => m.type === "ready")));
      c.writeLine(JSON.stringify({ type: "send", id: 7, text: "long turn" }));
      await readUntil(c, (m) => m.type === "event" && (m.event as { type?: string })?.type === "assistant_delta");
      c.writeLine(JSON.stringify({ type: "send", id: 8, text: "second" }));
      await readUntil(c, (m) => m.type === "error" && m.code === "busy");
      c.writeLine(JSON.stringify({ type: "interrupt" }));
      for (;;) {
        const line = await c.readLine(10_000);
        if (line === "") break;
        lines.push(line);
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.type === "result") break;
      }
      c.closeStdin();
      for (;;) {
        const line = await c.readLine(5_000);
        if (line === "") break;
        lines.push(line);
      }
      lines.push(`<exit:${await c.exited}>`);
      return lines;
    },
  },
  {
    name: "permission-roundtrip",
    run: async ({ home, cwd, base }) => {
      const lines: string[] = [];
      const cassette = join(base, "bash.json");
      writeFileSync(
        cassette,
        JSON.stringify([
          { deltas: ["trying "], finish: "tool_calls", toolCalls: [{ name: "bash", args: { command: "echo serve-ran" } }] },
          { deltas: ["bash worked"], finish: "stop" },
        ]),
      );
      const c = spawnServe(cwd, home, ["--cassette", cassette]);
      c.writeLine(INIT);
      lines.push(...(await collectUntil(c, (m) => m.type === "ready")));
      c.writeLine(JSON.stringify({ type: "send", id: 3, text: "run it" }));
      const req = await readUntil(c, (m) => m.type === "permission_request");
      lines.push(JSON.stringify(req));
      c.writeLine(JSON.stringify({ type: "permission_response", id: req.id, decision: "yes" }));
      for (;;) {
        const line = await c.readLine(15_000);
        if (line === "") break;
        lines.push(line);
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.type === "result") break;
      }
      c.closeStdin();
      lines.push(`<exit:${await c.exited}>`);
      return lines;
    },
  },
  {
    name: "resume-session",
    run: async ({ home, cwd }) => {
      const lines: string[] = [];
      const first = spawnServe(cwd, home, []);
      first.writeLine(INIT);
      const ready = await readUntil(first, (m) => m.type === "ready");
      const sessionFile = String((ready as { sessionFile?: unknown }).sessionFile);
      first.writeLine(JSON.stringify({ type: "send", id: 1, text: "first turn in serve" }));
      await readUntil(first, (m) => m.type === "result");
      first.closeStdin();
      lines.push(`<first-exit:${await first.exited}>`);

      const second = spawnServe(cwd, home, ["--session", sessionFile]);
      second.writeLine(INIT);
      const events: string[] = [];
      for (;;) {
        const line = await second.readLine();
        if (line === "") break;
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.type === "event") {
          events.push(JSON.stringify(msg.event));
          continue;
        }
        lines.push(line);
        if (msg.type === "ready") break;
      }
      // The resumed replay includes a session_resumed chrome event.
      lines.push(`<replayed:${events.length}>`);
      second.closeStdin();
      lines.push(`<exit:${await second.exited}>`);
      return lines;
    },
  },
];

/** Collects lines (including the matching one) until pred matches. */
async function collectUntil(c: Client, pred: (m: Record<string, unknown>) => boolean): Promise<string[]> {
  const lines: string[] = [];
  for (;;) {
    const line = await c.readLine();
    if (line === "") throw new Error("serve stdout closed before predicate matched");
    lines.push(line);
    if (pred(JSON.parse(line) as Record<string, unknown>)) return lines;
  }
}

async function main(): Promise<number> {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("usage: serve.ts <outDir>");
    process.exit(2);
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "serve"), { recursive: true });
  let failures = 0;
  for (const conv of CONVERSATIONS) {
    process.stderr.write(`[b4] ${conv.name} … `);
    try {
      const base = mkdtempSync(join(tmpdir(), "moh-b4-"));
      const { home, cwd } = fixture(base);
      const raw = await conv.run({ home, cwd, base });
      const norm = new Normalizer({ home, cwd });
      writeFileSync(
        join(outDir, "serve", `${conv.name}.txt`),
        raw.map((l) => norm.text(l)).join("\n") + "\n",
      );
      rmSync(base, { recursive: true, force: true });
      process.stderr.write(`ok (${raw.length} lines)\n`);
    } catch (e) {
      failures += 1;
      process.stderr.write(`FAILED: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  console.log(`serve: ${CONVERSATIONS.length} conversations, ${failures} failures`);
  return failures === 0 ? 0 : 1;
}

process.exitCode = await main();
