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
 * Remove every fully-formed done and waiting (`PREFIX…SUFFIX`) sentinel from
 * `text`. Incomplete fragments are left in place — callers that stream across
 * chunk boundaries must withhold a trailing partial themselves; for the
 * line-delimited stream-JSON transport a sentinel always arrives whole inside a
 * single text block, so this is sufficient there.
 */
export function stripSentinels(text: string): string {
  const s = text.split(DONE_SENTINEL).join('');
  let out = '';
  let i = 0;
  for (;;) {
    const start = s.indexOf(WAIT_PREFIX, i);
    if (start === -1) {
      out += s.slice(i);
      break;
    }
    const end = s.indexOf(WAIT_SUFFIX, start + WAIT_PREFIX.length);
    if (end === -1) {
      out += s.slice(i); // no closing suffix yet — leave the fragment
      break;
    }
    out += s.slice(i, start);
    i = end + WAIT_SUFFIX.length;
  }
  return out;
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
