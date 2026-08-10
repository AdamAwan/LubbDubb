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

Is there a CI failure the harness should put an agent on? True when `ciStatus === 'failing'` **or**
any non-advisory check is failing.

Deliberately **not** the same question as `prHealth`. `ciStatus` answers _can this merge_ and is read
by `prHealth`'s blocked verdict and the merge rule; this answers _is a fix owed_, and the two have
different right answers for a check that fails without blocking completion — an Azure "Optional"
branch policy. Folding such a check into the aggregate would claim the PR cannot merge when it can,
and would stop the harness merging it. The aggregate is still an arm of the test, because a provider
reporting no per-check detail has nothing else to answer from.

**Three call sites read it and they must not diverge**: rule `pr-ci-failing`'s gate, `inheritedCiFailure`, and
`prAttentionStatus`'s CI reading. A fourth reader added later uses this predicate, or the cockpit
tells an operator a PR is nobody's turn while an agent is being dispatched for it.

## `isConflicted(pr)`

True when the provider says `mergeableState === 'dirty'`, or — when it reported no state at all
(absent or `unknown`) — when the tri-state `mergeable` is a firm `false`. Merged PRs are never
conflicted.

## `needsBaseUpdate(pr)`

`isConflicted(pr) || mergeableState === 'behind'`. False for a merged PR. This is what rule `pr-base-update`
consumes; the dispatcher then splits on `mergeableState === 'behind'` to choose between the
`pr-base-update-behind` prompt (a routine update, no conflicts expected) and
`pr-base-update-conflict` (merge, resolve, push, escalate if not cleanly resolvable).

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

Both predicates take the **unfiltered** open list — the dispatch world plus `ctx.excludedPrs` — so an
`-ignore`d base still attributes.

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
the plan's status comment, so **not** auto-send gated; a failure is recorded and never fails the cycle.

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
rather than hanging the pulse. It takes the **unfiltered** open list, so an `-ignore`d rung does not
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

### `renamablePrs(prs, ctx)` — and what may be renamed

`filters.prAuthor` is the gate, because it is already the operator's answer to "which pull requests
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

| Status      | Court                         | When                                                                                                                                                                                                                                                                                     |
| ----------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `done`      | nobody — off the board        | `prState(pr) !== 'open'`.                                                                                                                                                                                                                                                                |
| `ignored`   | nobody, by your instruction   | `isPrExcluded(pr, ignoreLabel)`. First, because the harness filters these out of the dispatch world entirely — every arm below would describe rules that cannot fire.                                                                                                                    |
| `you`       | yours                         | A **pending proposal** whose ref names this PR; an agent on the branch **parked waiting**; a failing check the **CI policy holds** (rule `pr-ci-blocked` handed it to a human); or a concern whose **attempt cap is spent** (rule `cooldown-escalate` did).                              |
| `harness`   | the harness's                 | An agent is **running or queued** on the branch; an unstaffed **concern** (rules `pr-ci-failing`/`pr-base-update`/`pr-review-comment`) is dispatchable or on cooldown; the PR is **merge-ready** and the merge gate runs next cycle, or an accepted verdict is inside its settle window. |
| `settled`   | nobody — you already answered | Merge-ready, and a **rejection still stands** on `pr:<n>:merge`. The reason quotes the note you left.                                                                                                                                                                                    |
| `elsewhere` | outside the loop              | Stacked on a PR that has to merge first (naming the inherited CI failure when there is one); CI still running; waiting on review; merge blocked by required checks/reviews.                                                                                                              |
| `stalled`   | nobody, and that is the point | Everything else: green, approved, unstaffed, unproposed and still not mergeable by rule `pr-merge-ready`'s reading, so no rule will ever act on it and no human has been asked to. The reasons name what is missing — including the **muted-only** case below.                           |

Because the first matching arm wins, the ones below it are moot — a PR with an agent on its branch
reads `an agent is working this branch` whatever its CI says, which is the answer prose about health
cannot give.

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
- **Muted only** (every failure `ignore`d) → falls through to **`stalled`**, and the reason says the
  merge gate still reads CI as failing. Nothing dispatches and nothing escalates, yet rule `pr-merge-ready`'s merge
  test reads the aggregate, so nothing will ever move the PR. The old wording — `CI has not reported`
  — was untrue of a check that reported and was muted, and it was the one phrasing that hid the gap
  rather than naming it.
- **An inherited failure reads as no failure at all**, checked inside `ciReading` rather than per arm,
  for the reason rule `pr-ci-failing` suppresses the concern: the fix belongs to the PR underneath and the
  `elsewhere` arm names it. So a policy that would otherwise escalate cannot make a stacked PR your
  problem for its parent's red build.

### What it reads, and what it deliberately does not

- **The same lists the other predicates read**: the **unfiltered** open PR list (the dispatch world
  plus `ctx.excludedPrs`), so an `-ignore`d base still attributes, exactly as `inheritedCiFailure`
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
`isPrExcluded` — so a rule reading this verdict would be taking a second opinion about a decision
made elsewhere, from a function sitting nowhere near the rule it duplicates. A verdict the dispatcher
acts on is a new gate with its own failure modes; a verdict only the cockpit reads cannot change what
happens, only what an operator can see. `test/prAttention.test.ts` asserts the property both
structurally (one importer, `src/server/stateSnapshot.ts`) and behaviourally (building the snapshot between two
pulses changes no decision).

The concern list and the merge-readiness test are re-derived here from the same predicates rather
than shared with the dispatcher, which builds prompt-bearing concerns it has no use for — the same
relationship `issuePickupStatus` has to rule `issue-pickup`. The orders are stated once, above and in
[05](05-dispatcher.md), for both.

## `isPrExcluded(pr, label)`

True when `pr.labels` includes the configured ignore label. Pure and provider-agnostic. An empty label
(feature off) or a PR with no labels is never excluded. `Harness.runCycle` uses it to split the open
list; see [04](04-harness-cycle.md).

## The PR rules end to end

For each open, unmerged PR in the dispatch world, the dispatcher builds every concern that would on
its own warrant a code agent, in urgency order:

1. **CI** (`pr:<n>:ci`) — when `ciNeedsAttention(pr)` **and** `inheritedCiFailure` returns null.
2. **Base** (`pr:<n>:mergeable`) — when `needsBaseUpdate(pr)`. The base is `pr.baseBranch ?? config.defaultBranch`.
3. **Comments** (`pr:<n>:comments`) — **one concern for every unhandled thread on the PR**, not one per
   thread.

Then, by the branch's agent state: notify a running agent, hold for a busy one, or make the most
urgent concern a dispatch candidate. Candidates from all PRs are ranked together — concern class
first (CI > base > comment), then PR number — before the headroom cut.

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
  names one thread and is what `respond_to_agent` de-dup keys on. Keyed on the origin alone, a
  reviewer's fourth comment would be swallowed by the origin the first three already claimed — the
  signal an operator sends while reviewing an agent's work as it goes. `PrConcern.signals` carries the
  thread refs; `dispatch_code_agent.signalRefs` records the ones a dispatch already put in an agent's
  prompt, since `activeOrigins` sees task origins only and cannot tell that the running agent was
  launched with those threads (`dispatchedSignalsByBranch`).

The thread ref is also the ref a refused `reply_draft` proposal is filed under, so `rejectionGuidance`
takes the **list** of refs a dispatch names — its origin plus its signals — and matches each whole.
That is not a widening to the world item, which must never happen there: matching the origin alone
would have silently stopped every operator refusal reaching an agent.

What makes a thread stop being unhandled is the provider's business, and both providers read the
tracker's real resolution verdict first — see [15](15-integrations.md). Resolving a thread in the
GitHub or Azure UI is therefore the ordinary way to tell the harness a comment is dealt with; the
harness's own reply is the fallback for a thread nobody resolved.

Independently of all that, rule `pr-merge-ready` evaluates merge-readiness (see [05](05-dispatcher.md)) and emits
`merge_pr`, which claims no headroom and goes through the executor's auto-send gate.
