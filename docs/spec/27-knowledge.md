# 27 — Knowledge

> **Status: not yet built — all seven phases outstanding.** Everything below describes behaviour this
> subsystem is meant to have, none of which exists yet; [The phases](#the-phases) says what lands
> when. Per `docs/README.md`, a module that does not exist yet is named in italics —
> _src/knowledge/facts.ts_ — where a real one is backticked, and a phase landing deletes its row and
> unmarks the part of this document it makes true. When the last row goes, so does this banner.

Hundreds of agents work this repository and each one starts knowing nothing about it. What they learn
— that `knip` runs every rule at `error`, that a route handler never reads the request, that
`test (windows)` has been timing out at the install step all afternoon — is learned again, at full
price, by the next agent to need it. This is the record of what the fleet knows, and the four
different distances it can carry a fact.

## What this replaces

Knowledge is not a sixth store beside five others. It is those five collapsed into one, because they
are five answers to one question that share no vocabulary and cannot be read against each other.

| Today                   | Holds                                        | Reaches an agent                        |
| ----------------------- | -------------------------------------------- | --------------------------------------- |
| `lessons`               | Durable claims, operator-vouched             | System prompt, capped                   |
| `findings` kind `docs`  | "The repository does not say this"           | Nothing — until an operator makes a job |
| `remedies`              | Why the fleet came back to a pull request    | The next CI/review prompt, per check    |
| `scratchpads`           | Notes between siblings on one goal           | The goal's own agents, on request       |
| `retrospectives`        | The write-up of a delivered goal             | Nothing                                 |

Three of the five hold the same shape of claim — _something true of this repository that the
repository does not say_ — arriving through three tools that do not know about each other and landing
in three different places. A remedy's `undocumented` lesson and a `docs` finding are the same
sentence written twice.

**The scratchpad is not folded in.** A pad is a conversation between siblings on one goal,
chronological and unstructured; its entries are not claims, have no evidence and nothing to
corroborate. Two writable stores for one kind of content is the drift this codebase refuses
everywhere else, so the pad keeps its own writer and this page links to it. A pad note that turns out
to be durable is **proposed** as a fact by the agent that found it useful.

`remedies` survives as what it always was — the **event** record of one return to a pull request,
with its counts and its dollars ([18](18-observability.md)) — and gains the ability to propose a fact.
An account of an event and a durable claim are different animals and folding them together would lose
the counts.

## Three axes, not one list

A fact carries three independent fields, and the most common way to get this wrong is to fold them
into one enum. "A flaky check" and "fleet-wide" are not two values of the same thing: the first is a
statement about how long a fact lives and the second about who it applies to. A flaky check is
fleet-scoped **and** expiring; "the pets vivarium is off by default" is fleet-scoped and permanent.

### Scope — who it is relevant to

| Scope           | Written                | Means                                                                 |
| --------------- | ---------------------- | --------------------------------------------------------------------- |
| Fleet           | `fleet`                | True of working this repository at all. The most expensive to be wrong. |
| Check           | `check:<name>`         | True of one CI check. The name is the provider's identifier.           |
| Goal            | `goal:<issue ref>`     | True of one goal, and dies with it.                                    |

Scope is drawn as a reference token in the cockpit, so it is a place a reader can go rather than a
label.

**A `check:` scope is fragile, and the page says so.** A check name is a provider identifier that
changes when somebody renames a job or adds a matrix dimension. `priorRemedies` already matches check
names exactly and accepts the same fragility for the same reason — a prefix match would put another
job's history in front of an agent under a name it would read as its own. The failure is silent: the
fact simply stops being delivered. So a fact whose scope has matched nothing in `knowledgeScopeStaleDays`
is surfaced on the page as scoped to a check that no longer runs, which is the only way that can be
seen.

### Lifetime — how it ends

A fact either **stands** until it is retired, or it **expires**. An expiring fact is a _notice_, and
notices are a different animal in every respect that matters — see [Notices](#notices).

An expiring fact may also carry a **resolution condition** the harness can evaluate: `main` red on a
check resolves when that check goes green, not when a timer runs out. The clock is the backstop, not
the mechanism. A timer alone either drops a notice while it is still true — and the fleet
rediscovers it — or keeps one alive after the thing is fixed, which teaches every agent to skip a
check that is now genuinely failing. Both are silent.

### Reach — how far it carries

Reach is the state machine, and it is the whole of the governance.

| Reach       | Where the fact is                                  | What moves it here                       |
| ----------- | -------------------------------------------------- | ---------------------------------------- |
| `proposal`  | Nowhere. One agent said it and nothing has agreed.  | An agent proposing.                      |
| `lookup`    | Answered when asked; injected on a matching scope.  | Two independent corroborations, or you.  |
| `injected`  | In front of every agent, before it reads any code.  | **You, and only you.**                   |
| `committed` | In the repository. **Out of every prompt.**         | A docs pull request landing.             |
| `rejected`  | Nowhere, and barred from coming back.               | You.                                     |

**`committed` is not the top of a ladder — it is a different medium.** Once a fact is in
`docs/spec/` an agent reads it from the repository, and keeping it injected pays context twice for
one sentence. So committing **removes** the fact from every prompt and leaves a link to the pull
request behind. The number an operator should watch is this list growing and the injected list
shrinking: the knowledge base is a staging area, and success is it running out of durable facts to
hold.

## Corroboration

A fact reaches `lookup` on **two corroborations from two different goals**, and never on an operator's
absence of objection.

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

Corroborations are rows in their own table, each carrying the agent, the goal, the moment and **the
agent's own words** — never a counter on the fact. The count is what promotes; the words are what an
operator reads to decide whether it should have.

## Contradiction, and why it does not delete

An agent that finds an injected fact contradicted by the code in front of it says so. This is the
half `lessons` never had: today staleness rests on an agent mentioning it in a retrospective and a
human noticing, which is why `src/lessonBlock.ts`'s header has to ask for it in prose.

**A contradiction demands an amendment.** The contradicting agent must say what the claim should say
instead, and that amendment is filed as a new proposal linked to the original. Nothing is demoted by
count alone.

The reason is that a contradiction count punishes exactly the wrong claims. A claim that is right in
general and wrong at one edge attracts contradictions **because it is being used**, and those are the
most valuable claims in the store. The real example this design was drawn against: _drop the `export`
keyword rather than delete it_ is true of a type or a helper and false of a class member, where knip's
analysis is name-based. Three agents hitting that edge should sharpen the claim, not delete it. Under
a count, they delete it.

An operator resolving a contradiction has three moves: promote the amendment and supersede the
original, narrow the original by hand, or reject the contradiction. Only the last leaves the fact
where it was.

## Rejection bars a claim — and amendment is how a barred claim comes back

**A rejected fact is immune to re-proposal and to corroboration.** `src/store/findings.ts` already
takes this stance for a dismissed finding — a claim an operator has answered is not something a later
report is folded silently into — and here it is load-bearing rather than tidy: without it, two agents
re-propose next week what you killed today and auto-promotion resurrects it, on its own.

Matching is `claimKey` and `claimsMatch` from `src/store/findings.ts`: normalisation to alphanumerics,
then equality or whole-word containment above a length floor. That machinery is already written and
already tuned; this store uses it rather than growing a second matcher free to disagree with it.

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

**A notice states an observation. It never states an instruction.** This is `src/lessonBlock.ts`'s
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

**Auto-promotion is bounded by lifetime, and that is the whole safety argument.** A notice may reach
`injected` on corroboration alone because its blast radius is capped by its own clock; a permanent
fleet-wide fact may not, because a stale line in every agent's prompt is a false instruction handed to
every agent before it reads any code, and it fails silently. That is the argument
`src/server/routes/lessons.ts` already makes about promotion being the feature, and nothing here
weakens it.

## Delivery: two prompts, not one

Reach and scope interact, and the interaction decides **which** prompt a fact rides.

- **The system prompt** carries the notices and the globally-injected fleet facts. It is identical
  for every agent on a dispatch kind, which is what keeps it a cached prefix — the entire reason
  lessons live there rather than in the task prompt (`src/lessonBlock.ts`). Nothing in it varies per
  run: no goal name, no branch, no agent id, and every date is the fact's own.
- **The task prompt** carries the facts whose scope matches _this_ dispatch — the `check:` facts for
  the checks that are red, the `goal:` facts for the goal. These vary per dispatch and would destroy
  the cache in the system prompt. They are **appended**, exactly as `priorRemedies` is appended
  today, and for its reason: prompt templates are operator-overridable and `loadPromptTemplates`
  rejects only _unknown_ placeholders, so a `{knowledge}` token would be silently dropped by every
  override written before this existed.

The consequence is that `lookup` means _not injected everywhere_, not _never injected_. A
`check:format:check` fact costs nothing on a dispatch about anything else and is in front of the agent
that needs it without anyone asking. The tool becomes a fallback rather than the delivery mechanism —
which matters, because `report_remedy` is classified `point-of-use` in `test/mcpChannel.test.ts`
precisely because a tool named nowhere but in `tools/list` is a tool an agent finishes without.

### The cap, and saying what it dropped

The system-prompt block is bounded by `knowledgeBlockChars`, and whole facts are dropped at the bound,
oldest-vouched first. Half a claim is a different claim.

**The block says out loud that it is partial**, names how many facts it is not carrying, and names the
tool to ask with. `ciEvidenceNote` and `renderLessonBlock` both take this stance: an agent that reads
a partial record as a whole one concludes something from the absence of an entry that was merely
trimmed, which is worse than having no record at all.

## What the fleet writes with

Four tools, and the widening of who may write is the cheap half of this design — proposals cost
nothing until somebody vouches, and the gate is unchanged.

| Tool                    | Who may call it     | Does                                                            |
| ----------------------- | ------------------- | ---------------------------------------------------------------- |
| `knowledge_propose`     | **Any agent**       | Files a claim with its scope, lifetime and evidence.             |
| `knowledge_ask`         | **Any agent**       | Returns facts matching a scope or a question.                    |
| `knowledge_contradict`  | **Any agent**       | Says an injected fact is contradicted, **with the amendment**.   |
| `knowledge_notice`      | **Any agent**       | Raises an expiring observation.                                  |

Today only `retro_submit` and `report_remedy` may propose a lesson, and the remedy arm only under one
of four guard verdicts — so a planning agent, an assayer, a validator or an issue-work agent cannot
record what it learned at all except by surviving to a retrospective. That narrowness has no argument
behind it.

`report_remedy` and `report_finding` keep their own jobs and gain a proposal arm: a remedy is still
the event record, and a `docs` finding is still the thing that becomes a documentation pull request.

## In the cockpit

One page, `?page=knowledge`, and its state lives on `Place` like every other piece of "where am I"
([17](17-cockpit.md#the-address-bar)).

The page reads top to bottom in the order things demand attention: **Live notices** with their clocks,
**Needs you** — the corroborated proposals waiting on the one decision that is yours — then
**Injected** with the block's character budget drawn against its cap, **On lookup**, and **Committed
to the repository**. A row carries the claim, its scope as a reference, its corroboration count and
its provenance; a contradicted fact is drawn as contradicted, and a fact past the cap is drawn as not
reaching agents, because the panel is the only place either can be seen.

**A second surface renders what an agent actually receives**, per dispatch kind and per check, from
the same function the launch uses — never a second reading of it. `LessonsPanel` already carries this
idea in miniature ("is this claim actually being sent"); a store this size cannot be governed without
it.

## What nothing does

- **No rule, desk or gate reads a fact.** Nothing is dispatched, held, or ranked because of one. A
  fact feeds prompts and a panel, and that is the whole of it — `src/remedies/remedies.ts` takes this
  stance already and it survives unchanged.
- **Nothing auto-promotes to `injected` except a notice**, and a notice cannot outlive its clock.
- **Nothing auto-commits to the repository.** A docs pull request is a dispatch a person promotes,
  through the machinery `src/mcp/findings.ts` already has.

## What it costs

The injected block is input tokens on **every dispatch**, so the page prices it in the dollars the
rest of the cockpit uses — against the same window as Insights ([18](18-observability.md)) — rather
than in tokens, which mean nothing at a glance.

There is no way to measure whether an injected line was _read_. Cost is measurable, the corroboration
count is measurable, and the contradiction ratio is measurable; the page shows those three and does
not pretend to the fourth. A `lookup` fact has the better signal — how often it was actually asked for
— and that is drawn on its row.

## Committing to the repository

A fact leaves for one of two places, and they are not interchangeable.

- **The owning spec document** takes almost everything. `docs/README.md` says which document owns
  what, and a fact that survived long enough to be committed is by definition an invariant of some
  subsystem.
- **`CLAUDE.md` takes only what meets its own bar**: things that, not knowing them, get something
  broken _silently_. That file is loaded into every agent's context on every dispatch, so
  indiscriminate graduation there grows without bound the exact cost this whole design exists to cap —
  and its length is asserted, not intended (`test/docsReferences.test.ts`).

## The phases

Ordered so each lands something usable and nothing before it is wasted. Every phase updates the part
of this document it makes true.

| # | Lands                                                                                                                                                                                                | Depends on |
| - | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1 | The store and the axes. _src/store/knowledge.ts_ (facts, corroborations), scope/lifetime/reach, `claimKey` matching reused from findings, the rejection bar and `supersedes`. `knowledge_propose` and `knowledge_ask`. Promoted `lessons` migrate in. | —          |
| 2 | The Knowledge page: the five sections, the budget meter, promote/demote/reject. Nothing new reaches an agent — this is the surface that makes phase 3 safe to turn on.                                | 1          |
| 3 | Delivery. _src/knowledge/block.ts_ renders the system-prompt block under `knowledgeBlockChars`; scope-matched facts append to the task prompt beside `priorRemedies`. The "what an agent receives" surface. | 1, 2       |
| 4 | Notices. `knowledge_notice`, expiry, resolution conditions, the always-injected tier, and the harness-written notices for same-commit red→green and base-branch red.                                  | 3          |
| 5 | Contradiction and amendment. `knowledge_contradict`, the amendment proposal, the contradiction ratio on the page.                                                                                     | 2, 3       |
| 6 | Graduation. Committing a fact opens a documentation pull request through the `docs`-finding machinery, and the fact leaves every prompt when it lands.                                                | 2          |
| 7 | Cost and drift. Dollars per dispatch on the page; stale `check:` scopes surfaced; lookup ask-counts.                                                                                                  | 3          |

Phases 1–3 are the spine: without 3 nothing reaches an agent, and without 2 nothing can be governed.
4 through 7 are independent of each other and can land in any order.
