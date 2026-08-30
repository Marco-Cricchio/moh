/**
 * #274 / ADR-0014: self-update — download/verify/replace seams, injectable IO.
 * #351: onProgress emission at phase transitions (optional, silent without).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CryptoHasher } from "bun";
import {
  UPDATE_PLATFORMS,
  assetUrl,
  checksumFor,
  detectUpdatePlatform,
  performSelfUpdate,
  releasesUrl,
  type SelfUpdateProgress,
  type UpdateFetchResponse,
} from "../src/self-update";

function checksumOf(data: Uint8Array): string {
  const h = new CryptoHasher("sha256");
  h.update(data);
  return h.digest("hex");
}

function jsonRes(body: unknown): UpdateFetchResponse {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => "",
  };
}
function bytesRes(data: Uint8Array, ok = true): UpdateFetchResponse {
  return {
    ok,
    status: ok ? 200 : 404,
    json: async () => ({}),
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    text: async () => new TextDecoder().decode(data),
  };
}

const NEW_BINARY = new TextEncoder().encode("#!/bin/sh\necho 'new moh 0.2.0'\n");

function fakeReleaseUrls(asset = NEW_BINARY, hash = checksumOf(NEW_BINARY)) {
  return {
    "/releases/latest": jsonRes({
      tag_name: "v0.2.0",
      assets: [
        { name: "moh-darwin-arm64", browser_download_url: "/dl/moh-darwin-arm64" },
        { name: "checksums.txt", browser_download_url: "/dl/checksums.txt" },
      ],
    }),
    "/dl/moh-darwin-arm64": bytesRes(asset),
    "/dl/checksums.txt": bytesRes(new TextEncoder().encode(`${hash}  moh-darwin-arm64\n`)),
  };
}

function fetchMap(routes: Record<string, UpdateFetchResponse | Error>) {
  return async (url: string): Promise<UpdateFetchResponse> => {
    const route = Object.entries(routes).find(([k]) => url.endsWith(k))?.[1];
    if (route === undefined) throw new Error(`no route for ${url}`);
    if (route instanceof Error) throw route;
    return route;
  };
}

function fakeBin(dir = mkdtempSync(join(tmpdir(), "moh-selfupdate-"))): string {
  const path = join(dir, "moh");
  writeFileSync(path, "#!/bin/sh\necho 'old moh'\n");
  chmodSync(path, 0o755);
  return path;
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    currentVersion: "0.1.0",
    execPath: fakeBin(),
    platform: "darwin-arm64" as const,
    io: { fetch: fetchMap(fakeReleaseUrls()) },
    ...overrides,
  };
}

const dirs: string[] = [];
function keep(path: string): string {
  dirs.push(dirname(path));
  return path;
}

describe("detectUpdatePlatform", () => {
  test("maps the build target vocabulary", () => {
    expect(detectUpdatePlatform("darwin" as NodeJS.Platform, "arm64")).toBe("darwin-arm64");
    expect(detectUpdatePlatform("darwin" as NodeJS.Platform, "x64")).toBe("darwin-x64");
    expect(detectUpdatePlatform("linux" as NodeJS.Platform, "x64")).toBe("linux-x64");
    expect(() => detectUpdatePlatform("win32" as NodeJS.Platform, "x64")).toThrow(/unsupported platform win32-x64/);
    expect(UPDATE_PLATFORMS).toEqual(["darwin-arm64", "darwin-x64", "linux-x64"]);
  });
});

describe("assetUrl / checksumFor / releasesUrl", () => {
  const release = { assets: [{ name: "moh-linux-x64", browser_download_url: "http://x/moh-linux-x64" }] };
  test("finds an asset by name, null when absent", () => {
    expect(assetUrl(release, "moh-linux-x64")).toBe("http://x/moh-linux-x64");
    expect(assetUrl(release, "moh-darwin-arm64")).toBeNull();
    expect(assetUrl({ assets: "nope" }, "moh-linux-x64")).toBeNull();
  });
  test("parses sha256sum format (binary marker tolerated)", () => {
    expect(checksumFor(`${"a".repeat(64)}  moh-linux-x64\n`, "moh-linux-x64")).toBe("a".repeat(64));
    expect(checksumFor(`${"a".repeat(64)} *moh-linux-x64\n`, "moh-linux-x64")).toBe("a".repeat(64));
    expect(checksumFor(`${"a".repeat(64)}  other\n`, "moh-linux-x64")).toBeNull();
  });
  test("MOH_RELEASES_URL overrides the endpoint", () => {
    process.env.MOH_RELEASES_URL = "http://localhost:9/releases/latest";
    try {
      expect(releasesUrl()).toBe("http://localhost:9/releases/latest");
    } finally {
      delete process.env.MOH_RELEASES_URL;
    }
    expect(releasesUrl()).toContain("api.github.com");
  });
});

describe("performSelfUpdate", () => {
  test("downloads, verifies, and atomically replaces the binary", async () => {
    const execPath = keep(fakeBin());
    const before = readFileSync(execPath, "utf8");
    const r = await performSelfUpdate(baseOptions({ execPath }));
    expect(r.status).toBe("updated");
    expect(r.message).toBe("updated moh 0.1.0 → 0.2.0");
    expect(readFileSync(execPath, "utf8")).not.toBe(before);
    expect(readFileSync(execPath, "utf8")).toContain("new moh 0.2.0");
    expect(readdirSync(dirname(execPath))).toEqual(["moh"]); // no temp leftovers
    expect((statSync(execPath).mode & 0o111) !== 0).toBe(true); // still executable
  });

  test("equal versions → up-to-date, nothing downloaded", async () => {
    const execPath = keep(fakeBin());
    const before = readFileSync(execPath, "utf8");
    const r = await performSelfUpdate(baseOptions({ execPath, currentVersion: "0.2.0" }));
    expect(r.status).toBe("up-to-date");
    expect(readFileSync(execPath, "utf8")).toBe(before);
  });

  test("downgrade from a non-stable build asks; refusal declines without touching the binary", async () => {
    const execPath = keep(fakeBin());
    const before = readFileSync(execPath, "utf8");
    let asked = null as string | null;
    const r = await performSelfUpdate(
      baseOptions({ execPath, currentVersion: "9.9.9", confirmDowngrade: (latest: string) => ((asked = latest), false) }),
    );
    expect(asked).toBe("0.2.0");
    expect(r.status).toBe("confirm-declined");
    expect(r.message).toContain("staying on 9.9.9");
    expect(readFileSync(execPath, "utf8")).toBe(before);
  });

  test("prerelease build of the same version still asks before replacing stable", async () => {
    const execPath = keep(fakeBin());
    const before = readFileSync(execPath, "utf8");
    const r = await performSelfUpdate(
      baseOptions({ execPath, currentVersion: "0.2.0-rc.1", confirmDowngrade: () => false }),
    );
    expect(r.status).toBe("confirm-declined");
    expect(readFileSync(execPath, "utf8")).toBe(before);
  });

  test("prerelease downgrade without a confirm callback declines (non-interactive default)", async () => {
    const execPath = keep(fakeBin());
    const r = await performSelfUpdate(baseOptions({ execPath, currentVersion: "9.9.9" }));
    expect(r.status).toBe("confirm-declined");
    expect(r.message).toContain("staying on 9.9.9");
  });

  test("downgrade with assumeYes proceeds", async () => {
    const execPath = keep(fakeBin());
    const r = await performSelfUpdate(
      baseOptions({ execPath, currentVersion: "9.9.9", assumeYes: true, confirmDowngrade: () => false }),
    );
    expect(r.status).toBe("updated");
    expect(r.message).toBe("updated moh 9.9.9 → 0.2.0");
  });

  test("checksum mismatch aborts without touching the current binary", async () => {
    const execPath = keep(fakeBin());
    const before = readFileSync(execPath, "utf8");
    const r = await performSelfUpdate(baseOptions({ execPath, io: { fetch: fetchMap(fakeReleaseUrls(NEW_BINARY, "0".repeat(64))) } }));
    expect(r.status).toBe("checksum-mismatch");
    expect(r.message).toContain("update aborted, binary untouched");
    expect(readFileSync(execPath, "utf8")).toBe(before);
  });

  test("missing checksums.txt entry aborts", async () => {
    const execPath = keep(fakeBin());
    const r = await performSelfUpdate(baseOptions({
      execPath,
      io: { fetch: fetchMap({ ...fakeReleaseUrls(), "/dl/checksums.txt": bytesRes(new TextEncoder().encode("nope\n")) }) },
    }));
    expect(r.status).toBe("checksum-mismatch");
  });

  test("release missing the platform asset → error", async () => {
    const release = jsonRes({ tag_name: "v0.2.0", assets: [{ name: "moh-linux-x64", browser_download_url: "/dl/x" }] });
    const r = await performSelfUpdate(baseOptions({ io: { fetch: fetchMap({ "/releases/latest": release }) } }));
    expect(r.status).toBe("error");
    expect(r.message).toContain("missing its moh-darwin-arm64 asset");
  });

  test("network failure on the release endpoint → error", async () => {
    const r = await performSelfUpdate(baseOptions({ io: { fetch: fetchMap({ "/releases/latest": new Error("down") }) } }));
    expect(r.status).toBe("error");
    expect(r.message).toContain("network error");
  });

  test("non-2xx release endpoint → error with status", async () => {
    const r = await performSelfUpdate(baseOptions({
      io: { fetch: fetchMap({ "/releases/latest": { ...bytesRes(new Uint8Array(), false), json: async () => ({}) } }) },
    }));
    expect(r.status).toBe("error");
    expect(r.message).toContain("HTTP 404");
  });

  test("asset download failure → error, binary untouched", async () => {
    const execPath = keep(fakeBin());
    const before = readFileSync(execPath, "utf8");
    const routes = fakeReleaseUrls();
    routes["/dl/moh-darwin-arm64"] = bytesRes(new Uint8Array(), false);
    const r = await performSelfUpdate(baseOptions({ execPath, io: { fetch: fetchMap(routes) } }));
    expect(r.status).toBe("error");
    expect(r.message).toContain("could not download");
    expect(readFileSync(execPath, "utf8")).toBe(before);
  });

  test("unsupported platform → unsupported-platform, no fetch", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const r = await performSelfUpdate(baseOptions({ platform: undefined, io: { fetch: fetchMap({}) } }));
      expect(r.status).toBe("unsupported-platform");
      expect(r.message).toContain("unsupported platform");
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });
});

// cleanup temp dirs
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("performSelfUpdate update-check cache refresh (#328)", () => {
  test("updated → cache refreshed with the installed version", async () => {
    const writes: [string, string][] = [];
    const r = await performSelfUpdate(baseOptions({
      mohHome: "/tmp/moh-home-328",
      io: { fetch: fetchMap(fakeReleaseUrls()), writeUpdateCache: (home: string, v: string) => writes.push([home, v]) },
    }));
    expect(r.status).toBe("updated");
    expect(writes).toEqual([["/tmp/moh-home-328", "0.2.0"]]);
  });
  test("cache write failure stays silent — still updated", async () => {
    const execPath = keep(fakeBin());
    const r = await performSelfUpdate(baseOptions({
      execPath,
      mohHome: "/tmp/moh-home-328",
      io: { fetch: fetchMap(fakeReleaseUrls()), writeUpdateCache: () => { throw new Error("no disk"); } },
    }));
    expect(r.status).toBe("updated");
    expect(readFileSync(execPath, "utf8")).toContain("new moh 0.2.0");
  });
  test("non-updated outcomes leave the cache untouched", async () => {
    const noWrite = (): never => { throw new Error("must not write"); };
    const cases = await Promise.all([
      performSelfUpdate(baseOptions({ currentVersion: "0.2.0", mohHome: "/tmp/x", io: { fetch: fetchMap(fakeReleaseUrls()), writeUpdateCache: noWrite } })), // up-to-date
      performSelfUpdate(baseOptions({ currentVersion: "0.3.0", mohHome: "/tmp/x", io: { fetch: fetchMap(fakeReleaseUrls()), writeUpdateCache: noWrite } })), // confirm-declined (no callback)
    ]);
    expect(cases.map((r) => r.status)).toEqual(["up-to-date", "confirm-declined"]);
    const mismatch = await performSelfUpdate(baseOptions({
      mohHome: "/tmp/x",
      io: { fetch: fetchMap(fakeReleaseUrls(NEW_BINARY, "0".repeat(64))), writeUpdateCache: noWrite },
    }));
    expect(mismatch.status).toBe("checksum-mismatch");
  });
  test("no mohHome → no cache write", async () => {
    const r = await performSelfUpdate(baseOptions({
      io: { fetch: fetchMap(fakeReleaseUrls()), writeUpdateCache: () => { throw new Error("must not write"); } },
    }));
    expect(r.status).toBe("updated");
  });
});

describe("performSelfUpdate onProgress (#351)", () => {
  test("happy path emits the full phase sequence with byte count", async () => {
    const events: SelfUpdateProgress[] = [];
    const r = await performSelfUpdate(baseOptions({
      onProgress: (p: SelfUpdateProgress) => events.push(p),
    }));
    expect(r.status).toBe("updated");
    expect(events).toEqual([
      { phase: "checking" },
      { phase: "downloading", receivedBytes: 0 },
      { phase: "downloading", receivedBytes: NEW_BINARY.byteLength },
      { phase: "verifying" },
      { phase: "installing" },
    ]);
  });

  test("up-to-date stops after checking", async () => {
    const events: SelfUpdateProgress[] = [];
    const r = await performSelfUpdate(baseOptions({
      currentVersion: "0.2.0",
      onProgress: (p: SelfUpdateProgress) => events.push(p),
    }));
    expect(r.status).toBe("up-to-date");
    expect(events).toEqual([{ phase: "checking" }]);
  });

  test("download failure emits checking + the downloading start only", async () => {
    const routes = fakeReleaseUrls();
    routes["/dl/moh-darwin-arm64"] = bytesRes(new Uint8Array(), false);
    const events: SelfUpdateProgress[] = [];
    const r = await performSelfUpdate(baseOptions({
      io: { fetch: fetchMap(routes) },
      onProgress: (p: SelfUpdateProgress) => events.push(p),
    }));
    expect(r.status).toBe("error");
    expect(events).toEqual([{ phase: "checking" }, { phase: "downloading", receivedBytes: 0 }]);
  });

  test("checksum mismatch emits verifying but never installing", async () => {
    const events: SelfUpdateProgress[] = [];
    const r = await performSelfUpdate(baseOptions({
      io: { fetch: fetchMap(fakeReleaseUrls(NEW_BINARY, "0".repeat(64))) },
      onProgress: (p: SelfUpdateProgress) => events.push(p),
    }));
    expect(r.status).toBe("checksum-mismatch");
    expect(events).toEqual([
      { phase: "checking" },
      { phase: "downloading", receivedBytes: 0 },
      { phase: "downloading", receivedBytes: NEW_BINARY.byteLength },
      { phase: "verifying" },
    ]);
  });

  test("downgrade confirmation sits between checking and downloading", async () => {
    const events: SelfUpdateProgress[] = [];
    const r = await performSelfUpdate(baseOptions({
      currentVersion: "9.9.9",
      assumeYes: true,
      onProgress: (p: SelfUpdateProgress) => events.push(p),
    }));
    expect(r.status).toBe("updated");
    expect(events.map((e) => e.phase)).toEqual(["checking", "downloading", "downloading", "verifying", "installing"]);
  });

  test("unsupported platform emits nothing", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const events: SelfUpdateProgress[] = [];
      const r = await performSelfUpdate(baseOptions({ platform: undefined, io: { fetch: fetchMap({}) }, onProgress: (p: SelfUpdateProgress) => events.push(p) }));
      expect(r.status).toBe("unsupported-platform");
      expect(events).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });
});
