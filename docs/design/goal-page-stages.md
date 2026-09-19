# Design note — the goal page's stages

> **Not built.** This is a design conclusion reached on branch
> `claude/validation-checks-ui-trial-85891b` while trialling the validation surfaces in the demo
> cockpit. Nothing here is implemented beyond the partial trial described at the end. It is written
> down because the reasoning is the valuable part, and it is the kind of reasoning that gets
> re-derived badly. When it is built, the behaviour belongs in
> [17](../spec/17-cockpit.md#the-panes) and this note goes away.

## The problem

The goal page's tabs were `Ask · Plan · Merged · Shipped · Done`. Two complaints, both correct:

1. **`Merged` earns nothing.** `Plan` already reads `4/4 parts merged`. The tab named for the merge
   held the goal's validation checks — and a check is executed against the delivered goal, typically
   somewhere real, so the name described neither what was in the tab nor when it could be used.

2. **`Merged` and `Shipped` looked like two sets of tests.** They are not. A `check` row on an
   environment's sheet carries a Merged check's `sourceId`, and the run's outcome is written back
   onto that check as `resultBy: 'spec'`. One list, seen twice — the record, and a remote control for
   part of it.

A third, found while working through it: **`Done` cannot be last.** A post-deploy watch opens on an
arrival in production, which for most deployments happens *after* the work is closed. A tab called
Done with a live tab after it is a contradiction; a tab called Done holding the signals is a lie.

## Why a tab per environment is the wrong fix

The first instinct — drop `Merged`, give each environment a tab — does not survive contact:

- **There are no environment groups.** `EnvironmentConfig` is a flat ordered list (`name`, `at`,
  `health?`, `arrival?`, `watch?`, `validate?`). The order is the promotion order and that is all
  the structure there is.
- **Most deployments configure no environments at all**, and validation is always on. Per-environment
  tabs leave those deployments with nowhere to see their checks.
- **Some rows are never on a sheet.** `sheetRows` skips a declined check deliberately. Superseded,
  waived and deferred rows are not pressed. Nor is anything before the first arrival — the set is
  authored the moment the assessor says `delivered`, and the operator's accept/decline gate happens
  then, with no environment in sight.

## The conclusion — tabs are obligations, not places

An environment already declares what arriving there *means*, per environment and opt-in:

- `arrival.opens: EnvironmentGate[]`, where `EnvironmentGate = 'validate' | 'close_out'`
- a `watch` block, which opens a post-deploy watch window

A deployment that runs its checks on a test environment and watches telemetry in production
expresses exactly that today:

```jsonc
{
  "environments": [
    { "name": "test", "at": "…", "arrival": { "opens": ["validate", "close_out"] }, "validate": { … } },
    { "name": "prod", "at": "…", "watch": { "observe": "…" } }
  ]
}
```

So the tab row should be **the obligations, in the order they come due**, each naming the
environment that carries it — derived from config, never hard-coded:

| Tab        | Holds                                                     | Environment derived from                   |
| ---------- | --------------------------------------------------------- | ------------------------------------------ |
| `ask`      | the ticket                                                | —                                          |
| `plan`     | the plan, its parts, their pull requests, what has merged | —                                          |
| `validate` | the check set, the local run, the environment's sheet     | whichever declares `opens: 'validate'`     |
| `close`    | the close-out, the delivery, the part/environment matrix, the record | whichever declares `opens: 'close_out'` |
| `watch`    | the declared signals and the watch window's readings      | whichever declares a `watch` block         |

The row then reads as the operator's own sentence: *ask, plan, wait for a deployment to test,
validate on test, close, wait for a deployment to prod, watch*.

### How it degrades

This is the half that makes it generic rather than a second deployment's layout hard-coded:

| Configuration                            | What the row does                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| No environment opens `validate`          | `validate` still exists; its header says the checks are a person's, by hand or on a local run |
| No environment declares `watch`          | No `watch` tab                                                               |
| No environments at all                   | `validate` and `close` stand unqualified; no `watch`                          |
| Two environments open the same gate      | That tab carries a picker scoped to just those environments                   |
| An environment carries more than one gate | It is named on each tab it carries — the tabs are the obligations, and one place can owe several |

Ordering falls out of the environment list, which is already the promotion order, so a deployment
that watches before it closes gets its own order without the cockpit having an opinion.

### The record is not a stage

Spend, the tail, the transcripts, the reference material, and the settled check rows a sheet never
sees — declined, superseded, waived — are an archive, not a step. They fold into `close`, which is
when an operator starts reading them, rather than taking a tab of their own.

## What the trial branch actually changed

Partial, and deliberately so — fixtures and components only, no specs and no tests:

- `web/src/demo/fixtures.ts` — goal #395 populated as the maximal case: every `ValidationCheckState`,
  every `RemoteRowKind` and `RemoteRowOutcome`, three environments at three reach verdicts, a landing
  matrix with an unplaced stacked squash, a gate release, a watch window with clean / regressed /
  unknown, and two sheets.
- `merged` → `checks` as a first rename (superseded by `validate` above).
- `Shipped` given an environment picker over `Place.sheetEnvironment`, scoping the reach row, the
  watch and the sheet to one environment; the sheet card's own duplicate switcher suppressed.
- The part/environment matrix moved to the last tab, leaving its one-line account behind.

None of the tab ids above (`validate`, `close`, `watch`) are in the tree. The trial stopped at
`Ask · Plan · Checks · Shipped · Done`.
