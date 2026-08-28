#!/usr/bin/env bun
/** E2E harness (#274): fake GitHub Releases server for `moh update` e2e. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const asset = readFileSync(join(ROOT, "dist", "moh-darwin-arm64-e2e-asset")); // pre-swap target
const hasher = new Bun.CryptoHasher("sha256");
hasher.update(asset);
const hash = hasher.digest("hex");

const server = Bun.serve({
  port: 0,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/releases/latest") {
      return Response.json({
        tag_name: "v0.2.0",
        assets: [
          { name: "moh-darwin-arm64", browser_download_url: `http://localhost:${server.port}/dl/moh-darwin-arm64` },
          { name: "checksums.txt", browser_download_url: `http://localhost:${server.port}/dl/checksums.txt` },
        ],
      });
    }
    if (url.pathname === "/dl/moh-darwin-arm64") return new Response(asset);
    if (url.pathname === "/dl/checksums.txt") {
      const sum = process.env.BAD_CHECKSUM ? "0".repeat(64) : hash;
      return new Response(`${sum}  moh-darwin-arm64\n`);
    }
    return new Response("not found", { status: 404 });
  },
});
process.stderr.write(`${server.port}\n`);
if (process.env.PORT_FILE) writeFileSync(process.env.PORT_FILE, String(server.port));
setTimeout(() => process.exit(0), 120_000); // auto-stop after 2 min
await new Promise(() => {});
