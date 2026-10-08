import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createSession, MockProvider, SessionStore } from "../src/index";
import { legacyProjectSlug, listSessionSummaries, MIN_SUPPORTED_SCHEMA_VERSION, projectSlug, renameSession, setSessionPinned, replayMessages, deleteSession, restoreSession, listTrashedSessions, pruneTrash, resolveEventRef, isSessionOpen, projectTrashDir } from "../src/session-store";
import { acknowledgeStrandedData, canonicalRemoteSlug, deleteStrandedData, moveStrandedSessions, readStrandedDataRecord, strandedDataSummary } from "../src/project-identity";
import { runtimeRulesFromEvents } from "../src/permissions";
import type { AgentEvent } from "../src/index";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "moh-store-"));
}

const SORTABLE_ID = /^\d{8}T\d{6}\d{3}Z-[0-9a-f]{8}$/;

/** #1259: strips the integrity fields a written line carries. */
function withoutIntegrity<T extends AgentEvent>(e: T): T {
  const { prevHash: _p, hash: _h, ...rest } = e as T & { prevHash?: string; hash?: string };
  return rest as T;
}

describe("session store", () => {
  test("create() writes a new JSONL under <home>/.moh/projects/<slug>/ with a sortable id", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);

    expect(basename(store.file, ".jsonl")).toMatch(SORTABLE_ID);
    expect(store.file.startsWith(join(home, ".moh", "projects"))).toBe(true);
    // Never inside the project's .moh/
    expect(store.file.startsWith(cwd)).toBe(false);
    expect(statSync(store.file).size).toBe(0);
  });

  test("fresh moh-home session artifacts are owner-only without changing the injected home", () => {
    const home = tempHome();
    const homeMode = statSync(home).mode & 0o777;
    const store = SessionStore.create(mkdtempSync(join(tmpdir(), "moh-proj-")), home);
    for (const path of [join(home, ".moh"), join(home, ".moh", "projects"), join(home, ".moh", "projects", basename(join(store.file, "..")))]) {
      expect(statSync(path).mode & 0o777).toBe(0o700);
    }
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(homeMode);
  });

  test("does not retroactively chmod existing moh-home directories", () => {
    const home = tempHome();
    const mohHome = join(home, ".moh");
    mkdirSync(mohHome, { mode: 0o755 });
    SessionStore.create(mkdtempSync(join(tmpdir(), "moh-proj-")), home);
    expect(statSync(mohHome).mode & 0o777).toBe(0o755);
  });

  test("first open creates an opaque project identity and shared clones resolve to one slug", () => {
    const home = tempHome();
    const a = mkdtempSync(join(tmpdir(), "moh-same-"));
    const b = mkdtempSync(join(tmpdir(), "moh-same-"));
    const first = SessionStore.create(a, home);
    const identity = readFileSync(join(a, ".moh", "project.json"), "utf8");
    expect(JSON.parse(identity)).toEqual({ id: expect.any(String) });
    expect(identity).not.toContain(a);
    mkdirSync(join(b, ".moh"), { recursive: true });
    writeFileSync(join(b, ".moh", "project.json"), identity);
    const second = SessionStore.create(b, home);
    expect(join(first.file, "..")).toBe(join(second.file, ".."));
    expect(SessionStore.list(b, home).map((store) => store.file)).toContain(first.file);
  });

  test("projects without an identity retain their legacy slug when identity creation fails", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-legacy-"));
    mkdirSync(join(cwd, ".moh", "project.json"), { recursive: true });
    expect(projectSlug(cwd, home)).toBe(legacyProjectSlug(cwd));
  });

  test("declared identity atomically migrates an existing legacy directory once and records a note", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-migrate-"));
    const legacy = legacyProjectSlug(cwd);
    const legacyDir = join(home, ".moh", "projects", legacy);
    mkdirSync(join(legacyDir, "memory"), { recursive: true });
    writeFileSync(join(legacyDir, "old.jsonl"), "session");
    writeFileSync(join(legacyDir, "memory", "facts.md"), "fact");
    const slug = projectSlug(cwd, home);
    const target = join(home, ".moh", "projects", slug);
    expect(existsSync(legacyDir)).toBe(false);
    expect(readFileSync(join(target, "old.jsonl"), "utf8")).toBe("session");
    expect(readFileSync(join(target, "memory", "facts.md"), "utf8")).toBe("fact");
    expect(readFileSync(join(target, "migration.log"), "utf8")).toContain("Migrated legacy project directory");
    projectSlug(cwd, home);
    expect(readFileSync(join(target, "migration.log"), "utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("#591: an origin remote derives a canonical host/owner/repo slug shared by SSH, HTTPS and ssh-URL spellings", () => {
    const home = tempHome();
    const spellings = [
      "git@github.com:Owner/Repo.git",
      "https://github.com/Owner/Repo.git",
      "https://user:token@github.com/Owner/Repo",
      "ssh://git@github.com/Owner/Repo.git",
      "https://GitHub.com/owner/REPO.Git",
    ];
    const slugs = spellings.map((url) => {
      const cwd = mkdtempSync(join(tmpdir(), "moh-origin-"));
      execFileSync("git", ["init", "-q", cwd]);
      execFileSync("git", ["-C", cwd, "remote", "add", "origin", url]);
      const slug = projectSlug(cwd, home);
      expect(slug).toMatch(/^github\.com\/owner\/repo$/);
      expect(existsSync(join(cwd, ".moh", "project.json"))).toBe(false);
      return slug;
    });
    expect(new Set(slugs).size).toBe(1);
    expect(existsSync(join(home, ".moh", "projects", slugs[0]))).toBe(true);
  });

  test("#591: a project without origin keeps the UUID-derived identity slug", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-noorigin-"));
    execFileSync("git", ["init", "-q", cwd]);
    const slug = projectSlug(cwd, home);
    expect(slug).toMatch(/^project-[0-9a-f]{16}$/);
    expect(existsSync(join(cwd, ".moh", "project.json"))).toBe(true);
  });

  test("#591: nested-group remotes (GitLab subgroups) keep the full repo path in the slug", () => {
    const home = tempHome();
    const a = mkdtempSync(join(tmpdir(), "moh-origin-"));
    const b = mkdtempSync(join(tmpdir(), "moh-origin-"));
    for (const [dir, url] of [
      [a, "git@gitlab.com:group/sub/Repo.git"],
      [b, "https://gitlab.com/group/sub/repo.git"],
    ] as const) {
      execFileSync("git", ["init", "-q", dir]);
      execFileSync("git", ["-C", dir, "remote", "add", "origin", url]);
      expect(projectSlug(dir, home)).toBe("gitlab.com/group/sub/repo");
    }
    // Both clones share one nested directory under projects/.
    expect(existsSync(join(home, ".moh", "projects", "gitlab.com", "group", "sub", "repo"))).toBe(true);
  });

  test("#592: first resolution of a UUID project that gains origin migrates its data directory once", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-mig592-"));
    // Born without git: uuid identity + data.
    const uuidSlug = projectSlug(cwd, home);
    const uuidDir = join(home, ".moh", "projects", uuidSlug);
    mkdirSync(uuidDir, { recursive: true });
    writeFileSync(join(uuidDir, "old.jsonl"), "session");
    mkdirSync(join(uuidDir, "memory"), { recursive: true });
    writeFileSync(join(uuidDir, "memory", "facts.md"), "fact");
    // Later gains origin.
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "remote", "add", "origin", "git@github.com:Owner/Repo.git"]);
    const slug = projectSlug(cwd, home);
    expect(slug).toBe("github.com/owner/repo");
    const target = join(home, ".moh", "projects", slug);
    expect(existsSync(uuidDir)).toBe(false);
    expect(readFileSync(join(target, "old.jsonl"), "utf8")).toBe("session");
    expect(readFileSync(join(target, "memory", "facts.md"), "utf8")).toBe("fact");
    expect(readFileSync(join(target, "migration.log"), "utf8")).toContain(`Migrated project directory ${uuidSlug} to ${slug}`);
    // Exactly once.
    projectSlug(cwd, home);
    expect(readFileSync(join(target, "migration.log"), "utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("#592: the remote directory wins when it already exists; the uuid directory is left untouched", () => {
    const home = tempHome();
    const remote = join(home, ".moh", "projects", "github.com/owner/repo");
    mkdirSync(remote, { recursive: true });
    writeFileSync(join(remote, "remote.jsonl"), "remote-session");
    const cwd = mkdtempSync(join(tmpdir(), "moh-mig592b-"));
    const uuidSlug = projectSlug(cwd, home);
    const uuidDir = join(home, ".moh", "projects", uuidSlug);
    mkdirSync(uuidDir, { recursive: true });
    writeFileSync(join(uuidDir, "local.jsonl"), "local-session");
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
    expect(projectSlug(cwd, home)).toBe("github.com/owner/repo");
    expect(readFileSync(join(remote, "remote.jsonl"), "utf8")).toBe("remote-session");
    expect(readFileSync(join(home, ".moh", "projects", uuidSlug, "local.jsonl"), "utf8")).toBe("local-session");
    expect(existsSync(join(remote, "migration.log"))).toBe(false);
  });

  test("#592: a project without origin is never migrated", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-mig592c-"));
    const slug = projectSlug(cwd, home);
    mkdirSync(join(home, ".moh", "projects", slug), { recursive: true });
    writeFileSync(join(home, ".moh", "projects", slug, "s.jsonl"), "x");
    projectSlug(cwd, home);
    expect(existsSync(join(home, ".moh", "projects", slug, "migration.log"))).toBe(false);
  });

  test("#592: two openers racing the migration resolve to the same directory without corruption", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-mig592d-"));
    const uuidSlug = projectSlug(cwd, home);
    const uuidDir = join(home, ".moh", "projects", uuidSlug);
    mkdirSync(uuidDir, { recursive: true });
    writeFileSync(join(uuidDir, "old.jsonl"), "session");
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
    // Opener A performs the migration; opener B then re-resolves and must see
    // the migrated directory, not a second attempt or split data.
    const first = projectSlug(cwd, home);
    const second = projectSlug(cwd, home);
    expect(first).toBe("github.com/owner/repo");
    expect(second).toBe(first);
    expect(existsSync(uuidDir)).toBe(false);
    expect(readFileSync(join(home, ".moh", "projects", first, "old.jsonl"), "utf8")).toBe("session");
    expect(readFileSync(join(home, ".moh", "projects", first, "migration.log"), "utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("#1217: a materialized-but-empty remote directory does not block the migration", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-mig1217-"));
    // Born without git: uuid identity + data.
    const uuidSlug = projectSlug(cwd, home);
    const uuidDir = join(home, ".moh", "projects", uuidSlug);
    mkdirSync(uuidDir, { recursive: true });
    writeFileSync(join(uuidDir, "old.jsonl"), "session");
    mkdirSync(join(uuidDir, "memory"), { recursive: true });
    writeFileSync(join(uuidDir, "memory", "facts.md"), "fact");
    // Gains origin; a second moh process materializes the empty remote
    // directory before the next boot (the #1217 blocker).
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "remote", "add", "origin", "git@github.com:Owner/Repo.git"]);
    mkdirSync(join(home, ".moh", "projects", "github.com/owner/repo"), { recursive: true });
    const slug = projectSlug(cwd, home);
    expect(slug).toBe("github.com/owner/repo");
    const target = join(home, ".moh", "projects", slug);
    // The empty shell was not data: the uuid contents moved in once.
    expect(existsSync(uuidDir)).toBe(false);
    expect(readFileSync(join(target, "old.jsonl"), "utf8")).toBe("session");
    expect(readFileSync(join(target, "memory", "facts.md"), "utf8")).toBe("fact");
    expect(readFileSync(join(target, "migration.log"), "utf8")).toContain(`Migrated project directory ${uuidSlug} to ${slug}`);
    // Exactly once.
    projectSlug(cwd, home);
    expect(readFileSync(join(target, "migration.log"), "utf8").split("\n").filter((l) => l.startsWith("Migrated"))).toHaveLength(1);
  });

  test("#1217: a same-named survivor keeps the remote copy; the uuid copy is preserved and the note records it", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-mig1217b-"));
    const uuidSlug = projectSlug(cwd, home);
    const uuidDir = join(home, ".moh", "projects", uuidSlug);
    mkdirSync(uuidDir, { recursive: true });
    writeFileSync(join(uuidDir, "old.jsonl"), "uuid-copy");
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "remote", "add", "origin", "git@github.com:Owner/Repo.git"]);
    // Only a stale migration note: still an empty shell to the resolver.
    const remote = join(home, ".moh", "projects", "github.com/owner/repo");
    mkdirSync(remote, { recursive: true });
    writeFileSync(join(remote, "migration.log"), "stale note from an older attempt\n");
    expect(projectSlug(cwd, home)).toBe("github.com/owner/repo");
    // No collision in this shape — the shell still counts as empty — but the
    // note moved with the migration and the data landed beside it.
    expect(readFileSync(join(remote, "old.jsonl"), "utf8")).toBe("uuid-copy");
    expect(existsSync(uuidDir)).toBe(false);
  });

  test("#1217: both directories hold data — nothing moves, the stranded uuid data is recorded and readable", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-mig1217c-"));
    const uuidSlug = projectSlug(cwd, home);
    const uuidDir = join(home, ".moh", "projects", uuidSlug);
    mkdirSync(uuidDir, { recursive: true });
    writeFileSync(join(uuidDir, "uuid-session.jsonl").replace("uuid-session", `20260101T000000000Z-deadbeef`), "uuid-session");
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "remote", "add", "origin", "git@github.com:Owner/Repo.git"]);
    const remote = join(home, ".moh", "projects", "github.com/owner/repo");
    mkdirSync(remote, { recursive: true });
    writeFileSync(join(remote, "20260202T000000000Z-cafebab0.jsonl"), "remote-session");
    const slug = projectSlug(cwd, home);
    expect(slug).toBe("github.com/owner/repo");
    // Nothing merged or moved: each side keeps its own session.
    expect(existsSync(join(uuidDir, "20260101T000000000Z-deadbeef.jsonl"))).toBe(true);
    expect(existsSync(join(remote, "20260202T000000000Z-cafebab0.jsonl"))).toBe(true);
    // The stranded data is recorded durably and readable through the seam.
    const record = readStrandedDataRecord(join(home, ".moh", "projects", slug));
    expect(record?.source).toBe(uuidDir);
    expect(record?.destination).toBe(remote);
    // Idempotent: a second resolution does not duplicate or throw.
    expect(projectSlug(cwd, home)).toBe(slug);
    expect(readStrandedDataRecord(join(home, ".moh", "projects", slug))?.recordedAt).toBe(record?.recordedAt);
  });

  test("#1243: the stranded record stops being reported once the old directory holds no data", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-stranded-gone-"));
    const uuidSlug = projectSlug(cwd, home);
    const uuidDir = join(home, ".moh", "projects", uuidSlug);
    mkdirSync(uuidDir, { recursive: true });
    writeFileSync(join(uuidDir, "20260101T000000000Z-deadbeef.jsonl"), "uuid-session");
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "remote", "add", "origin", "git@github.com:Owner/Repo.git"]);
    const remote = join(home, ".moh", "projects", "github.com/owner/repo");
    mkdirSync(remote, { recursive: true });
    writeFileSync(join(remote, "20260202T000000000Z-cafebab0.jsonl"), "remote-session");
    const slug = projectSlug(cwd, home);
    expect(readStrandedDataRecord(join(home, ".moh", "projects", slug))).not.toBeNull();
    // The user does what the warning asks: moves the old data out, leaving the
    // directory (and the durable note) behind.
    rmSync(join(uuidDir, "20260101T000000000Z-deadbeef.jsonl"));
    expect(readStrandedDataRecord(join(home, ".moh", "projects", slug))).toBeNull();
    // A Finder visit must not re-arm it: `.DS_Store` is not project data.
    writeFileSync(join(uuidDir, ".DS_Store"), "");
    expect(readStrandedDataRecord(join(home, ".moh", "projects", slug))).toBeNull();
    // And a fresh resolution neither re-records nor reports it.
    expect(projectSlug(cwd, home)).toBe(slug);
    expect(readStrandedDataRecord(join(home, ".moh", "projects", slug))).toBeNull();
  });

  test("#1243: the acknowledgement is durable, idempotent, and cleared by a genuinely new situation", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-stranded-ack-"));
    const uuidSlug = projectSlug(cwd, home);
    const uuidDir = join(home, ".moh", "projects", uuidSlug);
    mkdirSync(uuidDir, { recursive: true });
    writeFileSync(join(uuidDir, "20260101T000000000Z-deadbeef.jsonl"), "uuid-session");
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "remote", "add", "origin", "git@github.com:Owner/Repo.git"]);
    const remote = join(home, ".moh", "projects", "github.com/owner/repo");
    mkdirSync(remote, { recursive: true });
    writeFileSync(join(remote, "20260202T000000000Z-cafebab0.jsonl"), "remote-session");
    const dir = join(home, ".moh", "projects", projectSlug(cwd, home));
    expect(readStrandedDataRecord(dir)).not.toBeNull();
    acknowledgeStrandedData(dir);
    expect(readStrandedDataRecord(dir)).toBeNull();
    const first = JSON.parse(readFileSync(join(dir, "stranded-data.json"), "utf8")) as { acknowledgedAt?: string };
    expect(typeof first.acknowledgedAt).toBe("string");
    // Idempotent: the first timestamp wins.
    acknowledgeStrandedData(dir);
    const again = JSON.parse(readFileSync(join(dir, "stranded-data.json"), "utf8")) as { acknowledgedAt?: string };
    expect(again.acknowledgedAt).toBe(first.acknowledgedAt);
    // A genuinely new stranded situation (a different uuid directory with
    // data) replaces the record and re-arms the warning.
    const cwd2 = mkdtempSync(join(tmpdir(), "moh-stranded-ack2-"));
    const uuidSlug2 = projectSlug(cwd2, home);
    const uuidDir2 = join(home, ".moh", "projects", uuidSlug2);
    mkdirSync(uuidDir2, { recursive: true });
    writeFileSync(join(uuidDir2, "20260303T000000000Z-fresh123.jsonl"), "second");
    execFileSync("git", ["init", "-q", cwd2]);
    execFileSync("git", ["-C", cwd2, "remote", "add", "origin", "git@github.com:Owner/Repo.git"]);
    projectSlug(cwd2, home);
    const record = readStrandedDataRecord(dir);
    expect(record?.source).toBe(uuidDir2);
  });

  test("#1243: the summary classifies only-here / same-size / differing and ignores .DS_Store + migration.log", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-stranded-sum-"));
    const uuidSlug = projectSlug(cwd, home);
    const uuidDir = join(home, ".moh", "projects", uuidSlug);
    mkdirSync(join(uuidDir, "memory"), { recursive: true });
    writeFileSync(join(uuidDir, "20260101T000000000Z-deadbeef.jsonl"), "uuid-session");
    writeFileSync(join(uuidDir, "session.md"), "notes");
    writeFileSync(join(uuidDir, "memory", "facts.md"), "fact");
    // Same name, same bytes → probably identical; same name, different
    // bytes → differing. Non-data noise must appear in no list.
    writeFileSync(join(uuidDir, "20260202T000000000Z-cafebab0.jsonl"), "shared");
    writeFileSync(join(uuidDir, "20260303T000000000Z-feedface.jsonl"), "mine");
    writeFileSync(join(uuidDir, "migration.log"), "note");
    writeFileSync(join(uuidDir, ".DS_Store"), "");
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "remote", "add", "origin", "git@github.com:Owner/Repo.git"]);
    const remote = join(home, ".moh", "projects", "github.com/owner/repo");
    mkdirSync(remote, { recursive: true });
    writeFileSync(join(remote, "20260202T000000000Z-cafebab0.jsonl"), "shared");
    writeFileSync(join(remote, "20260303T000000000Z-feedface.jsonl"), "theirs-longer");
    const dir = join(home, ".moh", "projects", projectSlug(cwd, home));
    const summary = strandedDataSummary(dir);
    expect(summary?.source).toBe(uuidDir);
    expect(summary?.destination).toBe(remote);
    expect(summary?.onlyHere).toEqual(["20260101T000000000Z-deadbeef.jsonl", "memory", "session.md"]);
    expect(summary?.sameSize).toEqual(["20260202T000000000Z-cafebab0.jsonl"]);
    expect(summary?.differing).toEqual(["20260303T000000000Z-feedface.jsonl"]);
  });

  test("#1243: moveStrandedSessions moves only-here logs, drops identical duplicates, keeps conflicts", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-stranded-move-"));
    const uuidSlug = projectSlug(cwd, home);
    const uuidDir = join(home, ".moh", "projects", uuidSlug);
    mkdirSync(uuidDir, { recursive: true });
    writeFileSync(join(uuidDir, "20260101T000000000Z-deadbeef.jsonl"), "only-here");
    writeFileSync(join(uuidDir, "20260202T000000000Z-cafebab0.jsonl"), "shared");
    writeFileSync(join(uuidDir, "20260303T000000000Z-feedface.jsonl"), "mine");
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "remote", "add", "origin", "git@github.com:Owner/Repo.git"]);
    const remote = join(home, ".moh", "projects", "github.com/owner/repo");
    mkdirSync(remote, { recursive: true });
    writeFileSync(join(remote, "20260202T000000000Z-cafebab0.jsonl"), "shared");
    writeFileSync(join(remote, "20260303T000000000Z-feedface.jsonl"), "theirs");
    const dir = join(home, ".moh", "projects", projectSlug(cwd, home));
    const result = moveStrandedSessions(dir);
    expect(result.moved).toEqual(["20260101T000000000Z-deadbeef.jsonl"]);
    expect(result.dropped).toEqual(["20260202T000000000Z-cafebab0.jsonl"]);
    expect(result.skipped).toEqual(["20260303T000000000Z-feedface.jsonl"]);
    expect(existsSync(join(remote, "20260101T000000000Z-deadbeef.jsonl"))).toBe(true);
    expect(existsSync(join(uuidDir, "20260101T000000000Z-deadbeef.jsonl"))).toBe(false);
    expect(existsSync(join(uuidDir, "20260202T000000000Z-cafebab0.jsonl"))).toBe(false);
    expect(readFileSync(join(remote, "20260303T000000000Z-feedface.jsonl"), "utf8")).toBe("theirs");
    expect(existsSync(join(uuidDir, "20260303T000000000Z-feedface.jsonl"))).toBe(true);
    // memory/session.md still in the old directory: the record stays live.
    writeFileSync(join(uuidDir, "session.md"), "notes");
    expect(readStrandedDataRecord(dir)).not.toBeNull();
  });

  test("#1243: deleteStrandedData trashes the logs, removes the rest, clears the record — and refuses outsiders", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-stranded-del-"));
    const uuidSlug = projectSlug(cwd, home);
    const uuidDir = join(home, ".moh", "projects", uuidSlug);
    mkdirSync(join(uuidDir, "memory"), { recursive: true });
    writeFileSync(join(uuidDir, "20260101T000000000Z-deadbeef.jsonl"), "uuid-session");
    writeFileSync(join(uuidDir, "session.md"), "notes");
    writeFileSync(join(uuidDir, "memory", "facts.md"), "fact");
    writeFileSync(join(uuidDir, "migration.log"), "note");
    writeFileSync(join(uuidDir, ".DS_Store"), "");
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "remote", "add", "origin", "git@github.com:Owner/Repo.git"]);
    const remote = join(home, ".moh", "projects", "github.com/owner/repo");
    mkdirSync(remote, { recursive: true });
    writeFileSync(join(remote, "20260202T000000000Z-cafebab0.jsonl"), "remote-session");
    const dir = join(home, ".moh", "projects", projectSlug(cwd, home));
    const result = deleteStrandedData(dir, cwd, home);
    expect(result.trashed).toBe(1);
    expect(result.removed.sort()).toEqual([".DS_Store", "memory", "migration.log", "session.md"]);
    expect(existsSync(uuidDir)).toBe(false);
    expect(existsSync(join(dir, "stranded-data.json"))).toBe(false);
    expect(readStrandedDataRecord(dir)).toBeNull();
    const trash = projectTrashDir(cwd, home);
    expect(readFileSync(join(trash, "20260101T000000000Z-deadbeef.jsonl"), "utf8")).toBe("uuid-session");
    // Refusal: a record pointing outside ~/.moh/projects/ is never deleted.
    const outsider = mkdtempSync(join(tmpdir(), "moh-stranded-outsider-"));
    writeFileSync(join(outsider, "20260404T000000000Z-aaaaaa11.jsonl"), "x");
    writeFileSync(join(remote, "stranded-data.json"), `${JSON.stringify({ source: outsider, destination: remote, recordedAt: new Date().toISOString() })}\n`);
    expect(() => deleteStrandedData(remote, cwd, home)).toThrow(/refusing/);
    expect(existsSync(outsider)).toBe(true);
  });

  test("#591: canonicalRemoteSlug returns null for non-repo URLs and missing git", () => {
    // No git at all.
    expect(canonicalRemoteSlug("/definitely/not/a/real/cwd-591")).toBeNull();
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-origin-"));
    execFileSync("git", ["init", "-q", cwd]);
    // No origin remote.
    expect(canonicalRemoteSlug(cwd)).toBeNull();
    // origin without an owner/repo path shape.
    execFileSync("git", ["-C", cwd, "remote", "add", "origin", "https://example.com/solo.git"]);
    expect(canonicalRemoteSlug(cwd)).toBeNull();
    // dot / dot-dot path segments must never become a slug (path escape).
    execFileSync("git", ["-C", cwd, "remote", "set-url", "origin", "git@github.com:../../elsewhere.git"]);
    expect(canonicalRemoteSlug(cwd)).toBeNull();
    expect(projectSlug(cwd, home)).toMatch(/^project-[0-9a-f]{16}$/);
  });

  test("append is one JSON line per event; load() round-trips a real session log", async () => {
    const home = tempHome();
    const cwd = process.cwd();
    const store = SessionStore.create(cwd, home);
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["Hello"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    await session.send("hi");

    const raw = readFileSync(store.file, "utf8");
    const lines = raw.trimEnd().split("\n");
    expect(lines.length).toBe(session.history().length);
    // #575: the persisted lines carry identity (fresh ULID + parent head);
    // compare on everything else.
    expect(lines.map((l) => {
      const e = JSON.parse(l);
      delete e.id;
      delete e.parentId;
      delete e.prevHash;
      delete e.hash;
      return e;
    })).toEqual(session.history().map((e) => ({ ...e, id: undefined, parentId: undefined, prevHash: undefined, hash: undefined })));

    // Append-only: existing bytes unchanged after more events.
    const before = raw;
    await session.send("again"); // error turn (script exhausted) still logs events
    const after = readFileSync(store.file, "utf8");
    expect(after.startsWith(before)).toBe(true);

    expect(store.load().map(withoutIntegrity)).toEqual(session.history());
  });

  test("ids are strictly increasing within a process and latest() finds the newest", async () => {
    const home = tempHome();
    const cwd = process.cwd();
    const a = SessionStore.create(cwd, home);
    await Bun.sleep(5);
    const b = SessionStore.create(cwd, home);
    expect(b.file > a.file).toBe(true);

    const latest = SessionStore.latest(cwd, home);
    expect(latest!.file).toBe(b.file);
    expect(SessionStore.latest(join(tmpdir(), "nowhere"), home)).toBeNull();
  });

  test("list() returns the project's session files, newest first", async () => {
    const home = tempHome();
    const cwd = process.cwd();
    expect(SessionStore.list(cwd, home)).toEqual([]);
    const a = SessionStore.create(cwd, home);
    await Bun.sleep(5);
    const b = SessionStore.create(cwd, home);
    expect(SessionStore.list(cwd, home).map((s) => s.file)).toEqual([b.file, a.file]);
  });

  test("fork() creates a new file inheriting the full history; the original is untouched", async () => {
    const home = tempHome();
    const cwd = process.cwd();
    const store = SessionStore.create(cwd, home);
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["one"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    await session.send("first");
    const originalBytes = readFileSync(store.file, "utf8");

    const fork = store.fork();
    expect(fork.file).not.toBe(store.file);
    expect(basename(fork.file, ".jsonl")).toMatch(SORTABLE_ID);
    // The inherited history is byte-identical, then the fork's born-consumed
    // `session_resumed` marker (ADR-0021) — #575: identity-stamped (fresh
    // ULID, parent = the copied log's head); the original stays untouched.
    expect(readFileSync(fork.file, "utf8").startsWith(originalBytes)).toBe(true);
    expect(readFileSync(store.file, "utf8")).toBe(originalBytes);
    const resumed = JSON.parse(readFileSync(fork.file, "utf8").split("\n").at(-2)!) as AgentEvent;
    expect(resumed.type).toBe("session_resumed");
    expect(resumed.id).toMatch(/^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/);
    expect(resumed.parentId).toBeDefined();

    // The fork keeps appending to its own file.
    const forked = createSession({
      provider: MockProvider.scripted([{ deltas: ["two"], finish: "stop" }]),
      sink: (e) => fork.append(e),
    });
    await forked.send("second");
    expect(readFileSync(fork.file, "utf8").startsWith(originalBytes)).toBe(true);
    expect(readFileSync(store.file, "utf8")).toBe(originalBytes);
  });

  test("resume appends to the same file and restores runtime permission rules from the log", async () => {
    const home = tempHome();
    const cwd = process.cwd();
    const store = SessionStore.create(cwd, home);
    // Hand-craft a log that contains a runtime rule grant.
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "abc123def456abc1" },
      { type: "session_mode", mode: "normal" },
      { type: "permission_rule_added", rule: { tier: "runtime", tool: "bash", effect: "allow", tokens: ["git", "status"] } },
      { type: "done" },
    ];
    for (const e of events) store.append(e);

    const latest = SessionStore.latest(cwd, home)!;
    expect(latest.file).toBe(store.file);
    const loaded = latest.load();
    // #575: direct store appends are identity-stamped on the tail.
    expect(loaded.map((e) => ({ ...e, id: undefined, parentId: undefined, prevHash: undefined, hash: undefined }))).toEqual(
      events.map((e) => ({ ...e, id: undefined, parentId: undefined, prevHash: undefined, hash: undefined })),
    );
    // The legacy first line had no id to chain to: parentId is absent
    // (degenerate linear tree); later events chain by ULID.
    expect(loaded[0]!.parentId).toBeUndefined();
    for (let i = 1; i < loaded.length; i += 1) {
      expect(loaded[i]!.parentId).toBe(loaded[i - 1]!.id);
    }

    const runtimeRules = runtimeRulesFromEvents(loaded);
    expect(runtimeRules).toEqual([
      { tier: "runtime", tool: "bash", effect: "allow", tokens: ["git", "status"] },
    ]);

    // The resumed session reuses the same file and the restored rules apply.
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      permissions: { runtimeRules },
      sink: (e) => latest.append(e),
    });
    expect(session.permissionRules.filter((r) => r.tier === "runtime")).toEqual(runtimeRules);
    await session.send("continue");
    const full = latest.load();
    // The resumed session re-appends session_start/session_mode plus the turn events.
    expect(full.length).toBe(events.length + 6); // session_start, session_mode, user_message, assistant_delta, model_call, done
    expect(full.slice(0, events.length).map((e) => ({ ...e, id: undefined, parentId: undefined, prevHash: undefined, hash: undefined }))).toEqual(
      events.map((e) => ({ ...e, id: undefined, parentId: undefined, prevHash: undefined, hash: undefined })),
    );
  });

  test("load() rejects too-old and too-new schema versions with clear errors", () => {
    const home = tempHome();
    const dir = join(home, ".moh", "projects", "x");
    mkdirSync(dir, { recursive: true });
    const old = join(dir, "20260101T000000000Z-old.jsonl");
    writeFileSync(old, JSON.stringify({ type: "session_start", schemaVersion: 0, promptVersion: "x" }) + "\n");
    expect(() => SessionStore.open(old).load()).toThrow(/too old/i);

    const future = join(dir, "20260101T000000001Z-new.jsonl");
    writeFileSync(future, JSON.stringify({ type: "session_start", schemaVersion: 99, promptVersion: "x" }) + "\n");
    expect(() => SessionStore.open(future).load()).toThrow(/newer/i);
  });

  test("load() tolerates a trailing empty line", () => {
    const home = tempHome();
    const store = SessionStore.create(process.cwd(), home);
    store.append({ type: "session_start", schemaVersion: 1, promptVersion: "abc123def456abc1" });
    appendFileSync(store.file, "\n");
    expect(store.load().map(withoutIntegrity).map((e) => ({ ...e, id: undefined, parentId: undefined }))).toEqual([
      { type: "session_start", schemaVersion: 1, promptVersion: "abc123def456abc1", id: undefined, parentId: undefined },
    ]);
  });

  test("replayMessages() repairs a tool_call whose tool_result never arrived (aborted turn) #237", () => {
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "abc123def456abc1" },
      { type: "user_message", text: "run" },
      { type: "assistant_delta", text: "starting" },
      { type: "tool_call", callId: "c9", name: "bash", args: { command: "sleep 99" } },
      // turn aborted mid-tool: user_message + error, no tool_result for c9
      { type: "user_message", text: "come procede?" },
      { type: "error", reason: "invalid_request", message: "x" },
    ];
    const messages = replayMessages(events);
    // The orphan tool_call must be followed by a failed synthetic
    // tool_result so the replayed conversation satisfies the tool-use
    // protocol every provider requires.
    const idx = messages.findIndex(
      (m) => m.parts.some((p) => p.kind === "tool_call" && p.callId === "c9"),
    );
    expect(idx).toBeGreaterThan(-1);
    const follow = messages[idx + 1]!;
    expect(follow.role).toBe("user");
    expect(follow.parts[0]).toMatchObject({ kind: "tool_result", callId: "c9", ok: false });
  });

  test("replayMessages() never emits an orphan tool_result after a discarded assistant message #371", () => {
    // Completed tool call, then the following model call fails and the
    // turn is cancelled: the tool_result must not survive the discard of
    // its assistant tool_call, or every later OpenAI-wire request fails
    // with "No tool call found for function call output".
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "abc123def456abc1" },
      { type: "user_message", text: "run" },
      { type: "assistant_delta", text: "starting" },
      { type: "tool_call", callId: "c1", name: "bash", args: { command: "ls" } },
      { type: "model_call", model: "glm-5.3", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "tool_result", callId: "c1", ok: true, output: "file.txt" },
      { type: "model_call", model: "glm-5.3", usage: { inputTokens: 1, outputTokens: 1 }, failed: true },
      { type: "cancelled" },
      { type: "user_message", text: "continue" },
      { type: "assistant_delta", text: "ok" },
      { type: "done" },
    ];
    const messages = replayMessages(events);
    const callIds = new Set(
      messages.flatMap((m) => m.parts.flatMap((p) => (p.kind === "tool_call" ? [p.callId] : []))),
    );
    const orphans = messages.flatMap((m) =>
      m.parts.flatMap((p) => (p.kind === "tool_result" && !callIds.has(p.callId) ? [p.callId] : [])),
    );
    expect(orphans).toEqual([]);
    expect(messages).toEqual([
      { role: "user", parts: [{ kind: "text", text: "run" }] },
      { role: "user", parts: [{ kind: "text", text: "continue" }] },
      { role: "assistant", parts: [{ kind: "text", text: "ok" }] },
    ]);
  });

  test("replayMessages() drops a completed tool pair when a fallback discards the call #371", () => {
    // Same invariant through the fallback path: the failed stop's
    // assistant message (carrying the tool_call) is discarded, so its
    // already-settled tool_result must not leak into the conversation.
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "abc123def456abc1" },
      { type: "user_message", text: "run" },
      { type: "assistant_delta", text: "starting" },
      { type: "tool_call", callId: "c1", name: "bash", args: { command: "ls" } },
      { type: "tool_result", callId: "c1", ok: true, output: "file.txt" },
      { type: "fallback", from: "glm-5.3", to: "gpt-5.6-terra", reason: "rate_limited" },
      { type: "model_call", model: "glm-5.3", usage: { inputTokens: 1, outputTokens: 1 }, failed: true },
      { type: "assistant_delta", text: "resumed" },
      { type: "done" },
    ];
    const messages = replayMessages(events);
    expect(messages).toEqual([
      { role: "user", parts: [{ kind: "text", text: "run" }] },
      { role: "assistant", parts: [{ kind: "text", text: "resumed" }] },
    ]);
  });

  test("replayMessages() rebuilds the provider-facing conversation from the log", () => {
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "abc123def456abc1" },
      { type: "session_mode", mode: "normal" },
      { type: "user_message", text: "hi" },
      { type: "assistant_delta", text: "Hello" },
      { type: "assistant_delta", text: " world" },
      { type: "done" },
      { type: "user_message", text: "again" },
      { type: "assistant_delta", text: "Bye" },
      { type: "tool_call", callId: "c1", name: "bash", args: { command: "ls" } },
      { type: "tool_result", callId: "c1", ok: true, output: "file.txt" },
      { type: "assistant_delta", text: "Done" },
      { type: "done" },
    ];
    const messages = replayMessages(events);
    expect(messages).toEqual([
      { role: "user", parts: [{ kind: "text", text: "hi" }] },
      { role: "assistant", parts: [{ kind: "text", text: "Hello world" }] },
      { role: "user", parts: [{ kind: "text", text: "again" }] },
      {
        role: "assistant",
        parts: [
          { kind: "text", text: "Bye" },
          { kind: "tool_call", callId: "c1", name: "bash", args: { command: "ls" } },
        ],
      },
      { role: "user", parts: [{ kind: "tool_result", callId: "c1", ok: true, output: "file.txt" }] },
      { role: "assistant", parts: [{ kind: "text", text: "Done" }] },
    ]);
  });
});

// #400: single-writer semantics — an open session detects that its JSONL
// file grew from elsewhere (sync channel / second process) at append
// boundaries. Tested at the session-store seam by mutating the file
// externally between open and append.
describe("single-writer guard (#400)", () => {
  const START: AgentEvent = { type: "session_start", schemaVersion: 1, promptVersion: "abc123def456abc1" };

  test("externalGrowth() reports growth between open and append, once, with both sizes", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);
    store.append(START);
    expect(store.externalGrowth()).toBeNull();

    // External writer appends to the same file (e.g. a synced machine).
    const before = statSync(store.file).size;
    appendFileSync(store.file, JSON.stringify({ type: "user_message", text: "from elsewhere" }) + "\n");
    const after = statSync(store.file).size;

    const growth = store.externalGrowth();
    expect(growth).not.toBeNull();
    expect(growth!.expectedBytes).toBe(before);
    expect(growth!.actualBytes).toBe(after);
    // Consuming: one incident, one warning — acknowledged until new
    // external growth (the local append has not happened yet).
    expect(store.externalGrowth()).toBeNull();
  });

  test("after the local append the expectation refreshes; local bytes stay intact", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);
    store.append(START);
    appendFileSync(store.file, JSON.stringify({ type: "user_message", text: "from elsewhere" }) + "\n");
    const bytesBeforeLocalAppend = readFileSync(store.file, "utf8");

    // The session flow probes before appending: the incident is observed
    // (consumed) here, then the local append proceeds on the tail with
    // the refreshed baseline. Nothing is rewritten; the external line
    // survives; no silent corruption.
    expect(store.externalGrowth()).not.toBeNull();
    store.append({ type: "user_message", text: "local" });
    const raw = readFileSync(store.file, "utf8");
    expect(raw.startsWith(bytesBeforeLocalAppend)).toBe(true);
    expect(store.externalGrowth()).toBeNull();
  });

  test("a local append that never probed does not swallow the external growth", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);
    store.append(START);
    const before = statSync(store.file).size;
    appendFileSync(store.file, JSON.stringify({ type: "user_message", text: "from elsewhere" }) + "\n");
    const after = statSync(store.file).size;

    // The append's arithmetic baseline (no re-stat) never observed the
    // foreign bytes: the next probe still reports them, unswallowed —
    // exactly once, then consumed.
    store.append({ type: "user_message", text: "local" });
    const growth = store.externalGrowth();
    expect(growth).not.toBeNull();
    // #575: the local line is identity-stamped (ULID + parentId) — its
    // byte length is computed from what was actually written.
    const localLine = JSON.stringify(store.load().at(-1)!) + "\n";
    expect(growth!.expectedBytes).toBe(before + Buffer.byteLength(localLine));
    expect(growth!.actualBytes).toBe(statSync(store.file).size);
    expect(store.externalGrowth()).toBeNull();
  });

  test("an open (resumed) store baselines at open time, not at the history's end", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const original = SessionStore.create(cwd, home);
    original.append(START);
    const originalBytes = readFileSync(original.file, "utf8");

    const reopened = SessionStore.open(original.file);
    expect(reopened.externalGrowth()).toBeNull();
    appendFileSync(original.file, JSON.stringify({ type: "user_message", text: "from elsewhere" }) + "\n");
    expect(reopened.externalGrowth()).not.toBeNull();

    // The original writer also notices the reopened writer's appends.
    reopened.append({ type: "user_message", text: "local" });
    expect(original.externalGrowth()).not.toBeNull();
  });

  test("shrinking or same-size external rewrites are not reported (growth-only signal)", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);
    store.append(START);
    writeFileSync(store.file, readFileSync(store.file, "utf8"));
    expect(store.externalGrowth()).toBeNull();
  });
});

describe("pertinent session (ADR-0021)", () => {
  test("fork() is born consumed: the new file opens with one session_resumed", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const original = SessionStore.create(cwd, home);
    original.append({ type: "session_start", schemaVersion: 1, promptVersion: "abc" });
    const forked = original.fork();
    const events = forked.load().map((e) => e.type);
    expect(events).toEqual(["session_start", "session_resumed"]);
    // The original file is untouched.
    expect(original.load().map((e) => e.type)).toEqual(["session_start"]);
  });

  test("listSessionSummaries: never-resumed session is not consumed", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);
    store.append({ type: "session_start", schemaVersion: 1, promptVersion: "abc" });
    store.append({ type: "user_message", text: "hello" });
    store.append({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, models: [] });
    const [summary] = listSessionSummaries(cwd, home);
    expect(summary.consumed).toBe(false);
    expect(summary.title).toBe("hello");
  });

  test("listSessionSummaries: resumed then closed is consumed", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);
    store.append({ type: "session_start", schemaVersion: 1, promptVersion: "abc" });
    store.append({ type: "user_message", text: "hello" });
    store.append({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, models: [] });
    store.append({ type: "session_resumed" });
    const [summary] = listSessionSummaries(cwd, home);
    expect(summary.consumed).toBe(true);
  });

  test("listSessionSummaries: resumed then worked on is suggestible again (consumption re-openable)", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);
    store.append({ type: "session_start", schemaVersion: 1, promptVersion: "abc" });
    store.append({ type: "session_resumed" });
    store.append({ type: "user_message", text: "back to work" });
    store.append({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, models: [] });
    const [summary] = listSessionSummaries(cwd, home);
    expect(summary.consumed).toBe(false);
    expect(summary.title).toBe("back to work");
  });
});

describe("session rename (#477)", () => {
  function seedSession(): { home: string; cwd: string; file: string } {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);
    store.append({ type: "session_start", schemaVersion: 1, promptVersion: "abc" });
    store.append({ type: "user_message", text: "first user message" });
    store.append({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, models: [] });
    return { home, cwd, file: store.file };
  }

  test("renameSession updates SessionSummary.title and keeps derivedTitle", () => {
    const { home, cwd, file } = seedSession();
    renameSession(file, "my cool name");
    const [summary] = listSessionSummaries(cwd, home);
    expect(summary.title).toBe("my cool name");
    expect(summary.derivedTitle).toBe("first user message");
  });

  test("last rename wins; empty name resets to the derived title", () => {
    const { home, cwd, file } = seedSession();
    renameSession(file, "one");
    renameSession(file, "two");
    expect(listSessionSummaries(cwd, home)[0].title).toBe("two");
    renameSession(file, "  ");
    const [summary] = listSessionSummaries(cwd, home);
    expect(summary.title).toBe("first user message");
    expect(summary.derivedTitle).toBe("first user message");
  });

  test("the reset event is appended (append-only log), nothing is deleted", () => {
    const { file } = seedSession();
    const before = readFileSync(file, "utf8");
    renameSession(file, "renamed");
    renameSession(file, "");
    const after = readFileSync(file, "utf8");
    expect(after.startsWith(before)).toBe(true);
    const events = after.trim().split("\n").map((l) => (JSON.parse(l) as AgentEvent).type);
    expect(events.slice(-2)).toEqual(["session_renamed", "session_renamed"]);
  });

  test("fork inherits the display name", () => {
    const { home, cwd, file } = seedSession();
    renameSession(file, "inherited name");
    const original = SessionStore.list(cwd, home)[0];
    const forked = original.fork();
    const events = forked.load();
    expect(events.some((e) => e.type === "session_renamed" && e.name === "inherited name")).toBe(true);
    void home;
  });

  test("renameSession validates the file", () => {
    expect(() => renameSession("/nope/missing.jsonl", "x")).toThrow();
    const notSession = join(mkdtempSync(join(tmpdir(), "moh-proj-")), "random.jsonl");
    writeFileSync(notSession, "{}\n");
    expect(() => renameSession(notSession, "x")).toThrow();
  });

  test("setSessionPinned toggles SessionSummary.pinned; last event wins", () => {
    const { home, cwd, file } = seedSession();
    const [before] = listSessionSummaries(cwd, home);
    expect(before.pinned).toBe(false);
    setSessionPinned(file, true);
    expect(listSessionSummaries(cwd, home)[0].pinned).toBe(true);
    setSessionPinned(file, false);
    expect(listSessionSummaries(cwd, home)[0].pinned).toBe(false);
  });

  test("setSessionPinned appends chrome-only events (append-only, not content)", () => {
    const { file } = seedSession();
    const before = readFileSync(file, "utf8");
    setSessionPinned(file, true);
    setSessionPinned(file, true); // a double toggle still appends
    const after = readFileSync(file, "utf8");
    expect(after.startsWith(before)).toBe(true);
    const events = after.trim().split("\n").map((l) => JSON.parse(l) as AgentEvent);
    expect(events.slice(-2).map((e) => e.type)).toEqual(["session_pinned", "session_pinned"]);
    const messages = replayMessages(events);
    expect(messages.length).toBe(1);
  });

  test("setSessionPinned validates the file", () => {
    expect(() => setSessionPinned("/nope/missing.jsonl", true)).toThrow();
    const notSession = join(mkdtempSync(join(tmpdir(), "moh-proj-")), "random.jsonl");
    writeFileSync(notSession, "{}\n");
    expect(() => setSessionPinned(notSession, true)).toThrow();
  });

  test("compaction/replay never treats the chrome event as content", () => {
    const { file } = seedSession();
    renameSession(file, "renamed");
    const events = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as AgentEvent);
    const messages = replayMessages(events);
    expect(messages.length).toBe(1);
    expect(JSON.stringify(messages[0]).includes("renamed")).toBe(false);
  });
});

describe("session trash (#478)", () => {
  function seedTrash(): { home: string; cwd: string; file: string } {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);
    store.append({ type: "session_start", schemaVersion: 1, promptVersion: "abc" });
    store.append({ type: "user_message", text: "doomed session" });
    store.append({ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, models: [] });
    store.dispose(); // trashed sessions are closed by definition
    return { home, cwd, file: store.file };
  }

  test("deleteSession moves the file into the trash and out of the live listing", () => {
    const { home, cwd, file } = seedTrash();
    deleteSession(file, cwd, home);
    expect(existsSync(file)).toBe(false);
    const trashed = listTrashedSessions(cwd, home);
    expect(trashed.length).toBe(1);
    expect(trashed[0].id).toBe(basename(file, ".jsonl"));
    expect(trashed[0].file).toBe(join(home, ".moh", "trash", "projects", projectSlug(cwd, home), basename(file)));
    expect(existsSync(trashed[0].file)).toBe(true);
    expect(listSessionSummaries(cwd, home).find((s) => s.file === file)).toBeUndefined();
  });

  test("deleteSession refuses a non-session or missing file", () => {
    const { home, cwd } = seedTrash();
    expect(() => deleteSession("/nope/missing.jsonl", cwd, home)).toThrow();
    const notSession = join(mkdtempSync(join(tmpdir(), "moh-proj-")), "random.jsonl");
    writeFileSync(notSession, "{}\n");
    expect(() => deleteSession(notSession, cwd, home)).toThrow();
  });

  test("deleteSession refuses a session open in this process", () => {
    const { home, cwd, file } = seedTrash();
    const store = SessionStore.open(file);
    expect(() => deleteSession(file, cwd, home)).toThrow(/open/);
    void store;
  });

  test("restoreSession moves the file back with identical content", () => {
    const { home, cwd, file } = seedTrash();
    const content = readFileSync(file, "utf8");
    deleteSession(file, cwd, home);
    const [entry] = listTrashedSessions(cwd, home);
    const restored = restoreSession(entry.file, cwd, home);
    expect(restored).toBe(file);
    expect(readFileSync(file, "utf8")).toBe(content);
    expect(listSessionSummaries(cwd, home).length).toBe(1);
    expect(listTrashedSessions(cwd, home).length).toBe(0);
  });

  test("restoreSession refuses an id collision with a live session", () => {
    const { home, cwd, file } = seedTrash();
    const content = readFileSync(file, "utf8");
    deleteSession(file, cwd, home);
    // Recreate a live session with the same id (simulated collision).
    writeFileSync(file, content);
    const [entry] = listTrashedSessions(cwd, home);
    expect(() => restoreSession(entry.file, cwd, home)).toThrow(/collision|exists/i);
  });

  test("lazy prune removes only entries older than the retention window", () => {
    const { home, cwd, file } = seedTrash();
    deleteSession(file, cwd, home);
    // A second, older entry beyond the 30-day window.
    const oldId = "20200101T000000000Z-deadbeef";
    const trashDir = join(home, ".moh", "trash", "projects", projectSlug(cwd, home));
    const oldFile = join(trashDir, `${oldId}.jsonl`);
    writeFileSync(oldFile, '{"type":"session_start","schemaVersion":1,"promptVersion":"abc"}\n');
    const past = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    writeFileSync(oldFile, readFileSync(oldFile, "utf8")); // ensure content
    const { utimesSync } = require("node:fs") as typeof import("node:fs");
    utimesSync(oldFile, past, past);
    pruneTrash(cwd, home);
    expect(existsSync(oldFile)).toBe(false);
    expect(listTrashedSessions(cwd, home).length).toBe(1);
  });

  test("retention days configurable via ~/.moh/config sessionTrash.retentionDays", () => {
    const { home, cwd, file } = seedTrash();
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(join(home, ".moh", "config"), JSON.stringify({ sessionTrash: { retentionDays: 1 } }));
    deleteSession(file, cwd, home);
    const [entry] = listTrashedSessions(cwd, home);
    expect(entry.daysRemaining).toBeGreaterThanOrEqual(1);
    // Backdate it beyond 1 day and it prunes on the next touch.
    const { utimesSync } = require("node:fs") as typeof import("node:fs");
    const past = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    utimesSync(entry.file, past, past);
    pruneTrash(cwd, home);
    expect(existsSync(entry.file)).toBe(false);
  });
});

describe("event identity (#575)", () => {
  test("line:N bridge resolves legacy events read-only; ULIDs resolve by id; dangling refs are null", () => {
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "v" },
      { type: "session_mode", mode: "normal" },
    ];
    const bridged = resolveEventRef("line:2", events);
    expect(bridged?.type).toBe("session_mode");
    // The bridge value rides `parentId` (a reference, never an id — d8).
    expect(bridged?.parentId).toBe("line:2");
    expect(bridged?.id).toBeUndefined();
    // The underlying log is untouched — the bridge is read-only.
    expect(events[1]!.id).toBeUndefined();
    expect(resolveEventRef("line:9", events)).toBeNull();
    expect(resolveEventRef("nope", events)).toBeNull();

    const identified: AgentEvent[] = [
      { type: "session_start", schemaVersion: 2, promptVersion: "v", id: "01ABCDEFABCDEFGHJKMNPQRSTV" },
    ];
    expect(resolveEventRef("01ABCDEFABCDEFGHJKMNPQRSTV", identified)?.type).toBe("session_start");
    expect(resolveEventRef("01ABCDEFABCDEFGHJKMNPQRSTW", identified)).toBeNull();
  });

  test("renameSession stamps identity: fresh ULID, parent = log head", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["hi"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    session.dispose();
    const before = store.load();
    renameSession(store.file, "my name");
    const after = store.load();
    const renamed = after.at(-1)!;
    expect(renamed.type).toBe("session_renamed");
    expect(renamed.id).toMatch(/^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/);
    expect(renamed.parentId).toBe(after.at(-2)!.id);
    expect(before.length + 1).toBe(after.length);
  });

  test("appending to a legacy log stamps id without a line:N parent; appends to a v2 log chain by ULID", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);
    appendFileSync(store.file, '{"type":"session_start","schemaVersion":1,"promptVersion":"v"}\n');
    store.append({ type: "session_mode", mode: "normal" });
    const lines = readFileSync(store.file, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[1]!) as AgentEvent;
    expect(first.id).toMatch(/^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/);
    // A purely legacy tail has no id: parentId is absent (same rule as
    // EventLog.append) — no `line:N` is ever written (d8).
    expect(first.parentId).toBeUndefined();
    store.append({ type: "session_mode", mode: "auto-accept" });
    const [, second, third] = store.load();
    expect(third!.parentId).toBe(second!.id);
  });
});

describe("isSessionOpen (#582, the #478 registry seam)", () => {
  test("reflects SessionStore.open/dispose; unknown files are not open", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    const store = SessionStore.create(cwd, home);
    const file = store.file;
    store.append({ type: "session_start", schemaVersion: 2, promptVersion: "v" });
    expect(isSessionOpen(file)).toBe(true);
    store.dispose();
    expect(isSessionOpen(file)).toBe(false);
    expect(isSessionOpen("/nope/missing.jsonl")).toBe(false);
  });
});

describe("#778: screenshot pixels ride replay", () => {
  test("a tool_result with image rebuilds the typed image part on resume/fork", () => {
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "abc123def456abc1" },
      { type: "user_message", text: "screenshot the canvas" },
      { type: "assistant_delta", text: "taking it" },
      { type: "tool_call", callId: "cs", name: "browser", args: { action: "screenshot" } },
      { type: "model_call", model: "glm-5.3", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "tool_result", callId: "cs", ok: true, output: "[screenshot: viewport]", image: { mime: "image/png", base64: "cG5n" } },
      { type: "model_call", model: "glm-5.3", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "assistant_delta", text: "done" },
      { type: "done" },
    ];
    const messages = replayMessages(events);
    const results = messages.flatMap((m) => m.parts.filter((p) => p.kind === "tool_result"));
    expect(results[0]).toMatchObject({ callId: "cs", ok: true, output: "[screenshot: viewport]", image: { mime: "image/png", base64: "cG5n" } });
  });

  test("a tool_result without image replays exactly as before", () => {
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "abc123def456abc1" },
      { type: "user_message", text: "ls" },
      { type: "assistant_delta", text: "ok" },
      { type: "tool_call", callId: "c1", name: "bash", args: { command: "ls" } },
      { type: "model_call", model: "glm-5.3", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "tool_result", callId: "c1", ok: true, output: "file.txt" },
      { type: "model_call", model: "glm-5.3", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "assistant_delta", text: "done" },
      { type: "done" },
    ];
    const messages = replayMessages(events);
    const results = messages.flatMap((m) => m.parts.filter((p) => p.kind === "tool_result"));
    expect(results[0]).toEqual({ kind: "tool_result", callId: "c1", ok: true, output: "file.txt" });
  });
});

describe("scoped fork (#768)", () => {
  const ULID = (n: number) => `01J000000000000000000000${String(n).padStart(2, "0")}`;
  const START: AgentEvent = { type: "session_start", schemaVersion: 1, promptVersion: "abc123def456abc1", id: ULID(1) };

  /** A branchy hand-crafted log: root turn (u1/a1), a sibling branch
   * (u2/a2) reached by a switch, then a switch back to a1 and a third
   * turn (u3/a3). The active path is s1,u1,a1,u3,a3. */
  function branchyStore(home: string, cwd: string): SessionStore {
    const store = SessionStore.create(cwd, home);
    const appends: AgentEvent[] = [
      START,
      { type: "user_message", text: "turn one", id: ULID(2), parentId: ULID(1) },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, models: [], id: ULID(3), parentId: ULID(2) },
      { type: "branch_switched", to: ULID(2), id: ULID(4), parentId: ULID(3) },
      { type: "user_message", text: "sibling", id: ULID(5), parentId: ULID(2) },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, models: [], id: ULID(6), parentId: ULID(5) },
      { type: "tree_bookmarked", to: ULID(5), name: "sibling-mark", id: ULID(7), parentId: ULID(6) },
      { type: "branch_switched", to: ULID(3), id: ULID(8), parentId: ULID(6) },
      { type: "compaction", summary: "path so far", upToId: `line:2`, id: ULID(9), parentId: ULID(3) },
      { type: "user_message", text: "turn three", id: ULID(10), parentId: ULID(3) },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, models: [], id: ULID(11), parentId: ULID(10) },
    ];
    for (const e of appends) store.append(e);
    return store;
  }

  test("default fork() keeps today's full-tree behavior", () => {
    const home = tempHome();
    const store = branchyStore(home, mkdtempSync(join(tmpdir(), "moh-proj-")));
    const originalBytes = readFileSync(store.file, "utf8");
    const fork = store.fork();
    expect(readFileSync(fork.file, "utf8").startsWith(originalBytes)).toBe(true);
    expect(fork.load()).toHaveLength(12); // 11 + session_resumed
  });

  test('fork("branch") copies only the active root→head path as a degenerate linear tree', () => {
    const home = tempHome();
    const store = branchyStore(home, mkdtempSync(join(tmpdir(), "moh-proj-")));
    const originalBytes = readFileSync(store.file, "utf8");
    const fork = store.fork("branch");
    // The original is untouched.
    expect(readFileSync(store.file, "utf8")).toBe(originalBytes);
    const events = fork.load();
    expect(events.map((e) => e.type)).toEqual([
      "session_start",
      "user_message",
      "done",
      "compaction",
      "user_message",
      "done",
      "session_resumed",
    ]);
    // Sibling branch and its bookmark are gone; no source-tree switch markers.
    expect(events.some((e) => e.type === "branch_switched")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("sibling");
    // Parent chains into the source topology are dropped: the copy is a
    // valid degenerate linear tree.
    for (const e of events.slice(0, -1)) expect(e.parentId).toBeUndefined();
    // The projected log replays as one certified path (its own activePath).
    expect(fork.load()[events.length - 1]!.parentId).toBeDefined();
    // Compaction line pointer remapped to the surviving id (line refs would
    // shift in the copy).
    const marker = events.find((e) => e.type === "compaction") as Extract<AgentEvent, { type: "compaction" }>;
    expect(marker.upToId).toBe(ULID(2));
  });

  test('fork("branch") on a purely legacy linear log copies the log unchanged', () => {
    const home = tempHome();
    const store = SessionStore.create(mkdtempSync(join(tmpdir(), "moh-proj-")), home);
    // A purely legacy tail: identity-less lines, written directly.
    const lines: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "abc" },
      { type: "user_message", text: "hello" },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, models: [] },
    ];
    writeFileSync(store.file, lines.map((e) => JSON.stringify(e) + "\n").join(""), { flag: "w", mode: 0o600 });
    const originalBytes = readFileSync(store.file, "utf8");
    const fork = store.fork("branch");
    // #1259: the copy re-seals the hash chain over the same events — the
    // content matches the source, the bytes gain the integrity fields.
    // The trailing `session_resumed` is the fork's own (ADR-0021) tail.
    const projected = fork.load().map(withoutIntegrity);
    expect(projected.at(-1)!.type).toBe("session_resumed");
    expect(projected.slice(0, -1)).toEqual(lines);
    expect(readFileSync(fork.file, "utf8")).not.toBe(originalBytes);
    expect(fork.load().some((e) => e.type === "log_integrity_warning")).toBe(false);
  });

  test('fork("branch") of a session with a dangling compaction line pointer drops the pointer visibly, never mis-remaps', () => {
    const home = tempHome();
    const store = SessionStore.create(mkdtempSync(join(tmpdir(), "moh-proj-")), home);
    store.append(START);
    store.append({ type: "user_message", text: "only turn", id: ULID(2), parentId: ULID(1) });
    store.append({ type: "compaction", summary: "gone", upToId: "line:99", id: ULID(3), parentId: ULID(2) });
    const fork = store.fork("branch");
    const marker = fork.load().find((e) => e.type === "compaction") as Extract<AgentEvent, { type: "compaction" }>;
    // `line:99` does not exist in the source: keeping it would silently
    // resolve to a different position in the short copy.
    expect(marker.upToId).toBeUndefined();
  });
});

describe("session-log integrity (#1259)", () => {
  function newStore() {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "moh-proj-"));
    return SessionStore.create(cwd, home);
  }

  function parsedLines(file: string): (AgentEvent & { prevHash?: string; hash?: string })[] {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
  }

  function expectedHash(event: { prevHash?: string; hash?: string } & object): string {
    const { prevHash, hash, ...rest } = event;
    return createHash("sha256").update(prevHash ?? "").update("\n").update(JSON.stringify(rest)).digest("hex");
  }

  test("every written line carries a verified prevHash/hash pair chaining through the log", () => {
    const store = newStore();
    store.append({ type: "session_start", schemaVersion: 1, promptVersion: "v" });
    store.append({ type: "user_message", text: "hi" });
    store.append({ type: "done" });
    const lines = parsedLines(store.file);
    expect(lines[0]!.prevHash).toBe("");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      expect(typeof line.hash).toBe("string");
      expect(expectedHash(line as AgentEvent & { prevHash?: string; hash?: string })).toBe(line.hash!);
      if (i > 0) expect(line.prevHash).toBe(lines[i - 1]!.hash);
    }
  });

  test("untampered logs load with no warnings and no extra writes", () => {
    const store = newStore();
    store.append({ type: "session_start", schemaVersion: 1, promptVersion: "v" });
    store.append({ type: "user_message", text: "hi" });
    const before = readFileSync(store.file, "utf8");
    const events = store.load();
    expect(events.some((e) => e.type === "log_integrity_warning")).toBe(false);
    expect(readFileSync(store.file, "utf8")).toBe(before);
  });

  test("rewriting a line's content surfaces a log_integrity_warning naming the position", () => {
    const store = newStore();
    store.append({ type: "session_start", schemaVersion: 1, promptVersion: "v" });
    store.append({ type: "user_message", text: "original" });
    const raw = readFileSync(store.file, "utf8").split("\n");
    const tampered = JSON.parse(raw[1]!) as Record<string, unknown>;
    tampered.text = "tampered";
    raw[1] = JSON.stringify(tampered);
    writeFileSync(store.file, raw.join("\n"));

    const events = store.load();
    const warnings = events.filter((e) => e.type === "log_integrity_warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ type: "log_integrity_warning", line: 2, reason: "hash_mismatch" });
    // The warning is chrome in the log itself, so a resume shows it.
    expect(parsedLines(store.file).at(-1)!.type).toBe("log_integrity_warning");

    // In-file dedupe: a second load never stacks a duplicate warning.
    store.load();
    expect(parsedLines(store.file).filter((e) => e.type === "log_integrity_warning")).toHaveLength(1);
  });

  test("a rewritten chain pointer is a chain_break; one tamper does not cascade", () => {
    const store = newStore();
    store.append({ type: "session_start", schemaVersion: 1, promptVersion: "v" });
    store.append({ type: "user_message", text: "a" });
    store.append({ type: "user_message", text: "b" });
    const raw = readFileSync(store.file, "utf8").split("\n");
    const tampered = JSON.parse(raw[1]!) as Record<string, string>;
    tampered.prevHash = "0".repeat(64);
    raw[1] = JSON.stringify(tampered);
    writeFileSync(store.file, raw.join("\n"));
    const events = store.load();
    const warnings = events.filter((e) => e.type === "log_integrity_warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ line: 2, reason: "chain_break" });
    // Line 3 still verifies against its recorded prev: exactly one mismatch.
    expect(warnings.every((w) => w.line === 2)).toBe(true);
  });

  test("legacy hash-less logs resume unchanged; the chain starts where hashes begin", () => {
    const store = newStore();
    appendFileSync(store.file, '{"type":"session_start","schemaVersion":1,"promptVersion":"v"}\n');
    appendFileSync(store.file, '{"type":"user_message","text":"legacy"}\n');
    store.append({ type: "done" });
    const lines = parsedLines(store.file);
    expect(lines[0]!.hash).toBeUndefined();
    expect(lines[1]!.hash).toBeUndefined();
    expect(lines[2]!.prevHash).toBe("");
    expect(expectedHash(lines[2]! as AgentEvent & { prevHash?: string; hash?: string })).toBe(lines[2]!.hash!);
    expect(store.load().some((e) => e.type === "log_integrity_warning")).toBe(false);
  });

  test("stamping onto a corrupt log is loud, never a silent parentless append", () => {
    const store = newStore();
    store.append({ type: "session_start", schemaVersion: 1, promptVersion: "v" });
    store.append({ type: "user_message", text: "keep" });
    const raw = readFileSync(store.file, "utf8").split("\n");
    raw[1] = "{not json";
    writeFileSync(store.file, raw.join("\n"));
    expect(() => renameSession(store.file, "x")).toThrow(/failed to load/);
  });
});
