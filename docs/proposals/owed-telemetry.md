# Proposal — telemetry a plan depends on

**Status: under discussion.** Nothing here is built. It follows the validation page an operator answers
once ([36](../spec/36-remote-validation.md#the-ok)).

## The problem

A watch check is declared at plan time, but the log line or metric it reads is often added by the work
itself. Nothing makes sure a part is told to add it, or that it did. The dry run cannot tell — the line
does not exist until the change deploys — and today it refuses a signal whose presence finds nothing,
telling the planner to fix a query that is correct ([29](../spec/29-post-deploy-watch.md#the-dry-run)).
The gap shows up only after arrival, as a watch that never hears anything.

## Direction

- **The plan names who emits it.** A watch check reading telemetry the work adds names the part that
  adds it (`emittedBy`), and that part's acceptance carries the line.
- **The building and review agents are told**, by notes **appended** to their prompts, never
  interpolated. The building agent `watch_declare`s the exact line it emitted.
- **Nothing waits on it.** A merged part settles by merge; holding it would wedge its dependents with
  nothing red.
- **The validation page shows it**: _not seen yet, owed by part 2_.

## Known problems to settle first

From review of an earlier draft:

- `emittedBy` can only be proven where the new line is a **presence** (or count) query. For a failure
  signal, never seeing the line is what success looks like, so "not seen yet" never clears. Restrict
  `emittedBy` to presence and count queries; for signal lines rely on review.
- The dry run also refuses presence-fires / signal-zero (`src/environments/watchDryRun.ts`); the
  exemption must cover what an owed check reads before deploy, not only presence-zero.
- On an acceptance environment the path may never run, so "never seen" cannot be told apart from "no
  traffic here". Filing an `unknown` for it would flood the rail; decide where, if anywhere, it files.
- A goal-wide `watch_declare` proposal accepted on one environment's page changes what every
  environment's window reads; its consent must say so.
