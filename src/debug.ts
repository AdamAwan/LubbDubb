/**
 * Opt-in debug tracing, off unless `LUBBDUBB_DEBUG` is set in the environment.
 *
 * Exists for the "it works here but not on my machine" class of problem — most
 * concretely the file-events pipeline (hook → spool → drain → classify → chip),
 * whose every stage is best-effort and swallows its own failures by design, so a
 * silent no-op is otherwise invisible. When on, lines go to stderr with a scoped
 * prefix, mirroring the `[lubbdubb:error]` format so they interleave sensibly in
 * a headless run's logs.
 */
export function debugEnabled(): boolean {
  return !!process.env.LUBBDUBB_DEBUG;
}

/**
 * Emit one scoped debug line to stderr — a no-op unless {@link debugEnabled}.
 *
 * The message often carries agent-influenced values (a written file path, a hook
 * breadcrumb), so control characters are escaped before logging: a newline in a
 * path would otherwise let a crafted write forge a second, fake log line (log
 * injection). Escaping keeps every record to exactly one line.
 */
export function debugLog(scope: string, message: string): void {
  if (debugEnabled()) console.error(`[lubbdubb:debug:${scope}] ${sanitizeForLog(message)}`);
}

// Matches every ASCII control char (0x00–0x1F and 0x7F), newlines included. Built
// from an escaped string rather than a regex literal so the source carries no
// control bytes of its own.
// eslint-disable-next-line no-control-regex -- matching control chars is the whole point (we neutralise them)
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

/** Replace control chars with a visible `\xNN` escape, so a log line stays one line. */
function sanitizeForLog(value: string): string {
  return value.replace(CONTROL_CHARS, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
