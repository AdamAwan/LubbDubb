# 32 — Obstacles

**Partly built.** The spine is running: the tables, the keys and their three gates, the matcher, the
states, the intake, both delivery channels, ownership, the `blocked` verdict and the four ways an
obstacle ends. What is not yet built carries its own marker, section by section — the model desk,
the harness's own voice, and the cockpit tab.
It supersedes [27](27-knowledge.md) on landing — that document describes the claim store this
replaces, and what it says is true of the harness today; a **note** still lands there, through the
same intake, until the last of these sections is built. The change that lands the last of them deletes
[27](27-knowledge.md) and this document takes its number. Every path named here is italic until the
file exists.

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

|                 |                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| An **obstacle** | Something broken now, which a fix ends. A red base branch, a wedged runner, a flaking check, a bug nobody is on. It gets an owner, and it closes. |
| A **note**      | Something true of the repository that the repository does not say. It has no owner and ends by being written down.                                |

One intake for both, and the discriminator is a single boolean the agent can always answer — _would a
fix make this go away?_ Not two tools: an agent choosing a shelf is an agent choosing wrongly, which
[27](27-knowledge.md#the-intake-asks-nothing-an-agent-cannot-answer) established at the cost of
finding out.

The bet the whole design rests on: **the expensive thing is a turn, not a byte.** Anything an agent
would spend a round trip discovering is pushed to it instead.

## What went wrong last time

The store this replaces is not a bad implementation of this design. It is a good implementation of a
different one, and naming the differences is what keeps them from coming back.

| It did                                                                                                                                                              | And so                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gated every durable claim on an operator's click                                                                                                                    | Its output when nobody visited the page was exactly zero. Neglect had no degraded mode.                                                                                                |
| Matched claims on **prose** (`claimsMatch` in `src/claims.ts`: equality or containment above a 24-character floor)                                                  | Two agents who hit one wall and wrote it down in their own words filed two singletons. _"there's a flakey test"_ normalises to a 21-character key and can never match anything at all. |
| Named `raise` and `knowledge_ask` only inside the injected block, which renders as `''` when nothing is injected (`renderKnowledgeBlock`, `src/knowledge/block.ts`) | An empty store told no agent the tools existed, so nothing was written, so the store stayed empty. Self-sealing.                                                                       |
| Answered _what does the fleet know_                                                                                                                                 | The question an operator opens a page to answer is _what is on me_, and the question an agent has is _is this already known_. Neither was the one being answered.                      |
| Never acted — "no rule, desk or gate reads a fact" ([27](27-knowledge.md#what-nothing-does))                                                                        | The fleet was **told** the base was red and each agent decided alone what to do about it. Telling thirty agents a thing is not the same as stopping thirty agents doing the same work. |

Two of those are the ones to keep hold of. **Identity cannot rest on prose**, and **a state whose only
exit is a person is a state that fills up**.

## Identity is a key

An obstacle is identified by a **key**: a fact about the world, not a sentence about it.

| Kind        | Value                                                                                                      | Checked against                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `check`     | The provider's own check name                                                                              | the checks the provider is reporting                        |
| `test`      | File plus test name                                                                                        | the suite's own reporting                                   |
| `path`      | A repository path                                                                                          | the tree                                                    |
| `signature` | The normalised first line of an error — paths relativised, hex, numbers and timestamps blanked, lowercased | nothing — [suggestion-only](#signature-and-cmd-do-not-bind) |
| `cmd`       | The command that failed                                                                                    | nothing — [suggestion-only](#signature-and-cmd-do-not-bind) |

**A key resolves to exactly one obstacle**, which is what makes deduplication an index lookup rather
than a judgement. The uniqueness constraint is on `value` in `src/store/obstacles.ts`, and the claim
is made inside the synchronous write `CLAUDE.md` already guarantees: insert the keys, read back
which obstacle won, attach the loser's report to the winner. Two agents reporting in the same
millisecond cannot both create a row, and neither waits.

**The value is the identity; the kind is a column beside it.** Two agents may reasonably disagree
about whether something is a flaking test or a broken check, and if the kind were part of the index
that disagreement would split one obstacle into two — the prose problem rebuilt with a smaller
vocabulary. `check:test (windows)` and `test:test (windows)` are one key. The kind is recorded
because it says what was checked against what, and it is read by nothing that matches.

**An obstacle may hold several keys.** A check name and a signature and a path are three ways into
one thing, and a report carrying any of them joins.

### A key alone is not always enough

A key coarse enough to catch everything catches everything, and then the fleet is told that a genuinely
new failure is already owned. That failure is silent — the swallowed report is answered _stand down_,
nobody fixes it, and nothing is red.

So a `check` key **never binds on its own**. It must co-occur with a `test` or a `path` key to resolve
an obstacle. A report carrying only a check name **files fresh**, and the prose matcher
(`claimsMatch`, `src/claims.ts`) is run over the new row against the existing ones — its hits land in
`near[]` as suggestions and bind nothing. That is the matcher this whole document replaces, kept
where a wrong answer is a line an agent may ignore rather than a report swallowed.
`test/obstacleMatch.test.ts` holds that, because it is the guard the rest of the design leans on.

A `signature` does not rescue a bare `check`, and that is the pair of rules meeting rather than one of
them having an exception: a key that cannot bind alone cannot make another one bind either, or "does
not bind" would mean _binds when convenient_.

Matching is exact and never a prefix, which is `priorRemedies`' choice
([07](07-pull-requests.md)) and the same fragility accepted for the same reason: a check name is a
provider identifier, and a prefix match puts another job's history in front of an agent under a name
it reads as its own.

### `signature` and `cmd` do not bind

The three keys the harness can check against something — `check`, `test`, `path` — bind. The two it
cannot only ever **suggest**: they land in `near[]` and on the row, and an agent or an operator
confirms them by id.

A signature is a normalisation of somebody else's output, and the thing being normalised is outside
this repository's control: a runner image changes its error prefix, a toolchain reformats a stack
frame, and one obstacle silently becomes two — or, worse, two become one. That is the wrong-merge
failure arriving through a key rather than through a model, and the [rule about visible
mistakes](#what-may-be-decided-by-a-model-and-what-may-not) does not care which door it comes
through.

Suggestion-only is also how the question gets answered rather than argued: the rows record how often
a signature suggestion was confirmed, and a signature that has been right for a quarter is promoted
to binding by a change that says so. Starting bound and demoting later is not the same move — the bad
merges it makes in the meantime are invisible.

### Where a key comes from

Not from an agent filling in a form. An agent that has to classify its own observation is an agent
that classifies it wrongly, and a design that depends on agents being disciplined about a schema is a
design that fails quietly on the day they are not.

The key is **extracted from what the agent wrote and then validated**, and both halves matter:

- **Extracted** by the harness, from the agent's own sentence plus the dispatch it came from. _"there's
  a flakey test"_ on a dispatch about `test (windows)` yields `check:test (windows)`.
- **Validated** against the world. A `check` key must name a check the provider is reporting or the
  dispatch is about; a `path` key must exist in the tree. A key that does not resolve is **dropped, and
  the claim is kept** — never refused. A refusal an agent cannot satisfy is a report that was never
  filed, and that is the one loss this store cannot recover from.
- **Grounded**, which is the third half. A key must be consistent with what the harness already knows
  about that dispatch — the checks it was dispatched about, the files its branch touches. A key outside
  that set does not bind; it is recorded as a suggestion. Validation catches nonsense, not plausible
  error, and a _plausible_ wrong key is a silent wrong merge arriving through the back door.

An agent may name keys itself, and they go through the same three gates.

The gates are `src/obstacles/keys.ts`, run against what the harness already holds
(`src/obstacles/world.ts`): the world model's own reading of the checks, `Task.ciChecks` for the
dispatch, `listGoalFiles` for the branch, and the checkout for the tree. Two readings of the general
rule are worth stating, because both could have gone the other way:

- **A `test` key is validated against the tree**, on its file half, and not against the suite's own
  reporting. The harness holds no registry of test names, so a gate that claimed to check one would
  be a gate that checked nothing. A key with no file in it is dropped: identity here is a fact about
  the world, and a test name on its own is a sentence.
- **A `test` or `path` key is grounded by _either_ half of what the harness knows** — the branch's
  own files, or a `check` key on the same report that grounded. The branch alone is the wrong half
  for most honest reports: an agent saying a test is not its doing is saying precisely that the file
  is not in its diff. A grounded check is the harness's own statement that this dispatch is about
  that check, so the file named beside it is that check's reporting rather than a file the agent
  thought of. Neither half, and the key suggests.

## What may be decided by a model, and what may not

The extraction above is a language judgement, and the harness has a fleet of things that make those
cheaply. The rule that governs where they may be used is not about trust:

> **A model may do anything whose mistakes are visible.**

| Job                                                                 | Model  | Because                                                                                                                                                                                                    |
| ------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deciding two reports are one obstacle                               | **No** | A wrong merge hides one agent's report inside another's. The swallowed report is answered _already owned_, nobody fixes it, and nothing is red. A duplicate row costs a few hundred bytes and can be seen. |
| Extracting keys from prose                                          | Yes    | The output is checked against the world. A wrong key fails to resolve and falls back to prose.                                                                                                             |
| Suggesting a merge the keys missed                                  | Yes    | It is a suggestion. An agent confirms it by id, or an operator does, or nobody does and the rows stay apart.                                                                                               |
| Deciding what an obstacle is for — a ticket, a documentation change | Yes    | A wrong ticket is a ticket, and a ticket is visible.                                                                                                                                                       |
| Writing the ticket from the sightings                               | Yes    | It is prose, read by whoever reads any other ticket.                                                                                                                                                       |

The desk that does this work is _src/obstacles/desk.ts_, on the pulse, and only where the inbox is
non-empty. It is the harness's secretary and it is deliberately not its judge.

**Not yet built.** The rule holds over what is running — nothing merges on a model's say-so, because
nothing calls a model at all. The desk is a later phase; extraction today is the mechanical reading
in `src/obstacles/keys.ts`, checked against the world by the same three gates a model's output would
be.

## States

| State      | Means                                                    | Reaches an agent                                   |
| ---------- | -------------------------------------------------------- | -------------------------------------------------- |
| `sighted`  | One voice has said it. It may be that goal's own doing.  | Nobody.                                            |
| `standing` | **Two independent voices** have said it.                 | Every dispatch its keys match, and running agents. |
| `owned`    | Something is fixing it.                                  | The same, plus _do not fix it_.                    |
| `resolved` | The world cleared it, the owner landed, or a clock ran out. | Nobody. Keeps its keys.                        |
| `dormant`  | Nothing has re-reported it inside `obstacleDormantMs`.   | Nobody. Keeps its keys.                            |
| `muted`    | You said never tell the fleet this.                      | Nobody.                                            |

**A voice is a goal, or [the harness itself](#the-harness-is-a-voice)** — and a goal is counted as a
goal, never as an origin and never as an agent. `pr:412:ci` and `pr:412:comments` are two origins of
one observation, and a re-dispatch inheriting a session is one agent counted twice.
`corroborationGoal` in `src/knowledge/knowledge.ts` is the harness's one spelling of that collapse and
survives unchanged.

**Two voices, and they must be independent**, which is the whole of what the count is for. One goal
saying a thing twice is one voice; the harness observing the same transition on ten pulses is one
voice. Anything the count cannot tell apart from an echo is not a second voice.

**One report is not evidence.** It is also the case the harness cannot tell apart from an agent
mis-diagnosing its own breakage, which is why `sighted` reaches nobody.

The states and their exits are declared in `src/obstacles/lifecycle.ts`. A report moves a row to
`sighted` on the first voice, `standing` on the second, and back to `standing` from a terminal state
on a re-report; `owned` is written on the pulse by the ownership desk
(`src/obstacles/ownershipDesk.ts`), and `resolved` and `dormant` by the endings desk
(`src/obstacles/endingsDesk.ts`) below.

### The harness is a voice

Waiting for a second **agent** to notice something the harness is already watching is the fleet paying
twice for a reading it has. So the harness's own observation of the world counts as one of the two,
on the same footing as a goal and by the same rule — an independent party said it.

It is the better witness wherever it applies, because it is edge-triggered on a transition it
watches rather than on somebody happening to run into it: a check going red on a branch other pull
requests are based on, a check flapping red-then-green on one `headSha`. An obstacle the harness can
see is `standing` from the first agent's report — or before any agent reports at all.

**This is what makes the two-goal gate safe on a small fleet.** "Thirty agents in a minute" is what
makes waiting for a second voice cheap, and a fleet running four agents does not have it. What that
fleet still has is the world model, which is watching the same checks either way. What is left
waiting is the class the harness genuinely cannot witness — a bug in code nobody is touching, a line
of documentation the code stopped agreeing with — and none of those is costing an agent its session
this minute.

**Not yet built.** The sighting carries the column the transition is recorded in, and the voice count
already folds by it; nothing on the pulse writes one yet.

A harness voice is recorded as a sighting like any other, attributed to the harness rather than to a
goal, and says which transition it saw. An operator reading why a row is standing must never find
one voice that is really the same reading counted twice: the transition is the identity, so the same
check going red once is one voice however many pulses observe it still red.

**`resolved` and `dormant` are not deletions.** A matching report reopens the row at `standing` with
its whole history. That is the only way a fix that did not stick is visible as a recurrence rather
than looking like a fresh problem every time.

### Every state has an exit that is not you

This is the invariant the previous store did not have, and it is asserted rather than intended.
`sighted` decays to `dormant`. `standing` gets an owner on the pulse. `owned` resolves when the owner
lands. `resolved` and `dormant` are terminal in the sense that matters — nothing further is owed of
anyone, and the row moves again only if the world re-reports it. The one state whose exit is a person
is `muted`, and a person put it there.

`test/obstacleLifecycle.test.ts` enumerates the states and **fails when one is added without an
automatic exit**. It carves out `muted` by name, not by predicate: a second entry in that carve-out
is the failure it exists to catch, and a rule loose enough to admit one would have admitted every
state the previous store filled up with. A queue that only a human empties is exactly how the last
attempt died, and a convention would not have caught it.

## The intake

One tool. Reshaped from `raise` (`src/mcp/tools/raise.ts`), which keeps its name because an agent
asking _what do I do with this_ should keep finding one door.

| The agent supplies     | Read as                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `what`                 | One line, its own words. Required.                                                                             |
| `why_not_mine`         | Free text, required, unvalidated.                                                                              |
| `keys`                 | Optional; goes through the three gates above.                                                                  |
| `fix_makes_it_go_away` | Present and true → an obstacle. False → a note.                                                                |
| `until`                | Optional clock for something the agent believes transient. Read only by [the backstop](#how-an-obstacle-ends). |

`originRef`, `goalRef`, `branch` and the agent id come from the credential and are never arguments —
the rule every other write in the tool channel already follows ([11](11-mcp-tools.md)).

**`why_not_mine` is required and nothing reads it.** Asking the question is the intervention: an agent
that has to write down why this is not its doing checks before it answers, and the sentence is what an
operator reads later when the routing turns out wrong. A field the harness validates would be a field
the agent games.

**The agent's own frame is stripped from `what`.** _"test X is flaky and nothing to do with PR 512"_ is
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
{ status, seen_by, owner, directive, what_others_saw[], near[] }
```

`directive` is one imperative sentence, chosen by the harness and never by the agent:

| Situation                              | Directive                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owned`                                | _#841 owns this. Do not fix it. Note it and return to your task._                                                                                 |
| `standing`, unowned                    | _Two independent voices have hit this. It is not yours. Recorded — return to your task._                                                          |
| `sighted`                              | _Recorded. Nothing else has seen this, so it may be your own change: check your diff before deciding it is not. Either way, do not go fixing it._ |
| The obstacle makes the task impossible | _You cannot finish. Conclude `blocked`, naming this obstacle._                                                                                    |

The last is chosen by the agent's own `blocks_me`, and only by that: whether an obstacle makes _this_
task impossible is a fact about the task, and the harness has no reading of it. It is the same shape
as `fix_makes_it_go_away` — one thing asked of the agent that only the agent can know — and it is read
by nothing except the directive. → [blocked is an answer](#blocked-is-an-answer)

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

The harness holds the diff already (`src/fileOverlap.ts`). This is the only enforcement of _an agent
fixes what its own session broke and nothing else_ that is not a sentence in a prompt, and a sentence
in a prompt is not an enforcement.

## Delivery

Three channels, and the tool is none of them. `renderKnowledgeBlock` and the fleet-wide block it
renders are [27](27-knowledge.md)'s and stay running until the last of this document lands — they are
not this subsystem's, and nothing below is added to them.

**At dispatch, scoped to the keys.** The obstacles whose keys intersect this dispatch — the checks it
is about, the paths its goal touches — are **appended** to the rendered task prompt, never
interpolated. `loadPromptTemplates` rejects only _unknown_ placeholders, so an override written before
this existed would silently drop a `{obstacles}` token on exactly the deployments that customised most
([05](05-dispatcher.md#prompt-templates)). `dispatchFactScopes` (`src/knowledge/block.ts`) is the
existing computation of _which scopes this dispatch matches_ and is what the keys are read against, so
the scope a row is delivered on and the scope it is judged against cannot drift; the paths half is
`Store.listGoalFiles`, which is the list the intake grounds a key against for the same reason. The
scoping and the rendering are `src/obstacles/delivery.ts`, and the one call site is the executor's
prompt assembly, where every dispatch passes whatever composed it.

**Only what reaches agents is delivered** — `standing` and `owned`, asked of `reachesAgents`
(`src/obstacles/lifecycle.ts`) rather than restated, so the states that reach a prompt and the states
the intake answers _it is not yours_ on cannot drift. A `sighted` row reaches nobody. A `signature` or
a `cmd` key delivers nothing either: a key that may not resolve an obstacle may not decide who is told
about one, or "does not bind" would mean _binds when convenient_.

**Mid-session, to a running agent.** A desk sends into a live session when — and only when — a state
change alters what that agent should do: an obstacle it reported becomes `owned` or `resolved`, or one
reaches `standing` whose keys match the checks its dispatch is about. It lands at the next turn
boundary; a turn cannot be interrupted, and one turn is a latency worth accepting rather than
designing around. The decision is `src/obstacles/notices.ts` and the desk that sends it is
`src/obstacles/noticeDesk.ts`, on the pulse above `decide` for the reason the notice desk sits there:
an agent dispatched on this pulse reads the board in its own prompt rather than being told it again a
moment later.

Three rules keep the channel worth reading, and `test/obstacleNotices.test.ts` fails when any of them
is broken. **Once per agent per obstacle, ever** — a notice that arrives twice reads as a second
problem. It is the primary key of `obstacle_notices` rather than a condition, and the row is claimed
_before_ the message goes out: the other order sends twice after a crash, and this one loses a notice
to an agent that is in all likelihood already gone. **Never to the reporter or the owner** — telling
the agent whose report created the row that the row exists is absurd, and so is telling the agent
dispatched to fix it to stand down from it. **Never for anything else**: a chatty channel is skimmed,
and then the message that mattered is skimmed too.

The reporter's arm is the asymmetry, and it is deliberate: what it is told is what became of **its own
report**, which is the state change that alters what it does next and the one thing it asked for.
Everybody else is told only about the transition to `standing`, and only on a check its own dispatch is
about.

**The channel is not an answer.** It types into a live session through `AgentManager.notify` and never
`respond`: an answer ends a park, moves a status and spends the "it carried on anyway" record, and an
agent parked on an escalation is still parked after a notice. A parked agent is skipped outright — it
is waiting on a person, and typing past that would look to the runtime exactly like the answer
arriving.

**There is no fleet-wide injected block.** Everything here is keyed, and a keyed thing is delivered to
the dispatches it is about. `renderKnowledgeBlock`, `knowledgeBlockChars` and the cost accounting over
them go with [27](27-knowledge.md) when it goes, and nothing here adds to them. Blanket context is the
wrong instrument at the sizes this harness runs against: a large instruction file is skimmed rather
than read, and adding to one makes every line in it worth less.

## Ownership

**Never an agent.** The reporting agent is not the owner, and no agent stakes a claim: a lock an agent
takes is a lock an agent forgets. Ownership is a row the harness writes, on the pulse, transactionally
on `owner IS NULL` — so _do not all pile on_ is a uniqueness constraint rather than an instruction.

A `standing` obstacle gets an owner one of two ways:

- **A ticket**, filed through `ticketFiler` (`src/tickets/filing.ts`) with the goal that hit it as a
  reference — the first goal that hit it, since the relation is one edge and that is the goal whose
  session paid for the discovery. Type, labels, assignee and the bug relation are **arguments**, never sentences in a
  prompt: a ticket without the watch label is created, linked, shown complete, and never dispatched
  for ([13](13-jobs-and-tickets.md#filing-a-ticket)). It then enters the normal funnel and is ranked
  and priced like any other goal.
- **A repair dispatch**, for an obstacle blocking the fleet now — a base branch red, three or more
  voices — through one bounded rule on origin `obstacle:<id>`. That origin is classified in
  `src/issueOrigins.ts`, without which it reads as `unrecognised`: it stops expanding under a goal's
  priority flag and its spend files under "other", and neither is red
  ([05](05-dispatcher.md#marking-a-goal-a-priority)).

That second door is a **capability**, not a convenience: a store that can queue work can put agents on
the fleet. It is one rule, in the pipeline where it can be seen, subject to the headroom cut like every
other candidate ([05](05-dispatcher.md#the-rule-book)) — never a general licence for this subsystem to
schedule things. It is bounded once more on top of the cut: **one repair in flight at a time**, across
the whole fleet, because the cut bounds how many agents run and not how many of them this rule may be.
A board that went to twenty standing rows on a bad afternoon would otherwise propose twenty repairs,
and the subsystem whose point is not spending the fleet twice on one thing would be spending it on
itself.

**The claim is the transition, and the ticket comes after it.** `Store.claimObstacle` is one
`UPDATE … WHERE state='standing' AND owner_ref IS NULL`, so two passes cannot both take one row —
filing first and claiming after would let the pulse either side of a provider round trip file a
second ticket for one obstacle. The window that opens the other way is closed at the other end: a row
left `owned` with a null owner is released at the top of the next pass, so a crash mid-filing costs a
pulse rather than a row nobody can ever own. Which door a row is at is `ownershipDoor`
(`src/obstacles/ownership.ts`), asked by the desk and by the rule, so the two cannot disagree about
what is blocking the fleet.

**The repair door is _recorded_ rather than taken.** The desk owns a row only once a task actually
exists on `obstacle:<id>` — a candidate the headroom cut never dispatched is not something fixing it,
and a row marked `owned` on the strength of one tells every agent it reaches to stand down from
something nobody is doing.

### Blocked is an answer

An agent whose task is genuinely stopped by an obstacle — the base will not build — is not helped by
_carry on_, and telling it to carry on makes it spin. `conclude_work` gains a `blocked` verdict
carrying an obstacle id: the task parks, the goal does **not** return to pickup, and a desk re-queues
it when the obstacle resolves.

**It writes no conclusion**, and that is what makes it a park rather than a failure. `done` and
`more_work` are the agent's statement about the _work_; this says the work could not be attempted, so
there is nothing to declare about whether the goal is finished — and a `more_work` row written here
would send the goal straight back to pickup, which is the next agent hitting the same wall. It is not
a fifth member of the verdict matrix ([14](14-persistence.md#issue-verdicts-and-the-exclusion-matrix))
for the same reason: those four answer _is the work finished_ and clear the ones they contradict, and
a block that cleared a delivery would hand delivered work back to the fleet.

Its exit is the **obstacle** and never the issue. `blockedGoals` (`src/obstacles/blocked.ts`) asks
`reachesAgents` rather than restating the states, so the rows a goal waits behind and the rows the
intake answers _it is not yours_ on cannot drift — `owned` still holds it, because being fixed is not
fixed. A block naming a row that is **gone** releases rather than holds: an unheld goal is a redundant
agent an operator can see, and a goal held behind an id nothing resolves is work that never comes back
with nothing red.

The directive that sends an agent here is the intake's fourth, and it is reached by the agent's own
answer to `blocks_me` — whether this stops _this_ task is a fact about the task, which the harness has
no reading of. It is the same shape as `fix_makes_it_go_away`: one thing asked of the agent that only
the agent can know, and nothing inferred from it.

That is the difference between the fleet queueing behind one obstacle and the fleet spending its
allowance on it.

## How an obstacle ends

Four endings, on the pulse, in `src/obstacles/endings.ts` (the readings) and
`src/obstacles/endingsDesk.ts` (the desk that acts on them), below the ownership desk so it reads
the owner that desk may have just written. Which one took a row is recorded on it as `endedBy`,
because the four are not interchangeable to anybody reading the board afterwards.

- **A condition the harness can evaluate**, written by the harness and never by an agent. Settling one
  means reading a world object pulse after pulse, and the only party that can promise to do that is the
  one already reading it — an agent naming a condition would be naming something nothing watches. One
  kind to start, the named check going green on the named branch; also met when the check stops being
  reported and when the pull request leaves the open set. A check sitting at `pending` does not meet
  it: a re-run in flight is not a green one. A provider reporting no per-check detail at all is *no
  reading*, never *no longer reported*, or a deployment with detail switched off would resolve its
  whole board at once — the [three verdicts](24-environments.md#the-three-verdicts) again. **Every**
  condition on a row must be met and not any of them: an obstacle red on two branches is not over
  when one goes green. The rows are `obstacle_conditions`, keyed on `(obstacle, check, branch)` so a
  still-red check re-promises nothing.
- **The owner landing**, read off the existing landing sweep (`Store.listGoalLandings`) and never off
  the merge itself. The merge SHA has a `closedPrWindowMs` shelf life, so a hook on the transition
  loses the landing to any restart that straddles it
  ([24](24-environments.md#recording-a-landing)). Only the **ticket** door is reachable this way,
  because the sweep files a landing under a goal root and a repair dispatch owns a row as
  `obstacle:<id>`, which is no goal: its own ending is the condition it was dispatched against, or
  the two below.
- **A clock, as a backstop and never as the mechanism.** The intake's `until` seeds it and nothing
  else reads that field: it expires a row that no condition and no owner ever settled, and it cannot
  resolve one early. A timer alone either drops an obstacle while it is still true, and the fleet
  rediscovers it, or keeps one alive after the fix landed, which teaches every agent to disbelieve a
  check that is now genuinely broken. Both silent. A row **said again after its deadline** has
  outlived the estimate and the clock stops applying to it: the deadline is stamped once, from the
  first report, so a row that reopens after it would otherwise be expired by the very next pulse and
  the re-report would buy nothing.
- **Decay.** No report for `obstacleDormantMs` ([02](02-configuration.md)) and no owner
  → `dormant`, read off `last_seen_at` and never `updated_at`: a row re-reported daily and never
  promoted is not dormant. The keys survive, so a re-report reopens rather than refiles.
- **A note ends by being written into the repository.** A `standing` note gets a documentation change;
  on merge it is `resolved` and leaves every prompt, because an agent reads it from the tree and keeping
  it delivered pays for one sentence twice. It is the `docs-change` template a promoted claim already
  renders, with what the voices said **appended** rather than interpolated
  ([05](05-dispatcher.md#prompt-templates)) — and the job is an ordinary one, ranked and priced like
  any other, bounded to **one in flight** for the repair rule's reason. What became of it is read off
  the work graph (`obstacle_writeups`), which remembers a merge long after `closedPullRequests` has
  forgotten it; a merge the graph only *inferred* settles nothing. One write-up per note, ever: an
  abandoned one leaves the note standing to decay, where a retry every pulse would be the subsystem
  whose point is not spending the fleet twice on one thing spending it on itself.

**A resolution fires on two consecutive real world readings**, and the resolving read is never one the
local cycle served — the desk is skipped on a local cycle, which re-serves the reading the last real
one took, and a condition found unmet clears its own stamp so *consecutive* is a fact about a column
rather than a promise. A resolution on a stale reading closes an obstacle that is still live, the
fleet pays for it again, and nothing is red.

Nothing here moves a `muted` row, and nothing restamps a row that has already ended: the guard is on
the states an ending may take, so an operator's silence is never argued with and the ending that took
a row is the first one that did, not whichever sweep noticed second.

## In the cockpit

**Not yet built.** There is no tab and no route. When there is, it is reachable by URL only —
deliberately not registered in the navbar until the operator says otherwise.

One tab, and it is **read-mostly**: _what is blocking the fleet, and what owns each one_. Not a queue,
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

**The page draws what it counts and never what it would like to.** Sightings, goals cost, dispatches
told and the rate agents call the tool are all observed. _Turns an agent did not spend_ is the figure
everyone wants and nothing measures, so it is not drawn — a number invented to sit beside four real
ones is the one thing on the page that would be a lie, and it would be the one quoted.

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

| Not                                                     | Because                                                                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A search tool for agents                                | Retrieval by guessed words is the failure mode this replaces, and a lookup is a turn.                                 |
| Embeddings, a vector store                              | Machinery for a problem that is not there across tens of live rows, and its errors are the invisible-merge kind.      |
| An agent-to-agent channel, or locks agents take         | A lock an agent takes is a lock an agent forgets.                                                                     |
| A severity an agent assigns                             | Severities from different agents are not comparable.                                                                  |
| Auto-fix by the reporter, including "it is a one-liner" | The rule has no exceptions or it is not enforcement.                                                                  |
| A durable claim store about the repository              | That is the tree, and [what went wrong last time](#what-went-wrong-last-time) is largely this.                        |
| Anything crossing to another fleet                      | An obstacle is about this repository's state right now. [28](28-cross-fleet-pool.md) is unaffected and stays unbuilt. |

## What is not settled

One thing, and it is the one the rest of this document rests on: **whether agents call the tool at
all.**

It cannot be settled by argument, because it is a fact about running agents rather than a decision
about a design. Everything else this document leaves open it decides one way and says why — that is
what the rest of these sections are — and this is the one that no amount of deciding settles. Two
things make it answerable rather than merely risky. The ask is appended to **every** dispatch
unconditionally, so the [bootstrap trap](#what-went-wrong-last-time) — an intake nobody was told
about — cannot recur. And the call rate is a figure on the page from the first day, so the
answer arrives as a number in a week rather than as an impression in a quarter.

If the number is near zero, nothing further in this document is worth building, and that is the
honest order to find it out in.
