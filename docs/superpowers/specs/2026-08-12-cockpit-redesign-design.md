# Cockpit redesign — the goal page and the queue

**Status:** design, approved in outline. Supersedes the Factory Floor as the cockpit's presentation
layer. Owns changes to [`docs/spec/17-cockpit.md`](../../spec/17-cockpit.md).

## Why

The Factory Floor draws the dispatcher's decision as a production line. It is internally consistent
and it is not what the operator's day looks like. Three complaints, in the order they were raised:

- **The metaphor is a translation step.** Belts, bays, silos and roboports have to be mapped back to
  agents, queue items and pull requests before a reading means anything.
- **Prominence is inverted.** The reading the operator opens the cockpit for — *what needs me* — is
  distributed across a status-bar gauge, a bench panel, a desk behind a click and a bot card on the
  line. The line itself, which is ambient, takes the widest tile.
- **It does not use the screen it is given.** The operator runs a 3440×1440 ultrawide and a laptop.
  The floor's full-bleed pictures need capping on one and scroll sideways on the other.

Underneath all three is one structural fault, and it is the one that decided this design:

> **An escalation is shown without the goal it is about.** Answering "Redis or Postgres?" requires
> the ticket, the plan, the part's siblings and what is waiting on it. Today none of that is on
> screen with the question, on either the desk or the bot card.

## What the cockpit is for

Ranked with the operator, and the ranking is the design's brief:

| Tier | Job | Contents |
| --- | --- | --- |
| 1 | Unblock the fleet | escalations, plan proposals, permissions, bench tasks, close-outs, recovery verdicts |
| 2 | Confirm the fleet is on the right work | live agents, goals in flight, PR court + CI, up-next and why it is held, cap, pulse |
| 3 | Drill into one thing | a goal's whole page, transcripts, plans, work graph, spend, yield, output, findings, shift log |
| 4 | Occasional | launch/schedule, settings, CI policy, prompts, fault log, ended shifts |

Two consequences worth stating because they reverse the current layout:

- **The drawn line is Tier 2 data with no picture.** Nothing is lost by rendering it as rows.
- **Spend, Yield and Output drop to Tier 3.** They are useful and they are not why the cockpit gets
  opened. They become numbers in the top bar that open their existing panels.

## Shape

Three surfaces, one shell.

```
┌──────────────────────────────────────────────────────────────────────┐
│ ident · Scan · Fleet cap            Spend Yield Output Findings ⚙    │  top bar
├───────────────┬──────────────────────────────────────────────────────┤
│ NEEDS YOU  6  │  Overview · Backlog · Work graph · Shift log         │
│ ┌───────────┐ │  ──────────────────────────────────────────────────  │
│ │escalation │ │                                                      │
│ │plan       │ │            the situation area                        │
│ │permission │ │      (overview · a goal page · backlog)              │
│ ├─ yours ───┤ │                                                      │
│ │bench      │ │                                                      │
│ │close-out  │ │                                                      │
│ └───────────┘ │                                                      │
└───────────────┴──────────────────────────────────────────────────────┘
```

### 1. The queue rail — "Needs you"

A permanent left column, ~360px, holding **every** blocking item in one list: escalations, plan
proposals, permission requests, bench tasks, close-outs and recovery verdicts. Six surfaces become
one.

- **Two groups, split on who is stopped.** *Blocking a bot* (an agent is parked; red stripe) above
  *Yours to do* (nobody is waiting on it; amber). This preserves the floor's one colour rule — red
  means an agent is parked on a question only you can answer — and it survives the merge intact,
  because a bench task genuinely blocks no agent.
- **Every row states what it is holding**, and that is the sort key within a group: "holding 3
  parts", "holding the whole goal", "holding 2 parts". A standalone ask draws no count rather than a
  zero, the rule the bench station already follows.
- **A row is a link to a goal, not to a modal.** See below.
- **At zero the rail collapses to a thin strip** rather than disappearing — a surface that vanishes
  when quiet is indistinguishable from one that broke, which is the floor's existing rule for the
  empty rack and the muted gauge.

### 2. The goal page — the centre of the redesign

**A queue row opens the goal it is about, with the ask pinned at the top of that goal's page.** This
is the fix for the structural fault above, and it is the design's one novel claim.

Order on the page, top to bottom:

1. **Goal header** — number, title, item type, workflow state, assay verdict, age, agent count,
   spend, parts merged. Controls: watch toggle, conclusion verdict, raise a bug, open the ticket,
   and dismiss the run where one is retained.
2. **The "Needs you" band** — every open ask *on this goal*, stacked, answerable in place. Red for
   asks blocking an agent, amber for the operator's own. A goal with two open asks draws two bands;
   a goal with none draws no band at all.
3. **The plan**, as waves left to right, each part carrying its status, its PR, its CI and its
   `scope`. Grouped *merged / now / held / not started*, so "holding 3 parts" is a thing the operator
   can see rather than a claim they are asked to believe.
4. **The ticket as it stood at pickup** — body and acceptance criteria, which is what a plan or an
   escalation is judged against.
5. **Pull requests for this goal**, with court and the CI scanner ladder.
6. **What has happened** — this goal's decisions and signals, filtered from the shift log by
   `subjectRef`.

A right-hand column at ≥1500px carries: agents on this goal now, the goal's spend split, the tail
(goal check → write-up → close the ticket), and the scratchpad.

**The goal page doubles as the supervision surface.** A goal with no ask is what the operator opens
to check the work is going the right way — the second of the two stated jobs, served by the same
page. It is therefore reachable from the Goals card on the overview as well as from the queue.

### 3. The overview

What is shown when no goal is selected: **Fleet**, **Goals in flight**, **Pull requests**, **Up
next**, **World signals**. Rows, not pictures.

- A goal row carries a **segment track** (merged / live / blocked / held / not started) rather than a
  drawn line. The line lives on the goal page.
- A PR row keeps the **court chip** and the **CI scanner ladder** — both are read off the server's
  verdict and neither is re-derived, which is the existing rule and is unchanged.
- **Up next states why each item is held** in the queue's own words, which the floor already does and
  which is the direct answer to "are we working on the right thing".

### 4. The backlog

A nav view, opened rather than always present, because triage is periodic. Four groups:

- **Watched** — what the harness will act on, with the toggle to drop one.
- **Blocked at intake** — an `unclear` assay quoted in the assayer's words, with the override beside
  it. Its own group because it is the one intake reading that *stops dispatch*; greyed inside
  Watched, it reads as a detail rather than as the thing preventing all work.
- **Unwatched** — the triage list. Container types render **disabled rather than absent**, since
  "cannot be picked up" is a fact worth seeing.
- **Ignored** — a tail, with un-ignore.

Assignment is a server-side filter (`workItemAssignedTo` for Azure; GitHub has no issue-assignee
filter today) and is explicitly **out of scope** — the view shows whatever the tracker returns.

### 5. What does not belong to a goal

Two blocking things are not goal-scoped, and forcing them onto a goal page would be a lie:

- **The recovery hold** is harness-wide — while it is up, no pulse runs and every goal is stale for
  the same reason. It is a **banner above the situation area**, at every width, which is where the
  floor already puts it and for the same reason.
- **Findings** are not blocking at all and are not goal-scoped. They keep their top-bar count and
  their own page.

## Layout at width

One DOM at every width; the arrangement is CSS alone, which is the floor's existing rule and is worth
keeping — a React tree per width costs a resize listener, a re-render per drag, and a second
definition of every boundary.

| width | arrangement |
| --- | --- |
| < 1100 | rail becomes a collapsible strip above; situation is one column |
| 1100–1499 | rail + situation; situation cards in two tracks |
| ≥ 1500 | rail + situation; goal page gains its right-hand column |
| ≥ 2000 | overview cards in four tracks |

**The plan's waves stack vertically below 1500px** rather than scrolling sideways. A horizontally
scrolling plan is the failure this redesign is a reaction to, and reproducing it in the new layout
would be the design arguing with itself.

## Architecture

The three-layer split is **kept exactly as it is**, and this is a replacement of the third layer
only:

| Layer | Path | Change |
| --- | --- | --- |
| Wiring | `web/src/cockpit/` | unchanged |
| Derivation | `web/src/view/viewModel.ts` | extended (below) |
| Presentation | `web/src/factory/` → `web/src/console/` | replaced |

Every invariant that survives the move, and each is load-bearing:

- **Presentation never imports `api.js`.** Every mutation stays enumerated on `CockpitActions`,
  pre-bound, so drawing code cannot grow a capability with no refusal rule behind it. The structural
  assertion in `test/factoryFloor.test.ts` moves to `test/console.test.ts` and is otherwise unchanged.
- **Shared components keep their refusal rules.** `EscalationCard`, `RecoveryPanel`, `HumanTaskActions`,
  `FindingsPanel`, `LaunchPanel`, `SchedulePanel`, `WorldSummary`, `FleetControl` and the buttons are
  **embedded, not redrawn**. The queue rail renders rows; the answer surfaces on a goal page are the
  shared components placed inside it, exactly as `BotCard` embeds `EscalationCard` today. The
  "Dismiss (rejects)" vs "Dismiss (denies)" distinction, the free-text refusal on a proposal, the
  permission verdict routing to `/permission` — one implementation each, wherever they are met.
- **Lenses stay out of `src/dispatcher/`.** The work graph, `buildStacks`, `prAttentionStatus`,
  `findings` and `overlaps` remain read-only views.
- **Nothing is derived in the browser that the server already decided.** `attention.status`,
  `ciVerdict`, `health.reasons`, `QueueItem.reason` and the assay summary are quoted, never parsed —
  the rule that keeps the cockpit from holding a second opinion about a decision made elsewhere.
- **Tokens on `:root` in `styles.css` stay the styling contract for shared components**, and nothing
  in the new presentation stylesheet targets a shared component's class.

### View-model additions

Four derivations, all pure, all in `viewModel.ts`, all off data already on the snapshot:

1. **`needsYou`** — the merged, ordered queue. One list of a discriminated-union row type over
   escalations, proposals, permissions, human tasks, close-outs and the recovery hold. Each row
   carries its group (blocking / yours), its subject goal where it has one, and its holding count.
2. **`holdingCount`** — how many live siblings a given ask is blocking. The bench station already
   derives this for a plan step off `planParts`; this generalises it to escalations and proposals.
3. **`goalPage(ref)`** — everything one goal's page draws, assembled from the snapshot: issue, plan
   parts, PRs, agents, spend, run, conclusion, human tasks, and the decisions whose `subjectRef`
   names it.
4. **`goalTrack`** — the overview's segment reading, folded by the same function the goal page's plan
   groups with, so the two cannot disagree about whether a part is held or merely not started.

Deriving the goal page from the existing snapshot is what keeps this a presentation change. **No new
route is required**, with one exception noted below.

## New behaviour, stated separately from re-arrangement

Most of this design is re-arrangement. Three items are genuinely new, and each is scoped as its own
piece of work:

1. **The goal page's activity list** needs decisions filtered by `subjectRef`. The field exists and
   the snapshot carries the decision log; if the log's retained window proves too short to be useful
   per goal, this becomes a route and is deferred rather than half-built.
2. **The overlap warning at plan-approval time** is **not adopted in this design.** `FileOverlap` is
   computed from observed writes by concurrently-live agents, so it structurally cannot see a plan
   that has not dispatched. Warning at approval would mean comparing a pending plan's part `scope`
   against live parts' `scope` — prose against prose, with no guarantee two planners describe the
   same area the same way. A comparison that misses is worse than none, because it would read as a
   clean bill. **Deferred to its own design.** The mockup shows it; the build does not.
3. **The queue's holding counts for escalations and proposals** are new derivations, cheap, and
   included.

## Non-goals

- **No visual theme is decided here.** The character is chosen separately against the built layout,
  through the token seam. The mockup's dark palette is a placeholder and carries no weight.
- **No change to any server behaviour, route, or store.** If one turns out to be needed, it is a
  separate change with its own spec update.
- **No assignee filtering.** A config concern, not a cockpit one.
- **The Factory Floor is deleted, not kept behind a flag.** Two presentations of one view-model is
  two things to keep in step, and the shared-component seam exists precisely so the presentation can
  be replaced rather than duplicated.

## Testing

At the existing seams, and the structural assertions carry over:

- `test/console.test.ts` replaces `test/factoryFloor.test.ts`: nothing under the presentation
  directory imports `api.js`; the queue rail renders every blocking kind; a goal page renders its
  asks above its plan; a goal with no ask draws no band; the recovery banner sits outside the
  situation area; a zero count mutes rather than removes.
- Unit tests for the four pure view-model derivations, `needsYou`'s ordering first among them.
- `test/wireContract.test.ts`, `test/workGraph.test.ts`, `test/stacks.test.ts` and
  `test/prAttention.test.ts` are untouched and must stay green — they are what proves this is a
  presentation change.

## Documentation

[`docs/spec/17-cockpit.md`](../../spec/17-cockpit.md) is rewritten in the same change. It is the
document that owns this behaviour, and roughly two thirds of it describes the Factory Floor
specifically. The invariants that outlive the floor — the layer split, the `CockpitActions` seam, the
shared/drawn split, the token contract, one-subject-once, the empty-surface rule, and red meaning one
thing — are restated as the new presentation's rules rather than deleted with it.

## Mockup

[`docs/superpowers/mockups/layout-a.html`](../mockups/layout-a.html) — the overview, a goal page with
two pinned asks (#142), a goal page whose ask is a plan approval (#147), and the backlog. Open it as
a file; the views switch on `:target`. It is a sketch of structure, not of styling, and two things in
it are knowingly not in this design: the per-part file counts (no such field exists — `scope` takes
their place) and the plan-time overlap warning (deferred, above).
