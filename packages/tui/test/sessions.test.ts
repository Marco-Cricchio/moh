import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, createSession, MockProvider } from "@moh/core";
import { listSessionSummaries } from "../src/sessions";

const tempHome = () => mkdtempSync(join(tmpdir(), "moh-tui-home-"));

describe("listSessionSummaries", () => {
  test("lists newest first with the first user message as title", async () => {
    const home = tempHome();
    const cwd = process.cwd();
    const a = SessionStore.create(cwd, home);
    const sessionA = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      sink: (e) => a.append(e),
    });
    await sessionA.send("fix the login page");
    await Bun.sleep(5);
    const b = SessionStore.create(cwd, home);

    const summaries = listSessionSummaries(cwd, home);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]!.file).toBe(b.file);
    expect(summaries[0]!.title).toBe("(empty session)");
    expect(summaries[1]!.title).toBe("fix the login page");
  });

  test("long titles are trimmed to 60 chars", async () => {
    const home = tempHome();
    const cwd = process.cwd();
    const store = SessionStore.create(cwd, home);
    const long = "x".repeat(100);
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    await session.send(long);
    const title = listSessionSummaries(cwd, home)[0]!.title;
    expect(title.length).toBe(58);
    expect(title.endsWith("…")).toBe(true);
  });

  test("a corrupt log degrades to a placeholder, never throws", () => {
    const home = tempHome();
    const cwd = process.cwd();
    const store = SessionStore.create(cwd, home);
    writeFileSync(store.file, "not json\n");
    const summaries = listSessionSummaries(cwd, home);
    expect(summaries[0]!.title).toBe("(empty session)");
  });
});
