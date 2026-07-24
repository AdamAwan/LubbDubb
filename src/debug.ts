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
 * The message routinely carries agent-influenced values (a written file path, a
 * hook breadcrumb), so it's `JSON.stringify`d before logging: control characters —
 * a newline especially — are escaped, so a crafted value can't forge a second,
 * fake log line (log injection). The quotes it adds also delimit the message.
 */
export function debugLog(scope: string, message: string): void {
  if (debugEnabled()) console.error(`[lubbdubb:debug:${scope}] ${JSON.stringify(message)}`);
}
