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

**Empty is two different states, and only one of them defers to the aggregate.** The fallback is for a
provider that had nothing else to answer from; a provider that had the detail and was configured not
to emit it — every reportable policy at `policyChecks` mode `off` — sets `ciChecksWithheld`, and a
withheld reading answers `false` rather than falling back. Read as the same silence, `off` would be
more actionable than `advisory`: the strongest mode the only one that still dispatches, and the agent
told nothing about which check is red. `classifyCiFailures` splits its own pre-policy arm on the same
flag, so the predicate and the verdict cannot disagree.

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

`isConflicted(pr) || mergeableState === 'behind'`. False for a merged PR. This is what rules
`pr-base-update` and `pr-base-update-conflict` consume; the dispatcher splits on
`mergeableState === 'behind'`, and the two arms cost different things — which is why they are two
rule ids over one predicate, so `agentModels.byRule` can price them apart.

- **`behind`** — the provider has said the merge is clean, so the harness asks it to merge the base in
  itself: an `update_pr_branch` act, no worktree and no agent. The `pr-base-update-behind` prompt is
  still rendered, but only for the fallback — a provider that cannot do the merge (Azure DevOps has no
  such endpoint) or refuses it gets the code agent on the next pulse instead.
  → [05](05-dispatcher.md#pr-base-update--two-arms)
- **`dirty`** — rule `pr-base-update-conflict`, its like-named prompt, and a code agent: merge,
  resolve, push, escalate if not cleanly resolvable. Resolving a conflict is judgement, so it is never
  taken directly. → [05](05-dispatcher.md#pr-base-update--two-arms)

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

Both predicates take the **unfiltered** open list — the dispatch world plus `ctx.hiddenPrs` — so an
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

**A fork is every path, not one of them.** A branch with two open PRs based on it yields one `Stack`
per root-to-leaf path, sharing the rungs beneath the split. This is not a hypothetical world: it is
what the planning funnel produces for a diamond plan, since `partBase` returns the first unsettled
dependency's branch and `dependencySatisfied` clears a part as soon as its dependency has pushed, so
two parts depending on the same part are both dispatched and both based on it. Walking one child per
rung dropped the second sibling from **every** chain — it is not a bottom, because `baseOf` resolves,
and no walk reached it — so it had no head line, no readiness verdict and no landing control, while
`isStackedPr` stayed true for it so no rule would merge it either. Worse, which sibling survived was
the provider's list order, and a stack is meant to be a fact about the world.

Because a fork's paths share a bottom, `Stack.ref` names the leaf as well when — and only when — the
bottom carries more than one chain: `stack:<bottom>:<leaf>`, against `stack:<bottom>` for the linear
case, which is every ref written before forks were modelled. `landingFor` follows: rung overlap alone
identified an intent only while a PR belonged to one chain, so it now also rejects an intent covering
a rung that is **still open** and outside the chain being drawn. Still open is load-bearing — a chain
shrinks as its rungs merge, and rejecting on a merged rung would lose the intent at its first success,
which is the thing the rung-keying exists to prevent.

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
no conflict, not `blocked`, and a `mergeable` the provider has actually computed. `behind` is
deliberately **excluded** — a rung is behind because the one beneath it has not landed, and it clears
itself on retarget, so counting it would withhold the button from every real stack. The line: the
operator is authorizing _code they have read_, and `behind` is a fact about the queue, not about the
code.

**The offer gate must be no weaker than rule `pr-merge-ready`'s test on anything that does not clear
itself**, and `behind` is the only thing that does. Where the two disagree there is no exit: the
button is offered, the click is accepted, the intent is recorded — and then nothing merges, because
the rule requires `mergeable === true` and a state that is not `blocked`, and nothing stops the
intent either, because `rungFault` needs a definite adverse verdict. The chain stands at "landing 0
of N" indefinitely with no escalation and no reason, which is exactly the silence `settleLandings`
exists to make impossible. So `blocked` is consulted — it is not a fact about the queue, since a rung
held back by its parent reports `behind`, and `prAttentionStatus` reads `blocked` as a required check
or reviewer a person has to resolve — and so is an absent `mergeable`, which is the provider still
computing after a retarget and resolves itself, so the button simply returns on the pulse it does.
`rungFault` gains neither: the offer gate is strict, the stop gate needs a definite adverse verdict,
and a `mergeable` that goes null mid-landing is the `pending` case the two predicates exist to differ
on.

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
merged and stops the chain with the reason _"nothing says it merged"_ — a stop that is factually
false, is never resumed, and silently reverts the feature to per-rung clicking. `settleLandings` and
`landedCount` therefore ask `Store.mergedPrs()` — the work graph, which is upsert-only for exactly
this reason — before they ask the world. Without it the cockpit's "landing 1 of 3" also counts back
_down_ to 0 of 3 as rungs age out. The `gone` arm itself stays: a rung genuinely closed without
merging still stops the chain.

**Stopping and offering are asked by different predicates, and must be.** `rungFault` is not the
negation of `rungVerdict`: retargeting a rung re-runs its checks, so every rung passes through
`pending` on its way to landing, and stopping there would stop every intent at its first success.
Pending waits. Only a definite adverse verdict — CI failing, approval explicitly withdrawn, a new
unresolved comment, a real conflict — stops the chain. An absent `approved` is unknown, not withdrawn.

A stopped intent is never resumed. The button returns once the rungs are clear, and that click is the
operator re-authorizing a chain they have looked at again.

**Revocation is reachable for as long as the intent stands, including after the chain stops being a
stack.** `DELETE /api/stacks/:ref/land` reads the ref for the rung it names (`stack:<bottom PR>`) and
finds the intent by what it covers — keyed on a rung end to end, not only in the desk. It must not
resolve the ref through `landingScope`, because that resolves through `buildStacks` and a chain of
one is not a stack: the moment a two-rung chain's bottom rung merges, every ref an operator could
send 404s while the intent goes on authorizing the survivor's merge. That is the same orphaning the
rung-keying exists to prevent, arriving at the last rung instead of the first, and the 404 body reads
"no open stack" — which a person reasonably takes to mean nothing is standing. The model may still
widen the search (a ref whose own rung is in no intent may name a chain whose other rungs are); it
may never gate it. `POST` keeps going through `landingScope`, because the scope of an authorization
is the server's own reading of the chain and `DELETE` authorizes nothing.

`StackLandingView` follows: `stackLandings` is the chains above **plus a row for every standing
intent no chain accounts for**, so the stop control is drawable on a one-rung remainder. Such a row
carries `offer: false` — there is no chain left to land, only one to stop.

**A settlement is only ever written from a world every source reported fresh.** A settle is the one
terminal write in the pulse that a later pulse cannot revise — `settleStackLanding` is a
compare-and-set onto a terminal status, so unlike `observePartPr` or `retainedRunIssues` it does not
correct itself when the provider recovers. And a world with a stale slice is exactly the world in
which rungs go missing: a provider serving its last-good list under-reports, and every rung it fails
to report reads as having left the open set. One bad pulse would otherwise end the operator's chain
permanently, naming a pull request that never changed. So a pulse carrying any
[`staleSources`](03-world-model.md#worldsnapshot) settles nothing — the _landed_ arm included, since
"all rungs merged" is as unsupportable from a world nobody could read as "a rung is gone" is.
`staleSources` names the integration rather than the slice, so there is no way to ask whether it was
the source-control half that went old; any stale source at all stops the settle.

`settleLandings` **never calls `buildStacks`** — it re-reads the chain from the intent's own numbers
and the world, which is what keeps the lens out of the harness's per-pulse decision path. The only
place the model is consulted is `landingScope`, at the click, in the route.

## Whose pull request is it

`isOurPr(pr, prAuthorConfigured)` / `isSomeoneElsesPr(pr)` (`src/prOwnership.ts`), asked in one place
because several paths need it and two wordings of "which pull requests are mine" would drift.

**`PullRequest.viewerAuthored` is the answer, and the provider is the only thing that can give it.**
It is the pull request's author compared against the identity the credential actually is — the
viewer — never against `filters.prAuthor`. Both providers set it on the open list and on the
closed-PR window, at no extra request: the author rides on the payload the snapshot already reads.

**`prAuthor` is not that answer**, and stopped being a usable proxy for it the day `ownWorkOnly`
widened the fetch to the pull requests a colleague **assigned** the operator
([#a-pull-request-a-person-put-on-you](#a-pull-request-a-person-put-on-you)). With the filter set,
somebody else's pull request is in the world _by design_ — so reading "it was fetched" as "it is
ours" had the harness renaming a colleague's pull request, tagging it for watching, reaping its
branch on merge, and, through rule `pr-review-comment`, **dispatching an agent that answered their
reviewers**. On a single-operator deployment nothing about that is red: the reply is posted under the
operator's own account, so it reads to the other team as the operator talking.

So the filter survives only as the fallback where authorship is unknown:

| `viewerAuthored` | `isOurPr`                                         | `isSomeoneElsesPr` |
| ---------------- | ------------------------------------------------- | ------------------ |
| `true`           | yes                                               | no                 |
| `false`          | no — under every arm, dispatch branch included    | **yes**            |
| absent           | `prAuthor` configured, or a dispatch branch shape | no                 |

**The two predicates are not each other's inverse, and must not be folded into one.** "Is this ours,
so we may rename it" fails safe by saying no; "is this somebody else's, so hide it from every rule"
has to fail safe by saying no as well — a provider that cannot name an author would otherwise take
every watched pull request out of the dispatch world and stop the fleet with nothing red. That is why
the absent row above answers `no` to both.

`isHarnessBranch(branch)` is the unknown arm's second half: `issue/<n>`, `issue/<n>/<slug>` or
`job/<id>`, the branch shapes only a dispatch cuts. Derived rather than stored — recording every
opened PR number would be a second answer to a question the branch already answers.

### What it gates

- **The dispatch world.** `Harness.runCycle` hides a pull request somebody else opened from
  `world.pullRequests` exactly as it hides an unwatched one, and hands both over as `ctx.hiddenPrs`
  ([04](04-harness-cycle.md)). No rule fires on either — no CI fix, base update, review, reply or
  merge — and the reasons are different but the requirement is one: the fleet works its own.
- **The bookkeeping desks** — `renamablePrs`, `reapableBranches`, `prWorkItemLinks`, all through
  `isOurPr`.
- **The watch seeding.** `prsToSeedWatch` tags the fleet's own untagged pull requests off the branch
  shape; a branch shape is evidence, not proof, so a pull request the provider says a colleague
  opened is never tagged however it is named.

Still fully visible in the cockpit, with its health, its threads and who opened it: the snapshot
reads the connector directly. `prAttentionStatus` gives it `elsewhere`, and where a person **put** the
operator on it, that assignment turns it straight back into `you`
([#a-pull-request-a-person-put-on-you](#a-pull-request-a-person-put-on-you)) — a review a colleague
asked for is the operator's to answer, and never the fleet's.

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
- **The pull request is ours** — `isOurPr` ([#whose-pull-request-is-it](#whose-pull-request-is-it)),
  the gate `renamablePrs` uses, asked in one place because two wordings of "which pull requests are
  mine" would drift. A colleague's branch is never deleted, and that one is irreversible.
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

### Naming a pull request

**`#12` is a work item on Azure DevOps, and `!12` is the pull request.** GitHub has one id space and
resolves `#12` either way; Azure has two disjoint ones and two sigils to tell them apart — the same
fact `azureRefUrl` refuses to guess on ([15](15-integrations.md)). So a body that names a sibling pull
request as `#12` on Azure does not fail to link. It links, confidently, to an unrelated ticket, and
nothing about that is red: the description renders, the sigil is live, and only a reader who follows
it finds a work item about something else.

`src/prRef.ts` holds the whole of it — `prRefStyle(provider)` picks the sigil from
`integrations.sourceControl` and `prRef(n, style)` writes one reference. Threaded from `system.ts` to
every place a pull request is named in prose that somebody else reads:

- **What the agent is shown.** `siblingContext` and `currentPlanSummary` name each part's pull request
  (`(PR !40)`), and an agent writing its own description copies the form it was given.
- **What the agent is told.** `open_pr`'s `body` argument description names the sigil and says why —
  the only text the agent reads immediately before writing a body ([11](11-mcp-tools.md#open_pr)).
- **What the harness publishes.** The plan's status comment on the tracker names each part's PR.

**The issue reference is deliberately not routed through it.** `Relates to #12` means the tracker item
on both providers, so `open_pr`'s appended reference is already right on Azure — and the work-item link
it writes beside it is what actually satisfies the branch policy anyway (below).

### `renamablePrs(prs, ctx)` — and what may be renamed

`isOurPr` is the gate ([#whose-pull-request-is-it](#whose-pull-request-is-it)) — the same one the
merged-branch reap asks, answered in one place.

**A colleague's pull request is never renamed.** A PR that resolves to no issue is left
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
| `elsewhere` | somebody else's               | `isSomeoneElsesPr(pr)` ([#whose-pull-request-is-it](#whose-pull-request-is-it)) — hidden from the dispatch world beside the unwatched, so no rule below can fire either. Named `elsewhere` rather than a status of its own because the fold below turns it into `you` the moment they put the operator on it.                                                        |
| `you`       | yours                         | A **pending proposal** whose ref names this PR; an agent on the branch **parked waiting**; a concern whose **attempt cap is spent** (rule `cooldown-escalate` did); or a failing check the **CI policy holds** (rule `pr-ci-blocked` handed it to a human) **with no other concern under it** — a held check that is one of two problems is a reason, not the court. |
| `harness`   | the harness's                 | An agent is **running or queued** on the branch; an unstaffed **concern** (rules `pr-ci-failing`/`pr-ci-gate`/`pr-base-update`/`pr-base-update-conflict`/`pr-review-comment`) is dispatchable or on cooldown; the PR is **merge-ready** and the merge gate runs next cycle, or an accepted verdict is inside its settle window.                                      |
| `settled`   | nobody — you already answered | Merge-ready, and a **rejection still stands** on `pr:<n>:merge`. The reason quotes the note you left.                                                                                                                                                                                                                                                                |
| `elsewhere` | outside the loop              | Stacked on a PR that has to merge first (naming the inherited CI failure when there is one); CI still running; waiting on review; merge blocked by required checks/reviews.                                                                                                                                                                                          |
| `stalled`   | nobody, and that is the point | Everything else: green, approved, unstaffed, unproposed and still not mergeable by rule `pr-merge-ready`'s reading, so no rule will ever act on it and no human has been asked to. The reasons name what is missing — including the **muted-only** case below.                                                                                                       |

### A pull request a person put on you

`PullRequest.viewerAssignment` ([03](03-world-model.md#pullrequest)) is the one thing the world reports
about a pull request that **no rule reads**. Everything else — a red check, an unhandled comment, a
base that moved — is something the harness acts on; an assignment is an obligation a colleague handed
the operator, and the fleet will do nothing about it whatever it says. So it is folded in _after_ the
arms above, by `prAttentionStatus` itself, and it does two different things depending on what they
answered:

| The arms said                         | The assignment                                                                                                                                                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unwatched` / `elsewhere` / `stalled` | **is the court.** Nothing in the harness is coming — no rule will fire, no proposal is waiting, no agent is on it — so the assignment is the whole answer to whose turn it is, and it leads the reasons. The arm's own reason survives behind it as why the fleet is silent. |
| anything else                         | **is a reason.** A pull request with an agent on its branch is the harness's whoever it is assigned to, and one whose merge is waiting on a verdict already has a row. The clause is appended so the surface still says it, and `assignedToYou` stays unset.                 |
| `done`                                | **is nothing.** A merged pull request is off the board, and an assignment on one is a fact about a thing that has finished.                                                                                                                                                  |

`assignedToYou` carries the kind on exactly the first row, and it is what the queue rail keys on
([17](17-cockpit.md#the-queue-rail--needs-you)) — a field rather than the leading reason's wording, so
rephrasing a sentence cannot silently empty the queue.

**The clause names the person who asked**, because that is the whole of what makes it an obligation
rather than a form field. `PullRequest.author` ([03](03-world-model.md#pullrequest)) is read for it and
for nothing else, and it rides on the payload the snapshot already fetches, so it costs no request:

| `viewerAssignment`  | With an author                                  | With none reported                   |
| ------------------- | ----------------------------------------------- | ------------------------------------ |
| `reviewer-optional` | `Priya Raman marked you as a reviewer`          | `you have been marked as a reviewer` |
| `reviewer-required` | `Priya Raman marked you as a reviewer`          | `you have been marked as a reviewer` |
| `assignee`          | `Priya Raman assigned this pull request to you` | `assigned to you`                    |

**Which kind of reviewer is deliberately not in the sentence.** It is `assignedToYou`, and a surface
that wants to say it reads the field — the queue rail draws it as `Required reviewer` /
`Optional reviewer` on the row's metadata line ([17](17-cockpit.md#the-queue-rail--needs-you)). Saying
it in the clause as well would put a real distinction in a string that any rewording can silently
drop, which is the same reason the queue does not key on the wording either.

### When the assignment ends

A review request is a question, and a question the operator has already answered is not still theirs.
`PullRequest.viewerApproved` — **their own** approving vote, never the `approved` fold, which is any
reviewer's — demotes the assignment from _the court_ to _a reason_, exactly as an agent on the branch
does: the clause survives as `… — you have approved it` so the row still says how the pull request came
to be theirs, and `assignedToYou` stays unset, which is what takes it off the rail.

Without it the row a colleague raised stands until the pull request merges, which teaches an operator
that answering the rail changes nothing on it — the one lesson a queue must never teach.

**Absent is never a verdict.** A provider that does not resolve a vote leaves the row exactly where it
was; it costs the operator the clearing and nothing else. Both providers resolve it from the reviewer
list the assignment itself came from ([15](15-integrations.md)), so neither pays a request for it.

**`waiting on review` is the arm this changes most**, and deliberately. It stays `elsewhere` on a pull
request the operator merely opened, because on a team the reviewer is somebody else and a queue of
other people's obligations is what makes an inbox stop being read
([above](#how-long-it-has-been-waiting-on-a-reviewer)). On a pull request that names **them** as the
reviewer it is the same sentence about the opposite person, and leaving it `elsewhere` would be the
surface telling an operator that the thing waiting on them is waiting on somebody else.

**A group is never an assignment.** Both providers list a team exactly as they list a person, and an
identity resolved through team membership is not somebody asking — folding the two would put every
pull request in the org on the rail, which is the one way to make the rail stop being read. The
providers resolve it ([15](15-integrations.md)); the lens takes what they say.

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

**An assignment is the second arm that carries it**, and it is the same clock rather than a second
one. Where an assignment takes over a court ([above](#a-pull-request-a-person-put-on-you)), the
reviewer the wait is about **is** the operator, so the verdict carries the watermark whichever arm the
assignment displaced — including `unwatched` and `stalled`, which never reach the `waiting on review`
arm and so carried no age at all, the case the rail shows most. The queue row draws it as its age
([17](17-cockpit.md#the-queue-rail--needs-you)). Nothing else moves: the predicate, the fold, the
watermark and every rule about when the clock runs are untouched — what an assignment changes is only
_whose_ wait it is.

An assigned pull request whose clock is **not** running — red CI, an unhandled comment, a staffed
branch, or one the harness has not yet observed a pulse of — draws no age, exactly as before. That is
the same safe direction the predicate takes: a reviewer cannot be late for work that is not ready.

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
  plus `ctx.hiddenPrs`), so an unwatched base still attributes, exactly as `inheritedCiFailure`
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

## Review threads

A pull request's review reaches the harness twice, from one reading.

`unresolvedComments` is the fold every dispatch rule consumes: one `PrComment` per thread, keyed on
the thread's root comment, carrying `handled` — the single bit that decides whether rule
`pr-review-comment` has work — with the thread's replies on it, so the fold is the whole conversation
and not only its opening line ([below](#the-thread-is-the-conversation)). `reviewThreads` is the same
threads with the state kept as well: who wrote each message, where the thread hangs in the diff, and
one of four states.
The providers build the threads and derive the comments from them (`threadComments` in
`src/prThreads.ts`), so a thread the cockpit draws as open and a comment list that calls it handled
cannot happen — there is one derivation, not two.

| state      | what it means                                                                 | `handled` |
| ---------- | ----------------------------------------------------------------------------- | --------- |
| `open`     | no reply the harness recorded sending stands last in the thread               | no        |
| `answered` | the newest reply is one the harness recorded sending; it is with the reviewer | yes       |
| `resolved` | the reviewer closed the thread — their own verdict                            | yes       |
| `reopened` | the operator put it back to the fleet, whatever the provider says             | no        |

The first three are exactly the two arms `handled` always folded, said out loud. They are worth
separating because the fold is right for dispatch and wrong for a person: "3 handled" cannot tell an
operator whether a review is finished or whether three answers are sitting unread on a reviewer.

**`reviewThreads` is optional and its absence is a third answer.** A provider that does not report
threads leaves it unset, and the cockpit says so in those words. Drawing that as "no review threads"
would claim nobody has reviewed the change, which is the opposite of what is known.

Both providers already read what this needs, so nothing here costs a request. GitHub joins the REST
review comments to the GraphQL resolution read it was already making (`buildReviewThreads` in
`src/integrations/github/sourceControl.ts`); Azure reads the thread status and `threadContext` off
the threads it already fetches (`src/integrations/azure/sourceControl.ts`). A provider that reports
no file or line leaves `path`/`line` unset and the thread is drawn without a place rather than with
a guessed one.

### The thread is the conversation

`PrComment` carries **`replies`** alongside the root's `body`, and `threadComments` fills it from the
thread it folds. The root alone is not a review thread — it is where one started.

This was the harness's second way of losing a reviewer's words, and it looked identical to the first
from the outside. Everything an agent reads about a review is built off `unresolvedComments`: the
thread list in the `pr-review-comment` prompt (`reviewThreadsNote`), the line a running agent gets
when a thread moves (`reviewThreadNote`), and `world_read`. All three rendered `body`, which is the
**root** and nothing else. So a reviewer's follow-up narrowing a finding, or an operator's reply
saying which of a bot's five comments actually needs fixing and what the fix is, was read off the
provider, recorded, drawn in the cockpit — and dropped on the way to the only reader that acts on it.
The agent answered the opening comment of a conversation it could not see the rest of, which to the
person who wrote the reply is indistinguishable from the fleet ignoring them, and is worse than the
silence: an answer arrives, confidently, to a question nobody asked.

`replies` is **absent rather than empty** on a thread nobody answered, so a provider that reports no
replies and a thread that has none are one answer to every reader — neither is a conversation to
render, and nothing that predates this changes shape.

Three things follow from carrying it:

- **The transcript names its authors, and marks the fleet's own replies.** Unmarked, an agent reads
  the harness's last answer back as a fresh instruction and makes the same change twice. `ours` is
  the record (above), so the badge is never on a person's message.
- **The newest message is stated to be the live ask** (`lastWordNote`). A list of threads with
  replies under them still reads as a list of comments to answer one by one; a reviewer who narrows
  a finding replies rather than editing what they wrote first, so the opening comment is where the
  thread started and not what it now wants. Appended only when some thread has a reply — a root-only
  review renders exactly as it did before this existed.
- **Notify de-dup keys on `prCommentSignalRef`, not on the thread ref.** De-dup asks "has this agent
  already been told this", and keyed on the thread alone the answer is yes forever after the first
  delivery — so a follow-up on a thread already in the running agent's prompt reached nobody, which
  is precisely the feedback an operator gives while watching an agent work. The key is the thread ref
  plus the id of its newest message, so it moves when the conversation does. It is a second function
  rather than a change to `prCommentOrigin`, because that string is a *ref*: it is what a refused
  `reply_draft` proposal is filed under and what `rejectionGuidance` matches whole, and it has to
  stay the same across the life of a thread. A key that must move and a ref that must not are two
  jobs.

### Attribution is a record, never an identity

`answered` and `PrThreadMessage.ours` both turn on one question — _did the fleet write this reply?_ —
and the answer is a **row in `pr_replies_sent`**, written when the reply went out. Never the author.

The identity rule it replaces read "the reply's author is `config.userId`". That identity is the
credential the harness posts under, and on a single-operator deployment it is the operator's own
account. Their follow-up on their own review thread therefore came back as the harness's: the cockpit
drew a "fleet" badge on a message a person wrote, the thread flipped to `answered`, that folded to
`PrComment.handled` — the only bit rule `pr-review-comment` reads — and their comment was marked as
work already done and never dispatched for. Nothing went red, because by every type in the system
nothing was wrong.

Every reply the harness sends leaves through exactly one call site, `sink.postPrReply` in
`src/executor/actionExecutor.ts`, and `SendResult.commentRef` carries the provider's own id for the
comment it created — in the same vocabulary `PrThreadMessage.id` uses on the way back in.
`PrReplyStore` (`src/store/prReplies.ts`) writes one row per reply, keyed on
`(pr_number, comment_ref)`. Both providers read it through the same `SentPrReplies` seam, threaded in
from `src/system.ts` via the registry, so the reply list a person reads and the comment list a rule
dispatches on cannot come to disagree about a thread — which is why there is one derivation in
`src/prThreads.ts` at all.

`commentRef` is deliberately separate from `SendResult.ref`. `ref` is a URL for a person to click in
the audit log and matches nothing on a read; comparing the wrong one would quietly never match, which
reads exactly like the reply having never been sent.

**Three cases fail toward the thread reading as unanswered work, on purpose.** A thread wrongly left
open costs one dispatch, which is visible and cheap; a thread wrongly marked answered loses the
reviewer's comment entirely, which is silent and permanent.

- **The provider returned no usable comment ref.** No row is written and the thread keeps reading as
  work. The miss goes through `errors.record`, so the operator is told which provider will not name
  what it created rather than left with a thread the fleet answers every pulse for no visible reason.
  There is no fallback to the author: that is the bug, not a degraded mode of it.
- **A reply sent before this record existed.** No row, so the thread reads open once more and the
  fleet answers it again. **There is no backfill**, and there cannot be one: the only evidence left on
  such a thread is the author, and telling the operator's reply from the harness's by author is
  exactly what does not work. The cost is one-off — the next reply _is_ recorded and the thread
  settles.
- **A row naming a comment the current reading does not carry** (a deleted reply, a recreated thread).
  It matches nothing. Rows are never pruned on that basis; a read served from a stale cache would
  otherwise throw the record away for good.

### Reopening a thread

The operator can put one thread back in front of the fleet:
`POST /api/prs/:number/threads/:threadId/reopen`. The thread then reads `reopened`, which is
unhandled, and rule `pr-review-comment` picks the pull request up again on the next pulse exactly as
it would for a thread nobody had answered.

It is what an operator has instead of arguing with an agent's answer. A thread the fleet replied to
is `answered` and a thread the reviewer closed is `resolved`, and both are settled as far as every
rule is concerned — so before this, an answer that missed the point could only be pursued by leaving
a second comment on the provider and waiting for it to be read as new work.

**It is a mark in the harness, never a write to the provider.** Unresolving a thread on GitHub is a
statement to the _reviewer_, reopening their question in their inbox; this is a statement to the
_fleet_. They are different acts, and for the common case — a thread nobody resolved that the harness
merely answered last — the provider cannot express the second at all. The reviewer's thread is left
exactly as they left it, and the page says `reopened` so the operator can see that the two now
disagree on purpose.

Three properties hold it together:

- **One fold, at the two seams that read a world.** `applyThreadReopens` lays the marks over the
  reading the harness decides against, and over the stored baseline as the cockpit serves it. Both,
  because they are not the same read: `runCycle` coalesces while a cycle is in flight, so a click
  that lands during one is followed by no world read at all, and a cockpit waiting for the next pulse
  would draw the thread as settled for a beat.
- **The baseline is never overwritten with it.** That row is the record of what the provider last
  said; folding an override into it would leave the harness unable to put the thread back when the
  ask is taken back — which is the whole of what "never mind" does.
- **The mark is spent by the fleet's next reply into that thread**, in `ActionExecutor`, and by
  nothing else — no timer, no cycle count. Left standing it would hold the thread open against every
  later reading and dispatch for it every pulse, for as long as the pull request lived. The loop is
  finite by construction: reopen → open → dispatch → reply → mark cleared → `answered`.

A mark naming a thread the current reading does not carry is skipped, not invented — the row stays,
costing nothing, and takes effect again if the thread comes back. A reopen is refused outright on a
pull request or thread the world does not carry: a stale page must not leave an operator believing
the fleet was asked for something it will never see.

One limit worth stating. While an agent is _already running_ on the branch, a reopened thread it was
dispatched with may not be read back to it as news — `dispatchedSignals` de-duplicates on the signal
ref over the recent-decision window, and a reopen does not mint a new one. The reopen still stands:
the next dispatch onto that branch carries the thread as work. Nothing is lost, but the answer can be
one round later than the click.

## The fleet review

**Off by default** (`review.enabled`). What follows is what a deployment gets when a project turns it
on.

The gap it closes: every gate in front of a merge asks whether the machinery is happy — CI is green,
the base is clean, no thread is open, the provider says it is mergeable — and the one thing nothing
does is _read the diff_. That reading is the operator's, on every pull request, and it is the piece of
the loop that gets worse the better the fleet works: a harness that opens four pull requests a day
hands its operator four diffs a day to read. Rule `pr-review` puts the fleet's own reading in front of
that, so what a person approves is a change something has already argued with.

It is a first pass, not the last word. A human approval is still what rule `pr-merge-ready` requires,
unchanged.

**It is not a review pack, and does not write one.** [31](31-review-packs.md) restates a change as
checked claims for the person reading it, on request, and reads the same diff this rule does. The two
are kept apart on purpose: this review is one round, its charter is the project's, and on the
deployments that run it a policy requires it — so its agent carries one job, and a pack is asked for
separately. Neither reads the other's output.

### When it runs

**On the pulse the pull request appears**, and it leads the PR concerns for it. A review's value
decays faster than any other concern's: read when the pull request opens, it is a reading of the change
somebody proposed; read after a CI fix and a base merge, it is partly a reading of the harness's own
work.

One exception, and it is a stand-down rather than a re-ordering: a pull request with **unhandled human
review threads** is not reviewed. A reviewer has already asked for changes, so the diff is about to be
rewritten, and a second opinion on the old one is spent for nothing. The concern comes back on the
pulse after those threads are handled.

**Leading means the concerns below it wait**, not merely that it sorts above them. While the fleet's
own review is still coming, the pull request contributes **no dispatch candidate but the review** — the
CI fix, the base update and the requeue all hold. Sorting alone was not enough, because the review is
not always on the list to be sorted: through the [routing wait](#choosing-how-to-review) there is no
review concern at all, and the CI fix under it took the branch in that gap and rewrote the diff the
reviewer was about to read.

The wait is finite, and the review's own attempt ledger is what ends it. Three dispatches that report
nothing, then the escalation, and the review stops leading: the concerns below it take the branch on
the pulse after a human has been told. Held on the standing verdict instead, a review nobody can
complete would be a pull request nothing may ever fix, with nothing red.

Notes are not held. An agent already working the branch is still told that CI went red — a note claims
no headroom and changes no diff. What it is **never** told is that the pull request wants reviewing:
that note would reach an agent whose dispatch origin is `pr:<n>:ci` or `pr:<n>:comments`, which
`reviewTargetPr` refuses, so the diff would be read with `review_report` unable to land. The merge gate
would still hold, the fleet would pay for the review a second time, and the only record of the first
would be whatever that agent happened to say. A review done outside the record is worse than one not
yet done, so the review is a dispatch of its own or it is nothing.

### A review that happened somewhere else

**Off** (`review.reviewedElsewhere: null`). `pr_reviews` answers "has the **fleet** read this", which is
the only question the harness can answer on its own — and on a team that already has a reviewer it is
the wrong question. An Azure branch policy with a required approver, a review bot, another org's gate:
each of those is a read that happened, and the fleet spending an agent on the same diff is a second
opinion nobody asked for, held merge included.

**A command, because there is no generic form** — an environment's `health` exactly
([24](24-environments.md#is-the-environment-well)). This is a policy evaluation on one deployment, a
label on another, and a script that asks two systems on a third, so the harness ships no opinion and
runs the operator's. It runs in a shell in `repoRoot` with `LUBBDUBB_PR` set, and **the exit code is
the answer** — 0 for "already reviewed" — because what an operator reaches for here already exits 0 for
yes (`az repos pr policy list … | grep -q approved`, a `gh` query, a `curl -f`), and a stdout contract
would mean a wrapper around each one, which is where the mistakes go.

**The verdict is three-valued and `unknown` never folds into `reviewed`.** A missing command, a timeout
and a real "no" are one exit code apart, and reading any of them as "already reviewed" would silently
switch the whole fleet review off on exactly the deployments whose gate broke. So only a clean exit 0
stands a pull request down; a clean non-zero exit is a real no, and a kill or a shell that never ran
the command is `unknown` — both leave the fleet reviewing, which is the fail-open direction the triage
and the appraiser already take. An `unknown` goes on the error log, because a check that has been
failing since the day it was configured is otherwise indistinguishable from one that keeps saying no.

**Only `reviewed` is recorded** (`pr_review_externals`), and it is its own table rather than a
`pr_reviews` row: that row means _the fleet read this and here is what it found_, and writing an
external gate as one would put a verdict in the cockpit, the Decision log and the next agent's prompt
that nothing in this harness performed. The other two verdicts are re-asked next pulse, because a gate
that has not passed yet may pass later.

**It is also how a team adopts the feature without reviewing their backlog.** Switching
`review.enabled` on makes every open pull request with no verdict eligible at once — `needsFleetReview`
has no condition about time — so a repository with twenty of them gets twenty review agents queued
behind `maxConcurrentAgents`, twenty read-only checkouts cycling through a pool of `cap + 2` slots (each
hand-over a `git clean -ffdx` and a cold dependency install), and, with `review.blocking`, twenty pull
requests held out of `pr-merge-ready` until each has been read.

A cutover **guard in the harness** was considered and is deliberately **not** implemented. It would
have been a per-pull-request ledger stamping what was open on the pulse the review started asking — and
its discriminating work happens exactly once, at adoption, after which it stamps every pull request
eligible for ever: a table, a provider field for the pull request's age, and a predicate arm, all
carrying a one-time problem. This command already answers the same question, permanently, and answers
it _better_ at the cutover, because the operator knows their own and the harness can only guess a
window. `LUBBDUBB_PR` is in the environment, so the whole guard is `[ "$LUBBDUBB_PR" -lt 677 ]`,
composed with whatever the real policy query is — a cutoff a team chose, at a precision they know,
rather than two pulses the harness picked. What it does not soften is a backlog nobody has reviewed at
all, and that is the honest division: the fleet reading twenty unread diffs is the feature working, and
deciding to spend that is the operator's call, not the harness's.

**Asked in the pulse, not in a rule**, since it is a process spawn and the rules are pure and
synchronous — and asked only of the pull requests a review is _otherwise due for_ on that pulse, which
is the whole of the cost control: one spawn per would-be review rather than one per open pull request
for ever. A pull request already reviewed, skipped, outside the intake or standing down behind a human
thread is never asked about, because the pulse builds its reading exactly the way the rules do.

### Skipping a review altogether

**Off** (`review.allowSkip`), and it is the one answer the triage can give that waives the gate rather
than sizing it. Everything else it decides is about _how much_ to read; this decides whether anything
does, and with `review.blocking` it is also what lets the merge through. So a project asks for it
deliberately or it is not on offer at all: `review_route` does not carry the argument, and
`skipNote` puts nothing in the prompt.

On, the triage answers `skip: true` instead of a mode, with the same required reason — and that reason
matters most here, because the route row is the only account of why a change went in unread. What
follows is read off the row by both halves, exactly as the intake is: `needsFleetReview` dispatches
nothing, and `reviewSatisfied` does not hold the merge. A skip that only did the first would make the
triage's cheapest answer the one that wedges the branch.

**It turns the triage on by itself.** `review.modes` is the switch for the _routing_ question because a
decision with one option is not a decision — but with skipping allowed, one declared mode is two
answers ("read it that way" or "do not"), so the triage runs. `triageRuns` is that reading, and every
rule asks it rather than `routesBetweenModes`, which stays the narrower fact the triage's own prompt is
built from.

**Never the fail-open direction.** A triage that crashes, is killed or spends its cap leaves no route,
and `pr-review` then reads the pull request in `review.defaultMode` — unchanged. A skip is only ever
something an agent said on purpose. And it is honoured only while the project still allows it: an
operator who turns `allowSkip` back off has every standing skip fall back to a review, the safe
direction and the same one a route naming a removed mode takes.

The prompt's wording pushes _against_ the skip deliberately. A model asked to size a read and handed a
"no read needed" option reaches for it more often than a team would, and the cost is asymmetric in
exactly the way the fail-open default already accounts for.

### One round, and what that decides

A pull request is reviewed **once**. Nothing re-reviews it after a push — not the fix for the review's
own findings, not a CI fix, not a base merge.

That decides the shape of the record, and the decision is worth stating because the obvious
alternative is wrong in a way nothing would report. `pr_reviews` is keyed on the **pull request**, and
`head_sha` is recorded but gates nothing. Keyed on the SHA instead — which is what "a review of a diff
dies with the diff" argues for, and it is a good argument under re-review — the first fix pushed after
the review would invalidate the row, nothing would ever write another, and the merge gate below would
then be unsatisfiable for the life of the pull request. It would sit unmergeable forever, with nothing
red and no rule proposing anything.

### The verdict, and where it comes from

The agent reports through `review_report` ([11](11-mcp-tools.md)) — `clear`, or `findings` with what
it found — and **that call is the review**. A run that ends without it has reviewed nothing, which is
the same rule every other verdict-bearing dispatch follows: silence never reads as success.

Two values and no severity ladder, because the verdict gates nothing by itself. What the words are for
is the person approving the merge.

### The merge gate

Rule `pr-merge-ready` gains one clause (`reviewSatisfied`, `src/review/prReview.ts`): with
`review.blocking` on, a pull request with **no** review row is not merge-ready. Unknown is never clear.

**Every arm `needsFleetReview` stands down on releases this gate too**, and the symmetry is what makes
each of them a decision rather than a wedge: a pull request the triage
[skipped](#skipping-a-review-altogether), and one
[already read elsewhere](#a-review-that-happened-somewhere-else). Neither has a review coming, so
holding it would be the gate waiting on something that will never arrive. `PrReviewReading` is the one
bundle every arm travels in, so an arm added later reaches both predicates or does not compile.

**It asks whether the review happened, not whether it liked what it saw.** With one round there is
nothing that could clear a `findings` verdict, so gating on `clear` would wedge every pull request the
reviewer had an opinion about and leave the operator no exit but to switch the feature off. What
findings do instead is reach the person who approves — on the pull request's row, and on the pull
request itself where `review.publish` is on — before they give the approval the gate already required.

`prAttentionStatus` reads the same two halves, so a row that says a review is coming and a rule that
dispatches one are one reading rather than two.

### Where the operator sees it

One reading, `prReviewState` (`src/review/prReviewState.ts`), folded onto every pull request on the
wire beside `health`, `attention` and `ciVerdict`, and drawn as the review mark
([17](17-cockpit.md#the-fleet-reviews-mark)). It has six answers where the verdict has two, because the
verdict is the half an operator sees **last**: `deciding` (no route, and the triage takes one),
`routed` (a mode chosen, nothing read yet), `clear`, `findings`, `skipped` and `elsewhere`. A pull
request nothing has read is the common case, and drawing that as an absent verdict says the review
found nothing.

**Findings somebody dealt with read as `addressed`.** The verdict does not change — the reviewer found
what it found, and the list stays on the row — but the mark is a call to look, and one that keeps
shouting after the thread was resolved is one an operator learns to stop reading. It is true only of
the fleet's **own** threads, on two independent arms either of which is enough: the thread the fleet
itself published into ([the record](#what-the-publication-is-recorded-as)), or every thread carrying
the stamp the project declared ([the stamp](#a-thread-the-harness-stamped)). Both only while the
current reading carries those threads as resolved: a thread the provider no longer reports is a thread
nothing can say was resolved, and "cannot say" is not "dealt with".

**A lens, never a gate.** It reads the same four rows `reviewSatisfied` reads and decides nothing:
every arm the gate stands down on is an arm the mark names in its own words, so the two cannot
disagree about whether a review is coming. And it is folded on the server for `ciVerdict`'s reason —
the arms read `config.review`, so a browser deciding which of them applies would be a second glob of
policy sitting nowhere near the rule it duplicates.

**Absent where the review is off**, which is the default, and absent is what draws no mark: a grey "no
review" glyph on every row of every default deployment is a claim about a feature nobody turned on.
It is the one reading a *closed* pull request keeps, because it is a record of what was read rather
than a verdict about what happens next — and "why did this merge with three findings on it" is asked
precisely after the merge.

### The reviewer's checkout

A **read-only checkout of the pull request's branch** (`readOnlyDispatch`, `review/pr-<n>`), never the
branch itself. Two things follow, and both are the point: the reviewer cannot commit what it found —
an agent that fixes its own findings then reviews its own fix — and it does not hold the branch lease,
so the CI fix behind it is not queued behind the review.

**And it does not wait on that lease either**, which is the same fact read the other way. Whether a
concern may be dispatched is asked of the branch its own agent checks out — `review/pr-<n>` for this
one, the pull request's branch for every other — so an agent working the code is not in the review's
way. Asked of the pull request's branch for all of them, the review was blocked by the very agent that
opened it, and by every CI fix after that.

### Choosing how to review

**A project may declare more than one way of reviewing** — `review.modes`, keyed by whatever names its
team uses. Two or more, and rule `pr-review-triage` runs first and picks one. Fewer, and there is no
triage at all: a decision with one option is not a decision, so nothing is spent making it. That is the
whole switch — there is no separate flag, because a flag could disagree with the modes and one of them
would be ignored with nothing to say which. `review.allowSkip` turns the triage on the same way, by
adding an answer rather than a flag about whether to ask: see
[Skipping a review altogether](#skipping-a-review-altogether).

**The choice is a model's, not a threshold's.** "Under three files" is a proxy for risk, and the things
that actually make a diff worth a careful read — it touches auth, it is the first change in a
subsystem, the ticket calls it a spike — are not counted, they are judged. So `review.routingCharterFile`
is the project's prose about _how to choose_, and a desk agent reads it.

**Metadata, not the diff.** The triage is a desk agent: no worktree, no pool slot, no repository read.
It gets the title, the branch, the base and what the tracker says, and may ask `world_read` for more. A
routing decision that needed the diff would cost what the review costs, and then there would be nothing
left to route for.

**Its verdict is a name, through `review_route`** — or, where the project allows it, a skip. Three
things act on a name before the reviewer reads a line — the prompt, the charter appended to it, and the profile it runs on — so an agent that merely
_said_ which mode it would use would leave all three on the default, silently, and the Decision log
unable to say which mode ran. A name the project has not declared is refused rather than honoured.

**It fails open.** A triage that crashes, is killed or spends its attempt cap leaves no route, and
`pr-review` then runs `review.defaultMode` rather than parking — the rule the appraiser, the planner and
the assessor all follow, because a gate that can quietly stop the fleet is worse than one that
occasionally reads a diff more carefully than it needed to. So the default should name the **thorough**
mode; null takes the first declared, which is why a project declares that one first. A `defaultMode`
naming a mode that does not exist is refused **at load**: it is only ever reached on a day something
else has already gone wrong, so a typo in it looks correct for as long as the harness is working.

The review waits one pulse for the route — and only while one is still coming. `pr-review` reads the
same attempt ledger the triage does, so a routing that has given up resolves to the default on that
pulse rather than holding the pull request for ever.

**Its own origin**, `pr:<n>:review-triage`, for the reason `pr-ci-gate` has one: a routing that cannot
be got through must not spend the budget the review was never given, and a failure has to name which of
the two it was about.

**Its own stage, above the PR concerns**, rather than an eighth concern among them. That pass exists
because at most one _branch_ agent works a branch, and the triage takes no branch — folding it in would
have it compete for a lease it never takes. Above, so the concern group stays contiguous
([05](05-dispatcher.md)).

**The routes live in their own table.** `pr_reviews` existing is what satisfies the merge gate, so a row
written early to carry a route would report a pull request as reviewed by the step that only decided how
to review it.

### What a project may say about it

Every field of `review` is written to be set by the **project** rather than by each operator, because
what a team looks for in a diff belongs beside the code it is about. `lubbdubb.project.json` carries any
key ([02](02-configuration.md#the-project-layer)), so all of it is committed once and shared.

| Key                         | Default  | What it decides                                                                                                                                                                                                 |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review.enabled`            | `false`  | Whether the review runs at all. It switches both rules in and out of the pipeline.                                                                                                                              |
| `review.blocking`           | `true`   | Whether an unreviewed pull request is held out of the merge gate. Off records the verdict and gates nothing.                                                                                                    |
| `review.allowSkip`          | `false`  | Whether the triage may answer that a pull request needs no review at all. It also turns the triage on by itself.                                                                                                |
| `review.reviewedElsewhere`  | `null`   | A command asking whether a pull request has already been reviewed outside the harness — and the way a team adopts this without reviewing their backlog. Exit 0 = yes; anything else leaves the fleet reviewing. |
| `review.publish`            | `'none'` | Whether the reviewer is told to post its findings on the pull request, through `reply_to_review` and only that.                                                                                                 |
| `review.publishedThreadProperty` | `null` | The thread property your own review tooling stamps its threads with, so findings it published read as addressed once every stamped thread is resolved. Azure DevOps only. → [A thread the harness stamped](#a-thread-the-harness-stamped) |
| `review.publishedThreadRole` | `null`  | Which stamped threads count — the value required on `"<property>.role"`. Null takes every stamped thread, summary threads included.                                                                             |
| `review.modes`              | `{}`     | The ways this project reviews: `charterFile` and `profile` each. Two or more switches the triage on.                                                                                                            |
| `review.defaultMode`        | `null`   | The mode a review falls back to when nothing routed it. Null takes the first declared.                                                                                                                          |
| `review.routingCharterFile` | `null`   | The prose that decides between the modes, read by the triage.                                                                                                                                                   |

```json
{
  "review": {
    "enabled": true,
    "routingCharterFile": "docs/review/routing.md",
    "defaultMode": "deep",
    "allowSkip": true,
    "reviewedElsewhere": "az repos pr policy list --id \"$LUBBDUBB_PR\" --query \"[?configuration.type.displayName=='Minimum number of reviewers' && status=='approved']\" -o tsv | grep -q .",
    "modes": {
      "deep": { "charterFile": "docs/review/deep.md", "profile": "heavy" },
      "quick": { "charterFile": "docs/review/quick.md", "profile": "light" }
    }
  }
}
```

Off by default because this is the one rule that spends an agent on **every** pull request. A deployment
that took the defaults and found its bill changed by a build it had not asked anything of would be right
to call that a fault. The triage adds a second, cheaper agent — which is worth it only when the modes
genuinely differ in what they cost, so a mode wants a `profile` as well as a charter.

A mode's `profile` is the project's standing opinion about what a kind of change is worth reading for.
An operator's own pin on the origin still wins over it ([05](05-dispatcher.md)): a person overruling the
project for one pull request is the narrower statement.

`review.publish: 'comment'` adds a line to the prompt telling the agent to post through
`reply_to_review`, which raises an act the executor authorises and signs ([09](09-execution.md)) — the
same route a rule-drafted reply takes. It is deliberately not a free channel: what the comment _says_ is
the project's, through the prompt and the charter; where it goes is the harness's. A published finding
then arrives as an unhandled thread, which rule `pr-review-comment` already answers — so the fix loop for
a fleet finding is the mature path the fleet already has, and not a second one.

**Both origins may reply, and for a while only one could.** `replyOrigin` fenced the tool to
`pr:<n>:comments` — the agent answering a reviewer — while the very prompt above dispatched the
reviewer at `pr:<n>:review` and told it to publish through the same tool. Every deployment with
`publish` on therefore had its reviewer refused by the call the harness had just ordered, leaving it
the operator's credential in its own shell, which the same prompt forbids: the findings reached the
pull request as nothing at all. The fence still holds against `pr:<n>:ci` and `pr:<n>:review-triage`,
neither of which has anything to say on a thread.

#### What the publication is recorded as

`pr_reviews.published_thread` — the provider's id for the thread the findings went out in, written by
the send, off the **origin that asked** for the reply and never off what the comment says or who wrote
it. It is the same discipline as `pr_replies_sent` and for the same reason: the credential the harness
posts under is the operator's own on a single-operator deployment, so identity can settle nothing here.

Three cases record nothing, and all three read as *not published*, which is the safe direction: a
reply into an existing thread (a publication opens one), a provider that will not name the thread it
created, and a provider whose pull-request comments are not threads at all — GitHub's are issue
comments and cannot be resolved, so there is nothing there to record or later to read. A re-review
clears the column: the old thread answers findings the new row no longer carries.

What it buys is the one thing the findings list cannot say on its own — whether anybody has dealt with
them. A person (or the fix agent, through `reply_to_review`'s `resolved`) resolving that thread is the
statement that they were, and it is what turns the review mark from red to green
([17](17-cockpit.md#the-fleet-reviews-mark)). Nothing wider is allowed to say it: not every thread on
the pull request, not a thread whose author matches the credential — either would let somebody else's
tidy-up report the fleet's findings as answered.

#### A thread the harness stamped

The record above is the whole of what the harness itself posted, and there is a deployment it cannot
reach at all. With `review.publish: 'none'` — the default — the reviewer posts nothing, so
`published_thread` is null on every review, so **no review can ever read as addressed**. On a project
whose findings are published by the operator's own review tooling rather than by the reviewer agent,
the threads are sitting on the pull request, resolved, and the mark stays red over them forever with
nothing anywhere saying why. `addressed` is dead code there, and nothing is red.

So a thread may **name itself** instead. `review.publishedThreadProperty` names a key in the
provider's own per-thread property bag (Azure DevOps has one; GitHub does not, and there the arm is
simply unavailable). A poster that stamps that key on every thread it opens leaves a mark every later
world read can see, on threads the harness wrote no row for. `review.publishedThreadRole` narrows it
further where the poster distinguishes its threads: the value required on the companion key
`"<property>.role"`, derived from the property name rather than configured separately so the two
cannot come to name different bags.

The arm reads **at least one stamped thread, and every one of them resolved**:

- _At least one_, because "every stamped thread is resolved" is vacuously true of a pull request with
  no stamped threads at all — which would read every unpublished review as dealt with.
- _Every_ rather than _any_, because a later round's new finding opens a new stamped thread: with
  _any_, one resolved thread from the first round would keep the mark green over an open finding
  nobody has looked at.
- A thread carrying no stamp neither addresses the findings nor holds them open. A reviewer's own
  question is not the fleet's finding to answer, and the arm is about the fleet's threads only.

`PrReviewThread.properties` is where that bag arrives — carried by the Azure provider, flattened out
of Azure's `{$type, $value}` envelopes, and **absent rather than empty** on a thread with none, so
"carries no stamp" and "this provider does not say" are one answer.

It is a **read-side derivation and nothing more**: no recording step, no ordering against the pulse,
nothing a re-review wipes. Both arms are independent and either is enough, and with no property
declared the stamp arm is not consulted at all — which is every deployment from before it existed. A
stamp is a statement an operator's own tooling wrote under a key they declared, which is a different
thing from the identity inference `pr_replies_sent` exists to end; and it gates a mark's tint and
nothing else — never `reviewSatisfied`, never a merge.

### The charters

There are two kinds, and the symmetry is the point: `routingCharterFile` says **how to choose**, and each
mode's `charterFile` says **what that mode looks for**. Both are files in the repository, resolved
against `repoRoot`, and both are **appended** to the rendered prompt under a heading that says whose
words they are — never interpolated, for the reason every addition to a prompt is appended: an operator's
override that never learned about a `{charter}` placeholder would drop every word of it silently, on
exactly the deployments that customised most ([05](05-dispatcher.md#prompt-templates)).

They exist because the obvious place for a team's checklist cannot hold one. Prompt overrides live in
`promptTemplatesDir`, which defaults into `.lubbdubb/` — the directory a team gitignores — so what a
project wants its reviewers to look at had no committed home at all.

Two properties, both deliberate:

- **Read from the working tree at `repoRoot`, never from the branch under review.** The project config
  layer is read the same way and for the same reason: a pull request that could edit the file it is
  reviewed against is a gate that reviews whatever it is told to.
- **Read once at boot**, like the template book they sit beside. An edited charter takes effect on the
  next restart, not the next pulse. A path that names nothing is recorded on the error log rather than
  swallowed — a team whose charter is not in front of an agent has no other way to find out.

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

1. **The fleet's review** (`pr:<n>:review`) — when the review is on and nothing has reviewed this pull
   request yet. See [the fleet review](#the-fleet-review).
2. **Comments** (`pr:<n>:comments`) — **one concern for every unhandled thread on the PR**, not one per
   thread.
3. **CI** (`pr:<n>:ci`) — when `ciNeedsAttention(pr)` **and** `inheritedCiFailure` returns null.
4. **Base** (`pr:<n>:mergeable`) — when `needsBaseUpdate(pr)`. The base is `pr.baseBranch ?? config.defaultBranch`.
   A concern either way, because a staffed branch is _told_ about its base moving whichever arm it is
   on; only the free-branch outcome differs, and only for `behind`, which is settled by an act rather
   than by an agent.

Then, by the branch's agent state: notify a running agent, hold for a busy one, or make the most
urgent concern a dispatch candidate. Candidates from all PRs are ranked together — an operator-flagged
`urgent` CI check first, then concern class (review > comment > CI > gate > base), then PR number —
before the headroom cut.

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
  signal an operator sends while reviewing an agent's work as it goes. A *reply* on a thread the agent
  already has is that same signal, which is why the key is `prCommentSignalRef` and not the thread ref
  ([above](#the-thread-is-the-conversation)). `PrConcern.signals` carries those keys; `dispatch_code_agent.signalRefs` records the ones a dispatch already put in an agent's
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
prompt arrived after it started and is its to answer, a body that no longer matches was edited, and a
thread carrying a reply the prompt does not have was answered while it worked — that reply being the
live ask on it now. The reading serves the replies for exactly this: a review moves by reply far more
often than by a new thread, and roots-only this re-check could not see the commonest thing it exists
to catch.
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
