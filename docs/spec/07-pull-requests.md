# 07 — Pull requests

Every PR predicate lives in `src/prHealth.ts`, pure and unit-tested (`test/prHealth.test.ts`,
`test/prWatch.test.ts`, `test/stackedPrs.test.ts`). The dispatcher, the cockpit and the
`world_read` tool all read them, so all three give one account of a PR.

## `prState(pr)`

Returns `open` \| `merged` \| `closed`, tolerant of the two shapes that reach the harness: the explicit
`state` a closed-PR-aware provider sets, and the bare `merged` flag everything wrote before that
existed. Absent `state` folds onto `merged ? 'merged' : 'open'`.

It **never invents `closed`**. Abandonment has to be observed, because inferring it from a
disappearance is the bug the closed-PR window exists to fix.

## `prHealth(pr, openPrs?)`

Folds a PR's signals into `{ blocked, reasons }` — _why_ is this PR stuck. A merged PR is done and is
never blocked. Reasons, most actionable first:

| Condition                                         | Reason                                    |
| ------------------------------------------------- | ----------------------------------------- |
| `ciStatus === 'failing'`, failure is its own      | `CI failing`                              |
| `ciStatus === 'failing'`, inherited from the base | `CI failing on base PR #n`                |
| `isConflicted(pr)`                                | `merge conflicts`                         |
| `mergeableState === 'behind'`                     | `behind base branch`                      |
| `mergeableState === 'blocked'`                    | `merge blocked (required checks/reviews)` |
| Unhandled comments                                | `N unresolved comment(s)`                 |

The conflict/behind/blocked reasons are mutually exclusive (an `if`/`else if` chain).

`openPrs` is optional stack context. Given it, an inherited CI failure names the PR underneath, which
is the only place an operator sees _why_ no agent was dispatched. Omitted, the verdict reads the PR
alone.

The `CI failing` reason names the failing checks after the colon when the provider reported them,
capped at three with `+N more`. It names only the ones that actually hold the merge: an **advisory**
check is not a CI check at all, and a check the provider says does **not block completion** cannot be
why the PR is stuck. A _muted_ check is named, because the operator telling the harness to leave it
alone does not stop the provider holding the PR on it.

## `ciNeedsAttention(pr)`

Is there a CI failure the harness should put an agent on? When `ciChecks` carries per-check detail
(non-empty), the answer is exactly that detail: true when any non-advisory check is failing, and
false otherwise — the aggregate is not consulted. Only when there is no detail to defer to
(`ciChecks` `undefined` or empty) does it fall back to `ciStatus === 'failing'`.

Deliberately **not** the same question as `prHealth`. `ciStatus` answers _can this merge_ and is read
by `prHealth`'s blocked verdict and the merge rule; this answers _is a fix owed_, and the two have
different right answers for a check that fails without blocking completion — an Azure "Optional"
branch policy. Folding such a check into the aggregate would claim the PR cannot merge when it can,
and would stop the harness merging it. The aggregate is a fallback, not a second vote, because a
provider reporting no per-check detail has nothing else to answer from — and because a provider's
aggregate can fold a check its own per-check detail marks `advisory` (Azure's policy aggregate does,
since it reads raw policy evaluations without consulting `policyChecks`), in which case the detail
must settle the question rather than be outvoted by the aggregate it disagrees with.

**Three call sites read it and they must not diverge**: rule `pr-ci-failing`'s gate, `inheritedCiFailure`, and
`prAttentionStatus`'s CI reading. A fourth reader added later uses this predicate, or the cockpit
tells an operator a PR is nobody's turn while an agent is being dispatched for it.

Rule `pr-ci-gate` is **not** a fourth reader, deliberately. A check watched in a non-failing state is
not a failure, and answering "is a fix owed" with `true` for one would put it in front of `prHealth`,
the merge rule and `inheritedCiFailure` — three readers asking about a red build. It rides
`classifyWatchedChecks` instead, a separate walk over the same `ci.checks` rules, and moves nothing
this predicate feeds. → [02](02-configuration.md#watching-a-check-that-is-not-failing-states)

## CI checks

`PullRequest.ciChecks` is the per-check detail `ciStatus` folds. Each check carries a `name`, a
`status` (`failing` \| `pending` \| `passing` — never `unknown`), and five optional fields:
`blocking: false` when the provider says it does not hold the merge, `advisory: true` for a signal
something else already models at higher fidelity (no `ci.checks` rule may claim one, in any state),
`expired: true` for a pending check with nothing in flight, `requeueRef` — the provider's own opaque
handle for queueing a fresh run, set only beside `expired` — and `aliases`, other names the provider
shows for the same check.

`expired` is the difference between a check that is waiting and a check that is _stuck_ waiting.
Azure's build-validation policies go `queued` with `context.isExpired` once the branch takes commits
past the last policy build: no build is running and none starts on its own, so the evaluation never
resolves until one is queued. `status` alone cannot say that — a build genuinely in flight reads the
same — so the flag rides beside `pending` rather than becoming a status. Nothing merge-facing reads
it: `ciStatus`, `prHealth` and the merge rule are untouched, because a build that has not run is not
a broken one. The single consumer is `classifyWatchedChecks`, which watches an expired check **with
no `ci.checks` rule naming it**, putting the PR in rule `pr-ci-gate`'s hands — which, where the check
carries a `requeueRef` and no operator guidance, settles it with one provider write rather than an
agent ([05](05-dispatcher.md#pr-ci-gate-a-check-that-waits-rather-than-fails)). That default is the
provider stating a fact rather than an operator stating a preference, which is why it is not left to
config: the config-only alternative — `states: ["pending"]` on the build checks — also fires on every
build that is merely mid-flight, dispatching an agent to release a gate that was about to release
itself. An operator who wants it back can still shadow the default with a rule claiming the check in
`pending` and ignoring it — `{ "match": "NXG-CI", "states": ["pending"], "onFailure": "ignore" }` — which
is the case for a deployment where every push expires the same required build. That rule claims nothing
when the build genuinely goes red, so its failures keep dispatching; `states: ["failing", "pending"]`
would mute both. The pending-only `ignore` is legal _because_ of this default, and `validateCiPolicy`
refused it until the default existed. → [02](02-configuration.md#watching-a-check-that-is-not-failing-states)

`aliases` exists for Azure's status policies, which have two names and neither is redundant. The
harness keys the check by `statusGenre/statusName` (`pr-agent-review/reviewed`, from
`policyDisplayName`), while the label on the pull request page comes from `settings.defaultDisplayName`
(`PR-Agent-Reviewed`) — so a glob an operator wrote by copying what they could see matched nothing,
silently. A `ci.checks` glob is now tried against the name **and** every alias; `name` stays what the
cockpit renders and what a briefing quotes, so no existing rule changes meaning and no row is renamed
under an operator reading it.

## `isConflicted(pr)`

True when the provider says `mergeableState === 'dirty'`, or — when it reported no state at all
(absent or `unknown`) — when the tri-state `mergeable` is a firm `false`. Merged PRs are never
conflicted.

## `needsBaseUpdate(pr)`

`isConflicted(pr) || mergeableState === 'behind'`. False for a merged PR. This is what rule `pr-base-update`
consumes; the dispatcher then splits on `mergeableState === 'behind'`, and the two arms cost
different things.

- **`behind`** — the provider has said the merge is clean, so the harness asks it to merge the base in
  itself: an `update_pr_branch` act, no worktree and no agent. The `pr-base-update-behind` prompt is
  still rendered, but only for the fallback — a provider that cannot do the merge (Azure DevOps has no
  such endpoint) or refuses it gets the code agent on the next pulse instead.
  → [05](05-dispatcher.md#pr-base-update--two-arms)
- **`dirty`** — `pr-base-update-conflict`, and a code agent: merge, resolve, push, escalate if not
  cleanly resolvable. Resolving a conflict is judgement, so it is never taken directly.

## Stacks

### `isStackedPr(pr, defaultBranch)`

True when `baseBranch` is present and is not `defaultBranch`. A PR whose base the provider did not
report is **not** treated as stacked — unknown must not silently stop merging PRs that merged fine
before.

This holds rule `pr-merge-ready` off the whole stack. Merging a stacked PR would land part 2 **into part 1's branch**
mid-flight: the change lands nowhere real, part 1's review now contains part 2's code, and the stack
is scrambled. A stacked child becomes mergeable on its own the moment its base becomes the default
branch, which is when its parent merges. There is no separate release step.

**GitHub retargets a merged parent's children itself; Azure does not.** That asymmetry used to be an
unstated assumption here, and on Azure it stopped a stack dead: the rung above a merged one kept
targeting a branch that no longer received anything, `isStackedPr` went on holding it back, and
nothing anywhere said why. `retargetsFor` (below) closes it.

### `basePrOf(pr, openPrs)`

The open PR whose _head_ branch is this PR's base. Resolved purely from the world, never from the plan
graph — "whose commits is this CI run actually testing" is a PR-level fact, equally true of a stack a
human made by hand. A merged PR is not a base worth attributing to: its commits are in the integration
branch and the provider retargets its children.

### `inheritedCiFailure(pr, openPrs)`

The PR below whose red CI this PR's red CI is inheriting, or `null` when the failure is genuinely its
own. Returns `null` immediately unless `ciNeedsAttention(pr)`. Walks the **whole** base chain, not
just the immediate base, because a base whose own CI is still `pending` must not read as "this failure
is yours". Cycle-guarded, so a provider reporting a base loop cannot spin it.

It reads `ciNeedsAttention` rather than the aggregate at both ends of the walk, because a non-blocking
check runs the base's commits exactly as a required one does and so propagates up the stack the same
way. Reading the aggregate would leave one red Optional check at the bottom putting an agent on every
PR above it, each unable to fix anything — the multiplication this predicate exists to prevent.

The hazard: part 2's CI runs part 1's commits, so part 1 going red turns part 2 red, and rule `pr-ci-failing` would
put an agent on part 2 to fix code that is not part 2's — multiplying agents up the stack, none able
to fix anything.

Two properties of the fix:

- **Suppress-only, never pushed down.** The concern is dropped on the inheriting PR and nothing is
  re-raised on the base. The failing PR at the bottom is in the same world and rule `pr-ci-failing` fires on it
  unaided; pushing would only duplicate it (and land on the `respond_to_agent` path if that branch is
  already staffed).
- **Only the CI concern is suppressed.** Rule `pr-base-update` still fires, which is what keeps a stack restacking
  the moment its parent pushes.

Rule `pr-ci-gate` is held by the same attribution and no more: a rung whose real problem is the red
base below it does not also collect an agent for its waiting gate, but a rung of an otherwise-healthy
stack keeps its own. A status policy is evaluated per pull request, so each rung genuinely has a gate
of its own to clear — suppressing those would park the whole stack on the bottom one, which is the
mirror-image failure of the multiplication above.

Both predicates take the **unfiltered** open list — the dispatch world plus `ctx.unwatchedPrs` — so an
unwatched base still attributes.

### `retargetsFor(openPrs, closedPrs, defaultBranch)`

The rungs whose base should move, as `PrBaseInput[]`. For each open PR whose `baseBranch` names the
branch of a PR that left the open set **merged** (`prState`, within `closedPrWindowMs`), the target is
that merged PR's own base — the default branch for a two-deep stack, the next rung down for a taller
one.

- **Merged parents only.** An **abandoned** parent strands the rung above it on purpose: the work
  beneath never landed, so rebasing onto the default branch would silently drop the premise the rung
  was built on. That is a human's call, and `prState` never invents `closed` from absence.
- **Idempotent.** A PR already targeting the right branch yields no input, so a settled world costs
  one comparison per PR and no writes.
- **Run on both providers.** The write is a no-op on GitHub, which has already done it. A
  provider-conditional would be a second answer to "who retargets" living nowhere near the one that
  matters.

Performed by `PrNamingDesk` on the pulse through `ActionSink.setPullBase`. Mechanical bookkeeping like
the plan's status comment, so it goes through no proposal; a failure is recorded and never fails the cycle.

### `buildStacks(openPrs, plans, parts, defaultBranch)`

The stack model — chains of open PRs, each based on the one beneath it — as `Stack[]`, each carrying
bottom-first `rungs`.

**Derived, never stored.** The edge is the one `basePrOf` walks, so a stack is a fact about the world
and the world is re-read every pulse; a `stacks` table would be a second answer to a question the
world answers, needing reconciling the way `plan_parts` already does.

**A plan adopts a stack; it never owns one.** Rung identity is the pull request, so a chain someone
opened by hand is a stack on exactly the same terms as one a plan produced — which is the point, since
`plan_parts` was previously the only record that a chain was a chain. The plan is adopted from the
parts the rungs deliver, not from a branch-name convention.

**It is a lens.** Nothing in `src/dispatcher/` may read it: every input it folds is already a gate
that fires on its own, so a rule consulting it would be a second opinion about a decision made
elsewhere. `test/stacks.test.ts` asserts that structurally — no file under `src/dispatcher/` names
`stacks/`, and the only importer is `src/server/stateSnapshot.ts`.

A chain of one is not a stack. A merged rung is not a base. A cycle in the base edges terminates
rather than hanging the pulse. It takes the **unfiltered** open list, so an unwatched rung does not
put a hole in the chain.

### Landing a stack

An operator's standing authorization to merge a whole chain: one click, and each rung's merge is
accepted as it is proposed, until the chain is gone or something goes wrong. The record is
`StackLanding`, the table is `stack_landings` (`src/store/landings.ts`), and the logic is
`src/stacks/landing.ts`.

**It adds no merge path, and it is not a loop.** Rule `pr-merge-ready` proposes exactly one merge per
chain — the bottom rung, the only one `isStackedPr` does not hold — and the rung above it becomes
proposable only once that lands and the provider retargets it, which is observed on a **later pulse**.
So the chain already lands bottom-up across cycles; the intent only decides who says yes. A merge
still happens exactly one way: a `merge` proposal accepted through `ActionExecutor.runAuthorized`.

A synchronous "merge each rung in order" loop is therefore wrong twice over — it would block on a
retarget that has not happened, or merge the bottom rung and report that it merged three.

**The scope is the rung PR numbers, not the stack ref.** `Stack.ref` is `stack:<bottom rung's PR
number>`, and the bottom rung is precisely the one that merges first — so the ref is stable only until
the intent's first success. Keying on it would land one rung and orphan the intent, silently. Keying
on the numbers captured at the click also makes the authorization exactly what the operator read: a
rung stacked _on top_ afterwards is not in the list, so it is not authorized, and no rule is needed to
say so. `landingFor` matches an intent to a chain by rung overlap for the same reason.

**The decider is `stack_landing`, a third one.** Not `auto_send`: that answers "the harness cleared its
own confidence threshold", and this answers "the operator authorized this chain in advance". The
proposal's note names the intent and when it was given, and `authorityOf` keeps the row grouped with
the pulse rather than prefixing it `human:` — the prefix marks a decision applied _outside_ a cycle,
which this is not.

**The button is offered only when every rung is clear** (`landingReadiness`), and it is disabled
rather than warned about: offering it while a rung above the bottom is unread would authorize merging
code whose ladder the operator cannot see. Clear means CI passing, approved, no unresolved comments,
no conflict. `behind` and `blocked` are deliberately **excluded** — a rung is behind because the one
beneath it has not landed, and it clears itself on retarget, so counting it would withhold the button
from every real stack. The line: the operator is authorizing _code they have read_, and `behind` is a
fact about the queue, not about the code.

**A rung that goes red stops the intent** (`settleLandings`, run once per pulse from the harness).
It does not wait, and it does not resume. Rule `pr-merge-ready` already refuses to propose a red rung,
so nothing merges either way; the only question is whether the intent waits silently or says so. Waiting
silently means CI fails, an agent fixes it three cycles later, and the merge is authorized — landing
code in a state nobody saw. Three things stop an intent: a remaining rung faults, a remaining rung
leaves the open set without merging, or a merge the intent authorized fails at the sink (without which
it would be re-proposed and retried every cycle after the settle window). Stopping records the reason
**and raises an escalation**, because a chain that drops below two rungs stops being a stack and its
head line leaves the rack entirely.

**"Left the open set without merging" is judged against the durable record, never against
`closedPullRequests`.** That list is a window — it carries a merge for `closedPrWindowMs` and then
forgets — and an intent routinely outlives it: a three-rung chain where each retarget re-runs CI and
waits on a review takes longer than the window by design, and the taller the stack the more certain
it is. Read off the window alone, a rung the harness itself merged reappears as neither open nor
merged and stops the chain with the reason *"nothing says it merged"* — a stop that is factually
false, is never resumed, and silently reverts the feature to per-rung clicking. `settleLandings` and
`landedCount` therefore ask `Store.mergedPrs()` — the work graph, which is upsert-only for exactly
this reason — before they ask the world. Without it the cockpit's "landing 1 of 3" also counts back
*down* to 0 of 3 as rungs age out. The `gone` arm itself stays: a rung genuinely closed without
merging still stops the chain.

**Stopping and offering are asked by different predicates, and must be.** `rungFault` is not the
negation of `rungVerdict`: retargeting a rung re-runs its checks, so every rung passes through
`pending` on its way to landing, and stopping there would stop every intent at its first success.
Pending waits. Only a definite adverse verdict — CI failing, approval explicitly withdrawn, a new
unresolved comment, a real conflict — stops the chain. An absent `approved` is unknown, not withdrawn.

A stopped intent is never resumed. The button returns once the rungs are clear, and that click is the
operator re-authorizing a chain they have looked at again.

`settleLandings` **never calls `buildStacks`** — it re-reads the chain from the intent's own numbers
and the world, which is what keeps the lens out of the harness's per-pulse decision path. The only
place the model is consulted is `landingScope`, at the click, in the route.

## Reaping a merged branch

When a pull request merges, the branch behind it is deleted — the worktree and the local ref, then
the branch on the remote. `reapableBranches` (`src/branchReap.ts`) is the predicate, pure and
unit-tested; `BranchReapDesk` performs it on the pulse, beside the rename and the retarget and in
the same register: mechanical bookkeeping through no proposal, a failure recorded and never failing
the cycle. **Unconditional** — there is no key to turn it off.

A branch is reapable when all of:

- **Its pull request merged.** `prState(pr) === 'merged'`, read from the closed-PR window. An
  **abandoned** PR's branch holds work that never landed, so deleting it destroys the only copy —
  the same line `retargetsFor` draws, and `prState` never invents `closed` from absence.
- **The pull request is ours** — `isOurPr` (`src/prOwnership.ts`), the gate `renamablePrs` uses,
  asked in one place because two wordings of "which pull requests are mine" would drift.
- **Nothing still stands on the branch.** It is not `defaultBranch`, and no open pull request names
  it as `baseBranch`. **This is the load-bearing one**: deleting the base of an open PR orphans it,
  and GitHub closes it outright. `retargetsFor` moves a rung off its merged parent, but that write
  lands on a **later pulse** — and on Azure it is the only thing that moves it at all. So a merged
  parent is held until the world shows nothing based on it. Holding costs one pulse; reaping first
  destroys a stack silently.
- **No agent is on it** — no `queued`/`running`/`waiting` task on the branch, the same guard the
  worktree reap in `system.ts` applies.
- **It has not been reaped already** — the `branch_reaps` row, keyed on the pull request rather than
  the branch, so a branch name re-cut and landed a second time is reaped again.

The local half is `Worktrees.deleteBranch`: the worktree, then `git branch -D`. **`-D`, not `-d`** —
`merge_pr` squashes, and a squash-merged branch has no ancestry link to its base, so `-d`'s
merged-check says no for every branch this is ever called on and the reap would silently delete
nothing. The safety `-d` offers is already given by the predicate above.

Local first, then remote: a failed remote delete is retried next pulse, while a failed local delete
after the remote copy is gone leaves nothing to retry against. A branch already absent on the remote
is **success**, not failure — see [15](15-integrations.md).

## Naming

Every pull request the harness opens is titled from `pr-title`, an ordinary overridable entry in the
prompt book — the `finding-ticket` argument: the wording is what an operator has opinions about, and a
prompt is where those already live.

### `prTitleFields(input)` / `renderPrTitle(template, fields)`

Pure. The fields are assembled as **finished clauses**, not raw values: `{position}` is empty for a PR
that stacks on nothing (a lone PR is not "1/1"), and `{kind}` is empty when the agent declared no
type, `type: ` with no scope, `type(scope): ` with one. So an override stays a plain substitution and
never has to express the conditionals — otherwise every override re-implements them and they drift.
Substitution is `renderTemplate`'s, since an override is placeholder-validated against the same book.

Placeholders: `{number} {title} {position} {total} {type} {scope} {kind} {summary}`. The shipped
default is `#{number} {position}{kind}{summary}`. The spec commits to the placeholders, not the
arrangement.

### The body is not templated

Only the title is. There is no `pr-body` entry in the prompt book, and there will not be one: a title
is a convention over a fixed set of known fields, and a body is an account of a change only the agent
that made it has. A template could produce a shape, not a reading — and a shape filled in by an agent
with nothing to say is exactly the thirty-line `## Summary` / `## Changes` / `## Testing` restatement
of the diff the reviewer already has.

What the harness does own is the **reference**, appended by `open_pr` after the agent's text and never
a closing keyword ([11](11-mcp-tools.md#open_pr)). Everything above it ships as written.

That leaves the form of the body expressible in exactly one place: the description of `open_pr`'s
`body` argument, which states it — a bullet list, five bullets at most, why the change is needed
first, one line each, no headings and no prose paragraphs. It reads as an odd place for a house style
until you notice it is the only place the agent reads before writing.

### `renamablePrs(prs, ctx)` — and what may be renamed

`userId` is the gate, because it is already the operator's answer to "which pull requests
are mine", and both providers apply it **at fetch time**:

- **Set** — every PR in the world is theirs _by construction_; the provider never surfaced anyone
  else's. All of them are renamable, and no attribution logic exists here at all.
- **Unset** — the world holds everyone's PRs and the harness cannot tell them apart, so it falls back
  to the branch shapes only a dispatch mints (`issue/<n>`, `issue/<n>/<slug>`). Derived rather than
  stored: recording every opened PR number would be a second answer to a question the branch answers.

**A colleague's pull request is renamed under neither arm.** A PR that resolves to no issue is left
alone — the convention is keyed on an issue number. A merged PR is never renamed. The render strips
any prefix it would itself have written, so renaming twice does not stack prefixes.

Performed by `PrNamingDesk` on the pulse through `ActionSink.setPullTitle`, and idempotent: only PRs
whose rendered title differs from the live one are written, so a world already on convention writes
nothing.

## `prAttentionStatus(pr, ctx)`

`src/prAttention.ts`, pure and unit-tested (`test/prAttention.test.ts`). The PR-side sibling of
`issuePickupStatus`: it folds every gate that decides what happens to a PR into one verdict about
**whose turn it is** — `{ status, reasons }`, reasons most actionable first and never empty.

It sits **beside** `prHealth`, not inside it. Health answers _can this merge_ and is consumed by the
merge gate's phrasing and by `world_read`'s agent-facing output; attention answers _who is this
waiting on_. The two have different right answers for the same PR — a stacked PR with red inherited
CI is honestly `CI failing on base PR #7` to the first and `waiting on PR #7` to the second — so
folding them would make one of the two a lie every time they disagree.

### The arms, in the order they are checked

| Status      | Court                         | When                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `done`      | nobody — off the board        | `prState(pr) !== 'open'`.                                                                                                                                                                                                                                                                                                                                            |
| `unwatched` | nobody — nobody opted it in   | `!isPrWatched(pr, watchLabel)`. First, because the harness filters these out of the dispatch world entirely — every arm below would describe rules that cannot fire.                                                                                                                                                                                                 |
| `you`       | yours                         | A **pending proposal** whose ref names this PR; an agent on the branch **parked waiting**; a concern whose **attempt cap is spent** (rule `cooldown-escalate` did); or a failing check the **CI policy holds** (rule `pr-ci-blocked` handed it to a human) **with no other concern under it** — a held check that is one of two problems is a reason, not the court. |
| `harness`   | the harness's                 | An agent is **running or queued** on the branch; an unstaffed **concern** (rules `pr-ci-failing`/`pr-ci-gate`/`pr-base-update`/`pr-review-comment`) is dispatchable or on cooldown; the PR is **merge-ready** and the merge gate runs next cycle, or an accepted verdict is inside its settle window.                                                                |
| `settled`   | nobody — you already answered | Merge-ready, and a **rejection still stands** on `pr:<n>:merge`. The reason quotes the note you left.                                                                                                                                                                                                                                                                |
| `elsewhere` | outside the loop              | Stacked on a PR that has to merge first (naming the inherited CI failure when there is one); CI still running; waiting on review; merge blocked by required checks/reviews.                                                                                                                                                                                          |
| `stalled`   | nobody, and that is the point | Everything else: green, approved, unstaffed, unproposed and still not mergeable by rule `pr-merge-ready`'s reading, so no rule will ever act on it and no human has been asked to. The reasons name what is missing — including the **muted-only** case below.                                                                                                       |

Because the first matching arm wins, the ones below it are moot — a PR with an agent on its branch
reads `an agent is working this branch` whatever its CI says, which is the answer prose about health
cannot give.

### How long it has been waiting on a reviewer

The `waiting on review` arm carries `reviewWaitingSince` — the instant this pull request started
waiting — and it is the only arm that ever does. Every other reading here is about an instant; this
one is about a **span**, and a span is not recoverable from a snapshot: no provider payload says
"reviewable since", GitHub's `updated_at` moves for a label change, and the creation date is not the
answer either, since a pull request that spent two days red was not waiting on anybody for those two
days.

So it is observed as it happens. `awaitingReview(pr, staffed)` (`src/prHealth.ts`, pure) is folded
once per pulse into `pr_review_waits` ([14](14-persistence.md)) as a **watermark**: one row per
waiting pull request, written only when absent and deleted the moment it stops waiting. A plain
upsert would set it to now on every pulse and read as "waiting five minutes" forever.

`awaitingReview` is **deliberately a superset of the arm**, and this is the one place two readings of
one thing are allowed to differ. The arm is reached only after seven earlier ones decline the pull
request; reproducing all seven in the predicate would be a second copy of the verdict, free to drift.
The predicate lives in `prHealth` rather than beside the arm because nothing outside the state
snapshot may import the lens and the pulse has to fold it. So the clock runs more eagerly and the
_arm_ decides whether an age is ever shown — a pull request whose clock is running but whose court is
the harness's shows nothing, which is the safe direction. Red CI, an unhandled comment and a staffed
branch each stop the clock, because a reviewer cannot be late for work that is not ready.

**It changes no court and gates nothing.** `waiting on review` stays `elsewhere` however long it has
been: on a team the reviewer is somebody else, and an obligation that is not yours does not belong in
"Needs you" — a queue of other people's obligations is what makes an inbox stop being read. Nothing
dispatches, escalates or files a task at any threshold, because the harness has no more idea than the
operator does how to make a colleague review faster. The whole of its effect is an age on the court
chip from the first pulse it is observed waiting ([17](17-cockpit.md#the-overview)).

### The CI policy decides the court, not `ciStatus`

`ciStatus` is a fold, and this verdict is about courts, so reading the aggregate alone was wrong in
two directions. `ciReading` (private, asked once and threaded into three arms) classifies the failure
through the same `classifyCiFailures` the dispatcher calls, off the same `config.ci` — carried on the
context as **policy** rather than as a pre-computed verdict, so nothing depends on the snapshot having
classified the PR first, and asking a pure function twice is one answer rather than two.

- _*Actionable*_ → the CI concern is raised and the PR is the harness's, as before. Rule `pr-ci-failing` dispatches
  only when the verdict is actionable, so raising the concern off `ciStatus` promised an agent for a
  check the policy had already taken off the table.
- **Held by policy** (`ciNeedsHuman`: nothing to dispatch, something to escalate) → **`you`**, naming
  the checks. Rule `pr-ci-blocked` has already filed the escalation; what was missing was the PR row
  saying so instead of promising an agent that will never be sent. Asked after the staffed arm, beside
  the spent attempt cap, because those are the two ways a failing check stops being the harness's
  problem without being fixed.

  **Asked _below_ the concern fold, though, and this is the whole of why it sits there.** `ciNeedsHuman`
  says there is nothing to dispatch _for the CI failure_ and says nothing at all about the PR's other
  concerns — rules `pr-review-comment` and `pr-base-update` staff those from the same loop iteration
  that raised the escalation. Answered above the fold, the arm printed _"so no agent will be sent"_ on
  the pulse an agent went out, which is the mirror image of the promise it was added to stop, and the
  denial was in the reason text rather than merely implied. So a held check with a concern under it is
  carried as a trailing reason — `<checks> failing — held by the CI policy` — behind the concern that
  is actually being staffed, and the unqualified sentence is kept for the case where it is true: the
  held check is the only thing outstanding. The shape an operator hits this in is long-lived (an infra
  gate stays red for as long as it takes a person to chase it), so it is the whole of that span the PR
  row would otherwise understate.

- **Muted only** (every failure `ignore`d) → falls through to **`stalled`**, and the reason says the
  merge gate still reads CI as failing. Nothing dispatches and nothing escalates, yet rule `pr-merge-ready`'s merge
  test reads the aggregate, so nothing will ever move the PR. The old wording — `CI has not reported`
  — was untrue of a check that reported and was muted, and it was the one phrasing that hid the gap
  rather than naming it.
- **Watched, not failing** (`classifyWatchedChecks`, rule `pr-ci-gate`'s set) → the gate concern is
  raised on `pr:<n>:ci-gate` and the PR is the **harness's**. This is the arm that had been wrong the
  longest: a blocking check sitting `pending` fell past every concern to `elsewhere` / "CI is still
  running", which was an honest reading of a PR nobody was going to act on and is a lie about one an
  agent is being dispatched for. Read whether or not anything is also failing, because the whole case
  is a PR that is **not** red.
- **An inherited failure reads as no failure at all**, checked inside `ciReading` rather than per arm,
  for the reason rule `pr-ci-failing` suppresses the concern: the fix belongs to the PR underneath and the
  `elsewhere` arm names it. So a policy that would otherwise escalate cannot make a stacked PR your
  problem for its parent's red build.

### What it reads, and what it deliberately does not

- **The same lists the other predicates read**: the **unfiltered** open PR list (the dispatch world
  plus `ctx.unwatchedPrs`), so an unwatched base still attributes, exactly as `inheritedCiFailure`
  requires; the tasks; the proposals in the store's newest-first order; the recent decision window;
  and the world snapshot's `takenAt` as "now".
- **`proposalHold`, not the proposal row.** The `settled` arm asks the gate, so a rejection that
  stopped standing at the first world event on that PR ([#122](05-dispatcher.md#pr-merge-ready--the-merge-gate))
  stops reading as settled at the same instant rule `pr-merge-ready` starts firing again. `rejectionSignals` comes
  from the same `rejectionSignalQuery` → `Store.listWorldEventsSince` pair the harness and the
  executor use.
- **`last_actor` is not the predicate**, and cannot be. It works on a closed two-party board where
  every state change has a participant actor; ours is not closed. CI turning a PR red, a base branch
  moving, a third-party review landing all arrive through `worldDiff` with **no participant identity
  attached**, and they are the most common reason a PR needs attention. What transfers is the
  discipline — many gates folded into one pure verdict with reasons — not the signal.
- **`PrComment.author` is not read as a signal.** It is the one place participant identity genuinely
  exists, and branching on it would recreate the two-party assumption in that one corner. An
  unhandled comment is what makes rule `pr-review-comment` dispatch, whoever wrote it: `handled` decides, and the
  author appears only in the wording of a reason.

### Nothing in the dispatcher reads it

It is a **lens**, like `findings` and `overlaps` and unlike the pending-proposal gate. Every input it
folds is already a gate that fires on its own — the branch gate, `proposalHold`, `dispatchVerdict`,
`isPrWatched` — so a rule reading this verdict would be taking a second opinion about a decision
made elsewhere, from a function sitting nowhere near the rule it duplicates. A verdict the dispatcher
acts on is a new gate with its own failure modes; a verdict only the cockpit reads cannot change what
happens, only what an operator can see. `test/prAttention.test.ts` asserts the property both
structurally (one importer, `src/server/stateSnapshot.ts`) and behaviourally (building the snapshot between two
pulses changes no decision).

The concern list and the merge-readiness test are re-derived here from the same predicates rather
than shared with the dispatcher, which builds prompt-bearing concerns it has no use for — the same
relationship `issuePickupStatus` has to rule `issue-pickup`. The orders are stated once, above and in
[05](05-dispatcher.md), for both — and **asked for** once, through `concernUrgency`, rather than
re-derived: three re-derivations of one ordering is the arrangement the rule numbers rotted under, and
a lens on the wrong one of them drifts silently, because both readings stay individually plausible.

What re-derivation cannot give itself is a check that the two agree, so `test/prAttention.test.ts`
sweeps a table of PR shapes — {comment present} × {CI arm} × {`mergeableState`} × {decision history} —
through **both** `prAttentionStatus` and a real `RuleDispatcher.decide`, asserting that an act on a
`pr:<n>:*` origin implies `harness` naming that same concern, and an escalation with nothing dispatched
implies `you`. Every defect this section now describes — the stale order, the origin nothing dispatches,
the held-check denial printed over a dispatch — was green against both suites' own fixtures and red on
the first cell of that table.

## Watching

A pull request is worked only while it carries `${labelPrefix}-watch`. `isPrWatched(pr, watchLabel)`
is the whole predicate — pure, provider-agnostic, and an empty label (feature off) reads as watched.
`Harness.runCycle` uses it to split the open list; see [04](04-harness-cycle.md).

Opt-in on its own would stop the harness acting on the pull requests it opened itself, so the harness
**tags its own**, programmatically and never by asking an agent to:

- **At creation.** `open_pr` writes the tag the moment the provider returns a number, so a pull
  request the fleet just opened is never briefly invisible to the fleet.
- **On the pulse.** `PrWatchDesk` tags any open pull request on a branch only a dispatch cuts —
  `issue/<n>`, `issue/<n>/<slug>`, `job/<id>`, the one predicate `isHarnessBranch` in
  `src/prOwnership.ts` — that carries no tag. That is the floor under the first: an agent that opened
  its own after the tool reported itself unwired, a code job's pull request, and every pull request
  already open the first pulse a deployment runs this.

**Exactly once per pull request, and `pr_watch_seeds` is what makes it once.** Taking the tag off is
how an operator stops the fleet on a runaway agent's pull request; a seeder that re-derived its
answer from the world alone would write the tag straight back on the next pulse, and the control
would silently undo itself. The row goes down only after the label write succeeds, so a failed write
is retried rather than marked done — and `POST /api/prs/:n/watch` writes a row too, in both
directions, because a human's answer must outrank the seeder just as much as the seeder's own past
one.

The one thing the seeding will not do is tag a pull request carrying the retired
`${labelPrefix}-ignore` tag ([06](06-issue-pickup.md#the-retired-ignore-tag)): everywhere else that
label is inert, and this is the single path that could wake the fleet on work somebody parked under
the old model.

## Linking the work item

**A pull request the harness opened carries a link to the work item it was opened for, written on the
tracker rather than named in prose.** The two providers disagree about what a link is, and that
disagreement is the whole reason this exists:

- **GitHub** reads the `Relates to #12` `open_pr` appends to the body and cross-references the issue
  itself. There is nothing to write.
- **Azure DevOps** does not. A work item and a pull request are linked by an **artifact link relation
  on the work item** — `vstfs:///Git/PullRequestId/{projectId}%2F{repositoryId}%2F{prId}` — and
  nothing else. Azure derives a pull request's `workItemRefs` from those relations and the create-PR
  payload's copy is read-only, so a pull request cannot be opened already linked. Prose in the
  description satisfies nothing.

That mattered because of one branch policy. **Check for linked work items** blocks a pull request
carrying no relation, so on Azure the fleet was opening pull requests that were blocked from the
moment they existed, and the only thing that moved them was a code agent — a model call, a worktree
and a context window spent rediscovering a number the harness had held on a row since pickup. The
work item is not a judgement. It is `issueForPr(pr, issues)` in `src/prIssue.ts`: the pull request
the issue links, else the issue its `issue/<n>` branch names — **the same predicate the rename reads**,
asked once so the number in a pull request's title and the number on its tracker link cannot
disagree.

So the link is written the way the tag is, and in the same two places:

- **At creation.** `open_pr` links the moment the provider returns a number, so a pull request is
  never briefly blocked by the policy that was about to be satisfied.
- **On the pulse.** `PrWorkItemDesk` links any open pull request that `isOurPr` claims and
  `issueForPr` resolves. The floor under the first, for the watch seeding's reasons.

Both go through `linkPrWorkItem` in `src/prWorkItemDesk.ts`, the one write path, exactly as both
tagging paths go through `seedPrWatch`.

**`ok: false` is "this provider does not need it", not a failure.** `CompositeConnector.linkWorkItem`
answers it when no integration is `WorkItemLinkCapable` — GitHub, where the body already links — and
that is the second act with that contract, after `updatePrBranch`. No row is written for it: recording
one would be the harness claiming credit for a write it never made, and would suppress the retry if
that deployment ever moved to Azure.

**Exactly once per pull request, and `pr_work_item_links` is what makes it once.** Two things make
the world's own answer insufficient. Deleting a link is how somebody says the harness picked the wrong
work item, and a desk re-deriving from the world would write it straight back next pulse — the watch
seeding's argument. And `linkedPrNumber` folds a work item's relations down to the **last** pull
request to cross-reference it, so on a plan whose parts each open one, the earlier parts read as
unlinked however many links really exist. The row goes down only after the link write succeeds.

The one world reading kept beside the row is `linkedPrNumber === pr.number`, which is the provider
stating that this exact link is already there. It is what stops a deployment upgrading onto the desk
from re-sending a link for every pull request already carrying one.

A duplicate relation is absorbed rather than raised: Azure answers one with a 400, `isRelationAlreadyExists`
recognises it, and "the link you asked for is there" is not an entry the operator's Errors panel needs.
A permission failure — a PAT without **Work Items (write)** — is not absorbed, and surfaces as itself.

**The `workItems` policy kind stays `off` by default** ([15](15-integrations.md)). Nothing about this
changes what the harness _dispatches_ for; it changes whether the gate is ever unsatisfied. An operator
who wants the policy visible as a check can now promote it knowing the fleet clears it mechanically.

## The PR rules end to end

For each open, unmerged PR in the dispatch world, the dispatcher builds every concern that would on
its own warrant a code agent, in urgency order:

1. **Comments** (`pr:<n>:comments`) — **one concern for every unhandled thread on the PR**, not one per
   thread.
2. **CI** (`pr:<n>:ci`) — when `ciNeedsAttention(pr)` **and** `inheritedCiFailure` returns null.
3. **Base** (`pr:<n>:mergeable`) — when `needsBaseUpdate(pr)`. The base is `pr.baseBranch ?? config.defaultBranch`.
   A concern either way, because a staffed branch is _told_ about its base moving whichever arm it is
   on; only the free-branch outcome differs, and only for `behind`, which is settled by an act rather
   than by an agent.

Then, by the branch's agent state: notify a running agent, hold for a busy one, or make the most
urgent concern a dispatch candidate. Candidates from all PRs are ranked together — an operator-flagged
`urgent` CI check first, then concern class (comment > CI > gate > base), then PR number — before the
headroom cut.

That class ranking is `concernUrgency` (`src/dispatcher/rules.ts`), which **reads the order off
`DISPATCH_PIPELINE`** rather than restating it, and it lives beside the pipeline because it has two
callers: the rule, and `prAttentionStatus`'s concern fold. The lens used to encode the order in the
order its pushes happened to appear in, and so was left on the pre-reorder one when comments moved to
the front — it led an operator with CI while the agent went out for the review, and, because the top
concern also decides which cooldown budget is read, flipped the court outright once the two origins'
histories diverged. One order, asked for in both places, is what keeps the list above true of both.

**Comments lead, and that is the whole ordering decision.** A review is the one PR signal that can
invalidate the diff rather than report something wrong around it: a reviewer asking for a different
approach means the code the CI failure is about, and the hunks the merge conflict is in, are both
about to be rewritten. An agent sent at CI or at the base first spends itself on work the next push
discards — and, for the base merge, resolves the same conflict twice, because the rewrite re-conflicts
the branch. Neither concern is lost; each gets its agent on the diff the review settled on.

### A review is answered as a whole

A review is written as a unit: the same person leaves three comments in one pass, each assuming the
others. One concern per thread meant one agent per thread, a cycle apart — so a fix for comment 1
landed without comment 3 in view, and the two contradicted each other or made the same edit twice.
The comment concern therefore folds **every** unhandled thread on the PR: one origin, one attempt cap,
one agent, with all of the threads in its prompt (`reviewThreadsNote`, `src/dispatcher/reviewThreads.ts`).

Two things fall out, and both are load-bearing:

- **The threads are appended to the rendered prompt, never interpolated.** `pr-review-comment` is
  operator-overridable and `loadPromptTemplates` rejects only _unknown_ placeholders, so an override
  written against the older one-comment prompt declares no token for a thread list — interpolating
  would hand exactly the deployments that customised most a single comment out of five, silently.
  `{author}` and `{comment}` stay declared and filled (with the joined author list and the first
  thread's body) so such an override still renders something true. Same rule as `ciFailureNote`.
- **De-dup stays per thread, because dispatch granularity and notification granularity are different
  questions.** The dispatch origin `pr:<n>:comments` names the whole review; `pr:<n>:comment:<id>`
  names one thread and is what `respond_to_agent` de-dup keys on — **and `prAttentionStatus` reads
  `pr:<n>:comments` for the same reason the dispatcher writes it**, importing `prCommentsOrigin`
  rather than re-typing the string. The lens keyed its review concern on the per-thread ref instead,
  which is not a dispatch origin at all: it asked the cooldown ledger about a key no decision row ever
  carries, found zero attempts on every review, and so promised an agent on a review whose attempt cap
  rule `cooldown-escalate` had already handed to a human. One origin means one attempt cap means one
  reading of whose turn it is. Keyed on the origin alone, a
  reviewer's fourth comment would be swallowed by the origin the first three already claimed — the
  signal an operator sends while reviewing an agent's work as it goes. `PrConcern.signals` carries the
  thread refs; `dispatch_code_agent.signalRefs` records the ones a dispatch already put in an agent's
  prompt, since `activeOrigins` sees task origins only and cannot tell that the running agent was
  launched with those threads (`dispatchedSignalsByBranch`).

### The agent checks the list again before it finishes

The thread list in the prompt is a reading taken at dispatch, and a review keeps moving: a reviewer
leaves a fourth comment, or rewords the second, while the agent is working. The notify path above
covers only part of that — it delivers a thread the agent was **never told about**, and only while
the agent is `running`. An edit to a thread already in its prompt is no new signal, so it reaches
nobody, and a thread landing after the agent's last turn waits for the next dispatch: another attempt
against the cooldown cap, and at the cap a human instead of an agent.

So the agent is asked to close that gap itself. `reviewRecheckNote` (`src/dispatcher/reviewThreads.ts`)
is appended after the thread list and tells it to call `world_read("pr", "pr:<n>")` before finishing
and compare `unresolvedComments` against the threads it was handed: a thread that is not in the
prompt arrived after it started and is its to answer, and a body that no longer matches was edited.
It is the same snapshot the dispatch was decided against, carrying `observedAt`, so the note also
says to read once more at the end of a long run. The agent then accounts for every thread by id,
which is what makes a missed one visible rather than merely absent.

Appended, never interpolated, for the reason above and one more: an override written before this
existed cannot know to ask for the re-check, and those are the deployments where an agent silently
answering a stale review costs the most.

The thread ref is also the ref a refused `reply_draft` proposal is filed under, so `rejectionGuidance`
takes the **list** of refs a dispatch names — its origin plus its signals — and matches each whole.
That is not a widening to the world item, which must never happen there: matching the origin alone
would have silently stopped every operator refusal reaching an agent.

What makes a thread stop being unhandled is the provider's business, and both providers read the
tracker's real resolution verdict first — see [15](15-integrations.md). Resolving a thread in the
GitHub or Azure UI is therefore the ordinary way to tell the harness a comment is dealt with; the
harness's own reply is the fallback for a thread nobody resolved.

Independently of all that, rule `pr-merge-ready` evaluates merge-readiness (see [05](05-dispatcher.md)) and emits
`merge_pr`, which claims no headroom and is always written as a proposal for you.
