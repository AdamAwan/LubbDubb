# 07 — Pull requests

Every PR predicate lives in `src/prHealth.ts`, pure and unit-tested (`test/prHealth.test.ts`,
`test/prExclusion.test.ts`, `test/stackedPrs.test.ts`). The dispatcher, the cockpit and the
`world_read` tool all read them, so all three give one account of a PR.

## `prState(pr)`

Returns `open` \| `merged` \| `closed`, tolerant of the two shapes that reach the harness: the explicit
`state` a closed-PR-aware provider sets, and the bare `merged` flag everything wrote before that
existed. Absent `state` folds onto `merged ? 'merged' : 'open'`.

It **never invents `closed`**. Abandonment has to be observed, because inferring it from a
disappearance is the bug the closed-PR window exists to fix.

## `prHealth(pr, openPrs?)`

Folds a PR's signals into `{ blocked, reasons }` — *why* is this PR stuck. A merged PR is done and is
never blocked. Reasons, most actionable first:

| Condition                                         | Reason                                          |
| ------------------------------------------------- | ------------------------------------------------- |
| `ciStatus === 'failing'`, failure is its own      | `CI failing`                                     |
| `ciStatus === 'failing'`, inherited from the base | `CI failing on base PR #n`                       |
| `isConflicted(pr)`                                | `merge conflicts`                                |
| `mergeableState === 'behind'`                     | `behind base branch`                             |
| `mergeableState === 'blocked'`                    | `merge blocked (required checks/reviews)`        |
| Unhandled comments                                | `N unresolved comment(s)`                        |

The conflict/behind/blocked reasons are mutually exclusive (an `if`/`else if` chain).

`openPrs` is optional stack context. Given it, an inherited CI failure names the PR underneath, which
is the only place an operator sees *why* no agent was dispatched. Omitted, the verdict reads the PR
alone.

## `isConflicted(pr)`

True when the provider says `mergeableState === 'dirty'`, or — when it reported no state at all
(absent or `unknown`) — when the tri-state `mergeable` is a firm `false`. Merged PRs are never
conflicted.

## `needsBaseUpdate(pr)`

`isConflicted(pr) || mergeableState === 'behind'`. False for a merged PR. This is what rule 2
consumes; the dispatcher then splits on `mergeableState === 'behind'` to choose between the
`pr-base-update-behind` prompt (a routine update, no conflicts expected) and
`pr-base-update-conflict` (merge, resolve, push, escalate if not cleanly resolvable).

## Stacks

### `isStackedPr(pr, defaultBranch)`

True when `baseBranch` is present and is not `defaultBranch`. A PR whose base the provider did not
report is **not** treated as stacked — unknown must not silently stop merging PRs that merged fine
before.

This holds rule 3 off the whole stack. Merging a stacked PR would land part 2 **into part 1's branch**
mid-flight: the change lands nowhere real, part 1's review now contains part 2's code, and the stack
is scrambled. A stacked child becomes mergeable on its own the moment the provider retargets it, which
is when its parent merges. There is no separate release step.

### `basePrOf(pr, openPrs)`

The open PR whose *head* branch is this PR's base. Resolved purely from the world, never from the plan
graph — "whose commits is this CI run actually testing" is a PR-level fact, equally true of a stack a
human made by hand. A merged PR is not a base worth attributing to: its commits are in the integration
branch and the provider retargets its children.

### `inheritedCiFailure(pr, openPrs)`

The PR below whose red CI this PR's red CI is inheriting, or `null` when the failure is genuinely its
own. Returns `null` immediately unless this PR's CI is failing. Walks the **whole** base chain, not
just the immediate base, because a base whose own CI is still `pending` must not read as "this failure
is yours". Cycle-guarded, so a provider reporting a base loop cannot spin it.

The hazard: part 2's CI runs part 1's commits, so part 1 going red turns part 2 red, and rule 1 would
put an agent on part 2 to fix code that is not part 2's — multiplying agents up the stack, none able
to fix anything.

Two properties of the fix:

- **Suppress-only, never pushed down.** The concern is dropped on the inheriting PR and nothing is
  re-raised on the base. The failing PR at the bottom is in the same world and rule 1 fires on it
  unaided; pushing would only duplicate it (and land on the `respond_to_agent` path if that branch is
  already staffed).
- **Only the CI concern is suppressed.** Rule 2 still fires, which is what keeps a stack restacking
  the moment its parent pushes.

Both predicates take the **unfiltered** open list — the dispatch world plus `ctx.excludedPrs` — so an
`-ignore`d base still attributes.

## `prAttentionStatus(pr, ctx)`

`src/prAttention.ts`, pure and unit-tested (`test/prAttention.test.ts`). The PR-side sibling of
`issuePickupStatus`: it folds every gate that decides what happens to a PR into one verdict about
**whose turn it is** — `{ status, reasons }`, reasons most actionable first and never empty.

It sits **beside** `prHealth`, not inside it. Health answers *can this merge* and is consumed by the
merge gate's phrasing and by `world_read`'s agent-facing output; attention answers *who is this
waiting on*. The two have different right answers for the same PR — a stacked PR with red inherited
CI is honestly `CI failing on base PR #7` to the first and `waiting on PR #7` to the second — so
folding them would make one of the two a lie every time they disagree.

### The arms, in the order they are checked

| Status      | Court                        | When                                                                       |
| ----------- | ---------------------------- | ---------------------------------------------------------------------------- |
| `done`      | nobody — off the board       | `prState(pr) !== 'open'`.                                                   |
| `ignored`   | nobody, by your instruction  | `isPrExcluded(pr, ignoreLabel)`. First, because the harness filters these out of the dispatch world entirely — every arm below would describe rules that cannot fire. |
| `you`       | yours                        | A **pending proposal** whose ref names this PR; an agent on the branch **parked waiting**; or a concern whose **attempt cap is spent** (rule `cooldown-escalate` handed it to a human). |
| `harness`   | the harness's                | An agent is **running or queued** on the branch; an unstaffed **concern** (rules 1/2/2b) is dispatchable or on cooldown; the PR is **merge-ready** and the merge gate runs next cycle, or an accepted verdict is inside its settle window. |
| `settled`   | nobody — you already answered | Merge-ready, and a **rejection still stands** on `pr:<n>:merge`. The reason quotes the note you left. |
| `elsewhere` | outside the loop             | Stacked on a PR that has to merge first (naming the inherited CI failure when there is one); CI still running; waiting on review; merge blocked by required checks/reviews. |
| `stalled`   | nobody, and that is the point | Everything else: green, approved, unstaffed, unproposed and still not mergeable by rule 3's reading, so no rule will ever act on it and no human has been asked to. The reasons name what is missing. |

Because the first matching arm wins, the ones below it are moot — a PR with an agent on its branch
reads `an agent is working this branch` whatever its CI says, which is the answer prose about health
cannot give.

### What it reads, and what it deliberately does not

- **The same lists the other predicates read**: the **unfiltered** open PR list (the dispatch world
  plus `ctx.excludedPrs`), so an `-ignore`d base still attributes, exactly as `inheritedCiFailure`
  requires; the tasks; the proposals in the store's newest-first order; the recent decision window;
  and the world snapshot's `takenAt` as "now".
- **`proposalHold`, not the proposal row.** The `settled` arm asks the gate, so a rejection that
  stopped standing at the first world event on that PR ([#122](05-dispatcher.md#rule-3--the-merge-gate))
  stops reading as settled at the same instant rule 3 starts firing again. `rejectionSignals` comes
  from the same `rejectionSignalQuery` → `Store.listWorldEventsSince` pair the harness and the
  executor use.
- **`last_actor` is not the predicate**, and cannot be. It works on a closed two-party board where
  every state change has a participant actor; ours is not closed. CI turning a PR red, a base branch
  moving, a third-party review landing all arrive through `worldDiff` with **no participant identity
  attached**, and they are the most common reason a PR needs attention. What transfers is the
  discipline — many gates folded into one pure verdict with reasons — not the signal.
- **`PrComment.author` is not read as a signal.** It is the one place participant identity genuinely
  exists, and branching on it would recreate the two-party assumption in that one corner. An
  unhandled comment is what makes rule 2b dispatch, whoever wrote it: `handled` decides, and the
  author appears only in the wording of a reason.

### Nothing in the dispatcher reads it

It is a **lens**, like `findings` and `overlaps` and unlike the pending-proposal gate. Every input it
folds is already a gate that fires on its own — the branch gate, `proposalHold`, `dispatchVerdict`,
`isPrExcluded` — so a rule reading this verdict would be taking a second opinion about a decision
made elsewhere, from a function sitting nowhere near the rule it duplicates. A verdict the dispatcher
acts on is a new gate with its own failure modes; a verdict only the cockpit reads cannot change what
happens, only what an operator can see. `test/prAttention.test.ts` asserts the property both
structurally (one importer, `src/server/app.ts`) and behaviourally (building the snapshot between two
pulses changes no decision).

The concern list and the merge-readiness test are re-derived here from the same predicates rather
than shared with the dispatcher, which builds prompt-bearing concerns it has no use for — the same
relationship `issuePickupStatus` has to rule 4. The orders are stated once, above and in
[05](05-dispatcher.md), for both.

## `isPrExcluded(pr, label)`

True when `pr.labels` includes the configured ignore label. Pure and provider-agnostic. An empty label
(feature off) or a PR with no labels is never excluded. `Harness.runCycle` uses it to split the open
list; see [04](04-harness-cycle.md).

## The PR rules end to end

For each open, unmerged PR in the dispatch world, the dispatcher builds every concern that would on
its own warrant a code agent, in urgency order:

1. **CI** (`pr:<n>:ci`) — when `ciStatus === 'failing'` **and** `inheritedCiFailure` returns null.
2. **Base** (`pr:<n>:mergeable`) — when `needsBaseUpdate(pr)`. The base is `pr.baseBranch ?? config.defaultBranch`.
3. **Comments** (`pr:<n>:comment:<id>`) — one per unhandled comment.

Then, by the branch's agent state: notify a running agent, hold for a busy one, or make the most
urgent concern a dispatch candidate. Candidates from all PRs are ranked together — concern class
first (CI > base > comment), then PR number — before the headroom cut.

Independently of all that, rule 3 evaluates merge-readiness (see [05](05-dispatcher.md)) and emits
`merge_pr`, which claims no headroom and goes through the executor's auto-send gate.
