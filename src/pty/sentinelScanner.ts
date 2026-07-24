import { stripAnsi } from '../agents/streamTranscript.js';

/**
 * Escape-tolerant sentinel scanning over a raw PTY byte stream.
 *
 * The interactive claude TUI styles the line it prints a sentinel on, so escapes
 * arrive *inside* the token (`@@LUBB\x1b[0mDUBB_DONE@@`), not merely around it.
 * The session used to compensate by running detection over an ANSI-stripped copy
 * while the display path stripped the raw bytes — two matchers over two views of
 * the same stream, which disagree exactly when it matters: detection fired, the
 * strip missed, and the sentinel leaked into the transcript. Everything here
 * matches through the escapes instead, so both callers share one matcher and
 * cannot diverge.
 *
 * Spans are reported as *raw* offsets, not offsets into a stripped copy, because
 * the caller has to excise the exact byte range — interleaved escapes included —
 * from the stream it forwards to the terminal emulator.
 */

export type SentinelKind = 'done' | 'waiting' | 'flag';

/** The protocol tokens to scan for. Empty strings disable that sentinel. */
export interface SentinelSpec {
  done: string;
  waitPrefix: string;
  waitSuffix: string;
  flagPrefix: string;
  flagSuffix: string;
}

export interface SentinelHit {
  kind: SentinelKind;
  /** Raw start offset (inclusive) of the whole sentinel. */
  start: number;
  /** Raw end offset (exclusive). */
  end: number;
  /** Payload between prefix and suffix, escape-free. Empty for a bare `done` token. */
  payload: string;
}

// Escape forms `stripAnsi` recognises, as sticky matchers so they can be tried at
// an exact offset without slicing.
// eslint-disable-next-line no-control-regex
const ESC_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/y;
// eslint-disable-next-line no-control-regex
const ESC_C1 = /\x1b[@-Z\\-_]/y;

/** How far either side of a token to look for its boundary char, allowing for escape noise. */
const BOUNDARY_WINDOW = 64;
/** Raw-window slack when hunting a trailing partial token, so interleaved escapes still fit. */
const ESC_SLACK = 6;

/** Byte length of the escape sequence at `i`, or 0 if there isn't one. */
function escLen(hay: string, i: number): number {
  if (hay.charCodeAt(i) !== 0x1b) return 0;
  ESC_CSI.lastIndex = i;
  if (ESC_CSI.test(hay)) return ESC_CSI.lastIndex - i;
  ESC_C1.lastIndex = i;
  if (ESC_C1.test(hay)) return ESC_C1.lastIndex - i;
  return 0;
}

/** End offset (exclusive) of `token` matched at `i` ignoring interleaved escapes, or -1. */
function matchAt(hay: string, i: number, token: string): number {
  let p = i;
  for (const ch of token) {
    p += escLen(hay, p);
    if (hay[p] !== ch) return -1;
    p++;
  }
  return p;
}

/** First offset at/after `from` where `token` matches escape-tolerantly, or -1. */
function indexOfToken(hay: string, token: string, from: number): { start: number; end: number } | null {
  if (!token) return null;
  const first = token[0];
  for (let i = from; i < hay.length; i++) {
    if (hay[i] !== first) continue;
    const end = matchAt(hay, i, token);
    if (end !== -1) return { start: i, end };
  }
  return null;
}

/**
 * A sentinel boundary: buffer edge or whitespace, looked up through escapes. A
 * window of pure escape noise reads as a boundary — the escapes are styling, not
 * content, so they must not block a legitimate sentinel (the bug that made a
 * styled done sentinel undetectable).
 */
function boundedBefore(hay: string, start: number): boolean {
  const win = stripAnsi(hay.slice(Math.max(0, start - BOUNDARY_WINDOW), start));
  const ch = win[win.length - 1];
  return ch === undefined || /\s/.test(ch);
}

function boundedAfter(hay: string, end: number): boolean {
  const win = stripAnsi(hay.slice(end, end + BOUNDARY_WINDOW));
  const ch = win[0];
  return ch === undefined || /\s/.test(ch);
}

/** Every complete, boundary-guarded bare token (the `done` sentinel). */
function collectTokens(hay: string, token: string, kind: SentinelKind, out: SentinelHit[]): void {
  let from = 0;
  for (;;) {
    const m = indexOfToken(hay, token, from);
    if (!m) return;
    if (boundedBefore(hay, m.start) && boundedAfter(hay, m.end)) {
      out.push({ kind, start: m.start, end: m.end, payload: '' });
      from = m.end;
    } else {
      from = m.start + 1;
    }
  }
}

/** Every complete, boundary-guarded `prefix…suffix` span, payload escape-stripped. */
function collectSpans(hay: string, prefix: string, suffix: string, kind: SentinelKind, out: SentinelHit[]): void {
  if (!prefix || !suffix) return;
  let from = 0;
  for (;;) {
    const open = indexOfToken(hay, prefix, from);
    if (!open) return;
    if (!boundedBefore(hay, open.start)) {
      from = open.start + 1;
      continue;
    }
    const close = indexOfToken(hay, suffix, open.end);
    if (!close) return; // suffix not yet arrived — leave it for a later chunk
    if (!boundedAfter(hay, close.end)) {
      from = open.start + 1;
      continue;
    }
    out.push({
      kind,
      start: open.start,
      end: close.end,
      payload: stripAnsi(hay.slice(open.end, close.start)),
    });
    from = close.end;
  }
}

/**
 * Every complete sentinel in `hay`, ordered by position and non-overlapping. A
 * `done` token wins an overlap: the waiting/flag suffix is a bare `@@`, so an
 * unterminated prefix would otherwise claim the leading `@@` of a following done
 * token and swallow it.
 */
export function scanSentinels(hay: string, spec: SentinelSpec): SentinelHit[] {
  const hits: SentinelHit[] = [];
  collectTokens(hay, spec.done, 'done', hits);
  collectSpans(hay, spec.waitPrefix, spec.waitSuffix, 'waiting', hits);
  collectSpans(hay, spec.flagPrefix, spec.flagSuffix, 'flag', hits);
  const rank = (h: SentinelHit): number => (h.kind === 'done' ? 0 : 1);
  hits.sort((a, b) => a.start - b.start || rank(a) - rank(b) || b.end - a.end);
  const kept: SentinelHit[] = [];
  for (const h of hits) {
    const prev = kept[kept.length - 1];
    if (prev && h.start < prev.end) continue;
    kept.push(h);
  }
  return kept;
}

/** Remove each hit's raw span from `hay`. */
export function excise(hay: string, hits: SentinelHit[]): string {
  let out = '';
  let i = 0;
  for (const h of hits) {
    if (h.start < i) continue;
    out += hay.slice(i, h.start);
    i = h.end;
  }
  return out + hay.slice(i);
}

/**
 * Offset from which `hay` must be withheld because it may be the leading half of a
 * sentinel (`hay.length` = emit everything). Call with complete sentinels already
 * excised, so any prefix found here is by definition unterminated.
 *
 * `maxHold` bounds the wait for a missing suffix. Without it an agent that prints
 * a prefix it never closes — quoting the protocol back while *explaining* itself
 * is enough — withholds every subsequent byte forever and blacks the transcript
 * out for the rest of the run. Past the bound the prefix is taken as literal text
 * and released, and only a trailing partial token is still held.
 */
export function holdFrom(hay: string, spec: SentinelSpec, maxHold: number): number {
  let hold = hay.length;
  for (const pre of [spec.waitPrefix, spec.flagPrefix]) {
    const m = indexOfToken(hay, pre, 0);
    if (m && m.start < hold) hold = m.start;
  }
  if (hold < hay.length && hay.length - hold <= maxHold) return hold;
  return partialTailStart(hay, [spec.done, spec.waitPrefix, spec.flagPrefix]);
}

/** Start of the longest trailing run that is a proper prefix of some token, else `hay.length`. */
function partialTailStart(hay: string, tokens: string[]): number {
  const valid = tokens.filter((t) => t.length > 1);
  if (!valid.length) return hay.length;
  const maxLen = Math.max(...valid.map((t) => t.length)) - 1;
  const from = Math.max(0, hay.length - maxLen * ESC_SLACK);
  for (let i = from; i < hay.length; i++) {
    const run = stripAnsi(hay.slice(i));
    if (!run || run.length > maxLen) continue;
    if (valid.some((t) => t.length > run.length && t.startsWith(run))) return i;
  }
  return hay.length;
}
