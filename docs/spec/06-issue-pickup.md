# 06 — Issue pickup and labels

## One label model

`src/watchLabels.ts` is the single source. An operator configures one `labelPrefix` (default
`"lubbdubb"`), from which two labels are derived:

- `${prefix}-watch` — "work this"
- `${prefix}-ignore` — "leave this alone"

`watchLabelsFor(prefix)` derives the pair. An **empty prefix yields empty labels**, which every gate
reads as "feature off": PRs are never excluded, issues and stories are never watch-gated. That is the
escape hatch tests use.

`resolveWatchState(labels, {watchLabel, ignoreLabel, defaultWatched})` folds the precedence, and it is
total — it never throws:

1. An explicit **ignore** always wins.
2. Then an explicit **watch**.
3. Otherwise the type default.

The default differs by item type, and only the default differs:

| Type    | Default     | Meaning                                  |
| ------- | ----------- | ---------------------------------------- |
| PRs     | opt-**out** | Worked unless explicitly `-ignore`d.     |
| Issues  | opt-**in**  | Left alone unless explicitly `-watch`ed. |
| Stories | opt-**in**  | Left alone unless explicitly `-watch`ed. |

**There is no ingest filter.** Every open issue is fetched and displayed. The gate decides only what
is _acted on_.

Where each gate lives:

- **PRs** — `isPrExcluded(pr, ignoreLabel)` in `src/prHealth.ts`. `Harness.runCycle` filters excluded
  PRs out of the dispatch world.
- **Issues** — `isIssuePickupEligible` / `issuePickupStatus` in `src/dispatcher/issuePickup.ts`.
- **Stories** — `watchGateReason(labels, policy)`, the label half on its own (stories have no state
  gate or ownership refinement).

The cockpit's per-row toggles write the tags back through outbound capabilities on the `ActionSink`
seam (`POST /api/prs/:n/exclude`, `POST /api/issues/:n/watch`, `POST /api/stories/:id/watch`). The
issue and story toggles write the pair — adding one label and removing the other — so the two stay
mutually exclusive. These are **label writes, not dispatcher actions**.

## `IssuePickupPolicy`

Assembled once in `src/system.ts` from config and handed to whichever dispatcher is selected:

| Field             | From config                  | Effect                                                              |
| ----------------- | ---------------------------- | ------------------------------------------------------------------- |
| `watchLabel`      | derived from `labelPrefix`   | Opt-in gate. Empty = gate off.                                      |
| `ignoreLabel`     | derived from `labelPrefix`   | Explicit exclusion. Empty = gate off.                               |
| `requireOwnLabel` | `issuePickupRequireOwnLabel` | Read `labelsAddedByViewer` instead of `labels` for the watch check. |
| `priorityLabels`  | `issuePriorityLabels`        | Label → weight.                                                     |
| `defaultPriority` | `issueDefaultPriority`       | Weight when no label matches.                                       |
| `pickupStates`    | `issuePickupStates`          | Allowed provider-native workflow states.                            |
| `inReviewState`   | `issueInReviewState`         | The state rule 3b parks an item in.                                 |

A bare `new RuleDispatcher()` takes an empty policy, which means no gate and flat priority — the
act-on-everything behaviour unit tests rely on.

## Intrinsic eligibility

`isIssuePickupEligible(issue, policy)` returns `{eligible, reasons}` — pure over the issue and the
policy alone, and it collects _every_ blocking reason rather than short-circuiting, so the cockpit can
explain an untouched item:

1. **Ignore** — `ignored ("<label>")`. Wins over everything else.
2. **State gate** — only when `pickupStates` is non-empty **and** the issue carries a
   `workItemState`. Items with no native state bypass it entirely. A state matching `inReviewState`
   reports `in review`; any other non-listed state reports `state "<x>" not in pickup states`.
3. **Watch gate** — the issue must carry `watchLabel`. With `requireOwnLabel` on, the check reads
   `labelsAddedByViewer`, and an item tagged by someone else reports
   `watch label "<x>" not added by you` rather than `no watch label "<x>"`, so the operator knows
   which knob to turn. A provider that does not populate authorship leaves the field unset, so the
   gate fails closed.

`issueWatchGateReason(issue, policy)` is the **label half only** — ignore, then watch, and
deliberately **not** the state gate. It is what plan parts inherit: the tag is evaluated once on the
parent issue. Re-applying the state gate there would be wrong, because rule 3b parks a decomposed item
in the review state for the life of its plan, which would stop the remaining parts ever being
scheduled.

## Priority

`issuePriority(labels, policy)` is pure: the **highest** weight among labels that match the scheme, or
`defaultPriority` when none match. Rule 4 sorts eligible issues by weight descending, tie-breaking on
issue number for determinism.

## `openPrForIssue`

`openPrForIssue(issue, openPrs)` resolves whether an issue already has a PR. A PR matches when its
number equals `issue.linkedPrNumber` **or** its branch is `issue/<n>`; merged PRs are skipped.

Two things make this the correct gate:

- **`linkedPrNumber` is sticky** — it is the last PR that ever cross-referenced the issue, with no
  open/merged filter, so it stays set after that PR merges. Gating on it alone would retire an issue
  the first time any PR touched it, killing an issue that needs a second PR.
- **`openPrs` must be every open PR**, including the ones the `-ignore` tag hid from the dispatch
  world. Both real providers list only open PRs, so absence otherwise reads as "merged".

Not covered: a `prAuthor` filter narrows the provider's PR list, so a linked PR opened by someone else
is invisible here and reads as gone.

## The per-issue verdict

`issuePickupStatus(issue, ctx)` folds **every** gate — intrinsic and contextual — into one verdict,
checked in the same order rule 4 applies them, so it predicts what happens next cycle rather than
guessing. `buildStateSnapshot` attaches it to each issue as `pickup`, and the cockpit renders it as a
chip.

| Status      | Meaning                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `done`      | Closed.                                                                |
| `planning`  | In the plan funnel — a verdict is owed, or the issue split into parts. |
| `has_pr`    | An open PR resolves it; the PR rules own it now.                       |
| `active`    | A task on this origin is queued / running / waiting on you.            |
| `ignored`   | Carries the explicit ignore tag.                                       |
| `unwatched` | Not opted in, or parked by the state gate.                             |
| `cooldown`  | Attempted recently; waiting out the re-dispatch gap.                   |
| `escalated` | Attempt cap spent; parked on a human.                                  |
| `blocked`   | Eligible, but dispatch is paused or the cap is reached.                |
| `eligible`  | Would be picked up next cycle.                                         |

The `parts` arm is answered **before** the open-PR gate, and it has to be: a part's PR is on
`issue/<n>/<slug>`, but `linkedPrNumber` is sticky and will point at one, so the PR gate would report
"has open PR #n" for every mid-plan issue and hide the plan behind whichever part opened last. For a
decomposed issue the reason is `"<merged>/<total> parts merged"`, or — for a `complete` plan, which
never moves again on its own — `"plan complete — all N parts merged; close the issue or replan"`.

`IssuePickupContext` carries the same inputs rule 4 consults: the policy, `DEFAULT_COOLDOWN`, the
world's `takenAt` as "now", tasks, the last 200 decisions, the **unfiltered** open PR list, the plan
graph, the planning policy, and the current headroom / paused flag.

## Rule 4 in full

An issue is picked up when:

1. `issue.state === 'open'`, and
2. `openPrForIssue(issue, allOpenPrs) === null`, and
3. `isIssuePickupEligible(issue, policy).eligible`, and
4. its plan route resolves to `single` (always true with planning off), and
5. no active task holds `issue:<n>`, and
6. `dispatchVerdict` says `dispatch`.

It dispatches a **code** agent on branch `issue/<n>` with origin `issue:<n>`, prompted from the
`issue-pickup` template. On an `escalate` verdict it emits `escalate_to_human` from the
`issue-pickup-escalation` template instead.

## Concluding an issue

A work item parked in `inReviewState` is ambiguous: it sits there when work remains **and** when
everything is delivered and it is waiting on test. No provider field distinguishes the two, so the
harness keeps its own record of whether an issue is finished.

`resolveIssueConclusion(stored, plan)` (`src/issueConclusion.ts`, pure) folds one verdict —
`done` | `more_work` | `undeclared` — with this precedence:

1. **The operator's toggle** (`POST /api/issues/:number/conclusion`), which wins over everything,
   including a plan roll-up.
2. **The agent's declaration**, via the `conclude_work` tool.
3. **Derived from the plan**: `complete` → `done`, `active`/`awaiting_approval` → `more_work`.
   `single`, `planning` and `abandoned` derive nothing — a `single` verdict describes the delivery's
   _shape_, not whether it has happened.
4. Otherwise `undeclared`.

**`undeclared` is a distinct answer, not a synonym for `more_work`.** It is what a missing row
resolves to, it is never stored, and rule 3b acts only on an explicit `more_work` — so an issue
nobody has vouched for stays parked and is surfaced rather than re-picked. Folding the two would
re-open the failure this exists to close: a merged PR leaves the open list, `openPrForIssue` cannot
tell that from "there was never a PR", and the item would bounce back to a pickup state for rule 4 to
put a fresh agent on work already on the default branch.

Only a **whole-issue origin** may declare (`conclusionOrigin`). `issue:<n>:part:<slug>`,
`issue:<n>:plan`, `pr:<n>:*`, `story:*` and `job:<id>` are refused, each with its own reason. That is
the structural half of _"done" means the issue is finished, not my slice of it_: a part agent has no
verdict to cast, because the plan roll-up already speaks for the issue.

Storage is the `issue_conclusions` table, keyed on the `issue:<n>` origin — one row per issue,
overwritten per declaration, and deliberately **not** hung off an agent row the way a `note_progress`
note is: a conclusion belongs to the issue and outlives every agent that touched it, including across
a replan. Clearing is a delete, so `undeclared` has exactly one representation.

**Nothing gates pickup on it.** `buildStateSnapshot` ships it per issue as `conclusion`, beside
`pickup`, and the cockpit draws a chip and a toggle; the only consumer that acts is rule 3b (see
[the dispatcher spec](05-dispatcher.md)). Gating pickup directly would make a `done` verdict silently
veto an item the operator had deliberately moved back to a pickup state — the work-item state stays
the source of truth for pickup, which is also why moving the ticket in the tracker _is_ the override
and no signal-based expiry is needed.

A `more_work` verdict cast **by an agent** is appended to the next dispatched agent's prompt for that
issue (`outstandingWorkNote`), attributed and quoted so it does not read as the harness's own
instruction. Appended rather than filled into a template placeholder, for the reason a rejected
proposal's note is: an operator override omitting a new token would silently drop it.

Consequence worth knowing: on a provider with no work-item state machine (GitHub, the fake) a
conclusion is recorded and displayed but changes no dispatch — there is no review state to be parked
in, so there is no bounce-back to suppress.
