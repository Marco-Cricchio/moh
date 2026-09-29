import { EventEmitter } from "node:events";

/**
 * Fake stdin for in-process Ink rendering (#1057). Shape follows the Stdin
 * of ink-testing-library: `write(data)` makes the bytes readable — Ink's
 * `useInput` reads them through its 'readable'/'data' handling — so tests
 * can pilot keyboard input deterministically.
 */
export class FakeStdin extends EventEmitter {
	isTTY = true;
	private pending: Buffer | null = null;
	private rawMode = false;

	write(data: string | Buffer): boolean {
		this.pending = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
		this.emit("readable");
		this.emit("data", this.pending);
		return true;
	}

	read(): Buffer | null {
		const data = this.pending;
		this.pending = null;
		return data;
	}

	setRawMode(mode: boolean): unknown {
		this.rawMode = mode;
		return this;
	}

	get isRaw(): boolean {
		return this.rawMode;
	}

	setEncoding(): void {}
	setMaxListeners(): this {
		return this;
	}
	resume(): void {}
	pause(): void {}
	ref(): void {}
	unref(): void {}
}
