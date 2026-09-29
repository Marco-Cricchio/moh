import "./ci-mask"; // BEFORE the ink import: is-in-ci snapshots the env at module load
import { describe, test, expect } from "bun:test";
import { createElement, type ReactElement } from "react";
import { Box, Text } from "ink";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { VtScreen } from "./screen";
import { renderOnFakeTty } from "./render";
import { hasPython, python3 } from "../pty/pty-runner";

const exec = promisify(execFile);

const COLS = 40;
const ROWS = 8;

// ---- scripted byte streams (shared by parity + accounting) ----------------

/** (i) A long paragraph whose wrapping pushes rows off-screen. */
function paragraphBytes(): string {
	const words = "the quick brown fox jumps over the lazy dog again and again until the viewport overflows past the physical screen edge and rows must spill into native scrollback".split(" ");
	let line = "";
	const parts: string[] = [];
	for (const w of words) {
		if (line.length + w.length + 1 > COLS) {
			parts.push(line + "\r\n");
			line = w;
		} else {
			line = line ? `${line} ${w}` : w;
		}
	}
	parts.push(line);
	return parts.join("");
}

/** (ii) Ink's clearTerminal cycle: ED2+ED3+CUP-home, then a sync-block repaint. */
function clearCycleBytes(rounds: number): string {
	let out = "";
	for (let r = 0; r < rounds; r++) {
		out += `\x1b[2J\x1b[3J\x1b[H`; // clearTerminal
		for (let i = 0; i < 5; i++) {
			out += `frame ${r} row ${i}\r\n`;
		}
		out += `\x1b[?2026h`; // sync begin
		for (let i = 0; i < ROWS + 3; i++) {
			out += `repaint ${r} line ${i}\r\n`;
		}
		out += `\x1b[?2026l`; // sync end
	}
	return out;
}

/** (iii) Alternate screen enter/leave cycles with content + scrollback. */
function altScreenBytes(rounds: number): string {
	let out = "main screen line one\r\nmain screen line two\r\n";
	for (let r = 0; r < rounds; r++) {
		out += `\x1b[?1049h`; // enter alternate screen
		out += `alt round ${r}\x1b[H\r\n`;
		for (let i = 0; i < ROWS + 2; i++) {
			out += `alt ${r} filler ${i}\r\n`; // pushes alt rows out (scrollback suppressed)
		}
		out += `\x1b[?1049l`; // leave — main grid + cursor restored
		out += `back on main after round ${r}\r\n`;
	}
	return out;
}

// ---- Python parity harness -------------------------------------------------

async function pythonScreen(data: Buffer, cols: number, rows: number): Promise<{ lines: string[]; scrollback: string[] }> {
	const dir = new URL("../pty", import.meta.url).pathname;
	const script = [
		"import json, sys",
		`sys.path.insert(0, ${JSON.stringify(dir)})`,
		"import harness",
		`s = harness.Screen(${cols}, ${rows})`,
		`s.feed_bytes(bytes(${JSON.stringify(Array.from(data))}))`,
		`print(json.dumps({"lines": s.lines(), "scrollback": s.scrollback_view}))`,
	].join("\n");
	const { stdout } = await exec(python3!, ["-c", script], { timeout: 30_000 });
	return JSON.parse(stdout);
}

function feedLocal(data: Buffer, cols = COLS, rows = ROWS): { lines: string[]; scrollback: string[] } {
	const s = new VtScreen(cols, rows);
	s.feed(data);
	return { lines: s.lines(), scrollback: s.scrollback() };
}

describe("fake-tty (#1057 T4)", () => {
	describe("parity with the Python harness on scripted byte streams", () => {
		const scenarios: Array<[string, Buffer]> = [
			["long paragraph with wrapping", Buffer.from(paragraphBytes(), "utf8")],
			["ED2+ED3+CUP-home clear cycle + sync-block repaints", Buffer.from(clearCycleBytes(3), "utf8")],
			["alternate screen enter/leave cycles", Buffer.from(altScreenBytes(3), "utf8")],
		];

		for (const [name, bytes] of scenarios) {
			test(`screen + scrollback match: ${name}`, async () => {
				if (!hasPython) return; // gated like the PTY suites

				const local = feedLocal(bytes);
				const py = await pythonScreen(bytes, COLS, ROWS);
				expect(local.lines).toEqual(py.lines);
				expect(local.scrollback).toEqual(py.scrollback);
			});
		}

		test("split feeds (sequences broken across writes) match single feed", () => {
			const bytes = Buffer.from(clearCycleBytes(1) + altScreenBytes(1), "utf8");
			const whole = feedLocal(bytes);
			const split = new VtScreen(COLS, ROWS);
			for (let i = 0; i < bytes.length; i += 7) {
				split.feed(bytes.subarray(i, i + 7));
			}
			expect(split.lines()).toEqual(whole.lines);
			expect(split.scrollback()).toEqual(whole.scrollback);
		});

		test("frame accounting: sync blocks count frames, ED3-in-block counts fullscreen", () => {
			const s = new VtScreen(COLS, ROWS);
			s.feed(Buffer.from(clearCycleBytes(2), "utf8"));
			const c = s.counters;
			expect(c.frames).toBe(2); // two sync blocks = two repaints
			expect(c.fullscreenFrames).toBe(0); // the ED3 runs BEFORE each sync-open, which opens a fresh frame — like Python
			expect(c.maxFrameRows).toBe(ROWS + 3); // one row per newline; trailing newline closes the frame
			// Ink's clearTerminal order: sync-open, then ED3, then content —
			// the clear flag survives to the close, so the block is fullscreen.
			const f = new VtScreen(COLS, ROWS);
			f.feed(`\x1b[?2026h\x1b[2J\x1b[3J\x1b[Hframe content\r\n\x1b[?2026l`);
			expect(f.counters.fullscreenFrames).toBe(1);
		});

		test("mark/markEnd window frames accounting like the harness payload", () => {
			const s = new VtScreen(COLS, ROWS);
			s.feed(Buffer.from(clearCycleBytes(1), "utf8"));
			s.mark();
			s.feed(Buffer.from(clearCycleBytes(2), "utf8"));
			s.markEnd();
			const c = s.counters;
			expect(c.framesAfterMark).toBe(2);
			// The pre-sync ED3 is dropped at sync-open (_open_frame resets the
			// flags without closing a frame) — Python-verified: the clear
			// outside a sync block is never counted, so the window holds only
			// the two 27-row sync repaints.
			expect(c.fullscreenAfterMark).toBe(0);
			expect(c.maxFrameRowsAfterMark).toBe(ROWS + 3);
		});
	});

	describe("smoke with real Ink", () => {
		test("renders hello fake tty and unmounts cleanly", async () => {
			const term = renderOnFakeTty(
				createElement(
					Box,
					{ flexDirection: "column" },
					createElement(Text, null, "hello fake tty"),
				),
				{ cols: COLS, rows: ROWS },
			);
			await term.settle();
			expect(term.rawBytes().length).toBeGreaterThan(0);
			expect(term.screen.lines().some((l) => l.includes("hello fake tty"))).toBe(true);
			expect(term.frames()).toBeGreaterThanOrEqual(1);
			await term.unmount();
			// A second settle after unmount must not grow the byte stream.
			const after = term.rawBytes().length;
			await term.settle();
			expect(term.rawBytes().length).toBe(after);
		});
	});

	describe("determinism", () => {
		test("same scripted scenario twice → byte-identical raw output", async () => {
			const tree = (): ReactElement =>
				createElement(Box, null, createElement(Text, null, "determinism probe"));
			const run = async (): Promise<Buffer> => {
				// Two independent instances of the same scenario (each render is
				// a fresh FakeStdout), not a comparison with itself.
				const term = renderOnFakeTty(tree(), { cols: COLS, rows: ROWS });
				await term.settle();
				const bytes = term.rawBytes();
				await term.unmount();
				return bytes;
			};
			const a = await run();
			const b = await run();
			expect(b.equals(a)).toBe(true);
		});
	});

	describe("hermeticity", () => {
		test("screen module never reads the wall clock", async () => {
			const src = await Bun.file(new URL("./screen.ts", import.meta.url)).text();
			// Strip comments first: the check is about code, not prose
			// (the staleness deviation is documented in the header).
			const code = src
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
			expect(code).not.toMatch(/\bDate\b/);
			expect(code).not.toMatch(/performance\./);
			expect(code).not.toMatch(/\btime\b/);
			expect(code).not.toMatch(/\bnow\b/);
		});
	});
});
