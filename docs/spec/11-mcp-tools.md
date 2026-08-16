# 11 — The MCP tool channel

`src/mcp/`. Every spawned agent is wired to a tools-only MCP server running **inside the harness**.
**Unconditional** — there is no key to turn it off. It is purely additive: it adds tools an agent may
use and changes nothing about how one is dispatched, parked or finished, and a socket that fails to
bind already degrades to the floor below, which is the only thing an off-switch ever bought.

The channel exists because the sentinels and the file-events hook are both **fire-and-forget**. An
agent can announce, but never receive a value back, never learn that what it sent was rejected, and
never ask a question. `plan.json` is the proof: a structured payload smuggled through an
artifact-detection hook, whose validation failure the planner never hears, costing a whole agent to
discover what a synchronous error would have said in one turn.

## The tools

`src/mcp/names.ts` lists them, a module under `src/mcp/tools/` defines each, and `src/mcp/tools.ts`
assembles them (see [How a tool is built](#how-a-tool-is-built)).

| Tool                 | Purpose                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan_submit`        | Submit a decomposition verdict. Replaces writing `.lubbdubb/plan.json`.                                                                                                                                                                                                                                                 |
| `escalate`           | Ask the human a question and park. The typed form of the WAITING sentinel.                                                                                                                                                                                                                                              |
| `world_read`         | Read the harness's own view of a PR or issue.                                                                                                                                                                                                                                                                           |
| `report_finding`     | File something noticed outside the agent's own task.                                                                                                                                                                                                                                                                    |
| `request_human_task` | Ask for work only a person can do. Files a durable work item, parks nobody, dispatches nobody.                                                                                                                                                                                                                          |
| `note_progress`      | Say in one line what the agent is working on right now.                                                                                                                                                                                                                                                                 |
| `link_ticket`        | Report the tracker item a filing agent created, closing the loop on a filed finding, a filed work item, or a bug an operator raised.                                                                                                                                                                                    |
| `conclude_work`      | Say whether the **issue** the agent was dispatched for is finished. The only thing that concludes a ticket in the harness's view.                                                                                                                                                                                       |
| `assay_issue`        | The gate in front of the work: say whether the issue an assayer was dispatched to judge has a goal that can be worked from. Fenced to `issue:<n>:assay` origins.                                                                                                                                                        |
| `assess_issue`       | The second look: say whether the issue an assessor was dispatched to judge is actually delivered. Fenced to `issue:<n>:assess` origins.                                                                                                                                                                                 |
| `conclude_part`      | Close **one plan part** that finished without a pull request — a report, or the determination that nothing needs building. Fenced to `issue:<n>:part:<slug>` origins.                                                                                                                                                   |
| `scratch_append`     | Leave a note on the shared scratchpad for the issue this agent is working. Append-only, attributed from the credential. Refused outside an issue subtree.                                                                                                                                                               |
| `scratch_read`       | Read that pad — every note left by every agent on the goal, oldest first. Same access rule as the write. The operator reads the same trail in the cockpit's notepad modal (`GET /api/scratchpads/:ref`), which resolves a ref through the same `padOriginFor`.                                                          |
| `retro_submit`       | Submit the retrospective for a delivered goal: what shipped, and how the run went. Fenced to `issue:<n>:retro` origins.                                                                                                                                                                                                 |
| `validation_amend`   | Correct the validation plan for the goal this agent is working: add or amend checks, withdraw one with a reason, declare a resource. **Merge-only** — an omitted check is untouched. Open to every agent on the goal; refused to the planner, which has `plan_submit`. → [20](20-validation.md)                         |
| `validation_report`  | Record the reading of the one validation check this agent was dispatched to run: `passed`, `failed`, or `handback` — could not run it, which records nothing and returns the check to the operator with the reason. Refused to every caller but that check's own agent, by name. → [20](20-validation.md#the-hand-over) |
| `request_permission` | Harness-internal (issue #130). Claude Code calls it via `--permission-prompt-tool` to route an un-allowlisted tool call to the operator. The one tool an agent never calls itself, and the one whose response is **bare** (no `_status`).                                                                               |

There is a **second, much shorter list** for the desktop channel below — three tools, none of them
the fleet's. See [The desktop channel](#the-desktop-channel).

### The `_status` envelope

**Every** tool response carries `_status` — _except_ `request_permission`, whose response is the bare
`{behavior, …}` verdict Claude's permission parser expects. The envelope is what removes the need for
a polling tool: an agent
that calls anything at all learns its origin, whether a human is currently parked on it, and how its
plan is progressing.

```ts
{
  origin: string | null,
  task: { title, status },
  awaitingHuman: { prompt } | null,
  plan?: { status, parts: { slug, status }[] }   // present when the agent's issue has a plan
}
```

### `plan_submit`

Arguments `{parts, reason, validation?}` plus the narrative fields. At least one part is required — work that is one pull request is a one-part plan, not a shape of its own.
Refused unless the caller's origin is a planning origin (`planOriginIssue(task.originRef)`). Validated
with the **same** `PlanDocumentSchema` the file path uses; on rejection the reason is returned and
**nothing is written**, so the caller retries against an unchanged plan graph. On success it routes
through the shared `ingestPlanDocument`, and reports `{accepted, status, retired}`.

**Every field of the document is on the schema, and the handler passes each one through.** The
handler builds the document field by field rather than forwarding `args`, which is what keeps the
version literal and the origin out of the agent's hands — and it is why a field added to
`PlanDocumentSchema` and to the prompt but not to _both_ halves of this module is invisible. That is
the shape the `validation` block was in: the prompt taught it, the file path accepted it, the tool
advertised no such property and dropped one sent anyway — so every plan submitted the way the prompt
tells a planner to submit one landed with no checks, and an absent block is a legal document
(`ingestPlanDocument` reads absence as "leave the existing checks alone") that nothing reports.
`validation` is passed through **undefined-preserving** for that reason: an empty block is a planner
withdrawing every check, which is not what silence means. → [20](20-validation.md#the-document-block)

### `escalate`

Arguments `{question, kind?: 'approve'|'choose'|'clarify'|'review', options?, detail?, questions?}`.
Routes through `AgentManager.ask` → the same `handleWaiting` the WAITING sentinel drives, so the whitelist, the drain
and the store writes cannot diverge between the two. Whichever detector fires first owns the park; the
`parked` latch makes the second a no-op. An agent that calls `escalate` **and** prints the sentinel
raises one escalation, not two.

Returns `{parked, escalationId, note}`. An `escalationId` of `null` means an operator whitelist rule
auto-answered it and the agent was never parked — said explicitly, rather than implying a human saw it.

`questions` is how an agent asks for several things at once: a list of `{question, detail?, options?}`,
each rendered as its own card with its own answer box, all answered in one reply. `question` stays the
headline — the line the inbox row shows — and the list is what sits behind it. Without it an agent with
three things to settle had one box, so it wrote all three into `detail` and spent `options` on "which
shall we start with?", paying a round trip per question. Capped at ten in the handler rather than
trusted from the schema's `maxItems`, which is advice to a model; a malformed entry is dropped rather
than failing the call, and the return value carries `questionsFiled` so the agent can see how many
landed. The answers come back as one numbered message with each question restated and the ones left
blank marked as unanswered — see [16](16-http-api.md#post-apiescalationsidanswer) for the fold and
[17](17-cockpit.md) for the modal.

`detail` is **markdown**, and the card renders it as such. This one is a description, not a
validation: unlike `report_finding.summary` there is no one-line invariant to hold, and `question` is
already the short field. Terminal output the harness captured stays preformatted — see
[17](17-cockpit.md#agent-authored-prose).

### `world_read`

Arguments `{kind: 'pr'|'issue', ref?}`. Closes the `gh`-shell-out gap: an agent that needed a
PR's CI status or review comments had to shell out, which is provider-coupled (nothing works under
`azure`) and re-fetches what the pulse already holds.

- **The source is `Store.getWorldBaseline()`** — exactly what `Harness.recordWorldChanges` persists
  each pulse. No provider fan-out per agent, no provider-shaped payload, and the agent sees the world
  the dispatch decision was made against. It is a pulse-old reading and says so (`observedAt`). Before
  the first cycle it errors informatively rather than throwing. **This must never be routed to a
  connector** — that coupling is what the tool exists to remove.
- **Same verdicts as the cockpit, from the same functions**: `prHealth`, `basePrOf`,
  `inheritedCiFailure`, over the **unfiltered** open list so an `-ignore`d base still attributes. An
  agent told `CI failing on base PR #7` and an operator reading the same phrase are reading one fact.
- **A closed PR is still readable** — "did the PR my branch is stacked on actually merge, or was it
  abandoned?" is exactly the question the closed-PR window answers.
- **An issue additionally carries its plan graph and its work subtree**, both of which live only in
  the store. The subtree is what the world cannot supply: `closedPullRequests` is bounded by
  `closedPrWindowMs` (6h), so a PR that delivered the issue last week is simply absent from the
  snapshot and the edge to it is in the graph or nowhere. Each node carries its `provenance`, so a
  reader can weigh "the harness watched this merge" (`observed`) against "it left the open list and
  the merge was assumed" (`inferred`) — rule `issue-assess`'s agent is the reader stage 1 recorded that
  distinction for. The lookup is `Store.listWorkSubtree`, in the tool layer rather than in the pure
  `worldRead.ts`, and nothing here imports the fold, so the dispatcher-side lens property in
  [`14-persistence.md`](14-persistence.md) is untouched.
- **`ref` is suffix-tolerant, kind-strict.** `pr:42:ci`, `issue:12:part:schema` and `issue:12:plan` all
  name their world item, so the origin ref from `_status.origin` passes back verbatim; bare `42` and
  `#42` work too. Omitting `ref` defaults to the caller's own origin. A prefix that contradicts `kind`
  is an **error**, not a guess. A miss lists the refs the harness is tracking (up to 20), so discovery
  needs no second mode.

`world_read` is **deliberately a general read, not confined to the caller's origin**, and
`test/mcpChannel.test.ts` says so. The dispatcher's own reasoning is cross-item, so an agent's is too:
a stacked PR's red CI belongs to the PR underneath it, a part's context is its siblings, a PR-fix agent
wants the issue it resolves. Fencing it would send an agent that was just told "CI failing on base PR
#7" straight back to `gh`. What structural identity protects is **writes**; a read forges nothing and
mutates nothing, and the cockpit already serves this same snapshot unauthenticated over HTTP while
this path needs a 0600 bearer token. What _is_ kept: an agent can only name items the harness already
holds, in the harness's own vocabulary — no query, no provider passthrough, no path or URL argument,
so it cannot reach another repository or project.

### `report_finding`

Arguments `{kind: 'duplicate'|'blocked'|'out_of_scope', summary, where?, detail?, ref?}`. See
[13](13-jobs-and-findings.md) for the full vocabulary and the promotion path. Four properties:

- **It queues nothing, and that is the design.** A queued job is dispatched by rule `manual-job` ahead of every
  world-driven rule, so an agent that could queue jobs could put agents on the fleet — a capability
  escalation. Promotion is an operator's click. The tool's description **and** its response say so, so
  an agent does not report a bug and then assume its fix is scheduled.
- **Identity is structural, with full force.** The schema is `{kind, summary, where, detail, ref}` and
  nothing else; `agentId`/`taskId`/`originRef` come from the credential. This is a write that puts
  words in an agent's mouth in front of an operator and is read as testimony about work its author
  actually did. The two text fields change nothing here — they are the reporter describing its own
  observation, not naming anyone.
- **`summary` is one line and the boundary enforces it.** A newline is refused, with the error naming
  `where` and `detail` as the fields the rest belongs in. The point is the timing: a report that
  arrives as one blob is fixable for the price of a tool call in the agent's own turn, and unfixable
  by the time an operator is reading it.
- **`ref` is kind-strict and a bare number is refused.** Unlike `world_read` there is no `kind`
  argument to say whether `41` is an issue or a PR, and a duplicate report must not guess. Anything
  off-vocabulary is refused with "omit ref, describe it in the summary".

### `request_human_task`

Arguments `{title, detail?}` and **nothing that names work**. See
[13](13-jobs-and-findings.md#human-tasks) for the entity and its lifecycle. Four properties:

- **It is not `escalate`, and the description says which is which.** `escalate` is for needing an
  _answer_ to carry on: it parks the agent, holding a slot and a worktree until a human replies. This
  is for needing a person to _do something_, which may take until Tuesday — so the agent files it and
  gets on with, or concludes, whatever it can. Left to one tool, every "somebody has to flip this
  setting" would park an agent overnight.
- **It queues nothing and blocks nothing by itself**, said in the response as well as the
  description, `report_finding`'s discipline for its reason. The half that _can_ hold work off the
  fleet is a plan part declared `expectedKind: 'human'`, which arrives through `plan_submit` and the
  approval gate. So the capability an agent gains here is "ask a person", never "stop the fleet", and
  nothing in the dispatcher reads `human_tasks`.
- **Identity is structural.** The schema is `{title, detail}` and nothing else; `agentId`/`taskId`/
  `originRef` come from the credential. This write puts an obligation on a person under an agent's
  name, so it must say truthfully which agent asked and what it was working on.
- **`title` is one line and the boundary enforces it**, with the error naming `detail` as the field
  the rest belongs in — `report_finding.summary`'s refusal, and for exactly its reason: this string is
  a panel headline, fixable for one tool call in the agent's own turn and unfixable by the time an
  operator is reading it. `detail` is optional, because a required field an agent has nothing for
  comes back as "N/A".

Unfenced by origin: it is hard to name an agent that legitimately has no reason to need a person. It
does not require a live session either, and that matters more here than for a finding — the
commonest moment to realise a person is needed is the moment an agent is giving up on doing something
itself.

It routes through `AgentManager.requestHumanTask` for the `humanTask` event, so the cockpit repaints
on the ask rather than on the next pulse.

### `note_progress`

Argument `{note}`. The agent's own answer to "what is it doing, and is it stuck?".

It sits **beside** `agent:tail`, never replacing it. Same asymmetry as `@@LUBBDUBB_DONE@@` against the
`result` event: a note an agent forgets to call is _silence_, and silence must not read as "no
progress". An agent that never calls it leaves a card identical to the pre-tool one — there is no
placeholder and nothing inferred from output. Where both exist the card shows both: the note is a
claim (durable, attributed, as old as its timestamp), the tail is evidence the process is still
emitting.

- **Latest value, so a column and not a table.** One row per call would be an audit trail, and that
  trail already exists — every call is a tool use in the agent's transcript, in order, with context. A
  second lossier copy in SQLite answers nothing new. Exactly one current reading is kept: `note` +
  `noted_at` on the `agents` row, overwritten per call, riding to the cockpit inside `listAgents()`
  with no new snapshot key, route or panel. The note deliberately outlives the agent — a finished
  agent's last note is the one-line summary of the run.
- **`notedAt` is display context, never liveness.** Nothing derives a staleness or health verdict from
  it, and `test/mcpChannel.test.ts` asserts no derived field appears on the shipped agent. The longest
  gaps between notes are long test runs and big refactors — the healthiest stretches — so reading age
  as "stuck" would punish honest use and turn an optional note into a heartbeat.
- **One field.** There is no `stage` enum, because the only member that would imply an operator action
  is `blocked`, and `escalate` already owns that and does it properly.
- **Trimmed, not rejected.** An over-long note is collapsed to one line, cut to `MAX_NOTE_LENGTH`
  (200) with an ellipsis, and **stored**, with the trim reported back. The opposite of
  `report_finding`, because a finding is testimony an operator acts on while a note is a status line
  whose value is being cheap and frequent. Only an empty note is refused.

It routes through `AgentManager.recordProgress` for the `progress` event, which the `Hub` turns into a
plain `dirty` (unlike `agent:tail`, the payload is already on the row the refetch brings).

### `link_ticket`

Argument `{ref}`. The other half of filing something as a tracker item: the agent dispatched to file
one reports back what it created. What can be filed all resolves the same way and never more than one at
once — a finding an agent reported (see [13](13-jobs-and-findings.md)), or a **work item** for work the
harness did that nothing external accounted for (see
[14](14-persistence.md#work-item-filings)), or a **blueprint** the operator injected as a code job,
which files a watched ticket to enter the planning funnel (see [13](13-jobs-and-findings.md)), or a
**bug** the operator raised against a story from the cockpit (see
[16](16-http-api.md#post-apiissuesnumberbug)). The blueprint shares the work-item-filing arm: its
filing is keyed on the desk job's own ref, since it files _for_ no prior work node. The bug is its own
arm and its own table, because it is keyed on the job rather than on a target and a story may carry
several.

- **It is what completes the filing.** The route leaves the finding `filing`; this call is the only
  thing that moves it to `filed` and gives the cockpit a ticket to link. An agent that never calls it
  leaves a visible unfinished filing rather than a silent one, which is the point of the two statuses.
- **The target comes from the credential, never an argument.** `agent → task → its `job:<id>` origin
→ the finding, the work-item filing, or the bug filing that job was created for`. A job is created for
  at most one of the three, so there is nothing to disambiguate; and there is no id to point at
  somebody else's, so an agent on any other kind of task resolves to none of them and is told so. Same
  discipline as `report_finding`, and here it is the whole access check.
- **`ref` is the same closed vocabulary**, parsed by the same `parseFindingRef`: `issue:314`,
  suffix-tolerant, and a **bare number refused** for the same reason — nothing here says whether `314`
  is an issue or a PR, and a ticket link pointing at the wrong one is worse than none.
- **A work item or a bug must be an `issue:` ref**, unlike a finding's ticket. Both trackers the harness reads
  make a work item an issue — a GitHub issue, an Azure work item — and the fold stands a placeholder
  node up under that ref when the world never lists the ticket, so accepting a `pr:` ref would mean
  guessing a node kind. The case is removed rather than answered.
- **Idempotence is in the write.** `linkFindingTicket` updates `WHERE id=? AND status='filing'`, and
  `linkWorkItemFiling` and `linkBugFiling` update `WHERE job_id=? AND status='filing'`, so a second
  call links nothing and is reported as an error rather than overwriting the first item.

It routes through `AgentManager.linkTicket`, which emits the `finding` event on the finding arm so the
cockpit repaints on the link rather than on the next pulse. The work-item arm emits none: the Work
panel is fetch-on-open, and the parent edge it draws is written by the next pulse's **fold**, not from
the tool — the recorder stays the graph's only writer.

### `conclude_work`

Arguments `{status, note}`, where `status` is `done` | `more_work`. It answers the one question a
tracker state cannot: an item parked in a review state sits there both when work remains and when
everything is delivered and it is waiting on test. See
[06](06-issue-pickup.md#concluding-an-issue) for the verdict and its consumers.

- **It is about the issue, not the turn.** `done` means everything the issue asked for is delivered,
  which is why only a **whole-issue origin** may call it. A part agent, a planner, a PR-concern agent
  and a job agent are each refused with their own reason — the part refusal explaining that the plan
  roll-up already concludes a decomposed issue, so no part agent has to. Refusing beats silently
  scoping the verdict to the part: an agent that got `{ok: true}` back would believe it had concluded
  the issue.
- **Silence is not "not done".** An agent that never calls this leaves the issue `undeclared`, which
  parks the ticket and surfaces it rather than re-picking it. Same asymmetry as `@@LUBBDUBB_DONE@@`
  against the `result` event: a verdict the model forgets is silence, and silence must not be read as
  a verdict.
- **The note is required and not trimmed** — the opposite of `note_progress`, and for the opposite
  reason. A progress note is a cheap frequent status line, so trimming beats refusing; a conclusion is
  a verdict an operator acts on and the next agent starts from, so an empty one is refused and an
  over-long one (>2000 chars) is refused rather than silently cut.
- **A `more_work` note reaches the next agent** for that issue, appended to its prompt, attributed and
  quoted so it reads as a report rather than as the harness's instruction. Only an _agent's_ verdict
  is carried; an operator's toggle is not, since the operator has the cockpit and the job queue to say
  what they want done.
- **It schedules nothing.** `more_work` returns the issue to pickup on a later cycle through rule `work-item-back-to-pickup`;
  it does not dispatch. The response says so, so an agent does not assume a follow-up is queued — and
  `done` does not close the ticket in the tracker, which the response also says.

It routes through `AgentManager.recordConclusion` for the `conclusion` event, so the cockpit repaints
on the verdict rather than on the next pulse.

### `assess_issue`

Arguments `{status: 'delivered'|'more_work', summary, detail?, cause?, part?}`. Rule `issue-assess`'s assessor casts its
verdict here. Identity is structural as for every other write tool — no issue argument, the origin
resolved from the credential.

- **The verdict arrives in two fields, and `validateAssessment` refuses a blob.** `summary` is one
  line, no newlines, ≤160 characters — the headline an operator reads first. `detail` is ≤2000
  characters of markdown: the account, rendered as the body of the card. The 2000-character cap moved
  off `summary` and onto `detail`; it did not disappear.

  **Refusing the newline is the load-bearing part**, exactly as it is for `report_finding` (whose
  shape this copies deliberately, so an operator learns one). An assessor handed a single string
  writes its sections into it as inline capitals — `PRESENT: … MISSING: … REMAINING: …` — and what
  reaches the operator is a paragraph with no seams. Refused here, it is a tool error the same agent
  fixes inside its own turn instead of something a person reads hours later. `detail` is optional: an
  assessment with nothing to add writes nothing, where a required field would be padded with "N/A".

- **`assessmentOrigin` refuses every agent that is _doing_ the work**, which is `conclusionOrigin`'s
  discipline pointed the other way. There a part agent is refused because the plan speaks for the
  issue; here a pickup, planner or part agent is refused because judging your own delivery is not an
  assessment — having someone else look is the entire point of the rule. Both refusals name the tool
  that _is_ the caller's, so an agent reaching for the wrong one is told which is right.
- **The two verdicts land in two rows of opposite polarity.** `delivered` writes the
  `issue_deliveries` park, which **gates pickup**; `more_work` writes an `issue_shortfalls` row,
  which gates nothing and exists to _release_ work. They are mutually exclusive — writing either
  clears the other, in the store — and they are separate tables rather than one with a polarity
  column precisely because every reader of the first holds and the second must never be mistaken for
  one (see [`14-persistence.md`](14-persistence.md)).
- **It no longer writes `issue_conclusions` at all**, and that is a bug fix independent of the
  routing. That row is keyed `origin_ref PRIMARY KEY` and is the row `conclude_work` writes, so an
  assessor writing `more_work` into it **overwrote the working agent's own declaration** — its note,
  its author, its timestamp — and `resolveIssueConclusion` read `by: 'assessor'` and `by: 'agent'`
  through one arm with no precedence between them. There are two records now, and one resolver, which
  ranks a shortfall above an agent's own declaration (the assessor is later and better informed) and
  the operator's toggle above both.
- **`cause` says _what_ fell short, and it is required when the issue has a plan.** `plan`, `part`
  (with `part` naming the slug) or `goal` — see [rule `issue-shortfall`](05-dispatcher.md) for what each routes to.
  The refusals are **plan-aware and synchronous**, which is the tool channel's whole point: a `part`
  slug that is not a live part is refused with the parts that are, `plan`/`part` on an issue with no
  plan is refused and pointed at `goal`, and a missing cause on a planned issue is refused with the
  three alternatives. This is the `plan.json` lesson applied — a structured payload whose rejection
  the agent never hears costs a whole agent to discover.
- **No cause is a fourth answer, not a default.** On an issue with no plan there is no decomposition
  to be wrong about, so "the work is just not finished" names nothing and routes to nothing: the
  verdict stands, `resolveIssueConclusion` reads it as `more_work`, and no arm fires. Folding it into
  `goal` would file an escalation claiming the ticket is wrong every time an unplanned issue fell
  short — a route invented from silence, which is what `undeclared` exists to refuse.
- **`delivered` may not carry a cause.** An assessor that filled one in has contradicted itself, and
  is refused rather than having the fields silently dropped — dropping them would leave it believing
  it had routed something.
- **`delivered` does not close the ticket**, and both the tool description and the response say so
  twice: an agent that believed it had closed the issue would stop looking at it. The description
  also says which way to err — a wrong `delivered` parks real work silently, a wrong `more_work`
  costs one more agent.

It routes through `AgentManager.recordAssessment` for the `assessment` event, so the cockpit
repaints on the verdict rather than on the next pulse.

### `assay_issue`

Arguments `{status: 'workable'|'unclear', summary, profile?}`. Rule `issue-assay`'s assayer casts its verdict here, with
identity structural as everywhere else — no issue argument, the origin resolved from the credential.

- **`assayerOrigin` refuses every agent that is _doing_ the work**, and refuses the assessor too,
  each by name and pointed at the tool that is theirs. An agent already at work has answered the
  question by starting, and an `unclear` from it would park an issue it is mid-way through — so the
  refusal tells it to **escalate** instead, which reaches a human who can actually answer.
- **The verdict is stored for both outcomes.** `workable` gates nothing; it exists so the assay is
  not asked again for the same text — the planner's reason for persisting a plan whatever its size.
- **`unclear` is a question, not a rejection**, and the tool description and response both say so:
  nothing is closed, and the hold ends by itself when the ticket is edited or anything happens on it.
- The verdict is fingerprinted against the title and body **the agent was dispatched with**, read off
  its task, so an edit made mid-run is not silently swallowed.
- **`profile` is the assayer sizing the work** (issue #342), and the tool builds its `enum` and its
  description from _this deployment's_ `agentModels.profiles` — so the agent proposes from the
  operator's own vocabulary rather than a difficulty scale that would then need mapping back. It is
  required with `workable` when any profile is configured, because an optional field is one most
  agents omit and an omitted proposal is indistinguishable from "the default is right" — which the
  harness would then act on, at the default's price, having asked. It is dropped rather than refused
  with `unclear`: a goal nobody can start from has no work to size. A proposal that differs from what
  is already standing holds the funnel until a human answers, and the tool's own reply says so.
  → [02](02-configuration.md#the-gate-the-assayer-proposes-a-human-confirms)

It routes through `AgentManager.recordAssay` for the `assay` event, so the cockpit repaints on the
verdict rather than on the next pulse.

### `conclude_part`

Arguments `{kind, summary, evidenceRef?}`. Pure layer in `src/mcp/partOutcome.ts`; the part is
resolved from the credential (agent → task → `issue:<n>:part:<slug>`), so there is no part argument
and an agent cannot conclude a sibling's work. `partConclusionOrigin` refuses every other caller **by
name**, pointing each at the tool it actually wants — `conclude_work` for a whole-issue agent,
`plan_submit` for a planner, `assess_issue` for an assessor — because an agent handed `{ok: true}`
would reasonably believe it had closed something.

`kind` is `report` or `determination`. **`code` is refused, with its reason given**: a code part
finishes by merging a pull request, which the world observes, so accepting `code` here would let an
agent declare its own work finished with no PR behind it — the false terminal that ruled derivation
out entirely (see [08](08-planning.md)). The tool covers exactly the two outcomes that have no outside
world.

`summary` is required, non-empty, bounded at 2000 characters and **refused rather than trimmed** when
over-long — `conclude_work`'s rule, for its reason: a terminal an operator reads to decide what the
plan achieved must not be silently truncated, and for a determination it is the entire record of why
no code was written. `evidenceRef` is optional and must be `flag:<id>` or `finding:<id>`; requiring it
was rejected because a write-up landing at a path `classifyArtifact` does not promote would leave the
part unable to close, reintroducing the parked-plan bug in a narrower case.

Idempotence is in the write: `Store.concludePlanPart` updates `WHERE id=? AND status IN
('dispatched','in_review')` and returns null when no row changed, so a second call is refused and a
merged or retired part cannot be re-labelled. It routes through `AgentManager.recordPartOutcome` for
the `partOutcome` event, so the cockpit repaints on the verdict rather than on the next pulse.

### `open_pr`

Opens the pull request for the work the calling agent was dispatched to do.
Arguments `{summary, type?, scope?, body?}` — and **nothing that names work**.

- **Identity is structural, with full force.** Branch, base, issue and stack position all resolve from
  the credential's origin (`resolveOpenPr`, `src/mcp/openPr.ts`), so an agent cannot open a pull
  request against another agent's work however it phrases the call. The same discipline
  `report_finding` rests on, and with more reason: this write puts a pull request into the world under
  the operator's account.
- **Base selection reuses `partBase`.** Two answers to "what does this part stack on" is the drift
  class the branch gate and the reconciler already avoid by sharing one.
- **Every other origin is refused by name**, and told which tool it actually wants — a PR-concern
  agent already has a pull request; a planner, assayer, assessor or desk job writes no code. Refusing
  beats silently scoping: an agent handed a target it did not ask for would open a PR for work it is
  not doing.
- **The title comes from `pr-title`** (see [07](07-pull-requests.md)); `type` and `scope` are the one
  thing the agent knows and the harness does not.
- **The issue reference is appended, never a closing keyword.** Whether a PR closes its issue is the
  agent's judgement — a harness-written "closes" would shut a ticket whose remaining parts are open.
  A part gets `Part <n>/<m> of #<issue>.`, a whole-issue pickup `Relates to #<issue>.`

**The floor is unchanged.** Unwired — no sink, a `listen()` that failed, a `claude` that ignores the
server — the tool is still advertised (so `names.ts` stays honest) and reports that it is unavailable,
and every prompt still tells the agent how to open its own pull request. `test/mcpChannel.test.ts`
asserts that rather than intending it.

### `request_permission`

The permission backstop (issue #130 phase B). Arguments `{tool_name, input, tool_use_id}` — but the
agent never supplies them: Claude Code calls this tool through `--permission-prompt-tool` when a tool
request is covered by neither `agentAllowedTools` nor the permission mode. It is the one tool an agent
is not told about and does not call itself.

- **It blocks.** The handler returns a Promise that resolves only when the operator decides. So a
  blocked agent holds its concurrency slot until answered (or killed) — deliberately, since the
  allow-list covers the mechanical happy path and the backstop fires only on genuinely unusual
  commands, the ones that _should_ wait for a human. There is no auto-timeout-deny: a silent timeout
  would tell the agent a command is forbidden when the operator merely hadn't looked.
- **`PermissionDesk` (`src/agents/permissionDesk.ts`), not a `Proposal`.** A permission request is
  ephemeral and single-shot — the agent is blocked on an open socket _now_, and if the harness
  restarts the blocked call dies with the process — the opposite of a durable re-read-every-pulse
  verdict with settle windows. The desk is a small in-memory `Map<escalationId, resolve>`. It reuses
  the **escalation inbox** purely as the visible "Needs you" surface (`context.permission` marks it),
  filing an `approve_change` escalation with the command as its prompt and `['Allow','Deny']` options.
- **The verdict is bare.** The handler returns `toolJson({behavior:'allow', updatedInput})` /
  `{behavior:'deny', message}` directly — never `ok()` (its `_status` envelope breaks Claude's
  permission parser) and never `toolError` (Claude reads an error as a tool _failure_, not a deny).
- **Settled out of band.** `POST /api/escalations/:id/permission {allow, note?}` → `PermissionDesk.decide`
  resolves the blocked call and settles the inbox item through `EscalationInbox.settleResolved`, which
  never types into the session — the agent is blocked in a tool call, not parked at a prompt, so the
  "answer" is the return value. The ordinary `/answer` route **409s** a permission escalation and names
  the permission route (the same pattern it uses for a pending proposal). The **same live agent** then
  continues (allow) or reads the denial (deny); a refusal does not orphan the task.
- **Deny on death.** `PermissionDesk.denyAll(agentId)` resolves any request an agent was blocked on as
  a denial. It hangs off `McpBridgeServer.release(token)` — the one choke point every terminal path
  (kill / crash / shutdown) already hits — so a dead agent never leaves Claude blocked.
- **No off-switch.** The backstop is unconditional: the alternative to routing an un-allowlisted call
  to the operator is Claude's headless default, a silent deny, which is a worse answer to the same
  question. Where the channel itself is unavailable the tool is unwired and denies rather than
  blocking, which is the floor below rather than a setting.

## Identity

**Identity is structural, not argued — for every write.** No write tool takes an agent, task or issue
argument. The credential minted at spawn resolves `token → agent → task → origin`, so an agent cannot
name itself and therefore cannot address another's work. This is what the `planOriginIssue` fencing was
approximating over a transport that carried no identity at all.

The token is a **bearer credential**: it lives in the 0600 launch-config file, never in argv (where
`ps` would show it), and it is revoked on kill, interrupt and reap. A resume mints a fresh one for the
same agent row.

**The `agent → task` half of that chain is resolved in exactly one place**, `AgentManager.withCaller`,
and every tool-facing method on the fleet runs its body through it. It was copied into all eleven of
them, so the channel's one security-relevant step held eleven times by inspection rather than once by
construction: a twelfth method written from scratch, or one that dropped the `!task` check because its
store call happens to take only an `agentId` (as `recordProgress`'s genuinely does), would have
inherited nothing and failed nothing. It is a **wrapper**, not a `resolveCaller()` a caller may forget
to check — the body cannot run without a resolved `{agent, task}` in hand — and it deliberately does
not check liveness, because a finding, a note or a verdict cast on an agent's last breath is still
true. `ask` is the one caller that needs a live session, and tests for it itself.

The tool layer's half is the same property one level up: the caller reaches a tool body on its
**context**, never in `args` (see [How a tool is built](#how-a-tool-is-built)).

## How a tool is built

`src/mcp/names.ts` declares the names, **one module per tool** under `src/mcp/tools/` carries its
description, schema and handler, and `src/mcp/tools.ts` is the assembly and nothing else — the same
shape `DISPATCH_PIPELINE` + `STAGES` gives the dispatch rules, for the same stated reason. `buildTools`
was one 844-line function whose scope every tool shared, so the growth axis for "add a tool" was a
function nobody could read end to end and each tool's origin fence was an `if` somewhere inside it.

Three things carry the split:

- **A tool module does not carry its own name.** The registry is a `Record<McpToolName, ToolFactory>`
  keyed on `MCP_TOOL_NAMES`, and a factory returns everything _except_ the name. So a name with no
  module is a compile error, and a module cannot name itself something `--allowedTools` never granted —
  the "connected server whose every call is refused" trap, closed at compile time rather than by an
  array index literal per module.
- **`ToolContext` is the seam** (`tools/context.ts`): the deps, the resolved `{agent, task}`, and the
  `ok()` that folds in the `_status` envelope. Everything a tool may reach is named there, which is what
  makes "the caller is on the context, never in `args`" a property of the type rather than of the
  reading.
- **The origin fence is declared in the tool's own module.** Only `plan_submit` has one at this layer
  (`plannerIssue`, pure — it resolves nothing but the issue number). The others — `conclusionOrigin`,
  `partConclusionOrigin`, `padOriginFor`, `retroSubmitOrigin`, `assessmentOrigin`, `assayerOrigin` —
  are asked at the fleet seam because each _resolves_ something out of the store as it refuses (the
  part, the pad, the issue), so a copy in the tool layer would be a second answer to a question already
  answered next to the write it guards.

`test/mcpChannel.test.ts` asserts both halves structurally: the caller resolution appears once in
`agentManager.ts`, and `tools.ts` declares no schema and no handler with one module per advertised
tool. Neither is a property any behavioural test can fail on — a tool that re-derived the caller by
hand works, right up until it works for the wrong agent.

## Transport

A **Unix domain socket** (named pipe on Windows), never a TCP port — the cockpit's HTTP surface is
already unauthenticated on `0.0.0.0`, and a second one with fleet-wide write access to the store is not
a trade worth making.

- Socket path: `<tmpdir>/lubbdubb/mcp-<pid>.sock`, or `\\.\pipe\lubbdubb-mcp-<pid>`. Per-pid, so two
  harnesses on one machine do not fight, and under the OS tmpdir to stay inside the ~104-character
  POSIX limit on socket paths.
- Launch configs: `<tmpdir>/lubbdubb/mcp/<token>.json`, written with mode `0600`.
- `bridge.mjs` (spawned by `claude`, shipped `.mjs` like `statusCapture.mjs`) is a **byte-transparent
  pipe with no protocol logic**, so `initialize` / `tools/list` / `tools/call` / validation all live in
  `protocol.ts` and `tools.ts` and are testable with no transport at all.
- A connection that does not hand over a token first is **dropped unanswered**. The handshake line is
  `{"lubbdubb":1,"token":"…"}`; everything after it is newline-delimited JSON-RPC 2.0.

`src/mcp/socketChannel.ts` is the listening half — bind, handshake, frame — and **both** channels use
it. A second copy of "a connection that does not identify itself gets nothing" would be a second
place for the only rule between a local process and the whole store to drift.

How a path already in use is treated is the one thing the two channels differ on, and it is
load-bearing both ways:

- **The fleet socket carries the pid**, so nothing else can want that exact path and a file on it is
  debris from a crashed run. It is removed before binding — binding is the only way to tell a dead
  socket from a live one.
- **The desktop socket is stable**, which is what lets the MCP server be registered once. A _live_
  socket on it therefore belongs to another harness, and unlinking it would silently steal every
  future desktop session from a running process. So the path is probed with a connect first: a live
  one is refused with a message naming the conflict, and only a dead one is cleared.

## The desktop channel

`src/mcp/desktop.ts`. A second socket, for the operator's **own** Claude Code rather than for a
spawned agent — so a validation check needing a browser and a login the fleet does not have can be
run at their keyboard and reported onto the same row. Off unless `validation.desktop`;
[20](20-validation.md#the-desktop-channel) owns the behaviour.

| Tool                | Purpose                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `validation_read`   | Read a goal's validation plan, or one check's full procedure. Records nothing.                        |
| `validation_claim`  | Take the one check this session is about to run. One claim at a time, harness-wide.                   |
| `validation_report` | Record what was seen: `passed`, `failed`, or `handback`. Reported against the claim, not an argument. |

Four things differ from the fleet channel, and each answers a way this credential is unlike an
agent's:

- **Identity has no agent behind it.** Nobody dispatched a desktop session, so there is no task and
  no origin. The equivalent chain is `token → connection → claim`, and it gives the same guarantee:
  which check a report is about is settled before the report rather than by it.
- **The tool set is narrowed by construction, not filtered.** `DESKTOP_TOOL_NAMES` is its own list
  and `src/mcp/desktopTools.ts` is a `Record` over it; this server never reaches `buildTools`. The
  credential is long-lived and sits in a home directory, so the guarantee has to be that there is no
  path to `conclude_work` at all — not that a filter is currently correct.
- **The credential is a file, and the registration carries no secret.** The token is minted at every
  `listen()` and written to `validation.desktopCredentialPath` at `0600`; `bridge.mjs --desktop`
  reads it at spawn. So `claude mcp add --scope user lubbdubb -- node …/bridge.mjs --desktop` is a
  fixed command line, added once, that survives every restart and every reminted token.
- **No `ALLOWED_MCP_TOOLS` equivalent.** The fleet's grants exist because nobody is at the prompt to
  approve a call ([Launch flags](#launch-flags)). Here somebody is, on their own machine.

Per-connection state is the reason `SocketChannel` mints a connection id: a claim belongs to one
connection, so closing that terminal releases it and a second terminal sharing the same token cannot
release the first one's check.

## The wire protocol

`src/mcp/protocol.ts`, pure. MCP revision `2024-11-05`. Only the methods a tools-only server must
answer are implemented; anything else returns a proper `method not found` rather than silence, so a
client mismatch shows up as an error instead of a hang.

| Method                                                 | Behaviour                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| `initialize`                                           | Echoes the version, `capabilities: {tools:{}}`, `serverInfo`. |
| `notifications/initialized`, `notifications/cancelled` | Returns nothing (notifications take no frame).                |
| `ping`                                                 | `{}` for a request; nothing for a notification.               |
| `tools/list`                                           | Name, description and input schema for each tool.             |
| `tools/call`                                           | Runs the named tool.                                          |

`handleRequest` **never throws**: a handler that blows up becomes an `isError` tool result, so an agent
gets a message it can act on instead of a dead channel. That is the whole point of the tool path over
the `plan.json` one.

`resolve(token)` failures are handled asymmetrically on purpose: `initialize` and `tools/list` are still
answered (with an empty tool set) so a bridge that raced ahead of `bind` completes its handshake and can
retry; only an actual `tools/call` needs a real identity, and it gets the reason as a handled error.

## Launch flags

Both verified empirically against `claude` 2.1.220 in headless `-p` mode, not assumed:

- **`--mcp-config` is additive.** Launched in a cwd holding its own `.mcp.json`, the init event reports
  `mcp_servers: [{theirs}, {ours}]`. `--strict-mcp-config` is therefore deliberately **not** passed: it
  would suppress the user's own servers in the user's own checkout.
- **`--allowedTools ALLOWED_MCP_TOOLS` is required, not defensive.** An `--mcp-config` server connects
  with no approval step (a project `.mcp.json` server instead sits at `pending`), but its tool _calls_
  are still permission-gated, and `acceptEdits` — the default `agentPermissionMode` — does not cover
  them. Without the flag every call returns `"Claude requested permissions to use mcp__lubbdubb__…, but
you haven't granted it yet."` with no human at the prompt. The flag is **additive, not restrictive**:
  an agent launched with it still uses Bash and Write normally.
- **`--permission-prompt-tool <name>` wires the backstop** (issue #130). Passed only alongside
  `--mcp-config`, since the tool lives on that server. Its
  value is `PERMISSION_PROMPT_TOOL` (`mcp__lubbdubb__request_permission`), derived from the same server
  id + tool name as every grant, so it can never drift from what `buildTools` exposes.

This is why `src/mcp/names.ts` exists. Three things must agree — the `mcpServers` key
(`MCP_SERVER_ID = 'lubbdubb'`), the tool names, and the `mcp__<key>__<tool>` grants — and drift between
them yields a _connected_ server whose every call is refused, invisible until an agent needs it.
`test/mcpChannel.test.ts` asserts all three against each other. **Adding a tool to `buildTools` without
adding its name to `MCP_TOOL_NAMES` is the sharp edge of the whole module.**

## Degradation

The sentinels remain the floor everything degrades to. `MCP_PROTOCOL_ADDENDUM` states a _preference_,
never a replacement, and `@@LUBBDUBB_DONE@@` has **no tool at all**: MCP has no turn-boundary event, so
a `finish()` the model forgets to call is silence, and silence is indistinguishable from thinking. The
`result` event plus the sentinel is what disambiguates _finished_ from _stopped mid-task_.

Every one of these leaves behaviour byte-for-byte as it was without the channel, and
`test/mcpChannel.test.ts` asserts that floor rather than merely intending it:

- `listen()` returning false (socket unavailable)
- An unwritable launch-config file (that one agent falls back; the rest are unaffected)
- A `claude` that ignores the server

In each case `open()` hands back a null `configPath`, no `--mcp-config` is passed, and the agent runs on
the sentinels alone.

## Testing

Tests drive `mcp.session(agentId)`, which converges on the same `dispatch` an agent's bridge reaches —
**there is no test-only tool path.** `npm run smoke` runs a real `bridge.mjs` child over a real socket,
which is the half unit tests cannot cover.

## `claim(ref)` — investigated and closed

Not an omission. **Origin and branch are 1:1 for every world-driven dispatch rule**, so the
`activeOrigins` / `findActiveTaskByOrigin` gate already _is_ a branch gate, and the existing gates leave
no dispatch-time collision for a claim to prevent. What they cannot see is what an agent does once
running — and a claim cannot fix that either: **advisory** makes it documentation an agent may forget,
**enforcing** needs a lock that vanishes whenever the socket does (a lock that silently is not one),
and **letting the dispatcher read claims** would let an agent suppress another's dispatch. The
structural detector in [12](12-artifacts-and-files.md) is what shipped instead.
