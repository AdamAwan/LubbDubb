# The operator writes the pull request description

**Status: proposed, nothing built.** This argues for a change to
[07-pull-requests.md](../spec/07-pull-requests.md#the-body-is-not-templated), which currently states
the opposite. Nothing here describes running code.

## The ask

Beside the prediction and the goal criteria, the operator authors the **pull request description** —
one per part, because one part is one pull request — and that text is what ships as the body. The
harness may tidy its shape before the operator accepts it; it never tidies the claim.

## What it collides with

`07` argues the body is the agent's: _"a body is an account of a change only the agent that made it
has"_, and _"the body is the one thing about a pull request the harness does not rewrite"_. Both
sentences are load-bearing today and both have to move.

The first one moves narrowly rather than being deleted. Read it beside the sentence four paragraphs
down — _"whatever an agent writes about its own change is written by the thing with the most reason
to be wrong about it"_ — and the two are in tension already. `07` resolves that tension by giving
the agent the bullets and taking the four reviewer questions away from it. This proposal resolves it
one step further along the same line: the account goes to an author with no stake in the verdict,
for the reason [`08`](../spec/08-planning.md#goal-criteria-beside-the-planners-acceptance) gives for
goal criteria — an independent oracle is independent because it was not written by the thing it
judges. What survives of the first sentence is its real content: **a template cannot produce a
reading**. An operator is not a template.

The second one, _the harness does not rewrite the body_, must stay true as written, and the tidy
pass is where it is at risk. See below.

## Grain, and therefore when it is asked for

Per part. A part is a pull request; a goal is not.

That settles the timing against the obvious guess. Parts do not exist until the plan does, so this
**cannot** be asked for at the [reveal interstitial](../spec/08-planning.md#the-reveal-gate-stands-in-front-of-the-approval-gate)
— the operator would be writing N descriptions before seeing the plan that decides N. It is asked
for at the **approval gate**, where the operator is already stopped, already reading the parts one
at a time, and already pressing once per plan.

The lost pre-reveal independence is not a cost here. It is a cost for criteria, whose whole standing
is that they predate their author's sight of the plan. A description that _ships_ has no such
standing to protect: it is public by construction, and what makes it worth having is only that a
person wrote it.

## What "tidy" may do

Nothing at `open_pr` time. If the harness rewrote a stored description on the way out, `07`'s
refusal-never-trim rule would be a dead letter and the operator's name would sit on prose they never
read.

So the tidy runs **at authoring**, in the cockpit, against the operator: they write, press, are
shown the tidied text beside their own, and accept or edit. What ships is text a person accepted.
The pass answers for shape only — the same arms `prBodyRefusal` (`src/pr/prBody.ts`) already
asserts: bullets, the count, the length cap, the plainness floor. It may not add a claim, drop one,
or change which one is first.

A description that fails `prBodyRefusal` and was accepted anyway is refused at authoring, not at
open. The operator is the one who can fix it.

## What the agent still owns

The five evidence fields — `satisfies`, `one_way`, `unverified`, `reach`, `decided`. Those are the
[four questions a reviewer has](../spec/07-pull-requests.md#the-four-questions-a-reviewer-has), they
are coordinates rather than claims, and they are answerable only by the agent that made the change.
Nothing about them moves.

And where no description was authored, `open_pr`'s `body` argument works exactly as it does today.
This adds a source; it does not remove one.

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

## Open

- **A replan changes the parts.** A description authored against part 3 of the old plan has no owner
  under the new one. Drop it, or carry it and record the drift the way criteria drift is recorded?
- **The operator who writes nothing.** Falling back to the agent's body is the honest default, but it
  makes the feature skippable by doing nothing, which is how a gate becomes theatre. Worth deciding
  whether the approval press should require one.
