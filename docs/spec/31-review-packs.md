# 31 — Review packs

**Built.** [The witness log](#the-witness-log), [the pack document](#the-pack),
[the author](#when-a-pack-is-made), [coverage](#coverage), [the check](#the-check) and its
[attention labels](#attention), the eight routes, the two prompt ids,
[the cockpit rendering](#reading-it), [the HTML companion](#reading-it),
[sharing a pack](#sharing-a-pack) and [unsharing one](#unsharing-a-pack) — the publish, the secret
backstop over every embedded line, the prune and the withdrawal — and
[the operator's reading](#the-operators-reading) over all of them are running code. Every path a
section names is italic while that section is unbuilt, and the marker comes off it in the change that
makes it true.

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

| Not                       | Because                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A code reviewer           | Nothing here forms an opinion about whether the change is good. It states what the change does, follows it through the tree, and marks its own statements true or false. The judgement stays with a person.                                                                                                                                                                  |
| The fleet review          | [07](07-pull-requests.md#the-fleet-review)'s `pr-review` reads the same diff, and a deployment with both on pays two readings of it. That is deliberate: the review is one round, policy-mandated on the deployments that run it, and its charter is the project's; folding a pack into it would put a second job in that agent's context. Neither reads the other's output. |
| A replacement for reading | The pack's job is to make the code readable in the right order, not to stand in for it. A surface that answers well enough to approve from is a regression, and the shape in [Reading it](#reading-it) resists it.                                                                                                                                                           |
| A summariser              | A summary is unfalsifiable. Every sentence a pack ships is a claim with a verdict beside it, or it is a gist attached to code the reader can see.                                                                                                                                                                                                                            |
| A dispatch input          | Same rule as the rest of the lenses: nothing under `src/dispatcher/` may import this. A pack is a read-only view assembled after the work. → [05](05-dispatcher.md)                                                                                                                                                                                                          |
| A gate                    | Nothing here blocks a merge. A pack is made because somebody asked for one, and an artefact that may never exist cannot be a precondition for anything. A false claim is shown, loudly. → [What a false claim does](#what-a-false-claim-does)                                                                                                                                |
| A commit message          | A commit message is one narrative for the whole change. A pack is several, one per idea, each with its own walk and its own verdicts — and it carries code, which a message cannot.                                                                                                                                                                                          |
| An always-on cost         | Three roles, and only one of them runs inside the work. → [Cost](#cost)                                                                                                                                                                                                                                                                                                      |
| A page the harness owns   | What the three agents produce is a JSON document. The cockpit and the shared HTML companion are both renderings of it, and neither is ever read back. → [A pack is data](#a-pack-is-data-and-rendering-is-downstream)                                                                                                                                                        |

## The three roles

The pack is produced by three agents that see deliberately different things. The separation is the
whole design: each one only has to distrust the one before it, and none is ever asked to check its
own output.

| Role        | Runs            | Sees                                                                                                            | Writes                                                                                                                             |
| ----------- | --------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Witness** | inside the work | everything — it _is_ the working agent                                                                          | the witness log, as it goes                                                                                                        |
| **Author**  | after the work  | the witness log, the diff, the tree                                                                             | the pack: ideas, claims, anchors                                                                                                   |
| **Checker** | after the pack  | the diff, the tree, each idea's one-line claim and anchor list, the claims — **not** the log, **not** the notes | a verdict and its evidence per claim; per idea an attention label and its cue; the finding for each false claim; the reading order |

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

_Built_ — stage 1 of the subsystem. What it says below is what `src/scratch/pad.ts`,
`src/mcp/tools/scratchAppend.ts` and `src/store/scratch.ts` do; `test/witnessLog.test.ts` holds it.

The working agent records **forks**, not commentary. A fork is a moment where the change could
reasonably have gone another way. One line at the fork is cheap; recovering it afterwards costs
more than the pack ([below](#the-witness-log)).

**The witness log is the scratchpad.** The pad ([11](11-mcp-tools.md#the-tools), `scratch_append`) is
already an append-only, attributed, per-goal record that survives worktree reuse and re-dispatch and is
replayed to the next agent on the goal — which is every property the log needs, and a second store
with the same properties would be the pad again under another name. A fork is a pad entry that
carries a _decision_ argument beside its note; an entry without one is an ordinary note. No new tool,
so the three-way agreement in [11](11-mcp-tools.md#launch-flags) is untouched; the tool's schema grows
one optional object, and `scratch_entries` grows one column, `decision`, holding the object as JSON
and null on a note — an existing table, so it has its `ColumnMigrations` entry, `SCRATCH_COLUMNS`
([14](14-persistence.md#migrations)). Null is what every row from before the column spells, and it is
the right answer for all of them, so no backfill is owed.

**The pad grows a second family for the agents the issue pad refuses.** `padOriginFor` resolves only
`issue:<n>` subtrees, and refuses a `pr:<n>:*` origin on purpose: `linkedPrNumber` is sticky, so
reaching an issue's pad through a pull request would let an agent write onto a goal it was not sent
to. But the CI-fix and review-comment agents are `pr:<n>:*` origins, and they are exactly the agents
whose pushes move a head — a pack for the third head of a pull request is mostly their forks. So a
`pr:<n>:*` origin resolves to a pad of its own, `pr:<n>`, that no issue agent reads and no issue agent
can reach — and the resolution is by the origin's own first segment, never by a join, so the sticky
`linkedPrNumber` still reaches nothing. `scratch_read` and `GET /api/scratchpads/:ref` resolve the
same way ([16](16-http-api.md#get-apiscratchpadsref)). The author is handed both: the goal's pad, by
the pull request's linked goal, and the pull request's own. A desk agent on a pull request — the
triage, the fleet reviewer — may write there too, and rarely has reason to.

Two things the pull request's pad does **not** yet do, deliberately left to the stages that need
them: it is not replayed into the next agent on the pull request the way `priorWorkBriefing` replays
an issue's pad — a CI fixer reads it with `scratch_read` — and the cockpit draws no way into it, since
there is no pull request page to carry one ([17](17-cockpit.md#links)); the author, which is handed
both pads, is the first reader that needs either.

An entry's `decision` carries:

| Field      | What                                                             |
| ---------- | ---------------------------------------------------------------- |
| `chose`    | one line: what the change does here                              |
| `because`  | one line: why                                                    |
| `rejected` | zero or more alternatives, each with the reason it was not taken |
| `paths`    | the files the fork touches, where the agent can say              |

`chose` and `because` are required inside the object and every line is collapsed to one; `rejected`
and `paths` may be empty and come back empty rather than missing, so a reader never has to ask which
fields a fork carries. `normalisePadDecision` refuses a malformed object **by field name** — the way
`normalisePadNote` refuses an empty note — rather than storing it as a note, because a fork the log
lost in silence is the one thing the log exists not to do; an over-long line or list is trimmed and
the result says so, the pad's own trade. The pad supplies `createdAt` from the harness clock, and
attribution from the credential.

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
- **It is read where the pad is read.** In the notepad modal, drawn apart from a note — chose,
  because, the rejected list ([17](17-cockpit.md#the-notepad-modal)) — and replayed into the next
  agent on the goal like every other pad note, decision included (`padTestimony`). Neither is a
  rendering of the pack: a fork is a fact about one moment, and the pack is what the author makes of
  all of them.

The instruction to use it, `WITNESS_INSTRUCTION`, is **appended** to the rendered execution prompt of
every code dispatch, never interpolated into it — an operator's overridden template never learned the
placeholder, and interpolation drops it silently on exactly the deployments that customised most. It
is short: what a fork is, that `rejected` is the field that matters, and that an empty log is fine.
Desk agents do not get it — they move no head, and a pack is written from the forks behind one.
→ [09](09-execution.md#the-instruction-to-record-forks-reaches-the-agent),
[05](05-dispatcher.md#prompt-templates)

## The pack

_Built_ — stage 2 of the subsystem: the document's shape and where it lives, and nothing that writes
or draws it. The types are in `src/types.ts` (`ReviewPack`, `ReviewIdea`, `ReviewAnchor`,
`ReviewClaim`, `ReviewMark`), the tables in `src/store/reviewPacks.ts`;
`test/reviewPackDocument.test.ts` holds it. A field the checker writes is **null until it has run**
(`attention`, `cue`, `verdict`, `evidence`, `finding`; the reading `order` is empty), because the author
writes the pack first and the checker annotates it, and a renderer draws the gap rather than guessing.

### An idea

An **idea** is a claim plus an ordered walk of anchors. It is the unit the whole subsystem exists to
produce, because it is the unit a change is actually made in — and the unit a diff destroys by
sorting everything alphabetically by path.

| Field       | What                                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | minted by the author on every run, so nothing durable is keyed to it ([marks](#what-a-reviewer-does-is-not-part-of-the-pack)); the one reserved id is `plumbing` ([Coverage](#coverage)) |
| `claim`     | one sentence, falsifiable, stating what this idea does                                                                                                                                   |
| `title`     | the same thing said the way a colleague would say it across a desk — what changed and why it matters, no identifiers ([The page](#the-page))                                             |
| `cue`       | one short line under the title: why this idea has the attention it has, and where its risk is                                                                                            |
| `anchors`   | ordered — the walk, in the order the reasoning ran, not the order the files sort in                                                                                                      |
| `claims`    | the checkable statements this idea rests on ([Claims](#claims))                                                                                                                          |
| `attention` | how much scrutiny it needs, set by the **checker** ([Attention](#attention))                                                                                                             |

`claim` is for the checker; `title` and `cue` are for the person. The author writes the first two,
the checker writes the cue after it has labelled the idea, because the cue says why the label is what
it is.

An idea's walk crosses files freely and is expected to: a change in this repo is naturally vertical —
domain type, wire type, store module, route, cockpit, spec, test — and reviewing those six files
separately is how a whole class of the sharp edges gets missed.

### An anchor

An anchor is a place in the tree the walk stops at, with one line saying why it stops there. Two
kinds, and the second is the point:

| Kind     | What                                  | Drawn  |
| -------- | ------------------------------------- | ------ |
| `hunk`   | a range of the diff                   | solid  |
| `region` | a range of a file **not in the diff** | dashed |

A `region` anchor is either **context** — code the change cannot be judged without, which the pull
request does not contain — or a **deliberate absence**: the file a reader would expect to have
changed, shown unchanged, with the reason. The second kind is the one that reaches the failures this
repo cannot otherwise review, and it is worth building even if nothing else here is.

Every anchor carries its `range` — path, and 1-based inclusive `start` and `end` lines at the head
sha — and its `code`, the lines as they stood there ([The document carries its code](#the-document-carries-its-code));
a hunk's lines keep their diff prefixes, a region's are plain. Every anchor carries a `gist` (one
line, always shown) and may carry a `note` (the reasoning, folded away). The gist belongs to the code; the note is support and is never required to understand it.
It may also carry a `caption` — the one-line label on the code block itself, saying what the block
is ("new function", "existing code, unchanged — shown because you need it", "two places, 250 lines
apart") — and a `mark`, one of `key` (the stop the idea turns on), `false` (the stop a false claim is
about) or `disputed` (the stop where the witness and the code disagree). A note states its
provenance the way a claim does: written by the witness at the time — `by: 'witness'`, citing the
pad entry's id and stamped with its time — or added by the author afterwards, `by: 'author'`. The
page shows which, because the reader weighs them differently.

### Coverage

_Built_ — stage 3. `src/reviewPacks/hunks.ts` computes the hunks and decides coverage;
`test/reviewPackAuthor.test.ts` holds it.

**Every hunk in the diff has exactly one owning idea.** A hunk nothing claims is either scope creep
nobody declared or an omission from the pack, and both are things a reviewer must be told rather than
left to notice. Coverage is mechanical, so it is checked mechanically: `parseDiffHunks` turns
`git diff base...head` into hunks — **a hunk is what git calls one**, at git's default context — and
`coverageRefusal` compares them against the union of `hunk`-kind anchors across every idea, `plumbing`
included, and refuses a pack that leaves one unowned or owns one twice, naming the hunks. The check
runs in `review_pack_submit` before the store is written, so a pack that fails it never lands.

A hunk's `range` is read off the `+c,d` half of git's header — lines `c` to `c + d − 1` at the head —
and the author is **handed the hunks by id** (`h1`, `h2`, …) and names them back; it never writes a
range for one. The ranges are what a reviewer's marks are keyed on, so they are computed from the
diff and never taken from the agent's prose. **A pure-deletion hunk carries a zero-width range** at
the line the deletion sits after — `d` is 0 and git's `c` names the line before the gap, so the range
is `{c, c}`, clamped to line 1 for a deletion at the top of a file — and its code is the removed lines
with their `-` prefixes; a deleted file keeps its old path, since the head has no new one. A binary
file and a pure rename produce no hunk: there is nothing for an idea to own.

Two escape valves, because the invariant is otherwise false in practice:

- **A hunk may be _referenced_ by other ideas** as a `region` anchor, while still having one owner.
  Shared code genuinely serves several ideas; pretending otherwise forces a bad assignment.
- **A reserved idea, `plumbing`,** owns hunks that carry no meaning to review: mechanical renames,
  formatting, generated files, a lockfile. It is declared like any other idea, under the fixed id
  `plumbing` where every other id is minted per run, and the checker
  verifies the claim that its hunks are semantically empty. Without it the author is pushed to invent
  a story for a rename, which is worse than saying there isn't one.

### Claims

A claim is a sentence that can be shown false. "This is cleaner" is not a claim. "These are the only
two callers" is.

| Field        | What                                                                                                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`       | the sentence                                                                                                                                                                                               |
| `provenance` | where it came from ([Provenance](#provenance))                                                                                                                                                             |
| `verdict`    | `true`, `false` or `cant_tell`, written by the checker; null until it has                                                                                                                                  |
| `evidence`   | what the checker did to decide — the search, the test, the file it read; null until it has                                                                                                                 |
| `finding`    | on a `false` claim and on nothing else: what is wrong and what follows ([What a false claim does](#what-a-false-claim-does)); null until it has, and null on every claim that held or could not be decided |

### Provenance

Every claim states where it came from, and this is structural rather than decorative. A claim
traceable to something the witness wrote at the time is worth more than one the author reconstructed
from the diff, and a reader must be able to tell which they are looking at.

| Provenance  | Means                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `witnessed` | traceable to a witness entry, which it cites by id (`entryId`, a `scr_…`) — the entry is shown beside it, verbatim |
| `inferred`  | the author's reading of the code; the witness said nothing about this. Cites nothing                               |
| `disputed`  | a witness entry and the code disagree. The claim states what the code does; the entry it cites is shown beside it  |

The provenance is a discriminated union rather than a label beside an optional id, so a `witnessed`
claim without an entry to show is a shape the type refuses rather than a row the page draws with a
blank beside it. The pack stores the id and never a copy of the entry: a copy is the retelling the
verbatim rendering exists to prevent.

`witnessed` claims cite the entry and the cockpit renders it unedited next to the claim. That is what
stops the author quietly improving a note in the retelling — not a fourth agent checking the third,
but the reader seeing both halves at once. A `disputed` claim is a finding in its own right and is
surfaced as one.

### Attention

_Built_ — stage 4, with the checker; the overrides are recorded and, since stage 5, taken from the
page ([marks](#what-a-reviewer-does-is-not-part-of-the-pack)); since stage 7 they are surfaced to the
operator ([The operator's reading](#the-operators-reading)).

Each idea carries a label saying how hard to look: **read**, **decide**, **skim** or **split**.

The label is written by the **checker**, never the author. How much scrutiny a change deserves is
exactly the judgement not to take from the party that produced it. `split` is the checker's opinion
that an idea is unrelated to the rest of the pull request and could be its own. Both are judgements
about ideas, which is why the checker is handed each idea's claim and anchor list and not only a flat
list of sentences ([The three roles](#the-three-roles)).

A reviewer may override a label, and the override is recorded — but it is **never shown to the
checker on a later pack**. Given the overrides it would calibrate to what reviewers like rather than
to what is risky, and a label that has learned to agree with its reader has stopped being evidence.

The overrides are surfaced to the operator instead, on
[the operator's reading](#the-operators-reading). A pattern of reviewers upgrading `skim` to `read`
says the checker is systematically underselling risk, which is worth more than any single pack and is
fixed by changing its prompt — a thing a person does, deliberately, once.

With nothing blocking, this label is the main thing steering where a reviewer spends their attention.
That makes its independence load-bearing rather than tidy.

## The check

_Built_ — stage 4. `src/reviewPacks/checker.ts` is the desk, `src/reviewPacks/check.ts` its pure
half, `src/mcp/tools/reviewPackCheck.ts` the tool; `test/reviewPackChecker.test.ts` holds it.

The checker is handed the claims as bare sentences, each idea's claim and anchor list, the diff, and
the tree at the pull request's head. It is not given the witness log or the notes. It answers one
question per claim and writes down how it answered.

| Verdict     | When                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| `true`      | reproduced against the tree. The evidence names what was run or read                                   |
| `false`     | the tree contradicts it. The evidence names the contradiction                                          |
| `cant_tell` | not decidable from this repository: a claim about the outside world, a product judgement, an intention |

`cant_tell` is a first-class answer and not a failure. A pack that claims something about how a
vendor meters usage, or about what an operator would find confusing, is making a claim a codebase
cannot settle — folding that into `false` would train reviewers to ignore the verdict, and folding it
into `true` is a lie. It is surfaced to the person, whose call it is.

**The checker may not edit the pack.** It writes verdicts and evidence. It does not reword a claim it
disagrees with, reassign an anchor, or open a code change — all three would make it an author, and
there would again be nobody checking.

**It follows the author, and nobody asks for it.** The reviewer's one ask buys both runs — the "two
agent runs spent deliberately" under [Cost](#cost) — so the checker's trigger is the author's run
**ending** with a pack written against its head: the desk listens to the fleet's `done`, and an
author task (`pr:<n>:pack`, head off its lease key) whose head has a pack with an empty `order` is
followed. Not the submit: at `written` the author is still alive, may submit again in the same turn,
and still holds its slot; at `done` the document is final and the slot is back. A run the operator
killed is not followed — a kill emits no `done` — and an author that failed after submitting is,
because the pack is there. A fleet paused between the two runs is honoured, and said in the error
log: the pack stays unchecked, visibly, and asking for it again re-runs both. A checker that fails
leaves the same state, for the same recovery; nothing retries on its own.

**The same shape as the author, under its own names.** Origin `pr:<n>:check`, lease key
`review-pack-check/pr-<n>/<headSha>` — the head in the key for the author's reason, so
`review_pack_check` re-derives the pull request and the head from its task row and lands on the
document it was handed, whatever the pull request points at by then. A read-only slot through
`WorktreeManager.ensureReadOnly`, released by the reap; reaped through `session.kill()`; not counted
against the cap; no fetch, because the author diffed the same head moments before. **One slot and
the claims in series** — one agent per claim was rejected under [Cost](#cost). While the checker is
on a pull request the ask is refused (409, "being checked") exactly as it is while the author is,
because a second author would replace the ideas the checker's verdicts are keyed to; and the read
ships `checking`, so a pack whose every verdict is null reads as "being checked" or "unchecked"
rather than either.

**What it is handed** is the rendered `review-pack-check` template and then, **appended** and never
interpolated: the diff's hunk count with the instruction to read it in the checkout (`git diff

<base>...HEAD`); the skeleton — per idea its id, its one-line `claim`, its anchors as numbered bare
ranges tagged _changed_ or _not in the diff_, and its claims by number; and the note naming
`review_pack_check`. Not the `title`, `gist`, `caption`, `note`, `headline`, `summary`, provenance or
either pad: nothing the author wrote to persuade. `plumbing` is listed like any other idea, and the
prompt says to check its claim like any other.

**The tool enforces the rule structurally.** `review_pack_check` takes verdicts keyed to what the
prompt handed out — the idea ids and the claim numbers — and `applyCheck` merges them onto the
stored document: per idea `attention` and `cue`; per claim `verdict`, `evidence` and, on a false
one, `finding`; the `false` mark on the step a finding names; the reading `order`. Nothing else in the
document is reachable from the arguments, so a claim cannot be reworded, an anchor moved or a `key` or
`disputed` mark set, because there is no field that would. **Complete or refused**: every idea gets a
label, every claim a verdict with evidence, the order names every idea exactly once, and a finding is
required on a false claim and refused on any other — a checker that skipped a claim has not checked
the pack, and a half-annotated document would read as one where the rest was found fine. A `false`
mark set by the merge replaces whatever the step carried: a false claim outranks the author's
emphasis on the same stop. Each merge starts from the author's marks, so a resumed checker calling
twice does not leave a stale `false` behind. The call re-records the document through
`Store.recordReviewPack` on the same (pull request, head) row, the desk emits `checked` and the hub
marks the goals section dirty.

## When a pack is made

_Built_ — stage 3: the author and the way a reviewer asks for one. `src/reviewPacks/author.ts` is
the desk, `src/mcp/tools/reviewPackSubmit.ts` the tool, `src/server/routes/reviewPacks.ts` the
routes; `test/reviewPackAuthor.test.ts` holds it. The control on the pull request's row that asks
is stage 5, `web/src/components/ReviewPackControl.tsx` ([Reading it](#reading-it)); the checker that
reads the pack is [The check](#the-check).

**On request, and never automatically.** A reviewer asks for one from the pull request's row on its
goal's page ([Reading it](#reading-it)) and waits while it is written. The fleet opens more pull
requests than anybody reads, and a pack nobody opens is two agent runs spent on nothing — so the cost
is paid by the person who chose to pay it, at the moment they chose to.

The wait is the trade, and it falls at the worst possible moment: somebody has just sat down to
review and is told to hold on. That is accepted rather than solved.

**The ask is `POST /api/prs/:number/review-pack`, and it returns at once** — `202`, accepted rather
than done — because the author is an agent run and a route that held the connection for one would
time out on every proxy between the cockpit and the port. The pack arrives later and
`GET /api/prs/:number/review-pack` is how a reader learns it has: until then the read is a 404 that
says whether one is being written. The desk refuses, in the order a reader would blame them, a pull
request that is not open (404), a head the provider did not report, an author already on the pull
request, a pack already being checked, and a paused fleet (409 each). **Each refusal is drawn where
the ask was clicked, in the route's own words**: a refusal is not a failure, so nothing is written
to the error log for one, and a status code the cockpit kept to itself reached the reader as a
button that did nothing — with four reasons they could have acted on. A second ask while one is
being written is refused rather than queued — the reader is the one party who can tell when a new pack is worth two agent runs — and
the ask on a new head, once the first author has finished, is the same call.

**The author is spawned outside the dispatcher.** It is not a rule: a pack is made when a person
asks, never when a rule notices a pull request without one, and nothing under `src/dispatcher/`
imports it (`test/reviewPackAuthor.test.ts` asserts so). What the desk keeps from the executor is the
two things that must not be arranged twice. Its checkout comes through `WorktreeManager.ensureReadOnly`
— a read-only slot detached at the head sha, leased under `review-pack/pr-<n>/<headSha>`, so the
branch gate sees it and the reap releases it — and its process is reaped through `AgentManager.kill`
→ `session.kill()` like every other agent's. It does **not** count against the concurrency cap, which
is the cost [Cost](#cost) accepts; it does honour the pause flag, because a paused fleet is one the
operator asked not to start agents. Its origin is `pr:<n>:pack`, inside the pull request's family, so
`padOriginFor` resolves it to the pull request's own pad and no rule's vocabulary matches it.

**The lease key carries the head sha.** The task row has no column for a head, and the pack must be
written against the head the author was handed rather than whatever the pull request points at by
the time it submits. The key is the task's own, survives a restart with the row, and names both — so
the tool re-derives everything it checks against from the row (the pull request from the origin, the
head from the key, the hunks from the same diff the prompt listed) and nothing lives only in this
process's memory. A restart mid-run resumes the agent and its submit still lands.

**What the author is handed** is the rendered `review-pack-author` template and then, **appended**
in this order and never interpolated ([05](05-dispatcher.md#prompt-templates)): the hunks by id with
their head-side ranges and `+n −m` counts, telling it to read the diff itself in its checkout with
`git diff <base>...HEAD`; both pads verbatim, oldest first, each entry with its `scr_…` id and its
fork drawn out — the goal's pad by the pull request's linked issue (`issueForPr`, then
`goalOriginFor`) and the pull request's own — or the sentence that nobody witnessed it; and the note
naming `review_pack_submit`. The diff is `GitObserver.diff(base, head)` — `git diff base...head`
from the merge base, with the pull request's `baseBranch` or the configured `defaultBranch` as the
base — and the clone is fetched first on the real observer, the plan reconciler's rule, because the
head a person just clicked on was reported by the provider and the clone may not hold it yet. A
head the clone still cannot diff fails the ask loudly: the error is recorded, no task and no lease
are left behind, and the pull request can be asked about again.

**The author writes ideas, claims, gists, notes and the ranges of regions; the harness fills in the
rest.** `review_pack_submit` (`src/reviewPacks/submission.ts` is its pure half) copies the pull
request and the head off the commission, sets `schema` to `REVIEW_PACK_SCHEMA`, mints every idea id
but `plumbing` — the one id the author may name — fills every hunk anchor's `range` and `code` from
the diff and every region anchor's `code` from the tree at the head (confined to the checkout: a
path that leaves it, or a range past the file's end, is refused), stamps a witness note's `at` from
the entry it cites, and reads `witnessed` off the log: true if either pad had an entry. A
`witnessed` or `disputed` claim, and a `by: 'witness'` note, must cite an entry the author was
handed, or it is refused by field name — the shape the type refuses is also the shape the tool
refuses. Everything the checker owns is set, not taken: `order` empty, every `attention`, `cue`,
`verdict` and `evidence` null, and the only marks an author may set are `key` and `disputed` — `false`
is the checker's. The call is the pack: it writes `Store.recordReviewPack`, the desk emits `written`
and the hub marks the goals section dirty, and a run that ends without the call has written nothing.

**Once, and the reader decides when again.** A pack is written against one head sha and stays written
against it. When the head moves the pack is marked **stale**, says how far behind it is, and **is
still shown**: the read ships `head`, the pull request's head as the harness last saw it, and `stale`
— `{headSha, commitsBehind}` when that head is not the pack's, with the count asked of the clone
(`GitObserver.divergence`) and null where the clone cannot say, which leaves the pack stale by sha
alone rather than "zero behind". Both are null for a pull request no longer in the world, open or
recently closed, where staleness cannot be decided; a reader must not fold that into "current".
Nothing regenerates it: not the push, not the next pulse, and not a reader opening it.
A pull request rarely changes direction enough after its first pack for a second to be worth two
agent runs, and the reader is the only party who can tell when it has. Asking again is the same
control as asking the first time, and the new pack replaces the old. The witness log has kept
growing in the meantime — the CI-fix and comment agents write to the pull request's own pad — so the
second pack is written from a fuller log, not the first pack.

It is not regenerated underneath a reader for the same reason it is not regenerated at all: a pack
that re-flows mid-read costs the reader their place and tells them nothing about what changed since
they started, which is worse than being told it is old.

### Pull requests nobody witnessed

_Built_ — stage 3, with the author.

A pack is offered for a human-authored pull request too, and the harness says plainly that there is
no witness log: every claim comes out `inferred`, and the pack's header states it rather than leaving
a reader to notice the absence of `witnessed` beside anything. The prompt's log block says so in as
many words — neither pad has an entry, and whether the harness links the pull request to a goal at
all — and tells the author not to invent a witness; the tool then refuses any claim or note that
cites an entry, since there is none to cite, and writes `witnessed: false`.

Offered where every pack is — on the [pull request's own page](17-cockpit.md#the-pull-request-page),
reached from its row on a goal's page. A pull request the provider has not linked to a goal has no
row to be reached from, so in practice a human-authored pull request gets a pack where the harness
knows about it (`ownsPr`, [17](17-cockpit.md#the-pull-requests-and-the-tail)). That is the honest
limit of the surface rather than a rule about authorship — and one the address bar already answers
for anybody who has the number: `?pr=<n>` opens the page, control and all.

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

**Where the finding lives** — _built_, stage 4; the four surface requirements above are the
rendering's, stage 5, drawn by `web/src/components/ReviewPackPage.tsx` in that order and held as an
order by `test/reviewPackPage.test.ts`. A false claim's finding is a field **on the claim**, `ReviewClaim.finding`
(`ReviewFinding` in `src/types.ts`), because the claim is what is false and the claim is what the
gate counts; the step of the walk it is about carries `mark: 'false'`, set by the same write, so
the walk shows where. A finding carries its `headline` (one plain line), its `body` (the consequence
worked out, how serious, whose call — the closing paragraph; markdown), the `step` it is about
(1-based, as the page numbers them; null where no stop fits) and, where the contradicting code is not
already on the walk, a `counter`: a range of the tree at the head with its `code` read off the
checkout the way a region anchor's is, and the checker's one-line caption. The "two pieces of code
that disagree" on the page are the marked step and the counter. It rides inside the document —
`ReviewPackPayload` extends the record and re-declares nothing — so the page draws the gate from the
count of `false` verdicts, the flag on the idea's collapsed row from the same, the claim at the top of
the idea from the claim's own fields, and the boxed section from `finding`. An added field on a
claim, so `REVIEW_PACK_SCHEMA` stays at 1: no renderer exists yet that the shape could surprise.

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

The version this build writes is `REVIEW_PACK_SCHEMA` in `src/store/reviewPacks.ts`, and the field is
a number rather than a literal type so the comparison can be written. The store refuses to **write**
a document stating any other number: a pack it accepted and every reader then refused would be a
run's work lost with nothing red at the one moment it could have been caught. It does not inspect
the version on read — what was written is returned as written, and refusing is the renderer's job.

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

A mark (`ReviewMark`) is one row per hunk, keyed on the pull request and the hunk — path, start,
end — and **not** on the head sha, which it records but is not keyed by: keyed to a head, a mark
would die with the pack it was made against, which is the one thing the table exists to prevent. The
three things a reviewer can do — read an idea, override its label, take the finding on its false
claim — are three columns on that one row, `read`, `attention` and `seen`, and **each write names
only its own column** so the other two keep what they had. `Store.markReviewIdeaRead`,
`Store.overrideReviewAttention` and `Store.markReviewFindingSeen` take the hunks an idea owns and
write them all in one transaction; `listReviewMarks` hands back every mark on the pull request,
whichever head each was made against, for the renderer to lay over whichever ideas own those hunks
now.

`seen` is the odd one of the three and is the reason [prominence](#whether-prominence-works) is
measurable at all: it is a statement about the **checker's** output rather than the author's, and it
is keyed the same way as the other two on purpose — to the hunks the idea owns, never to an idea id,
which the next pack mints afresh. It is offered on the page **under a finding and nowhere else**, and
the route does not second-guess that by refusing an idea with no false claim: the mark rides on
hunks, and which ideas carry a finding is the renderer's rule to keep.

**The page writes them through three routes** — _built_, stages 5 and 7 —
`POST /api/prs/:number/review-pack/ideas/:id/read` with `{read}`,
`…/ideas/:id/attention` with `{attention}` (a label or null to clear), and `…/ideas/:id/seen` with
`{seen}`, all three in `src/server/routes/reviewPacks.ts` under `checked(...)`. Each resolves the idea in the **current**
pack, takes the hunks it owns — the `hunk` anchors; a `region` is a reference, and a mark riding on
one would land on the idea that owns that hunk — and writes at the pack's head. Refused when there
is no pack or no such idea in the current one (404: the pack was rewritten under the page), and when
the idea owns no hunk at all (409): a walk of regions only has nothing for a mark to ride on, and a
click that wrote nothing would read as taken. Both answer with every mark on the pull request, the
shape the read ships, so the page re-lays them from one shape rather than patching a copy.

**Laying them back is a rule, not a lookup.** `layMarks` (`web/src/view/reviewPack.ts`) reads an
idea as _read_ only when **every** hunk it owns carries a read mark, as _seen_ only when every hunk
it owns is, and as overridden only when every hunk agrees on one label. Across a rewrite that is the honest reading: the next pack may fold
two ideas into one, and calling the union read because half of it was is the lie the per-hunk key
exists to avoid. An idea owning no hunk can carry no mark and reads unread.
→ [16](16-http-api.md#post-apiprsnumberreview-packideasidread)

## Reading it

_Built_ — stage 5, the cockpit rendering; stage 6, the HTML companion. `web/src/components/ReviewPackPage.tsx`
draws the page, `ReviewPackModal.tsx` fetches it and takes the marks, `ReviewPackControl.tsx` is the
control on the row, and `web/src/view/reviewPack.ts` holds the derivations; `test/reviewPackPage.test.ts`
holds it.

Two renderings, and the layering is the same in both because the layering _is_ the product.

1. **The whole change on one screen.** The ideas as one line each, their attention labels, and the
   count of false claims above them. A reader who stops here has the useful part: where the time
   goes, and whether anything is wrong.
2. **The code.** Opening an idea shows the walk — every anchor, with its actual code, in reasoning
   order. This is the layer the reader is meant to spend time in.
3. **The reasoning.** Under each anchor, folded away, the note and the witness entry behind it.

Layer 2 is code and not prose deliberately. A pack whose middle layer was the author's narrative
would be a surface people approve from without reading the change, which is worse than the review it
replaces. The prose is support; it is never the thing in the middle.

### On the row

The pull-request rack and the goal page's pull-request card draw **whether there is a pack**, as a
third mark in the reading slot beside [the fleet's review](17-cockpit.md#the-fleet-reviews-mark) and
[the checks](17-cockpit.md#the-checks-mark): `PackMark` (`web/src/components/PackMark.tsx`), the
book glyph in the review mark's own box, tinted `current`, `stale` (badged), `unplaced` or `writing`.
Absent — no pack, and nobody writing one — draws nothing, the silence the review mark keeps on a
deployment with no reviewer. → `test/packMark.test.ts`

**A reading, never the control.** Asking for a pack and opening one stay on the pull request's page,
where `ReviewPackControl` reads the document over its own route and can say everything about it. This
mark answers the one question a rack of twenty rows can afford to ask of all of them at once — is
there something written here worth going to read — and its click goes to that page.

**It rides the snapshot, and it is three columns rather than a document.** `PullRequest.pack` is folded
in `stateSnapshot.ts` from `Store.listReviewPackHeads()` — `(pr_number, head_sha, written_at)` for each
pull request's newest pack, no `document` column and so no JSON parsed — and from whether an author is
on the pull request now. `listCurrentReviewPacks` parses every pack it returns, which is the right
price for a surface that draws them and the wrong one for a fold that runs on every pulse.

**Staleness is by sha and never by time**, the same rule the page's own `packCurrency` keeps: a pack
is about the commit it was written against, and a pull request whose head has not moved is one the
pack still describes however long ago it was written. A pull request the provider reported **with no
head** is `unplaced` and says so, rather than being folded into `current` — the one case that is about
the provider must not be drawn as the one that is about the pack
([24](24-environments.md#the-three-verdicts)).

### The page

This is the output format, and both renderings draw it. It is written for the person, in their
words: the sentences on it say what changed and what could go wrong the way a colleague would, and
the identifiers live in the code blocks, not the prose. Top to bottom:

1. **Masthead.** A kicker naming the pull request and its head; a `headline` that says what the
   change does in one plain sentence; a `summary` paragraph in the same register, with the one thing
   the reader most needs in bold; and a facts line — ideas, files, changes and whether every one is
   owned, the claim counts by verdict, and an `estimatedMinutes`. Both prose fields are the author's.
2. **The gate.** A red band, first thing after the masthead and above the ideas, with the count of
   false claims and one sentence saying what is wrong and which idea it touches, linking to the
   finding below. Absent when nothing is false. This is the surface that honours
   [What a false claim does](#what-a-false-claim-does).
3. **The ideas.** A rule reading "The _n_ ideas — open one to see the code", an open-all control, and
   then one row per idea: its number, its attention label as a chip, its `title`, and a metadata
   line — steps, changes, and a red flag naming a false claim or a disputed one. Under the title,
   the `cue`. The row is collapsed; the marks on it survive a reader who opens nothing. The numbers
   carry the reading order the checker chose, which is why they are numbers.
4. **The walk.** Opening an idea shows the anchors as numbered steps down a rule. Each step is the
   path and line, a tag — _changed +n −m_, _not in this PR_ drawn dashed, _the important bit_,
   _claim is false_, _witness disagrees_ — the gist in one sentence, the code block with its
   `caption` and diff lines coloured, and beneath it the folded reasoning: one fold per note, each
   stamped _witness · hh:mm_ or _added afterwards_. A fold with a false or disputed claim behind it
   is open by default. A deliberate absence reads "Should this have changed? No — here's the proof."
5. **The claims.** Under the walk, "What the author claims · checked by a second agent": one line per
   claim with its verdict as a chip, its evidence in the sentence, and a `cant_tell` ending with
   "You decide."
6. **The finding.** After the ideas, a boxed section per false claim: a plain headline, the two
   pieces of code that disagree shown together with captions, the consequence worked out — a table
   where numbers make it concrete — and a closing paragraph that says how serious it is and whose
   call it is. Written by the checker from its evidence; the page's most important prose.
7. **Where to spend the time.** A numbered list, one entry per idea, in the order the checker says to
   read them, each with the reason. This is `attention` made actionable.
8. **The colophon.** Folded: how the pack was made, what the dashed boxes mean, and what is fake if
   anything is — the sentence a demo owes and a real pack states as "nothing".

The document carries every field this needs and the renderer invents none: `headline`, `summary`,
`estimatedMinutes` and the reading `order` are fields of the pack, `title` and `cue` of the idea,
`caption` and `mark` of the anchor. A renderer that finds a field missing draws the gap, so a pack
without a cue shows a row with no cue — the author's omission, visible, rather than a renderer's
guess.

Three things the order above leaves to the renderer, settled the same way in both:

- **The numbers are the reading order when there is one.** The rows are numbered by `order` once
  the checker has filled it and by document order until then, and the rule above the ideas says
  which — _numbered in the order the checker says to read them_, or _in document order — the checker
  has not ordered them_. "Where to spend the time" is drawn only from a filled order; with none it
  says so rather than inventing one.
- **An unchecked pack is drawn as itself.** Every `attention` and `verdict` null with `order` empty
  is one of two states, told apart by the read's `checking`: a band saying the checker is on it, or
  one saying it never finished — a paused fleet, a checker that failed, the error log says which —
  with the ask beside it, because asking again is the recovery and nothing retries on its own.
  Neither reads as "fine".
- **The facts line's counts are computed, not stated.** Ideas, distinct files and changes come off
  the hunk anchors; the claim counts off the verdicts, with _unchecked_ as a fifth figure while any
  is null.

The reference for the shape is the pack for #684, kept at
[`examples/review-pack-684.html`](examples/review-pack-684.html) as the target the first build is
measured against. It is a hand-made demo — its colophon says what in it is invented — and a pack the
harness writes is expected to render to the same page.

**The cockpit rendering** opens over the goal page, from the control on the pull request's row
([17](17-cockpit.md#the-pull-requests-and-the-tail)) — there is no pull request page to put it on —
and is the only one that takes input: the reviewer's marks, per
[What a reviewer does](#what-a-reviewer-does-is-not-part-of-the-pack). Its position — which pull
request's pack, which idea is open — is `Place` state and lives in the query string as
`?pack=<n>&idea=<id>`, not a `useState` in `useCockpit`: a surface held outside it is stepped over
by the back button and dropped by a reload, both silently. `idea=all` is the open-all control, a
value of the same field rather than a second one, and an idea is carried only under a pack.
→ [17](17-cockpit.md#the-address-bar), [17](17-cockpit.md#the-review-pack)

The control on the row draws the states between asking and reading — not asked, being written,
written and being checked, checked, stale by so many commits or by an unknown number, and a pull
request the world no longer carries — and reads them off the route itself, because the pack is not
on the snapshot. A closed pull request's row keeps the way in to a pack it has and loses the ask,
since the desk refuses to write one for it. Both the control and the page re-read on a short clock
only while an author or a checker is on the pull request.

**A refused ask is drawn beside the ask that was refused**, wherever it is drawn — the row control,
the empty page, the stale line, the unchecked band — held by the shell (`ReviewPackModal`) exactly
as the share's refusal is, because the page is a pure function of the payload and a refusal is about
a click. It is drawn and not flashed for the reason the share's is: the sentence _is_ the whole of
what the reader can act on, and the four reasons the desk gives
([When a pack is made](#when-a-pack-is-made)) each have a different next move. Every ask also
**re-reads the pack afterwards, refused or not** — a refusal usually names state that moved under
the surface, and the re-read is what turns the button into the chip that says so.

Every reference to a goal, a pull request or an issue is drawn with `<Ref to={ref}/>`
(`web/src/components/refs.tsx`), never as text. → [17](17-cockpit.md#links)

The page fetches the two pads the author was handed — the pull request's own and the goal's — once
per open, and draws the entry a `witnessed` or `disputed` claim cites verbatim beside it; an entry
neither pad carries is said to be missing rather than left blank. The renderer's own copy of the
schema number is `KNOWN_REVIEW_PACK_SCHEMA` in `web/src/view/reviewPack.ts`, restated there because
the cockpit may name nothing of the harness but `src/wire.ts`, which carries no runtime; the test
pins it to `REVIEW_PACK_SCHEMA`.

**The HTML companion** — _built_, stage 6. `renderReviewPackCompanion` in
`src/reviewPacks/companion.ts` is a single self-contained file rendered by the harness from the pack
document alone when a pack is [shared](#sharing-a-pack), the way
[28](28-cross-fleet-pool.md#the-human-readable-companion) renders its markdown beside `claims.json`:
a pure function of the document, written beside it, never read back;
`test/reviewPackCompanion.test.ts` holds it. It is read-only, it has no harness behind it, and it is
for the reviewer who has no LubbDubb — which is most reviewers on most teams. It needs nothing
checked out, because the document [carries its code](#the-document-carries-its-code): one file, one
inline stylesheet, no script and no request, every fold a `<details>`. It **takes no input** — a
shared pack carries no marks, so there is no control on it and nothing for one to write to — and it
refuses an unknown `schema` whole, exactly as the cockpit does. A skill in the repository was the
earlier shape and is rejected for the reason [20](20-validation.md#the-skill) keeps its skill out of
the checkout: a copy that travels with a checkout is the stale one, and this renderer's one job is to
not be.

**It draws the same page, from a second copy of the derivations.** The numbering, the false-claim
list and the facts line are in `src/reviewPacks/derive.ts` for the companion and
`web/src/view/reviewPack.ts` for the cockpit, and neither can import the other: `web/src/` may name
no server module but `src/wire.ts`, which carries no runtime, so there is no one place both can
reach. The arrangement is the one `KNOWN_REVIEW_PACK_SCHEMA` already has and the defence is the same
— `test/reviewPackCompanion.test.ts` runs both over one pack and asserts they agree, so a rule
changed on one side and not the other fails there rather than shipping two pages that disagree about
which idea is number one. Two differences are deliberate and are the absence of a harness rather than
a second design: every idea is open, because there is no address bar to hold which one is not; and a
`witnessed` claim's pad entry is **said to have stayed behind** rather than drawn, because a shared
pack carries the document and nothing else.

## Sharing a pack

_Built_ — stage 6. `PoolDesk.shareReviewPack` takes the ask and its packs arm publishes and prunes
(`src/pool/poolDesk.ts`); `packSecretRefusal` in `src/reviewPacks/secrets.ts` is the backstop, the
route is `POST /api/prs/:number/review-pack/share` and the control is on the page
(`web/src/components/ReviewPackPage.tsx`); `test/reviewPackShare.test.ts` holds it.

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
pack is a second kind of document in the fleet's own namespace, beside `digest.json`, with an HTML
companion beside it the way the digest has a markdown one. It is **not** a claim: nothing about it is
corroborated, vouched for, or injected into an agent's prompt.

**One document per pull request**, at `fleets/<fleetId>/packs/pr-<n>.json` with its companion beside
it, carrying the pack whole in the pool's own envelope
([28](28-cross-fleet-pool.md#a-third-document-rides-this-and-is-not-a-claim)) — the local document
restated nowhere, for the reason every rendering of one is downstream of it. Sharing again on a newer
head replaces that one document; the older pack stays in the fleet's own store, which is where the
history belongs. **Nothing polls it**: `fetch` names the two clock documents and never walks, so a
shared pack is read by people and by no harness, this fleet's included.

**The ask is a person's and the publish is the pulse's.** The route records the share and answers
`202`; the pool's own arm puts the document out on the next pulse, because
[28](28-cross-fleet-pool.md#the-publish-is-never-inside-a-route-handler) has a route that pushed to
another continent reporting a network failure as a failure of the click. A publish that throws leaves
the share standing, so the next pulse retries it, exactly as a dirty document is retried. The page
draws the states between — not shared, shared and waiting for the next publish, in the pool, refused
— and re-reads on the short clock while one is waiting, the same clock the pack and the check arrive
on. A deployment with no pool says so instead of offering a control that could only refuse.

Two consequences that are easy to miss:

- **The secret backstop matters more here than it does for a claim.** A pattern check written for one
  English sentence is being pointed at the code the anchors embed, where a token in a test fixture or
  an internal hostname in a config default is exactly the thing that hides. It runs over every
  embedded line, not only the sentences. It refuses and never rewrites, as it does for claims — and it
  will refuse a legitimate share sometimes, which is the correct direction to fail in and should
  surprise nobody when it happens. It is the pool's own `secretRefusal` pointed at every string the
  document would carry — anchor code, counter code, notes, claims, the author's prose — and **the
  refusal names the place and never the match**: _idea 1, step 2: src/config.ts:41 — it looks like it
  contains a GitHub token_. Echoing the line would be this control creating the exposure it exists to
  stop. It runs twice, at the ask and again at the publish, because the ask is the last moment a
  person is there to be told and the publish is the last moment before the bytes leave; a refusal with
  somebody to tell writes no row, and the one nobody is there to hear is recorded on the share.
- **A shared pack is pruned; the local one is kept.** A claim is durable; a pack is disposable, and
  the pack for a merged pull request is dead weight in a repository everybody clones. The fleet that
  published it removes it from its namespace on the publish after the pull request has been closed
  for `closedPrWindowMs` — the same clock that drops the pull request out of the world the cockpit
  draws ([07](07-pull-requests.md)), so a shared pack outlives its pull request's row by nothing. The
  local row is untouched: it is the fleet's own record, and the cost of keeping it is the fleet's.
  The reading is off the world the cockpit draws and **never off a silence**: with no baseline at all
  nothing is pruned, because _the harness has not looked_ must not be folded into _the pull request is
  long gone_. A prune that fails leaves the share row standing and the next pulse tries again — a pack
  left in the pool because one push failed is the thing pruning exists to prevent.

## Unsharing a pack

_Built_ — stage 7. `PoolDesk.unshareReviewPack` records the withdrawal and the packs arm carries it
out (`src/pool/poolDesk.ts`); the route is `POST /api/prs/:number/review-pack/unshare` and the
control is beside the share on the page; `test/reviewPackCalibration.test.ts` holds it.

A pack shared by mistake used to wait for [the prune](#sharing-a-pack), which is `closedPrWindowMs`
after the pull request closes — weeks, in a substrate everybody clones. **The inverse of the share is
one act**: one route, one control, and the copy is gone on the next pulse.

**Immediate in the only sense a route may be.** The ask is recorded at once and the network write is
the pool's, exactly as the publish is
([28](28-cross-fleet-pool.md#the-publish-is-never-inside-a-route-handler)) — a route that pushed to
another continent would report a network failure as a failure of the click, and the failure that
matters here is the one where the pack _stays_ in the pool. So the row is stamped `withdrawnAt` and
the arm takes the same path a prune takes: `unpublish`, then the row goes. A withdrawal that throws
leaves the row standing and the next pulse tries again, which is the prune's rule for the prune's
reason.

Three consequences worth stating:

- **The row is kept and stamped rather than deleted**, because the copy is still in the namespace and
  the row is the only thing that would tell the arm to remove it. The one exception is a share the
  pool never carried — nothing landed, so nothing needs a commit to say so, and the row goes at once.
- **Unsharing something nobody shared is not an error.** The caller wanted the pack out of the pool,
  and it is. A 409 there would be the control reporting success as failure.
- **The local `review_packs` row is untouched**, as it is on a prune: it is the fleet's own record,
  and the cost of keeping it is the fleet's. What a withdrawal takes back is the copy, never the pack.

## The operator's reading

_Built_ — stage 7. `src/reviewPacks/calibration.ts` is the lens, `GET /api/review-calibration` the
route (in the review packs' own route module, which owns the group), and
`web/src/components/ReviewCalibrationTab.tsx` the **Review** tab on
[Insights](17-cockpit.md#insights); `test/reviewPackCalibration.test.ts` holds it.

Three readings, on one surface, because they are three answers to one question: **is this subsystem's
own output drifting?** Nothing on it is about a particular pull request, and the action each points at
is the same one — a person changing a prompt, once, deliberately.

| Reading                | The signal                                                      | What it says to do                                                                                           |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **The overrides**      | reviewers relabelling ideas, and which way                      | a pattern of upgrades means the checker is underselling risk: change `review-pack-check`                     |
| **The plumbing ratio** | plumbing hunks over owned ones                                  | a rising share is an author explaining less, not a repository with more renames: change `review-pack-author` |
| **Prominence**         | pull requests that merged with a false claim nobody marked seen | either the finding was wrong, or [the page](#the-page) is not loud enough                                    |

**It is never shown to the checker, and it reaches no prompt.** That is the whole reason the
overrides are worth recording: given them the checker would calibrate to what reviewers like rather
than to what is risky, and a label that has learned to agree with its reader has stopped being
evidence ([Attention](#attention)). This is a page a person reads.

**On Insights rather than on the obstacle board.** [27](27-obstacles.md) is what the fleet is _told_,
and a pack produces nothing for it ([What was decided](#what-was-decided-and-why)) — a reading of packs
filed there would draw a feedback path this subsystem deliberately does not have. Insights is where an operator reads
whether the harness is working, which is exactly what these three are. It obeys that page's window
like every other tab there, and it is fetched on the tab's first visit for a window rather than with
the page: it folds every pack against every mark, which nothing on the top bar needs.

**Derived, never stored**, and over one population: each pull request's **current** pack written in
the window — one pack per pull request, so a pull request asked three times is not counted three
times, and the pack counted is the one the page draws. Every mark on that pull request is laid over it
whenever it was made, by the rule [`layMarks`](#what-a-reviewer-does-is-not-part-of-the-pack) lays
them: an idea is overridden only when every hunk it owns agrees on one label, and seen only when every
hunk it owns is. That rule is stated twice — once server-side and once in the cockpit — for
`KNOWN_REVIEW_PACK_SCHEMA`'s reason: `web/src/` may name no server module but `src/wire.ts`, which
carries no runtime.

Two details that are easy to get wrong:

- **`read`, `decide` and `skim` are a ladder and `split` is not.** `split` is a judgement about how
  ideas relate rather than about how hard to look, so a move onto or off it is counted as its own
  figure rather than folded into an upgrade — which would make the one number the operator acts on
  say something it does not mean.
- **The merge is read off the durable work graph, never off the world.** A closed pull request drops
  out of the world after `closedPrWindowMs`, and _the harness stopped carrying it_ must not read as
  _it never merged_. The plumbing ratio is null and never zero on an empty population, for the same
  shape of reason.

## Where it lives

Three tables, in `src/store/reviewPacks.ts` — under `src/store/`, the only directory that touches
SQLite, one module per group of related tables, taking a `StoreContext`, with `Store` delegating
under the same method names — and one column on a table another module owns.
→ [14](14-persistence.md#shape)

| Table                | Holds                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `scratch_entries`    | the witness log: a `decision` column on the pad's own rows, null on an ordinary note                                                          |
| `review_packs`       | one row per (pull request, head sha): the pack document as JSON, and when it was written                                                      |
| `review_marks`       | what a reviewer did to a pack — overrides, ideas read, findings taken — one row per hunk an idea owns, keyed on the pull request and the hunk |
| `review_pack_shares` | whether a pull request's pack is in the pool: one row per pull request, written only when somebody shares one, deleted when it is pruned      |

The pack is one document rather than a table per level. It is written whole and read whole, and
nothing queries inside it — three normalised tables would buy nothing and cost a join on every read.
The head sha it was written against is a column **as well as** a field, because staleness is decided
by comparing it to the pull request's head on every load and that read must not open the document to
do it; the row's columns are copied off the document at write, never taken as arguments, so the two
cannot disagree. `recordReviewPack` upserts on (pull request, head sha): asking again on the same
head replaces the pack, and a pack for a newer head is a row beside the older one, which is kept.
`getCurrentReviewPack` answers the newest written, whatever head it names — whether that is stale is
decided above the store, which does not know the pull request's head. The witness log lives on the
pad because it _is_ pad entries, appended over time by the working agents; the marks are separate
because they outlive the document they were made against.

No row is the ordinary state for a share, and the honest one: sharing is a second, deliberate act, so
a pull request nobody shared has nothing to say. The row carries the head it shared — a share is of
one pack, not of a pull request — and the ask, the publish and the withdrawal as three stamps,
because all three happen on the pool's clock rather than in the route. Deleting it on the prune, or
on the withdrawal the pulse carries out, leaves the `review_packs` row alone.

`scratch_entries` exists, so the `decision` column needs its `ColumnMigrations` entry in the pad's
own store module, or every database from before it has no column and every fork is silently a note.
The three pack tables were new **once**, which never kept them exempt — and stage 7 is where that
came due: `review_marks.seen` and `review_pack_shares.withdrawn_at` are columns on tables that had
already shipped, so each has its `REVIEW_PACK_COLUMNS` entry and each arrives by an additive
`ALTER TABLE` guarded by a `PRAGMA table_info` check. Neither owes a backfill: `seen` is 0 on every
existing row and 0 is what those rows mean — nobody had a finding to take, because there was no
control to take it with — and a null `withdrawn_at` means _not withdrawn_, which is true of every
share that predates the withdrawal. → [14](14-persistence.md#migrations),
[14](14-persistence.md#when-a-null-means-something)

The shapes the routes ship live in `src/wire.ts`, and a wire type either **is** the domain type or
`extends` it — never a re-declaration and never widened. `test/wireContract.test.ts` asserts that
`src/wire.ts` is the only server module anything under `web/src/` names. The pack document is the
clearest case there is: the cockpit, the companion and the store read one shape, so there is one
declaration of it — `ReviewPackPayload` extends `ReviewPackRecord` (the document and when it was
written) with the marks, and re-declares nothing. Declared with the document, ahead of the route that
will ship it, so the two cannot drift apart.

The routes are `src/server/routes/reviewPacks.ts`, with its entry in `app.ts`'s `ROUTE_MODULES`,
and every handler is wrapped in `checked(schemas, handler)` rather than reading the request itself:
the ask and the read under [When a pack is made](#when-a-pack-is-made), both on
`/api/prs/:number/review-pack`; the share under [Sharing a pack](#sharing-a-pack), on
`…/review-pack/share`, and its inverse on `…/review-pack/unshare`
([Unsharing a pack](#unsharing-a-pack)), whose answer — `ReviewPackSharing`, the same shape the read
ships as `sharing` — is declared beside the payload; the three mark routes under
[What a reviewer does](#what-a-reviewer-does-is-not-part-of-the-pack) beneath it, whose body
shapes — `ReviewReadBody`, `ReviewAttentionBody`, `ReviewSeenBody` — and answer —
`ReviewMarksPayload` — are declared in `src/wire.ts` beside the payload; and
`GET /api/review-calibration` ([The operator's reading](#the-operators-reading)), which is in this
module because the packs are the group that owns the reading rather than because it is an insights
route. → [16](16-http-api.md#post-apiprsnumberreview-pack)

Two prompt ids, registered like any other: `review-pack-author` and `review-pack-check`, both
built. A `PromptId` is never deleted once it exists — it is marked `retired: true`, because
`loadPromptTemplates` throws on a file naming no known id and removing one turns every deployment
that overrode it into a harness that will not boot. The author's tool is `review_pack_submit` and
the checker's `review_pack_check`, both named in `MCP_TOOL_NAMES` and classified `point-of-use` —
each prompt names its own, twice — and the two desks reach the tool layer as
`McpToolDeps.reviewPacks` and `McpToolDeps.reviewPackChecker`, lazily, like the filing desk; each a
`Pick` of the one `submit` method, so a tool can reach nothing of a desk but the write it exists for.
The origins and lease keys of both live together in `src/reviewPacks/origins.ts`, so the two shapes
cannot drift. → [05](05-dispatcher.md#prompt-templates), [11](11-mcp-tools.md#the-tools)

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

**The checker follows the author, and nobody asks for it.** A second explicit ask was the
alternative, and it would make an unchecked pack the ordinary state and a checked one a further
click — where every sentence in this document assumes the labels and the gate arrive with the pack.
It follows the author's run ending rather than its submit, because at the submit the author is
still alive and still holds its slot. → [The check](#the-check)

**The finding lives on the claim, and the `false` mark on the step.** The claim is what is false and
what the gate counts; a separate findings list on the pack would be one more place for the count and
the prose to disagree. → [What a false claim does](#what-a-false-claim-does)

**The checker's tool takes verdicts, never a document.** Handed a whole document back, the rule that
the checker may not edit the pack would be a sentence in a prompt; keyed to the ids and numbers the
prompt handed out and merged by a function that can reach only the checker's fields, it is the shape
of the tool. → [The check](#the-check)

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

**A pack files nothing on the board.** "The checker keeps catching the same class of thing" was the
argument for a path into [27](27-obstacles.md), and it names an aggregator across packs that nothing is
specified to be and that could not live in `src/dispatcher/`. Nobody needs it; the paragraph is gone.

**The three cross-pack readings are one surface, on Insights.** They were open questions separately
and are one answer together: the overrides, the plumbing ratio and prominence all say the same kind
of thing — the subsystem's own agents are drifting — and they point at the same act, a person editing
one of two prompts. Filing them on the [obstacle board](27-obstacles.md) was the alternative and would
have drawn a feedback path into the fleet that this subsystem refuses to have.
→ [The operator's reading](#the-operators-reading)

**`seen` is a third column on the mark row, not a table of its own.** It is keyed to the hunks an
idea owns exactly as the other two are, because it survives a rewrite for the same reason and dies
with a rewritten hunk for the same reason. A separate table would be the same key twice.
→ [What a reviewer does](#what-a-reviewer-does-is-not-part-of-the-pack)

**Unsharing is the share's inverse and rides the same arm.** Deleting the local row and letting the
prune find nothing was the cheap alternative, and it leaves the copy in the pool forever. The row is
stamped instead, and the pulse that publishes is the pulse that withdraws.
→ [Unsharing a pack](#unsharing-a-pack)

## What is still open

**Whether `plumbing` rots, now that the ratio is counted.** It is the honest answer to hunks that
carry nothing to review, and it is also where an author will put anything it cannot be bothered to
explain. The checker verifying that those hunks are semantically empty is the defence, and it is not
obviously enough — and by the check's own rule "semantically empty" is a judgement, so the honest
verdict on a plumbing claim is often `cant_tell`. The signal is now drawn
([the ratio](#the-operators-reading)); what is still open is the threshold, which nothing here states
because nobody has watched it long enough to know one.

**Whether the wait is tolerable.** Asking for a pack and waiting lands at the worst moment — somebody
has just sat down to review — and the checker reading in series is most of the wait. If that turns
out to drive people away from asking, the fix is pre-generating for a narrower set of pull requests,
never making everyone pay for every one.

**Whether prominence works.** [What a false claim does](#what-a-false-claim-does) makes four
requirements on the surface, and all four are checkable — as the order things are drawn in. None
measures the thing they stand in for, which is whether a false claim gets read. The one number that
does is now recorded and counted: the [`seen` mark](#what-a-reviewer-does-is-not-part-of-the-pack)
and the pull requests that merged without one
([the reading](#the-operators-reading)). What is open is the reading itself — a merge with an unread
finding is ambiguous between _the page is not loud enough_ and _the reader looked and disagreed_, and
nothing distinguishes them. A control that recorded disagreement would, and it would also be a
verdict on the checker's verdict, which is a fourth role this subsystem has argued itself out of
twice.

**Whether a reviewer's marks should travel.** They are held beside the pack rather than in it, which
means they are local by construction. Whether a shared pack should carry the fact that somebody
already read an idea, or arrive clean for each reader, is not decided — and the answer probably
differs for a teammate and for an outside reviewer.
