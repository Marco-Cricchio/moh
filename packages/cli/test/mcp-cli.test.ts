import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpCommand } from "../src/mcp";

function fakeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "moh-mcp-cli-"));
  mkdirSync(join(dir, ".moh"));
  return dir;
}

async function run(argv: string[], cwd: string, home: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await mcpCommand({
    argv,
    cwd,
    home,
    stdout: { write: (s: string) => out.push(s) } as unknown as NodeJS.WritableStream,
    stderr: { write: (s: string) => err.push(s) } as unknown as NodeJS.WritableStream,
  });
  return { code, out: out.join(""), err: err.join(""), home };
}

describe("moh mcp", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "moh-mcp-cli-cwd-"));
    dirs.push(d);
    return d;
  };
  test("add/list/remove roundtrip in moh.json (project scope)", async () => {
    const cwd = tmp();
    const home = fakeHome();
        let r = await run(["add", "search", "--", "bun", "server.ts", "--flag"], cwd, home);
    expect(r.code).toBe(0);
    const config = JSON.parse(readFileSync(join(cwd, "moh.json"), "utf8"));
    expect(config.mcpServers.search).toEqual({ type: "stdio", command: "bun", args: ["server.ts", "--flag"] });

    r = await run(["add", "weather", "--url", "https://example.test/mcp", "--header", "Authorization: Bearer x"], cwd, home);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(cwd, "moh.json"), "utf8")).mcpServers.weather).toEqual({
      type: "http",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer x" },
    });

    r = await run(["list"], cwd, home);
    expect(r.out).toContain("search");
    expect(r.out).toContain("[project, stdio, asks on first use]");
    expect(r.out).toContain("[project, http, asks on first use]");

    r = await run(["remove", "search"], cwd, home);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(cwd, "moh.json"), "utf8")).mcpServers.search).toBeUndefined();
  });

  test("add --user writes to ~/.moh/config without clobbering other keys", async () => {
    const cwd = tmp();
    const home = fakeHome();
    writeFileSync(join(home, ".moh", "config"), JSON.stringify({ theme: "nord", mcpServers: { old: { type: "http", url: "https://x.test" } } }));
    const r = await run(["add", "docs", "--user", "--", "bun", "docs-server.ts"], cwd, home);
    expect(r.code).toBe(0);
    const user = JSON.parse(readFileSync(join(home, ".moh", "config"), "utf8"));
    expect(user.theme).toBe("nord");
    expect(user.mcpServers.docs.type).toBe("stdio");
    expect(user.mcpServers.old.type).toBe("http");
    // list marks user servers as trusted
    const listing = await run(["list"], cwd, home);
    expect(listing.out).toContain("[user, stdio, trusted]");
  });

  test("restart reports tool count for a working server, fails for unknown names", async () => {
    const cwd = tmp();
    const home = fakeHome();
    const server = join(import.meta.dir, "../../core/test/fixtures/mcp-stdio-server.ts");
    writeFileSync(
      join(cwd, "moh.json"),
      JSON.stringify({ mcpServers: { srv: { type: "stdio", command: process.execPath, args: [server, "ok"] } } }),
    );
    const ok = await run(["restart", "srv"], cwd, home);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("1 tool(s)");
    const missing = await run(["restart", "nope"], cwd, home);
    expect(missing.code).toBe(1);
  });
});
