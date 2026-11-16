# CLAUDE.md — `src/pty/`

Sharp edges for work under this directory, loaded when you read or edit a file here. It holds the
same genre as the root [`CLAUDE.md`](../../CLAUDE.md) — what breaks **silently** — which keeps the
documentation rule, the conventions and the edges that can be tripped from anywhere.

## Agent runtimes

- **`PtySession.kill()` sets status `killed` _before_ signalling the process.** A synchronously
  delivered exit would otherwise be reclassified as `failed`, firing a terminal event.
- **`PtySession.send()` writes the text and its submitting carriage return as two separate writes**,
  `agentSubmitDelayMs` apart. A line editor folds one burst into a paste and treats a trailing CR as a
  literal newline. Test assertions look for the payload as its own write — do not re-glue them.
- **Sentinel matching goes through `src/pty/sentinelScanner.ts`, never `indexOf`.** A program that
  styles the line puts SGR escapes _inside_ the token; one matcher serves detection and stripping.
