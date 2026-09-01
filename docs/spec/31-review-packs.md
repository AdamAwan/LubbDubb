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
| A gate                    | Nothing here blocks a merge. A pack is made because somebody asked for one, and an artefact that may never exist cannot be a precondition for anything. A false claim is shown, loudly. → [What a false claim does](#what-a-false-claim-does) |
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

A reviewer may override a label, and the override is recorded — but it is **never shown to the
checker on a later pack**. Given the overrides it would calibrate to what reviewers like rather than
to what is risky, and a label that has learned to agree with its reader has stopped being evidence.

The overrides are surfaced to the operator instead. A pattern of reviewers upgrading `skim` to `read`
says the checker is systematically underselling risk, which is worth more than any single pack and is
fixed by changing its prompt — a thing a person does, deliberately, once.

With nothing blocking, this label is the main thing steering where a reviewer spends their attention.
That makes its independence load-bearing rather than tidy.

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

## When a pack is made

**On request, and never automatically.** A reviewer asks for one from the pull request's page and
waits while it is written. The fleet opens more pull requests than anybody reads, and a pack nobody
opens is two agent runs spent on nothing — so the cost is paid by the person who chose to pay it, at
the moment they chose to.

The wait is the trade, and it falls at the worst possible moment: somebody has just sat down to
review and is told to hold on. That is accepted rather than solved. If it turns out to be intolerable
in practice, the answer is to pre-generate for a narrower set of pull requests, not to make everyone
pay for every one.

A pack is written against one head sha and stays written against it. When the head moves the pack is
marked **stale**, says how far behind it is, and **is still shown**. It is not regenerated underneath
a reader: a pack that re-flows mid-read costs the reader their place and tells them nothing about
what changed since they started, which is worse than being told it is old. Taking the new one is one
click, and it is the reader's to make.

### Pull requests nobody witnessed

A pack is offered for a human-authored pull request too, and the harness says plainly that there is
no witness log: every claim comes out `inferred`, and the pack's header states it rather than leaving
a reader to notice the absence of `witnessed` beside anything.

What is lost is the rejected alternatives, which are the best thing here. What survives is the idea
grouping, the `region` anchors and the whole of the check — which is most of the value, and more than
that pull request had before.

## What a false claim does

**Nothing blocks.** There is no gate, no merge coupling, and no override record, because there is
nothing to override. A pack reports; a person decides.

That is a deliberate trade and it has an obvious cost: an advisory finding is a finding somebody can
scroll past, and the checker's best output is exactly the thing that must not be scrolled past. The
answer is prominence rather than a lock, and it is a requirement on the surface rather than a hope:

- The pack's header states the count of false claims, and it is the first thing on the page.
- A reader cannot reach the ideas without passing it — it sits above them, not in a sidebar.
- The idea that carries a false claim is marked in its collapsed row, so the mark survives a reader
  who never opens anything.
- The claim itself is shown at the top of that idea, with the checker's evidence, not folded away
  with the supporting notes.

If those four are not true the decision to stay advisory is not being honoured, whatever the spec
says.

There is no mechanism for clearing a false claim, because there is nothing holding. The author is
re-run against the fixed code and the new pack replaces the old one, exactly as any other
regeneration does.

## Reading it

One surface, in the cockpit, one page per pull request. Three layers, and the ordering is the part
that matters:

1. **The whole change on one screen.** The ideas as one line each, their attention labels, and the
   count of false claims above them. A reader who stops here has the useful part: where the time
   goes, and whether anything is wrong.
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
| _review_packs_            | one row per (pull request, head sha): the pack and its verdicts          |

The pack is one document rather than a table per level. It is written whole and read whole, and
nothing queries inside it — three normalised tables would buy nothing and cost a join on every read.
The head sha it was written against is a column rather than a field, because staleness is decided by
comparing it to the pull request's head on every load. The witness log is separate because it is
appended to over time by a different party.

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

Three roles, and only the witness runs inside the work — a handful of tool calls on a session already
running, on every dispatch whether a pack is ever asked for or not. It is the cheap one, and it is the
one that must be paid up front: a log cannot be written after the fact, which is the whole point of it.

The other two are paid **per request, not per pull request**. The author is one agent over the diff,
the log and the tree. The checker is one agent whose work divides — each claim is verified
independently, so the pass parallelises to whatever headroom allows and its wall-clock is roughly one
claim rather than fourteen.

So the standing cost of the subsystem is the witness alone, and a pack is two agent runs spent
deliberately, against a person's review hour. A fleet opening twenty pull requests a day and reviewing
four pays for four.

## What was decided, and why

Six questions were open when this document was first written. They are settled here rather than
deleted, because each one has a losing option that will look attractive again later.

**Packs are made on request, never automatically.** Always-on is simpler to build and pays two agent
runs for every pull request nobody opens. The fleet's output already exceeds what anybody reads, so
the default would be waste by construction. → [When a pack is made](#when-a-pack-is-made)

**Nothing blocks.** A pack that only exists when asked for cannot be a precondition for merging —
requiring one would make packs mandatory through the back door and undo the trigger decision. So the
pack reports and a person decides, and the risk that creates is answered with prominence rather than
a lock. → [What a false claim does](#what-a-false-claim-does)

**A stale pack is shown, not regenerated.** Regenerating under a reader costs them their place and
tells them nothing about what moved. → [When a pack is made](#when-a-pack-is-made)

**Human-authored pull requests get a pack, and are told the log is missing.** Every claim comes out
`inferred`. Less than a witnessed pack, more than that pull request had.
→ [Pull requests nobody witnessed](#pull-requests-nobody-witnessed)

**Nothing audits the author's quotation of the log, by design.** A `witnessed` claim cites its entry
and the entry is rendered verbatim beside it, so a reader sees both halves. A fourth agent auditing
the third was the alternative; the regress has to stop somewhere, and it stops at the reader.
→ [Provenance](#provenance)

**Attention overrides are recorded and never fed back to the checker.** Shown the overrides, it would
calibrate to what reviewers like rather than to what is risky, and the label would stop being
independent evidence. The pattern is surfaced to the operator instead: reviewers steadily upgrading
`skim` to `read` means the checker's prompt is wrong, and that is a change a person makes.
→ [Attention](#attention)

**A pack files nothing on the validation bench.** [20](20-validation.md) is about a delivered goal; a
pack is about a change. Coupling them would put a row on the bench for every pull request whose pack
found something, which early on is most of them.

## What is still open

**`plumbing` will rot.** It is the honest answer to hunks that carry nothing to review, and it is also
where an author will put anything it cannot be bothered to explain. The checker verifying that those
hunks are semantically empty is the defence, and it is not obviously enough. Expect this to be the
first thing that needs tightening, and watch the ratio of plumbing hunks to owned ones as the signal.

**Whether the wait is tolerable.** Asking for a pack and waiting lands at the worst moment — somebody
has just sat down to review. If that turns out to drive people away from asking, the fix is
pre-generating for a narrower set of pull requests, never making everyone pay for every one.
