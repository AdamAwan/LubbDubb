/**
 * Minimal ANSI SGR parser for the drawer transcript.
 *
 * The transcript that reaches the drawer is already legible text (stream mode's
 * `renderBlocks`, or settled PTY text), never raw TUI bytes. The only escapes it
 * carries are the handful of SGR colour codes `renderBlocks` emits for tool
 * labels — cyan/gray/red/dim/reset — and PTY legible text carries none at all. So
 * we translate those into styled segments and drop every other escape. This is the
 * one xterm feature the HTML pane has to replace; kept pure so it's unit-tested
 * directly (`test/ansi.test.ts`).
 */
type AnsiColor = 'cyan' | 'gray' | 'red' | 'green';

export interface AnsiStyle {
  color?: AnsiColor;
  dim?: boolean;
}

interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

/** SGR foreground codes `renderBlocks` uses (90 = bright black → our "gray"). */
const FG: Record<number, AnsiColor> = { 31: 'red', 32: 'green', 36: 'cyan', 90: 'gray' };

// One SGR colour sequence (capturing its params), or any other CSI / two-byte
// escape (dropped). Order matters: the SGR alternative must come first.
// eslint-disable-next-line no-control-regex
const ESCAPE = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

/** Fold one `m` sequence's parameters into the running style. */
function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  const codes = params === '' ? [0] : params.split(';').map((p) => Number(p));
  let next: AnsiStyle = { ...style };
  for (const code of codes) {
    // Reset (0) clears everything; any later codes in the same run re-apply onto the cleared style.
    if (code === 0) next = {};
    else if (code === 2) next.dim = true;
    else if (code === 22) next.dim = false;
    else if (code === 39) next.color = undefined;
    else {
      const fg = FG[code];
      if (fg) next.color = fg;
    }
  }
  return next;
}

/**
 * Parse `input` into styled text segments, resuming from `start` so a streamed
 * delta that splits a colour run mid-sequence continues seamlessly. Returns the
 * segments plus the style in effect at the end, to thread into the next delta.
 */
export function parseAnsi(input: string, start: AnsiStyle = {}): { segments: AnsiSegment[]; end: AnsiStyle } {
  const segments: AnsiSegment[] = [];
  let style: AnsiStyle = { ...start };
  let last = 0;
  const push = (text: string) => {
    if (text) segments.push({ text, style: { ...style } });
  };
  ESCAPE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ESCAPE.exec(input)) !== null) {
    push(input.slice(last, m.index));
    last = ESCAPE.lastIndex;
    if (m[1] !== undefined) style = applySgr(style, m[1]); // an SGR colour sequence
    // otherwise a non-SGR escape: swallowed, no segment, no style change
  }
  push(input.slice(last));
  return { segments, end: style };
}

/** Space-separated CSS class list for a segment's style (`''` when unstyled). */
export function ansiClass(style: AnsiStyle): string {
  const classes: string[] = [];
  if (style.color) classes.push(`ansi-${style.color}`);
  if (style.dim) classes.push('ansi-dim');
  return classes.join(' ');
}
