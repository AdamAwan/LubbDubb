# The operator writes the pull request description

**Status: proposed, nothing built.** This argues for a change to
[07-pull-requests.md](../spec/07-pull-requests.md#the-body-is-not-templated) and, behind it, to
[`mission.md`](../mission.md). Both currently state the opposite. Nothing here describes running code.

## The ask

Beside the prediction and the goal criteria, the operator authors the **pull request description** —
one per part, because one part is one pull request — and that text is what ships as the body. The
harness may tidy its shape before the operator accepts it; it never tidies the claim. It holds nothing
up: a part nobody described opens its pull request anyway, with no body above the reference.

## Why: the thing writing is for

The mission's founding line is that _"the old job was producing the change. The new job is stating
the goal, and judging the evidence — everything between those two belongs to the harness."_ Read
strictly, everything between is work to be removed, and each removal is a win.

That is the line this proposal moves. **Some of the work between the two ends was never overhead —
it was the mechanism by which the person came to understand the change.** Writing is not the report
of comprehension that follows it; it is the instrument that produces it. A description you cannot
write is a change you have not understood, and that is information available at no other moment and
by no other means. Remove the writing and nothing announces what was lost, because what was lost is
a state of mind and nothing measures one.

So the goal is not a better body. It is that **somebody who read the change has to say what it
does**, and the saying is the check.

### The inconsistency this repairs

The repo already holds this principle one subsystem over. On review packs, `mission.md` says a change
is restated _"by a party that did not write it — how much scrutiny a change deserves is exactly the
judgement not to take from its author."_

Review packs took the **scrutiny judgement** away from the author. They left the **account of the
change** with it. The pull request description is, today, written by its author, which is the one
place the principle is not applied. This finishes the job rather than opening a new front.

### And it is owed to the reviewer

A pull request spends another person's attention, and the operator is the one spending it. Sent with
a body written by the thing that made the change, with nobody who understood it anywhere in between,
that is an ask which costs the asker nothing and the reader an hour. A reviewer is entitled to a
description written by someone who will answer for it.

That is also why this cannot be an oracle kept in a drawer. It has to **ship**, under the operator's
name, where the reviewer reads it.

## Same shape as the prediction and the criteria

This is the third instrument of one kind, and the family is the argument for it:

|                 | written before         | judged against                 |
| --------------- | ---------------------- | ------------------------------ |
| Prediction      | seeing the plan        | what the plan turned out to be |
| Goal criteria   | seeing the plan        | what was delivered             |
| **Description** | **the reviewer reads** | **the diff, by the reviewer**  |

Each asks the operator to commit to a reading and then exposes that reading to something that can
contradict it. The description's judge is the strongest of the three, because it is a person who was
not in the room and did not want to be told the answer.

## What it collides with in `07`

Two sentences, and they part company.

**"A body is an account of a change only the agent that made it has."** This one goes. It is already
in tension with the sentence four paragraphs below it — _"whatever an agent writes about its own
change is written by the thing with the most reason to be wrong about it"_ — and `07` resolves that
tension halfway, by leaving the agent five bullets and taking the four reviewer questions off it. The
bullets are the half that is still a claim rather than a coordinate, and they are the half a person
should be making. What survives of the sentence is its real content: **a template cannot produce a
reading.** An operator is not a template.

**"The body is the one thing about a pull request the harness does not rewrite."** This one stays
true as written, and the tidy pass is where it is at risk. See below.

## What "tidy" may do

Nothing at `open_pr` time. If the harness tidied a stored description on the way out, `07`'s
refusal-never-trim rule would be a dead letter and the operator's name would sit on prose they never
read.

So the tidy runs **at authoring**, in the cockpit, against the operator: they write, press, are shown
the tidied text beside their own, and accept or edit. What ships is text a person accepted. The pass
answers for shape only — the arms `prBodyRefusal` (`src/pr/prBody.ts`) already asserts: bullets, the
count, the length cap, the plainness floor. It may not add a claim, drop one, or change which one is
first.

A description that fails `prBodyRefusal` and was accepted anyway is refused at authoring, not at
open. The operator is the one who can fix it.

## Grain, and therefore when it is asked for

Per part. A part is a pull request; a goal is not.

That settles the timing against the obvious guess. Parts do not exist until the plan does, so this
**cannot** be asked for at the [reveal interstitial](../spec/08-planning.md#the-reveal-gate-stands-in-front-of-the-approval-gate)
— the operator would be writing N descriptions before seeing the plan that decides N. It is asked for
at the **approval gate**, where the operator is already stopped, already reading the parts one at a
time, and already pressing once per plan.

The lost pre-reveal independence is not a cost here, because independence is not what this instrument
is for. Criteria need to predate their author's sight of the plan or they judge nothing. A
description needs only to predate the reviewer.

## It blocks nothing

This is an offer, never a hold. The plan releases, the parts dispatch, the pull request opens, the
review is watched and the comments come back, whether or not a description was ever written. The
approval press is not gated on it and nothing waits behind it — the same posture the reveal gate
takes, and for the same reason: a step that is awkward to decline is a step that gets resented and
then turned off.

**What an ignored ask produces is a pull request with no body at all** — the harness's appended
reference and nothing above it. That is already `07`'s stated behaviour, one sentence on from the
refusal rules: _"An absent body is not refused — the appended reference stands on its own."_

This is what answers the worry the last draft had backwards. A feature that is skippable by doing
nothing is theatre only when skipping it still produces something that looks like the real thing.
Here it does not: the absence is on the pull request, legible to the reviewer and to the operator who
skipped it. Nobody is told a description exists when none does. An empty body is an honest reading,
and an honest reading is the whole standard the rest of this repo holds itself to.

So there is no fallback, and that is the load-bearing part: **the agent does not write one either.**
A backstop that quietly fills the gap would reintroduce exactly the thing this proposal removes — an
account of the change written by the thing with the most reason to be wrong about it — while making
the gap invisible. Either a person wrote the body or the pull request has none.

### Which withdraws `open_pr`'s `body`

If the agent never authors a body, the argument it authors one through goes. `open_pr` keeps its five
evidence lists and loses `body`; `prBodyRefusal` (`src/pr/prBody.ts`) stays exactly as it is and
serves the cockpit's authoring pass instead, which is the same rule against the same shape with a
different author in front of it.

Two things that costs, both worth naming: the built-in prompt bodies that tell an agent how to write
one need the instruction removed, and a deployment that overrode those templates keeps telling its
agents to write a body they can no longer send. An argument is not a `PromptId` or a tool name, so
neither retirement mechanism covers it — the call arrives with an unknown key and the agent gets a
refusal that has to name what happened.

## When it is asked, and until when

At the approval gate, per part, as above — but because it holds nothing, the ask does not end there.
The field stays open on the part for as long as the pull request is open, and a description written
after the pull request exists updates its body in place. That is not the harness rewriting a body: it
is the operator writing theirs, later.

The practical shape is that an operator approves eight parts in one press and writes the descriptions
as the pull requests actually arrive, which is also when they have something to describe.

## What the agent still owns

The five evidence fields — `satisfies`, `one_way`, `unverified`, `reach`, `decided`. Those are the
[four questions a reviewer has](../spec/07-pull-requests.md#the-four-questions-a-reviewer-has), they
are coordinates rather than claims, and they are answerable only by the agent that made the change.
Nothing about them moves.

## Storage

A table of its own, append-only and versioned the way `goal_criteria` is, keyed on the part rather
than the goal — an edit is a new version pointing at the one it supersedes, so what shipped stays
readable after a rewrite. _src/store/prDescriptions.ts_, an ordinary named member of `Store`.

Two things it must not be:

- **Not a `WorldEvent`.** Same trap as an arrival, a sheet reading and criteria drift: `deliveryHold`
  expires a standing delivery verdict on any world event matching the goal's issue ref, so a
  description written as one un-parks the goal.
- **Not a prediction slot.** A prediction is contained and this is published. They share a form and
  nearly share a moment, which is exactly how the containment invariant gets leaked.
  → [08](../spec/08-planning.md#goal-criteria-beside-the-planners-acceptance)

## `mission.md` is what actually changes

If this lands, the line to amend is not in `07` but in the mission: _"everything between those two
belongs to the harness"_ is no longer true, and should not be repaired by adding an exception to a
list. The honest statement is that the engineer keeps the two ends **and the understanding**, and
that a piece of work between them is kept deliberately where removing it would remove the
understanding with it.

## Open

- **A replan changes the parts.** A description authored against part 3 of the old plan has no owner
  under the new one. Drop it, or carry it and record the drift the way criteria drift is recorded?
