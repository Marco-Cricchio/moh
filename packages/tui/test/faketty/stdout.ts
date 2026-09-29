import { EventEmitter } from "node:events";

/**
 * Fake stdout for in-process Ink rendering (#1057, T4 of #1052 / ADR-0057
 * step B). Shape follows the Stdout of ink-testing-library (the reference
 * for what Ink touches on a real stdout): an EventEmitter whose `write`
 * records bytes instead of shipping them to a terminal.
 */
export class FakeStdout extends EventEmitter {
	isTTY = true;
	columns: number;
	rows: number;
	colorDepth: number;
	/** True when the terminal accepts colors at all (hasColors in Ink). */
	hasColors = true;
	private chunks: Buffer[] = [];
	private _bytes = 0;

	constructor(opts?: { cols?: number; rows?: number; colorDepth?: number }) {
		super();
		this.columns = opts?.cols ?? 100;
		this.rows = opts?.rows ?? 30;
		this.colorDepth = opts?.colorDepth ?? 24;
	}

	get getColorDepth(): () => number {
		return () => this.colorDepth;
	}

	write(data: string | Buffer): boolean {
		// ONLCR (#1058, T5): a real PTY's termios translates bare `\n` to
		// `\r\n` before the terminal model sees it — the VtScreen in
		// `screen.ts` is a byte-for-byte port of the Python harness that
		// reads post-ONLCR bytes, so it treats a bare `\n` as newline-only
		// (column preserved). Ink writes bare `\n`; without the translation
		// every centered/indented row after the first drifts right. The
		// conversion lives here (the fake terminal device), NOT in the
		// screen model, so `rawBytes()` stays "what the terminal received"
		// exactly like a pty rawDump.
		const text = (Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8")).toString("utf8");
		const buf = Buffer.from(text.replace(/(?<!\r)\n/g, "\r\n"), "utf8");
		this.chunks.push(buf);
		this._bytes += buf.length;
		this.emit("write", buf);
		return true;
	}

	/** Every raw byte Ink produced, concatenated in write order. */
	rawBytes(): Buffer {
		return Buffer.concat(this.chunks);
	}

	get byteLength(): number {
		return this._bytes;
	}

	/** Drops recorded bytes (keeps counters coherent per scenario). */
	reset(): void {
		this.chunks = [];
		this._bytes = 0;
	}

	ref(): void {}
	unref(): void {}
}
