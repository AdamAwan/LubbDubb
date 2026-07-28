# Roots for everything — the work item that was never filed

**Status:** design, stage 3 of 3
**Date:** 2026-07-28
**Follows:** [`2026-07-28-work-graph-design.md`](2026-07-28-work-graph-design.md) (stage 1, shipped in #150),
[`2026-07-28-work-graph-stage-2-assessor-design.md`](2026-07-28-work-graph-stage-2-assessor-design.md) (stage 2, shipped in #151)

## The problem stages 1 and 2 left standing

Stage 1 records what the harness did. Stage 2 reads that record — as an agent, never as
a rule — and writes `delivered`, the harness's own park, which is keyed on `issue:<n>`.

Both are complete for work that descends from a tracker item and blind to work that does
not. `foldWorkGraph` emits a `job` node with `parentRef: null` unconditionally, so every
operator-launched job is a root of its own tree. An agent runs, a worktree is cut,
commits land, a PR may open and merge — and the only place any of it is recorded is a
`jobs` row in the harness's own SQLite file. There is nothing in the tracker at all.

Three consequences, in increasing order of how much they matter.

**The tracker under-reports the fleet.** Anyone reading the board sees the issues and
none of the jobs, so "what has this repo been doing" is answerable only from the cockpit,
which is the harness's own window on itself.

**Stage 2 cannot reach it.** `deliveryHold`, `issue_deliveries`, `assess_issue` and rule
3e are all keyed on `issue:<n>`. A job's tree has no `issue:<n>` anywhere in it, so no
assessment is possible even in principle — not because the assessor refuses, but because
there is no ref to address it to.

**Nothing external can ever mark it done.** Completion is read from the tracker and
never computed — that is the line the whole design rests on. An item the tracker has
never heard of therefore has no terminal state available to it, ever. It is not that the
harness has the wrong answer; it is that the question cannot be asked.

The statement stage 3 makes is the one the stage-1 design wrote down: **nothing gets done
without a recorded work item; if one is missing we create it.** What follows is what
"missing" means, who decides, and what changes when one appears.

## Question 1: what triggers filing

**Settled: an operator click. Not a rule, and not the assessor.**

A rule that files tickets autonomously is a **new outbound capability on the world**, and
it is a larger step than anything stages 1 or 2 took. Stage 1 wrote only to its own
table. Stage 2 wrote `issue_deliveries` — internal, reversible, gating nothing but
pickup — and dispatched an agent onto a branch that is never pushed. Neither touched the
tracker. The stage-2 spec put the line in as many words:

> **Closing the issue.** The assessor never moves the tracker. `closed` is the human's,
> and that is the line the whole design rests on.

Creating an item _is_ moving the tracker. Reading a tracker state as terminal while
writing tracker rows on the harness's own initiative is not a contradiction exactly, but
it is the harness on both sides of a signal it has spent two stages insisting it only
reads.

Three further reasons, none of which is caution for its own sake.

**A filer is a loop whose output is somebody's backlog.** Every gate in this repo that
produces outbound acts is either throttled (`dispatchVerdict`), gated (`autoSend`), or
proposed to a human (`proposals`). None of those transfer. A cooldown does not help: the
condition "this job has no work item" is _permanent_ until acted on, so a throttle only
sets the rate at which the backlog fills. And unlike an escalation, a filed ticket has no
undo — it is closed by hand, by a person, one at a time.

**The mechanism stage 3 is told to reuse is defined by a human starting it.**
`report_finding` deliberately queues nothing, and `src/mcp/findings.ts` gives the reason
at length: an agent that could put work into the pipeline is a capability escalation
round the auto-send seam. Filing is `POST /api/findings/:id/file` — an operator click,
sitting beside `/promote` and `/dismiss` as one of three arms of one human decision.
Reusing that machinery while inverting its authority model would take the plumbing and
discard the argument.

**The assessor cannot notice.** It is fenced to `issue:<n>:assess` origins by
`assessmentOrigin` and dispatched by a rule keyed on issues. It can never be looking at a
job. Routing it there would mean a second assessment funnel for work that has none of the
re-pickup problem the first one exists to solve.

So the harness's half is to **detect and surface**; the operator's half is one click; the
agent's half is to write the ticket, because the wording is the part an operator has
opinions about and a prompt template is where those already live.

### What the harness does do on its own

Detection is not a decision, and stage 3 leans on that hard. The rest of this document is
mostly about making the flagged set _small and true_, so that the click is rare and
obviously right rather than a chore attached to every job.

## Question 2: is an unparented PR a defect?

**Settled: no. A PR with no work item behind it is normal, and filing one for each would
be noise.**

Most repositories carry hand-made PRs with no ticket — a typo, a dependency bump, a
drive-by cleanup. A human opened it, a human will merge it, and the harness already works
it fully: rules 1, 2, 2b and 3 fire on an unparented PR exactly as on any other, so
nothing is degraded and nothing is missing. **Noise in a tracker is worse than a gap in a
graph**, because the gap costs a reader one inference and the noise costs somebody a
triage pass, forever.

The interesting part is why that answer was ever in doubt, and the answer is that the
category was ambiguous. Today a rootless PR might be a human's, or it might be the
harness's own — a job agent's PR is unparented for exactly the same reason a stranger's
is, because `prParent` is filled from parts and from issues and from nothing else. So
"unparented PR" named two populations with opposite verdicts.

Stage 3 splits them, with two adoption arms in the fold. Both join things already in the
pulse; neither invents a signal.

**Arm A — a job adopts its own PR, by branch.** A code job's branch is `job.branch` or,
when the operator supplied none, `job/<id>` — computed today in one expression inside
rule 0. Extracted as the pure `jobBranch(job)` and used by rule 0 _and_ the fold, so the
two cannot disagree about which branch a job's work lands on. A PR on that branch was
produced by that job: exact, 1:1 by construction, and the same shape as the issue arm's
`pr.branch === issueBranch(n)` match. Desk jobs have no branch and are excluded by
returning null, which is the same predicate rule 0 already applies.

**Arm B — a job is adopted by the issue its own PR names.** If the job's PR carries
`linkedPrNumber` back to an issue, a work item for that work already exists and somebody
already said so. The job is parented to it, giving `issue:12 → job:7 → pr:41`, and no
ticket is filed — the best possible outcome for a stage whose thesis is "do not add noise
to the tracker". This is the write-once rule's own intended case one level up: the stage-1
design allows a null parent to be "adopted later when `linkedPrNumber` appears".

After both arms, an unparented PR can only be a human's, and the harness leaves it alone.
That is the whole of the answer to this question: the fix for "is an unparented PR a
defect" is not a policy, it is making the category mean one thing.

### The one ordering decision

Arm A runs **before** the issue arm's `linkedPrNumber` match and after the part arm.
`parentRef` follows _work lineage_ — the stage-1 design says so explicitly, and it is why
stacking lives on `baseRef` instead of being folded in. A job's branch match is a
statement about what **caused** the PR; `linkedPrNumber` is a statement about what the PR
is **about**. When both are available, lineage wins and the aboutness is recovered one
level up by arm B, which produces the strictly more informative tree. A branch match for
an issue (`issue/<n>`) can never collide with `job/<id>`, so only the fuzzy arm is ever
displaced.

## What "missing a work item" means

A node is **unrecorded** when all of:

- it is a `job` node, and
- the job is a **code** job — a desk job touches no repository, so there is nothing about
  it a tracker item would record. This is the narrowing `detectFileOverlaps` already
  makes for the same reason ("code tasks only"), and it is what stops the recursion by
  construction: **a filing job is itself a desk job**, so filing can never generate work
  that wants filing.
- the job is `dispatched` — `queued` has done nothing yet and `cancelled` never will, so
  neither has anything to record.
- `parentRef` is still null after both adoption arms.

A node with a filing **in flight** stays in the reported set, carrying that filing's
status. Dropping it would make the click look like it did nothing, which is the same
reason `findings` has `filing` as well as `filed`. A node whose filing has _linked_ leaves
the set on its own and needs no special case: the link sets its parent, and a parented
node is not unrecorded.

Deliberately **not** in the list: "produced a PR". Requiring one would mean the harness
only offers to record work it can already see, which is circular — the invisible work is
precisely the work that left no PR behind. What the detector does instead is carry the
evidence alongside the verdict (how many PRs are under the node, when it was first seen),
so the operator's click is informed rather than blind. The predicate stays binary; the
judgement stays the human's.

Issues, plans, parts, concerns, assessments and PRs are never unrecorded. Every one of
them either descends from a tracker item or is one.

## Question 3: what the new root does once filed

The job node's `parentRef` is set to the new `issue:<n>`. Legal precisely because
`parent_ref` is **write-once once non-null** — null → set is the allowed transition, and
`recordWorkGraph`'s `COALESCE(work_nodes.parent_ref, excluded.parent_ref)` is what
enforces it. That same clause is why the fold may go on emitting `job` nodes with a null
parent forever without ever undoing an adoption.

**The fold writes it, not the route and not the tool.** `workGraphRecorder.ts` is the
graph's _only_ writer, and that is a property worth more than the shortcut of having
`link_ticket` reach into `work_nodes` directly. So the filing row is **intent** — the
same relationship `plans` and `plan_parts` have to the fold — and the fold reads it and
derives the edge, idempotently, like everything else it emits.

### The placeholder issue node

A filed ticket does not necessarily appear in the world. The issue provider lists open
items in one repository or project; a ticket filed and immediately closed, or filed into a
different project, is never fetched. If the fold set `job:7`'s parent to an `issue:314`
that has no row, the job would become **unreachable** — `listWorkRoots` filters on
`parent_ref IS NULL` and would not return it, and `listWorkSubtree('issue:314')` seeds
from a node that does not exist and returns nothing. The record would be worse than before
the click.

So a linked filing also emits its ticket ref as an `issue` node, **only when the world has
not already emitted one this pulse** — the same `seen`-set discipline the PR arms use, and
for the same reason: the world's reading is the real one and must not be clobbered by a
placeholder's empty title. Status `open`, not terminal, parent null. When the world does
know the issue, the next pulse overwrites title and status with the truth.

## Question 4: do `assess_issue` and `deliveryHold` need to reach `job:` refs?

**Settled: no. Stage 3 is purely about giving them an `issue:<n>` to reach.**

`deliveryHold` gates **pickup**, and nothing picks up a job. A job is dispatched once by
rule 0, is marked `dispatched`, and leaves the queue; there is no re-pickup loop, so there
is nothing for a hold to hold. The bug stage 2 exists to fix — an issue re-entering rule 4
after its PR merged — has no analogue on the job side.

`assess_issue` is fenced to `issue:<n>:assess` origins, and rule 3e is keyed on issues.
Widening either would mean a parallel assessment funnel for work with no re-pickup
problem, and a `job_deliveries` verdict gating nothing.

What stage 3 does give them is real, and it is the payoff: once `job:7` hangs under
`issue:314`, the issue is an ordinary issue. The assessor's prior-task condition still
answers from `ctx.tasks` by origin prefix, so it does not fire off the job's task — and
that is correct, not a gap. Nothing has been done _on that issue's origins_ yet; the issue
is a record of work already finished, and if the operator wants it worked they tag it.

### The interaction that must be stated

A filed ticket is a fresh open issue, and rule 4 picks up open issues. It does **not** get
picked up under the default configuration, because the issue watch gate is opt-in:
`labelPrefix` defaults to `lubbdubb` and an issue is left alone unless it carries
`lubbdubb-watch`. A newly filed ticket carries no tags, so nothing dispatches against it,
and if the operator adds the tag they are explicitly asking for the work.

The exception is `labelPrefix: ''`, which turns the watch gate off entirely (act on all).
On such a deployment a filed ticket **is** immediately eligible for pickup, and an agent
would be dispatched to redo work the job already did. This is stated rather than
mechanised: the escape hatch's documented meaning is "act on everything", a ticket is
something, and adding a filing-specific suppression would be a gate keyed on provenance
sitting nowhere near the rule it modifies — the shape refused three times already in this
tree. An operator running with the gate off and using filing should expect the ticket to
be worked, and the ticket's body says what was already done.

## The filing record

One fresh table, so no `Store.migrate()` entry.

```sql
CREATE TABLE IF NOT EXISTS work_item_filings (
  target_ref  TEXT PRIMARY KEY,   -- the unrecorded node ("job:job_abc")
  job_id      TEXT NOT NULL,      -- the desk job filing it
  status      TEXT NOT NULL,      -- filing | filed
  ticket_ref  TEXT,               -- "issue:314", once link_ticket lands
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

**Keyed on `target_ref`**, so one node has at most one filing and a second click on the
same node is refused by the write rather than by a caller remembering to look. Two
statuses for `findings`' reason, quoted because it transfers exactly: filing is
asynchronous, `filing` means "an agent is creating it", `filed` carries the ref, and
collapsing them would claim a ticket that does not exist yet and leave nothing to show for
a filing agent that died before making one.

### Why not a `findings` row

Reusing `findings` verbatim is the smaller diff and it is wrong, for the reason phase 1
gave for `proposals` against columns on `escalations`.

A `Finding` is **testimony**: `agent_id` and `task_id` are `NOT NULL` and its own doc
comment says a finding "always says truthfully who found it and what they were working
on". Attribution is structural, from a credential, and that is the property the whole
tool rests on. A harness-authored row has no agent and no task, so writing one means
forging the two columns that carry the guarantee — the exact lie structural identity
exists to make impossible. The filing _mechanism_ is reused in full (a desk job, the
`trackerCoordinates` supply, the overridable prompt, `link_ticket`); the row that means
"an agent testified" is not.

## The route

`POST /api/work/:ref/file`, under the guarded `/api` prefix like every other route —
`test/cockpitAuth.test.ts` walks the table and will require a refusal from it, and that
test is not edited. It sits on the `/api/work` prefix because a filing is about a work
node, not about a job's queue entry.

It mirrors `/api/findings/:id/file` step for step, and the mirroring is the point — the
two paths differ only in what they are filing _for_:

- 404 when the ref names no node; 409 when the node is not unrecorded (a desk job, a
  queued one, an already-parented one) and 409 when a filing already stands, both quoting
  which.
- 409 when `trackerCoordinates(config)` is null, with the same wording: there is nowhere
  to file, and the cockpit hides the button off the same `canFileTickets` predicate the
  snapshot already ships.
- Renders the prompt from the operator's template book — a new `work-item-ticket` entry
  beside `finding-ticket`, because the values differ (the node, its title, what ran under
  it, the tracker) even though the register does not.
- Creates a **desk** job, then writes the filing row — job first, so a failed create
  leaves the node unfiled.

`workItemTicketFields(node, subtree, tracker)` is pure and lives beside the detector, the
way `findingTicketFields` lives beside `parseFindingRef`: the wording an agent acts on is
testable without a server, and the route is left with `render` + `createJob`.

## `link_ticket` gains a second arm

The tool is unchanged in shape — it takes a ref and nothing else, and the target is
resolved from the credential. Today: agent → task → `job:<id>` → the finding that job was
created for. Stage 3 adds: → **or** the work-item filing that job was created for. A job
is created for at most one of the two, so there is no ambiguity to resolve, and an agent
on any other task still resolves to neither and is told so.

Idempotence stays in the write (`WHERE job_id = ? AND status = 'filing'`), not in a
read-then-check, which is the discipline `linkFindingTicket` already follows.

The ref is parsed by the existing `parseFindingRef` — the same closed vocabulary, the same
refusal of a bare number for the same reason (nothing in `link_ticket` says whether `314`
is an issue or a PR). A ticket that comes back as `pr:…` or `story:…` is accepted by the
parser and simply becomes that node's parent; the tracker decides what a ticket is, not
this route.

## The detector

`src/graph/unrecorded.ts`, pure: `unrecordedWork(nodes, filings) → UnrecordedWork[]`,
over the node list and the standing filings. It is a **lens** exactly as stages 1 and 2
are: nothing in `src/dispatcher/` reads it, nothing gates on it, and the only consumer is
the route that serves the cockpit.

`GET /api/work` gains `unrecorded` beside `roots` rather than taking a route of its own —
it is the same fetch-on-open the panel already makes, computed from rows it is already
reading.

It needs the whole node table, not the roots: the evidence carried beside each verdict is
what ran under the node. So `Store.listWorkNodes()` joins the three stage-1 read methods —
one `SELECT`, against the N+1 of rebuilding the table from roots and subtrees. It is a
fourth method where stage 1 argued for three, and it is worth naming that this
incidentally makes the **stage-1 backfill reach gap** closable, since that gap is
`WorkGraphRecorder.record` reconstructing `existing` the N+1 way. Stage 3 does **not**
close it — the recorder is untouched — because the operator ruled to leave it and that
ruling is theirs to revisit.

**The structural assertion is strengthened, never relaxed.** `test/workGraph.test.ts`
names the files under `src/` that may reference `graph/workGraph`, and stage 3 adds a
second graph module that would sit outside that check. So a **sibling** assertion is added
beside it — no file under `src/dispatcher/` may reference `graph/` at all — which covers
every module the directory will ever hold. The existing assertion stays byte-for-byte as
it is.

## Cockpit

`WorkTreePanel` gains an "Unrecorded work" section above the roots: the flagged nodes,
what ran under each, and a **File a work item** button when `canFileTickets` is true. A
node with a filing in flight shows that instead of the button, so the asynchrony is
visible rather than looking like a click that did nothing.

Nothing else moves. The panel stays fetch-on-open and stays a lens.

## Testing

`test/workGraphRoots.test.ts`, at the `buildSystem(config, opts)` seam.

- **The headline.** A code job runs, opens a PR on its branch, the PR merges and ages out
  of the world. Assert the job is reported unrecorded, that filing it and linking a ticket
  parents it to `issue:<n>`, and that the whole tree — job, PR, merge provenance — is
  reachable from that issue afterwards.
- Arm A: a PR on a job's branch is parented to the job, including the derived
  `job/<id>` case with no operator-supplied branch.
- Arm B: a job whose PR links an issue is adopted by it, and is **not** reported
  unrecorded — the no-ticket-needed case.
- Ordering: with both a job branch match and an issue `linkedPrNumber`, the PR's parent is
  the job and the job's parent is the issue.
- The narrowings, one assertion each: a desk job, a queued job, a cancelled job and an
  already-parented job are all not unrecorded.
- Adoption is write-once: a second filing cannot re-parent an adopted job.
- The placeholder: a ticket the world never lists still leaves the job reachable from it,
  and a ticket the world does list keeps the world's title.
- The route: 404 unknown ref, 409 not-unrecorded, 409 already filing, 409 no tracker
  configured, and the happy path creating a desk job.
- `link_ticket` from a filing job links; from an unrelated job it is refused naming both
  reasons; the finding arm is unchanged.
- **Structural**: the existing assertion untouched, plus the new sibling.

`npm run check` must pass: both typecheck passes, knip with no unused exports, Prettier,
and the suite.

## Out of scope, stated

- **Filing for anything other than a job.** Unparented PRs are settled above as not
  defects; issues, plans and parts already have work items by construction.
- **Any autonomous outbound act.** No rule files anything. `autoSend` is untouched and
  gains no new authorizable kind.
- **Closing or updating a filed ticket.** The harness creates it and links it. Everything
  after that is the tracker's and the human's, which is the same line stages 1 and 2 drew.
- **Retiring `Story`.** Still a real simplification and still a separate change.
- **The stage-1 backfill reach gap.** Ruled on, left, and written up in
  `docs/spec/14-persistence.md`. Stage 3 does not touch it: adoption is derived from rows
  the fold already reads, so it needs no wider view of `existing` than stage 1 built.
