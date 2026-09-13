import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../src/serve";

/**
 * e2e for `moh serve` (#525): spawns the real CLI with piped stdio and
 * scripts protocol conversations against the mock provider — PTY-free,
 * no API keys, no network.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try {
      readdirSync(d, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  }
});

interface Client {
  readonly stdout: ReadableStream<string>;
  writeLine(line: string): void;
  closeStdin(): void;
  readonly exited: Promise<number>;
}

function makeClient(proc: ReturnType<typeof Bun.spawn>): Client {
  const stdout = new Response(proc.stdout as ReadableStream).body!.pipeThrough(
    new TextDecoderStream(),
  );
  const stdin = proc.stdin as unknown as {
    write(s: string): number;
    flush(): void;
    end(): void;
  };
  return {
    stdout,
    writeLine(line: string) {
      stdin.write(line + "\n");
      stdin.flush();
    },
    closeStdin() {
      stdin.end();
    },
    exited: proc.exited.then((code: number) => code),
  };
}

function harness(): { cwd: string; home: string; spawnServe: (argv?: string[]) => Client } {
  const dir = `/tmp/moh-serve-e2e-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  dirs.push(dir);
  const cwd = join(dir, "project");
  const home = join(dir, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  const spawnServe = (argv: string[] = []): Client => {
    const proc = Bun.spawn(
      ["bun", join(import.meta.dir, "..", "src", "cli.ts"), "serve", ...argv],
      {
        cwd,
        env: { ...process.env, HOME: home, MOH_ENDPOINT_TEST_API_KEY: "" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return makeClient(proc);
  };
  return { cwd, home, spawnServe };
}

/** Collects stdout lines into a queue that readLine can await one at a time. */
function reader(stream: ReadableStream<string>) {
  const queue: string[] = [];
  let notify: (() => void) | undefined;
  let done = false;
  (async () => {
    // Split strictly on LF: the protocol's framing rule.
    let buffer = "";
    for await (const chunk of stream) {
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
    readLine(timeoutMs = 15000): Promise<string> {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      if (done) return Promise.resolve("");
      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          notify = undefined;
          resolve("");
        }, timeoutMs);
        notify = () => {
          clearTimeout(timer);
          resolve(queue.shift()!);
        };
      });
    },
  };
}

async function readMessage(r: ReturnType<typeof reader>): Promise<any> {
  const line = await r.readLine();
  expect(line).not.toBe("");
  return JSON.parse(line);
}

async function readUntil(r: ReturnType<typeof reader>, pred: (m: any) => boolean): Promise<any> {
  for (;;) {
    const m = await readMessage(r);
    if (pred(m)) return m;
  }
}

function initializeMsg(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "initialize", protocolVersion: PROTOCOL_VERSION, provider: "mock", ...extra });
}

describe("moh serve (#525)", () => {
  test("initialize → ready → send → streamed events → result", async () => {
    const { cwd, home, spawnServe } = harness();
    const client = spawnServe();
    const r = reader(client.stdout);
    client.writeLine(initializeMsg());
    const ready = await readUntil(r, (m) => m.type !== "event");
    expect(ready.type).toBe("ready");
    expect(ready.protocolVersion).toBe(PROTOCOL_VERSION);
    // A session file is created and reported.
    expect(typeof ready.sessionFile).toBe("string");
    expect(existsSync(String(ready.sessionFile))).toBe(true);

    client.writeLine(JSON.stringify({ type: "send", id: 1, text: "say hi" }));
    const events: any[] = [];
    const result = await (async () => {
      for (;;) {
        const m = await readMessage(r);
        if (m.type === "event") events.push(m.event);
        else return m;
      }
    })();
    expect(result.type).toBe("result");
    expect(result.id).toBe(1);
    expect(result.status).toBe("done");
    expect(result.exitCode).toBe(0);
    const types = events.map((e) => e.type);
    expect(types).toContain("user_message");
    expect(types).toContain("user_message");
    expect(types).toContain("assistant_delta");
    expect(types).toContain("done");
    client.closeStdin();
    expect(await client.exited).toBe(0);
    void cwd;
  });

  test("messages before initialize are rejected; ping works; session continuity via --session", async () => {
    const { spawnServe } = harness();
    const client = spawnServe();
    const r = reader(client.stdout);
    client.writeLine(JSON.stringify({ type: "send", id: 0, text: "early" }));
    const e1 = await readMessage(r);
    expect(e1.type).toBe("error");
    expect(e1.code).toBe("not_initialized");

    client.writeLine(initializeMsg());
    const ready = await readUntil(r, (m) => m.type !== "event");
    expect(ready.type).toBe("ready");
    const sessionFile = String(ready.sessionFile);

    client.writeLine(JSON.stringify({ type: "ping", id: 42 }));
    const pong = await readMessage(r);
    expect(pong.type).toBe("pong");
    expect(pong.id).toBe(42);

    // Resume the same file into a second serve process.
    client.closeStdin();
    expect(await client.exited).toBe(0);
    const client2 = spawnServe(["--session", sessionFile]);
    const r2 = reader(client2.stdout);
    client2.writeLine(initializeMsg());
    const ready2 = await readUntil(r2, (m) => m.type !== "event");
    expect(ready2.type).toBe("ready");
    expect(String(ready2.sessionFile).endsWith("/" + sessionFile.split("/").pop())).toBe(true);
    client2.closeStdin();
    expect(await client2.exited).toBe(0);
  });

  test("send while busy is a typed busy error; interrupt cancels with 130", async () => {
    // A long-turn cassette: the provider streams slowly, so the turn stays
    // in flight while the client sends again / interrupts.
    const dir = `/tmp/moh-serve-e2e-slow-${process.pid}-${Date.now()}`;
    dirs.push(dir);
    const cwd = join(dir, "project");
    const home = join(dir, "home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });
    const cassette = join(dir, "slow.json");
    await Bun.write(
      cassette,
      JSON.stringify([
        {
          deltas: ["tick ", "tick ", "tick "],
          finish: "stop",
          deltaDelayMs: 400,
        },
      ]),
    );
    const client = spawnServeWith(cwd, home, ["--cassette", cassette]);
    const r = reader(client.stdout);
    client.writeLine(initializeMsg());
    await readUntil(r, (m) => m.type !== "event");

    client.writeLine(JSON.stringify({ type: "send", id: 7, text: "long turn" }));
    // Wait until the turn is actually streaming.
    await readUntil(r, (m) => m.type === "event" && m.event?.type === "assistant_delta");
    // Busy send is rejected.
    client.writeLine(JSON.stringify({ type: "send", id: 8, text: "second" }));
    const busy = await readMessage(r);
    expect(busy.type).toBe("error");
    expect(busy.code).toBe("busy");
    expect(busy.id).toBe(8);
    // Interrupt the in-flight turn.
    client.writeLine(JSON.stringify({ type: "interrupt" }));
    const result = await readUntil(r, (m) => m.type === "result");
    expect(result.type).toBe("result");
    expect(result.status).toBe("cancelled");
    expect(result.exitCode).toBe(130);
    client.closeStdin();
    expect(await client.exited).toBe(0);
  });

  test("permission round-trip: ask surfaces a permission_request and allow proceeds", async () => {
    const dir = `/tmp/moh-serve-e2e-perm-${process.pid}-${Date.now()}`;
    dirs.push(dir);
    const cwd = join(dir, "project");
    const home = join(dir, "home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });
    const cassette = join(dir, "bash.json");
    await Bun.write(
      cassette,
      JSON.stringify([
        { deltas: ["trying "], finish: "tool_calls", toolCalls: [{ name: "bash", args: { command: "echo serve-ran" } }] },
        { deltas: ["bash worked"], finish: "stop" },
      ]),
    );
    const client = spawnServeWith(cwd, home, ["--cassette", cassette]);
    const r = reader(client.stdout);
    client.writeLine(initializeMsg());
    await readUntil(r, (m) => m.type !== "event");
    client.writeLine(JSON.stringify({ type: "send", id: 1, text: "run echo" }));
    const req = await readUntil(r, (m) => m.type === "permission_request");
    expect(req.type).toBe("permission_request");
    expect(typeof req.id).toBe("number");
    expect(req.tool).toBe("bash");
    client.writeLine(JSON.stringify({ type: "permission_response", id: req.id, decision: "yes" }));
    const result = await readUntil(r, (m) => m.type === "result");
    expect(result.status).toBe("done");
    expect(result.exitCode).toBe(0);
    client.closeStdin();
    expect(await client.exited).toBe(0);
  });

  test("denied permission yields a completed turn with structured denial; malformed lines get typed errors", async () => {
    const dir = `/tmp/moh-serve-e2e-deny-${process.pid}-${Date.now()}`;
    dirs.push(dir);
    const cwd = join(dir, "project");
    const home = join(dir, "home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });
    const cassette = join(dir, "bash2.json");
    await Bun.write(
      cassette,
      JSON.stringify([
        { deltas: ["trying "], finish: "tool_calls", toolCalls: [{ name: "bash", args: { command: "echo denied-please" } }] },
        { deltas: ["done"], finish: "stop" },
      ]),
    );
    const client = spawnServeWith(cwd, home, ["--cassette", cassette]);
    const r = reader(client.stdout);
    // Malformed line first: typed error, connection survives.
    client.writeLine("this is not json");
    const bad = await readMessage(r);
    expect(bad.type).toBe("error");
    expect(bad.code).toBe("bad_json");
    client.writeLine(initializeMsg());
    await readUntil(r, (m) => m.type !== "event");
    client.writeLine(JSON.stringify({ type: "send", id: 2, text: "run echo" }));
    const req = await readUntil(r, (m) => m.type === "permission_request");
    client.writeLine(JSON.stringify({ type: "permission_response", id: req.id, decision: "no" }));
    const result = await readUntil(r, (m) => m.type === "result");
    expect(result.type).toBe("result");
    expect(result.status).toBe("done");
    expect(result.exitCode).toBe(0);
    client.closeStdin();
    expect(await client.exited).toBe(0);
  });

  test("unknown and unsupported-version messages get typed errors", async () => {
    const { spawnServe } = harness();
    const client = spawnServe();
    const r = reader(client.stdout);
    // Unknown type before initialize: not_initialized wins (state machine).
    client.writeLine(JSON.stringify({ type: "frobnicate", id: 5 }));
    const early = await readMessage(r);
    expect(early.type).toBe("error");
    expect(early.code).toBe("not_initialized");
    client.writeLine(initializeMsg());
    await readUntil(r, (m) => m.type !== "event");
    client.writeLine(JSON.stringify({ type: "frobnicate", id: 6 }));
    const unknown = await readMessage(r);
    expect(unknown.type).toBe("error");
    expect(unknown.code).toBe("bad_message");
    // A second initialize is rejected as already_initialized.
    client.writeLine(JSON.stringify({ type: "initialize", protocolVersion: PROTOCOL_VERSION }));
    const again = await readMessage(r);
    expect(again.type).toBe("error");
    expect(again.code).toBe("already_initialized");
    client.closeStdin();
    expect(await client.exited).toBe(0);
  });
});

/** serve spawn bound to a specific cwd/home (per-test isolation). */
function spawnServeWith(cwd: string, home: string, argv: string[]): Client {
  const proc = Bun.spawn(
    ["bun", join(import.meta.dir, "..", "src", "cli.ts"), "serve", ...argv],
    {
      cwd,
      env: { ...process.env, HOME: home, MOH_ENDPOINT_TEST_API_KEY: "" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return makeClient(proc);
}
