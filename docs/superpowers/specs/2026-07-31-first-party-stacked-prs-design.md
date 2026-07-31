# First-party stacked PRs and consistent PR naming

Date: 2026-07-31
Status: design approved, not implemented

## The gap

Stacks today are **entirely observed, never authored**. Rule 4a picks a base branch
(`partBase`), the `plan-part` prompt asks an agent in prose to _"Open a pull request from
{branch} **into {base}**"_ (`promptTemplates.ts`), and everything downstream reads back
whatever the agent happened to do. Nothing under `src/` ever creates a pull request, sets a
title, or retargets a base — there is no outbound capability for any of it.

Three consequences, and they are the whole of this design's scope:

1. **Titles are whatever the model wrote.** There is no convention, and nothing could enforce
   one if there were.
2. **A stack only exists if a plan made it.** `plan_parts` is the only record that a chain of
   PRs is a chain; a hand-opened stack is invisible as a stack, even though `basePrOf` already
   computes the edge that defines one.
3. **A stack silently drifts.** When a base part merges or its branch moves, nothing retargets
   or rebases the PRs above it. GitHub auto-retargets on merge; Azure does not; neither
   rebases the commits.

What already exists and is **not** re-litigated here: `isStackedPr`, `basePrOf`,
`inheritedCiFailure` (stack safety, stage 4), `needsBaseUpdate`/`isConflicted`, the plan
reconciler's `GitObserver` reads, `PlanPanel`'s per-plan part column, and the merge gate that
holds rule 3 off any PR whose base is not `defaultBranch`. This design adds to that surface; it
changes none of it.

## Scope

Four things, in the order they can ship:

| Stage | What                                           | Independently shippable |
| ----- | ---------------------------------------------- | ----------------------- |
| A     | PR authoring (`PrCreateCapable` + `open_pr`)   | yes                     |
| B     | Title convention (`pr-title` template, rename) | yes, after A            |
| C     | The derived stack model                        | yes                     |
| D     | Restack, and the cockpit stack panel           | needs C                 |

Stages A+B give consistent titles without touching the stack model at all. C+D give the stack
view and restacking without depending on the harness opening anything.

---

## Stage A — the harness opens the pull request

### A new outbound capability

`PrCreateCapable.createPullRequest({branch, base, title, body})` on the `ActionSink` seam,
implemented by the `fake`, `github` and `azure` source-control providers, routed by
`CompositeConnector`. Same add-to-the-seam-and-its-scripted-fake-together discipline as
`setPrLabel` / `setWorkItemState` / `upsertIssueComment`.

### `open_pr` — the agent's half

A new MCP tool. **Identity is structural**, with the full force it carries for every other
write tool: the schema is `{summary, type?, scope?, body?}` and **nothing else**. Branch, base,
issue number, plan part and stack position all resolve from the credential's origin
(`token → agent → task → origin`), so an agent cannot open a pull request for another agent's
work, cannot choose its own base, and cannot name a branch it does not own. This is the same
argument `report_finding` rests on and the opposite of `world_read`'s deliberate exception: a
read forges nothing, and this write puts a pull request into the world under the operator's
account.

`type` and `scope` are optional and exist only to feed the title template (below). They are the
one thing the agent knows and the harness does not — whether the change is a feature, a fix or
a refactor, and which module it lands in. An agent that omits them renders a title without
them.

The tool returns the created PR number, so the agent can reference it.

### The degradation floor

**The floor is today's behaviour, and it is load-bearing rather than polite.** An agent that
ignores `open_pr` and runs `gh pr create` produces an ordinary observed PR, exactly as now.
`mcp.enabled: false`, an unwritable launch config, a `claude` that ignores the server — all
degrade the same way. This is the sentinel doctrine (`MCP_PROTOCOL_ADDENDUM` states a
preference, never a replacement), and the tests must assert the floor rather than merely
intend it.

The `plan-part` and `issue-pickup` prompts gain a stated preference for `open_pr` and keep
their existing prose instruction as the fallback. Appended, never interpolated into a new
placeholder — an operator override that never learned about a `{openPr}` token would silently
drop it, which is the failure mode `ciFailureNote`, `reaskContext` and `outstandingWorkNote` all
avoid by appending.

---

## Stage B — one title convention

### `pr-title` is an ordinary prompt-book entry

Not a hardcoded format, and not a config field of its own. It is an overridable entry in the
same template book as `finding-ticket`, for the same reason: **the wording is what an operator
has opinions about, and a prompt is where those already live.** House style changes by dropping
a file in `promptTemplatesDir`, not by patching a route.

This spec commits to the **placeholders**, not the arrangement:

| Placeholder  | Source                                                 |
| ------------ | ------------------------------------------------------ |
| `{number}`   | issue number from the origin                           |
| `{title}`    | issue title                                            |
| `{position}` | 1-based rung index within the stack                    |
| `{total}`    | rung count; `1` when the PR stacks on nothing          |
| `{type}`     | agent-declared, via `open_pr`; empty when not declared |
| `{scope}`    | agent-declared, via `open_pr`; empty when not declared |
| `{summary}`  | agent-declared, via `open_pr`; required                |

The shipped default renders `#182 [2/4] feat(store): sync cursor table`, and **omits the
position clause entirely when `{total}` is 1** (`#182 feat(store): sync cursor table`). An
operator who wants the position as a suffix, or no conventional-commit prefix, writes a
different template; nothing in the code has an opinion.

Rendering is pure — a `prTitleFields` function beside `blueprintTicketFields`, taking stored
fields and returning the placeholder values. No provider call, no world re-read.

### Rename

`PrTitleCapable.setPullTitle(prNumber, title)` on the `ActionSink` seam (fake + github +
azure). It is **mechanical bookkeeping**, like `set_work_item_state` and `upsertIssueComment`,
so it is deliberately **not** auto-send gated and runs directly from the executor.

It is **idempotent by construction**: it writes only when the rendered title differs from the
live one, so a renamed PR is not rewritten every pulse.

### What may be renamed — `filters.prAuthor` is the gate

The operator has already answered "which pull requests are mine": `github.filters.prAuthor` /
`azureDevOps.filters.prAuthor` (`config.ts`), which both providers apply **at fetch time** to
the open and closed lists alike.

That makes the scoping rule fall out rather than needing to be invented:

- **`prAuthor` set** — every PR in the harness's world is the operator's own _by
  construction_; the provider never surfaced anyone else's. Rename applies to all of them,
  and no new attribution logic exists anywhere.
- **`prAuthor` unset** — the world contains everyone's PRs and the harness genuinely cannot
  tell whose is whose. Rename falls back to **PRs the harness itself opened** (stage A), which
  it knows without asking anyone.

A colleague's pull request is therefore never renamed under either arm. The narrowing lives in
one predicate so the two arms cannot drift.

### No off-convention chip

An earlier mockup marked off-convention titles in the cockpit. With rename on, an off-convention
title is **transient** — it is corrected on the next pulse — so a standing chip would describe a
state that no longer exists by the time anyone read it. A rename is an outbound act and audits
as one: an ordinary row in the Decision log, like every other thing the harness does to the
world.

---

## Stage C — the stack model is derived, not stored

### No `stacks` table

`src/stacks/stack.ts`, pure: `buildStacks(openPrs, plans, parts)` folds the open PR list into
`Stack[]` by walking the `pr.baseBranch → another pr.branch` edge that `basePrOf` **already
computes**. A stack is a fact about the world, and the world is re-read every pulse; persisting
it would be a second answer to a question the world answers, and would need reconciling against
the world the way `plan_parts` already does.

A plan **adopts** a stack when its parts' branches match the rungs; it never owns one. That is
what makes a hand-opened stack first-class without any new storage: rung identity is the PR, not
the part.

### It is a lens

**Nothing in the dispatcher reads it**, following `prAttention`, `findings` and `overlaps`
rather than the pending-proposal gate. Every input it folds is already a gate that fires on its
own, so a rule reading the stack model would be a _second opinion about a decision made
elsewhere_, from a function sitting nowhere near the rule it duplicates — the drift class this
repo has paid for more than once.

Asserted structurally as well as behaviourally, matching `test/prAttention.test.ts`: exactly one
importer (`src/server/app.ts`), and no file under `src/dispatcher/` names `stacks/` at all.

### It reads the unfiltered list

`buildStacks` takes the dispatch world **plus `ctx.excludedPrs`**, so an `-ignore`d base still
appears as a rung. Same reason `inheritedCiFailure` and `prAttentionStatus` do: a stack with a
hole in it misattributes everything above the hole.

---

## Stage D — restack, and the panel

### Restack extends rule 2; it is not a new rule

The dispatchable signal is **per-PR**, not per-stack: _my base PR's branch has moved past the
commit I am cut from_. So it is `needsRestack(pr, openPrs, git)` beside `needsBaseUpdate` in
`prHealth.ts`, and **rule 2 (base-update) dispatches it** exactly as it already dispatches
behind/conflict. Nothing new counts attempts, throttles, or gates it.

This is what keeps the lens a lens: the rule reads a per-PR predicate, never the stack model.

### Restack and inherited CI are two different facts and stay apart

- `needsRestack` is **actionable** and dispatches — the base branch moved, this PR needs
  rebasing onto it.
- `inheritedCiFailure` is **suppression** and never dispatches — the red CI belongs to an
  ancestor, and an agent sent here would be fixing code that is not its own.

Folding them into one "unhealthy" verdict would put an agent on the upper PR to fix the lower
one's code, which is the exact bug stage 4 exists to prevent. `inheritedCiFailure` is unchanged
by this design.

### Retarget on merge

When a rung merges, the rung above it is retargeted to the merged rung's base. GitHub does this
itself; Azure does not, so it routes through a `PrBaseCapable.setPullBase` on the sink, called
from the plan reconciler's pulse alongside its other mechanical bookkeeping, and is idempotent
(writes only when the live base is wrong).

### Cockpit

`/api/state` ships `stacks`; `web/src/components/StackPanel.tsx` draws each stack as a column,
bottom rung last, with per-rung health (`prHealth`) and attention (`prAttentionStatus`) reusing
the existing chips rather than inventing new ones.

Actions:

- **Restack** — queues the rule-2 dispatch for the rung.
- **Merge** — the bottom rung only, routed through the existing `Proposal` machinery, so
  `autoSend` and human approval apply completely unchanged.

**There is no "merge stack" button.** Each rung's merge is already a proposal a human accepts;
a button that queues four of them ahead of CI results is a way to merge something red by
accident. Merging a stack is that same single act repeated as each rung lands.

---

## Testing

At the `buildSystem(config, opts)` seam, as everything else here is.

- `test/prTitle.test.ts` — pure rendering, the `{total}` = 1 omission, override behaviour, the
  idempotence of rename, and both arms of the `prAuthor` gate.
- `test/stacks.test.ts` — the fold over a hand-made chain, plan adoption, a stack with an
  `-ignore`d rung, and the two structural lens assertions.
- `test/stackedPrs.test.ts` (existing) — extended for `needsRestack`, and an assertion that
  `inheritedCiFailure` still suppresses rather than dispatches.
- `test/mcpChannel.test.ts` — `open_pr`'s structural identity (an agent cannot open a PR for
  another origin), and the degradation floor with `mcp.enabled: false`.

Scripted fakes gain `createPullRequest` / `setPullTitle` / `setPullBase` in the same change as
the seam, per the standing rule.

## Spec updates

`docs/spec/07-pull-requests.md` (stacks, naming, restack), `docs/spec/11-mcp-tools.md`
(`open_pr`), `docs/spec/15-integrations.md` (three new capabilities), `docs/spec/17-cockpit.md`
(the panel). Same change, per `CLAUDE.md`.

## Out of scope, stated

- Any change to what `autoSend` may authorize.
- Any change to `inheritedCiFailure`, the merge gate, or `plan_parts`.
- Renaming a pull request the harness cannot attribute to the operator.
- A persisted stack record, or any dispatcher rule that reads the stack model.
- Automatic rebasing of commits without an agent — restack dispatches an agent, as rule 2
  already does for a behind/conflicted branch.
