# Raising a bug against a story

Design — 2026-08-11.

## The gap

An operator looking at a story the harness believes is finished has no way to say **"this shipped,
and it does not work how I expect."** The two verdict buttons on the row are both about the story's
own completeness — `finished` and `more work` — and neither carries a word of what is actually
wrong. `more work` in particular writes the fixed note `Set by the operator from the cockpit.`, so
the agent it bounces the story back to is told only that something is unfinished, not what.

Worse, the operator's observation is the one thing no agent can derive. The assayer read the ticket,
the planner read the repository, the working agent read its own diff — none of them ran the feature
and formed an expectation about it. That knowledge exists only in the operator's head, and the
cockpit has nowhere to put it.

This adds a **`raise issue`** button to the story row. The operator types the symptom; a desk agent
turns it into a Bug in the tracker, linked back to the story.

## What it is not

It is **not** a second route to re-opening the story. The story keeps whatever verdict it has; the
Bug is its own work item, picked up on a later cycle like any other. That split is deliberate: the
story was delivered as specified, and the bug is new work with its own repro. It is also the only
arrangement in which the fleet gets the operator's actual words as the goal — a `more_work` verdict
on the story would hand the next agent the weaker of the two briefs.

It is also **not** a relationship model. The harness has no notion of work-item-to-work-item links
today — `mapWorkItem` in `src/integrations/azure/restAzureDevOpsApi.ts` keeps only `ArtifactLink`
relations and `linkedPrFromRelations` narrows those to the resolving PR — and designing one is
[#267](https://github.com/AdamAwan/LubbDubb/issues/267), deliberately out of scope here. The filing
row below records **whether the job the operator asked for completed**, which is what
`work_item_filings` and the findings table already record, and neither of those is a relationship
model either. When #267 lands, the story row may gain a richer live link; this row remains the
record of the filing.

## Shape: the third instance of an existing pattern

Two routes already do exactly this, and this is the third:

| | trigger | job prompt | completed by |
|---|---|---|---|
| `/api/findings/:id/file` | an agent's finding | `finding-ticket` | `link_ticket` |
| `/api/work/:ref/file` | unrecorded work in the graph | `work-item-ticket` | `link_ticket` |
| `/api/issues/:number/bug` | **the operator's own report** | **`raise-bug`** | `link_ticket` |

Operator click → desk job rendered from an overridable template → the agent shells out to `az` in
its own shell → the agent calls `link_ticket` → the filing row flips `filing` → `filed`.

The harness never creates the ticket through the provider seam, and this change does not add
`createWorkItem` to `AzureDevOpsApi`. The argument is already written down in `src/mcp/findings.ts`:
the *wording* of a ticket is the part an operator has opinions about, and a prompt is where those
opinions live. What the harness must supply is the one thing an agent cannot infer — **which**
tracker, since a desk job runs in a scratch directory with no git remote to read coordinates off.

## The route

`POST /api/issues/:number/bug`, in `src/server/routes/issues.ts` — the module that owns the issue
group. Body:

```
{ summary: string (required, non-empty), title?: string }
```

`summary` is the operator's report and is the whole point of the feature, so it is required; an
empty body asks for nothing. `title` overrides the derived job title, matching the override
`TicketTitleBody` already offers on the other two filing routes.

Refusals, in this order:

1. **404** when the issue is not in the last world snapshot. The assay route's check, for its
   reason: an override on an issue the harness has never seen would be a silent no-op dressed as an
   action.
2. **409** when `trackerCoordinates` is null — the `fake` provider, or an unconfigured one. The
   cockpit hides the button in that case, so reaching here means a direct call.

Then, in the order `/api/findings/:id/file` uses so a failed create leaves nothing behind: render
the template, `createJob({ kind: 'desk' })`, `createBugFiling`, broadcast `world:changed`, and
`runCycle('manual')` — the operator's report should reach the fleet now, not on the next heartbeat.

Desk, not code: filing touches no repository, so a worktree and a branch would be cut for a task
that never writes a file.

## The prompt template — `raise-bug`

A new id in `src/dispatcher/promptTemplates.ts`, placeholders `{number} {title} {summary}
{tracker}`. It tells the agent, in this order: this is the **operator's own report**, quote it
verbatim; search the open items for a duplicate before creating anything; verify what you can
against the repository and say in the body which parts you confirmed and which are the operator's
word; create the Bug; add a **Related** link both ways to the story; then call `link_ticket` with
the new item's ref, because that call is what completes the filing.

The template says `Bug` literally. A project on the Basic process template calls that type `Issue`,
and the fix there is a template override — which is what overrides are for.

## Ticket fields — `src/bugFiling.ts`

A new pure module, in the same register as `src/blueprintTicket.ts`:

- `bugTicketFields(issue, summary, tracker)` → `{ title, vars }`. The title is the **job's**, not the
  ticket's — the agent writes the ticket's title, since that is the judgement being delegated, and
  this one only has to be recognisable in the Up next queue.
- `bugTrackerCoordinates(config, storyNumber)` → `string | null`. The existing
  `trackerCoordinates` hardcodes `--type Task` and knows nothing about relations, so the bug variant
  supplies `az boards work-item create --type Bug …` plus the follow-up
  `az boards work-item relation add --relation-type related --target-id <story>`. Its two existing
  callers are untouched.

Pure over its arguments, so the wording an agent acts on is testable without a server and the route
is left with nothing but `render` + `createJob`.

### Why a Related link and not parent/child

`related` is legal whatever process template the project uses, shows on both items, and changes
neither item's rollup or board position. A parent link from a User Story to a Bug is only valid when
the project manages bugs at the task level; where it is not, `az` refuses the relation outright and
the filing agent is left holding an unlinked bug. The stronger semantics are not worth a link that
fails on an unknown fraction of deployments.

## Persistence — `issue_bug_filings`

A new module `src/store/bugFilings.ts` owning one new table. Because the table is brand new it needs
no `ColumnMigrations` entry; `CREATE TABLE IF NOT EXISTS` is the whole migration.

```sql
CREATE TABLE IF NOT EXISTS issue_bug_filings (
  job_id     TEXT PRIMARY KEY,
  origin_ref TEXT NOT NULL,          -- issue:<n>, the story it was raised from
  status     TEXT NOT NULL,          -- filing | filed
  ticket_ref TEXT,                   -- issue:<n>, once the agent reports it
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

**Keyed by `job_id`, not by the story.** That is the one structural difference from
`work_item_filings`, which is keyed `target_ref PRIMARY KEY` so a node has at most one filing ever.
A story can be wrong in several ways over its life, and each is its own bug — refusing the second
would be a rule nobody asked for. `origin_ref` is indexed instead, and the cockpit groups by it.

Methods, following the module's neighbours: `createBugFiling`, `listBugFilings`,
`findBugFilingByJobId`, and `linkBugFiling(jobId, ticketRef)` guarded in the write
(`WHERE job_id=? AND status='filing'`) so an agent that calls `link_ticket` twice links once.

The operator's `summary` is **not** stored. The job's prompt already carries it verbatim and is
durable; a second copy would be two records of one sentence, free to drift.

## `link_ticket` grows a third arm

`AgentManager.linkTicket` resolves the filing from the agent's credential — agent → task → its
`job:<id>` origin → the row that job was created for. It knows two kinds today; this adds a third,
resolved the same way, so the tool still takes only a ref and an agent on any other task still has
nothing to point at. The refusal message gains the third case.

The ref must be an `issue:` ref, the check `work_item_filings` already applies: a work item is an
issue in both trackers the harness reads.

## Cockpit

A `raise issue` button on the issue row in `web/src/components/WorldSummary.tsx`, beside `finished`
and `more work`, gated on `state.config.canFileTickets` — the flag that already hides the other two
filing buttons when no real tracker is configured.

Unlike its two neighbours it is **not** gated on `i.state === 'open'`. Raising a bug against a story
the harness has already closed is the case the whole feature exists for.

Clicking opens a small modal (following `ScratchpadModal`) with a required textarea for the symptom
and an optional ticket title. A chip on the row reads `raising bug…` while the job runs, and
`→ Bug #456` once `link_ticket` reports back, resolved through the same `refUrls` lookup every other
ref chip uses.

`bugFilings` reaches the cockpit on the snapshot through `src/wire.ts`, as a wire type that **is**
the domain type.

## Tests

At the `buildSystem` seam, in a new `test/raiseBug.test.ts`:

- the route creates a **desk** job whose prompt carries the operator's words verbatim and the story
  number;
- `link_ticket` from that job's agent flips the filing `filing` → `filed` and records the ref;
- a second raise on the same story opens a **second** filing (the repeatability the key choice buys);
- no tracker configured → 409, and the route creates no job;
- a `link_ticket` ref that is not an `issue:` ref is refused.

Plus a pure unit test for `bugTicketFields` and `bugTrackerCoordinates`, asserting the rendered
coordinates name the story in the relation command.

## Specs to update in the same change

Per the repo's one documentation rule, five documents own a piece of this:

- **16** (HTTP API) — the new route, its body and its refusals.
- **13** (jobs and findings) — the third filing kind.
- **14** (persistence) — the new table and why it is keyed by job id.
- **17** (cockpit) — the button, the modal and the chip.
- **11** (MCP tools) — `link_ticket`'s third arm.
