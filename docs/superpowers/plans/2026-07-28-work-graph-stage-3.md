# Work graph stage 3 — roots for everything, task by task

**Spec:** [`../specs/2026-07-28-work-graph-stage-3-roots-design.md`](../specs/2026-07-28-work-graph-stage-3-roots-design.md)
**Stage 1:** shipped in PR #150. **Stage 2:** shipped in PR #151 (merge commit `66795c1`).

Eight tasks, in order. Each ends with `npm run check` green and its own commit — knip
runs every rule at `error`, so a task that adds an export must add its consumer in the
same task (a test counts: `includeEntryExports` holds test files to the same standard).
Do not batch or reorder.

## Signatures verified against the tree

Read out of the source at plan time, because stage 1's plan invented three APIs and stage
2's plan avoided all of it by writing this table first.

| Thing                      | Actual                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| rule 0's branch expression | `job.kind === 'code' ? (job.branch ?? \`job/${job.id}\`) : null`—`ruleDispatcher.ts:180`, one site     |
| `Job`                      | `{id, title, prompt, kind: TaskKind, branch: string \| null, status, taskId, createdAt, updatedAt}`    |
| `JobStatus`                | `'queued' \| 'dispatched' \| 'cancelled'` — **not exported** (`types.ts:273`)                          |
| `Store.listJobs`           | `(limit = 100) => Job[]` — the recorder calls it with no argument                                      |
| `Store.createJob`          | `({title, prompt, kind, branch?}) => Job`                                                              |
| `Store.recordWorkGraph`    | `(observations: WorkNodeObservation[]) => void`; parent is `COALESCE(existing, excluded)`              |
| `Store.listWorkRoots`      | `() => WorkNode[]` — `WHERE parent_ref IS NULL`                                                        |
| `Store.listWorkSubtree`    | `(rootRef: string) => WorkNode[]` — recursive CTE, seeds from `WHERE ref = ?`                          |
| `WorkNodeObservation`      | `{ref, kind, parentRef?, baseRef?, title, status, terminal, provenance?}`                              |
| `WorkNodeKind`             | `issue \| plan \| part \| pr \| concern \| job \| assess` — **no new kind needed**                     |
| `foldWorkGraph`            | `(input: WorkGraphInput) => WorkNodeObservation[]`; `WorkGraphInput` is exported                       |
| `Store.resolveFinding`     | `(id, status: Exclude<FindingStatus,'open'\|'filed'>, jobId = null) => Finding \| null`                |
| `Store.findFindingByJobId` | `(jobId: string) => Finding \| null`                                                                   |
| `Store.linkFindingTicket`  | `(id, ticketRef) => Finding \| null` — guarded `WHERE id=? AND status='filing'`                        |
| `AgentManager.linkTicket`  | `(agentId, ticketRef) => {ok:true, finding} \| {ok:false, error}` (`agentManager.ts:396`)              |
| `parseFindingRef`          | `(ref: unknown) => {ok:true, ref: string \| null} \| {ok:false, error}` (`mcp/findings.ts:75`)         |
| `trackerCoordinates`       | `(config: Config) => string \| null` (`mcp/findings.ts:158`)                                           |
| `findingTicketFields`      | `(finding, tracker) => {title, vars: Record<string,string>}` — the shape to mirror                     |
| `PromptTemplates.render`   | `(id: PromptId, vars: Record<string, string \| number \| undefined>) => string`                        |
| prompt registry entry      | `{placeholders: string[], template: string, doc: string}`; `PromptId` union at `promptTemplates.ts:41` |
| `System.prompts`           | `PromptTemplates` — hoisted in `system.ts`, available to routes                                        |
| `buildApp`                 | `buildApp(system)` — one arg, config off `system.config`                                               |
| `WORK_RATE_LIMIT`          | `{config: {rateLimit: {max: 120, timeWindow: '1 minute'}}}` — `app.ts:789`, reuse it                   |
| `connector.resolveRefUrl`  | synchronous, non-optional                                                                              |
| `issueBranch`              | `(n: number) => string` — exported from `dispatcher/issuePickup.ts`, already imported by the fold      |
| web `WorkNodeView`         | mirrors `WorkNode` field for field (`web/src/types.ts:209`)                                            |
| `api.getWorkRoots`         | `() => Promise<{roots: WorkNodeView[]}>` (`web/src/api.ts:91`) — the shape that gains `unrecorded`     |
| structural assertion       | `test/workGraph.test.ts:494` — filters `src/` files containing the string `graph/workGraph`            |

Repo facts that still apply: ESM with explicit `.js` extensions on every relative import;
`src/store/store.ts` is the only file touching SQLite; `Store` migrates in its constructor
and `migrate()` is private; a fresh `CREATE TABLE` needs no `migrate()` entry; tests close
with `system.store.close()`; route tests opt out of auth with
`auth: { enabled: false } as never`; the fake connector has no `pr_merged` event (a merge
is `pr_closed` with `merged: true`, which moves the row into `closedPullRequests` and never
expires it — `FakeWorldStore` is how a test ages it out); a cycle that matches nothing
still records a `no_op`, so assert on the absence of a _dispatch_, not an empty action list.

---

## Task 1 — adoption: a job owns its PR, and its PR's issue owns the job

**Goal.** The two fold arms that make "unparented PR" mean one thing. No new table, no
route, no tracker contact — this task alone already shrinks the flagged set.

**Files.** `src/jobs.ts` (new), `src/dispatcher/ruleDispatcher.ts`,
`src/graph/workGraph.ts`, `test/workGraphRoots.test.ts` (new).

- `jobBranch(job: Job): string | null` in `src/jobs.ts`, beside the other top-level pure
  predicate modules (`fileOverlap.ts`, `issueConclusion.ts`, `watchLabels.ts`). It is
  rule 0's expression, moved: `job.kind === 'code' ? (job.branch ?? \`job/${job.id}\`) : null`.
  Rule 0 calls it. Two call sites, one predicate — the discipline the jobs 409/defer pair
  and the proposals hold both use.
- Arm A in `foldWorkGraph`: fill `prParent` from jobs by branch, **after** the part loop
  and **before** the issue loop. A desk job returns null and is skipped.
- Arm B: a job whose PR carries an issue's `linkedPrNumber` is emitted with
  `parentRef: issueOrigin(n)`. Read the link from `input.world.issues`, the same list the
  issue arm already walks.
- Comment the ordering decision where it happens — lineage beats aboutness, and arm B is
  what recovers the aboutness one level up.

**Test.** Arm A with an operator-supplied branch and with the derived `job/<id>`; arm B;
the ordering case (both signals → `issue → job → pr`); a desk job adopts nothing; the
adoption is write-once across two folds.

**Watch for.** `graph/workGraph.ts` importing `../jobs.js` is fine; `src/jobs.ts` must not
import from `src/graph/` or the new structural sibling in task 8 fails.

---

## Task 2 — the filing record

**Goal.** The store can open a filing, list them, find one by job, and settle it.

**Files.** `src/types.ts`, `src/store/schema.ts`, `src/store/store.ts`,
`test/workGraphRoots.test.ts`.

- `WorkItemFiling` + `WorkItemFilingStatus = 'filing' | 'filed'` in `src/types.ts`.
- Schema per the spec, keyed on `target_ref`. Fresh table → **no `migrate()` entry**.
- `Store.createWorkItemFiling({targetRef, jobId})` — insert; returns null when a row
  already stands for that target, so a second click is refused by the write.
- `Store.listWorkItemFilings()`, `Store.findWorkItemFilingByJobId(jobId)`.
- `Store.linkWorkItemFiling(jobId, ticketRef)` — guarded
  `WHERE job_id=? AND status='filing'`, returning null when nothing changed. Idempotence
  in the write, mirroring `linkFindingTicket` exactly.
- `Store.listWorkNodes()` — the whole table, one `SELECT`, for task 3's detector. **Do not
  change `WorkGraphRecorder.record` to use it**: that would close the stage-1 backfill
  reach gap, which the operator ruled to leave.

**Test.** Create then create again for the same target returns null; link settles it and
carries the ref; linking twice links once; `findWorkItemFilingByJobId` misses cleanly.

---

## Task 3 — the detector and the wording

**Goal.** The harness can say which work has no work item, and how to ask for one.

**Files.** `src/graph/unrecorded.ts` (new), `src/dispatcher/promptTemplates.ts`,
`test/workGraphRoots.test.ts`.

- `unrecordedWork(nodes: WorkNode[], jobs: Job[], filings: WorkItemFiling[]) => UnrecordedWork[]`.
  `UnrecordedWork` is **not exported** (knip: a type naming an exported function's return
  stays usable by callers unexported).
- The predicate, per the spec: `kind === 'job'`, `parentRef === null`, and the joined job
  is `kind: 'code'` with `status: 'dispatched'`. A node with a filing in flight stays in
  the set, carrying `filing: 'filing'`.
- **`Job[]` is a parameter rather than something read off the node** because the fold
  records a job's `status` and not its `kind`, and smuggling code-vs-desk through a display
  field to save a join would make the node lie about what `status` means. The join is one
  map. Consequence, stated: `Store.listJobs()` is capped at 100, so a job older than that
  drops out of the flagged set — the same window the fold itself already lives in, since
  the recorder calls `listJobs()` with no argument too.
- `workItemTicketFields(node, subtree, tracker) => {title, vars}`, mirroring
  `findingTicketFields`: `title` is the _job's_ title (recognisable in Up next), and the
  vars carry the node ref, its title, what ran beneath it and the tracker.
- Prompt template `work-item-ticket` in the registry beside `finding-ticket`, with a `doc`
  saying it is overridable and what the placeholders are. It must tell the agent to search
  for an existing item first, to describe work **already done** (not to do it), and to
  finish with `link_ticket`.

**Test.** Each narrowing separately (desk / queued / cancelled / parented → not flagged); a
dispatched parentless code job is flagged; an in-flight filing keeps it flagged with the
status; the rendered prompt names the tracker and the ref.

---

## Task 4 — the fold learns the parent

**Goal.** A linked filing adopts its node, durably, written by the recorder and nobody else.

**Files.** `src/graph/workGraph.ts`, `src/graph/workGraphRecorder.ts`,
`test/workGraphRoots.test.ts`.

- `WorkGraphInput` gains `filings: WorkItemFiling[]`; the recorder passes
  `store.listWorkItemFilings()`.
- For each filing with a `ticketRef`: emit the target node with `parentRef: ticketRef`.
  When the target is not otherwise emitted this pulse (its job aged past `listJobs`'
  window), re-emit it from `input.existing` verbatim with the parent set — `existing` is
  already in the input for "observed beats inferred" and needs no widening.
- Emit a placeholder `issue` node for the ticket ref **only when the world has not already
  emitted one this pulse**, tracked with a `seen` set the way the PR arms do. Status
  `open`, not terminal, parent null.

**Test.** A linked filing parents the job; the placeholder keeps the job reachable when the
world never lists the ticket; the world's own issue row wins the title when it does; a
second filing cannot re-parent (write-once).

---

## Task 5 — the route

**Goal.** The operator can see the gap and close it in one click.

**Files.** `src/server/app.ts`, `test/workGraphRoots.test.ts`.

- `GET /api/work` gains `unrecorded`, from `listWorkNodes` + `listJobs` + `listWorkItemFilings`.
- `POST /api/work/:ref/file`, reusing `WORK_RATE_LIMIT`. Mirrors
  `/api/findings/:id/file` step for step: 404 unknown ref; 409 not unrecorded (naming
  why); 409 filing already standing; 409 when `trackerCoordinates` is null with the same
  wording; render `work-item-ticket`; `createJob({kind: 'desk'})` **then**
  `createWorkItemFiling` (job first, so a failed create leaves the node unfiled);
  `hub.broadcast`; `await harness.runCycle('manual')`.

**Watch for.** A ref carries colons, and `/api/work/:ref` already proves Fastify survives
one in a path segment — keep the same shape. Under the guarded `/api` prefix, so
**`test/cockpitAuth.test.ts` is not edited**; it walks the route table and covers the new
route the day it is written.

---

## Task 6 — `link_ticket`'s second arm

**Goal.** A filing agent can settle a work-item filing, not just a finding.

**Files.** `src/agents/agentManager.ts`, `test/workGraphRoots.test.ts`.

- `linkTicket` resolves the job id from the origin as it does now, then tries the finding
  and, failing that, the work-item filing. Refuse naming both possibilities.
- Parse the ref with the existing `parseFindingRef` — same vocabulary, same refusal of a
  bare number.
- Emit the existing `finding` event only on the finding arm; the filing arm broadcasts
  through the ordinary `dirty` path (the panel is fetch-on-open, so there is nothing to
  repaint live).

**Test.** A filing job's agent links and the node is parented on the next pulse; an agent
on an unrelated job is refused; the finding arm is unchanged.

**Watch for.** `test/findingTickets.test.ts` covers the finding arm and is **not edited**.

---

## Task 7 — the cockpit

**Goal.** The gap is visible where the graph already is.

**Files.** `web/src/types.ts`, `web/src/api.ts`, `web/src/components/WorkTreePanel.tsx`.

- `UnrecordedWorkView` in `web/src/types.ts`; `getWorkRoots`'s return type gains
  `unrecorded`; `api.fileWorkItem(ref)`.
- An "Unrecorded work" section above the roots, with a **File a work item** button gated
  on `canFileTickets` from the snapshot — the same predicate the route refuses on, so the
  button never offers what the route declines. A node with a filing in flight shows that
  instead of the button.

**Watch for.** `typecheck:web` is a separate pass from `typecheck`; this task spans both.

---

## Task 8 — the structural sibling, and the docs

**Goal.** The property that carried stages 1 and 2 is asserted for every module
`src/graph/` will ever hold, and the specs describe what shipped.

**Files.** `test/workGraph.test.ts` (**add only**), `docs/spec/`, `CLAUDE.md`.

- A **new** assertion beside the existing one: no file under `src/dispatcher/` contains the
  string `graph/`. Strictly stronger, and it covers `unrecorded.ts` and whatever comes
  next. **The existing assertion stays byte-for-byte** — it is not relaxed, replaced or
  reworded.
- `docs/spec/`: the persistence document gains `work_item_filings`; the dispatcher document
  needs nothing (no rule changed); find the one that owns the route list and the graph.
- `CLAUDE.md`: extend the `src/graph/` bullet with stage 3 — the two adoption arms and the
  ordering, why filing is an operator click and not a rule, why a filing is not a
  `findings` row, and the `labelPrefix: ''` consequence stated in the spec.

---

## Then

`npm run check`, then push to `claude/work-graph-stage-3-2ejopu` and open the PR as ready
for review. Call out in the body: the new `Store.listWorkNodes()` makes the stage-1
backfill reach gap closable and stage 3 deliberately does not close it.
