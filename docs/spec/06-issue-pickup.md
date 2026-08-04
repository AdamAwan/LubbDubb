# 06 — Issue pickup and labels

## One label model

`src/watchLabels.ts` is the single source. An operator configures one `labelPrefix` (default
`"lubbdubb"`), from which two labels are derived:

- `${prefix}-watch` — "work this"
- `${prefix}-ignore` — "leave this alone"

`watchLabelsFor(prefix)` derives the pair. An **empty prefix yields empty labels**, which every gate
reads as "feature off": PRs are never excluded, issues are never watch-gated. That is the
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

The cockpit's per-row toggles write the tags back through outbound capabilities on the `ActionSink`
seam (`POST /api/prs/:n/exclude`, `POST /api/issues/:n/watch`). The issue toggle writes the pair —
adding one label and removing the other — so the two stay mutually exclusive. These are **label writes, not dispatcher actions**.

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
| `inReviewState`   | `issueInReviewState`         | The state rule `work-item-in-review` parks an item in.              |

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
parent issue. Re-applying the state gate there would be wrong, because rule `work-item-in-review` parks a decomposed item
in the review state for the life of its plan, which would stop the remaining parts ever being
scheduled.

## Priority

`issuePriority(labels, policy)` is pure: the **highest** weight among labels that match the scheme, or
`defaultPriority` when none match. Rule `issue-pickup` sorts eligible issues by weight descending, tie-breaking on
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
checked in the same order rule `issue-pickup` applies them, so it predicts what happens next cycle rather than
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
| `delivered` | Assessed as delivered — parked until the world or the operator says otherwise. |
| `assay`     | Its goal is being checked, or was found unworkable — nothing is dispatched for it. |
| `blocked`   | Eligible, but dispatch is paused or the cap is reached.                |
| `eligible`  | Would be picked up next cycle.                                         |

The `parts` arm is answered **before** the open-PR gate, and it has to be: a part's PR is on
`issue/<n>/<slug>`, but `linkedPrNumber` is sticky and will point at one, so the PR gate would report
"has open PR #n" for every mid-plan issue and hide the plan behind whichever part opened last. For a
decomposed issue the reason is `"<merged>/<total> parts merged"`, or — for a `complete` plan, which
never moves again on its own — `"plan complete — all N parts merged; close the issue or replan"`.

`IssuePickupContext` carries the same inputs rule `issue-pickup` consults: the policy, `DEFAULT_COOLDOWN`, the
world's `takenAt` as "now", tasks, the last 200 decisions, the **unfiltered** open PR list, the plan
graph, the planning policy, the standing delivery verdicts with the world transitions that may have
ended one, the standing goal assays with the same, the assay policy, and the current headroom /
paused flag.

The `delivered` arm is asked **after** `has_pr` and `active`, and that order is deliberate: a
delivered issue that somehow has an open PR is honestly `has_pr` — the PR rules own it — and one
with a live agent is honestly `active`. Saying "delivered" in either case would send the operator
looking in the wrong place.

The `assay` arm is asked **after** the intrinsic gates and **before** the plan funnel, which is
exactly where rule `issue-assay` sits: an unwatched or state-parked issue is never assayed, so reporting an
assay for one would promise something that cannot happen, while an assay that refused the goal is
the reason no planner and no pickup agent is coming. It covers both the standing hold (the
assayer's own words, quoted) and the pending case — `awaiting a goal assay`, `a goal assay is
running`, `goal assay on cooldown` — because an issue silently waiting a cycle for a verdict looks
exactly like an idle fleet.

## Rule `issue-pickup` in full

An issue is picked up when:

1. `issue.state === 'open'`, and
2. `openPrForIssue(issue, allOpenPrs) === null`, and
3. `isIssuePickupEligible(issue, policy).eligible`, and no standing `unclear` goal assay holds it
   (see below), and
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

`resolveIssueConclusion(stored, plan, shortfall)` (`src/issueConclusion.ts`, pure) folds one verdict —
`done` | `more_work` | `undeclared` — with this precedence:

1. **The operator's toggle** (`POST /api/issues/:number/conclusion`), which wins over everything,
   including a plan roll-up.
2. **A standing shortfall** — the assessor's "worked, and the goal is not reached".
3. **A plan in flight**: `planning`, `active` or `awaiting_approval` → `more_work`.
4. **The agent's declaration**, via the `conclude_work` tool.
5. **A `complete` plan** → `done`.
6. Otherwise `undeclared`. `single` and `abandoned` derive nothing — a `single` verdict describes the
   delivery's _shape_, not whether it has happened.

**Arm 3 sits above the declaration because ownership does.** The rule this module states — _the
verdict is asked of whoever owns the whole issue_ — used to be enforced by making the two arms
unreachable together: `conclusionOrigin` refuses the part agent, the planner and the assessor, so a
decomposed issue had no declaration to rank. A **replan is the one path that breaks that**. An issue
worked `single` has one agent, that agent declares `done`, and an accepted shortfall then flips its
plan to `planning` ([rule `issue-shortfall`](05-dispatcher.md#issue-shortfall--routing-a-failed-assessment)) — and with the
declaration ranked first, a spent verdict outranked the plan that had just taken the issue back. A
`complete` plan stays _below_ the declaration: an agent saying work remains on an issue whose parts
all merged is telling the roll-up something it cannot see, and `more_work` is the safe direction.

`planning` reads as in flight for the same reason. Both ways to reach it — a plan awaiting its
planner's verdict, and a replan — are unsettled decompositions, and nobody re-plans a finished goal.
An operator who did by mistake has arm 1, which outranks every derivation.

**`undeclared` is a distinct answer, not a synonym for `more_work`.** It is what a missing row
resolves to, it is never stored, and rule `work-item-back-to-pickup` acts only on an explicit `more_work` — so an issue
nobody has vouched for stays parked and is surfaced rather than re-picked. Folding the two would
re-open the failure this exists to close: a merged PR leaves the open list, `openPrForIssue` cannot
tell that from "there was never a PR", and the item would bounce back to a pickup state for rule `issue-pickup` to
put a fresh agent on work already on the default branch.

Only a **whole-issue origin** may declare (`conclusionOrigin`). `issue:<n>:part:<slug>`,
`issue:<n>:plan`, `pr:<n>:*` and `job:<id>` are refused, each with its own reason. That is
the structural half of _"done" means the issue is finished, not my slice of it_: a part agent has no
verdict to cast, because the plan roll-up already speaks for the issue.

Storage is the `issue_conclusions` table, keyed on the `issue:<n>` origin — one row per issue,
overwritten per declaration, and deliberately **not** hung off an agent row the way a `note_progress`
note is: a conclusion belongs to the issue and outlives every agent that touched it, including across
a replan. Clearing is a delete, so `undeclared` has exactly one representation.

**Nothing gates pickup on it.** `buildStateSnapshot` ships it per issue as `conclusion`, beside
`pickup`, and the cockpit draws a chip and a toggle; the only consumer that acts is rule `work-item-back-to-pickup` (see
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

## The delivery park (`delivered`)

The consequence above is exactly what this closes. `delivered` is the harness's **own** park, for
the providers that have no tracker park — rule `work-item-in-review`'s review-state hold, generalised off the tracker
onto a row the harness owns. It is written by rule `issue-assess`'s agent (see
[the dispatcher spec](05-dispatcher.md)) or by the operator, and unlike a conclusion **it gates
pickup**.

It is deliberately weaker than the tracker's `closed` and it is reversible:

- **`delivered`** — the harness believes it has done what it can. Its only effect is to stop pickup.
  **Not terminal.**
- **`closed`** — the human agrees. Tracker status, read never computed, and the only terminal one.

The gap between them is days of testing and sign-off, and that gap is the whole reason the state
exists.

### What ends it

`deliveryHold(delivery, issue, ctx)` (`src/delivery/delivery.ts`, pure) is asked in **two places off
the one predicate** — rule `issue-pickup`'s eligibility filter and `issuePickupStatus` — so the chip can never
promise what the next cycle refuses. Two arms, plus a third clearer that is deliberately not an arm:

1. **The issue is observed in a pickup state again.** The operator moved the ticket, and CLAUDE.md
   already promises that is the override. It cannot be a signal: `worldDiff` emits `issue_opened`,
   `issue_closed` and `issue_linked` and **nothing for a `workItemState` transition**. Reading the
   _current_ state is also sturdier — it survives a restart and a lost baseline, where an event
   between two pulses does not. Adding an `issue_state` event was considered and refused: it would
   make the verdict depend on the harness having witnessed the moment of the move.
2. **Any world transition on `issue:<n>` strictly after the verdict.** Issue #109 phase 4's
   rejection-expiry pattern, which covers the providers where arm 1 can never fire. "Any" rather
   than a per-kind list, for `expiringSignal`'s reason: a filter here would be a second opinion
   about which changes matter, sitting nowhere near the rule it second-guesses.
3. **The operator clears it** (`POST /api/issues/:number/delivered` with `{delivered: false}`). A
   delete, which is why it is not an arm — the absence of a verdict keeps exactly one
   representation.

**There is no timer arm.** The asymmetry with `proposalHold`'s accepted settle window is the point:
an accepted act waits on the world to _reflect_ something already done, which is a duration; a
delivered issue waits on it to _become_ something else, which is an event. A clock expiry would mean
"delivered for now", and re-picking work that was genuinely delivered is the failure this exists to
stop.

Expiry lifts the hold; it does not retract the verdict. The row stays, so the assessor's summary
remains readable as the last thing said about the issue.

### Why not a third `IssueConclusionVerdict`

A conclusion is declared once by the agent that did the work and **gates nothing**; a delivery
verdict is re-read by a gate every pulse and expires on world signal. Folding them would give
`resolveIssueConclusion` an expiring member its other two do not have, and would overwrite the
working agent's note with the assessor's. So `issue_deliveries` is a separate table — the same
argument [proposals](../../CLAUDE.md) made for a fresh table over columns on `escalations`.

The two are **mutually exclusive**: writing either clears the other, enforced in the store rather
than in a caller, because a caller that remembered one and forgot the other would leave rule `work-item-back-to-pickup`
returning an item to pickup while this gate held it. That exclusion, and every other one among the
four issue-verdict tables, is declared as data in `src/store/verdicts.ts` and applied by one internal
writer — see [14](14-persistence.md#issue-verdicts-and-the-exclusion-matrix).

## The shortfall — the same verdict's other polarity

An assessment's `more_work` writes `issue_shortfalls`, and the single most important thing about that
row is what it does to this document: **nothing**. It is not a pickup gate, it is not asked by
`issuePickupStatus`, and an issue carrying one is eligible exactly as if it carried nothing —
releasing work is the whole point of the verdict. Its one consumer is
[rule `issue-shortfall`](05-dispatcher.md#issue-shortfall--routing-a-failed-assessment), which routes what the assessor said
fell short.

That is why it is a **separate table** rather than a polarity column on `issue_deliveries`, and the
reason is stronger than the one that split deliveries from conclusions:

|              | `issue_deliveries`                                | `issue_shortfalls`                       |
| ------------ | ------------------------------------------------- | ---------------------------------------- |
| read by      | a gate, every pulse                               | one rule, until it is acted on           |
| effect       | **holds** pickup                                  | **releases** work                        |
| ends on      | world signal, tracker move, operator clear        | the arm it named being performed         |

One table with a `polarity` column would leave every present and future reader remembering which one
it was holding, from rows that look identical until you read a column — the drift class this repo has
already paid for twice (`proposalHold` vs `planProposalHold`; detection vs stripping in the PTY
scanner), and both times the fix was to keep the two predicates apart rather than give one a flag.
`test/issueShortfall.test.ts` asserts the split **structurally** — `src/delivery/delivery.ts` names no
shortfall type at all — as well as behaviourally, so a later polarity flag fails a test rather than
quietly holding an issue this row exists to free.

A shortfall and a delivery are mutually exclusive, for the reason a delivery and a conclusion are. A
shortfall and a **conclusion** are not: the conclusion is the working agent's own statement about its
own run and the assessor must never overwrite it, so both rows stand and `resolveIssueConclusion`
ranks them — operator toggle, then shortfall, then the agent, then the plan derivation. Both facts
are cells of the declared matrix in
[14](14-persistence.md#issue-verdicts-and-the-exclusion-matrix), where "clears nothing" is written
out rather than being an absent `DELETE`.

## The goal assay (`unclear`)

Every gate above asks about **policy**: the watch tag, the workflow state, the cooldown, the attempt
cap, headroom, `resolvePlanRoute`. None of them asks whether the ticket says anything an agent could
act on. So a vague, self-contradictory or already-obsolete issue goes straight into the funnel — with
`planning.enabled` the planner decomposes the vagueness and an operator is asked to approve the
decomposition of a question nobody could answer; with it off, rule `issue-pickup` puts an agent on it directly —
and the first signal that anything was wrong is an agent spending its attempt cap and escalating in a
way that reads as its own failure.

The goal assay (issue #158, `src/intake/assay.ts`, config `assay.enabled`, **on by default**) is
that missing gate. Rule `issue-assay` dispatches a code agent on `assay/issue/<n>` (origin `issue:<n>:assay`,
cut from the default branch) for a watched open issue nothing has been started for, and the agent
casts a verdict with the `assay_issue` tool. It is the mirror of the assessor: `hasPriorWork` is the
discriminator for both, one taking each arm — nothing started means the goal is all there is to
judge, something started means the question was answered by someone acting on it. "Started" means an
origin that could have delivered something, which is the pickup root, a plan's parts, or an
assessment — never the origins where the harness is merely deliberating (`:plan`, `:assay`). That
distinction lives in `issueOriginRole` (`src/issueOrigins.ts`); see
[`05-dispatcher.md`](05-dispatcher.md) for what counting a planner's own task as work cost.

| Verdict    | Effect                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------ |
| `workable` | None on scheduling. Stored so the assay is not asked again for this text.                  |
| `unclear`  | Holds the issue out of **both** rule `issue-plan` and rule `issue-pickup` while it stands. |
| _no row_   | Holds nothing. This is what a crashed, killed or capped assayer leaves behind.             |

### Block or inform, and why blocking is safe

It blocks — informing is what the cockpit already does for every other verdict, and would leave the
dispatch this exists to prevent happening anyway. Three things stop that becoming the most effective
way to stop the harness working:

- **Silence holds nothing.** Only an explicit `unclear` gates. An assayer that crashes or spends its
  attempt cap writes no row and the issue falls through to ordinary pickup, with **no escalation** —
  the planner's fail-open and the assessor's, for their reason. This is also
  `undeclared`-vs-`more_work` again: the harness acts on what was said, never on silence.
- **The hold expires on its own** (below).
- **The operator can clear or override it** (`POST /api/issues/:number/assay`), from either cockpit:
  the refused issue's row in `WorldSummary`, and the Goal Floor's refused-assay plate as a second
  entry point onto the same action ([17](17-cockpit.md)). Only a refusal draws the affordance — a
  `workable` verdict blocks nothing — and clearing is a distinct third option rather than the same
  toggle's other end.

### What ends a hold

`assayHold(assay, issue, ctx)` (pure) is asked in **two places off the one predicate** — rule `issue-pickup`'s
eligibility filter and `issuePickupStatus` — so the chip can never promise what the next cycle
refuses. Two arms, plus a clearer that is deliberately not an arm:

1. **The goal text changed.** The row stores `goal_ref`, a NUL-joined fingerprint of the title and
   body the verdict was cast against (`goalFingerprint`), taken from the *task* rather than re-read
   from the world — so an edit made while the assayer was running is not silently swallowed. A
   different fingerprint means the verdict describes a ticket that no longer exists: the hold ends
   and the issue is assayed again. This is #158's fourth requirement, and it could not be an event:
   `worldDiff` emits nothing at all for an edit, and adding one would make the verdict depend on the
   harness having witnessed the moment — so a ticket rewritten while it was down would stay parked
   forever.
2. **Any world transition on `issue:<n>` strictly after the verdict.** Issue #109 phase 4's
   rejection-expiry pattern again, and here it is what covers a human who answers the question in a
   **comment** rather than by editing the body.
3. **The operator clears it** (`{verdict: null}`) — a delete, which is why it is not an arm.

**There is no timer arm**, for `deliveryHold`'s reason: a refused goal waits on the world to *become*
something else, which is an event, not a duration. A clock expiry would re-ask a question whose
answer has not changed, at the price of an agent each time.

### The comment on the ticket

An `unclear` verdict is also asked as a question **on the item itself** — one living comment,
written through `IssueCommentCapable.upsertIssueComment` and edited in place, by `AssayDesk` on the
pulse beside the plan reconciler (issue #158's third decision). Without it a blocking gate would
refuse a ticket and tell only the cockpit, while the person who can end the hold in one edit is
usually not looking at it.

It is mechanical bookkeeping in the sense `set_work_item_state` and the plan status comment are — so
it is not auto-send gated and does not go through the proposal machinery, and what keeps that from
being a licence to chatter is the one-comment rule. It is written only when the body changes, the
comment ref is dropped when the ticket's text changes (a genuinely new question gets a new comment
rather than overwriting the record of the old one), and a hold that has ended is **retracted** on the
thread rather than left standing. It is the assay's only outbound act: nothing is closed, rejected,
labelled or edited.

Because it is the harness explaining, on somebody else's ticket, why it will not act, the operator
must be able to read it without opening the tracker: `/api/state` ships it as `issue.assay.commentRef`
— a canonical comment ref beside the verdict, resolved through `buildRefUrls` like every other link
(see [15](15-integrations.md#comment-refs)). The cockpit draws it on the issue row **beside** the two
assay overrides, never among them: those change the verdict, this only opens what was already said. A
verdict whose comment has not been written yet, and a provider that cannot build a URL, both draw
nothing.

### The watch gate

The assay applies only to issues that already pass the watch gate — it never filters an untagged
backlog. So it does second-guess an explicit operator signal, and is argued for on that basis: the
tag says *work this*, and the assay's answer is not *no* but *with what?*. A question, asked once,
that the operator ends by editing the ticket, replying to it, or clearing the verdict.

### Cost

With `planning`, `assessment` and `assay` all on, one issue can spend **three agents** before a line
of its work is written. All three are on by default and each is one switch away from off; the cost is named here rather
than discovered.
