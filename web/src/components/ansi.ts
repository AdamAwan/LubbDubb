// → docs/spec/17-cockpit.md

type AnsiColor = 'cyan' | 'gray' | 'red' | 'green';

export interface AnsiStyle {
  color?: AnsiColor;
  dim?: boolean;
}

interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

const FG: Record<number, AnsiColor> = { 31: 'red', 32: 'green', 36: 'cyan', 90: 'gray' };

// One SGR colour sequence (capturing its params), or any other CSI / two-byte
// escape (dropped). Order matters: the SGR alternative must come first.
// eslint-disable-next-line no-control-regex
const ESCAPE = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  const codes = params === '' ? [0] : params.split(';').map((p) => Number(p));
  let next: AnsiStyle = { ...style };
  for (const code of codes) {
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
    if (m[1] !== undefined) style = applySgr(style, m[1]);
  }
  push(input.slice(last));
  return { segments, end: style };
}

export function ansiClass(style: AnsiStyle): string {
  const classes: string[] = [];
  if (style.color) classes.push(`ansi-${style.color}`);
  if (style.dim) classes.push('ansi-dim');
  return classes.join(' ');
}
