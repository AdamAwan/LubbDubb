# 27 — Knowledge

Hundreds of agents work this repository and each one starts knowing nothing about it. What they learn
— that `knip` runs every rule at `error`, that a route handler never reads the request, that
`test (windows)` has been timing out at the install step all afternoon — is learned again, at full
price, by the next agent to need it. This is the record of what the fleet knows, and the four
different distances it can carry a fact.

## What this replaces

Knowledge is not a sixth store beside five others. It is those five collapsed into one, because they
are five answers to one question that share no vocabulary and cannot be read against each other.

| Today                  | Holds                                     | Reaches an agent                        |
| ---------------------- | ----------------------------------------- | --------------------------------------- |
| `lessons`              | Durable claims, operator-vouched          | Mirrored in; rides the block below      |
| `findings` kind `docs` | "The repository does not say this"        | Nothing — until an operator makes a job |
| `remedies`             | Why the fleet came back to a pull request | The next CI/review prompt, per check    |
| `scratchpads`          | Notes between siblings on one goal        | The goal's own agents, on request       |
| `retrospectives`       | The write-up of a delivered goal          | Nothing                                 |

Three of the five hold the same shape of claim — _something true of this repository that the
repository does not say_ — arriving through three tools that do not know about each other and landing
in three different places. A remedy's `undocumented` lesson and a `docs` finding were the same
sentence written twice — the remedy's half is [now raised as a fact](#the-remedy-arm), and the
finding's half waits on this merge.

**The scratchpad is not folded in.** A pad is a conversation between siblings on one goal,
chronological and unstructured; its entries are not claims, have no evidence and nothing to
corroborate. Two writable stores for one kind of content is the drift this codebase refuses
everywhere else, so the pad keeps its own writer and this page links to it. A pad note that turns out
to be durable is **proposed** as a fact by the agent that found it useful.

`remedies` survives as what it always was — the **event** record of one return to a pull request,
with its counts and its dollars ([18](18-observability.md)) — and [raises a fact](#the-remedy-arm)
under its `undocumented` guard. An account of an event and a durable claim are different animals and
folding them together would lose the counts, so it writes both and neither stands in for the other.

**The promoted lessons are already here.** A promoted `lessons` row _is_ a fleet-scoped standing claim
an operator vouched for that reaches every agent's system prompt — which is `injected`, exactly — so
`KnowledgeStore.adoptLessons` mirrors it under an id derived from the lesson's. It runs on every boot
**and** on the promote and retire routes themselves, because `lessons` keeps its own surface — a
lesson vouched for now has to reach agents at the next launch rather than at the next restart, and a
claim that silently stopped being delivered looks exactly like one nobody promoted. The mirror runs backwards
too — a lesson retired after it was adopted takes its fact with it, unless something has since
corroborated or amended it, at which point it is a fact in its own right and the lessons panel is not
where it is governed.

## Three axes, not one list

A fact carries three independent fields, and the most common way to get this wrong is to fold them
into one enum. "A flaky check" and "fleet-wide" are not two values of the same thing: the first is a
statement about how long a fact lives and the second about who it applies to. A flaky check is
fleet-scoped **and** expiring; "the pets vivarium is off by default" is fleet-scoped and permanent.

### Scope — who it is relevant to

| Scope | Written           | Means                                                                                                                              |
| ----- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Fleet | `fleet`           | True of working this repository at all. The most expensive to be wrong.                                                            |
| Check | `check:<name>`    | True of one CI check. The name is the provider's identifier.                                                                       |
| Goal  | `goal:<goal ref>` | True of one goal, and dies with it. The goal an origin collapses to — `goal:issue:41`, `goal:pr:412` — never the dispatch concern. |

A scope is stored as it is written above, and **resolved from the credential wherever it can be**: an
agent says `goal` and the harness expands it to its own goal, exactly as every other write in the tool
channel is attributed (`token -> agent -> task -> origin`). A check name is the one part it cannot
derive, so that one is an argument. An agent with no goal behind it is _refused_ the `goal` scope
rather than quietly widened to `fleet` — a silent widening files a fleet-wide claim on behalf of an
agent that thought it was writing a note about one goal.

A scope is **drawn as a reference** on the page, so it is a place a reader can go rather than a label:
a `goal:` scope is the goal's own ref, and a `check:` scope is the provider's identifier, said as one.

**Matching is inside a scope.** The same sentence about one check and about the fleet are two claims:
they carry different costs to be wrong and reach different agents, so folding them would let a note
about one job be corroborated into a fleet-wide instruction.

**A `check:` scope is fragile, and the page says so.** A check name is a provider identifier that
changes when somebody renames a job or adds a matrix dimension. `priorRemedies` already matches check
names exactly and accepts the same fragility for the same reason — a prefix match would put another
job's history in front of an agent under a name it would read as its own. The failure is silent: the
fact simply stops being delivered. The page names a check scope as the provider's own identifier and
says that much where it is drawn.

**A `check:` scope that has stopped matching is drawn as one**, which is the only way a silently
unmatched scope can be seen. The reading is `knowledgeScopeStaleDays` (default thirty) and it is
**derived, never recorded**: nothing writes a match, because a recorder for a reading is a second
record that has to be kept true, and the failure this exists to surface is silent non-delivery —
which a recorder that quietly stopped writing would reproduce rather than reveal. The evidence is
what the harness already holds, and it is two things rather than one:

- **The dispatches it made**, read through `dispatchFactScopes` itself rather than through a second
  reading of `Task.ciChecks`, so the scopes a fact is judged against and the scopes it is actually
  delivered on cannot drift apart.
- **The checks the provider is reporting now.** Not optional: most checks are green most of the time
  and a green check is dispatched about approximately never, so dispatch evidence alone would call
  almost every `check:` scope stale inside a week. A check the world reports is running, whatever the
  fleet has had to do about it. An alias counts as the name, exactly as a `ci.checks` glob treats one.

Three things keep it from crying wolf, and each is a case where a true "stale" would be a lie: a check
the world reports is never stale; a claim younger than the window cannot be, because there has not
been time; and `0` turns the reading off without demoting anything to achieve it.

It is a **reading and never a trigger**. Nothing is demoted, lapsed or dropped from a prompt because
its scope went quiet — a scope that matched nothing may be a check that is simply not running this
week, and a rule acting on this would delete the fleet's record of exactly the checks it sees least.
`src/knowledge/drift.ts` holds it, outside `src/dispatcher/` for the reason nothing there reads a
fact.

### Lifetime — how it ends

A fact either **stands** until it is retired, or it **expires**. An expiring fact is a _notice_, and
notices are a different animal in every respect that matters — see [Notices](#notices).

An expiring fact carries the moment it lapses, and a lapsed fact is answered to nobody — the row
stays, saying what it said, but it is out of every read.

An expiring fact may also carry a **resolution condition** the harness can evaluate: a check red on a
branch other pull requests are based on resolves when that check goes green, not when a timer runs
out. The clock is the backstop, not the mechanism. A timer alone either drops a notice while it is
still true — and the fleet rediscovers it — or keeps one alive after the thing is fixed, which
teaches every agent to disbelieve a check that is now genuinely failing. Both are silent.

**A condition is the harness's to write and never an agent's**, and that is not a trust judgement: a
condition is a mechanism rather than a sentence. Settling one means reading a world object pulse
after pulse, and the only party that can promise to do that is the one already reading it. An agent
naming a condition would be naming something nothing watches, and the notice would then be exactly
what it was without one — a clock — while its row claimed otherwise. There is one condition kind
today, `ci-check-green`: the named check passing on the named pull request. It is also met when that
check stops being reported at all, and when the pull request leaves the open set — merged, which is
the commonest way a red base branch stops being anybody's base. A check sitting at `pending` does
**not** meet it: a re-run in flight is not a green one.

A resolution **lapses** the notice rather than deleting or demoting it: a lapsed expiring fact is
already out of every read while its row stays saying what it said, so resolution rides the mechanism
the lifetime axis already has instead of adding a second way to be out of a prompt. The reach is
untouched — `rejected` means _not true_, and a notice that was true this morning is not that.

### Reach — how far it carries

Reach is the state machine, and it is the whole of the governance.

| Reach        | Where the fact is                                       | What moves it here                      |
| ------------ | ------------------------------------------------------- | --------------------------------------- |
| `proposal`   | Nowhere. One agent said it and nothing has agreed.      | An agent proposing.                     |
| `lookup`     | Answered when asked; injected on a matching scope.      | Two independent corroborations, or you. |
| `injected`   | In front of every agent, before it reads any code.      | **You** — or two goals, for a notice.   |
| `committed`  | In the repository. **Out of every prompt.**             | A docs pull request landing.            |
| `superseded` | Nowhere. A sharper claim naming it stands in its place. | **You**, adopting an amendment.         |
| `retired`    | Nowhere, and **free to be raised again**.               | You.                                    |
| `rejected`   | Nowhere, and barred from coming back.                   | You.                                    |

Two of those transitions belong to the fleet: an agent proposing, and corroboration carrying a
proposal to `lookup` — or, for a [notice](#notices) and only a notice, to `injected`. The rest are the operator's, and the [page](#in-the-cockpit) is what they are
reached through — promote, demote, retire and reject through `POST /api/knowledge/facts/:id/reach`, and
`committed` through the documentation pull request an operator opens with
`POST /api/knowledge/facts/:id/commit` and the world merges
([Committing to the repository](#committing-to-the-repository)).

**Naming the reach a claim already has is a ruling, not a no-op.** `lookup` is where two agents
agreeing puts a claim _and_ where an operator puts one that is true but not worth every agent's
context, so an operator who has read a corroborated claim and decided it belongs exactly where it is
has to be able to say so — the store stamps `ruled_at` on any move they make, whether or not the
reach changed. Without it the page's **Needs you** section would ask again forever, and the only way
to empty it would be a decision the operator does not agree with.

### Retiring is not rejecting

The two were one word, in two stores, meaning opposite things. `lessons` called its prune `retired`
and said outright that a lesson retired in error is simply written again; `knowledge_facts` called its
terminal ruling `rejected` and barred the claim by name. On one surface with one set of buttons, an
operator tidying a claim nobody had vouched for would have barred it forever — and what a bar costs is
paid by the agent that hits the same wall next quarter and is refused, by name, for saying something
true.

So they are two reaches, and the difference is what a claim leaving means:

| | `retired` | `rejected` |
| --- | --- | --- |
| Says | not carried any more | **not true** |
| Raised again | files a **fresh claim**, with its own evidence and today's date | refused by name |
| Undone by | an ordinary ruling — "Carry again" | nothing but an amendment naming it |
| Confirmation | none | two-step |

**A retired claim comes back by being raised, never by being restored**, which is `lessons`' rule
("there is no un-retire") kept rather than inherited by accident. `LIVE_REACHES` does not include
`retired`, so a raised claim matching a retired row files beside it instead of joining it. Joining
would resurrect a judgement nobody has revisited, wearing the date it was made on — and the whole
value of a returning claim is that somebody saw it again, recently, and said so.

**Retiring takes one click and rejecting takes two**, and that asymmetry is the feature rather than an
inconsistency. A prune has to be the cheap act on this surface: an operator who has to be sure before
tidying is an operator who does not tidy, and a store nobody prunes is the failure this whole design
is built around. Nothing is lost either way — the row stays, saying what it said, drawn in its own
section rather than dropped, so a list you have finished with can still be told from one that lost
rows.

What a retired claim cannot do is anything at all: it is out of `askFacts`, out of the block, and
refused by `contradictableFact` and `committableFact` alike. The refusal from `contradictableFact` is
the one worth reading, because it is the only place the distinction reaches an agent: it says the claim
was not judged untrue and invites the agent to raise what it saw in its own words, rather than sending
it to argue with a row nobody is being told.

**`committed` is not the top of a ladder — it is a different medium.** Once a fact is in
`docs/spec/` an agent reads it from the repository, and keeping it injected pays context twice for
one sentence. So committing **removes** the fact from every prompt and leaves a link to the pull
request behind. The number an operator should watch is this list growing and the injected list
shrinking: the knowledge base is a staging area, and success is it running out of durable facts to
hold.

## Corroboration

A fact reaches `lookup` on **two corroborations from two different goals**, and never on an operator's
absence of objection. The same two carry a _notice_ one further, to `injected` — see
[Notices](#notices) for why a clock is what makes that difference.

**The proposal is the first of the two.** An agent writing a claim down is making an observation, with
words and a goal behind it, so it is recorded as a corroboration like any other — which is what makes
"two corroborations from two different goals" the literal count rather than a rule with an off-by-one
in it. It also means the second agent to hit a wall calls the _same_ tool with the same words it would
have used anyway, and its call lands as agreement rather than as a second copy of the claim:
`claimsMatch` decides which, so nobody has to know whether they are first.

**Different goals, not different origins.** `pr:412:ci` and `pr:412:comments` are two origins and one
confusion; two parts of one goal hitting one wall is one observation. And a re-dispatch inherits the
conversation through `spawn`'s `resumeSessionId` ([10](10-agent-runtimes.md)) — an agent corroborating
its own predecessor's claim is one agent counted twice, which is exactly the shape auto-promotion must
not reward.

**The harness is a better corroborator than a second agent**, wherever it can speak. Two agents are
not independent if the second read the first's notice before forming its own view, and contamination
is invisible in the count. But whether a check went red and then green on the same commit is a fact
the harness holds in `world_events` already, and whether a check is red on the base branch is one it
computes to send the base-branch-recovered notice. A harness observation is stronger evidence than an
agreeing agent and cannot be contaminated by one, so it counts as a corroboration and, for the notice
kinds it can evaluate, raises the notice itself.

It is attributed like any other observation and to nothing it does not have: a harness corroboration
carries the **goal** it was read on and no agent, task or session. `distinctCorroborators` counts by
goal, so two readings of one check on two different pull requests are two corroborators — which is
what carries a harness notice to `injected` — while two readings on one pull request stay one,
exactly as an agent's two dispatches on one goal do. Its **words** are the reading itself, in the
terms an operator can check: which check, which commit, which pull request, and what was true on the
pulse before. That is what they read to decide whether the claim should have promoted, and a harness
row that said only "observed by the harness" would be a count with nothing behind it.

`src/knowledge/noticeDesk.ts` is where both live, and it is a **writer** of facts rather than a
reader. It sits in the pulse above `decide` and above the executor, and that ordering is what it is
for: the block a dispatch carries is rendered at launch, so a desk run below that point would raise a
notice the agents dispatched on that pulse are not told, and settle one they are still told. It is
the argument [24](24-environments.md#the-bench-asks-for-one-thing-at-a-time) makes about
`DeliveryCloseOutDesk` running below `ValidationReadyDesk`, pointed the other way. It is not under
`src/dispatcher/` for the reason nothing there reads a fact: `test/knowledge.test.ts` matches
`proposeFact` over that directory as well as `askFacts`, so a writer put among the rules fails the
same assertion a reader does.

Corroborations are rows in their own table, each carrying the agent, the goal, the moment and **the
agent's own words** — never a counter on the fact. The count is what promotes; the words are what an
operator reads to decide whether it should have.

## Contradiction, and why it does not delete

An agent that finds a fact contradicted by the code in front of it says so, through `raise`'s
`contradicts` argument. This is the half `lessons` never had: staleness there rested on an agent
mentioning it in a retrospective and a human noticing, which is why the lesson block's header had to
ask for it in prose.

**A contradiction demands an amendment.** The contradicting agent must say what the claim should say
instead, and that amendment is filed as a new proposal naming the original in `supersedes` — through
`proposeFact` like any other, because the bar exemption, the claim matching and the corroboration row
are all that call's. A contradiction with no amendment is **refused, by name and with the reason**.
Nothing is demoted by count alone.

The reason is that a contradiction count punishes exactly the wrong claims. A claim that is right in
general and wrong at one edge attracts contradictions **because it is being used**, and those are the
most valuable claims in the store. The real example this design was drawn against: _drop the `export`
keyword rather than delete it_ is true of a type or a helper and false of a class member, where knip's
analysis is name-based. Three agents hitting that edge should sharpen the claim, not delete it. Under
a count, they delete it.

Which is also why the **second** agent to hit an edge matters as much here as it does for a proposal.
Its amendment is the same sentence, so it lands as corroboration on the amendment already standing —
`claimsMatch` again, with the parent alone excluded from the match, since folding an amendment into
the claim it sharpens would discard the correction. Filing each identical sharpening as its own
one-voice proposal would carry nothing anywhere and would look exactly like the design working.

**A contradiction lives in its own table**, `knowledge_contradictions`, and not as a discriminated row
in `knowledge_corroborations` whose shape it otherwise shares exactly. `distinctCorroborators` counts
the rows of that table, so a stance column would be counted as agreement by any reader that forgot the
filter — a contradiction promoting the claim it disputes, with nothing red. Two tables make that
unreachable rather than merely wrong. It is counted by the same union over goal and session, because
an agent disputing its own predecessor's claim across a re-dispatch is one voice twice.

**Any fact an agent could have been shown may be contradicted**, which is `lookup` and `injected` and
not lapsed — `askFacts`' own answer rather than a second opinion about it. This section used to say
"an injected fact", but a `lookup` fact reaches agents through the task prompt of every dispatch its
scope matches and through `knowledge_ask`, and it is contradicted by the same reading of the same
code; refusing there would leave the fleet's one way of saying "this is stale" working for some of
what it was told and not the rest, with no way for the agent to tell which. A `proposal` reaches
nobody, so nothing could have been shown one; a `committed` fact is in the repository, where the way
to correct it is a change to the documentation — and the refusal names `report_finding` kind `docs`
as the rail for one, rather than the pull request that put the claim there, which is a merged diff
nobody can file against. And a **rejected** claim is refused by name: an
operator has already said it is not true and it reaches nobody, so there is nothing to correct — what
the agent has in hand is a claim in its own right, which is `raise` naming the barred one.

**The block does not say a claim is disputed**, and that is a decision rather than an omission. Both
answers cost something: saying so puts a hedge in front of the whole fleet on one agent's say-so, and
not saying so means every agent reads a claim two agents have contradicted as though nobody had. It is
not said because a marker with no amendment behind it hands the reader a doubt it can do nothing with
— the stance [the cap](#the-cap-and-saying-what-it-dropped) takes about a count an agent cannot act on
— and because delivery moving on an agent's say-so is exactly what the reach machine reserves for a
clock or an operator. What closes the gap instead is that the block's header names the
way to say so where it says the code is the authority, so the invitation and the call that answers it
are one sentence; and that the page draws the ratio and the unanswered count on the row,
where the person who can act on them is.

An operator resolving a contradiction has three moves: promote the amendment and supersede the
original, narrow the original by hand, or reject the contradiction. Only the last leaves the fact
where it was.

**Adopting an amendment is one call, not two.** The amendment reaching the claim's place and the claim
leaving it are two halves of one decision, and two calls can half-land: the sharper claim injected
beside the blunter one it was written to replace, both in the same block, saying different things to
every agent until somebody notices. `POST /api/knowledge/contradictions/:id/resolve` carries all three
moves and the store makes both writes in one transaction.

The adopted claim goes to **`superseded`**, a reach of its own and deliberately not `rejected`. It was
not judged untrue — and a rejection would bar the amendment's own words, since an amendment usually
_contains_ the claim it sharpens, so the next agent to hit that edge would be refused by the name of a
claim nobody is being told. `superseded` is out of every read exactly as `committed` is, bars nothing,
and is terminal in both directions. For the same reason **the bar yields to a live descendant**: a
rejected claim does not refuse a proposal whose words match a live fact that supersedes it, which is
the `supersedes` exemption extended from the amendment itself to the later agent with no id to name.
And for the same reason again, dismissing a contradiction leaves its amendment exactly where it is
rather than rejecting it: an operator who wants it killed has the ordinary control and pays that cost
knowingly.

Narrowing rewrites the claim in place, and supersedes the amendments it answered — the operator wrote
the sentence themselves, so those proposals are replaced rather than untrue, and leaving them live
would grow a near-duplicate of the narrowed claim that a later agent could corroborate into a second
version of it. Both moves answer **every** open contradiction on the claim, because both move the
claim and a dispute about a sentence that no longer stands is not a decision anybody can still make.

**The ratio is disputing voices over every voice that has spoken**, over the whole life of the claim
and no window, taken server-side beside the rows it counts. No window because the count beside it — the
one that carries a proposal to `lookup` — is over every corroboration a fact ever had, and a ratio over
a shorter window would be a second number drawn from the same rows under a different rule, free to
disagree with the one that governs while looking like the same arithmetic. Server-side for
`distinctCorroborators`' reason exactly: both counts are counts of _voices_, so a division taken in
the browser would be arithmetic over numbers whose rule the view layer does not know. It is a
**reading and never a trigger** — nothing is demoted, lapsed or deleted by it.

## Rejection bars a claim — and amendment is how a barred claim comes back

**A rejected fact is immune to re-proposal and to corroboration.** `src/store/findings.ts` already
takes this stance for a dismissed finding — a claim an operator has answered is not something a later
report is folded silently into — and here it is load-bearing rather than tidy: without it, two agents
re-propose next week what you killed today and auto-promotion resurrects it, on its own.

Matching is `claimKey` and `claimsMatch` (`src/claims.ts`): normalisation to alphanumerics, then
equality or whole-word containment above a length floor. That machinery was already written and
already tuned for `src/store/findings.ts`, and it moved up to a module of its own rather than being
copied — a claim an operator dismissed as a finding and re-proposed as a fact has to look like the
same sentence to both stores, or the bar leaks. A domain module under `src/store/` may not reach a
sibling (`test/storeModules.test.ts`), which is the other half of why it lives outside both.

**Which is precisely why an amendment needs an explicit link.** An amended claim usually _contains_
its original — that is what amending is — so a rejected claim's bar would swallow its own correction,
silently, and the sharpest version of a fact would be the one form of it that could never be filed. A
fact therefore carries `supersedes`, and a fact naming a barred parent is exempt from its bar. Nothing
else is.

`rejected` means **not true**, and nothing else. "True, but not worth the context" is not a rejection —
it is `lookup`, where it costs nothing until somebody asks. Folding the two together bars a true claim
from ever being found.

## Notices

A notice is fleet-visible within minutes, on two corroborations, with no operator in the loop. It is
the one path in this design where agents put text in front of the whole fleet by themselves, and
everything below is about bounding what that can do.

**A notice states an observation. It never states an instruction.** This is `src/knowledge/block.ts`'s
rule and it binds hardest here. _"This check went red and then green on the same commit twice
today"_ is an observation. _"Do not chase the diff — re-run it"_ is an instruction, and it is the
failure mode: an agent misreads a real defect as a flake, a second agrees, and for a day every agent
is told to re-run a check that is genuinely broken. That is a board that teaches the fleet to skip
real bugs, and the harness's own rules about never re-running to dodge a failure are written against
exactly it. The agent draws the conclusion; the notice supplies what was seen.

**A notice is always injected**, and this inverts the obvious arrangement on purpose. Notices are the
smallest tier and the most time-critical, and a lookup is a **turn** — the cost `ciEvidence` and
`priorRemedies` are both written to avoid ([09](09-execution.md)). A handful of dated one-liners is a
few hundred bytes and no round trip. The long tail of permanent facts is the part that belongs behind
a lookup, not this.

Which is why **`injected` decides the prompt and the scope only excepts**. A notice is usually about
one check, and a check that flakes flakes for the agent about to run it rather than only for the one
already dispatched to fix it — so leaving a notice scoped would put it in front of exactly the agents
who had already found out. `renderKnowledgeBlock` therefore carries every injected fact whatever its
scope, and the one exception is a `goal:` scope, which is an exception about **lifetime** rather than
audience: a goal fact is true of one goal and dies with it, so it is not merely irrelevant to the
rest of the fleet but a claim about something most readers cannot see. It rides the task prompt of
its own goal's dispatches, where it reaches everyone it is about. One predicate decides
(`ridesSystemPrompt`), read by the block to filter _in_ and by the scoped note to filter _out_, so no
fact is delivered twice and none falls between the two — two lists that merely agreed today would
send one sentence twice, charged twice and read as two claims.

**Its line in the block carries the fact's own dates and no clock.** "Lapses in three hours" is
computed from _now_, which is different bytes on every launch — the cached prefix thrown away for a
countdown, with nothing measuring the loss. So the line says `lapses <date>`, which is the fact's own
`expiresAt`. A notice leaving the block when it lapses is a change that happens once per notice and
is unavoidable; a countdown rendered into it is neither.

**Notices are rendered first, and are therefore the last thing the cap drops.** They are the smallest
tier and the most time-critical, and each one leaves the block by its own clock within days anyway.

**Auto-promotion is bounded by lifetime, and that is the whole safety argument.** A notice may reach
`injected` on corroboration alone because its blast radius is capped by its own clock; a permanent
fleet-wide fact may not, because a stale line in every agent's prompt is a false instruction handed to
every agent before it reads any code, and it fails silently. That is the argument
`src/server/routes/lessons.ts` already makes about promotion being the feature, and nothing here
weakens it. It is stated once, in `autoReach` (`src/store/knowledge.ts`), and it reads the **clock**
rather than the lifetime word: an expiring fact with no `expiresAt` would be a standing claim wearing
the word, one missed validation away from being the thing the rule exists to refuse.

**A notice reaches nobody until the moment it is injected**, and that is what stops its own delivery
manufacturing its second voice. With one corroborator it is a `proposal`: answered to no
`knowledge_ask`, riding no prompt, and shown only on the page an operator reads. The second goal to
say it therefore cannot have read the first's — the contamination the count cannot see is closed by
construction rather than by a rule somebody has to remember.

### What the harness raises

Two kinds, both **edge-triggered** — a transition between two consecutive world snapshots, never a
state. A level-triggered raise would file the same observation on every pulse for as long as the
condition held, and the corroborations are a record of observations rather than a counter.

- **A check that went red and then green on the same commit.** The commit is the whole of it: red
  followed by green is the ordinary shape of a _fix_, and calling that a flake would teach the fleet
  to disbelieve every check anybody ever repaired. What separates them is whether anything was pushed
  in between, which is `PullRequest.headSha` — GitHub's `head.sha`, Azure's `lastMergeSourceCommit`.
  **A provider that does not report it gets silence**: absent means the harness cannot say, and a
  flake claimed on that basis would be the notice teaching the fleet to ignore a genuinely broken
  check. It carries no resolution condition, because the check is already green and no later reading
  settles it — here the clock genuinely is the mechanism, which is why it is a short one.
- **A check newly red on a branch other open pull requests are based on.** The harness computes that
  relation already (`basePrOf`, `inheritedCiFailure` — [07](07-pull-requests.md)), and a rung whose
  own CI is red for its base's reason is the case it exists for. This one names the branch, where the
  flake notice names no goal at all: a different branch being red is a different fact, and folding two
  of them together would let one team's broken base speak for another's. It is also what the
  `ci-check-green` condition is anchored to.

The claim a harness notice files carries **no pull request number**, and that is what makes the count
mean anything: `claimsMatch` compares sentences, so a claim naming the goal it was seen on could
never be corroborated by the same thing seen elsewhere, and a notice would need one pull request to
flake twice before it reached anybody.

## Delivery: two prompts, not one

Reach and scope interact, and the interaction decides **which** prompt a fact rides.

- **The system prompt** carries every injected fact except a goal-scoped one — the notices and the
  fleet's standing claims — rendered by `renderKnowledgeBlock` (`src/knowledge/block.ts`) and threaded
  in by `src/system.ts`. Which fact rides which prompt is [one predicate](#notices). It is
  identical for every agent on every dispatch, which is what keeps it a cached prefix — the entire
  reason this lives there rather than in the task prompt. Nothing in it varies per run: no goal name,
  no branch, no agent id, and every date is the fact's own.

  **It replaced the lesson block rather than joining it.** A promoted lesson is mirrored in as an
  injected fleet claim, so rendering both would have sent every promoted lesson to every agent twice
  — once as a lesson and once as its own mirror. One block ships
  ([10](10-agent-runtimes.md#the-knowledge-block)), and the Lessons panel's per-row "sent to agents"
  chip is that block's answer read back through the fact the lesson was adopted into.

- **The task prompt** carries the facts whose scope matches _this_ dispatch and that the block is not
  already carrying — the `lookup` facts for the checks that are red, and the goal's own. These vary
  per dispatch and would destroy
  the cache in the system prompt. They are **appended**, exactly as `priorRemedies` is appended
  today, and for its reason: prompt templates are operator-overridable and `loadPromptTemplates`
  rejects only _unknown_ placeholders, so a `{knowledge}` token would be silently dropped by every
  override written before this existed. `recordDispatchTask` appends them
  ([09](09-execution.md#what-the-fleet-knows-about-this-goal-reaches-the-agent)) rather than any rule,
  which is what keeps "no rule, desk or gate reads a fact" true of a dispatch that carries one.

The consequence is that `lookup` means _not injected everywhere_, not _never injected_. A
`check:format:check` fact costs nothing on a dispatch about anything else and is in front of the agent
that needs it without anyone asking. The tool becomes a fallback rather than the delivery mechanism —
which matters, because `report_remedy` is classified `point-of-use` in `test/mcpChannel.test.ts`
precisely because a tool named nowhere but in `tools/list` is a tool an agent finishes without.

### The cap, and saying what it dropped

The system-prompt block is bounded by `knowledgeBlockChars`, and whole facts are dropped at the bound,
oldest-vouched first. Half a claim is a different claim.

The ordering turns on `ruled_at`, not `updated_at`: the latter also moves when somebody corroborates a
claim, which would let an agent agreeing with a fact reorder the fleet's block.

**The block says out loud that it is partial**, names how many facts it is not carrying, and names the
tool to ask with. `ciEvidenceNote` and `priorRemedies` both take this stance: an agent that reads
a partial record as a whole one concludes something from the absence of an entry that was merely
trimmed, which is worse than having no record at all. It is the one place this reverses the lesson
block's stance, and `knowledge_ask` is why: a count an agent can do nothing about is noise, and a
count with a tool behind it is a way through.

**What fits is returned by the renderer and never recomputed at a call site.** The block, the facts it
carries and the facts it dropped come back together, and the cockpit's meter is projected from that
same answer. A second implementation of "what fits" is free to disagree with the one that actually
ran, and nothing is red when it does.

## What the fleet writes with

Two tools an agent chooses between, and the choice is *read or write* rather than a taxonomy.

| Tool            | Who may call it | Does                                                                                 |
| --------------- | --------------- | ------------------------------------------------------------------------------------ |
| `raise`         | **Any agent**   | Records anything the agent learned — or records the caller as agreeing with a claim. |
| `knowledge_ask` | **Any agent**   | Returns facts matching a scope or a question.                                        |

Widening *who* may write was the cheap half of this design: proposals cost nothing until somebody
vouches, and the gate is unchanged. Narrowing what a writer has to *decide* is the other half, and it
is the one that took a surface away rather than adding one.

### The intake asks nothing an agent cannot answer

Filing an observation used to mean choosing a door: `report_finding` — and then which of its four
kinds — `knowledge_propose`, `knowledge_notice`, `knowledge_contradict`, or a retrospective's
`lessons` field. Six, sorted by **what an operator would do about it**, which is the operator's
knowledge and not the agent's. The discriminator that sorted them was stated in three places
([13](13-jobs-and-findings.md#where-a-lesson-does-not-go)) precisely because it did not stick, and
each restatement was somewhere it could drift.

So the axis is inverted. The agent says what it saw; **where the claim goes is the harness's to work
out and the operator's to settle**. `raise` takes no kind, no lifetime word and no destination:

| The agent supplies | And the harness reads it as                                                    |
| ------------------ | ------------------------------------------------------------------------------ |
| `claim`, `evidence` | Required. The claim, and the observation that is the argument for it.         |
| `where`            | What locates it — file and line, package, service. Optional.                   |
| `ref`              | The world item it is **about** (`issue:41`, `pr:412`) — never the caller's own origin. |
| `until`            | Present → the claim is a notice, bounded by that clock. Absent → it stands.     |
| `contradicts`      | Present → the claim is an amendment, and the dispute is recorded.               |
| `scope`            | Optional. Defaults to `fleet`.                                                  |

**Presence is the answer, on both of the fields that used to be a tool.** A notice cannot be filed by
picking the wrong word, and — the thing `knowledge_notice` existed as its own tool to prevent — a
standing fleet-wide claim cannot be filed by forgetting the right one. There is no field to forget:
an agent that supplies a clock has filed a notice, and an agent that supplies none has filed a
standing claim, which is what it meant either way.

**`contradicts` is routed rather than folded into `supersedes`**, because the two are not the same
act and the store already knows it. A bare `supersedes` files a sharper claim beside a blunter one
and records no disagreement; a contradiction says *the claim you gave me does not fit what I am
looking at*, and that dispute is what an operator reads to decide whether the original was ever
right. Folding them would leave the contradiction ratio reading zero on a claim the fleet keeps
walking into — a silence, and the expensive kind. The claim being raised **is** the amendment: an
agent that has seen a claim fail has, in the same breath, said what it should say instead.

**Scope defaults to `fleet`, and that default is the one worth arguing.** `goal` is cheaper to be
wrong about and is still the wrong default, because a goal-scoped claim dies with its goal — so an
agent that did not think about scope would have its observation buried on exactly the run that
learned it. What makes `fleet` safe is the gate rather than the guess: a proposal reaches nobody, two
*different* goals agreeing is itself evidence a claim is not goal-local, and the scope is on the row
in front of the operator. A default an agent never has to think about, which an agent who has thought
about it can still override, is not a taxonomy question.

**`aboutRef` is never `originRef`**, and the case where they differ is the case that matters: an agent
on `issue:41` reporting that `pr:412` duplicates `pr:398` has an origin of the first and is talking
about the second. Attributing such a claim to its origin files it under somebody else's goal — the
defect `findingJobRequest` already refuses by carrying `finding.ref` rather than `finding.originRef`
([13](13-jobs-and-findings.md#promotion--post-apifindingsidpromote)). Both columns are additive and
carry null on every row from before the intake, which is the only true value: nothing before `raise`
could name either.

What has **not** changed is everything the gate rests on. A raised claim reaches nobody on its
author's say-so; two goals agreeing carries it as far as `lookup`; only an operator carries it
further; nothing in the dispatcher reads it at any reach; and a claim an operator rejected is still
refused by name, with `contradicts` as the one way back. Making it easier to file costs nothing
because filing has never been what puts a sentence in front of the fleet.

Both are named in `MCP_PROTOCOL_ADDENDUM` rather than at a point of use — the choice
`test/mcpChannel.test.ts` forces on every tool. Every agent may write to this store and every agent
may read it, so there is no one dispatch prompt that could name them.

### The doors that closed, and why they are still there

`report_finding`, `knowledge_propose`, `knowledge_notice` and `knowledge_contradict` are **named
nowhere**. They are still registered, still granted, and still work.

That is deliberate on both halves. Advertising them would put six ways to file one observation in
front of every agent, which is the taxonomy `raise` exists to remove — an agent choosing between
doors is an agent that can choose wrong, and the whole value of the intake is that there is nothing
to get wrong. But **deleting a tool name fails silently in the one place it matters most**: an
operator's prompt override written before the intake may still name `report_finding`, and a name
dropped from `MCP_TOOL_NAMES` and the `--allowedTools` grants comes back refused with nothing in the
logs to say why — on exactly the deployments that customised most. Unlike a `PromptId`, whose removal
turns a deployment into a harness that will not boot and says so, a withdrawn tool name is a call that
quietly does not work.

So they are classified `superseded` in `test/mcpChannel.test.ts` — a third answer beside `addendum`
and `point-of-use`, which is where that intent is recorded. Without it they would read as
`point-of-use` and look like tools somebody forgot to name, which is the state `open_pr` spent its
first release in and the thing that test exists to catch. Withdrawing the names for real is a later
change, once overrides have moved.

**A raised claim is refused by name when it is barred**, with the id of the rejected claim and the
`contradicts` argument that is the way back. A silent refusal teaches the fleet nothing, and it files
the same claim again tomorrow.

### What is not folded in, and why

The discipline that keeps one door from becoming the catch-all `findings` deliberately never had. Each
of these is a claim-shaped thing that stayed out for a stated reason rather than an oversight:

| Stays its own | Because                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `knowledge_ask` | It is a read. The one axis worth making an agent choose is whether it is telling or asking.               |
| `escalate`      | It **parks the agent**. A request for an answer is not an observation, and `raise` parks nobody.           |
| `request_human_task` | It is a request for a person to act, not information. It files durable work, and it too parks nobody. |
| `scratch_append` | A conversation between siblings on one goal: chronological, unstructured, nothing to corroborate.         |
| `report_remedy` | The **event** record of one return to a pull request, with its counts and its dollars ([18](18-observability.md)). |

> **Not yet built:** the `raise` arm on `report_finding`. A `docs` finding is still only a finding. It
> keeps its own job either way: it is the thing that becomes a documentation pull request. It waits on
> the findings/lessons store merge rather than on this page.

### The remedy arm

`report_remedy` under an `undocumented` guard raises a fact, and that is the whole of the change: the
row it writes, the counts on it and the dollars behind it are untouched, because an account of an
event and a durable claim are different animals and folding them together would lose the counts.

**Why it had to move at all.** The claim used to be a `lessons` row, which made this the last
agent-facing writer to that store — so the same sentence reached a different store, under a different
gate and with no corroboration behind it, depending on which tool the agent happened to be holding.
An agent hitting a wall two other agents had already documented filed a third copy of it that nothing
could read against the first two. Agreement is the only thing that carries a claim out of one agent's
head, and it was exactly what this door could not produce. It was left alone until now for a stated
reason — the intake did not exist, and writing into a store nothing read would have bought nothing —
and delivery has since moved.

**It goes through the path `raise` uses**, `AgentManager.fileFact`, so the observer is the
credential's and `claimsMatch` decides whether the call is a claim or an agreement. Nothing about the
gate changes: it lands a `proposal`, two different goals carry it to `lookup`, and only an operator
carries it further.

| Field | What the remedy supplies |
| ----- | -------------------------- |
| `claim` | The agent's own, and the one argument this arm adds — it replaces the `lesson` field under the same fence. |
| `evidence` | The remedy's **`summary`**. It is already what the agent saw, so asking again for an observation the submission is carrying would be a third field for one answer. |
| goal | `corroborationGoal`'s reading of the caller's origin: `pr:<n>` for both `pr:<n>:ci` and `pr:<n>:comments`. The pull request the remedy was filed on, exactly as the lesson's `originRef` was, and resolved from the credential rather than asserted. |
| `aboutRef` | Null. The claim is about the repository; what it was learned on is the corroboration's, which is where a reader can already see it. |
| scope | `fleet`. |

**The scope is `fleet`, and a `check:` would have been the wrong answer for three reasons that all
cut the same way.** It is tempting, because a remedy is filed against one pull request's checks and
`priorRemedies` already delivers per check — but **matching is inside a scope**, so a remedy-raised
claim scoped to `check:test (windows)` could never be corroborated by the same sentence raised through
`raise`, which defaults to `fleet`. That is the fragmentation of exactly the agreement this arm
exists to gain. A **review** remedy has no checks at all, so a `check:` scope would be available on
half the remedies and the tool would scope by kind. And `Task.ciChecks` is a *list*: one fact carries
one scope, so a dispatch answering three checks would have to either file the claim three times or
pick one arbitrarily. `fleet` matches `raise`'s default, and what makes it safe here is what makes it
safe there — a proposal reaches nobody, and the scope is on the row in front of the operator.

**The fence stays, and so does its refusal.** A claim is refused under any guard but `undocumented`,
by name and with the reason. A remedy under `documented`, `local_check` or `unpreventable` has already
said the fleet knew, so the fence is what stops "we fixed it" being filed as "the repository does not
say this".

**The bounds are the knowledge store's own and are applied before anything is written.** The claim
goes through `validateFactProposal` inside `validateRemedy`, so an over-long claim is a refusal the
agent can act on this turn rather than a claim lost to a submission that otherwise succeeded.

**What comes back says which of three things happened** — raised, recorded as agreeing, or refused by
the bar — in the payload and in words. That is `raise`'s rule and it applies here for its reason: an
agent that reads a returned id as proof it filed something new says it again, louder, and an agent
that cannot tell filing from agreeing cannot tell which of two opposite things to do next.

**A barred claim does not take the remedy with it.** The row is already written when the claim is
raised, and it stays written: the account of an event does not depend on an operator's ruling about a
sentence, and losing the remedy to one would lose the counts the Yield panel is built on. The refusal
is reported to the agent instead, with the `contradicts` argument that is the way back.

## In the cockpit

One destination, `?tab=knowledge`, reached from the **Knowledge** button in the nav — which carries a
badge of the corroborated claims nobody has ruled on, and nothing else, for the reason the Lessons
reading counts proposals ([17](17-cockpit.md#shape)). It was a panel on `?panel=knowledge` until the
top bar was tidied, and it is a tab now because ruling on a claim is triage — a sitting, several times
a day, like the tickets tab beside it — where a panel drew over the queue rail the ask that sent you
here came from. `readPlace` aliases the old parameter onto the tab, so every link an operator saved to
a claim still lands ([17](17-cockpit.md#the-address-bar)).

Where the nav is and which claim has its provenance open are both on `Place`: `?fact=<id>` is a link to
what two agents actually saw, and a row held open in a `useState` works right up until the back button
steps over it.

The **Live notices** section says what a notice is and where one comes from — including that the
harness raises its own, and that a row carrying a resolution condition ends when the world meets it
rather than when its clock runs out. The page reads top to bottom in the order things demand
attention: **Live notices** with their clocks,
**Needs you** — the corroborated claims waiting on the one decision that is yours — then **Injected**,
**On lookup**, **One voice**, **Committed to the repository**, **Superseded**, and the **Rejected**
tail. A row carries the claim, its scope as a reference, its corroboration count, its contradiction
count and ratio, its provenance, and — where it has one — where it is going or has gone in the
repository, with the observers' own words a click away. A `check:` row whose scope has stopped
matching says so; a `lookup` row says how often it was asked for, including when that is never. Both
are [readings and never triggers](#what-it-costs).

**A disputed claim stays in the section its reach puts it in**, and so does one whose scope has
drifted and one nobody has asked for. That is the page's own statement of the invariant: nothing is
demoted by a count, so lifting such a claim out of **Injected** — or into a "stale" section of its own
— would draw a demotion that did not happen. What it carries instead is the ratio and, while any dispute
is unanswered, a count of what is left to answer. The three moves are inside the row's provenance,
beside the words that ask for them — an operator choosing between the claim and the amendment has to
be able to read both, and a control that sat where only one of them was visible would be asking for
the decision with half of it hidden.

**The page draws what it stopped**, which is why the last two sections are there. A surface showing
only what it let through cannot tell an operator that a claim was killed — and the rejection bar,
which is what stops two agents re-proposing next week what was killed today, is invisible everywhere
else in the harness. The Lessons panel keeps its retired tail for the same reason.

**The count on a row is `distinctCorroborators`', taken server-side.** Two observations are one
corroborator if they share a goal _or_ a session, transitively, so a length counted in the browser
would be a different number wearing the same label — free to disagree with the one that actually
carries a claim to `lookup`.

**Nothing on the page auto-promotes anything, and it files nothing.** Agents propose through the tool
channel on a scoped MCP credential; the cockpit's bearer token reaches five verbs — promote, demote,
retire, reject, keep — plus the three answers to a contradiction and the two of graduation, and none of
them is available to an agent. Nothing here files an amendment either: an agent wrote that through
`raise`, naming the claim it contradicts, with an observation behind it. There is no un-reject: a
rejection is terminal, and what comes back is an amendment naming the barred claim. There is no
un-retire either, and it is a different absence: a retired claim comes back by an agent **raising it
again**, which files a fresh row with fresh evidence — the operator's own "Carry again" is for the
prune they regret, not for the claim's return.

**A committable row carries a "Commit to the repository" control**, which asks where the claim goes
before it opens anything — the owning document, or `CLAUDE.md` with the sentence that arm costs. It is
offered on a standing claim at `lookup` or `injected` and nowhere else, because those are the two
things the store will take. While a graduation is going the row says so and draws its pull request as a
reference; a graduation that did not land says that instead, and the control comes back. A row whose
reading is `unknown` draws the two controls that answer it — _it merged_ / _it did not_ — beside the
pull request they are about, because that reading is the harness declining to guess and the operator is
who it is asking.

**The reading on a graduation is the sweep's own**, shipped on the row. A page that worked out whether
a pull request had landed from its status would be a second implementation of the verdict that takes a
claim out of every prompt, free to disagree with the one that actually ran — `distinctCorroborators`'
argument, pointed at the other end of the fact's life.

**Promoted lessons are mirrored in, so the Lessons panel and this page show the same claims.** The
page says so in as many words rather than leaving a reader to work out which surface is authoritative.

**The Injected section carries a character budget** drawn against `knowledgeBlockChars`, and marks the
claims the cap left out, per row. Under it is [what the block costs](#what-it-costs): the characters
are the cap, and the dollars are the purchase.

**And the page ends with a second surface: what an agent actually receives** — the system-prompt block
verbatim, and the task-prompt append for each `check:` and `goal:` scope holding anything deliverable,
from the same two renderers the launch and the dispatch use.

Per scope rather than per dispatch, because a dispatch matches its goal and every check it answers at
once and the set of dispatches is not a list; an agent fixing CI on a goal with claims against both
receives both entries, in one pass through the renderer.

Both are **projected server-side from the renderer's own answer**, never a second reading of it. A
meter drawn from a plain character count in the browser would be exactly the second implementation of
"what fits" that rule exists to prevent. The lessons section carries the idea in miniature ("is this claim
actually being sent"); a store this size cannot be governed without it.

## What nothing does

- **A contradiction neither deletes, lapses nor demotes the fact it names.** The only things that end
  a fact are its own clock and an operator, and the only thing a contradiction does on its own is put
  a sharper claim beside the one it disputes.
- **No rule, desk or gate reads a fact.** Nothing is dispatched, held, or ranked because of one. A
  fact feeds prompts and a panel, and that is the whole of it — `src/remedies/remedies.ts` takes this
  stance already and it survives unchanged.
- **Nothing auto-promotes to `injected` except a notice**, and a notice cannot outlive its clock —
  `autoReach` reads the clock itself rather than the lifetime word.
- **Nothing auto-commits to the repository.** A docs pull request is a dispatch a person promotes,
  through the machinery `src/mcp/findings.ts` already has — and no agent reaches
  `POST /api/knowledge/facts/:id/commit`, which is on the cockpit's bearer token and not the tool channel.
- **Nothing takes a claim out of a prompt because work for it was queued.** Committing opens a pull
  request and moves the claim nowhere; only an observed merge, or an operator answering a reading the
  harness would not take, reaches `committed`.
- **No reading acts.** Nothing is demoted, lapsed, dropped from the block or deprioritised because of
  what it costs, because its `check:` scope has stopped matching, because it is disputed, or because
  nobody has asked for it. Every number on the page is drawn for the person who can act on it, and the
  only things that end a fact are still its own clock and an operator.

## What it costs

The injected block is input the fleet pays for on work nobody asked it to do, so the page prices it in
the dollars the rest of the cockpit uses — against the same window as Insights
([18](18-observability.md)) — rather than in tokens, which mean nothing at a glance.
`src/knowledge/cost.ts` is the fold, and it is drawn beside the character budget on the **Injected**
section, because the characters are the cap and this is the purchase.

**Measured, not modelled, and there is no price table.** The figure is the block's **share** of the
fleet's own input applied to the fleet's own recorded spend. A table of per-token prices would be a
second statement about money, free to disagree with `Agent.costUsd` the moment a rate changes or a
deployment moves plan — and it would disagree silently, which is the whole objection. Applying the
fleet's own rate is also what keeps the figure honest about the cache: the block lives in the system
prompt precisely so it is a cached prefix, and pricing it at a fresh-input rate overstates it by
roughly an order of magnitude. `Agent.inputTokens` is the **gross** figure — fresh, cache-written and
cache-read alike — so `costUsd / inputTokens` is the fleet's own dollars per input token with the
cache discount already inside it. A fleet at a 90% hit rate carries a low rate and the block inherits
it. Nothing here has to know what a cache read costs.

**It is paid per turn, and "per dispatch" is that divided by the dispatches.** The obvious reading —
the block is identical on every launch, so it is bought once per launch — is wrong by the fleet's
average turn count. The block is in the system prompt, and a session re-sends its whole prefix on
every call; that is what being a cached prefix *means*, and it is why the prefix being cached is the
point rather than an optimisation. The denominator the share is taken against
(`Agent.inputTokens`) is likewise a sum over every turn, so a numerator counted per launch would
understate the block twenty-fold or worse while looking like the same arithmetic. So the block's
tokens over the window are its tokens times the fleet's turns, and dollars per dispatch is that total
divided by the dispatches.

**One thing is estimated and it is named on the glass.** Nothing in the harness tokenises and the
block is never billed as a line item, so characters into tokens is a stated constant
(`KNOWLEDGE_CHARS_PER_TOKEN`, four) rather than a config key — an operator tuning it would be tuning
the answer rather than the thing measured, and two deployments' figures would stop being comparable.
Every other number is what the fleet reported.

**A dispatch that reported no usage is unmeasured, never free.** A PTY run carries the same block and
reports nothing, so it is counted apart and shown, and a window in which nothing was measured answers
**null** rather than zero — `Agent.costUsd`'s own convention. A `$0.00` there would be the one figure
on the page that is a lie, and it would read as the feature costing nothing.

The window is Insights' own, resolved through `resolveWindow` — but the page has no time bar and takes
the window Insights *opens* on (`defaultWindow`). A second control here would be a second answer to
"over what stretch" on a page whose whole argument is that one number should be readable beside
another.

There is no way to measure whether an injected line was _read_, and the page does not pretend there
is. Cost is measurable, the corroboration count is measurable, the contradiction ratio is measurable,
and for a `lookup` fact demand is measurable — **how often it was actually asked for**, drawn on its
row. Four readings, and the fifth is not invented to sit beside them.

**An ask is an explicit `knowledge_ask` and nothing else.** A `lookup` fact also reaches agents
through the task-prompt append of every dispatch its scope matches, and counting that would make the
number a count of *dispatches matching a scope* — a fact about the fleet's week rather than about the
claim, under a label saying otherwise. A `check:format:check` claim would score highest in the week
`format:check` happened to fail most, and a fleet-scoped claim, which no scoped append ever carries,
could never score at all. The same shape of decision the contradiction section makes about which
facts may be disputed: the label has to match what is counted.

**The count is written on the credentialed path and never in the read.** `askFacts` is a read path and
`stateSnapshot` calls it **twice on every poll** to project the delivery view, so a counter kept inside
the store would count the operator's own browser as fleet demand — growing fastest while nobody is
looking at the page, and fastest of all on the claims nobody asks for. What keeps the cockpit out is
not a filter somebody has to remember but an argument that cannot be supplied: an ask is attributed to
an asker resolved from the credential (`AgentManager.askKnowledge`), exactly as every other write in
the tool channel is, and a poll has no agent, task, goal or session to give.

**A row per ask, not a counter** — the corroborations table's stance, with one word changed. A
corroboration is a row because the *words* are what an operator reads; an ask has none to give, so
what a row carries instead is who and when, which is what separates a claim forty agents wanted from
one an agent asked for forty times in a loop. It is counted as **rows rather than voices** and over the
whole life of the claim: independence is what a count needs when it *carries* a claim somewhere, and
this one carries nothing, exactly as `openContradictions` beside it is a count of decisions rather
than of voices.

**Every reading here is a reading and never a trigger.** Nothing is demoted, lapsed, dropped from the
block or deprioritised because it costs money, because its scope went stale, or because nobody asks
for it. A claim nobody asked for this month may be the one that saves the next agent a day. The
contradiction ratio is the precedent: it counts and it does not act.

## Committing to the repository

A claim that has held long enough is worth more in the tree than in this store, and moving it there
is the one transition in this design that ends outside the harness. `POST /api/knowledge/facts/:id/commit`
opens the documentation work; the fact reaches `committed` — and therefore leaves every prompt — when
that pull request actually lands.

**It goes through the `docs`-finding machinery, and through the same authority.** A promoted `docs`
finding is already "a fact about the repository that its own documentation does not state, worked by a
code agent that opens a pull request", which is what a graduation is. So a graduation renders the same
`docs-change` template ([05](05-dispatcher.md#prompt-templates)) and creates the same kind of job, and
`src/mcp/findings.ts`' argument carries over unchanged: **nothing auto-commits**, because an agent that
could queue this work could put agents on the fleet, which is a capability escalation rather than a
convenience. The machinery has two callers now and one template — a second `PromptId` would be a
second copy of an operator's "where documentation lives here" override to keep in step, diverging in
silence on exactly the deployments that customised most.

What graduation adds to that prompt — the observations behind the claim, where it is going, and what
the landing costs the claim — is **appended** rather than given placeholders, for the reason every
addition to a rendered prompt is (CLAUDE.md, "Prompts and templates").

### Which document, and who decides

A fact leaves for one of two places, and they are not interchangeable.

- **The owning spec document** takes almost everything, and the agent finds it. `docs/README.md` says
  which document owns what, and a fact that survived long enough to be committed is by definition an
  invariant of some subsystem — so naming the file is a judgement made better by the agent that has
  just read the code than by the operator clicking, and the `docs-change` template already says to
  follow the repository's own rule about where documentation lives.
- **`CLAUDE.md` takes only what meets its own bar**: things that, not knowing them, get something
  broken _silently_. That file is loaded into every agent's context on every dispatch, so
  indiscriminate graduation there grows without bound the exact cost this whole design exists to cap —
  and its length is asserted, not intended (`test/docsReferences.test.ts`).

**What stops CLAUDE.md being the cheap default is that it costs a sentence.** The commit body is a
discriminated union, and the `claudeMd` arm carries the operator's own statement of what breaks
silently without the claim — required by the body's _shape_, exactly as a `narrowed` contradiction
carries its claim, because an arm that could be taken by forgetting a field is the arm that gets taken.
The sentence is not ceremony: it is appended to the prompt, so the agent writing the entry has the
argument in the operator's words and is told to check that reading the way it checks the claim — and to
put the fact in the owning document instead, saying so in the pull request, if the failure turns out to
be a loud one.

### What a fact is between the click and the landing

**Nothing changes about it.** The claim keeps its reach, so it is still injected or still answered on
lookup, still rides the prompts it rode, and can still be contradicted while its pull request is in
review. That is a decision and not an oversight: a claim taken out of every prompt the moment somebody
queues a docs job is a claim the fleet stops being told while a pull request sits unreviewed — and if
that pull request is closed unmerged, it is a claim nobody committed and nobody reads, with nothing red.

So the intermediate state is **a row beside the fact and never a sixth reach**. Reach is how far a
claim carries, and a claim being written up carries exactly as far as it did yesterday; a reach would
have to be added to `askFacts`, to `ridesSystemPrompt` and to `contradictableFact` to mean "delivered",
and every one of those is a place it could be forgotten silently. `knowledge_graduations`
([14](14-persistence.md#graduations)) holds the job, the target, the operator's bar sentence and the
pull request, and a fact may have more than one over its life — a pull request closed unmerged leaves
the claim exactly where it was and the operator free to commit it again, and a column would have
overwritten the record of the attempt that failed, which is the one thing somebody deciding whether to
try again needs to read. A second graduation is refused while one is open: two agents writing the same
paragraph into two pull requests is two chances to land a half of it.

**A pull request closed unmerged ends the graduation and moves nothing.** Nobody committed the claim,
so it is still true, still delivered, and still committable. The row stays, drawn on its fact.

### How the landing is detected

**Swept for, never hooked** — [24](24-environments.md#recording-a-landing)'s argument, and it binds
harder here. A hook on the merge loses the landing to any restart that straddles it, or to a person
merging in the web UI between two pulses, and what is lost is not a number in a report: it is a claim
that goes on being injected into every prompt forever, paying context twice for one sentence, which is
the exact cost this whole subsystem exists to cap.

It takes its **own** reading rather than reusing `EnvironmentArrivalDesk`'s, because the two ask
different questions. That desk asks whether a commit has reached an environment, which needs the merge
SHA — a provider fact with a `closedPrWindowMs` shelf life that a squash leaves no ancestry link to. A
graduation needs no commit at all: it needs what became of one pull request, and the **work graph**
holds that durably, because it is upsert-only and keeps a merged PR long after `closedPullRequests` has
forgotten it (`work_nodes`, [14](14-persistence.md)). Reading the graph rather than the world is what makes the sweep
survive a restart across the merge. `src/knowledge/graduationDesk.ts` runs it, below `graph.record`
because it reads the graph and above `decide` because a fact it commits has to be out of the block the
launches on this pulse carry — and outside `src/dispatcher/` for `src/knowledge/noticeDesk.ts`' reason,
since it is a writer and `test/knowledge.test.ts` matches this store's method names over that directory.

**The reading is three-valued, and `unknown` is never folded into either of the others** — the
discipline [24](24-environments.md#the-three-verdicts) states. A pull request node the graph marks
merged with `provenance: 'inferred'` is one that vanished from the world without ever being seen
closed; absence-means-merged is a sane default for a lens and is not one here, because acting on it
takes a claim out of every prompt for a pull request that may have been closed unmerged while nothing
was watching. So the sweep settles on an **observed** merge and on an observed close, and says
`unknown` otherwise. `POST /api/knowledge/graduations/:id/settle` is the answer to that reading, and it
is the one place `committed` is an operator's own word: the objection that keeps `committed` off the
reach route — that it would take the claim out of every prompt while putting it nowhere — does not
apply once a pull request has actually been opened.

A documentation job that finishes without opening a pull request stays `waiting` rather than being
called abandoned on a guess. The template says an unopened pull request means nothing happened, the
page draws the row, and the operator decides.

### What a committed fact keeps

Everything except delivery. Its corroborations, its contradictions, its ratio and its provenance are
the record of how it got there, and the page draws them on a committed row exactly as on any other —
plus the pull request that put it in the tree, as a reference rather than as text. What it does not
keep is a way to be contradicted: an agent holding a sharper version of a committed claim is holding a
documentation change, and the refusal says so and names `report_finding` kind `docs`, which is a rail
that now exists rather than a gesture at one.

### What may be committed

A **standing** claim that reaches somebody. Two refusals, and neither is about authority:

- **A proposal reaches nobody.** One agent said it and nothing has agreed, so committing it would put
  an unvouched claim into the repository through an agent — the auto-promotion this whole design
  refuses, arriving through the one door that ends outside the harness. `lookup` is one click away.
- **A notice is a report on today.** An expiring fact is true until its clock runs out and the
  repository is for what stays true, so committing one would write this afternoon into a document that
  outlives it by years — and the fact's own lapse would then take the claim out of prompts it is no
  longer in while the document went on saying it.
