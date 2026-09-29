import type { ReactElement } from "react";
import { render as inkRender } from "ink";
import { FakeStdout } from "./stdout";
import { FakeStdin } from "./stdin";
import { VtScreen } from "./screen";

/**
 * In-process Ink rendering over the fake TTY (#1057, T4 of #1052 / ADR-0057
 * step B). Uses ink's own `render` — not ink-testing-library — because the
 * tests need the raw byte stream Ink writes, and ink accepts injected
 * `stdout`/`stdin` options (verified against node_modules/ink/build/render.js:
 * { stdout, stdin, exitOnCtrlC, patchConsole, ... }; ink-testing-library
 * passes exactly stdout/stderr/stdin/debug/exitOnCtrlC:false/patchConsole:false).
 */

export interface FakeTerminal {
	screen: VtScreen;
	stdout: FakeStdout;
	stdin: FakeStdin;
	/** Writes bytes to the app's stdin (pilots `useInput`). */
	write(data: string | Buffer): void;
	resize(cols: number, rows: number): void;
	rerender(tree: ReactElement): void;
	unmount(): Promise<void>;
	/** Every raw byte Ink wrote, in order. */
	rawBytes(): Buffer;
	frames(): number;
	maxFrameRows(): number;
	fullscreenFrames(): number;
	/** Waits for Ink's render loop to drain. */
	settle(): Promise<void>;
}

export interface RenderOnFakeTtyOptions {
	cols?: number;
	rows?: number;
	stdout?: FakeStdout;
	stdin?: FakeStdin;
}

/**
 * Settle strategy: listen-on-quiescence, not a fixed sleep. Ink throttles
 * its render loop (animation frames + throttled writes), so a single
 * `setTimeout` is either too short (bytes still coming) or wastefully long
 * (idle app). Instead we poll: a tick where `stdout.byteLength` did not
 * grow over the previous tick means the loop has drained. Two consecutive
 * quiet ticks, bounded at ~2s, before giving up.
 */
const TICK_MS = 40;
const QUIET_TICKS = 2;
const MAX_TICKS = 50;

export function renderOnFakeTty(
	element: ReactElement,
	opts: RenderOnFakeTtyOptions = {},
): FakeTerminal {
	const cols = opts.cols ?? 100;
	const rows = opts.rows ?? 30;
	const stdout = opts.stdout ?? new FakeStdout({ cols, rows });
	const stdin = opts.stdin ?? new FakeStdin();

	// Like the Python harness on mid-run resize (it rebuilds its Screen —
	// "Ink fully repaints after SIGWINCH"), a resize swaps in a fresh
	// VtScreen of the new geometry; the raw byte stream stays the single
	// source of truth.
	let screen = new VtScreen(stdout.columns, stdout.rows);
	// Attach BEFORE inkRender: Ink's throttled render uses leading-edge
	// timing, so the first frame can be written synchronously inside
	// render() — a listener attached after would miss it.
	stdout.on("write", (buf: Buffer) => screen.feed(buf));

	const instance = inkRender(element, {
		stdout: stdout as unknown as import("node:tty").WriteStream,
		stdin: stdin as unknown as import("node:tty").ReadStream,
		exitOnCtrlC: false,
		patchConsole: false,
	});

	let unmounted = false;
	const unmount = async (): Promise<void> => {
		if (!unmounted) {
			unmounted = true;
			instance.unmount();
			instance.cleanup();
		}
		await settle();
	};

	function settle(): Promise<void> {
		return new Promise<void>((resolve) => {
			let last = stdout.byteLength;
			let quiet = 0;
			let ticks = 0;
			const timer = setInterval(() => {
				ticks += 1;
				const now = stdout.byteLength;
				if (now === last) {
					quiet += 1;
				} else {
					quiet = 0;
					last = now;
				}
				if (quiet >= QUIET_TICKS || ticks >= MAX_TICKS) {
					clearInterval(timer);
					resolve();
				}
			}, TICK_MS);
		});
	}

	return {
		get screen() {
			return screen;
		},
		stdout,
		stdin,
		write: (data) => {
			stdin.write(data);
		},
		resize: (c, r) => {
			stdout.columns = c;
			stdout.rows = r;
			// Swap the screen BEFORE emitting: Ink repaints synchronously
			// inside the resize emit (clear + full repaint), so those bytes
			// must land on the new geometry, not on the old one.
			screen = new VtScreen(c, r);
			stdout.emit("resize");
		},
		rerender: (tree) => {
			instance.rerender(tree);
		},
		unmount,
		rawBytes: () => stdout.rawBytes(),
		frames: () => screen.counters.frames,
		maxFrameRows: () => screen.counters.maxFrameRows,
		fullscreenFrames: () => screen.counters.fullscreenFrames,
		settle,
	};
}
