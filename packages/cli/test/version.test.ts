import { describe, expect, test } from "bun:test";
import { main } from "../src/cli";

describe("moh --version", () => {
  test("prints the dev version and exits 0", async () => {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: any) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await main(["--version"]);
      expect(code).toBe(0);
      expect(out.join("")).toBe("0.1.0\n");
    } finally {
      process.stdout.write = write;
    }
  });

  test("-v is an alias", async () => {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: any) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await main(["-v"])).toBe(0);
      expect(out.join("")).toBe("0.1.0\n");
    } finally {
      process.stdout.write = write;
    }
  });

  test("rejects extra arguments", async () => {
    const err: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await main(["--version", "extra"])).toBe(2);
      expect(err.join("")).toContain("takes no arguments");
    } finally {
      process.stderr.write = write;
    }
  });
});
