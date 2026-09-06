// → docs/spec/10-agent-runtimes.md

export const DONE_SENTINEL = '@@LUBBDUBB_DONE@@';
const WAIT_PREFIX = '@@LUBBDUBB_WAITING:';
const WAIT_SUFFIX = '@@';
export const FLAG_PREFIX = '@@LUBBDUBB_FLAG:';
export const FLAG_SUFFIX = '@@';

export interface ParsedFlag {
  kind: string;
  label: string;
  ref: string;
}

export function stripSentinels(text: string): string {
  let s = text.split(DONE_SENTINEL).join('');
  s = stripDelimited(s, WAIT_PREFIX, WAIT_SUFFIX);
  s = stripDelimited(s, FLAG_PREFIX, FLAG_SUFFIX);
  return s;
}

function stripDelimited(s: string, prefix: string, suffix: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const start = s.indexOf(prefix, i);
    if (start === -1) {
      out += s.slice(i);
      break;
    }
    const end = s.indexOf(suffix, start + prefix.length);
    if (end === -1) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, start);
    i = end + suffix.length;
  }
  return out;
}

export function stripFlags(text: string): string {
  return stripDelimited(text, FLAG_PREFIX, FLAG_SUFFIX);
}

export function extractWaitingReason(text: string): string | null {
  const start = text.indexOf(WAIT_PREFIX);
  if (start === -1) return null;
  const from = start + WAIT_PREFIX.length;
  const end = text.indexOf(WAIT_SUFFIX, from);
  if (end === -1) return null;
  return text.slice(from, end).trim();
}

export function parseFlag(payload: string): ParsedFlag | null {
  const raw = payload.trim();
  if (!raw) return null;
  let kind: unknown;
  let label: unknown;
  let ref: unknown;
  if (raw.startsWith('{')) {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      kind = o.kind;
      label = o.label;
      ref = o.ref;
    } catch {
      return null;
    }
  } else {
    ref = raw;
  }
  if (typeof ref !== 'string' || !ref.trim()) return null;
  const cleanRef = ref.trim();
  const isUrl = /^https?:\/\//i.test(cleanRef);
  return {
    kind: typeof kind === 'string' && kind.trim() ? kind.trim() : isUrl ? 'link' : 'artifact',
    label: typeof label === 'string' && label.trim() ? label.trim() : basename(cleanRef),
    ref: cleanRef,
  };
}

export function extractFlags(text: string): ParsedFlag[] {
  const flags: ParsedFlag[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(FLAG_PREFIX, from);
    if (start === -1) break;
    if (!isBoundary(start === 0 ? undefined : text[start - 1])) {
      from = start + 1;
      continue;
    }
    const payloadAt = start + FLAG_PREFIX.length;
    const end = text.indexOf(FLAG_SUFFIX, payloadAt);
    if (end === -1) break;
    const flag = parseFlag(text.slice(payloadAt, end));
    if (flag) flags.push(flag);
    from = end + FLAG_SUFFIX.length;
  }
  return flags;
}

function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

function basename(ref: string): string {
  const parts = ref.split(/[\\/]/);
  return parts[parts.length - 1] || ref;
}
