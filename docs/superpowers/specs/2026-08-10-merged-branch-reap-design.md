# Reaping a merged branch

Design — 2026-08-10.

## The gap

When rule `pr-merge-ready` merges a pull request, nothing cleans up after it. The worktree goes when
the code agent is reaped `done` (`src/system.ts`), which is a fact about the agent, not about the
merge — and the **local branch ref and the remote branch both survive forever**. A long-running
deployment accumulates one dead branch per landed PR on both sides.

This adds the missing step: once the harness observes a PR **merged**, it reaps that branch locally
and on the remote.

The trigger is the merge, not the review approval. A branch whose PR is approved but not landed
still holds the only copy of the work.

## Selection — `reapableBranches`, a pure predicate

New module `src/branchReap.ts`, pure and unit-tested, in the same register as `retargetsFor` — the
predicate and the desk that performs its writes live in separate files, as `prRetarget.ts` and
`prNamingDesk.ts` already do.

`reapableBranches(world, ctx)` yields `BranchReapInput[]` (`{ prNumber, branch }`), where `ctx`
carries the default branch, whether `filters.prAuthor` is configured, the tasks, and the set of
already-reaped pull request numbers — so the function stays pure and the store read happens in the desk. A
branch is reapable when every one of these holds:

- **The PR merged.** `prState(pr) === 'merged'`, read from `world.closedPullRequests` — the
  closed-PR window. An **abandoned** PR is never reaped: the work under it never landed, and
  `prState` never invents `closed` from absence. Same line `retargetsFor` draws, for the same
  reason.
- **The PR is ours.** The `renamablePrs` gate, exactly: `filters.prAuthor` set means every PR in the
  world is ours by construction, so all of them qualify; unset falls back to the branch shapes only
  a dispatch mints (`issue/<n>`, `issue/<n>/<slug>`). That test moves out of `prRename.ts` into one
  shared predicate rather than being written a second time — two differently-worded answers to
  "which pull requests are mine" is how the two drift.
- **Nothing is standing on it.** The branch is not `config.defaultBranch`, and no other pull request
  — open, or in the closed window — names it as `baseBranch`.
- **No agent is on it.** No task on the branch is `queued`, `running` or `waiting`. The same guard
  the worktree reap in `system.ts` already applies: an agent can still be finishing on a branch
  whose PR has merged.
- **It has not already been reaped.** No `branch_reaps` row for that pull request (below).

### Why the base check is load-bearing

Deleting a merged parent's branch while the rung above it still targets that branch orphans the
child pull request, and on GitHub the provider closes it. `retargetsFor` moves such a rung onto the
merged parent's own base, but that write lands on a **later pulse** — and on Azure it is the only
thing that moves it at all, since Azure does not retarget a stack itself.

So the reap holds while anything still bases on the branch. It costs one extra pulse and it cannot
destroy a stack; reaping first is silent and unrecoverable.

## The writes

### Remote

`ActionSink` gains `deleteBranch(input: BranchDeleteInput): Promise<SendResult>`, behind a
`BranchDeleteCapable` capability probe beside `PrBaseCapable` and `PrTitleCapable` in
`src/integrations/integration.ts`. GitHub deletes the ref (`DELETE /git/refs/heads/<branch>`); Azure
updates the ref to the zero object id. Both `*Api` interfaces and both scripted fakes gain the
method in the same change.

**A branch that is already gone is a success, not a failure.** A repository with GitHub's
"automatically delete head branches" setting on will have deleted it at merge time, so
already-absent is the common case rather than an error, and recording it as one would put a
permanent stream of noise in the error log on exactly the repos that are configured best.

### Local

`Worktrees` gains `deleteBranch(branch: string): Promise<void>` — `git worktree remove --force` when
one is registered, then `git branch -D`. Force, not `-d`: `merge_pr` squashes, and a squash-merged
branch has no ancestry link to its base, so `-d` would refuse every time. `FakeWorktreeManager`
gains it too, so no test cuts or deletes a branch in the checkout the suite is running in.

`ensure`/`remove` was deliberately the whole seam; this is a third method because there is now a
third thing its consumer asks for, not because the seam wants widening.

### Order

Local first, then remote. A failed remote delete is retried on the next pulse; a failed local delete
after the remote is already gone leaves nothing to retry against.

## Where it runs

A `BranchReapDesk` (`src/branchReapDesk.ts`), run once per pulse from `Harness.runCycle` beside
`PrNamingDesk`, and threaded through `src/system.ts` like every other component.

Not a dispatcher rule: it claims no headroom and dispatches no agent, and a rule that wrote to the
provider directly would bypass the candidate list. Not a proposal either — this is mechanical
bookkeeping in the same sense as PR renaming and stack retargeting: nothing is deciding *whether* to
reap, only carrying out a convention the operator configured. So it is deliberately not auto-send
gated.

A failure is recorded through `errors.record({ source: 'cycle', ... })` and never fails the cycle.

## Remembering what was reaped

A merged pull request stays in the closed-PR window for `closedPrWindowMs` (6h by default), so
without a record the desk would re-issue a delete for an already-gone branch on every pulse for six
hours.

New table `branch_reaps`, owned by a new store module `src/store/branchReaps.ts` taking the usual
`{db, now}` `StoreContext`, with `Store` delegating under the same method names: `{ pr_number,
branch, at }`, one row written after a successful reap, read by the predicate as the already-reaped
gate. A brand-new table needs no `ColumnMigrations` entry.

**Keyed on the pull request, not the branch.** A branch name is reusable — `issue/12` can land, be
re-cut by a later dispatch and land again — and a row keyed on the name would suppress the second
reap silently and forever, since the table is unbounded in age.

Stored rather than derived because the world does not answer the question. "Has this branch been
reaped" is not visible in any provider payload, and asking git or the provider per merged PR per
pulse would be a read per PR to avoid a write per PR.

## Configuration

One key, `reapMergedBranches`, **defaulting to `true`**. This is a missing step in the workflow
rather than an option, so the flag is the escape hatch for a repository where a merged branch is
someone else's expectation — not the opt-in.

No secret is involved, so it is an ordinary `lubbdubb.config.json` key.

## Errors

Every failure path routes through `errors.record` and none of them fails the cycle:

| Failure                             | Handling                                                    |
| ----------------------------------- | ----------------------------------------------------------- |
| Remote branch already absent (404)  | Success. The reap is recorded and never retried.            |
| Remote delete fails otherwise       | Recorded; no `branch_reaps` row, so it is retried next pulse. |
| Local `worktree remove` / `branch -D` fails | Recorded; the remote delete is not attempted this pulse.    |

## Tests

Unit tests on `reapableBranches`, one per gate: an abandoned PR is not reaped; a colleague's merged
PR is not reaped under either arm of the author gate; a branch another PR still bases on is held; a
branch with an active task is held; a branch with a `branch_reaps` row yields nothing.

`buildSystem` tests with `FakeWorktreeManager`, `dbPath: ':memory:'` and the scripted provider fake:

- a merged PR's branch is gone from the worktree manager and from the provider after one pulse, and
  a `branch_reaps` row exists;
- a merged parent whose child still targets it is **not** reaped until the retarget lands, and is
  reaped on the pulse after;
- a provider reporting the branch already absent still records the reap and issues no second delete;
- `reapMergedBranches: false` reaps nothing.

## Documentation

Same change, per the repo's one documentation rule:

- [07 — Pull requests](../../spec/07-pull-requests.md): a "Reaping a merged branch" section stating
  the predicate and why the base check holds.
- [02 — Configuration](../../spec/02-configuration.md): `reapMergedBranches`.
- [14 — Persistence](../../spec/14-persistence.md): the `branch_reaps` table and its store module.
- [15 — Integrations](../../spec/15-integrations.md): `BranchDeleteCapable` and the two providers'
  implementations.
