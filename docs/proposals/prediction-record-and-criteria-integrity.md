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

**A third option: time-boxed, and its decay is itself measured.**

A prediction can be recorded only in the window between the goal becoming pickup-eligible and the
planning agent being dispatched. Before that there is nothing to predict about; after it the plan
exists and the prediction is contaminated. The cockpit draws the prediction card **only inside that
window**, and the card disappears when planning starts.

Nothing blocks on it. No gate reads it, no rule holds a goal for want of one, and a goal with no
prediction behaves in every respect as goals behave today. So it is not required, and cannot be
resented as a toll.

But it is not the ordinary optional-feature-that-decays either, for two reasons. The window means
it is never a deferred nag — a prediction not written in that window is not written, and does not
accumulate as a backlog of things the operator owes. And the aggregate reports **coverage** as a
first-class figure: how many goals passed through the window and how many took it. Decay is the
failure this design expects, so decay is the number on the panel rather than an absence nobody
notices. An operator who stops predicting finds out that they stopped.

There is a real cost to the window: it is short on a fast fleet, and on a goal that is picked up and
planned inside one pulse it may be effectively zero. Two mitigations are possible and neither is
proposed for stage one — a configurable hold that delays `issue-plan` on goals whose prediction
window has not been open for some minimum, and an operator press that opens the window explicitly on
a goal they want to predict on. Both add a gate that withholds work, which is the category
[33](../spec/33-story-sequencing.md#fail-open) exists to warn about, so neither should be added until
the coverage figure says the window is actually the thing limiting it.

### 2.4 Is it two scoring moments? What closes the second?

**Yes, two, and conflating them is the main way this feature would produce numbers that mean
nothing.**

- **Moment one — "did I predict the plan?"** Fires when the plan arrives (`awaiting_approval`). The
  prediction and the plan are drawn side by side; each filled slot is marked `matched` / `missed` /
  `not-applicable`. This is a claim about the operator's model of the _system_, and it is answerable
  immediately.

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

The plan row's transition into `status === 'planning'` is the start of planning and is already
recorded. Each criteria version carries `authoredAt`, and the standing is **derived, never stored as
a claim**:

- `pre-plan` — authored before the goal's plan row entered `planning`.
- `post-plan` — authored after planning began but before any part task was dispatched.
- `post-work` — authored after the first part task was dispatched. **This is drift.**

Derived rather than stored because a stored flag is a claim that can be written wrongly once and is
then true forever; a derivation against two timestamps the harness already keeps cannot be.

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
record will say `post-plan` rather than refusing them. Refusing them would mean a goal whose criteria
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

## 6. Staging

Each stage is independently landable and leaves the tree working.

1. **Storage and containment.** _src/store/predictions.ts_ and _src/store/goalCriteria.ts_, their
   tables and `ColumnMigrations`, `PredictionStore` off `Store` and threaded through `src/system.ts`,
   and _test/predictionContainment.test.ts_ with both arms. **No surface.** This stage is the
   invariant, and it lands first so that everything after it is written against a guarantee that
   already holds and is already asserted.
2. **The prediction record.** The window, the four slots, the routes, the goal-page card, the wire
   types. Recording only — no marking, no aggregate.
3. **Moment one.** The side-by-side view against the arriving plan, and the three-valued mark per
   slot.
4. **Goal criteria.** The versioned set, the derived standing, the drift record and its own wire
   list, merged at the feed's door. Part acceptance untouched.
5. **Moment two.** The close-out bench row and the second mark.
6. **The aggregate.** Counts first, rates withheld below threshold, coverage as a first-class figure,
   no author grouping.

Stages 1–3 alone satisfy "I can record a prediction on a goal and see it against the plan". Stage 4
alone satisfies "at least one instance of criteria drift has surfaced". Stage 6 is the one that needs
a month of data before it says anything, which is why it is last and why §2.5 matters.

## 7. Specs this touches when it lands

[08](../spec/08-planning.md) (criteria authorship and what the planner's acceptance now is),
[14](../spec/14-persistence.md) (both tables, the append-only rule, and the deliberate `Store`-shape
deviation), [16](../spec/16-http-api.md) (the routes), [17](../spec/17-cockpit.md) (the card, the
side-by-side, the aggregate panel, the feed merge), [18](../spec/18-observability.md) (the withheld
rate and its threshold), [24](../spec/24-environments.md) (the extra close-out bench row), and
[02](../spec/02-configuration.md) (the threshold key). `CLAUDE.md` gains at most two lines: the
prediction store is deliberately off `Store`, and a drift record is never a `WorldEvent`.
