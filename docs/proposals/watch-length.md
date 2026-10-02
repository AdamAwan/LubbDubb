# Proposal — watching for long enough

**Status: under discussion.** Nothing here is built. It follows the validation page an operator answers
once ([36](../spec/36-remote-validation.md#the-ok)).

## The problem

A watch window is a fixed time per environment (`watch.forMs`, 48 hours by default,
[29](../spec/29-post-deploy-watch.md#opening)). For a fix on a busy path that is plenty; for a weekly
job, or a path with little traffic, 48 hours shows nothing and the window settles having learned
nothing. An operator can set `forMs` to weeks today, but two things then go wrong:

- **Reads grow.** Signal and presence queries return one row per occurrence since arrival, so every
  reading of a three-week window ships three weeks of rows, and hits the thirty-second kill.
- **Readings pile up.** At the default interval three weeks is about 1,000 readings per check.

## Direction

- **Bounded reads.** Past 48 hours, read only since the previous reading, and judge the window on
  running totals per check rather than on the newest reading — today's verdict reads only the newest
  (`src/environments/watchVerdict.ts`), which on short slices flips presence to `unknown` and lets a
  regression clear itself. Totals live per check, not on `watch_windows`.
- **A slower cadence after 48 hours**, so long windows stay near 170 readings per check.
- **Ending on evidence, opt-in per environment.** The goal declares a `count` query (one number:
  how often the changed path ran) and a target; an environment that opts in ends the window when the
  target is met or at `forMs`. The time limit stays the environment's, for the reason 29 gives.

## Known problems to settle first

From review of an earlier draft:

- Reading "since the previous reading" loses telemetry ingested late, so a signal undercounts and reads
  falsely clean. Needs an overlap or an ingestion-lag allowance.
- A measure's baseline spans one `forMs`; capping it while the window grows breaks the "same span"
  rule in [29](../spec/29-post-deploy-watch.md#the-baseline-and-why-a-measure-is-not-trusted-without-one).
- `count` must be exempt from the tail refusal and from `scalarShaped`, and a stale count must never be
  shown as current.
- On an acceptance environment the target is never met; it must not opt in, and nothing should file
  because of it.
- Re-reading a settled window after a query edit: `Extend` already re-opens and re-reads, so a separate
  Re-read may not be needed at all.
