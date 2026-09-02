# 32 — Obstacles

**Not yet built.** Nothing in this document is running code. It supersedes [27](27-knowledge.md) on
landing — that document describes the claim store this replaces, and what it says is true of the
harness today. The markers come off section by section, in the change that makes each true; the
change that lands the last of them deletes [27](27-knowledge.md) and this document takes its number.
Every path named here is italic until the file exists.

An agent working a goal runs into something that is not its goal: a test that fails for reasons that
have nothing to do with its change, a base branch someone else broke, a bug in code nobody is
touching, a line in `CLAUDE.md` the code stopped agreeing with. It has no way to find out whether
anyone else has already hit the same thing, so it works it out from first principles, acts on it
alone, and the next agent pays again. At the concurrency this harness runs at, "the next agent" is
thirty agents in the same minute.

This subsystem is that problem and only that problem. It is **not a memory of what the fleet knows** —
that is what the repository is for, and [the failure of the store this replaces](#what-went-wrong-last-time)
is largely the story of confusing the two.

## What it is

| | |
| --- | --- |
| An **obstacle** | Something broken now, which a fix ends. A red base branch, a wedged runner, a flaking check, a bug nobody is on. It gets an owner, and it closes. |
| A **note** | Something true of the repository that the repository does not say. It has no owner and ends by being written down. |

One intake for both, and the discriminator is a single boolean the agent can always answer — *would a
fix make this go away?* Not two tools: an agent choosing a shelf is an agent choosing wrongly, which
[27](27-knowledge.md#the-intake-asks-nothing-an-agent-cannot-answer) established at the cost of
finding out.

The bet the whole design rests on: **the expensive thing is a turn, not a byte.** Anything an agent
would spend a round trip discovering is pushed to it instead.

## What went wrong last time

The store this replaces is not a bad implementation of this design. It is a good implementation of a
different one, and naming the differences is what keeps them from coming back.

| It did | And so |
| --- | --- |
| Gated every durable claim on an operator's click | Its output when nobody visited the page was exactly zero. Neglect had no degraded mode. |
| Matched claims on **prose** (`claimsMatch` in `src/claims.ts`: equality or containment above a 24-character floor) | Two agents who hit one wall and wrote it down in their own words filed two singletons. *"there's a flakey test"* normalises to a 21-character key and can never match anything at all. |
| Named `raise` and `knowledge_ask` only inside the injected block, which renders as `''` when nothing is injected (`renderKnowledgeBlock`, `src/knowledge/block.ts`) | An empty store told no agent the tools existed, so nothing was written, so the store stayed empty. Self-sealing. |
| Answered *what does the fleet know* | The question an operator opens a page to answer is *what is on me*, and the question an agent has is *is this already known*. Neither was the one being answered. |
| Never acted — "no rule, desk or gate reads a fact" ([27](27-knowledge.md#what-nothing-does)) | The fleet was **told** the base was red and each agent decided alone what to do about it. Telling thirty agents a thing is not the same as stopping thirty agents doing the same work. |

Two of those are the ones to keep hold of. **Identity cannot rest on prose**, and **a state whose only
exit is a person is a state that fills up**.

## Identity is a key

An obstacle is identified by a **key**: a fact about the world, not a sentence about it.

| Kind | Value | Checked against |
| --- | --- | --- |
| `check` | The provider's own check name | the checks the provider is reporting |
| `test` | File plus test name | the suite's own reporting |
| `path` | A repository path | the tree |
| `signature` | The normalised first line of an error — paths relativised, hex, numbers and timestamps blanked, lowercased | nothing; see below |
| `cmd` | The command that failed | nothing; see below |

**A key resolves to exactly one obstacle**, which is what makes deduplication an index lookup rather
than a judgement. The uniqueness constraint is on `(kind, value)` in _src/store/obstacles.ts_, and the
claim is made inside the synchronous write `CLAUDE.md` already guarantees: insert the keys, read back
which obstacle won, attach the loser's report to the winner. Two agents reporting in the same
millisecond cannot both create a row, and neither waits.

**The key is the identity; the kind is a label.** Two agents may reasonably disagree about whether
something is a flaking test or a broken check, and if the kind were part of the match key that
disagreement would split one obstacle into two — the prose problem rebuilt with a smaller vocabulary.
Matching is on the key alone.

**An obstacle may hold several keys.** A check name and a signature and a path are three ways into
one thing, and a report carrying any of them joins.

### A key alone is not always enough

A key coarse enough to catch everything catches everything, and then the fleet is told that a genuinely
new failure is already owned. That failure is silent — the swallowed report is answered *stand down*,
nobody fixes it, and nothing is red.

So a `check` key **never binds on its own**. It must co-occur with a `test`, `path` or `signature` key
to resolve an obstacle; a report carrying only a check name joins on containment or files fresh.
_test/obstacleMatch.test.ts_ holds that, because it is the guard the rest of the design leans on.

Matching is exact and never a prefix, which is `priorRemedies`' choice
([07](07-pull-requests.md)) and the same fragility accepted for the same reason: a check name is a
provider identifier, and a prefix match puts another job's history in front of an agent under a name
it reads as its own.

### Where a key comes from

Not from an agent filling in a form. An agent that has to classify its own observation is an agent
that classifies it wrongly, and a design that depends on agents being disciplined about a schema is a
design that fails quietly on the day they are not.

The key is **extracted from what the agent wrote and then validated**, and both halves matter:

- **Extracted** by the harness, from the agent's own sentence plus the dispatch it came from. *"there's
  a flakey test"* on a dispatch about `test (windows)` yields `check:test (windows)`.
- **Validated** against the world. A `check` key must name a check the provider is reporting or the
  dispatch is about; a `path` key must exist in the tree. A key that does not resolve is **dropped, and
  the claim is kept** — never refused. A refusal an agent cannot satisfy is a report that was never
  filed, and that is the one loss this store cannot recover from.
- **Grounded**, which is the third half. A key must be consistent with what the harness already knows
  about that dispatch — the checks it was dispatched about, the files its branch touches. A key outside
  that set does not bind; it is recorded as a suggestion. Validation catches nonsense, not plausible
  error, and a *plausible* wrong key is a silent wrong merge arriving through the back door.

An agent may name keys itself, and they go through the same three gates.

## What may be decided by a model, and what may not

The extraction above is a language judgement, and the harness has a fleet of things that make those
cheaply. The rule that governs where they may be used is not about trust:

> **A model may do anything whose mistakes are visible.**

| Job | Model | Because |
| --- | --- | --- |
| Deciding two reports are one obstacle | **No** | A wrong merge hides one agent's report inside another's. The swallowed report is answered *already owned*, nobody fixes it, and nothing is red. A duplicate row costs a few hundred bytes and can be seen. |
| Extracting keys from prose | Yes | The output is checked against the world. A wrong key fails to resolve and falls back to prose. |
| Suggesting a merge the keys missed | Yes | It is a suggestion. An agent confirms it by id, or an operator does, or nobody does and the rows stay apart. |
| Deciding what an obstacle is for — a ticket, a documentation change | Yes | A wrong ticket is a ticket, and a ticket is visible. |
| Writing the ticket from the sightings | Yes | It is prose, read by whoever reads any other ticket. |

The desk that does this work is _src/obstacles/desk.ts_, on the pulse, and only where the inbox is
non-empty. It is the harness's secretary and it is deliberately not its judge.

## States

| State | Means | Reaches an agent |
| --- | --- | --- |
| `sighted` | One goal has said it. It may be that goal's own doing. | Nobody. |
| `standing` | Two different **goals** have said it. | Every dispatch its keys match, and running agents. |
| `owned` | Something is fixing it. | The same, plus *do not fix it*. |
| `resolved` | The world was observed to clear it, or the owner landed. | Nobody. Keeps its keys. |
| `dormant` | Nothing has re-reported it inside `obstacleDormantMs`. | Nobody. Keeps its keys. |
| `muted` | You said never tell the fleet this. | Nobody. |

**Two goals, counted as goals** — never origins and never agents. `pr:412:ci` and `pr:412:comments`
are two origins of one observation, and a re-dispatch inheriting a session is one agent counted twice.
`corroborationGoal` in `src/knowledge/knowledge.ts` is the harness's one spelling of that collapse and
survives unchanged.

**One report is not evidence.** It is also the case the harness cannot tell apart from an agent
mis-diagnosing its own breakage, which is why `sighted` reaches nobody. At this fleet's concurrency
that is not a delay worth designing around: the second goal arrives in minutes. On a quiet fleet it
is, and [that is an open question](#what-is-not-settled).

**`resolved` and `dormant` are not deletions.** A matching report reopens the row at `standing` with
its whole history. That is the only way a fix that did not stick is visible as a recurrence rather
than looking like a fresh problem every time.

### Every state has an exit that is not you

This is the invariant the previous store did not have, and it is asserted rather than intended.
`sighted` decays to `dormant`. `standing` gets an owner on the pulse. `owned` resolves when the owner
lands. `resolved` and `dormant` are terminal. The only state whose exit is a person is `muted`, and a
person put it there.

_test/obstacleLifecycle.test.ts_ enumerates the states and **fails when one is added without an
automatic exit**. A queue that only a human empties is exactly how the last attempt died, and a
convention would not have caught it.

## The intake

One tool. Reshaped from `raise` (`src/mcp/tools/raise.ts`), which keeps its name because an agent
asking *what do I do with this* should keep finding one door.

| The agent supplies | Read as |
| --- | --- |
| `what` | One line, its own words. Required. |
| `why_not_mine` | Free text, required, unvalidated. |
| `keys` | Optional; goes through the three gates above. |
| `fix_makes_it_go_away` | Present and true → an obstacle. False → a note. |
| `until` | Optional clock for something the agent believes transient. |

`originRef`, `goalRef`, `branch` and the agent id come from the credential and are never arguments —
the rule every other write in the tool channel already follows ([11](11-mcp-tools.md)).

**`why_not_mine` is required and nothing reads it.** Asking the question is the intervention: an agent
that has to write down why this is not its doing checks before it answers, and the sentence is what an
operator reads later when the routing turns out wrong. A field the harness validates would be a field
the agent games.

**The agent's own frame is stripped from `what`.** *"test X is flaky and nothing to do with PR 512"* is
written for the reader of PR 512, which is the one place the claim will never be needed again, and the
ref inside it is what no other agent's wording can match. `stripOwnFrame` (`src/knowledge/frame.ts`)
already does exactly this, against a closed list of function words, and survives unchanged. The
original sentence is kept verbatim as the sighting's own words.

### Reporting is the lookup

There is no search tool, and that is a decision rather than an omission. An agent does not search on a
hunch, and searching requires it to guess the words somebody else used — the failure `knowledge_ask`
had. It calls something the moment it is in pain, so the pain call returns the answer, in one round
trip, with no model call and no waiting:

```
{ status, seen_by_goals, owner, directive, what_others_saw[], near[] }
```

`directive` is one imperative sentence, chosen by the harness and never by the agent:

| Situation | Directive |
| --- | --- |
| `owned` | *#841 owns this. Do not fix it. Note it and return to your task.* |
| `standing`, unowned | *Two other goals have hit this. It is not yours. Recorded — return to your task.* |
| `sighted` | *Recorded. Nothing else has seen this, so it may be your own change: check your diff before deciding it is not. Either way, do not go fixing it.* |
| The obstacle makes the task impossible | *You cannot finish. Conclude `blocked`, naming this obstacle.* |

`near[]` names rows a suggestion linked but no key merged, with their ids, so the agent may agree with
one directly. **The report is filed either way** and never held pending a reply: a round trip is a
report that may never come back.

### Others' words are withheld until `standing`

`what_others_saw` carries up to three prior sightings in their authors' own words, and it is the whole
of the re-payment saving — the second agent gets the first agent's diagnosis in the call it was going
to make anyway, before it spends ten turns.

It is answered **only on a row that is already `standing`**. On a `sighted` row it is withheld, and
the reason is not politeness: a second agent shown the first's sentence and then counted as agreeing
with it is not independent evidence, and the count cannot see the difference. The previous store closed
this by construction — a claim reached nobody until it was promoted, so the second goal to say it
could not have read the first ([27](27-knowledge.md#corroboration)). Handing the words back at
`sighted` would open it. The promotion to `standing` is what unlocks them, and by then the two voices
that carried it there were independent.

### An agent may not report its own breakage

If a report's `path` or `test` keys intersect the agent's own branch diff, the tool **refuses**, names
the file, and records nothing.

The harness holds the diff already (`src/fileOverlap.ts`). This is the only enforcement of *an agent
fixes what its own session broke and nothing else* that is not a sentence in a prompt, and a sentence
in a prompt is not an enforcement.

## Delivery

Three channels, and the tool is none of them.

**At dispatch, scoped to the keys.** The obstacles whose keys intersect this dispatch — the checks it
is about, the paths its goal touches — are **appended** to the rendered task prompt, never
interpolated. `loadPromptTemplates` rejects only *unknown* placeholders, so an override written before
this existed would silently drop a `{obstacles}` token on exactly the deployments that customised most
([05](05-dispatcher.md#prompt-templates)). `dispatchFactScopes` (`src/knowledge/block.ts`) is the
existing computation of *which scopes this dispatch matches* and is what the keys are read against, so
the scope a row is delivered on and the scope it is judged against cannot drift.

**Mid-session, to a running agent.** A desk sends into a live session when — and only when — a state
change alters what that agent should do: an obstacle it reported becomes `owned` or `resolved`, or one
reaches `standing` whose keys match the checks its dispatch is about. It lands at the next turn
boundary; a turn cannot be interrupted, and one turn is a latency worth accepting rather than
designing around.

Three rules keep the channel worth reading. **Once per agent per obstacle, ever** — a notice that
arrives twice reads as a second problem. **Never to the reporter or the owner** — telling the agent
whose report created the row that the row exists is absurd. **Never for anything else**: a chatty
channel is skimmed, and then the message that mattered is skimmed too.

**There is no fleet-wide injected block.** Everything here is keyed, and a keyed thing is delivered to
the dispatches it is about. `renderKnowledgeBlock`, `knowledgeBlockChars` and the cost accounting over
them go with it. Blanket context is the wrong instrument at the sizes this harness runs against: a
large instruction file is skimmed rather than read, and adding to one makes every line in it worth
less.

## Ownership

**Never an agent.** The reporting agent is not the owner, and no agent stakes a claim: a lock an agent
takes is a lock an agent forgets. Ownership is a row the harness writes, on the pulse, transactionally
on `owner IS NULL` — so *do not all pile on* is a uniqueness constraint rather than an instruction.

A `standing` obstacle gets an owner one of two ways:

- **A ticket**, filed through `ticketFiler` (`src/tickets/filing.ts`) with the goal that hit it as a
  reference. Type, labels, assignee and the bug relation are **arguments**, never sentences in a
  prompt: a ticket without the watch label is created, linked, shown complete, and never dispatched
  for ([13](13-jobs-and-tickets.md#filing-a-ticket)). It then enters the normal funnel and is ranked
  and priced like any other goal.
- **A repair dispatch**, for an obstacle blocking the fleet now — a base branch red, three or more
  goals — through one bounded rule on origin `obstacle:<id>`. That origin is classified in
  `src/issueOrigins.ts`, without which it reads as `unrecognised`: it stops expanding under a goal's
  priority flag and its spend files under "other", and neither is red
  ([05](05-dispatcher.md#marking-a-goal-a-priority)).

That second door is a **capability**, not a convenience: a store that can queue work can put agents on
the fleet. It is one rule, in the pipeline where it can be seen, subject to the headroom cut like every
other candidate ([05](05-dispatcher.md#the-rule-book)) — never a general licence for this subsystem to
schedule things.

### Blocked is an answer

An agent whose task is genuinely stopped by an obstacle — the base will not build — is not helped by
*carry on*, and telling it to carry on makes it spin. `conclude_work` gains a `blocked` verdict
carrying an obstacle id: the task parks, the goal does **not** return to pickup, and a desk re-queues
it when the obstacle resolves.

That is the difference between the fleet queueing behind one obstacle and the fleet spending its
allowance on it.

## How an obstacle ends

- **A condition the harness can evaluate**, written by the harness and never by an agent. Settling one
  means reading a world object pulse after pulse, and the only party that can promise to do that is the
  one already reading it — an agent naming a condition would be naming something nothing watches. One
  kind to start, the named check going green on the named branch; also met when the check stops being
  reported and when the pull request leaves the open set. A check sitting at `pending` does not meet
  it: a re-run in flight is not a green one.
- **The owner landing**, read off the existing landing sweep and never off the merge itself. The merge
  SHA has a `closedPrWindowMs` shelf life, so a hook on the transition loses the landing to any restart
  that straddles it ([24](24-environments.md#recording-a-landing)).
- **A clock, as a backstop and never as the mechanism.** A timer alone either drops an obstacle while it
  is still true, and the fleet rediscovers it, or keeps one alive after the fix landed, which teaches
  every agent to disbelieve a check that is now genuinely broken. Both silent.
- **Decay.** No report for `obstacleDormantMs` and no owner → `dormant`. The keys survive, so a
  re-report reopens rather than refiles.
- **A note ends by being written into the repository.** A `standing` note gets a documentation change;
  on merge it is `resolved` and leaves every prompt, because an agent reads it from the tree and keeping
  it delivered pays for one sentence twice.

**A resolution fires on two consecutive real world readings**, and the resolving read is never one the
local cycle served. A resolution on a stale reading closes an obstacle that is still live, the fleet
pays for it again, and nothing is red.

## In the cockpit

One tab, and it is **read-mostly**: *what is blocking the fleet, and what owns each one*. Not a queue,
not a triage surface, and no badge counting things that are waiting on a decision — because nothing is.

Two sections. **Standing**, which is what reaches agents, and **Sighted once**, which reaches nobody,
drawn dimmed and saying when it will go dormant. Everything terminal is behind a fold that states its
own size — a tail that names itself and its count cannot be mistaken for rows that went missing, which
is what [27](27-knowledge.md#the-queue-is-the-page) spent nine open sections buying.

A row carries the claim, its keys, how many goals it cost, its owner as a reference, its state and when
it was last seen. Opening one shows the sightings **in their authors' own words**, each with its goal
and, next to it, **why it matched** — the key that bound it, or the suggestion that was confirmed. That
last is the only place the matcher can be seen working or getting it wrong, and it is the reason the
row expands at all.

Four controls, none of them on any path: **mute**, **own it** (naming a ticket you are using),
**retire**, and **write it down** for a note. Retiring is not rejecting and leaves the row saying what
it said ([27](27-knowledge.md#retiring-is-not-rejecting)); nothing here bars a claim by name, because
nothing here is a durable statement about the repository to bar.

## What nothing does

- **Nothing merges on a model's say-so.** Keys merge; a model suggests.
- **No agent owns an obstacle**, and no agent fixes one it did not cause in its own session.
- **No agent reaches the ownership or exit routes.** They are on the cockpit's bearer token and the
  pulse, not the tool channel.
- **Nothing is demoted, dropped or deprioritised by a reading.** A reading counts; it does not act.
  The states above are moved by evidence, a clock, or you.
- **Nothing is injected fleet-wide.** There is no blanket block.

## What is deliberately not built

| Not | Because |
| --- | --- |
| A search tool for agents | Retrieval by guessed words is the failure mode this replaces, and a lookup is a turn. |
| Embeddings, a vector store | Machinery for a problem that is not there across tens of live rows, and its errors are the invisible-merge kind. |
| An agent-to-agent channel, or locks agents take | A lock an agent takes is a lock an agent forgets. |
| A severity an agent assigns | Severities from different agents are not comparable. |
| Auto-fix by the reporter, including "it is a one-liner" | The rule has no exceptions or it is not enforcement. |
| A durable claim store about the repository | That is the tree, and [what went wrong last time](#what-went-wrong-last-time) is largely this. |
| Anything crossing to another fleet | An obstacle is about this repository's state right now. [28](28-cross-fleet-pool.md) is unaffected and stays unbuilt. |

## What is not settled

Stated rather than hidden, because each is a place this design could be wrong:

- **Whether agents call the tool at all.** The whole thing rests on it. The mitigation is that the ask
  is appended to every dispatch unconditionally — the [bootstrap trap](#what-went-wrong-last-time) is
  the failure to avoid — and that the call rate is a number on the page rather than an assumption.
- **Whether two goals is too slow on a quiet fleet.** "Thirty agents in a minute" is what makes
  `sighted` cheap. A fleet running four agents may wait hours for a second voice, and the first agent
  has already paid.
- **Whether `signature` normalisation is stable enough across runners to be a key**, or whether it
  drifts enough to be a suggestion only.
- **Whether turns saved can be honestly measured.** Sightings, goals cost and dispatches told are
  counted. *Turns an agent did not spend* is the number everyone wants and nothing observes, and a
  figure invented to sit beside four real ones is worse than a blank.
