# The operator writes the pull request description

**Status: proposed, nothing built.** Behind `manualDescriptions`, off by default. This argues for a
change to [07-pull-requests.md](../spec/07-pull-requests.md#the-body-is-not-templated) and, behind it,
to [`mission.md`](../mission.md). Nothing here describes running code.

## The ask

With `manualDescriptions` on, the operator authors the **pull request description** — one per part,
because one part is one pull request — and that text is what ships as the body. They may hand it to
their own Claude Code to be argued with first. It holds nothing up: a part nobody described opens its
pull request anyway, with no body above the reference.

With the flag off, which is every deployment until somebody turns it on, nothing changes at all.

## Why: the thing writing is for

The mission's founding line is that _"the old job was producing the change. The new job is stating the
goal, and judging the evidence — everything between those two belongs to the harness."_ Read strictly,
everything between is work to be removed, and each removal is a win.

That is the line this proposal moves. **Some of the work between the two ends was never overhead — it
was the mechanism by which the person came to understand the change.** Writing is not the report of
comprehension that follows it; it is the instrument that produces it. A description you cannot write
is a change you have not understood, and that is information available at no other moment and by no
other means. Remove the writing and nothing announces what was lost, because what was lost is a state
of mind and nothing measures one.

So the goal is not a better body. It is that **somebody who read the change has to say what it does**,
and the saying is the check.

### The inconsistency this repairs

The repo already holds this principle one subsystem over. On review packs, `mission.md` says a change
is restated _"by a party that did not write it — how much scrutiny a change deserves is exactly the
judgement not to take from its author."_

Review packs took the **scrutiny judgement** away from the author. They left the **account of the
change** with it. The pull request description is, today, written by its author, which is the one
place the principle is not applied.

### And it is owed to the reviewer

A pull request spends another person's attention, and the operator is the one spending it. Sent with a
body written by the thing that made the change, with nobody who understood it anywhere in between,
that is an ask which costs the asker nothing and the reader an hour.

That is also why this cannot be an oracle kept in a drawer. It has to **ship**, under the operator's
name, where the reviewer reads it.

## The field is free, and the four questions are hints

Not five bullets. A free field, with the
[four questions a reviewer has](../spec/07-pull-requests.md#the-four-questions-a-reviewer-has) sitting
under it as prompts rather than as required fields:

- Is this what we asked for?
- What can't be undone if this is wrong?
- What's missing?
- How far does it reach if it's wrong?

**Why hints and not four boxes.** Four boxes make the form the task: the operator fills each one
because it is there, and a question with nothing to say under it gets an answer anyway. As hints they
do the one job worth doing — they say what a reviewer actually needs, so an operator who cannot answer
one notices that they cannot.

**And why `prBodyRefusal` does not run here.** The bullet rules, the length cap and the plainness floor
were written against a party that games a shape: asked for five bullets, agents wrote five paragraphs
with a dash in front of each, and `07` had to assert the form because asking for it did not work. A
person writing four answers about a change they read is not that party, and a refusal that bounces
their prose for a semicolon teaches them to write for the checker. The shape rules stay exactly where
they are, over the agent's body, which is what still ships when the flag is off.

## Two presses

**Save it.** The description is set and the pull request carries it. Nothing else happens.

**Validate with Claude.** A deep link, the same mechanism the validation bench already uses to hand a
check to the machine the operator is sitting at: an `<a>` carrying
`claude://code/new?q=…&folder=<config.desktopFolder>`, built the way `DesktopLink`
(`web/src/components/DesktopLink.tsx`) builds the check hand-over, opening their own Claude Code on the
goal's checkout with the command already in the box. It records nothing and claims nothing until that
session reports.

### It has to be the operator's own session, not the fleet's

This is not a plumbing detail, and it is the reason the press is a deep link rather than a button that
dispatches.

What happens after the report is a **conversation**: the session says the diff contradicts a sentence,
the operator says the throw is behind a flag, the session checks and concedes or holds. That exchange
is worth having only at conversational speed. A fleet agent answers on the pulse — dispatched,
queued behind the headroom cut, its reply arriving as a row on a surface the operator has to go back
to. Three rounds of that is an afternoon, and an instrument that costs an afternoon is one nobody
reaches for twice. The operator is already sitting in front of a Claude Code; the round trip there is
seconds.

It is also the right channel on the merits. Nobody dispatched this session, there is no task behind it
and no agent row — the properties [11](../spec/11-mcp-tools.md#the-desktop-channel) already states of
the desktop channel. And the fleet's channel must never grow this tool: a dispatched agent that could
mark its own operator's description of its own change is the conflict of interest this whole proposal
exists to remove, handed back through a side door.

### What the validating session does

It reads the operator's description and the actual diff, and it says where the two disagree. Then it
argues: the operator answers, corrects, or points at something the session misread, and the session
answers back. When they are done the operator confirms, and the description is set.

Reporting back is a tool on the **desktop channel** — `DESKTOP_TOOL_NAMES` and
`src/mcp/desktopTools.ts`, never `buildTools`. It is the operator's own Claude Code, not the fleet's:
nobody dispatched it, there is no task behind it, and the fleet's channel must not grow a tool that
lets a dispatched agent mark its own operator's description.

## The sharp edge: it must contradict, never draft

This is the one way the feature inverts into its own opposite, and it is quiet.

If the validating session hands back improved prose and the operator presses confirm, then a model
wrote the account of the change, the operator approved it, and the pull request ships a body that
looks human-authored and is not. That is strictly worse than today: today's agent-written body is at
least _known_ to be agent-written. Every reason this proposal exists is gone, and the surface still
reads as though the feature is working.

So the session's job is **to find what is wrong, not to say what is right**. It reports where the
description contradicts the diff, what it claims that the code does not do, and which of the four
questions the diff answers and the description does not. The operator edits their own text. A session
that offers a rewrite has failed at its job, and the tool it reports through should not take one:
what it hands back is findings and a mark, never a body.

The honest version of the press might well be named for that — **Check my description** rather than
**Validate with Claude** — because the first names what happens and the second names who does it.

## What is recorded, and the invariant it must not break

The session reports how accurate the description was, and that reading reaches insights beside the
prediction figures. Two rules come with it, both inherited rather than invented:

**Never a percentage on its own.** `PredictionRate` already carries a rate and the n it is over
together, _"because a percentage alone is the figure this panel exists not to draw."_ A description
accuracy score shown as a bare number is the same figure with a different label. The
`PredictionMark` vocabulary — `matched`, `missed`, `not-applicable` — already exists, per question, and
is the shape to reuse.

**Never scored by author.** `predictionAggregate.ts` drops the `author` column deliberately, and says
why: _"the aggregate is keyed by slot and by goal, and scoring people is out of scope."_ A description
accuracy keyed by person is a performance metric on an engineer, which is a different product. Keyed
by goal and by question, it is what it should be: a reading on how well the harness's own account and
the operator's agree.

There is a third, weaker rule worth stating now rather than discovering later: the aggregate should
not see the description's **text**. Predictions narrow theirs to a boolean at the one seam between the
record and every reading of it. A description is published, so the containment argument does not
apply — but "the aggregate sees marks, not prose" is the shape that keeps a later panel from quoting
an operator back at themselves.

## Grain, and when it is asked

Per part. A part is a pull request; a goal is not.

That settles the timing against the obvious guess. Parts do not exist until the plan does, so this
**cannot** be asked at the [reveal interstitial](../spec/08-planning.md#the-reveal-gate-stands-in-front-of-the-approval-gate)
— the operator would be writing N descriptions before seeing the plan that decides N. It is offered at
the **approval gate**, and because it holds nothing, the field stays open on the part for as long as
the pull request is open; a description written after the pull request exists updates its body in
place.

The practical shape is that an operator approves eight parts in one press and writes the descriptions
as the pull requests actually arrive, which is also when there is a diff to check one against.

## What it collides with in `07`

**"A body is an account of a change only the agent that made it has."** This one goes, where the flag
is on. It is already in tension with the sentence four paragraphs below it — _"whatever an agent writes
about its own change is written by the thing with the most reason to be wrong about it"_ — and `07`
resolves that tension halfway, by leaving the agent five bullets and taking the four reviewer
questions off it. What survives is its real content: **a template cannot produce a reading.** An
operator is not a template.

**"The body is the one thing about a pull request the harness does not rewrite."** This one stays true,
and the section above is what keeps it true. Nothing rewrites anything: the validating session
contradicts, the operator edits, and what ships is text a person typed.

## Storage

A table of its own, append-only and versioned the way `goal_criteria` is, keyed on the part rather than
the goal — an edit is a new version pointing at the one it supersedes, so what shipped stays readable
after a rewrite, and a version carries whether it was checked and what the check marked.
_src/store/prDescriptions.ts_, an ordinary named member of `Store`.

Two things it must not be:

- **Not a `WorldEvent`.** Same trap as an arrival, a sheet reading and criteria drift: `deliveryHold`
  expires a standing delivery verdict on any world event matching the goal's issue ref, so a
  description written as one un-parks the goal.
- **Not a prediction slot.** A prediction is contained and this is published. They share a form and a
  measurement, which is exactly how the containment invariant gets leaked.

## Configuration

`manualDescriptions`, boolean, `access: 'plain'`, **false by default** — a `ConfigField` in
`src/config/configFields.ts` beside `goalCriteria.enabled`, which is the closest precedent in both
shape and posture. Its routes mount only where it is on, so the cockpit draws the field off the
reading rather than off a second copy of the flag, the way the criteria half of the reveal gate already
keys itself.

## Open

- **A replan changes the parts.** A description authored against part 3 of the old plan has no owner
  under the new one. Drop it, or carry it and record the drift the way criteria drift is recorded?
- **What a mark is per question.** `matched` / `missed` / `not-applicable` is the inherited vocabulary,
  but a description's failure has a mode predictions do not: a claim the diff contradicts is worse than
  a question left unanswered, and one mark cannot say both.
