import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools } from "../src/builtin-tools";
import { createSession, MockProvider } from "../src/index";
import type { AskUserQuestionSet, AskUserSetResult } from "../src/index";
import type { ToolContext } from "../src/types";

const cwd = mkdtempSync(join(tmpdir(), "moh-askuser-"));
const tools = builtinTools();

function ctxWith(
  askUser?: (set: AskUserQuestionSet) => Promise<AskUserSetResult> | AskUserSetResult,
): ToolContext {
  return { signal: new AbortController().signal, cwd, onProgress: () => {}, ...(askUser ? { askUser } : {}) };
}

const single = {
  questions: [
    {
      question: "Which database should we target?",
      header: "Database",
      options: [
        { label: "Postgres", description: "Mature relational default" },
        { label: "SQLite", description: "Zero-config, file-based" },
      ],
      suggested: "SQLite",
    },
  ],
};

const batch = {
  questions: [
    ...single.questions,
    {
      question: "Where do we deploy?",
      header: "Deploy",
      options: [
        { label: "Fly", description: "edge regions" },
        { label: "Hetzner", description: "cheap EU boxes" },
      ],
      multiSelect: true,
      suggested: "Fly",
    },
  ],
};

describe("ask_user tool (question set, ADR-0019 / #411)", () => {
  test("schema rejects out-of-range option counts and empty batches", () => {
    const oneOption = {
      questions: [{ ...single.questions[0]!, options: [single.questions[0]!.options[0]!] }],
    };
    expect(() => tools.ask_user.inputSchema!.parse(oneOption)).toThrow();
    const fiveOptions = {
      questions: [
        { ...single.questions[0]!, options: [1, 2, 3, 4, 5].map((i) => ({ label: `o${i}`, description: "" })) },
      ],
    };
    expect(() => tools.ask_user.inputSchema!.parse(fiveOptions)).toThrow();
    expect(() => tools.ask_user.inputSchema!.parse({ questions: [] })).toThrow();
    expect(() =>
      tools.ask_user.inputSchema!.parse({ questions: [1, 2, 3, 4, 5].map(() => single.questions[0]) }),
    ).toThrow();
  });

  test("schema rejects duplicate question texts, duplicate labels, bad headers, bad suggested", async () => {
    const dupQuestion = { questions: [single.questions[0]!, { ...single.questions[0]!, header: "Other" }] };
    expect(() => tools.ask_user.inputSchema!.parse(dupQuestion)).toThrow(/duplicate question text/);

    const dupLabel = {
      questions: [
        {
          ...single.questions[0]!,
          options: [
            { label: "a", description: "" },
            { label: "a", description: "" },
          ],
        },
      ],
    };
    expect(() => tools.ask_user.inputSchema!.parse(dupLabel)).toThrow(/unique/);

    // A header that cannot survive trimming (empty after trim) still
    // yields a valid call object at the schema — execute trims the
    // whitespace-only header down harmlessly; nothing structural fails.
    const longHeader = { questions: [{ ...single.questions[0]!, header: " ".repeat(13) }] };
    expect(tools.ask_user.inputSchema!.parse(longHeader)).toBeTruthy();
    const noHeader = { questions: [{ ...single.questions[0]!, header: "" }] };
    expect(() => tools.ask_user.inputSchema!.parse(noHeader)).toThrow();

    // #731: purely-visual mistakes are normalized at execution, not
    // rejected — a long header trims to the 12-char budget and a fuzzy
    // suggested snaps to its unique case-insensitive match (or is dropped
    // when ambiguous). Schema-level rejection is reserved for structural
    // problems (counts, duplicates), so the header/suggested assertions
    // below go through execute's normalization via the parsed-then-tool
    // path instead.
    const trimmableHeader = tools.ask_user.inputSchema!.parse({
      questions: [{ ...single.questions[0]!, header: "Database pick" }],
    });
    // execute's normalization trims the header before the UI ever sees it.
    const headerCtx = ctxWith(async (set) => {
      expect(set.questions[0]!.header).toBe("Database pic");
      return { answers: [{ labels: ["Postgres"] }] };
    });
    await tools.ask_user.execute({ questions: [trimmableHeader.questions[0]!] } as never, headerCtx);
    const fuzzySuggested = tools.ask_user.inputSchema!.parse({
      questions: [{ ...single.questions[0]!, suggested: "sqlite" }],
    });
    const snapCtx = ctxWith(async (set) => {
      expect(set.questions[0]!.suggested).toBe("SQLite");
      return { answers: [{ labels: ["Postgres"] }] };
    });
    await tools.ask_user.execute({ questions: [fuzzySuggested.questions[0]!] } as never, snapCtx);
    const ambiguousSuggested = tools.ask_user.inputSchema!.parse({
      questions: [{ ...single.questions[0]!, suggested: "Mongo" }],
    });
    const dropCtx = ctxWith(async (set) => {
      expect(set.questions[0]!.suggested).toBeUndefined();
      return { answers: [{ labels: ["Postgres"] }] };
    });
    await tools.ask_user.execute({ questions: [ambiguousSuggested.questions[0]!] } as never, dropCtx);
    expect(tools.ask_user.inputSchema!.parse(single)).toBeTruthy();
    expect(tools.ask_user.inputSchema!.parse(batch)).toBeTruthy();
  });

  test("single question: returns the chosen label", async () => {
    const ctx = ctxWith(async (set) => {
      expect(set.questions).toHaveLength(1);
      expect(set.questions[0]!.suggested).toBe("SQLite");
      return { answers: [{ labels: ["Postgres"] }] };
    });
    expect(await tools.ask_user.execute(single, ctx)).toBe("Which database should we target?: Postgres");
  });

  test("batch: returns one line per question, in order; multiSelect joins labels", async () => {
    const ctx = ctxWith(() => ({
      answers: [{ labels: ["SQLite"] }, { labels: ["Fly", "Hetzner"], other: "plus a staging env" }],
    }));
    const out = await tools.ask_user.execute(batch, ctx);
    expect(out.split("\n")).toEqual([
      "Which database should we target?: SQLite",
      "Where do we deploy?: Fly, Hetzner + Other: plus a staging env",
    ]);
  });

  test("chosen option's preview is echoed back to the model (#414)", async () => {
    const withPreview = {
      questions: [
        {
          question: "Which style?",
          header: "Style",
          options: [
            { label: "concise", description: "terse", preview: "**Concise**: short answers, no filler." },
            { label: "verbose", description: "loquacious", preview: "# Verbose\n\nLong, structured essays with\ntwo\nthree\nfour\nfive lines." },
          ],
          suggested: "concise",
        },
      ],
    } as const;
    const ctx = ctxWith(() => ({ answers: [{ labels: ["verbose"] }] }));
    const out = await tools.ask_user.execute(withPreview, ctx);
    expect(out).toBe(
      "Which style?: verbose\n# Verbose\n\nLong, structured essays with\ntwo\nthree\nfour\nfive lines.",
    );
    // multiSelect: each chosen option's preview, separated by ---.
    const ctxMulti = ctxWith(() => ({ answers: [{ labels: ["concise", "verbose"] }] }));
    const multi = await tools.ask_user.execute(
      { ...withPreview, questions: [{ ...withPreview.questions[0], multiSelect: true }] },
      ctxMulti,
    );
    expect(multi).toBe(
      "Which style?: concise, verbose\n**Concise**: short answers, no filler.\n---\n# Verbose\n\nLong, structured essays with\ntwo\nthree\nfour\nfive lines.",
    );
    // No previews offered → the classic single line, unchanged.
    const plain = await tools.ask_user.execute(single, ctxWith(() => ({ answers: [{ labels: ["Postgres"] }] })));
    expect(plain).toBe("Which database should we target?: Postgres");
  });

  test("free-text 'Other' only answer", async () => {
    const ctx = ctxWith(() => ({ answers: [{ other: "whatever the team prefers" }] }));
    const out = await tools.ask_user.execute(single, ctx);
    expect(out).toBe("Which database should we target?: Other: whatever the team prefers");
  });

  test("cancelled set returns 'cancelled'", async () => {
    const ctx = ctxWith(() => ({ answers: [], cancelled: true }));
    expect(await tools.ask_user.execute(single, ctx)).toBe("cancelled");
  });

  test("rejects answers that pick a label that was not offered", async () => {
    const ctx = ctxWith(() => ({ answers: [{ labels: ["Mongo"] }] }));
    await expect(tools.ask_user.execute(single, ctx)).rejects.toThrow(/not offered/);
  });

  test("rejects multiple labels on a single-select question and wrong answer count", async () => {
    await expect(tools.ask_user.execute(single, ctxWith(() => ({ answers: [{ labels: ["Postgres", "SQLite"] }] })))).rejects.toThrow(
      /single-select/,
    );
    const short = ctxWith(() => ({ answers: [{ labels: ["SQLite"] }] }));
    await expect(tools.ask_user.execute(batch, short)).rejects.toThrow(/expected 2 answers, got 1/);
  });

  test("rejects an empty answer and choice+Other in single-select", async () => {
    await expect(tools.ask_user.execute(single, ctxWith(() => ({ answers: [{}] })))).rejects.toThrow(/empty/);
    await expect(
      tools.ask_user.execute(single, ctxWith(() => ({ answers: [{ labels: ["SQLite"], other: "actually…" }] }))),
    ).rejects.toThrow(/single-select/);
  });

  test("fails fast without an interactive askUser channel (headless)", async () => {
    await expect(tools.ask_user.execute(single, ctxWith())).rejects.toThrow(
      /no interactive user is attached.*without asking/i,
    );
  });

  test("session plumbing: onAskUser answers flow back as a paired tool_result in the event log", async () => {
    const provider = MockProvider.scripted([
      {
        deltas: [],
        finish: "tool_calls",
        toolCalls: [
          {
            name: "ask_user",
            args: {
              questions: [
                {
                  question: "Pick one",
                  header: "Choice",
                  options: [
                    { label: "a", description: "first" },
                    { label: "b", description: "second" },
                  ],
                  suggested: "a",
                },
              ],
            },
          },
        ],
      },
      { deltas: ["thanks, going with the answer"], finish: "stop" },
    ]);
    const session = createSession({
      provider,
      tools: builtinTools(),
      cwd,
      permissions: { unrestrictedTools: true },
      onAskUser: async () => ({ answers: [{ labels: ["b"] }] }),
    });
    const result = await session.send("decide");
    expect(result.status).toBe("done");
    const log = session.history();
    const call = log.find((e) => e.type === "tool_call")!;
    const res = log.find((e) => e.type === "tool_result")!;
    if (call.type !== "tool_call" || res.type !== "tool_result") throw new Error("missing events");
    expect(res.callId).toBe(call.callId);
    expect(res.ok).toBe(true);
    expect(res.output).toBe("Pick one: b");
  });
});
