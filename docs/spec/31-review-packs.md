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
| The fleet review          | [07](07-pull-requests.md#the-fleet-review)'s `pr-review` reads the same diff, and a deployment with both on pays two readings of it. That is deliberate: the review is one round, policy-mandated on the deployments that run it, and its charter is the project's; folding a pack into it would put a second job in that agent's context. Neither reads the other's output. |
| A replacement for reading | The pack's job is to make the code readable in the right order, not to stand in for it. A surface that answers well enough to approve from is a regression, and the shape in [Reading it](#reading-it) resists it. |
| A summariser              | A summary is unfalsifiable. Every sentence a pack ships is a claim with a verdict beside it, or it is a gist attached to code the reader can see.                                                              |
| A dispatch input          | Same rule as the rest of the lenses: nothing under `src/dispatcher/` may import this. A pack is a read-only view assembled after the work. → [05](05-dispatcher.md)                                            |
| A gate                    | Nothing here blocks a merge. A pack is made because somebody asked for one, and an artefact that may never exist cannot be a precondition for anything. A false claim is shown, loudly. → [What a false claim does](#what-a-false-claim-does) |
| A commit message          | A commit message is one narrative for the whole change. A pack is several, one per idea, each with its own walk and its own verdicts — and it carries code, which a message cannot.                            |
| An always-on cost         | Three roles, and only one of them runs inside the work. → [Cost](#cost)                                                                                                                                        |
| A page the harness owns   | What the three agents produce is a JSON document. The cockpit and the shared HTML companion are both renderings of it, and neither is ever read back. → [A pack is data](#a-pack-is-data-and-rendering-is-downstream) |

## The three roles

The pack is produced by three agents that see deliberately different things. The separation is the
whole design: each one only has to distrust the one before it, and none is ever asked to check its
own output.

| Role        | Runs               | Sees                                          | Writes                                        |
| ----------- | ------------------ | --------------------------------------------- | --------------------------------------------- |
| **Witness** | inside the work    | everything — it _is_ the working agent        | the witness log, as it goes                   |
| **Author**  | after the work     | the witness log, the diff, the tree           | the pack: ideas, claims, anchors              |
| **Checker** | after the pack     | the diff, the tree, each idea's one-line claim and anchor list, the claims — **not** the log, **not** the notes | a verdict and its evidence per claim, and an attention label per idea |

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
is the failure mode the third role exists to avoid. What it _is_ handed is the skeleton of each idea —
its one-line claim and the ordered anchors, without their notes — because the
[attention label](#attention) is a judgement about an idea, and `split` is a judgement about how the
ideas relate. A checker shown only a flat list of sentences could not write either.

## The witness log

The working agent records **forks**, not commentary. A fork is a moment where the change could
reasonably have gone another way. One line at the fork is cheap; recovering it afterwards costs
more than the pack ([below](#the-witness-log)).

**The witness log is the scratchpad.** The pad ([11](11-mcp-tools.md#the-tools), `scratch_append`) is
already an append-only, attributed, per-goal record that survives worktree reuse and re-dispatch and is
replayed to the next agent on the goal — which is every property the log needs, and a second store
with the same properties would be the pad again under another name. A fork is a pad entry that
carries a _decision_ argument beside its note; an entry without one is an ordinary note. No new tool,
so the three-way agreement in [11](11-mcp-tools.md#launch-flags) is untouched; the tool's schema grows
one optional object, and `scratch_entries` grows one column — an existing table, so it needs its
`ColumnMigrations` entry ([14](14-persistence.md#migrations)).

**The pad grows a second family for the agents the issue pad refuses.** `padOriginFor` resolves only
`issue:<n>` subtrees, and refuses a `pr:<n>:*` origin on purpose: `linkedPrNumber` is sticky, so
reaching an issue's pad through a pull request would let an agent write onto a goal it was not sent
to. But the CI-fix and review-comment agents are `pr:<n>:*` origins, and they are exactly the agents
whose pushes move a head — a pack for the third head of a pull request is mostly their forks. So a
`pr:<n>:*` origin resolves to a pad of its own, `pr:<n>`, that no issue agent reads and no issue agent
can reach. The author is handed both: the goal's pad, by the pull request's linked goal, and the pull
request's own. A desk agent on a pull request — the triage, the fleet reviewer — may write there too,
and rarely has reason to.

An entry's `decision` carries:

| Field      | What                                                                          |
| ---------- | ----------------------------------------------------------------------------- |
| `chose`    | one line: what the change does here                                           |
| `because`  | one line: why                                                                 |
| `rejected` | zero or more alternatives, each with the reason it was not taken              |
| `paths`    | the files the fork touches, where the agent can say                           |

The pad supplies `createdAt` from the harness clock, and attribution from the credential.

`rejected` is the field that justifies recording forks at all. _Why not derive it from the span?_ is
the question a reviewer asks most often and the one a diff can never answer, because the road not
taken leaves no trace in the tree. The agent's transcript holds it, in principle — the harness keeps
every one ([10](10-agent-runtimes.md)) — but a transcript is the whole run, tool output included, and
reading one to find three forks costs more than the pack. The entry is the fork already found.

**A rejected alternative is never a claim.** It is an intention, and the checker's answer to an
intention is `cant_tell` by construction ([The check](#the-check)). So it reaches the pack as
provenance — the entry, verbatim, beside the claim it informed — and never as a sentence with a
verdict. That is the honest shape: the most useful line in the log is also the one line nothing can
check, and the pack says which it is.

Three rules hold the log honest, and all three are properties of the pad rather than instructions in
a prompt:

- **Append-only.** The pad offers no edit and no delete. A later entry may supersede an earlier one
  and says so; the earlier one stays.
- **No prose ceiling to fill.** An agent with nothing to record writes nothing. An empty log is an
  honest outcome and the author says the pack was written without one, rather than the witness
  padding to look thorough.
- **It is read where the pad is read.** In the notepad modal, and replayed into the next agent on the
  goal like every other pad note. Neither is a rendering of the pack: a fork is a fact about one
  moment, and the pack is what the author makes of all of them.

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
that an idea is unrelated to the rest of the pull request and could be its own. Both are judgements
about ideas, which is why the checker is handed each idea's claim and anchor list and not only a flat
list of sentences ([The three roles](#the-three-roles)).

A reviewer may override a label, and the override is recorded — but it is **never shown to the
checker on a later pack**. Given the overrides it would calibrate to what reviewers like rather than
to what is risky, and a label that has learned to agree with its reader has stopped being evidence.

The overrides are surfaced to the operator instead. A pattern of reviewers upgrading `skim` to `read`
says the checker is systematically underselling risk, which is worth more than any single pack and is
fixed by changing its prompt — a thing a person does, deliberately, once.

With nothing blocking, this label is the main thing steering where a reviewer spends their attention.
That makes its independence load-bearing rather than tidy.

## The check

The checker is handed the claims as bare sentences, each idea's claim and anchor list, the diff, and
the tree at the pull request's head. It is not given the witness log or the notes. It answers one
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

**On request, and never automatically.** A reviewer asks for one from the pull request's row on its
goal's page ([Reading it](#reading-it)) and waits while it is written. The fleet opens more pull
requests than anybody reads, and a pack nobody opens is two agent runs spent on nothing — so the cost
is paid by the person who chose to pay it, at the moment they chose to.

The wait is the trade, and it falls at the worst possible moment: somebody has just sat down to
review and is told to hold on. That is accepted rather than solved.

**Once, and the reader decides when again.** A pack is written against one head sha and stays written
against it. When the head moves the pack is marked **stale**, says how far behind it is, and **is
still shown**. Nothing regenerates it: not the push, not the next pulse, and not a reader opening it.
A pull request rarely changes direction enough after its first pack for a second to be worth two
agent runs, and the reader is the only party who can tell when it has. Asking again is the same
control as asking the first time, and the new pack replaces the old. The witness log has kept
growing in the meantime — the CI-fix and comment agents write to the pull request's own pad — so the
second pack is written from a fuller log, not the first pack.

It is not regenerated underneath a reader for the same reason it is not regenerated at all: a pack
that re-flows mid-read costs the reader their place and tells them nothing about what changed since
they started, which is worse than being told it is old.

### Pull requests nobody witnessed

A pack is offered for a human-authored pull request too, and the harness says plainly that there is
no witness log: every claim comes out `inferred`, and the pack's header states it rather than leaving
a reader to notice the absence of `witnessed` beside anything.

Offered where every pack is — on the pull request's row on a goal's page. There is no pull request
page in the cockpit ([17](17-cockpit.md#links)), so a human-authored pull request gets a pack only
where the harness has linked it to a goal (`ownsPr`, [17](17-cockpit.md#the-pull-requests-and-the-tail)).
One the provider has not linked has no row to carry the control, and gets none. That is the honest
limit of the surface rather than a rule about authorship.

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

## A pack is data, and rendering is downstream

**What the three agents produce is a JSON document, not a page.** Every surface is a pure function of
it, and nothing ever reads a rendering back — the rule [28](28-cross-fleet-pool.md#the-human-readable-companion)
already states about its own markdown companion, for the reason it gives: a second grammar for one
fact is free to disagree with the first, and it disagrees silently.

One shape, three consumers:

| Consumer           | Reads it as                                      | Can                                   |
| ------------------ | ------------------------------------------------ | ------------------------------------- |
| The cockpit        | a wire type over HTTP                            | render, and take the reviewer's marks |
| The HTML companion | the document, through a pure function at publish | render, read-only                     |
| The store          | the document as written                          | neither                               |

The split is worth more than distribution. **Re-rendering is free; re-authoring is not.** With the
pack stored as data, the page can be redesigned fifty times against packs that already exist, without
spending an agent run — so presentation iterates at the speed of a stylesheet rather than the speed of
the fleet.

### The document carries its code

**Every anchor embeds the lines it points at** — the hunk, or the region of the unchanged file — as
they stood at the head sha. A pack is therefore complete on its own: the companion renders with no
repository behind it, and the cockpit draws code it has no route to read, because the harness has
no file-at-a-commit route and the cockpit no diff viewer, and neither is worth building for this. The
cost is stated under [Sharing a pack](#sharing-a-pack): a pack _is_ source, in volume.

### The document carries its schema version

A pack another fleet published was written by a harness on a different build, and a cockpit will
be handed one older or newer than itself. So a pack states its `schema`, and **a renderer that does
not know that version refuses loudly rather than rendering what it recognises.** Dropping unknown
fields is the tempting behaviour and the wrong one: a page silently missing its false-claim banner
because the renderer was a version behind is exactly the failure the whole subsystem exists to catch,
reproduced by the thing that reports it.

### What a reviewer does is not part of the pack

Attention overrides, an idea marked read, a reviewer disagreeing with a verdict — these live in their
own table, **never written back into the document**.

The pack is immutable output for one head sha. The moment it is also a mutable record of what somebody
did to it, regenerating against a new head throws away their marks. Held beside it, the marks survive
a pack being rewritten under them — **keyed to what survives a rewrite**, which is the code and not
the idea: an idea's id is minted by the author on every run, so a mark keyed to it points at nothing
in the next pack. A mark on an idea is stored against the hunks that idea owns (path and range at the
head sha), and the next pack draws it on whichever idea owns the same hunks. A hunk the next head
rewrote loses its mark, honestly: the thing that was read is gone.

## Reading it

Two renderings, and the layering is the same in both because the layering *is* the product.

1. **The whole change on one screen.** The ideas as one line each, their attention labels, and the
   count of false claims above them. A reader who stops here has the useful part: where the time
   goes, and whether anything is wrong.
2. **The code.** Opening an idea shows the walk — every anchor, with its actual code, in reasoning
   order. This is the layer the reader is meant to spend time in.
3. **The reasoning.** Under each anchor, folded away, the note and the witness entry behind it.

Layer 2 is code and not prose deliberately. A pack whose middle layer was the author's narrative
would be a surface people approve from without reading the change, which is worse than the review it
replaces. The prose is support; it is never the thing in the middle.

**The cockpit rendering** opens over the goal page, from the control on the pull request's row
([17](17-cockpit.md#the-pull-requests-and-the-tail)) — there is no pull request page to put it on —
and is the only one that takes input: the reviewer's marks, per
[What a reviewer does](#what-a-reviewer-does-is-not-part-of-the-pack). Its position — which pull
request's pack, which idea is open — is `Place` state and lives in the query string, not a
`useState` in `useCockpit`: a surface held outside it is stepped over by the back button and dropped
by a reload, both silently. → [17](17-cockpit.md#the-address-bar)

Every reference to a goal, a pull request or an issue is drawn with `<Ref to={ref}/>`
(`web/src/components/refs.tsx`), never as text. → [17](17-cockpit.md#links)

**The HTML companion** is a single self-contained file, rendered by the harness from the pack document
alone when a pack is [shared](#sharing-a-pack), the way [28](28-cross-fleet-pool.md#the-human-readable-companion)
renders its markdown beside `claims.json`: a pure function of the document, written beside it, never
read back. It is read-only, it has no harness behind it, and it is for the reviewer who has no
LubbDubb — which is most reviewers on most teams. It needs nothing checked out, because the document
[carries its code](#the-document-carries-its-code). A skill in the repository was the earlier shape
and is rejected for the reason [20](20-validation.md#the-skill) keeps its skill out of the checkout:
a copy that travels with a checkout is the stale one, and this renderer's one job is to not be.

## Sharing a pack

A pack is written locally. **Publishing one is a second, deliberate act**, and the two are separate
controls on the page. The person shares the pack when they are happy with the pull request and with
the pack, and nothing shares one for them.

That is the opposite of [28](28-cross-fleet-pool.md#data-classification)'s `keepLocal`, and
deliberately: a claim is one sentence, so publishing by default and withholding the rare one is the
cheap arrangement. A pack [carries its code](#the-document-carries-its-code), is written per pull
request, and may be written again per head — publishing those by default puts the fleet's source, in
volume, into a repository that never forgets. Which is the objection
[28](28-cross-fleet-pool.md#what-it-is-not) raises against mirroring the store, arriving from a
different direction. 28 also argues that a second click means nothing is ever published; that is
accepted here, with open eyes, because a pack unshared costs nobody anything and a pack shared by
default costs the fleet its source.

**A shared pack rides the pool's transport and nothing else about it.** `PoolTransport` in the
provider registry already solves one-writer-per-namespace, unreachability and the commit hygiene; a
pack is a third kind of document in the fleet's own namespace, beside `claims.json` and
`digest.json`, with an HTML companion beside it the way the other two have a markdown one. It is
**not** a claim: no corroboration, no vouch, no contradiction, no lifetime, and nothing about it is
ever injected into an agent's prompt. → [27](27-knowledge.md)

Two consequences that are easy to miss:

- **The secret backstop matters more here than it does for a claim.** A pattern check written for one
  English sentence is being pointed at the code the anchors embed, where a token in a test fixture or
  an internal hostname in a config default is exactly the thing that hides. It runs over every
  embedded line, not only the sentences. It refuses and never rewrites, as it does for claims — and it
  will refuse a legitimate share sometimes, which is the correct direction to fail in and should
  surprise nobody when it happens.
- **A shared pack is pruned; the local one is kept.** A claim is durable; a pack is disposable, and
  the pack for a merged pull request is dead weight in a repository everybody clones. The fleet that
  published it removes it from its namespace on the publish after the pull request has been closed
  for `closedPrWindowMs` — the same clock that drops the pull request out of the world the cockpit
  draws ([07](07-pull-requests.md)), so a shared pack outlives its pull request's row by nothing. The
  local row is untouched: it is the fleet's own record, and the cost of keeping it is the fleet's.

## Where it lives

Two tables, in a new module under `src/store/` — the only directory that touches SQLite, one module
per group of related tables, taking a `StoreContext`, with `Store` delegating under the same method
names — and one column on a table another module owns. → [14](14-persistence.md#shape)

| Table             | Holds                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `scratch_entries` | the witness log: a `decision` column on the pad's own rows, null on an ordinary note          |
| _review_packs_    | one row per (pull request, head sha): the pack document and its verdicts                     |
| _review_marks_    | what a reviewer did to a pack — overrides, ideas read — keyed to pack and the hunks an idea owns |

The pack is one document rather than a table per level. It is written whole and read whole, and
nothing queries inside it — three normalised tables would buy nothing and cost a join on every read.
The head sha it was written against is a column rather than a field, because staleness is decided by
comparing it to the pull request's head on every load. The witness log lives on the pad because it
_is_ pad entries, appended over time by the working agents; the marks are separate because they
outlive the document they were made against.

`scratch_entries` exists, so the `decision` column needs its `ColumnMigrations` entry in the pad's
own store module, or every database from before it has no column and every fork is silently a note.
The two pack tables are new, so neither needs one; a table being new **once** does not keep it
exempt, and the first column added to either afterwards needs an additive `ALTER TABLE` guarded by a
`PRAGMA table_info` check. → [14](14-persistence.md#migrations)

The shapes the routes ship live in `src/wire.ts`, and a wire type either **is** the domain type or
`extends` it — never a re-declaration and never widened. `test/wireContract.test.ts` asserts that
`src/wire.ts` is the only server module anything under `web/src/` names. The pack document is the
clearest case there is: the cockpit, the companion and the store read one shape, so there is one
declaration of it.

Routes go in a new module under `src/server/routes/` with an entry in `app.ts`'s `ROUTE_MODULES`, and
every handler is wrapped in `checked(schemas, handler)` rather than reading the request itself.
→ [16](16-http-api.md#shape)

Two new prompt ids, _review-pack-author_ and _review-pack-check_, registered like any other. A
`PromptId` is never deleted once it exists — it is marked `retired: true`, because
`loadPromptTemplates` throws on a file naming no known id and removing one turns every deployment
that overrode it into a harness that will not boot. → [05](05-dispatcher.md#prompt-templates)

## Cost

Three roles, and only the witness runs inside the work — a handful of pad writes on a session already
running, on every dispatch whether a pack is ever asked for or not, plus the paragraph appended to
every execution prompt that says to make them. It is the cheap one, and it is the one that must be
paid up front: a log cannot be written after the fact, which is the whole point of it.

The other two are paid **per request, not per pull request**. The author is one agent over the diff,
the log and the tree. The checker is one agent over the claims, in series, on a read-only checkout of
the head — the shape [07](07-pull-requests.md#the-reviewers-checkout) already uses. One agent per
claim was considered and rejected: every spawn outside the dispatcher is invisible to the fleet cap,
and every one of them wants a slot in a pool bounded at the cap plus slack
([09](09-execution.md#exhaustion)), so fourteen claims in parallel is fourteen checkouts thrashing one
branch's slot. The wait is the checker reading fourteen claims one after another, and that is the
wait [When a pack is made](#when-a-pack-is-made) accepts.

So the standing cost of the subsystem is the witness alone, and a pack is two agent runs spent
deliberately, against a person's review hour. A fleet opening twenty pull requests a day and asking
for four packs pays for four.

## What was decided, and why

These were open when this document was first written, or were argued against after it was. They are
settled here rather than deleted, because each one has a losing option that will look attractive
again later.

**Packs are made on request, never automatically, and made once.** Always-on is simpler to build and
pays two agent runs for every pull request nobody opens. The fleet's output already exceeds what
anybody reads, so the default would be waste by construction. Regenerating on every push is the same
waste per pull request: a change rarely turns direction enough after its first pack, and the reader
is the one party who can tell when it has. → [When a pack is made](#when-a-pack-is-made)

**It is not the fleet review, and does not share its agent.** `pr-review` is one round, its charter is
the project's, and on the deployments that run it a policy requires it. A reviewer that also wrote a
pack would carry two jobs in one context and answer to two prompts. Two readings of one diff is the
cost, taken knowingly. → [What it is not](#what-it-is-not)

**The witness log is the scratchpad, not a tool of its own.** The pad already has every property the
log needs, and a second append-only per-goal record would be the pad again. What the pad lacked was
a place for the agents that work a pull request's concerns, which are refused by the issue pad on
purpose — so the pad grows a `pr:<n>` family rather than the log growing a store.
→ [The witness log](#the-witness-log)

**The checker reads claims in series, on one checkout.** One agent per claim would parallelise the
wait away, and would do it by spawning outside the cap into a worktree pool bounded by it.
→ [Cost](#cost)

**The document embeds the code its anchors point at.** The alternative — anchors as paths and ranges,
resolved at render — needs a file-at-a-commit route and a diff viewer the cockpit does not have, and
leaves the companion unable to render without a checkout. The cost is that a shared pack is source,
which is why sharing is a person's act. → [The document carries its code](#the-document-carries-its-code)

**Nothing blocks.** A pack that only exists when asked for cannot be a precondition for merging —
requiring one would make packs mandatory through the back door and undo the trigger decision. So the
pack reports and a person decides, and the risk that creates is answered with prominence rather than
a lock. → [What a false claim does](#what-a-false-claim-does)

**A stale pack is shown, not regenerated.** Regenerating under a reader costs them their place and
tells them nothing about what moved. → [When a pack is made](#when-a-pack-is-made)

**Human-authored pull requests get a pack where they have a goal, and are told the log is missing.**
Every claim comes out `inferred`. Less than a witnessed pack, more than that pull request had. A pull
request linked to no goal has no row in the cockpit to ask from, and gets none.
→ [Pull requests nobody witnessed](#pull-requests-nobody-witnessed)

**Attention is the checker's, and the checker is shown the ideas' skeleton to write it.** A label is a
judgement about an idea and `split` about how ideas relate, which a flat list of sentences cannot
support. The notes and the log stay withheld. → [Attention](#attention)

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

**The pack is a document and every surface renders it.** Posting a rendered pack onto the pull
request was considered and rejected: it is the cheapest distribution there is — the tracker's own
permissions are already the right audience, and `ActionSink`'s `upsertIssueComment` reaches GitHub and
Azure DevOps alike — but a comment cannot fold reliably across providers, cannot take a reviewer's
marks at all, and a flat wall of prose and diff is the thing this subsystem exists to replace. Paying
the product to save the plumbing is the wrong trade when the plumbing is a JSON file. A renderer
shipped as a skill in the repository was the second shape and is rejected too: a checkout's copy is
the stale one. The standalone rendering is the harness's own companion file, written beside the
shared document. → [A pack is data](#a-pack-is-data-and-rendering-is-downstream)

**Sharing is a separate act from asking, and a person's.** Publishing rides the pool's transport into
the fleet's own namespace, never its claims arm, and never by default. A shared pack is pruned on the
pull request's own retention clock; the local one is kept. → [Sharing a pack](#sharing-a-pack)

**A pack produces no knowledge.** "The checker keeps catching the same class of thing" was the
argument for a lesson path into [27](27-knowledge.md), and it names an aggregator across packs that
nothing is specified to be and that could not live in `src/dispatcher/`. Nobody needs it; the
paragraph is gone.

## What is still open

**`plumbing` will rot.** It is the honest answer to hunks that carry nothing to review, and it is also
where an author will put anything it cannot be bothered to explain. The checker verifying that those
hunks are semantically empty is the defence, and it is not obviously enough — and by the check's own
rule "semantically empty" is a judgement, so the honest verdict on a plumbing claim is often
`cant_tell`. Expect this to be the first thing that needs tightening, and watch the ratio of plumbing
hunks to owned ones as the signal; nothing here yet defines the counter.

**Whether the wait is tolerable.** Asking for a pack and waiting lands at the worst moment — somebody
has just sat down to review — and the checker reading in series is most of the wait. If that turns
out to drive people away from asking, the fix is pre-generating for a narrower set of pull requests,
never making everyone pay for every one.

**Whether prominence works.** [What a false claim does](#what-a-false-claim-does) makes four
requirements on the surface, and all four are checkable — as the order things are drawn in. None
measures the thing they stand in for, which is whether a false claim gets read. The one number that
would is how often a pull request merges with a false claim nobody marked, and recording it means a
mark that says _seen_ on a false claim, which is a mark this document has not yet added.

**Whether a reviewer's marks should travel.** They are held beside the pack rather than in it, which
means they are local by construction. Whether a shared pack should carry the fact that somebody
already read an idea, or arrive clean for each reader, is not decided — and the answer probably
differs for a teammate and for an outside reviewer.
