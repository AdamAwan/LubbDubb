# 31 — Review packs

**Not yet built.** Nothing in this document describes running code. Every path it names is italic for
that reason, and the marker comes off in the change that makes each section true.

A diff is what is left over after the thinking. The reasoning that produced it — what was considered,
what was rejected, which file was deliberately not touched — is thrown away at the moment of commit,
and a reviewer's job is to reconstruct it from the residue. That reconstruction is slow, it is done
badly under time pressure, and with agent-written code there is often no human memory to reconstruct
it from at all. The fleet can open pull requests faster than anybody can read them, which makes
review the one place a harness that works can still fail.

This subsystem attacks the reconstruction rather than the reading. The agent that wrote the change
**had** the reasoning; it costs almost nothing to record the forks as they are taken, and everything
to recover them afterwards. A second agent turns that record and the diff into a **review pack**: the
change restated as a handful of _ideas_, each one followed through every file it touched, in the
order the reasoning ran. A third agent marks every sentence in it true, false or undecidable against
the tree.

Two properties do the work, and neither is presentation:

- **A pack is a set of falsifiable claims, not a summary.** A summary is a story an agent tells about
  its own work, and these models tell a good one whether or not the work was good. A claim can be
  checked, and one of them being false is worth more than the rest of the pack put together.
- **A pack can point at code that is not in the diff.** Most of the silent failures this repo
  catalogues in [`CLAUDE.md`](../../CLAUDE.md) are of the form _you changed A and did not change B_ —
  a column without its migration, a tool without its name in `MCP_TOOL_NAMES`, a colour without its
  token. The absence is the bug, and no diff can show an absence. A pack can.

## What it is not

| Not                       | Because                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A code reviewer           | Nothing here forms an opinion about whether the change is good. It states what the change does, follows it through the tree, and marks its own statements true or false. The judgement stays with a person.  |
| A replacement for reading | The pack's job is to make the code readable in the right order, not to stand in for it. A surface that answers well enough to approve from is a regression, and the shape in [Reading it](#reading-it) resists it. |
| A summariser              | A summary is unfalsifiable. Every sentence a pack ships is a claim with a verdict beside it, or it is a gist attached to code the reader can see.                                                              |
| A dispatch input          | Same rule as the rest of the lenses: nothing under `src/dispatcher/` may import this. A pack is a read-only view assembled after the work. → [05](05-dispatcher.md)                                            |
| A quality gate on code    | The gate in [What blocks](#what-blocks) holds on the pack being **honest**, never on the change being good. A false claim blocks; an ugly function does not.                                                    |
| A commit message          | A commit message is one narrative for the whole change. A pack is several, one per idea, each with its own walk and its own verdicts — and it carries code, which a message cannot.                            |
| An always-on cost         | Three roles, and only one of them runs inside the work. → [Cost](#cost)                                                                                                                                        |

## The three roles

The pack is produced by three agents that see deliberately different things. The separation is the
whole design: each one only has to distrust the one before it, and none is ever asked to check its
own output.

| Role        | Runs               | Sees                                          | Writes                                        |
| ----------- | ------------------ | --------------------------------------------- | --------------------------------------------- |
| **Witness** | inside the work    | everything — it _is_ the working agent        | the witness log, as it goes                   |
| **Author**  | after the work     | the witness log, the diff, the tree           | the pack: ideas, claims, anchors              |
| **Checker** | after the pack     | the diff, the tree, the claims — **not** the log, **not** the author's prose | a verdict and its evidence per claim |

Three things follow that are easy to lose and expensive to re-derive:

**The witness never writes the pack.** It is the party with an interest in the work looking sound,
and it is also mid-task and bad at prose. Asking it to narrate produces a tidy story assembled
backwards from a passing test run. Asking it to record forks produces facts.

**The author is told the log is unreliable — specifically, not generally.** A general instruction to
distrust makes a model hedge everything or manufacture disagreements to look diligent. The rule it is
given is exact: _where a note and the code disagree, the code wins, and the disagreement is a
finding._ That finding — the author said it did X, it does Y — is the cheapest real bug this
subsystem catches, and it is free once both halves are in hand.

**The checker never sees the story it is testing.** It is handed claims as bare sentences and the
tree, and asked whether each holds. Given the author's reasoning it would be persuaded by it, which
is the failure mode the third role exists to avoid.

## The witness log

The working agent records **forks**, not commentary. A fork is a moment where the change could
reasonably have gone another way. One line at the fork is cheap; recovering it afterwards is
impossible.

It writes through a tool on the fleet's MCP channel, _record_decision_, alongside the existing tools
in `src/mcp/tools/`. Adding it means the three-way agreement in [11](11-mcp-tools.md#launch-flags) —
the server id, `MCP_TOOL_NAMES`, and the `mcp__lubbdubb__*` grant — and `test/mcpChannel.test.ts`
asserts all three against each other.

An entry carries:

| Field      | What                                                                          |
| ---------- | ----------------------------------------------------------------------------- |
| `at`       | when, from the harness clock, not the agent's belief about the time           |
| `chose`    | one line: what the change does here                                           |
| `because`  | one line: why                                                                 |
| `rejected` | zero or more alternatives, each with the reason it was not taken              |
| `paths`    | the files the fork touches, where the agent can say                           |

`rejected` is the field that justifies the subsystem. _Why not derive it from the span?_ is the
question a reviewer asks most often and the one a diff can never answer, because the road not taken
leaves no trace in the tree. Everything else in an entry can be inferred later at some cost; a
rejected alternative cannot be inferred at all.

Three rules hold the log honest, and all three are properties of the tool rather than instructions in
a prompt:

- **Append-only.** The tool offers no edit and no delete. A later entry may supersede an earlier one
  and says so; the earlier one stays.
- **No prose ceiling to fill.** An agent with nothing to record writes nothing. An empty log is an
  honest outcome and the author says the pack was written without one, rather than the witness
  padding to look thorough.
- **It never renders to a human.** The log is an input to the author and evidence beside a claim
  ([Provenance](#provenance)). It is not a surface, and it is not written to be read.

The instruction to use it is **appended** to the rendered execution prompt, never interpolated into
it — an operator's overridden template never learned the placeholder, and interpolation drops it
silently on exactly the deployments that customised most. → [09](09-execution.md),
[05](05-dispatcher.md#prompt-templates)

## The pack

### An idea

An **idea** is a claim plus an ordered walk of anchors. It is the unit the whole subsystem exists to
produce, because it is the unit a change is actually made in — and the unit a diff destroys by
sorting everything alphabetically by path.

| Field       | What                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------- |
| `claim`     | one sentence, falsifiable, stating what this idea does                                            |
| `anchors`   | ordered — the walk, in the order the reasoning ran, not the order the files sort in                |
| `claims`    | the checkable statements this idea rests on ([Claims](#claims))                                    |
| `attention` | how much scrutiny it needs, set by the **checker** ([Attention](#attention))                       |

An idea's walk crosses files freely and is expected to: a change in this repo is naturally vertical —
domain type, wire type, store module, route, cockpit, spec, test — and reviewing those six files
separately is how a whole class of the sharp edges gets missed.

### An anchor

An anchor is a place in the tree the walk stops at, with one line saying why it stops there. Two
kinds, and the second is the point:

| Kind     | What                                                | Drawn                    |
| -------- | --------------------------------------------------- | ------------------------ |
| `hunk`   | a range of the diff                                 | solid                    |
| `region` | a range of a file **not in the diff**               | dashed                   |

A `region` anchor is either **context** — code the change cannot be judged without, which the pull
request does not contain — or a **deliberate absence**: the file a reader would expect to have
changed, shown unchanged, with the reason. The second kind is the one that reaches the failures this
repo cannot otherwise review, and it is worth building even if nothing else here is.

Every anchor carries a `gist` (one line, always shown) and may carry a `note` (the reasoning, folded
away). The gist belongs to the code; the note is support and is never required to understand it.

### Coverage

**Every hunk in the diff has exactly one owning idea.** A hunk nothing claims is either scope creep
nobody declared or an omission from the pack, and both are things a reviewer must be told rather than
left to notice. Coverage is mechanical, so it is checked mechanically.

Two escape valves, because the invariant is otherwise false in practice:

- **A hunk may be _referenced_ by other ideas** as a `region` anchor, while still having one owner.
  Shared code genuinely serves several ideas; pretending otherwise forces a bad assignment.
- **A reserved idea, `plumbing`,** owns hunks that carry no meaning to review: mechanical renames,
  formatting, generated files, a lockfile. It is declared like any other idea and the checker
  verifies the claim that its hunks are semantically empty. Without it the author is pushed to invent
  a story for a rename, which is worse than saying there isn't one.

### Claims

A claim is a sentence that can be shown false. "This is cleaner" is not a claim. "These are the only
two callers" is.

| Field        | What                                                                        |
| ------------ | --------------------------------------------------------------------------- |
| `text`       | the sentence                                                                |
| `provenance` | where it came from ([Provenance](#provenance))                              |
| `verdict`    | `true`, `false` or `cant_tell`, written by the checker                      |
| `evidence`   | what the checker did to decide — the search, the test, the file it read     |

### Provenance

Every claim states where it came from, and this is structural rather than decorative. A claim
traceable to something the witness wrote at the time is worth more than one the author reconstructed
from the diff, and a reader must be able to tell which they are looking at.

| Provenance  | Means                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| `witnessed` | traceable to a witness entry, which it cites by id — the entry is shown beside it, verbatim                  |
| `inferred`  | the author's reading of the code; the witness said nothing about this                                        |
| `disputed`  | a witness entry and the code disagree. The claim states what the code does; the entry is shown beside it     |

`witnessed` claims cite the entry and the cockpit renders it unedited next to the claim. That is what
stops the author quietly improving a note in the retelling — not a fourth agent checking the third,
but the reader seeing both halves at once. A `disputed` claim is a finding in its own right and is
surfaced as one.

### Attention

Each idea carries a label saying how hard to look: **read**, **decide**, **skim** or **split**.

The label is written by the **checker**, never the author. How much scrutiny a change deserves is
exactly the judgement not to take from the party that produced it. `split` is the checker's opinion
that an idea is unrelated to the rest of the pull request and could be its own.

A reviewer may override a label, and the override is recorded. A pattern of reviewers upgrading
`skim` to `read` is the signal that the checker is systematically underselling risk, and is worth
more than any single pack.

## The check

The checker is handed the claims as bare sentences, the diff, and the tree at the pull request's
head. It is not given the witness log, the author's notes, or the ideas' prose. It answers one
question per claim and writes down how it answered.

| Verdict     | When                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `true`      | reproduced against the tree. The evidence names what was run or read                                      |
| `false`     | the tree contradicts it. The evidence names the contradiction                                             |
| `cant_tell` | not decidable from this repository: a claim about the outside world, a product judgement, an intention    |

`cant_tell` is a first-class answer and not a failure. A pack that claims something about how a
vendor meters usage, or about what an operator would find confusing, is making a claim a codebase
cannot settle — folding that into `false` would train reviewers to ignore the verdict, and folding it
into `true` is a lie. It is surfaced to the person, whose call it is.

**The checker may not edit the pack.** It writes verdicts and evidence. It does not reword a claim it
disagrees with, reassign an anchor, or open a code change — all three would make it an author, and
there would again be nobody checking.

## What blocks

A pack has a **gate status**, and it holds on the pack being honest rather than on the change being
good.

Blocks:

- any claim with verdict `false`
- a hunk with no owning idea
- a pack whose head no longer matches the pull request's head, once one is required

Does not block:

- `cant_tell` verdicts — those are for the reviewer
- an empty witness log — honest, and the pack says so
- attention labels, or a reviewer disagreeing with one

A block is released by a **new pack over a new head** — the author re-runs against the fixed code —
or by an **operator override**, which is recorded with its reason and shown on the pack from then on.
Hand-editing a claim to make it true is not a release, and the shape of the store makes it awkward on
purpose.

Where the harness holds its own merge gate ([07](07-pull-requests.md)), a blocked pack holds it too.
It never blocks a person: an operator who wants to merge past a red pack can, and the override says
who and why.

## Reading it

One surface, in the cockpit, one page per pull request. Three layers, and the ordering is the part
that matters:

1. **The whole change on one screen.** The ideas as one line each, their attention labels, the gate.
   A reader who stops here has the useful part: where the time goes, and whether anything is wrong.
2. **The code.** Opening an idea shows the walk — every anchor, with its actual code, in reasoning
   order. This is the layer the reader is meant to spend time in.
3. **The reasoning.** Under each anchor, folded away, the note and the witness entry behind it.

Layer 2 is code and not prose deliberately. A pack whose middle layer was the author's narrative
would be a surface people approve from without reading the change, which is worse than the review it
replaces. The prose is support; it is never the thing in the middle.

The page's position — which pull request, which idea is open — is `Place` state and lives in the
query string, not a `useState` in `useCockpit`: a surface held outside it is stepped over by the back
button and dropped by a reload, both silently. → [17](17-cockpit.md#the-address-bar)

Every reference to a goal, a pull request or an issue is drawn with `<Ref to={ref}/>`
(`web/src/components/refs.tsx`), never as text. → [17](17-cockpit.md#links)

## Where it lives

Two tables, in a new module under `src/store/` — the only directory that touches SQLite, one module
per group of related tables, taking a `StoreContext`, with `Store` delegating under the same method
names. → [14](14-persistence.md#shape)

| Table                     | Holds                                                                    |
| ------------------------- | ------------------------------------------------------------------------ |
| _review_witness_entries_  | one row per fork, appended during the work, never updated                |
| _review_packs_            | one row per (pull request, head sha): the pack, its verdicts, its gate   |

The pack is one document rather than a table per level. It is written whole, read whole, and its only
queried field is the gate status — three normalised tables would buy nothing and cost a join on every
read. The witness log is separate because it is appended to over time by a different party.

Both tables are new, so neither needs a `ColumnMigrations` entry; a table being new **once** does not
keep it exempt, and the first column added to either afterwards needs an additive `ALTER TABLE`
guarded by a `PRAGMA table_info` check. → [14](14-persistence.md#migrations)

The shapes the routes ship live in `src/wire.ts`, and a wire type either **is** the domain type or
`extends` it — never a re-declaration and never widened. `test/wireContract.test.ts` asserts that
`src/wire.ts` is the only server module anything under `web/src/` names.

Routes go in a new module under `src/server/routes/` with an entry in `app.ts`'s `ROUTE_MODULES`, and
every handler is wrapped in `checked(schemas, handler)` rather than reading the request itself.
→ [16](16-http-api.md#shape)

Two new prompt ids, _review-pack-author_ and _review-pack-check_, registered like any other. A
`PromptId` is never deleted once it exists — it is marked `retired: true`, because
`loadPromptTemplates` throws on a file naming no known id and removing one turns every deployment
that overrode it into a harness that will not boot. → [05](05-dispatcher.md#prompt-templates)

## Cost

Three roles, and only the witness runs inside the work — it is a handful of tool calls on a session
already running, and it is the cheap one.

The author is one agent over the diff, the log and the tree. The checker is one agent, and its work
divides: each claim is verified independently, so the pass parallelises to whatever headroom allows
and its wall-clock is roughly one claim, not fourteen.

So a pack is about two extra agent runs per pull request. The thing it is spent against is a person's
review hour, which is both more expensive and the fleet's actual bottleneck — but it is spent per
pull request, and a fleet opening twenty a day is spending it forty times. Whether that trade holds
is a deployment's to make, which is why [Open questions](#open-questions) puts the trigger first.

## Open questions

These are unsettled, and each changes what gets built.

1. **What triggers a pack.** Every pull request the fleet opens, only those a human is about to
   review, or on request? Always-on is simplest and pays the cost on packs nobody opens.
2. **Regeneration.** A pack is written against one head. Does a push regenerate it — losing a
   reviewer's place mid-read — or does the pack go stale and say so until asked?
3. **Human-authored pull requests.** No witness log exists. The author can still produce a pack from
   the diff and the tree, and the `region` anchors still work. Is a log-less pack worth the run?
4. **Blocking.** Does a red pack hold the harness's own merge gate, or only display? This document
   assumes it holds; that is an assumption, not a settled decision.
5. **The author checking the log.** Nothing verifies that the author quoted the witness faithfully.
   The mitigation here is to render the cited entry verbatim beside the claim and let the reader see
   both. A fourth agent would be the alternative, and is probably not worth it.
6. **Feedback.** Reviewer overrides of `attention` are recorded. Should the checker see them on later
   packs — which would let it calibrate, and also let it learn to say what reviewers like?
7. **Relationship to the validation bench.** [20](20-validation.md) already asks for evidence about a
   delivered goal. A pack is evidence about a change. Whether the two are one surface or two is
   unresolved, and doing it wrong duplicates a bench row for every pull request.
