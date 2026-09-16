# Proposal — the prediction record, and acceptance criteria as an independent oracle

**Status: under discussion. Nothing here is built.** This document is a design proposal, not a
description of the application ([`docs/README.md`](../README.md)). If it is accepted, the reasoning
that is still load-bearing moves into the spec documents that own the behaviour and this file is
deleted by the change that lands the last stage.

It proposes two features that share a moment — the gap between an issue being picked up and its plan
being written — and share one invariant, which is that what a human commits to in that gap must not
be visible to the agent whose work it is a measurement of.

---

## 1. What is being measured, and why the two belong together

The harness already records what the _fleet_ did: spend per goal, reds per goal, throughput,
remedies, retro dossiers. It records nothing about whether the **operator's model of the system** was
right. Approving a plan is a prediction; refusing one is a prediction; every hint written into
`goalInstructions` is a prediction. None of them is scored, so none of them corrects.

Separately, a goal's acceptance criteria are today written by the **planning agent**
([08](../spec/08-planning.md)) as `plan_parts.acceptance`, and ticked by a reviewer against a diff.
The planner, the implementer and the validation-plan author are the same model reading the same
issue. Whatever the issue meant to a model at plan time is what it will still mean at test time, so
the criteria cannot catch the one failure that matters most: the goal was understood wrongly and then
built, reviewed and validated consistently with the wrong understanding.

The two features are one mechanism seen twice. A prediction is a human claim about the work recorded
before the fleet's account of it exists; acceptance criteria are a human claim about what "done"
means, recorded before the fleet's account of it exists. Both are worthless the moment they can be
written after the answer is known, and both are worthless the moment the thing being measured can
read them.

---

## 2. Answers to the questions the goal asked

These are the decisions the proposal makes. Each is arguable; each is stated so it can be argued with
before code exists.

### 2.1 Does the prediction attach to the goal, to each part, or to a dispatch?

**To the goal** — one prediction per `issue:<n>` origin ref, and at most one.

Parts do not exist when the prediction is made. That is not an inconvenience to route around: the
prediction is a claim about work whose decomposition has not been proposed yet, and _where the
decomposition falls_ is one of the things a prediction can be wrong about. Attaching to parts would
make the most interesting class of miss unrecordable, because a prediction that the change lives in
one place cannot be filed against three parts that did not exist when it was written.

A dispatch is the wrong grain in the other direction: a goal is dispatched for many times (appraisal,
planning, each part, each fix, validation), and a prediction per dispatch measures the operator's
model of the _dispatcher_ rather than of the system.

**Marks, however, are per line against the plan.** The prediction attaches to the goal; each of its
lines is marked once the plan arrives (§2.4). A line may cite the part it was about — a free-text
`against` field carrying a part slug — but citation is not attachment: the prediction row does not
move.

**Consequence for stacked and re-planned goals.** A replan (`status === 'planning'` on a live plan)
produces a second plan document against the same prediction. The prediction is not re-openable, and
the marks are against the **first** plan to arrive — the one the prediction was actually a prediction
about. A replan carries the marks forward unchanged and records that it happened; it does not offer a
second marking pass, because marking against a plan written after the first plan was read is marking
against something the operator has already been told the answer to.

### 2.2 Structured fields or free text?

**Four named slots, free text inside each.** The slots are the four the goal names:

| Slot       | The question                             |
| ---------- | ---------------------------------------- |
| `locus`    | Where do I think this lives?             |
| `cause`    | What do I think the cause / approach is? |
| `hard`     | What do I think will be hard?            |
| `surprise` | What would surprise me?                  |

Every slot is individually skippable; a prediction with one slot filled is a prediction.

The structure buys exactly one thing, and it is the thing the aggregate view needs: **the mark is per
slot**, so the aggregate is four rates rather than one, and "which kinds of human hint are worth
putting into standing context" is answerable at the resolution of the four slots without anything
reading the text. The goal's own phrasing — "which _kinds_ of hint" — is at that resolution.

**What it costs.** Nothing aggregates _within_ a slot. If the operator's `locus` predictions are
reliably right for schema changes and reliably wrong for cockpit work, the aggregate cannot see it;
only a human reading the goals can. That is accepted rather than solved: the alternative is
classifying free text, which means a model reading predictions, which the containment invariant
(§3) forbids outright. **A prediction is never fed to a model, including for its own analysis.** That
is the price of the guarantee and it should be paid knowingly.

A fifth slot is a schema change and a fifth column on the aggregate. The four are not sacred, but
adding one retroactively makes every earlier goal absent rather than zero in that column, and the
aggregate must draw it that way (§2.5).

### 2.3 Required or optional? Is there a third option?

**A third option: neither. The plan arrives obscured, and the offer to predict is what stands in
front of it.**

An earlier draft of this proposal put the prediction in a window between pickup and the planning
agent's dispatch, and it was wrong in a way worth recording, because the mistake is instructive. It
treated contamination as a property of the **clock** — predict before the planner runs — when
contamination is a property of **what the operator has read**. A prediction typed while the planning
agent is still working is exactly as clean as one typed before it was dispatched; the operator has
seen no plan in either case. Anchoring on the planner's dispatch bought no integrity and cost the
whole thing its usability: on a fleet that picks up and plans inside one pulse, the window was
effectively zero, and the feature would have been a card almost nobody ever saw.

So the anchor moves from the planner's dispatch to **the operator's first sight of the plan**, and
the offer moves to the moment that sight is about to happen:

> The plan lands `awaiting_approval`. The operator opens the goal. The plan is **drawn obscured**,
> and over it: _"A plan is ready. Predict first?"_ — with **Predict** and **Show me the plan** beside
> each other, one press each.

This is better than a window on four counts, and each is worth stating because each was a problem
with the window version.

- **It is offered at the moment of maximum attention.** The operator is already on that page, for the
  exact reason the prediction matters. There is no separate surface to visit, no notification to
  clear, nothing competing for a moment of its own. The feature's whole interaction budget is two
  presses spent at a moment the operator was going to spend anyway.
- **It cannot expire unfairly.** The offer is available for as long as the plan is unread — a minute
  on a fast fleet, a day if the operator is away. The fleet's speed no longer decides whether the
  operator gets to predict.
- **It is self-sealing.** The window version needed a rule saying predictions cannot be back-filled.
  This version does not need the rule, because the act that ends the opportunity is the act that
  would have contaminated it. Reveal is the seal. There is nothing to enforce.
- **Declining is a recorded act rather than an absence.** A window silently expires; a gate is
  answered. "I looked without predicting" is a fact with a timestamp, and it is the fact the coverage
  figure is actually made of.

**It still blocks no work, and this is the precise sense in which that is true.** Nothing is
withheld from the fleet: parts are not held, the plan is not un-approved, no rule waits on it, and a
goal with no prediction proceeds exactly as goals proceed today. What is briefly withheld is **the
operator's own view of the plan, from the operator, at their own request**. That is the one thing
this feature is allowed to interrupt, and it is worth being plain that it is an interruption rather
than pretending the cost is zero.

**The interstitial's own failure mode is reflexive dismissal**, and it should be designed against
rather than hoped away. Three measures: **Show me the plan** is always the equal-weight press and
never a small grey link, because a gate that is awkward to decline is a gate that gets resented and
then disabled outright; the gate never re-prompts for a goal it has been declined on; and the
**decline rate is on the aggregate** beside coverage, so an operator dismissing every gate can see
that they are. A sampling rate — offer the gate on one goal in N — is the obvious relief valve if the
decline rate says the gate is being tuned out, and it costs the aggregate nothing as long as the
sample is unbiased. It should not ship in stage one: ship the gate on every plan, read the decline
rate, and turn it down only if the number says to.

#### The reveal must be a server fact, not a client one

Requirement 4 asks that "written before" be a fact rather than a claim, and a blur is a decoration —
the plan body would be sitting in the payload behind it, readable from the network tab, and
`revealedAt` would be a timestamp the page reports about itself.

So **the plan body is withheld from the goal's payload until it is revealed**, and revealing it is a
route call that stamps `revealed_at` server-side and returns the document. One extra fetch, and the
ordering becomes a fact of the same kind as every other timestamp here rather than a courtesy the
client extends.

This is honest about the cockpit and only about the cockpit, so it is worth confirming what else can
show the operator a plan at that moment — and the answer is nothing. `PlanReconciler` writes the plan
status comment only when `current.status !== 'awaiting_approval'`, so while a plan is awaiting
approval **no plan content has reached the tracker at all**. Approval is downstream of reveal, parts
are not dispatched and no pull request exists. The obscured plan really is the only copy the operator
can reach, which is what makes the gate meaningful rather than theatrical.

What it is not, and should not be sold as, is access control. The operator can read the database.
This is a **self-measurement instrument**, and a determined self-deceiver defeats every possible
version of it; what the design owes them is that the honest path is also the easy one, and that the
record says plainly when they looked.

### 2.4 Is it two scoring moments? What closes the second?

**Yes, two, and conflating them is the main way this feature would produce numbers that mean
nothing.**

- **Moment one — "did I predict the plan?"** Is what the reveal opens onto. Submitting a prediction
  at the gate lifts the obscured plan and draws it beside what was just written; each filled slot is
  marked `matched` / `missed` / `not-applicable`. This is a claim about the operator's model of the
  _system_, and it is answerable on the spot — which is why it is one continuous interaction rather
  than a second visit: predict, reveal, mark, in the sitting the operator was already having. An
  operator who reveals without predicting has no moment one, and that is the same fact as their
  decline.

- **Moment two — "was the plan right?"** Fires at delivery. The operator marks whether the plan the
  fleet produced turned out to be correct, per slot, on the same three-valued mark. This is a claim
  about the _plan_, not about the operator.

The two must both exist, because either alone is misleading. A prediction that missed the plan and a
plan that then turned out wrong is the operator having been _right_ — the most valuable row in the
whole record, and one that moment one alone files as a miss. A prediction that matched the plan and a
plan that turned out wrong is the operator and the fleet being wrong together, which is precisely the
shared-interpretation failure §1 describes, and one that moment one alone files as a success.

**What closes the second moment.** It rides the existing delivery close-out bench rather than
becoming a second queue. `DeliveryCloseOutDesk` already parks a delivered goal and asks the operator
for one thing at a time ([24](../spec/24-environments.md#the-bench-asks-for-one-thing-at-a-time));
a goal with marked prediction slots carries one additional close-out row. This matters for a reason
beyond tidiness: a second standalone queue for an optional feature is the thing that decays first,
and the close-out bench is a surface the operator already has to clear.

**Moment two is skippable and its absence is recorded as absent, never as a miss.** A goal whose
first moment was marked and whose second was skipped appears in the first aggregate column and in
neither of the second's. Folding a skip into `missed` is the same error as folding `null` into
`false` in `fleetCanStart` (`CLAUDE.md`), one subsystem over.

### 2.5 At low volume the aggregate is noise. What stops it being read as signal?

The repo already has the answer and it should be reused rather than re-invented:
[18](../spec/18-observability.md) withholds a figure from the **payload** below a sample threshold,
because withholding it from the payload is the only way the panel can be made not to draw it. A
caption saying "small sample" is read by nobody.

So:

- Every rate on the prediction aggregate is `null` below a threshold of marked goals, and the panel
  draws the **count toward the threshold** in its place — "4 goals marked; rates appear at 10" — which
  is a true statement and not a rate.
- **Counts are never withheld.** How many goals had a prediction, how many were marked, how many had
  criteria drift: these are facts at any n, and they are the figures that matter first anyway.
- **The median and the count, never a percentage alone.** A rate is always drawn beside the n it is
  over.
- **A slot added later is absent rather than zero** in every bucket that predates it, for the reason
  an absent bucket beats a zero one in the runaway watch.

The threshold is a config key with a default, not a literal.

---

## 3. The containment invariant, and whether it can be guaranteed

> The prediction must not reach an agent by ANY path — prompt context, transcript, tool response,
> retrospective input, or scratchpad. If you cannot guarantee that, stop and say so.

**It can be guaranteed, on the condition that the prediction is never written anywhere the harness
already ships to agents wholesale.** The paths, enumerated against the code as it stands:

| Path                          | Why a prediction cannot travel it                                                                                                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Prompt context**            | `loadPromptTemplates` renders a fixed placeholder set, and the repo's standing rule is that anything new an agent must read is **appended** deliberately ([05](../spec/05-dispatcher.md#prompt-templates)). Nothing reaches a prompt by default; a prediction reaches one only if somebody writes the append. |
| **The tracker**               | This is the sharp one. `worldRead` serves an issue's **body and comments verbatim**. A prediction written as an issue comment, a body edit or a label is therefore readable by every agent on the goal. **The prediction is never written to the tracker, in any form.**                                      |
| **Tool responses**            | MCP tools are built in `buildTools` from an explicit `deps` object. Containment is by construction if the prediction store is not in that object (§3.1).                                                                                                                                                      |
| **The retro dossier**         | `goalRecord` (`src/retro/record.ts`) enumerates its store reads one at a time; it does not sweep. A prediction is absent unless added.                                                                                                                                                                        |
| **The scratchpad**            | `src/scratch/pad.ts` holds only what an agent wrote through `scratch_append`. Nothing writes operator text into it.                                                                                                                                                                                           |
| **Transcripts**               | A transcript records what passed through the session. Containment on the four paths above is containment here.                                                                                                                                                                                                |
| **The state snapshot / wire** | `src/wire.ts` is the cockpit's payload, served over HTTP behind the bearer token. No MCP tool serves it. It may carry the prediction.                                                                                                                                                                         |

Two locks are proposed, because "nobody added the append" is a convention and this invariant is worth
more than a convention.

### 3.1 Lock one — the prediction store is not on `Store`

`CLAUDE.md` states that `src/store/` is the only directory that touches SQLite and that each module
is reached as a named member — `store.tasks.getTask(id)`. The prediction module keeps the first half
and **deliberately breaks the second**: _src/store/predictions.ts_ defines `PredictionStore` taking a
`StoreContext` like every other module, but `Store` does not forward it. `src/system.ts` constructs
it and hands it to the HTTP route module that owns the prediction routes, and to nothing else.

This turns the invariant from a rule into a type error. `buildTools` receives `deps.store`; the
dispatcher receives the store; the retro dossier receives the store. None of them can name
`store.predictions`, because there is no such member. Somebody who wants to leak a prediction into a
prompt has to thread a new dependency through the composition root to do it, which is a diff a
reviewer sees.

This deviation is the whole reason the module exists in that shape, so if the proposal is accepted
the deviation is stated in [14](../spec/14-persistence.md) at the point the store shape is described,
not left to be discovered and "fixed" by a later tidying change. A tidy-up that folds
`PredictionStore` onto `Store` silently removes the guarantee, which makes it exactly the genre of
sharp edge `CLAUDE.md` carries — and it should get a line there.

### 3.2 Lock two — a structural test and a live one

The repo already asserts architectural boundaries structurally ("Lenses stay out of
`src/dispatcher/`... Asserted structurally — if one of those tests fails, fix the file it names, not
the assertion"). _test/predictionContainment.test.ts_ does the same in two ways:

- **Statically**: no module under `src/dispatcher/`, `src/agents/`, `src/mcp/`, `src/retro/`,
  `src/briefing/`, `src/scratch/` or `src/sink/` imports _src/store/predictions.ts_ or names
  `predictions` as a store member.
- **Live**: build a `System` with fakes, record a prediction whose text is a distinctive sentinel
  string, dispatch a mock (`raw`) agent on the goal, and assert the sentinel appears in no rendered
  prompt, no tool response, no transcript row and no outbound sink call. The sink assertion is what
  catches the tracker path, which is the one a type system cannot.

The live arm is the more important of the two, and it is also the one that would have caught the
mistake this section exists to prevent: writing the prediction as an issue comment because that is
where operator text usually goes.

### 3.3 What is _not_ guaranteed, stated plainly

- **An operator who pastes their own prediction into `goalInstructions` has leaked it**, and nothing
  can stop that. Standing instructions are delivered to agents by design. The cockpit should say so
  on the prediction card, once, in a sentence.
- **A prediction is never analysed by a model**, including for the aggregate (§2.2). Any future
  request to classify prediction text automatically is a request to break the invariant and should be
  refused at that level rather than sandboxed.
- **Acceptance criteria are the opposite case and must not inherit this posture.** Criteria are an
  oracle the implementer is _meant_ to be judged against, and today's `plan_parts.acceptance` already
  reaches the part prompt. Human-authored criteria reach agents too. The two features share a moment
  and share a table neighbourhood; they do not share a containment rule, and a reader who conflates
  them will either leak predictions or hide criteria.

---

## 4. Acceptance criteria as an independent oracle

### 4.1 What changes

Today: the planner writes `plan_parts.acceptance`; a reviewer ticks it; `acceptanceMet` is a list of
ticked lines ([08](../spec/08-planning.md)).

Proposed: a **goal-level criteria set**, human-authored, versioned, append-only, living in its own
table and its own module. Part acceptance stays exactly as it is — it is the planner's restatement at
part grain and it is useful. The goal-level set is the independent one, and where both exist the goal
set is the authority: a delivered goal is judged against it, and a part's acceptance that contradicts
it is a plan defect rather than a criteria change.

### 4.2 "Written before" as a fact

Criteria take the same anchor predictions take, and for the same reason §2.3 gives: what makes a
criterion independent is not that it predates the planner's dispatch but that it predates the
author's sight of the plan. So the standing is derived against **`revealed_at`** and the first part
dispatch:

- `pre-reveal` — authored before the plan was revealed to a human. **This is the independent one.**
- `post-reveal` — authored after the plan was read but before any part task was dispatched.
- `post-work` — authored after the first part task was dispatched. **This is drift.**

Derived, never stored as a claim: a stored flag is a claim that can be written wrongly once and is
then true forever, whereas a derivation against two timestamps the harness already keeps cannot be.

One consequence is worth drawing out, because it is the quiet half of the gate. The reveal
interstitial is the natural place to ask for criteria as well as a prediction — it is the last moment
at which either can be authored independently, and it is a moment the operator is already stopped at.
A goal whose criteria were written at that gate is a goal whose oracle provably predates its plan,
which is the whole of requirement 4 discharged by an interaction that was happening anyway.

### 4.3 The version chain

`goal_criteria` is **append-only**. An edit writes a new row with an incremented `version`, a
`supersedes` pointer, `author`, `authoredAt` and a **required** `reason` when the standing is
`post-work`. No `UPDATE` touches criteria text, ever. The goal page draws the current version with
the chain behind it, and a goal whose criteria changed after work started is marked as such on the
goal page, in the aggregate, and — this is the part that needs care — **in the feed**.

**A criteria-drift record must never be written as a `WorldEvent`.** This is the same trap as an
environment arrival and a sheet reading ([24](../spec/24-environments.md#in-the-cockpit),
[36](../spec/36-remote-validation.md)): `deliveryHold` expires a standing delivery verdict on **any**
world event matching the goal's issue ref, so a drift record written as one un-parks the goal it just
reported on and hands delivered work back to the fleet. Drift gets its own table and its own wire
list, and the cockpit merges it at the feed's door, exactly as arrivals are merged.

### 4.4 The independence this does and does not buy

It buys: criteria that predate the plan, and a record when they do not. It does **not** buy criteria
the fleet cannot influence — an operator can still write criteria after reading a plan, and the
record will say `post-reveal` rather than refusing them. Refusing them would mean a goal whose criteria
were not written in time can never have any, which is worse. The design's position is that the
_standing is the product_: a `post-work` criterion is not forbidden, it is labelled, counted, and
visible in the aggregate as drift.

---

## 5. Where the scoring must not go

The goal puts scoring of people out of scope, and this design has a specific hazard: the criteria
version chain and the prediction row both carry an `author`, and on the day a second operator exists,
grouping the aggregate by that column is one SQL clause away.

So, as an invariant rather than an intention: **no route, wire type or surface groups prediction or
criteria figures by author.** The author column exists to attribute a version in the chain — "who
changed the criteria, and why" is requirement 5 — and for nothing else. The aggregate is keyed by
slot and by goal. If a later change wants an author-grouped reading, that is a change to this
invariant and has to argue with this paragraph first.

On today's deployment the question is smaller than it looks. The harness is single-operator: one
bearer token, no user model, `config.userId` is the credential the harness posts under. There is no
second human for a prediction to be private _from_, so requirement 7's privacy reduces almost
entirely to the containment invariant of §3 — private from the fleet, which is the one that carries
the value. The `author` column is recorded now so that the chain is meaningful later; the filter it
would feed is a no-op today and should be written as one rather than as a permission system that
protects nothing and reads as though it does.

---

## 6. The switch, and how it comes off again

**Both halves ship behind a config key, and both default to `false`.** Nothing about this reaches a
deployment that has not asked for it.

| Key                    | Default | On                                                                                                            |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `prediction.enabled`   | `false` | The reveal gate offers a prediction; the record, the marks and the prediction columns of the aggregate exist. |
| `goalCriteria.enabled` | `false` | Goal-level criteria can be authored and versioned; drift is derived, recorded and surfaced.                   |

Two keys rather than one because the two halves land in different stages and are independently worth
being unhappy with — the point of a switch is that it can be thrown for one thing at a time. They are
genuinely independent: neither reads the other's rows. They share exactly one fact, the reveal stamp,
and it is handled by a single derived predicate — `revealGateOn` is true when **either** key is on —
read in the two places named below and nowhere else.

### 6.1 What "off" has to mean, and why "invisible" is not enough

This repo has already paid for the difference one subsystem over, and `CLAUDE.md` carries the scar: a
`RemoteValidationDesk` pass that stamps an arrival it did not assemble "burns the guard that makes
turning remote validation on next month safe". The same trap is available here, and it is worth
naming before the code exists.

**With both keys off, nothing is stamped.** Not `revealed_at`, not a decline, not an offer. If the
harness stamped reveals while the feature was off, then the day the operator turned it on they would
inherit a backlog of goals that had been revealed and not predicted on — which is the database's way
of spelling _declined_ — when the truth is that those goals were **never offered**. The aggregate
would open on a fabricated decline rate, in its first week, which is the one week it has to earn any
trust at all.

So the aggregate distinguishes three outcomes and not two: **predicted**, **declined**, and **not
offered**. The third is what every goal from before the switch reads as, permanently, and it is what
makes turning the key on safe.

### 6.2 One cut point per half, not a branch per reader

The other half of the cost is the one [08](../spec/08-planning.md) records against the funnel's own
retired switch: keeping `planning.enabled` "meant every gate that read it was a branch to reason
about and test". A boolean scattered through a dozen call sites is a dozen half-tested arms.

So each key is read in exactly two places:

- **`src/system.ts`**, which decides whether the desk and its routes are constructed at all. Off, the
  routes are not mounted and the desk does not exist, so there is no arm inside it to get wrong.
- **The wire payload**, which omits the prediction block, the criteria block and the aggregate
  section entirely. Off, the plan body ships in the payload exactly as it does today, because there is
  no gate to withhold it for.

Everything downstream reads **the presence of data**, not the flag. A goal page draws a prediction
card when the payload carries a prediction block, and draws today's plan when it does not. That is
one branch, in one place, testable by building a `System` twice.

### 6.3 The schema is not behind the flag

The tables and their `ColumnMigrations` run at boot whichever way the keys are set. Gating schema on
a flag would mean the operator's first flip performs a migration on a live boot — the flip becoming a
schema event rather than a behaviour change, which is a far worse thing to do on a Tuesday than to
carry two empty tables. Empty tables cost nothing and are the ordinary shape here.

### 6.4 Flipping it, and flipping it back

**On**, mid-flight: goals already past their reveal are never offered — the no-back-fill invariant
already says so, and they read as `not offered` for good. Goals sitting at `awaiting_approval` and
not yet revealed **do** get the gate, which is the correct behaviour and the pleasant one.

**Off again**: nothing is deleted. Recorded predictions and every criteria version survive untouched
— the criteria half is append-only, so this is guaranteed rather than promised — and the surfaces
simply stop. Turning it back on resumes against the same rows, with the goals in between reading as
`not offered`, because they were.

### 6.5 The key is scaffolding, and the exit is part of the design

Worth stating plainly, because this repo's own history is that feature switches are an on-ramp and
not a fixture: `planning.enabled`, `validation.enabled`, `assessment.enabled`, `appraisal.enabled`
and `retrospective.enabled` are all in `RETIRED_KEYS` now, each with a sentence saying why the
behaviour is unconditional. A key that is never retired is a branch the deployment carries for ever,
and a second configuration nobody tests.

The retirement condition here should be the one the feature is actually for: **the key comes off when
the aggregate has said something the operator acted on at least once.** That is a higher bar than "it
works", and deliberately so — what is being validated is not whether the gate renders but whether the
record is worth keeping. Until then the key stays, and `false` stays the default.

## 7. Staging

Each stage is independently landable and leaves the tree working.

1. **Storage, containment and the two keys.** _src/store/predictions.ts_ and
   _src/store/goalCriteria.ts_, their tables and `ColumnMigrations`, `PredictionStore` off `Store` and
   threaded through `src/system.ts`, `prediction.enabled` and `goalCriteria.enabled` in
   `src/config/configFields.ts` defaulting to `false`, and _test/predictionContainment.test.ts_ with
   both arms. **No surface.** This stage is the invariant and the switch, and it lands first so that
   everything after it is written against a guarantee that already holds, is already asserted, and is
   already off.
2. **The reveal gate and the prediction record.** Withholding the plan body from the payload until
   reveal, the `revealed_at` stamp and its route, the obscured plan with its two presses, the four
   slots, the goal-page card and the wire types. Recording and declining only — no marking, no
   aggregate. The gate ships in the same stage as the record because a record with no gate in front
   of it is the optional feature §2.3 exists to avoid.
3. **Moment one.** The side-by-side view the reveal opens onto, and the three-valued mark per slot.
4. **Goal criteria.** The versioned set, the derived standing, the drift record and its own wire
   list, merged at the feed's door. Part acceptance untouched.
5. **Moment two.** The close-out bench row and the second mark.
6. **The aggregate.** Counts first, rates withheld below threshold, coverage as a first-class figure,
   no author grouping.

Stages 1–3 alone satisfy "I can record a prediction on a goal and see it against the plan". Stage 4
alone satisfies "at least one instance of criteria drift has surfaced". Stage 6 is the one that needs
a month of data before it says anything, which is why it is last and why §2.5 matters.

Every stage from 2 onwards lands **behind its key, off**. So the whole of this can be built, reviewed
and merged without any deployment behaving differently, and the first time anything changes is the
day the operator sets a key to `true` on their own harness. There is no stage at which merging is the
same act as rolling out.

## 8. Specs this touches when it lands

[08](../spec/08-planning.md) (criteria authorship and what the planner's acceptance now is),
[14](../spec/14-persistence.md) (both tables, the append-only rule, and the deliberate `Store`-shape
deviation), [16](../spec/16-http-api.md) (the routes), [17](../spec/17-cockpit.md) (the card, the
side-by-side, the aggregate panel, the feed merge), [18](../spec/18-observability.md) (the withheld
rate and its threshold), [24](../spec/24-environments.md) (the extra close-out bench row), and
[02](../spec/02-configuration.md) (the two feature keys, the threshold key, and the retirement entry when the switch eventually comes off). `CLAUDE.md` gains at most two lines: the
prediction store is deliberately off `Store`, and a drift record is never a `WorldEvent`.
