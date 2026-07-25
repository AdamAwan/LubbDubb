# Multi-PR issues: local planning, dependency tracking and stacked parts

**Date:** 2026-07-25
**Status:** Draft — design agreed in conversation, not yet planned

## Problem

Some issues cannot land in one pull request, and LubbDubb has no way to express
that. Its issue model is 1:1 with a PR, and terminal:

- `src/dispatcher/ruleDispatcher.ts:339` gates pickup on `i.linkedPrNumber === null`.
  That is the entire issue → PR model.
- `src/integrations/github/issues.ts:120` (`linkedPrFromTimeline`) returns the *last*
  cross-referencing PR with no open/merged filter. Once PR #12 merges without closing
  the issue, `linkedPrNumber` stays `12` forever and the issue never re-enters pickup.
  Not paused — retired.
- `src/dispatcher/issuePickup.ts:159` then reports `has open PR #12` for a PR that
  merged last week. The word "open" is never checked.
- Rule 3b (`work-item-in-review`, `ruleDispatcher.ts:311`) is one-way: it moves an
  Azure work item to `inReviewState` when a PR opens and never moves it back. Work
  remaining after that PR merges leaves the item parked, and `pickupStates` then
  blocks it too.
- The default `issue-pickup` prompt says *"open a pull request that closes this
  issue"* — so on a three-PR issue, the first PR merging closes it outright.

Second, there is no memory across runs. A second agent on the same issue gets the
identical prompt the first one got: number, title, body, branch. The store holds the
history (`tasks.origin_ref`, `agent_flags`, `agent_files`) but nothing composes it
into a later dispatch. Worse for plan documents specifically — the file-events hook
promotes a report-like path to a flag, but the ref is worktree-relative and the
worktree is removed on the `done` reap, so the artifact route cannot serve the plan
after the run that wrote it.

Third, the obvious fix (serialise: work part 2 only once part 1 merges) is worse
than what an operator does by hand, which is to **stack** PRs — part 2 branches off
part 1 and opens against it, both in flight at once.

## Goals

1. An issue may resolve into many PRs, tracked as parts of one plan.
2. Parts declare dependencies and may run **concurrently, stacked** — a part starts
   once its dependency has pushed a branch, not once that branch has merged.
3. Every part agent knows what previous parts did and what remains.
4. The dependency graph and progress live **locally, in LubbDubb's store** — not in
   git, not parsed out of a prose plan document.
5. Simple issues are unaffected: they still take one agent, one branch, one PR.

## Non-goals

- Parsing superpowers plan documents. `docs/superpowers/plans/*.md` are ~1000-line
  prose plans with `- [ ]` steps, written for *an agent executing them*. Deriving a
  scheduling graph from that format would be brittle and would fight the format.
  Two artefacts, two consumers: prose plan for the worker, graph for the scheduler.
- Reading repository file contents. No `getFileContent` is added to the `GitHubApi`
  or `AzureDevOpsApi` seams.
- Sub-issues or work-item children as the tracking mechanism. Progress *is* mirrored
  back to the tracker, but as a single status comment — not by creating provider-side
  child items that would need their own lifecycle.
- Cross-issue dependencies. A plan spans exactly one issue.

## The funnel

Every watched, open issue passes through a **planning agent** first. It emits one of
two verdicts:

```
issue ──► planner ──┬── "single"  ──► today's issue-pickup, unchanged
                    └── "parts"   ──► plan + parts ──► stacked part agents
```

The planner biases hard toward `single`; splitting is the exception, and an agent
that over-decomposes turns a twenty-minute fix into three PRs. That judgement is
taste, so it lives in an operator-overridable prompt template (`issue-plan`).

**The verdict must be persisted.** A `plans` row is written for both outcomes,
otherwise the planner re-runs on the same issue every cycle. `single` is a
first-class plan status, and rule 4 fires only for issues whose plan says `single` —
so the existing single-PR path stops being a bypass and becomes an explicit outcome
of the funnel. Its behaviour is otherwise byte-for-byte what it is today, which
keeps the regression surface near zero.

## Why local, and what that costs

The graph is scheduling *intent*: which parts exist, what depends on what, which
agent is on which. That is LubbDubb's business, changes as the fleet runs, and has
no natural home in the target repository.

The honest cost: wipe the database (or lose the container) and the graph is gone
while the PRs live on. Reconciliation (below) can rebuild part → PR links from
branch names but not the graph itself. That is a real argument for the planner also
committing its prose plan — a replan then starts from something rather than nothing.

**Local must not mean authoritative about reality.** Tracking that only records what
LubbDubb intended goes fictional within a day: a human merges a part by hand, or
closes a PR, and the store still says `dispatched`. See Reconciliation.

## Data model

Two new tables. Both are fresh `CREATE TABLE`s, so no `Store.migrate()` entries are
needed.

```sql
-- One plan per issue. Written for both verdicts, so the planner never re-runs.
CREATE TABLE IF NOT EXISTS plans (
  id          TEXT PRIMARY KEY,
  origin_ref  TEXT NOT NULL UNIQUE,   -- "issue:12"
  title       TEXT NOT NULL,
  status      TEXT NOT NULL,          -- planning | single | active | complete | abandoned
  reason      TEXT,                   -- the planner's justification for its verdict
  status_comment_ref TEXT,            -- provider comment id, edited in place
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Parts of a multi-PR plan. Empty for a `single` plan.
CREATE TABLE IF NOT EXISTS plan_parts (
  id          TEXT PRIMARY KEY,       -- "<plan_id>:<part slug>"
  plan_id     TEXT NOT NULL,
  slug        TEXT NOT NULL,          -- stable, author-chosen; survives replanning
  seq         INTEGER NOT NULL,
  title       TEXT NOT NULL,
  scope       TEXT NOT NULL,          -- files/areas this part owns, for the prompt
  depends_on  TEXT NOT NULL,          -- JSON array of sibling slugs
  branch      TEXT,
  pr_number   INTEGER,
  status      TEXT NOT NULL,          -- pending | ready | dispatched | in_review | merged | blocked
  task_id     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (plan_id, slug)
);
```

Conventions, matching the existing `pr:<n>:<facet>` shape:

- Origin ref: `issue:12:plan` (planner), `issue:12:part:<slug>` (part agent).
- Branch: `issue/12/<slug>`.

Because part origins are per-part, every mechanism that keys on origin works
unchanged — `activeOrigins` de-dup, `dispatchVerdict` cooldown and the attempt cap,
escalation, the candidate ranking and the headroom cut. And one-agent-per-branch
already keys on branch, so concurrent parts do not trip it.

## Dispatch rules

Three registry entries in `src/dispatcher/rules.ts`:

| id | number | fires when |
| --- | --- | --- |
| `issue-plan` | 3c | watched open issue with no `plans` row |
| `plan-part` | 4a | a part whose dependencies are satisfied has no active task |
| `issue-pickup` | 4 | *(narrowed)* open issue whose plan status is `single` |

Ranking, inside the existing `Candidate` list so the headroom cut and the "Up next"
queue need no changes: **planners first** (a planner unblocks work, so it should win
a scarce slot ahead of the work it unblocks), then parts ordered by dependency depth
(bottom of a stack before its dependents), then one-shot pickups by label priority.

The planner is a **code** agent, not a desk agent: it needs a worktree to read the
repository, and it is the thing that commits the prose plan.

Concurrency within one issue is capped (`maxConcurrentPartsPerIssue`, default 2)
rather than fanning out the whole graph the moment dependencies are satisfied. Manual
stacking works because a human holds the decomposition in their head and knows part 3
will not collide with part 2; N concurrent agents do not. The cap plus per-part
`scope` is what substitutes for that.

## Plan ingestion

The planner writes `.lubbdubb/plan.json` into its worktree. The harness picks it up
through the **file-events `PostToolUse` hook** that already reports every `Write`
path (`AgentManager.drainFileEvents`): a reserved filename is recognised, read from
the worktree, zod-validated at the boundary like every other action payload, and
persisted.

```jsonc
{
  "version": 1,
  "verdict": "parts",              // or "single"
  "reason": "Schema change must land before the dispatcher reads it.",
  "parts": [
    { "slug": "schema",     "title": "…", "scope": "src/store/…", "dependsOn": [] },
    { "slug": "dispatcher", "title": "…", "scope": "src/dispatcher/…", "dependsOn": ["schema"] }
  ]
}
```

No new sentinel, no network coupling from the agent to the server, and it reuses two
mechanisms that already exist. The alternative — a `@@LUBBDUBB_PLAN:<json>@@`
sentinel — is more consistent with the protocol but a real plan bumps into
`MAX_SENTINEL_HOLD`.

**Sequencing constraint:** ingestion must happen at drain time, *before* the `done`
reap removes the worktree (`WorktreeManager.remove` in the composition root).

Because ingestion is uniform, two useful things fall out for free:

- **Mid-flight upgrade.** A one-shot agent that discovers the work is bigger than
  the planner thought writes a `plan.json` itself; the issue is upgraded from
  `single` to `parts` and the agent's own branch becomes part 1.
- **Replanning.** Parts *will* be wrong. An amended `plan.json` merges on `slug`
  rather than wiping, so in-flight parts keep their branches and PRs. A cockpit
  "replan" button dispatches a planner primed with the current plan and part states.

## Reconciliation

The store holds intent; the outside world stays the source of truth for facts. Each
pulse, next to `worldDiff`, fold observed reality onto the part rows. **Two sources,
and they are good at different things.**

### Git, for branch reality

The harness already has a local clone and shells out to git (`WorktreeManager`), so
branch state is available without spending an API call. A narrow `GitObserver` seam —
same shape as every other seam here, with a scripted fake for tests — answers:

- does the part's branch exist, locally or on the remote
- has it any commits beyond its base (i.e. has the part actually pushed — the
  condition a dependent part stacks on)
- how far ahead/behind its base it is

This is cheap enough to run every pulse, and it is the *only* source that sees a
branch before a PR exists. It needs a `git fetch` to see other people's pushes.

**Git cannot tell you a PR merged.** `merge_pr` uses `method: 'squash'`, and a
squash-merged branch has no ancestry relationship to the base — `git branch --merged`
will never report it. Merge is a provider fact.

### The provider, for PR and merge state

From the world snapshot, as today:

- part branch matches an open PR → record `pr_number`, status `in_review`
- that PR merged → `merged`
- that PR closed unmerged → back to `ready` (the cooldown/attempt cap bounds retries)

## Progress is reported as a tracker comment

Both providers in use — GitHub and Azure DevOps — support comments on an
issue/work item, so that is the one channel that works everywhere. It is also the
only way a human sees plan progress **without opening the cockpit**, which matters
because the graph itself is deliberately local.

New outbound capability on the `ActionSink` seam, a sibling of `postPrReply`:

```ts
interface IssueCommentCapable {
  /** Create the plan's status comment, or update it in place when `ref` is set. */
  upsertIssueComment(input: IssueCommentInput): Promise<SendResult>;
}
```

Implemented by the fake, the `github` issues provider (issue comments API) and the
`azure` work-items provider (`/_apis/wit/workItems/{id}/comments`) — interface plus
scripted fake in the same change, as with every other outbound action.

**One comment per plan, edited in place.** The provider-side comment id is stored on
the `plans` row (`status_comment_ref`) and reused, so an issue accumulates a single
living status comment rather than a stream of them. This mirrors `recordFlag`, which
dedupes by `ref` so an evolving document refreshes rather than piling up.

It is written on three events: the plan being created (so the decomposition is
visible for review before parts start), a part merging, and completion. Like
`set_work_item_state` this is mechanical bookkeeping rather than authored prose, so
it is **not** auto-send gated — the single-comment rule is what keeps it from
becoming noise.

### Completion never closes the issue

When every part is `merged`, the plan goes `complete` and the harness goes **no
further than review**:

- Both providers → update the status comment: all parts merged, with the PR numbers.
- Azure additionally → `set_work_item_state` to `inReviewState`, reusing the existing
  action. GitHub has no equivalent state, so the comment is the whole signal there.

Closing is a human decision. There is no auto-close path, gated or otherwise.

## Stacking mechanics

**Dependency satisfied = the dependency has *pushed a branch*, not merged.** That one
word is the difference between stacking and serialising. The line is drawn at
`in_review` or `merged`, not `dispatched`: a dispatched part's branch exists the
moment its worktree does, but basing on an empty branch gains nothing.

**Base selection.** Dependency's PR still open → base is the dependency's branch.
Dependency merged → base is the default branch. **A part may stack on at most one
open dependency**; any additional dependencies must be merged. Validated at
ingestion. Multi-parent merge bases are not worth the complexity here.

**`WorktreeManager` needs a base parameter.** `ensure(branch)`
(`src/worktree/worktreeManager.ts:35`) creates new branches off whatever the repo
root's HEAD happens to be — no base argument exists. This is the hard blocker for
stacking and is a latent bug regardless: today the base of every agent branch is
incidental. `ensure(branch, base)` fixes both.

**Merge ordering.** Rule 3 merges anything green + approved, which on a stack would
merge part 2 *into part 1's branch* mid-flight. Gate: only `merge_pr` when the PR's
base is the default branch. Stacked children wait for GitHub to retarget them when
their parent merges. Small pure predicate beside `prHealth`.

**Default branch is not configured anywhere.** `'main'` is a hardcoded fallback at
`ruleDispatcher.ts:168` and `fakeGitHub.ts:86`. The merge gate and base selection
both need it to be real config.

**Restacking is free.** When part 1 pushes, part 2 goes `behind` its base and rule 2
dispatches an agent to merge it in — that is already implemented.

**CI attribution is the hazard.** Part 2's CI runs part 1's commits. Part 1 goes red
→ part 2 goes red → rule 1 dispatches an agent onto part 2 to fix a failure that is
not its code, multiplying agents across the whole stack. Needs a pure stack-aware
predicate: suppress the CI rule on a PR whose base PR is itself failing, and push the
concern to the bottom of the stack. Not optional.

## Failure modes

- **Planner crashes, or writes no `plan.json`.** Must not deadlock the issue. After
  the existing attempt cap, fail **open** to `single` — the issue still gets worked
  the way it does today.
- **Planner over-decomposes.** Mitigated by prompt bias and by the fact that a part
  is a normal PR a human reviews. Persistent over-splitting is an operator signal,
  not something to auto-correct.
- **Parts collide.** Concurrency cap plus per-part `scope` in the prompt. Collisions
  surface as conflicts, which rule 2 already handles.
- **Graph outlives reality.** Reconciliation, above.
- **Stale plan after a DB reset.** Accepted. The committed prose plan makes a replan
  cheap.

## Cockpit

- A plan panel per issue: the parts as a stack/graph, each with status, branch, PR
  and the dispatch cut line — the same projection the "Up next" queue already draws.
- The per-issue pickup chip gains plan-aware states (`planning`, `2/5 parts merged`).
- Replan button → a planner primed with current state.

## Config

- `defaultBranch: string` — new, real (replaces the two hardcoded `'main'` fallbacks).
- `planning.enabled: boolean` — off leaves the funnel out entirely and today's
  behaviour intact.
- `planning.maxConcurrentPartsPerIssue: number` (default 2).
- New prompt template ids: `issue-plan`, `plan-part`.

## Staged delivery

Each stage is independently shippable and independently useful.

0. **Unstick the loop.** Resolve `linkedPrNumber` against live PRs so a merged PR
   stops parking its issue; fix the unverified "has open PR" reason; give rule 3b its
   inverse; stop the default prompt auto-closing on the first PR.
   *Independent of everything below and worth landing regardless.*
1. **Base plumbing.** `defaultBranch` config; `WorktreeManager.ensure(branch, base)`;
   the `GitObserver` seam and its fake.
2. **Plans.** Schema + store methods; `plan.json` ingestion; the `issue-plan` rule;
   `single` falling through to today's pickup.
3. **Parts.** The `plan-part` rule; base selection; reconciliation from both sources;
   the status comment (`IssueCommentCapable` + both providers).
4. **Stack safety.** Merge gate; CI attribution; the cockpit plan panel.

Tests follow the existing seam: `buildSystem(config, { backend, streamSpawner,
dbPath: ':memory:' })` exercises inject → plan → part dispatch → stack → merge with
no model and no real terminal. New files: `test/issuePlan.test.ts`,
`test/planIngestion.test.ts`, `test/planReconcile.test.ts`, `test/stackedPrs.test.ts`.

## Decisions

- **The planner runs at the standard model and effort tier.** It is tempting to
  economise on a short structured job, but a weak plan is expensive in a way a
  slightly cheaper agent never repays — every part inherits the decomposition's
  mistakes. No tier knob is added.
- **Never auto-close.** Completion updates the status comment on both providers and,
  on Azure only, moves the work item to the review state. Nothing goes further.
- **Parts inherit the issue's watch/ignore tag.** There is no per-part gate: the
  watch check is evaluated once, on the parent issue, and parts follow. Tagging the
  issue `-ignore` mid-flight stops *new* parts being dispatched; agents already
  running and PRs already open are left alone, matching how PR exclusion behaves.
- **Git is monitored for branch reality**, the provider for merge state.
- **Progress is reported as a single, in-place-edited tracker comment.** Comments are
  the one outbound channel both GitHub and Azure DevOps share, and the only way plan
  progress reaches someone who isn't looking at the cockpit.

## Open questions

1. How often to `git fetch` for the observer — every pulse, or on a slower timer than
   the provider snapshot?
2. Does a part's PR get the plan's context in its body automatically (which part of
   which issue, what it stacks on), or is that left to the agent's prompt?
