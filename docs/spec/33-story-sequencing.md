# 33 — Story sequencing

`src/sequence/`. The order the stories under a Feature are worked in, and the hold that keeps a story
waiting for the one it needs.

A Feature is never dispatched at — its children are the work ([06](06-issue-pickup.md#hierarchy)) —
and watching one tags every descendant beneath it at once. So the click that says "work this feature"
currently makes eight stories eligible in the same pulse, and the fleet starts whichever the priority
labels happen to rank first. That is right when the stories are independent and wrong when they are
not: the story that reads a table starts beside the story that writes it, and the first agent
invents the schema the second was going to design.

This is the record that says which of those two goes first, and the gate that makes it so.

## What it is not

Stated first, because each boundary is a thing the harness already does and would otherwise be
re-litigated:

| Not                       | Because                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A plan                    | A plan decomposes **one** issue into parts and cuts a branch per part ([08](08-planning.md)). A sequence orders issues somebody else already wrote, creates nothing, and cuts no branch.                                              |
| A priority                | `issuePriorityLabels` says which of two eligible items claims scarce headroom first. This says one of them is not eligible yet. Ranking never withholds work; a sequence does. → [precedence](#precedence)                            |
| A workflow state          | `pickupStates` is the operator's statement about their board. The harness never writes a state on the strength of a sequence — the hold is harness-side and invisible to the tracker. → [what it never writes](#what-it-never-writes) |
| A verdict about a Feature | The feature board composes no sentence of its own ([17](17-cockpit.md#the-feature-summary)) and neither does this. A sequence is an ordering with a stated reason, not a reading of how the Feature is going.                         |
| A dependency graph        | Nothing here is transitive reasoning over the repo. The edges are what the tracker's links say plus what one agent read in the items' own text, and both are recorded as such. → [two sources](#where-the-order-comes-from)           |
| Automatic                 | An order holds work only once a person has accepted it. Until then the fleet behaves exactly as it does today. → [fail open](#fail-open)                                                                                              |

## Where the order comes from

Two sources the harness _reads_, and **which one an edge came from is recorded on the edge**. The
distinction is not presentational: one is a statement a person made on the board and the other is a
guess, and a surface that draws them the same way invites an operator to accept the second thinking
it is the first. A third value, `operator`, is written by an [amendment](#amending-it) — a judgement
a person made here rather than on their board, and marking one of those `inferred` would claim an
agent guessed at it.

### The tracker's own links

Azure DevOps work items carry `System.LinkTypes.Dependency-Forward` / `-Reverse` — Successor and
Predecessor. Azure names the link from the _other_ end, so what an item **waits on** is `-Reverse`,
the same way round as `Hierarchy`, whose `-Reverse` is the parent.

`src/integrations/azure/workItems.ts` resolves them into `Issue.dependsOn`, a list of
`IssueRelative` beside the existing `parent` / `children` / `siblings`. It rides in the hierarchy
pass's own batch rather than a round of its own: a dependency is almost always a sibling under the
same Feature, so the ids are usually already being fetched and the whole thing costs no extra
request. Providers that track no dependencies (GitHub, the fake) leave it `undefined`, which every
reader treats as "no order stated" — the flat-tracker path is byte-for-byte what it was, and is
distinct from the `[]` a board that tracks dependencies reports for an item that waits on nothing.

These edges are **authoritative and re-read every hydration**. They are not stored as part of the
sequence and they are not the sequencer's to change: a person drew them, and a proposal that
contradicted one would be the harness overruling the board it is supposed to be reading.

### The sequencer

Most boards have no dependency links at all, which is the case this feature exists for. One desk
agent per Feature — rule `feature-sequence` (`src/dispatcher/rules/featureSequence.ts`), origin
`issue:<n>:sequence` — reads the Feature's description and its watched children and proposes the
rest of the order. It runs only at `issueSequencing: full`; at `links` there is nothing for it to
propose, because every edge was drawn by a person.

Two Features are never asked about: one with a **single story**, where an order is a question with
one arm, and one above `issueSequenceMaxChildren`, where the prompt would not fit and the order
would not be read. Both are refusals to spend rather than gates on correctness — the Feature keeps
the ordering it has, which is none.

What the agent is shown — the Feature's goal, each story's own text, and the Predecessor links the
board already states, **marked as the board's own** — is _appended_ to the rendered prompt
(`src/sequence/dossier.ts`), never interpolated. An override that never learned a `{stories}` token
would drop it in silence, on exactly the deployments that customised most, and leave an agent asked
to order a list it was never given ([09](09-execution.md)). The links are marked because an agent
that could not tell them from its own guesses would restate them as inferences, and the provenance
would be lost a layer before an operator ever saw the card.

It is **`feature-summary`'s shape throughout** (`src/dispatcher/rules/featureSummary.ts`,
`src/summaries/featureSummary.ts`), deliberately, because that rule already solved this rule's hard
parts: a desk agent with no branch and no worktree, triggered by a standing-key comparison rather
than an event, ranked at the bottom of the pipeline, failing open and silent. What differs is the
key and what the agent may write.

**The trigger is membership, not movement.** `featureSequenceKey` (`src/sequence/sequence.ts`)
digests **which** stories are under the Feature — settled ones counted alongside the rest — and what
the provider says about them, never how any of them is going. A story merging does not invalidate an
order; a story being _added_ does, and so does the board gaining a Predecessor link, because what was
accepted was an order over a set of statements and the statements have changed. What the rule does with
that firing — the primed arm, and when the acceptance carries — is [a story is added](#a-story-is-added).

That is the whole difference from the summary's key, which digests standings precisely because a
summary is about movement: re-proposing an order every time a child landed would ask an operator to
re-accept the same sequence eight times.

**It may decline to order.** An agent that cannot support an order from the items' own text says so
and proposes them all parallel. This is `isOrphanIssue`'s discipline one tier up
([06](06-issue-pickup.md#hierarchy)): the harness reports what it can see and does not invent the
structure, because a fabricated edge is the one mistake that would be invisible in the resulting
work — a story that simply never starts, with nothing red.

## The record

`src/store/sequences.ts`, two tables.

`feature_sequences` — one row per Feature: the Feature's own `issue:<n>`, `status`, the sequencer's
stated reason, what it was unsure about, the standing key it was written against, and who answered
it and when.

A rewrite keeps `createdAt` and **drops the answer**. When a Feature was first sequenced is a
different fact from when its current order was written, and the card shows both; the acceptance is
not carried forward, because an approval given for one set of edges must never end up holding work
under another.

| Status     | Meaning                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `proposed` | An agent has written an order and nobody has answered. **Holds nothing.**                                                             |
| `accepted` | A person accepted it. This is the only status the gate reads.                                                                         |
| `declined` | A person said to run them all. Holds nothing, and is remembered so the same standing is not proposed again. → [declining](#declining) |

`feature_sequence_edges` — one row per edge: the Feature, the dependent issue, the issue it depends
on, `source` (`link` | `inferred`), and the sequencer's one-line reason for that edge. A story with
no row depends on nothing and is in the first wave.

The sequencer's own submissions are **always `inferred`**, whatever it says: an agent that could
mark its own guess as a person's statement would defeat the distinction the column exists to keep.

### Waves are derived, never stored

The cockpit's "wave 2 of 4" is **depth in the edge graph**, computed on read the way `partDepth`
computes a part's depth from its `dependsOn` slugs (`src/plans/parts.ts`). Storing a wave number
would be a second answer to a question the edges already settle, and the two would part company the
first time an edge was amended.

Waves are the right vocabulary for the surface because they are honest about parallelism: everything
at one depth runs together. A numbered list would read as a chain and would quietly claim an order
between two stories nobody ordered.

### A cycle is refused at ingestion

Edges that form a cycle are rejected when the sequencer submits them, with the cycle named back to
the agent, and **nothing is stored**. `partDepth` is cycle-safe and returns a depth anyway, which is
correct for a plan whose parts are already in flight; here there is nothing in flight yet and a
sequence that silently linearised a cycle would hold work in an order no one chose.

## Readiness and the hold

`sequenceReadiness(edges, world)` in `src/sequence/readiness.ts` is pure over the edges plus the
world: for each story, the predecessors it is still waiting on. `linkEdges` beside it is where the
provider's own `Issue.dependsOn` becomes those edges — a self-edge dropped, since it would hold its
own story for good and there is nothing an operator could do about it from here.

**A predecessor is satisfied when it is settled, or when it is in flight and has pushed a branch** —
`dependencySatisfied`'s rule exactly (`src/plans/parts.ts`). Waiting for a merge would serialise a
feature into a queue of one; waiting for a branch lets the successor stack on work already underway,
which is what makes a four-wave sequence finish in less than four times one story.

For a **story**, "has pushed a branch" is read as `openPrForIssue` — an open pull request. That is
the whole of what the dispatcher can see: it reads no git, and a goal's branch announces itself to
it as a pull request. It errs towards satisfied, which is the direction every uncertainty here errs
in.

The verdict rides on `StageContext.sequenceWaits` for later stages to read, and it is computed
**once**, in the
dispatcher's context assembly, beside `routes` and `eligibleIssues`. It is not a second opinion
formed inside a rule: `issue-plan` and `issue-pickup` both consult it and must never disagree about
whether a story is ready, exactly as they must never disagree about which plan arm it is on
([05](05-dispatcher.md#the-rule-book)).

### A held story is queued, not skipped

`issue-pickup` and `issue-plan` push their candidate with `held: 'sequenced'` and a reason naming
what it waits behind — `Held: waits on #593, which has not pushed a branch yet.`, appended to the
rule's own reason so the row still says what the work _is_ before it says why it is not going out
(`sequenceHoldReason`). It is a new
member of `RuleHeld` (`src/dispatcher/admission.ts`), beside `superseded` and `unapproved`.

Queued rather than skipped, for `capped`'s reason: a dispatch that silently never appears is
invisible, and an operator looking at an idle fleet and a full board has nothing to read. A held
candidate stays in Up next with its reason attached.

**It is not routed through `consider`.** The cooldown has no bearing on a pickup that is not going
out this cycle for a different reason entirely, and spending an attempt cap on a suppressed dispatch
would blame the pickup for the sequence's hold — the same argument `issue-pickup` already makes for
`superseded`.

## Fail open

Every one of these leaves **every story eligible, in exactly the order it has today**:

- no sequence row for the Feature;
- a sequence `proposed` but not accepted, or `declined`;
- a sequencer that crashed, was killed, or spent its attempt cap;
- an edge naming an issue the world does not hold;
- a cycle, a self-edge, or an edge naming a story the Feature does not have — all refused at
  ingestion with nothing stored;
- `issueSequencing` off, which is the default.

This is `resolvePlanRoute`'s discipline ([08](08-planning.md#the-four-arms)): a planner that fails
falls through to `single` rather than parking the issue. A mechanism that adds ordering must never be
able to park a Feature, because the failure it would cause — a feature nobody works, with nothing
red — is worse than the disorder it exists to fix.

Fails **silent**, `feature-summary`'s rule: no escalation is raised for a sequence that did not
happen. There is nothing a person can do about it that they cannot do by reading the board, and an
inbox item per unsequenced Feature would be a queue of chores generated by a feature nobody asked
for.

## Proposing it

A sequence reaches a person before it holds anything. The proposal is drawn on the Feature's card
and carries four things, and the last two are the ones that make it answerable:

- **the order**, as waves, each edge marked `from a tracker link` or `inferred`;
- **why this order** — the sequencer's reason, in its own voice;
- **what it was unsure about** — the edge it would most like argued with, and what would change its
  mind. `openQuestions`' job on the plan document ([08](08-planning.md#the-seven-narrative-fields)):
  an order with no stated doubt is one nobody can disagree with usefully;
- **what accepting costs** — how many stories would start now and will not if this is accepted.
  Without it the operator is agreeing to a hold whose size is not on the card.

Three answers, because nothing else ends it: **accept**, **discuss**, **decline**. Until the card
exists, accept and decline arrive at `POST /api/features/:number/sequence` (`src/sequence/answer.ts`),
which takes those two and not `proposed` — an agent writes that status and nothing else may, and a
route that accepted it would let the cockpit put a Feature back to unanswered, which is not a thing
a person means.

### Declining

`declined` is a real answer, not a dismissal, and it is stored. "Run them all" is what an operator
says about a feature whose stories genuinely are independent, and a proposal that came back on the
next pulse would make the fleet argue with them once a Feature until they gave in.

It is scoped to the standing key it declined, so a Feature that gains three new stories is proposed
again — the thing declined was an order over a set, and the set has changed.

## Amending it

There is no drag-to-reorder. An accepted sequence is changed by **talking to Claude Code**, which is
the door a plan is already amended through ([08](08-planning.md#discussing-a-plan)): the card carries
a `Discuss…` deep link (`web/src/components/DesktopLink.tsx`), the operator's own session opens on
the Feature, and it writes through `sequence_read` and `sequence_amend` on the desktop channel
(`src/mcp/desktopSequence.ts`, mounted in `src/mcp/desktopTools.ts` under `DESKTOP_TOOL_NAMES` —
never `buildTools`). The session dispatches nothing.

An amendment **replaces the whole order** rather than patching it, `plan_amend`’s shape: an edge
dropped from what is sent has to disappear, and a merge would leave it behind indistinguishable from
one still meant. It lands `accepted`, because the person making it is the person who would have
accepted it, and its edges are marked `operator` — never `inferred`, which would claim an agent
guessed at a judgement a person made. An **empty** order is how the operator says the stories are
independent after all, and it releases everything the previous one held.

That is the right shape rather than the cheap one. Reordering is a judgement with a reason behind it,
and the reason is the half worth keeping: a drag records that the order changed and loses why, which
is exactly what the next person to read the Feature needs. It also removes a surface — no reorder
route, no per-wave editing state on `Place`, nothing in the cockpit that writes an order.

The fleet's own channel gets `sequence_submit` (`src/mcp/tools/sequenceSubmit.ts`), named in
`buildTools` **and** in `MCP_TOOL_NAMES` (`src/mcp/names.ts`), authorised structurally against the
origin the caller was dispatched on — `validation_report`'s identity rule
([11](11-mcp-tools.md#identity)). It always writes `proposed`. There is no arm that accepts: an order
holds work, and nothing the fleet says about its own output may hold work.

## Precedence

Four things now have an opinion about which story is worked next. In force order, strongest first:

| Rank | Statement                     | Beats a sequence because                                                                                           |
| ---- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1    | A goal's priority flag        | An operator naming one goal the priority is a standing instruction about that goal.                                |
| 2    | The operator's drag           | Dragging a **held** story to the top is the operator saying "go now" — an explicit override of the harness's hold. |
| 3    | The accepted sequence         | The hold.                                                                                                          |
| 4    | `issuePriorityLabels`, number | Ranking among what is already eligible. It never withheld anything and does not start now.                         |

Rows 1 and 2 already rank ahead of the natural order (`src/dispatcher/priorityOverride.ts`,
`src/dispatcher/goalPriority.ts`). What is new is that they also **clear the hold**: an origin the
operator has flagged or dragged is dispatched even when the sequence would have held it, and the
sequence is not amended by that — one story going early is not a new order.

## What it never writes

- **No work-item state.** The obvious shortcut is to promote the next story to `Ready`. It is
  refused: `pickupStates` is the operator's statement about their board, and moving items on someone
  else's project on the strength of an inferred edge is a loud, outward-facing failure. An operator
  who wants that behaviour states it with `pickupStates` themselves, which already sequences a board
  perfectly well by hand ([06](06-issue-pickup.md#issuepickuppolicy)).
- **No Predecessor links.** The harness reads the tracker's hierarchy and dependencies and never
  writes them. Writing an inferred edge back would make the harness's guess indistinguishable from
  the team's intent on the next hydration — its own output folded back in as evidence, which is
  `PoolDesk`'s failure ([28](28-cross-fleet-pool.md)) in a place with no reading to catch it.
- **No comment on the ticket.** An order is a harness-side scheduling decision; the board is not
  where it belongs.

## A story is added

The trigger is already there — `featureSequenceKey` digests membership, so a story being added
changes the key and the rule fires. What this section is about is the two things that would
otherwise make that firing worse than useless.

### The sequencer is primed, never asked cold

A Feature that already has an accepted order takes the **`feature-resequence`** arm of the rule.
The distinction is `issue-replan`’s ([08](08-planning.md)) — whether there is an existing answer to
work _from_ — and so is the failure it avoids: a planner asked cold re-derives a decomposition and
gives the parts new slugs, stranding the ones in flight; a sequencer asked cold re-derives an order
and gives the same decisions different answers, putting a judgement somebody already made back in
front of them.

The order that stands is **appended** to the prompt with the stories (`src/sequence/dossier.ts`),
every edge with the reason it was written under, and the stories the order has never seen are
marked `**new**`. The prompt then asks the narrow question — where do the new ones go — rather than
the broad one.

A `declined` order is deliberately not shown. It is not an order the operator holds; it is them
saying to run the stories in parallel, and quoting it as something to preserve would invite exactly
the edges they refused.

### An extension keeps the acceptance

`resequenceVerdict` decides whether a re-proposed order goes back to a person or holds work
immediately, and it is a **mechanical property, not a judgement**. The acceptance carries only when
the new order is provably the old one extended:

- every edge the operator accepted, between two stories the Feature still has, is still there — a
  dropped edge un-holds work they chose to hold;
- every edge that is new **touches a story that is new** — an edge added between two stories they
  already ruled on is a change of opinion about work they answered, whatever else it leaves alone.

Anything else is a fresh proposal, and so is every uncertainty: a previous order nobody accepted,
and one written before the harness recorded which stories it covered.

The reason this arm exists at all is the failure `declined` exists to prevent, one door over. A
Feature that gains a story every few days would otherwise put the same question to an operator once
a week until they stopped reading it, and an approval nobody reads is worse than no approval — it
is the hold standing on a click rather than on a decision. Re-asking about an order nobody changed
is not a question, it is a chore.

The direction of the risk is stated rather than assumed. Carrying wrongly holds work the operator
did not agree to; asking unnecessarily costs a click. So every arm that cannot prove the extension
asks — which is what every row did before this existed.

### What the record needed for it

`feature_sequences.members` — the stories an order was written over, settled ones included. The
edges alone cannot answer it: a story in the first wave has no row, so an order built only from
edges cannot tell a story it deliberately left unordered from one it has never seen.

It is an additive `ALTER TABLE` on an existing table, declared in `SEQUENCE_COLUMNS`
(`src/store/sequences.ts`) — the standing warning that a table being new _once_ does not keep it
exempt, arriving. **Nullable, and owed no backfill**: null is exactly what every row written before
it meant, which is that the order does not say which stories it covered, and the one reader treats
that as "cannot say" and asks. → [14](14-persistence.md#when-a-null-means-something)

## The cockpit

### The Feature page

The sequence **groups the children list that is already on the card** — it does not add a second
list of the same stories (`web/src/components/FeatureBoard.tsx`). Two lists of the same stories in
different orders are two answers to "what is under this Feature", and a reader would have to work
out which to believe. The existing columns are unchanged; what is new is a wave header row above
each group and, under a held story, a row saying what it waits behind. Within a wave the board's own
ordering stands: a sequence says which stories go together and has no opinion about which of two
that can both start is the more interesting to look at.

Only an **accepted** order groups the list. A proposal holds nothing, so drawing the rows under one
as though it did would show an operator the shape of a decision they have not taken.

Above it sits the proposal itself while one is open — the order as waves, the sequencer's reason,
what it was unsure about, every edge marked `tracker link` or `inferred`, what accepting costs, and
**Accept** / **Run them all**. Answered, it collapses to one line saying which, because the answer's
whole consequence is the wave rail below it or its absence.

A Feature with no sequence at all draws none of this — the flat children list, exactly as today.
Neither does the orphan bucket, which is not a Feature: an order is a statement about the stories
under one.

### The Goal page

A copy of the same sequence, with this goal highlighted, **folded shut by default** — `Environments`'
treatment ([17](17-cockpit.md)) — because a story's own page is read for the story, not for its
neighbours.

The folded reading is the whole point of folding it: `wave 2 of 4 · 2 waiting on this`. A goal
nothing is waiting on says so without being opened, which is the `0/3 reached` case; `2 waiting on
this` is the reason to open it. The Feature's ref sits on the shut header, so the way up does not
require expanding.

Opened, it draws the two sides of this goal and nothing else: what it waits on, and what waits on
it. Both are **direct**, never transitive — "2 waiting on this" has to be a number the card in front
of the operator adds up to, and a transitive count is one nothing on the page shows. The whole order
belongs on the Feature, and repeating it here would be a second list with no way to act on it.

The sequence reaches this page on the **state snapshot** (`featureSequences`) rather than through
`/api/features`, because the Goal page is assembled client-side from that snapshot: an order
reachable only through the feature board's own fetch could not be drawn beside the story it holds.

Waves are derived where they are drawn (`web/src/view/sequence.ts`), from the edges the wire ships —
`layoutFloor`'s arrangement, and for its reason.

## Configuration

| Key                        | Default | What it does                                                                                                           |
| -------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `issueSequencing`          | `off`   | `off` — no sequencer, no hold. `links` — honour the tracker's dependency links only. `full` — links and the sequencer. |
| `issueSequenceMaxChildren` | `40`    | Above this a Feature is not sequenced: the prompt would not fit and the order would not be read.                       |

`links` exists as its own level because it is the setting with no inference in it at all. A team
that already draws Predecessor links gets the whole gate, deterministically, with no agent spend and
nothing to accept — and a sequence built only from links is `accepted` on arrival, since a person
drew every edge in it.

## Persistence

Both tables are new, so `CREATE TABLE IF NOT EXISTS` is sufficient and no `ColumnMigrations` entry
is owed — but `Issue.dependsOn` is a hydration field and not a column, so nothing on `tracker_items`
changes either. → [14](14-persistence.md#migrations)

`feature_sequence_edges` rows are deleted and rewritten as a set when a sequence is submitted or
amended, never merged: an edge dropped from an amended order must disappear, and a merge on
(dependent, dependsOn) would leave it behind indistinguishable from one still meant.

A child that is re-parented out of the Feature drops its edges with it. An edge whose endpoint the
world no longer holds is ignored on read rather than deleted, because a story invisible for a pulse
is not a story that has gone.

## Tests

`test/storySequencing.test.ts` and `test/featureSequence.test.ts`, at the `RuleDispatcher` seam —
where the queue's other held reasons are asserted (`test/dispatchPipeline.test.ts`), because a hold
is a statement about the queue and nothing about it needs a worktree or an agent:

- a held story is queued as `held: 'sequenced'` and is **not** dispatched;
- the same story dispatches once its predecessor pushes a branch, before any merge;
- every fail-open arm above dispatches everything;
- a flagged or dragged origin dispatches through a hold, and a drag clears **only** that hold;
- the planner is held by the order too, and says so rather than blaming a cooldown;
- a cycle, a self-edge and a story the Feature does not have are each refused, and nothing is stored;
- an order is rewritten as a set, and a rewrite drops the answer while keeping `createdAt`;
- a Feature with one story, and one above the cap, are not sequenced at all;
- an order extended to cover a new story keeps the acceptance; a dropped edge, an edge added between
  two stories already ruled on, an unaccepted previous order and a null `members` each ask again;
- the dossier hands the sequencer the order that stands and marks the new stories, and does not quote
  a declined one back;
- `linkEdges`, `sequenceReadiness`, `sequenceHoldReason`, `featureSequenceKey` and `resequenceVerdict`
  as pure unit tests, with no world.

The readiness function and the key are pure, so the two things most likely to be wrong — which
stories are ready, and when a Feature is re-proposed — are testable without a harness.

## What is deliberately not built

- **Ordering across Features.** An epic's features are not sequenced against each other. The unit an
  operator accepts an order for is the thing they opened, and a cross-feature order is one nobody
  would be able to read.
- **Inferring edges from the code.** The sequencer reads the tracker, not the repo. An order derived
  from imports would be an argument about the code made in a place with no code review.
- **Enforcing an order the fleet has already broken.** If two stories in different waves are both in
  flight — a drag, a flag, a sequence accepted late — nothing is killed or rolled back. The hold is
  about what starts, never about what is already running.
