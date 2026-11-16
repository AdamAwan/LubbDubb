# CLAUDE.md — `src/pets/`

Sharp edges for work under this directory, loaded when you read or edit a file here. It holds the
same genre as the root [`CLAUDE.md`](../../CLAUDE.md) — what breaks **silently** — which keeps the
documentation rule, the conventions and the edges that can be tripped from anywhere.

## Persistence

- **A one-shot id is never edited in place** — `VIVARIUM_RESET` in `src/pets/keeper.ts`, and every id a re-introduced
  `runOnce` is given. Changing one declares a _second_ pass, which every database that ran the first runs again on the
  next boot. A further pass is a further id, added deliberately. There is no `runOnce` right now: all three of its
  callers folded rows into the claim store and went with it, so the mechanism comes back with the next migration that
  needs it. → [22](../../docs/spec/22-pets.md#clearing-the-vivarium),
  [14](../../docs/spec/14-persistence.md#a-migration-that-must-run-once)
