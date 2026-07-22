import headless from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import { PTY_COLS, PTY_ROWS } from './backend.js';

const { Terminal } = headless;

/**
 * The PTY-mode legibility seam — the counterpart of stream mode's
 * `renderBlocks`. The interactive `claude` TUI paints the screen with
 * cursor-addressed redraws (spinner animation, status line, input box), so the
 * raw byte stream is illegible once the escapes are stripped: every repaint
 * frame lands jammed together. Deleting escapes can't fix that; only *terminal
 * emulation* can, because the meaning of the bytes is "what the screen ends up
 * showing", not the bytes themselves.
 *
 * So each legible PTY session feeds its bytes into a headless xterm.js instance
 * sized like the real PTY, and the transcript is read back off the emulated
 * screen: buffer rows joined (wrapped rows re-joined into their logical line),
 * TUI chrome rows dropped, trailing blanks trimmed. Updates are debounced past
 * the repaint churn and diffed against what was already emitted — an extension
 * flows out as a plain `append` delta (the common case: content scrolling up),
 * and an in-place rewrite of already-emitted text becomes a full `replace`.
 */
export type TranscriptUpdate = { kind: 'append'; delta: string } | { kind: 'replace'; text: string };

export interface TerminalTranscriptOptions {
  /** Emulated screen size. Must match the real PTY's or cursor addressing garbles. */
  cols?: number;
  rows?: number;
  /** Quiet period after the last write before an update is emitted. */
  debounceMs?: number;
  onUpdate: (update: TranscriptUpdate) => void;
}

const DEFAULT_DEBOUNCE_MS = 200;
/** Emulator scrollback cap — bounds memory per live agent; older lines fall off the top. */
const SCROLLBACK_LINES = 5000;

/** Glyphs the claude TUI animates its spinner with. `●`/`⎿` (content markers) are deliberately absent. */
const SPINNER_GLYPHS = new Set([...'·✢✳✶✻✽∗*+']);
/** Box-drawing chars that start an input-box row. */
const BOX_STARTS = new Set([...'╭│╰']);

/**
 * Is this settled screen row TUI chrome (spinner, input box, shortcut hints)
 * rather than transcript content? Heuristic by necessity — the TUI doesn't mark
 * its chrome — so the patterns are kept conservative: content bullets (`●`,
 * `⎿`) and ordinary text never match.
 */
export function isTuiChromeLine(line: string): boolean {
  const t = line.trim();
  const first = t[0];
  if (!t || first === undefined) return false;
  if (t.includes('esc to interrupt')) return true; // spinner suffix, any frame
  if (BOX_STARTS.has(first)) return true; // input box border/row
  if (t.startsWith('? for shortcuts')) return true;
  if (t.startsWith('⏵') || t.startsWith('⏸') || t.includes('shift+tab to cycle')) return true;
  // A spinner frame without the interrupt hint: glyph-led and trailing ellipsis.
  return SPINNER_GLYPHS.has(first) && (t.includes('…') || t.includes('...'));
}

export class TerminalTranscript {
  private readonly term: HeadlessTerminal;
  // xterm parses writes asynchronously; chaining keeps reads behind every write.
  private pending: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private lastEmitted = '';
  private disposed = false;

  constructor(private readonly opts: TerminalTranscriptOptions) {
    this.term = new Terminal({
      cols: opts.cols ?? PTY_COLS,
      rows: opts.rows ?? PTY_ROWS,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true, // buffer access is a proposed API in headless builds
    });
  }

  /** Feed raw PTY bytes in; an update is emitted once the stream goes quiet. */
  write(data: string): void {
    if (this.disposed) return;
    this.pending = this.pending.then(() => new Promise<void>((resolve) => this.term.write(data, resolve)));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.emitPending(), this.opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** Flush now: wait out pending writes and emit any outstanding update (used at exit). */
  async settle(): Promise<void> {
    await this.emitPending();
  }

  /** The settled transcript as of the writes processed so far. */
  snapshot(): string {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      // Re-join hard-wrapped rows into their logical line so the transcript
      // doesn't inherit the PTY's column width.
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    const content = lines.filter((l) => !isTuiChromeLine(l));
    while (content.length > 0 && content[0]?.trim() === '') content.shift();
    while (content.length > 0 && content[content.length - 1]?.trim() === '') content.pop();
    return content.join('\n');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.term.dispose();
  }

  private async emitPending(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.pending;
    if (this.disposed) return;
    const next = this.snapshot();
    if (next === this.lastEmitted) return;
    const update: TranscriptUpdate = next.startsWith(this.lastEmitted)
      ? { kind: 'append', delta: next.slice(this.lastEmitted.length) }
      : { kind: 'replace', text: next };
    this.lastEmitted = next;
    this.opts.onUpdate(update);
  }
}
