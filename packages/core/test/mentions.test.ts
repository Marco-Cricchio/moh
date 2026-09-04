import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleMentions,
  expandMentions,
  mimeForPath,
  parseMentions,
  renderMentionAttachment,
  MENTION_TEXT_CAP,
} from "../src/mentions";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "moh-mentions-"));
}

describe("parseMentions", () => {
  test("parses @path at token start, not mid-text", () => {
    const m = parseMentions("look at @src/x.ts please");
    expect(m).toEqual([{ token: "@src/x.ts", rawPath: "src/x.ts" }]);
    expect(parseMentions("email me at bob@example.com")).toEqual([]);
    expect(parseMentions("compact@thing")).toEqual([]);
  });

  test("parses multiple mentions and quoted paths with spaces", () => {
    expect(parseMentions("@a.ts and @b/c.md")).toEqual([
      { token: "@a.ts", rawPath: "a.ts" },
      { token: "@b/c.md", rawPath: "b/c.md" },
    ]);
    expect(parseMentions('see @"my file.txt" now')).toEqual([
      { token: '@"my file.txt"', rawPath: "my file.txt" },
    ]);
  });

  test("trailing punctuation does not join the path", () => {
    expect(parseMentions("check @src/x.ts.")[0]!.rawPath).toBe("src/x.ts");
  });
});

describe("expandMentions", () => {
  test("resolves against cwd, annotates existence and kind, collapses duplicates", () => {
    const dir = tmpProject();
    try {
      writeFileSync(join(dir, "a.ts"), "hello");
      mkdirSync(join(dir, "sub"));
      const { text, mentions } = expandMentions("read @a.ts and @sub and @a.ts", dir);
      expect(text).toBe("read @a.ts and @sub and @a.ts"); // mentions stay in the text
      expect(mentions).toHaveLength(2); // duplicate collapsed
      expect(mentions[0]).toMatchObject({ displayPath: "a.ts", exists: true, isDirectory: false });
      expect(mentions[1]).toMatchObject({ displayPath: "sub", exists: true, isDirectory: true });
      const missing = expandMentions("@nope.ts", dir).mentions[0]!;
      expect(missing.exists).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("assembleMentions", () => {
  test("file: content snapshot at send time; text stays untouched", async () => {
    const dir = tmpProject();
    try {
      writeFileSync(join(dir, "a.ts"), "const x = 1;\n");
      const r = await assembleMentions("explain @a.ts", { cwd: dir });
      expect(r.text).toBe("explain @a.ts");
      expect(r.warnings).toEqual([]);
      expect(r.attachments).toEqual([{ kind: "file", path: "a.ts", mime: "text/plain", content: "const x = 1;\n", truncated: false }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("oversized text file is truncated with a declared marker", async () => {
    const dir = tmpProject();
    try {
      writeFileSync(join(dir, "big.txt"), "x".repeat(MENTION_TEXT_CAP + 10));
      const r = await assembleMentions("@big.txt", { cwd: dir });
      expect(r.attachments[0]!.truncated).toBe(true);
      expect(r.attachments[0]!.kind === "file" && r.attachments[0]!.content.endsWith("[truncated: file exceeds the 204800-byte attachment cap]")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("binary file attaches base64 with detected mime", async () => {
    const dir = tmpProject();
    try {
      writeFileSync(join(dir, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
      const r = await assembleMentions("@img.png", { cwd: dir });
      expect(r.attachments[0]).toMatchObject({ kind: "file", mime: "image/png", truncated: false });
      expect(r.attachments[0]!.kind === "file" && Buffer.from(r.attachments[0]!.content, "base64").toString()).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]).toString());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("directory: recursive listing of paths only, no contents", async () => {
    const dir = tmpProject();
    try {
      mkdirSync(join(dir, "pkg", "inner"), { recursive: true });
      writeFileSync(join(dir, "pkg", "b.ts"), "secret");
      writeFileSync(join(dir, "pkg", "inner", "c.md"), "secret");
      const r = await assembleMentions("@pkg", { cwd: dir });
      expect(r.attachments[0]).toEqual({
        kind: "directory",
        path: "pkg",
        listing: ["b.ts", "inner/", "inner/c.md"],
        truncated: false,
      });
      const rendered = renderMentionAttachment(r.attachments[0]!);
      expect(rendered).toContain('kind="directory"');
      expect(rendered).not.toContain("secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("directory listing is public metadata: attached even when the dir itself is denied", async () => {
    const dir = tmpProject();
    try {
      mkdirSync(join(dir, "pkg"));
      writeFileSync(join(dir, "pkg", "b.ts"), "secret");
      const r = await assembleMentions("@pkg", {
        cwd: dir,
        canRead: (p) => !p.endsWith("pkg"),
      });
      expect(r.warnings).toEqual([]);
      expect(r.attachments[0]).toMatchObject({ kind: "directory", path: "pkg" });
      // the listing itself stays content-free
      expect(JSON.stringify(r.attachments)).not.toContain("secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("denied file: warning, no attachment; missing file warns too", async () => {
    const dir = tmpProject();
    try {
      writeFileSync(join(dir, "open.ts"), "ok");
      writeFileSync(join(dir, "secret.env"), "nope");
      const r = await assembleMentions("@open.ts @secret.env @missing.ts", {
        cwd: dir,
        canRead: (p) => !p.endsWith("secret.env"),
      });
      expect(r.attachments).toHaveLength(1);
      expect(r.warnings).toEqual([
        { path: "secret.env", reason: "denied by permission rule" },
        { path: "missing.ts", reason: "not found" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mimeForPath maps known extensions and defaults to octet-stream", () => {
    expect(mimeForPath("a.pdf")).toBe("application/pdf");
    expect(mimeForPath("a.PNG")).toBe("image/png");
    expect(mimeForPath("a.weird")).toBe("application/octet-stream");
  });
});
