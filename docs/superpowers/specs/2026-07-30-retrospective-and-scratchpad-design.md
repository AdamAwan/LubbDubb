# The retrospective — and the pad the agents write it from

The Goal Floor draws a station called **Manifest**, `Report what was done`, immediately before
Launch. It reports nothing. Its whole content is `issue.conclusion?.note` falling back to `'—'`
(`web/src/skins/factory/goalFloor.ts`), its status is `manifestStatus(Boolean(conclusion?.note))`,
and its `link` is null — so it is not even clickable. Nothing downstream reads it: the edge to the
Signal post is drawing order, the Signal post is built from `issue.workItemState` and
`plan.statusCommentRef`, and Launch from `delivered`/`shortfall`. A missing note holds nothing back.

So the station names a step the harness does not take. What it should name is a **retrospective**:
what was delivered, and what came out of the process of delivering it — the run's own post-mortem,
readable by the operator who has to decide whether to change a gate, a prompt or a config.

Two things are missing, and they are different things:

- **During the run**, nothing lets one agent leave a note another agent — or a later
  retrospective — can read. `note_progress` is a single overwritten line for a fleet card;
  `report_finding` is testimony about work *outside* the agent's task, deliberately narrow and
  operator-actioned. Neither is "here is what I learned doing this, for whoever comes next".
- **After it**, nothing synthesises. The facts that make a process retrospective worth reading —
  attempts spent, cooldowns, escalations, replans, a shortfall, red CI on a base, file overlaps,
  spend — exist only in the store, and no agent has ever been asked to write them up.

This spec adds both: a per-issue **scratchpad** the working agents append to, and a per-issue
**retrospective document** an agent writes at the end from that pad plus a harness-assembled
dossier. The Manifest station becomes the way in to the second.

## Decision 1: the retrospective is its own document, not a plan part

A plan part could have carried it — `expectedKind: 'report'` already exists on `PartSchema` and the
planner prompt already offers it — and it was rejected. A part is *work the plan schedules*: it is
retired by a replan, counted by `liveParts`, rolled up into the plan's status, and it exists only
for a decomposed issue. A retrospective is about the whole goal, including the goals that were never
decomposed at all, and it must survive a replan rewriting `plan_parts`. It is also not something a
planner should be able to forget: a plan-authored retro part is absent exactly when the planner was
sloppy, which is the run most worth reading about.

So: one row per issue, written after delivery, keyed on `issue:<n>` — the same key
`issue_conclusions`, `issue_deliveries`, `issue_shortfalls` and `issue_assays` already use.

## Decision 2: two tables, not one with a `kind`

`scratch_entries` is many attributed rows accumulating *during* the run. `retrospectives` is one
document per goal produced *after* it. Folding them into one table with a discriminator is the shape
refused for `issue_shortfalls` against `issue_deliveries`: every reader would have to remember which
kind it held, from rows identical until you read a column.

They also differ in what they promise. A pad entry is cheap, frequent, and true only of the moment
it was written. A retro document is the one thing a human reads to decide what to change.

### `scratch_entries`

| column | meaning |
| --- | --- |
| `id` | row id |
| `pad_ref` | the pad key, always `issue:<n>` |
| `author_origin_ref` | the origin of the agent that wrote it (`issue:12:part:schema`) |
| `agent_id`, `task_id` | attribution, from the credential |
| `topic` | optional short tag the author chose |
| `note` | the entry |
| `created_at` | when |

Append-only: there is no update and no delete. Fresh `CREATE TABLE`, so no `migrate()` entry.

### `retrospectives`

| column | meaning |
| --- | --- |
| `origin_ref` | `issue:<n>`, primary key |
| `summary` | one or two sentences, required |
| `document` | the write-up, markdown, trimmed not refused |
| `agent_id`, `task_id` | who wrote it |
| `created_at`, `updated_at` | when |

Fresh `CREATE TABLE`, so no `migrate()` entry. The document is **stored on the row**, not surfaced
as an artifact chip, for the reason `plan.document` is: `GET /artifacts/:id` serves out of the
agent's worktree and `system.ts` removes that worktree on the `done` reap, so a write-up surfaced
that way 404s exactly when it becomes worth reading.

## Decision 3: append-only, because two part agents run at once

`maxConcurrentPartsPerIssue` permits concurrent part agents on one plan by default. A pad shaped as
one mutable document (`scratch_write` replaces) would have them overwrite each other with no merge
anywhere — the same silent loss `detectFileOverlaps` exists to expose, reintroduced deliberately.
Keyed sections (each agent upserts its own key) avoids the clobber but lets an agent quietly rewrite
its own history, and a retrospective's value is partly *when* something was learned.

So: append, attributed, timestamped, ordered. The retro reads a trail.

## Decision 4: the pad is resolved from the credential, never named

Neither tool takes a pad reference. Identity is structural exactly as for every other write tool:
`token → agent → task → origin`, then the pure

```
padOriginFor(originRef: string): string | null
```

which maps `issue:12`, `issue:12:plan`, `issue:12:assay`, `issue:12:assess`,
`issue:12:part:<slug>` and `issue:12:retro` to `issue:12`, and everything else to null. A
PR-concern agent, a job agent and a planner for another issue are all refused, **by name and with
the tool they actually want** — `partConclusionOrigin`'s discipline, because an agent handed a
silent success believes its note was recorded.

Read is the same set as write; that is what makes it shared. A later part agent reading what an
earlier one learned is a feature, not a leak: they are agents on one goal, dispatched by one plan.

Deliberately **not** widened to `pr:<m>:*` agents whose PR is linked to the issue.
`linkedPrNumber` is sticky, so that join would let an agent reach a pad through a PR the issue
merely points at, and the CI-fix and comment-reply prompts are not written to produce retrospective
notes anyway.

### The tools

- **`scratch_append({note, topic?})`** — one entry. Empty `note` is refused; an over-long one is
  **trimmed and stored with the trim reported**, `note_progress`'s rule rather than
  `report_finding`'s, because a pad note's value is being cheap and frequent while a finding is
  testimony an operator acts on.
- **`scratch_read()`** — every entry on the caller's pad, oldest first, each with its author origin
  and timestamp. No arguments, no filter, no paging: a pad is bounded by one goal's agents.

Both route through `AgentManager` (not straight to the store) for the reason a flag does — the
event is what puts it in the cockpit now rather than next pulse — and both carry the ordinary
`_status` envelope.

### The dispatcher reads existence, and never prose

The pad is a lens, like `findings`, `overlaps` and `prAttention`: **nothing in the dispatcher reads
it at all**. A rule reading pad notes would let one agent's prose suppress another agent's dispatch,
which is #108's open question 3 in different clothes. Asserted structurally, the way
`test/workGraph.test.ts` asserts its own: no file under `src/dispatcher/` names the scratchpad
module.

The retrospective is different in exactly one way, and the difference is bounded rather than
argued away: rule 3h has to know whether a retro already exists, or it dispatches one every pulse
forever. So `DispatchContext` carries `retrospectiveOrigins: string[]` — the keys of the rows that
exist, wired in `harness.ts` from `store.listRetrospectiveOrigins()` — and **not** the summaries or
the documents. Every other rule already reads its own verdict table this way; what must not reach a
rule is the *writing*, since a rule branching on retro prose would let one agent's account of the
run change what the harness schedules. `test/retrospective.test.ts` asserts the context type carries
no document or summary field.

## Decision 5: rule `issue-retro` (3h), on by default

`3g` is taken by `issue-shortfall`, so the retro rule is **3h**, `Delivered goal needs a
retrospective`, with a registry entry like every other rule and the `rule` id on the action it
emits.

It fires when all of these hold:

1. The goal is **finished** — a standing `issue_deliveries` row for `issue:<n>`, or
   `resolveIssueConclusion` reading `done`. Not "the tracker closed it": the harness's own park is
   the signal, since `openPrForIssue` reads only the open list and GitHub has no review state.
2. There is **no `retrospectives` row** for the issue.
3. Nothing is in flight on the issue (the ordinary origin gate covers the retro's own agent).
4. `retrospective.enabled`.

It dispatches a **desk** agent (`dispatch_desk_agent`), origin `issue:<n>:retro`, no branch and no
worktree: it writes no files, and a checkout would only be a temptation to start work on a goal that
is finished. Origin/branch stays 1:1 by construction — a desk job has no branch.

Repeats are held by machinery that already exists: the origin gate while the agent runs, the retro
row once it lands, `dispatchVerdict`'s cooldown and three-attempt cap in between. Nothing new counts
anything.

**It fails open and silent.** A retro agent that crashes, is killed, or spends its cap leaves no row,
raises no escalation, and the Manifest station reads *Nothing written*. This is `assay`'s and the
planner's rule: act on what was said, never on silence. The retro gates nothing, so silence costs
nothing but the report.

**It ranks after `issue-assess`.** An issue whose delivery is still being judged is not one to write
up.

### On by default, and what that costs

`retrospective.enabled` defaults **true**. The same change flips `planning.enabled`,
`assessment.enabled` and `assay.enabled` to `true` (see below). `autoSend` stays **off**: it
authorizes replies and merges going out with no human, which is a different class of switch from
spending an agent, and nothing here changes it.

Cost, on the record rather than discovered later: one issue can now spend an assayer, a planner, its
part agents, an assessor and a retrospective agent. The retro is the cheapest of them — one desk
agent, once, after the work is done — but it is one more.

## Decision 6: the agent gets testimony *and* the record

The pad holds only what agents chose to write. Attempts spent, cooldowns, escalation answers,
replans, the shortfall and its cause, CI attempts, overlaps and spend exist only in the store, and
they are most of what makes a process retrospective actionable.

So a pure fold in `src/retro/` assembles a **dossier**:

- the plan: verdict, approval, replans, each part with its slug, kind, status and outcome note;
- the pull requests: merged and closed-unmerged, with base chains where a stack existed;
- decisions on `issue:<n>` and its subtree origins, with the `rule` ids that fired;
- escalations raised and how they were answered; proposals and their verdicts;
- the assay verdict, the delivery, the shortfall and its cause, the conclusion note;
- CI attempts per PR and any inherited-failure suppressions;
- file overlaps touching the issue's agents;
- agents spawned, and spend from `usage_events`.

Every one of these is already computed or stored somewhere in the pulse; the fold reads, it does not
re-derive. It is pure and unit-tested, and it renders to markdown.

The dossier and the pad are **appended** to the rendered `issue-retro` prompt, never interpolated
into it. `loadPromptTemplates` rejects only *unknown* placeholders, so a `{dossier}` token would be
silently dropped by exactly the overrides that customised most — the rule the rejection note, the
outstanding-work note and the part-outcome note all follow. Appending has no fallback to get wrong.

The prompt asks for both audiences in one document: **what shipped** (a reviewer's changelog — the
PRs, what each part decided, what was concluded out of scope, what is still outstanding) and **how
the run went** (where agents were spent and why, what surprised the agents, what an operator should
change). The pad is quoted as agent testimony, attributed, so the retro does not read it as the
harness's own account.

## Decision 7: `retro_submit`

```
retro_submit({ summary, document })
```

Fenced to an `issue:<n>:retro` origin by a pure predicate, refusing every other caller by name.
`summary` is required. `document` is markdown, **trimmed rather than refused** past a maximum, for
`MAX_PLAN_DOCUMENT_CHARS`' reason: an over-long write-up must not sink the whole submission.
Validation is synchronous and the rejection reason is returned in the same turn — the whole
difference between this and `plan.json`, whose zod rejection the planner never heard.

The write is an **upsert on `origin_ref`**, so a second call revises the same row rather than
duplicating it, and idempotence lives in the write rather than in a read-then-check.

There is deliberately **no** file fallback (no `.lubbdubb/retro.md` path). `plan.json` stays wired
because it predates the tool channel and is the degradation floor for a plan; a retrospective is new,
and a desk agent has no worktree to write into.

## Cockpit

`/api/state` ships a per-issue `retrospective`: `{ summary, hasDocument, updatedAt }` — **not** the
markdown. The snapshot is polled continuously, so the document is fetched on open via
`GET /api/retrospectives/:ref`, the `WorkTreePanel` pattern.

The Manifest station then reads the retro rather than the conclusion note:

- `manifestStatus` becomes *Filed* when a retrospective exists, *Nothing written* otherwise;
- the summary is the station's meta line, with the conclusion note demoted beneath it;
- a control opens a shared `RetroModal` (both skins reach it, like `PlanModal`) through a new
  `viewRetro` on `CockpitActions`.

**The entry point is keyed on the retrospective existing**, never on what state the issue is in.
That is the plan modal's lesson, learned twice: hanging controls off a status made the plan readable
only while it was `awaiting_approval`, so approving it removed the only way to read it back.

Nothing else in the cockpit changes. The pad is not drawn as its own panel in this change — its
entries reach the operator through the retrospective, which is what they are for.

## The defaults flip

| flag | before | after |
| --- | --- | --- |
| `planning.enabled` | `false` | `true` |
| `assessment.enabled` | `false` | `true` |
| `assay.enabled` | `false` | `true` |
| `retrospective.enabled` | — | `true` |
| `autoSend.enabled` | `false` | `false` (unchanged) |

Flipping a default changes what the harness does on a deployment that configured nothing, so the
same change updates every place that documents the old answer: the rule registry descriptions for
3c, 3e and 3f (each says "Off by default" today), the README's safety wording, the `docs/spec/`
pages that own planning, assessment and the assay, and the corresponding CLAUDE.md bullets. Tests
that pass explicit config are unaffected; any that lean on a default are updated with it.

## Testing

- **`test/scratchPad.test.ts`** — `padOriginFor` over every origin shape; a part agent appends and a
  sibling reads it; a PR-concern agent, a job agent and another issue's agent are each refused;
  append-only (no tool can modify or delete); empty refused, over-long trimmed and reported;
  attribution comes from the credential and not from arguments. Plus the structural assertion that
  no file under `src/dispatcher/` names the module.
- **`test/retrospective.test.ts`** — the rule fires once for a delivered issue and never for an
  undelivered one; it does not fire while an assessment is outstanding; a capped or crashed retro
  agent leaves no row, no escalation and no parked issue; `retro_submit` is fenced, validates,
  trims, and upserts idempotently; the snapshot ships summary-without-document and the route serves
  the document; the Manifest station's reading follows the row rather than the issue's status.
- **Unit tests** for the pure dossier fold (each source present, each absent) and for the new config
  defaults.

## Out of scope, stated

- No pad panel in the cockpit, and no pad entries on the agent drawer.
- No outbound act: the retrospective is not posted to the tracker as a comment, not attached to a
  PR, and closes nothing. `upsertIssueComment` is untouched.
- No dispatcher consumption of the pad or the retro, now or later, without a separate argument.
- No cross-issue or periodic retrospective; one document per goal.
- No `autoSend` change.
- Nothing gates on a retrospective existing: an issue is delivered whether or not it was written up.
