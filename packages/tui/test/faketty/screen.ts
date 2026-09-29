/**
 * TypeScript port of the VT100 screen model in
 * `packages/tui/test/pty/harness.py` (class `Screen`, #1057 — T4 of the
 * #1052 chain, ADR-0057 step B). Semantics are kept byte-for-byte
 * equivalent: cursor movement (CUU/CUD/CUF/CUB), ED (0/1/2/3 — ED3 clears
 * scrollback), EL, CUP/CHA, CR/LF/BS/TAB, autowrap, SU/SD, IL/DL-style
 * L/M, RI, DECSTBM (cursor home only), alternate screen DECSET 1049
 * (main grid+cursor saved, scrollback preserved across the cycle), and
 * sync block DECSET 2026. SGR/OSC are consumed, never interpreted.
 *
 * Determinism deviation (documented, intentional): the Python model keeps
 * a 2-second staleness rule on open sync blocks (`lines()` falls back to
 * the live grid when a block stays open too long) because the harness
 * samples a live process in real time and a stale block can only mean a
 * parser bug. This model is deterministic and fed in whole scenarios, so
 * a sync block ALWAYS commits at its `?2026l` and the staleness fallback
 * branch does not exist: `lines()` mid-block returns the last committed
 * grid, exactly as the Python non-stale path does. No wall clock is read
 * anywhere in this module.
 *
 * Frame accounting (#1022 semantics) is ported as-is: `frames` (heights),
 * `windows` [(height, fullscreen?)], `maxFrameRows`, `fullscreenFrames`,
 * plus the mark/markEnd window used by the harness payload.
 */

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/;

interface Window {
	height: number;
	fullscreen: boolean;
}

function blankRow(cols: number): string[] {
	return new Array<string>(cols).fill(" ");
}

export class VtScreen {
	readonly cols: number;
	readonly rows: number;
	private grid: string[][];
	private scrollbackBuf: string[] = [];
	private row = 0;
	private col = 0;
	// Alternate screen (DECSET 1049).
	private altActive = false;
	private mainSaved: { grid: string[][]; row: number; col: number } | null = null;
	// Partial escape sequence split across writes.
	private pending = "";
	// Sync block (DECSET 2026): writes buffer into a shadow grid and commit
	// atomically at block close. Always closes; no staleness fallback.
	private syncActive = false;
	private syncGrid: string[][] | null = null;
	// Frame accounting (#1022).
	private framesBuf: number[] = [];
	private windowsBuf: Window[] = [];
	private maxFrameRowsVal = 0;
	private fullscreenFramesVal = 0;
	private markIndex: number | null = null;
	private markEndIndex: number | null = null;
	private frameTop: number | null = null;
	private frameBottom: number | null = null;
	private frameNewlines = 0;
	private frameErase = false;
	private frameClear = false;
	private frameTrailingNewline = false;

	constructor(cols: number, rows: number) {
		this.cols = cols;
		this.rows = rows;
		this.grid = Array.from({ length: rows }, () => blankRow(cols));
	}

	// ---- feeding -----------------------------------------------------------

	feed(data: string | Buffer): void {
		const text = typeof data === "string" ? data : data.toString("utf8");
		let buffer = this.pending + text;
		this.pending = "";
		// Feed until no more progress: a leftover tail is either a partial
		// escape sequence split across writes (kept as pending, exactly like
		// the Python harness) or a block boundary that only closes once the
		// matching closer arrives.
		this.feedText(buffer);
	}

	private feedText(text: string): void {
		this.pending = "";
		let i = 0;
		const n = text.length;
		while (i < n) {
			const ch = text[i]!;
			if (ch === "\x1b") {
				const rest = text.slice(i);
				const m = ANSI_RE.exec(rest);
				if (m && m.index === 0) {
					this.csi(m[0]);
					i += m[0].length;
					continue;
				}
				if (i + 1 < n && text[i + 1] === "]") {
					const end = text.indexOf("\x07", i); // OSC: skip to BEL
					if (end === -1) {
						this.pending = text.slice(i);
						return;
					}
					i = end + 1;
					continue;
				}
				this.pending = text.slice(i); // sequence split across writes
				return;
			}
			const code = text.codePointAt(i)!;
			if (ch === "\r") {
				this.col = 0;
			} else if (ch === "\n") {
				this.row += 1;
				this.scroll();
				// #1022: the frame's own line breaks are its height.
				this.frameNewlines += 1;
				this.frameTrailingNewline = true;
			} else if (ch === "\b") {
				this.col = Math.max(0, this.col - 1);
			} else if (ch === "\t") {
				this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
			} else if (code >= 0x20) {
				this.put(ch);
				if (code >= 0x10000) i += 1; // surrogate pair: skip low half
			}
			i += 1;
		}
		this.pending = "";
	}

	// ---- frame accounting --------------------------------------------------

	private touch(row: number): void {
		if (this.frameTop === null || row < this.frameTop) this.frameTop = row;
		if (this.frameBottom === null || row > this.frameBottom) this.frameBottom = row;
	}

	private openFrame(): void {
		this.frameTop = this.frameBottom = null;
		this.frameNewlines = 0;
		this.frameErase = false;
		this.frameClear = false;
		this.frameTrailingNewline = false;
	}

	private closeFrame(): void {
		let span = 0;
		if (this.frameTop !== null) {
			span = this.frameBottom! - this.frameTop + 1;
		}
		const { frameNewlines: newlines, frameErase: erase, frameClear: clear } = this;
		const trailing = this.frameTrailingNewline;
		this.openFrame();
		if (clear) {
			this.fullscreenFramesVal += 1;
			this.windowsBuf.push({ height: 0, fullscreen: true });
			return;
		}
		if (!erase && span === 0) return; // plain write, not a repaint
		// `output + '\n'` (log-update payload) carries one newline more than
		// the frame has rows; the fullscreen payload carries none.
		const height = Math.max(span, newlines + (trailing ? 0 : span > 0 || newlines > 0 ? 1 : 0));
		this.framesBuf.push(height);
		this.windowsBuf.push({ height, fullscreen: false });
		if (height > this.maxFrameRowsVal) this.maxFrameRowsVal = height;
	}

	// ---- terminal emulation ------------------------------------------------

	private scroll(): void {
		if (this.row >= this.rows) {
			if (!this.altActive) {
				this.scrollbackBuf.push(this.grid[0]!.join("").replace(/ +$/, ""));
			}
			this.grid.shift();
			this.grid.push(blankRow(this.cols));
			this.row = this.rows - 1;
		}
	}

	private put(ch: string): void {
		if (this.col >= this.cols) {
			// autowrap
			this.col = 0;
			this.row += 1;
			this.scroll();
		}
		this.touch(this.row);
		this.grid[this.row]![this.col] = ch;
		this.col += 1;
		this.frameTrailingNewline = false;
	}

	private csi(seq: string): void {
		// DECSET 2026: a repaint begins (h) / commits (l).
		if (/\x1b\[\?2026;?\d*h/.test(seq) && seq === seq.match(/\x1b\[\?2026;?\d*h/)?.[0]) {
			this.openFrame();
			this.syncActive = true;
			this.syncGrid = this.grid.map((r) => r.slice());
			return;
		}
		if (/\x1b\[\?2026;?\d*l/.test(seq) && seq === seq.match(/\x1b\[\?2026;?\d*l/)?.[0]) {
			this.closeFrame();
			this.syncActive = false;
			this.syncGrid = null;
			return;
		}
		const params = (seq.match(/\d+/g) ?? []).map(Number);
		const p1 = params.length > 0 ? params[0]! : null;
		const final = seq[seq.length - 1]!;
		if (final === "A") {
			this.row = Math.max(0, this.row - (p1 ?? 1));
		} else if (final === "B") {
			this.row = Math.min(this.rows - 1, this.row + (p1 ?? 1));
		} else if (final === "C") {
			this.col = Math.min(this.cols - 1, this.col + (p1 ?? 1));
		} else if (final === "D") {
			this.col = Math.max(0, this.col - (p1 ?? 1));
		} else if (final === "G") {
			this.col = Math.min(this.cols - 1, Math.max(0, (p1 ?? 1) - 1));
		} else if (final === "H" || final === "f") {
			const r = params.length > 0 ? params[0]! : 1;
			const c = params.length > 1 ? params[1]! : 1;
			this.row = Math.min(this.rows - 1, Math.max(0, r - 1));
			this.col = Math.min(this.cols - 1, Math.max(0, c - 1));
		} else if (final === "K") {
			const mode = p1 ?? 0;
			if (mode === 2) {
				// A repaint without sync markers delimits frames with
				// eraseLines: a full-line erase opens a fresh frame.
				if (this.frameErase && !this.syncActive) this.closeFrame();
				this.frameErase = true;
			}
			let start = this.col;
			let end = this.cols;
			if (mode === 1) {
				start = 0;
				end = this.col + 1;
			} else if (mode === 2) {
				start = 0;
				end = this.cols;
			}
			for (let c = start; c < end; c++) this.grid[this.row]![c] = " ";
		} else if (final === "J") {
			const mode = p1 ?? 0;
			if (mode === 3) {
				this.scrollbackBuf.length = 0;
				this.frameClear = true;
			} else if (mode === 2) {
				this.grid = Array.from({ length: this.rows }, () => blankRow(this.cols));
				this.frameClear = true;
			} else if (mode === 0) {
				for (let c = this.col; c < this.cols; c++) this.grid[this.row]![c] = " ";
				for (let r = this.row + 1; r < this.rows; r++) this.grid[r] = blankRow(this.cols);
			}
		} else if (final === "r") {
			// DECSTBM: no scroll regions in this model; cursor home suffices.
			this.col = 0;
		} else if (final === "M") {
			// Reverse index: scroll region above the cursor up by one.
			if (this.row > 0) {
				if (!this.altActive) {
					this.scrollbackBuf.push(this.grid[0]!.join("").replace(/ +$/, ""));
				}
				this.grid.shift();
				this.grid.splice(Math.max(0, this.row - 1), 0, blankRow(this.cols));
				this.row -= 1;
			}
			this.col = 0;
		} else if (final === "L") {
			const count = p1 ?? 1;
			for (let k = 0; k < count; k++) {
				this.grid.pop();
				this.grid.splice(this.row, 0, blankRow(this.cols));
			}
		} else if (final === "S") {
			// SU: push top rows out to scrollback.
			const count = p1 ?? 1;
			for (let k = 0; k < count; k++) {
				if (!this.altActive) {
					this.scrollbackBuf.push(this.grid[0]!.join("").replace(/ +$/, ""));
				}
				this.grid.shift();
				this.grid.push(blankRow(this.cols));
			}
		} else if (final === "T") {
			// SD: rows move down, blank row on top.
			const count = p1 ?? 1;
			for (let k = 0; k < count; k++) {
				this.grid.pop();
				this.grid.unshift(blankRow(this.cols));
			}
		} else if (final === "E" && seq.endsWith("E")) {
			this.row = Math.min(this.rows - 1, this.row + 1);
			this.col = 0;
			this.scroll();
		} else if (final === "h" && seq.startsWith("\x1b[?1049")) {
			if (!this.altActive) {
				this.mainSaved = { grid: this.grid, row: this.row, col: this.col };
				this.altActive = true;
				this.grid = Array.from({ length: this.rows }, () => blankRow(this.cols));
				this.row = this.col = 0;
			}
		} else if (final === "l" && seq.startsWith("\x1b[?1049")) {
			if (this.altActive && this.mainSaved) {
				this.grid = this.mainSaved.grid;
				this.row = this.mainSaved.row;
				this.col = this.mainSaved.col;
				this.mainSaved = null;
				this.altActive = false;
			}
		}
		// SGR (m), OSC and anything else: styling or unsupported → ignore.
	}

	// ---- reading -----------------------------------------------------------

	/** Physical screen rows, rstripped. Mid-sync-block returns the last
	 * committed grid (a real terminal displays the committed frame); the
	 * block always commits at close, so this never goes stale. */
	lines(): string[] {
		const grid = this.syncActive && this.syncGrid ? this.syncGrid : this.grid;
		return grid.map((r) => r.join("").replace(/ +$/, ""));
	}

	/** Native scrollback, rstripped (rows pushed out by overflow, RI, SU;
	 * suppressed while the alternate screen is active). */
	scrollback(): string[] {
		return this.scrollbackBuf.slice();
	}

	/** Marks the start of the watched window (harness `mark` step). */
	mark(): void {
		this.markIndex = this.windowsBuf.length;
	}

	/** Marks the end of the watched window (harness `markEnd` step). */
	markEnd(): void {
		this.markEndIndex = this.windowsBuf.length;
	}

	get counters(): {
		frames: number;
		windows: Window[];
		maxFrameRows: number;
		fullscreenFrames: number;
		framesAfterMark: number;
		maxFrameRowsAfterMark: number;
		fullscreenAfterMark: number;
	} {
		const start = this.markIndex ?? 0;
		const end = this.markEndIndex !== null ? this.markEndIndex : this.windowsBuf.length;
		const window = this.windowsBuf.slice(start, end);
		const rows = window.filter((w) => !w.fullscreen).map((w) => w.height);
		return {
			frames: this.framesBuf.length,
			windows: this.windowsBuf.slice(),
			maxFrameRows: this.maxFrameRowsVal,
			fullscreenFrames: this.fullscreenFramesVal,
			framesAfterMark: window.length,
			maxFrameRowsAfterMark: rows.length > 0 ? Math.max(...rows) : 0,
			fullscreenAfterMark: window.filter((w) => w.fullscreen).length,
		};
	}
}
