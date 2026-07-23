/**
 * The harness control sentinels an agent prints to announce its own state, plus
 * the pure helpers for detecting and stripping them. Both agent runtimes
 * ({@link PtySession} and {@link StreamJsonSession}) share these strings so the
 * protocol is defined in exactly one place.
 *
 * A "waiting" sentinel embeds a reason: `PREFIX<reason>SUFFIX`. A "done" sentinel
 * is a bare token. They are reserved control strings: detected for status
 * transitions *and* stripped from displayed output so they never leak into a
 * transcript.
 */
export const DONE_SENTINEL = '@@LUBBDUBB_DONE@@';
const WAIT_PREFIX = '@@LUBBDUBB_WAITING:';
const WAIT_SUFFIX = '@@';
/**
 * The generic "flag something to the cockpit" sentinel: `PREFIX<payload>SUFFIX`.
 * Unlike done/waiting it carries no status meaning — it just surfaces an artifact
 * (a design doc, a report, a link) an agent produced mid-run so the UI can link
 * to it. The payload is a bare ref (a worktree-relative path or an http(s) URL)
 * or a JSON object (see {@link parseFlag}). Shares the `@@` suffix, so it strips
 * and holds through the same machinery as the waiting sentinel.
 */
export const FLAG_PREFIX = '@@LUBBDUBB_FLAG:';
export const FLAG_SUFFIX = '@@';

/** A parsed flag: an artifact an agent surfaced. `kind`/`label` are cosmetic; `ref` is the pointer. */
export interface ParsedFlag {
  /** Free-form slug for grouping/iconography in the UI (e.g. "design", "report", "link"). */
  kind: string;
  /** Human-readable name; defaults to the ref's basename. */
  label: string;
  /** A worktree-relative path or an absolute http(s) URL. */
  ref: string;
}

/**
 * Remove every fully-formed sentinel (done, waiting, and flag — all
 * `PREFIX…SUFFIX`) from `text`. Incomplete fragments are left in place — callers
 * that stream across chunk boundaries must withhold a trailing partial
 * themselves; for the line-delimited stream-JSON transport a sentinel always
 * arrives whole inside a single text block, so this is sufficient there.
 */
export function stripSentinels(text: string): string {
  let s = text.split(DONE_SENTINEL).join('');
  s = stripDelimited(s, WAIT_PREFIX, WAIT_SUFFIX);
  s = stripDelimited(s, FLAG_PREFIX, FLAG_SUFFIX);
  return s;
}

/** Remove every complete `prefix…suffix` span, leaving an unterminated trailing fragment in place. */
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
      out += s.slice(i); // no closing suffix yet — leave the fragment
      break;
    }
    out += s.slice(i, start);
    i = end + suffix.length;
  }
  return out;
}

/** Remove only complete flag sentinels, preserving an unterminated trailing one so it can complete on the next chunk. */
export function stripFlags(text: string): string {
  return stripDelimited(text, FLAG_PREFIX, FLAG_SUFFIX);
}

/** Extract the reason from the first complete waiting sentinel, or null if there isn't one. */
export function extractWaitingReason(text: string): string | null {
  const start = text.indexOf(WAIT_PREFIX);
  if (start === -1) return null;
  const from = start + WAIT_PREFIX.length;
  const end = text.indexOf(WAIT_SUFFIX, from);
  if (end === -1) return null;
  return text.slice(from, end).trim();
}

/**
 * Parse a flag payload into a normalised {@link ParsedFlag}, or null if it's
 * empty/invalid. Two forms are accepted so the simple case stays terse:
 *   - a bare ref: `./design.html` or `https://…`
 *   - a JSON object: `{"kind":"report","label":"Cost model","ref":"out/r.html"}`
 * `ref` is required; a missing `kind` defaults to `link` for URLs else `artifact`,
 * and a missing `label` to the ref's basename.
 */
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
      return null; // looked like JSON but wasn't — don't silently treat braces as a path
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

/** Every complete, boundary-guarded flag sentinel in `text`, parsed. Ignores unterminated trailing fragments. */
export function extractFlags(text: string): ParsedFlag[] {
  const flags: ParsedFlag[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(FLAG_PREFIX, from);
    if (start === -1) break;
    // Boundary-guard the prefix so an echoed sentinel mid-token doesn't fire.
    if (!isBoundary(start === 0 ? undefined : text[start - 1])) {
      from = start + 1;
      continue;
    }
    const payloadAt = start + FLAG_PREFIX.length;
    const end = text.indexOf(FLAG_SUFFIX, payloadAt);
    if (end === -1) break; // suffix not yet arrived
    const flag = parseFlag(text.slice(payloadAt, end));
    if (flag) flags.push(flag);
    from = end + FLAG_SUFFIX.length;
  }
  return flags;
}

/** A sentinel boundary: start/end of the buffer, or a whitespace char. Mirrors {@link PtySession}'s guard. */
function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

/** Last path segment of a ref (handles both slash flavours), falling back to the whole ref. */
function basename(ref: string): string {
  const parts = ref.split(/[\\/]/);
  return parts[parts.length - 1] || ref;
}
