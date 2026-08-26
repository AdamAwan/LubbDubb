# 25 — Supply and the runway

`src/supply/runway.ts` is the lens. `src/supply/runwayDesk.ts` is the pulse's half of it.

Every other lens in the harness asks about one piece of work — whose turn a pull request is on, where
a goal's commit has got to, what a plan has left. This one asks about the **pipeline**: is there
anything left for the fleet to do, and if not, is the reason upstream of it.

It exists because both ways that pipeline fails are invisible. A fleet with nothing left to pick up
does not error, parks no agent and records nothing worth reading — it goes quiet, which is also what
a fleet between goals looks like, and what a fleet whose provider stopped answering looks like. A
fleet whose every goal is parked on a person looks identical from outside and is the same failure
from the other end: the fleet outrunning somebody's ability to _absorb_ work rather than to supply
it.

## The unit is time, never a count

"Fewer than three eligible issues" does not survive a changing `maxConcurrentAgents`. A three-wide
fleet on twenty-minute goals empties a five-deep backlog inside the hour; a one-wide fleet on
day-long goals is comfortable with two. So the reading is **how long until nothing is left for a slot
to take**:

```
supply  = inflight + queued                      (goals)
runway  = supply × medianLeadTime ÷ max(1, cap)  (minutes)
```

The median comes off `IssueRun`'s `startedAt → completedAt` ([13](13-jobs-and-tickets.md)), which is
the only span that already contains a goal's whole tail — the CI fixes, the review threads, the
assessment and the write-up that follow its pull request. Agent durations would miss all of it and
read a goal as twenty minutes of work when it occupies the fleet for three hours.

## The lead time is fleet time

That span is wall-clock, and wall-clock is the wrong quantity. It is padded with every hour the goal
spent parked on a **person** — a close-out nobody got to, a validation waiting until Tuesday, a
profile question asked at six on a Friday — plus the nights and weekends around them. A runway
computed from it tells an operator who does nothing for sixty-four hours that the fleet has
sixty-four hours of work, when the fleet runs dry long before that _because_ he did nothing. The
arithmetic is sound; the input is not.

So each completed run's calendar span has its **human holds** subtracted. What is left is how long
the goal occupied the fleet, which is what the drain is a drain of.

| Hold                | Evidence                                               |
| ------------------- | ------------------------------------------------------ |
| Close-out           | `human_tasks` `close_out`, `created_at → resolved_at`  |
| Validation          | `human_tasks` `validate`, same span                    |
| A step for a person | `human_tasks` `ask` **with a `part_id`**               |
| The profile gate    | `issue_appraisals`, `decided_at → profile_answered_at`\*\* |
| A standing delivery | `issue_deliveries`, `decided_at →` the end of the run  |
| An escalation       | `escalations`, `created_at → answered_at`              |

**The tail stays in.** This subtracts human-wait, never work. A CI fix, a review thread and a
write-up are all still inside the span, which is exactly why agent durations remain the wrong
substitute.

**\*\* The profile gate is the hold `appraisalHold` reports, and its span is closed or it is nothing.**
Two things follow, and both were once got wrong together. It is asked through `appraisalHold`
(`src/intake/appraisal.ts`) rather than re-tested here — the same pure function the pickup gate and the
`appraisal` bucket ask — so a gate the world has **released** is not a hold: a ticket rewritten since the
appraisal no longer fingerprints to what the appraiser read, and that is precisely how a goal with an
unanswered proposal comes to ship at all. And an **unanswered** proposal is subtracted as nothing
rather than run to the end of the run: it has no end, so clamped it erases the whole span of a goal
that demonstrably completed — the completion being the evidence the fleet was not held. The
open-ended treatment is spec'd for the standing delivery below and for nothing else.

**A `burn` row is not a hold**, and it is the one worth stating: a burn notice kills nothing
([18](18-observability.md)) — the expensive agent carries straight on while the row stands, so the
fleet is working through every minute of it. **An `ask` without a `part_id` is not a hold** either,
by `HumanTask`'s own rule ([13](13-jobs-and-tickets.md)): a standalone ask blocks nothing, because
the agent that filed it gets on with what it can. Only a part is a scheduling node the reconciler
holds work behind. **A `supply` row is never a hold**: this reading must not describe itself, the
same rule the debt count follows.

**The holds are unioned per goal before they are subtracted.** They overlap routinely — a delivery
hold and the close-out it caused cover the same afternoon — and adding them up would over-subtract,
which is the same bug pointed the other way.

**Every hold is clamped to the run it sits in**, so a close-out still standing three weeks after a
goal finished loses the median the minutes inside the run and not the weeks after it. A run whose
whole calendar span is covered by holds is **dropped from the median**, exactly as one with an
unreadable span is: zero minutes of fleet time is not evidence about how long the fleet works, it is
evidence that the hold rows are coarser than the run, and admitting it would drag the median towards
zero and leave a deployment permanently `thin` over a queue that is fine.

### Attributing an escalation

`escalations` has no `origin_ref`. Two keys in its context reach a goal and the lens tries both:
`context.originRef` (what the goal-work arms carry, folded from `issue:12:part:api` onto `issue:12`),
then `context.prNumber` against the run's own `linkedPrNumber` — which is all the merge and reply
arms have, and without it the longest waits on a deployment would be the ones that went
unsubtracted. An escalation **dismissed without an answer** is skipped: `dismissEscalation` stamps no
time, so when its hold ended is recorded nowhere.

It is read through `Store.listEscalationSpans` — four columns and two `json_extract`s — never
`listEscalations`, which is all-time and ships every settled item's transcript tail
([16](16-http-api.md)); the cockpit takes this reading on every refresh.

### What is not subtracted, and knowingly

- **A plan awaiting approval.** `plans` stamps `created_at`/`updated_at` and nothing for entering
  `awaiting_approval`, and by the time a run is complete its plan is `active` or `complete` — the
  span is not recoverable from a finished goal at all. The _live_ ones are still counted, as
  [latent supply](#the-second-direction).
- **Non-working hours.** Subtracting a calendar would be more accurate and would introduce a
  timezone and a schedule policy the harness does not have. Evidenced holds only.

Both leave a residual, and the residual is padding: the reading still errs **long**, never short,
which is the safe direction for a warning.

### Derived, never stored

The subtraction is recomputed from the tables on every read. A `held_ms` on `issue_runs` would be
faster and would need an additive `ALTER TABLE`, a `ColumnMigrations` entry and a one-time backfill
([14](14-persistence.md#migrations)) — three things that fail silently if any is omitted — to buy a
walk over a few hundred rows that the pulse and the snapshot already pay for `issue_runs` itself.
Worse, it would go stale: a hold answered after the run completed changes the answer, and a stored
column written once would not know.

**The drain is capacity, never the observed start rate.** The obvious estimator is how fast goals
have actually been starting, and it is the one estimator that cannot work: a starved fleet starts
nothing, so the observed rate falls towards zero, so the runway computed from it rises towards
infinity — the warning suppresses itself exactly when it is due. Capacity over median lead time is
self-consistent: it says how fast the fleet drains when saturated, which is the question.

**Median, never mean**, for the burn watch's reason ([18](18-observability.md)): one nine-day goal in
the history would drag a mean upward until a fleet with a fortnight of backlog reported a week of
runway.

## The buckets

There is no new taxonomy. `issuePickupStatus` ([06](06-issue-pickup.md)) already sorts every open
issue, and the lens re-reads that one function's answer — it never asks the world a second question
of its own, which is what stops it and rule `issue-pickup` coming to different conclusions about the
same issue.

| Bucket        | Pickup status                                      | What it means                                   |
| ------------- | -------------------------------------------------- | ----------------------------------------------- |
| **Inflight**  | `active` · `has_pr` · `planning`                   | The fleet is on it. Drains over time.           |
| **Queued**    | `eligible` · `blocked` · `cooldown` · `appraisal`\*    | Unstarted supply the fleet may take.            |
| **Reservoir** | `unwatched`                                        | Not supply. One watch write away from being it. |
| **Held**      | `escalated` · `delivered` · `retained` · `appraisal`\* | Parked on a person. The fleet cannot drain it.  |
| **Gone**      | `done`                                             | —                                               |

`blocked` is in **queued** and it is the healthiest number on the card: it means more work than
slots, which is the condition this whole module exists to keep a deployment in. A count that dropped
it would report a full backlog as a drought on precisely the fleet working hardest. `cooldown` is
supply that is coming back.

### \* Why `appraisal` is in two rows

`appraisal` is the one status that covers two opposite situations, and it must not be bucketed by name.
An issue the fleet has not appraised **yet** is ordinary unstarted supply — an appraiser is coming. One
an appraiser refused, or priced and left standing, is parked on a person. The lens separates them by
asking `appraisalHold` (`src/intake/appraisal.ts`), the same pure function the gate itself asks: a null hold
is the pending arm.

Read as held, **every freshly tagged issue would count as work nobody can do**, and a deployment
would look starved on the pulse after somebody filled its queue — which is the exact moment the
feature must stay quiet.

### The reservoir counts issues, and a container is a way in

A container (a Feature or an Epic — [06](06-issue-pickup.md)) is never dispatched at, so it is worth
nothing to the fleet on its own. But one watch write on it cascades to every descendant, so it is
worth reporting: `reservoirContainers` counts the unwatched ones **beside** the reservoir rather than
adding to it. Its children are already in the reservoir under their own numbers, and counting them
again through their parent would state the same stories twice.

## The states

Five, and the ordering is load-bearing:

1. **`starved`** — not paused, nothing queued, and `headroom > 0`. Slots are empty _now_.
2. **`dry`** — nothing queued. Every slot is full, but the next goal to finish finds nothing behind
   it.
3. **`unknown`** — fewer than `runway.minimumRuns` completed goals **with a measurable fleet-time
   span**, so there is no median.
4. **`thin`** — the runway is below the band (see [hysteresis](#hysteresis)).
5. **`healthy`** — above it.

**`starved` above `dry`**: any fleet with a free slot and an empty queue satisfies both, and
reporting the weaker one describes a fleet that is _about to_ go idle while it already has.

**Both above `unknown`**: they are observations about this instant and need no median. A deployment
two days old with two empty slots is genuinely starved, and withholding that until five goals have
completed would silence the warning for exactly the week it is most useful. `unknown` guards only the
arms that need a _duration_.

**The count `unknown` names is the median's own population**, not the raw completed count. `medianLead`
drops a run whose span is not finite and positive — a run covered end to end by holds, or one written
`complete` on its first sighting, where `started_at` and `completed_at` are the same instant — and
`RunwayReading.completedRuns` is what survived that, with `unmeasuredRuns` carrying what did not. It
has to be: a card saying "8 goals have completed; a median lead time is taken over more" beside a
`minimumRuns` of 5 contradicts itself, and an operator who reads the two together can only conclude the
gauge is broken. Naming both counts instead — "3 of 11 completed goals left fleet time to measure" — is
the one diagnosis of a runway that has gone permanently dark, which is the state a deployment that
adopted a repository full of already-closed tickets is in on its first day.

**`unknown` is not folded into anything**, on the reach verdict's grounds
([24](24-environments.md#the-three-verdicts)): a deployment two days old and one that has run dry
present identically to anything that rounds "cannot say" down to "nothing left".

**`idleSlots` comes off the pulse's own headroom**, never `cap − inflight`. They are different
questions and only one is about slots: a goal with an open pull request is in flight and holds no
agent, so counting goals would report a fully-staffed fleet as having spare capacity.

### There is no sixth state

The obvious sixth is the fleet idle because everything is parked on a person. It is not a state: it
is `starved` with the sentence rearranged, because the fleet is in precisely the same condition and
only the reason differs. A state whose whole content is which clause leads the detail would double
the machine to say what the wording already says.

## The second direction

What the bench holds splits three ways, by what answering a row actually does:

| Split             | Rows                                                        | Answering it…                             |
| ----------------- | ----------------------------------------------------------- | ----------------------------------------- |
| **Latent supply** | plans awaiting approval · profile gates · `escalated` goals | puts work **back in the fleet**.          |
| Stalled inflight  | escalations · permissions · usage-limit parks               | restores throughput; supply is unchanged. |
| Human debt        | close-outs · validations · bench asks                       | returns nothing to the fleet.             |

**Latent supply leads the sentence** on every arm that means the fleet has stopped. Telling an
operator with three plans awaiting approval to go and find more work would be wrong twice over: there
is work, and they are the reason it is not moving. The headline becomes _"The fleet is waiting on
you, not on work"_ and the detail names what answering would release.

**Debt is never a threshold.** The queue rail already draws all twelve close-outs as twelve rows —
"you have 12 close-outs" is not news, it is on screen. Debt earns a trailing clause when it explains
a starved fleet and nothing else. It is counted off `listAllHumanTasks`, which is deliberately
unbounded where the panel's feed takes a limit: this is a count, and a cap would report a hundred to
the deployment furthest behind and to the one exactly at the cap alike. `supply` rows are excluded —
the reading must not describe itself.

That read returns **every** row, settled ones included, and one list rather than an open one beside a
closed one: the open rows are this count, the settled rows are the [human holds](#the-lead-time-is-fleet-time)
the median lead time subtracts. Two lists of one table, either a subset of the other, would be a
caller free to report a debt the history beside it does not contain.

## What it files

A `supply` human task ([13](13-jobs-and-tickets.md)), on `SpendBurnDesk`'s terms: store-only, it
dispatches nobody, holds nothing, and no rule reads what it writes. `healthy` and `unknown` file
nothing.

Joining the bench is what gets the notification for free — `NeedKind` gains `supply`, and
`notify.ts` diffs the rendered needs-you queue by row id ([17](17-cockpit.md)). Its tone is **amber**
and its group is **yours**: a gate rather than a fault, and no agent is parked on it.

**Exactly one open row, and a state change replaces it.** `recordHumanTask` dedups on the title, so a
row whose wording changed is a _new_ row rather than a refreshed one.

**Which is why the title is a function of the state alone, and every figure lives in the detail.**
The title is both that dedup key and the identity the notification chain diffs on, so a headline
carrying the runway or the idle-slot count settles the row and files a new one every time the queue
moves by one issue — a fresh banner per pulse on a fleet that never left the band, and then, once
every wording in range has been spent, silence for good. That is exactly the flap `validateRunwayPolicy`
refuses a `clearHours` at or below `warnHours` to prevent, reintroduced through the wording. So there
is one title per state — two for the latent/non-latent split, which is a different thing to say and
not the same thing with a different number in it — and the cockpit's band draws its figures off the
`RunwayReading` fields directly rather than off the sentence. That is what the notification
chain needs — a standing row is already in the previous snapshot and cannot re-announce, so
`thin → dry` gets one further banner and nothing else does — and it is also what makes settling the
old one obligatory, since leaving both would put two rows describing one fleet on the bench.

A row the operator has already **answered** is not raised again under the same wording. A row
standing under the same wording _is_ re-filed, so `recordHumanTask`'s refresh keeps its figures
current without moving its id.

**The desk's own settlements are not answers**, and the clause above is scoped to the operator for
that reason. The desk settles its rows on every state change, and a superseded row is `status: 'done'`
exactly like an answered one — so reading "settled" as "answered" turns _exactly one open row_ into
_at most one row, ever_: the first time the fleet passes through a state that wording is spent, and
`starved → healthy → starved` files nothing the second time. Every deployment would get one starvation
warning and one dry warning in its life, and after that the fleet goes quiet with nothing saying so,
which is the failure the module exists to break. So the desk marks its own settlements, tells them
apart from an operator's, and **reopens** its own row when the state comes round again. Reopening is a
write of its own (`Store.reopenHumanTask`) rather than a second file: `recordHumanTask`'s dedup ignores
status deliberately — an agent repeating itself must not resurrect a task a person declined — so filing
over a settled row refreshes its detail and leaves it `done`, which is this same bug from underneath.
A row the operator has **dismissed** off the bench is reopened along with the rest, and `dismissed_at`
clears with it: dismissing says "I have read this record and am done with it", which is true of the
episode it recorded and says nothing about the next one, and leaving it hidden is the same silence
again. `created_at` moves with it: the bench draws newest-first under a hundred-row cap, so a reopened
row wearing the timestamp of an episode that ended months ago is open in the store and off the end of
the wire.

### Hysteresis

The condition oscillates hard: a goal completes, the queue dips, one issue gets watched, it recovers.
Two bands are the whole of the anti-nag design, not a refinement.

- Entering the warn band costs `runway.warnHours`.
- Leaving it costs `runway.clearHours`.

With one number the row files at 59 minutes, settles at 61 when a goal is watched, files again at 59
when the next one starts, and the operator gets a banner every few minutes for a queue that is
hovering. `validateRunwayPolicy` **refuses** a `clearHours` at or below `warnHours` at load: it does
not fail, it flaps, and a channel that cries wolf is worse than no channel.

The hysteresis needs no stored state. Its one input is whether a `supply` row is standing, which the
desk reads off the bench and the cockpit reads off the snapshot — and both must read it off an
**unbounded** list. `listHumanTasks` is the panel's feed: newest-first, capped at a hundred rows. Ask
it whether a `supply` row is standing and the answer is right until a hundred rows are filed behind
that row, at which point the band starts applying `warnHours` while the desk applies `clearHours`,
and the card reports `healthy` over a row that is still standing.

## When it stays quiet

- **Paused.** `idleSlots` is zero by definition and nothing here is news to whoever pressed the
  button.
- **The recovery hold.** No pulse runs at all ([04](04-harness-cycle.md#the-crash-recovery-hold)),
  and the banner above the console already says so.
- **Below `minimumRuns`** — on the duration arms only.
- **`runway.enabled: false`.** Files nothing **and still settles standing rows**, so turning it off
  drains the bench rather than stranding a row nothing left running will ever close.

## Where it runs

`RunwayDesk.run` sits in the pulse **below `dispatcher.decide`**, and both neighbours are the reason
([04](04-harness-cycle.md#ordering)). It needs every read `decide` needs — the plan funnel, the
verdicts, the decision window — so that is the first point in the pulse where they all exist; and
running it after the decision means a lens about supply can never delay a dispatch, however long its
walk over the issues takes.

It reads the **pre-dispatch** headroom, so a goal this pulse is about to start still counts as queued
rather than in flight. One pulse of lag, the same lag the retarget and the reap accept, and in the
safe direction: it over-reports supply for a beat rather than announcing a drought the dispatch
happening milliseconds later has already answered.

The cockpit takes its **own** reading in `buildStateSnapshot` rather than reading a cached one off
the pulse. A snapshot is served far more often than a cycle runs, and a reading a pulse old would
show a queue the operator has just topped up as still empty — on exactly the surface they topped it
up from. The two agree because the lens is one function **and both are handed the same reads**, not
because anything is passed between them — which makes every input the desk takes off the whole bench
one the snapshot must take off the whole bench too. `standing` is the one that has to be said out
loud, since the snapshot holds a capped feed of the same table two lines above it for the panel.

## In the cockpit

A band along the **foot of the Fleet card** ([17](17-cockpit.md)) — who is out, then what is queued
behind them, in that order and in one card. The foot rather than the head because the agents are the
card's subject and this is its consequence, and it costs nothing to reach: Fleet's rows are bounded
by the agent cap, so the band never travels far down the page.

It draws no control. The reading is a statement about the fleet, and a "watch something" shortcut
there would make it a prompt for the quickest fix rather than the truest one — which on the `starved`
arm would point at the reservoir when the answer is the three plans awaiting approval.

**It always draws**, muted when healthy, on the empty-card rule: a band that vanished when the queue
was full would be indistinguishable from one that broke, on exactly the deployment where nobody has
seen it before. `paused` wears the grey tone rather than the alarm.

The reading **changes unit rather than lying**: with nothing queued there is no runway to state, so
the band counts idle slots instead.

The duration is **fleet time**, and the band is one line — so what it cannot say it carries on hover:
which quantity it is, the median goal behind it, and the calendar span that median came out of. The
bench row and its notification say it in the sentence itself, composed once in `say()` so three
surfaces cannot word one reading differently.

## Configuration

→ [02](02-configuration.md#runway)

| Key                  | Default | Effect                                                             |
| -------------------- | ------- | ------------------------------------------------------------------ |
| `runway.enabled`     | `true`  | Master switch. Off files nothing and drains standing rows.         |
| `runway.warnHours`   | `1`     | Runway below which a row is filed.                                 |
| `runway.clearHours`  | `3`     | Runway a standing row must be back above. Must exceed `warnHours`. |
| `runway.minimumRuns` | `5`     | Completed goals before the median lead time is trusted.            |

An hour is roughly one goal's work on a three-wide fleet at this repo's own median, which is the
point: late enough that a fleet dipping between goals never trips it, early enough that there is
still time to triage before a slot goes empty.

**The defaults are stated against fleet time and were always meant to be.** Against a calendar
median they were unreachable: at a twenty-one-hour median and five slots, `thin` needed supply below
a quarter of a goal, so only the count-based `dry` and `starved` arms could ever fire and the whole
hysteresis design was dead in practice. The fix restores the sentence above rather than replacing it,
which is why the numbers have not moved. A deployment whose goals genuinely take several hours of
_fleet_ time should raise both — the useful shape is `warnHours` at about one median goal, so the
band opens when every slot has one thing to do and nothing behind it, and `clearHours` at two or
three.
