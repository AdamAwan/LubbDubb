# Plan approval, the plan view, and discussing a plan

**Status:** design, approved 2026-07-28. Supersedes nothing; extends issue #109 phase 3
(`planning.requireApproval`) and stage 4's Replan.

## The problem

Three gaps, one theme: the harness can be asked to authorise a decomposition, but the thing it
asks you to authorise is too thin to judge, invisible once the question is answered, and
un-arguable while it is being asked.

1. **The gate is off by default.** `planning.requireApproval` already exists and already works
   — a `parts` verdict lands `awaiting_approval`, rule 3d puts it to a human, rule 4a schedules
   nothing until they accept. It defaults to `false`, so the common experience is a
   decomposition committing the moment the planner writes it.
2. **A plan is only visible while it is a question.** The approval card renders a template
   string into "Needs you" and disappears when answered. The Plans panel draws terse rows whose
   `scope` is a `title=` tooltip. There is no way to say "show me the plan for #231" from
   anywhere, at any time.
3. **A plan carries four fields.** `PlanDocumentSchema` is `{version, verdict, reason, parts:
[{slug, title, scope, dependsOn}]}` and nothing else. Approving against that is a weak ask, and
   it gets weaker the moment the gate is on by default. The only lever for disagreeing is
   **Replan**, which discards the plan and asks again rather than amending it — so the outcome
   of a conversation you never had must be re-typed as a fresh prompt.

## What ships

Four parts. Each reuses machinery that already exists; the new mechanism is deliberately small.

### 1. Approval on by default

`planning.requireApproval` defaults `true` — in `src/config.ts` and in `DEFAULT_PLANNING`
(`src/plans/planning.ts`), which must agree.

**This changes nothing for a deployment that has not turned the funnel on**, because
`planning.enabled` stays `false`. It only decides what happens once you do — which is the
honest place for the safe default, since the thing being defaulted is whether a decomposition
into N branches and N agents starts itself.

One existing assertion inverts. `test/planPart.test.ts` asserts _the default writes no
proposal_; it must now assert the default **does** write one, and that `requireApproval: false`
writes none. Same test, both polarities, opposite way round — the assertion is what keeps the
two default sites from drifting.

### 2. What a plan carries

Five additive, **optional** fields, so a document from an older planner still validates and no
transport changes shape:

| Field        | Level | What it is                                                 |
| ------------ | ----- | ---------------------------------------------------------- |
| `rationale`  | part  | Why this is its _own_ PR rather than folded into a sibling |
| `acceptance` | part  | What makes this part done                                  |
| `risks`      | plan  | What could go wrong with this split                        |
| `outOfScope` | plan  | What the planner deliberately left out                     |
| `document`   | plan  | The full narrative, markdown — the read-in-depth version   |

**The narrative lives on the plan row, not in an artifact chip.** The obvious alternative — let
the planner write `docs/plan.md` and let the file-events hook promote it to a flag chip — is
broken by a lifetime the chip mechanism does not own: `GET /artifacts/:id` serves out of the
agent's worktree, and `system.ts` removes that worktree on a `done` reap. The planner finishes,
the worktree goes, and the design doc 404s at exactly the moment the plan is ready to approve.
Storing it with the plan makes it outlive the planner, outlive a restart, and stay joined to the
row it describes — and is consistent with what is already true of the graph: `.lubbdubb/` is
gitignored precisely so a plan lives only in the store.

**Storage.** `plans` gains `risks`, `out_of_scope`, `document`; `plan_parts` gains `rationale`,
`acceptance`. Both through `ensureColumns` in `Store.migrate()`. CLAUDE.md records that these
tables need no `migrate()` entry — true when they were introduced as fresh `CREATE TABLE`s, and
**no longer true for columns added to them now**. `CREATE TABLE IF NOT EXISTS` never alters an
existing table, so without the `ensureColumns` entries the fields silently do not exist on any
database from an older build. Update that CLAUDE.md line in the same change.

**`document` is expected, not merely permitted.** The `issue-plan` / `issue-replan` templates
demand it, and a plan without one renders "no write-up" rather than silently hiding the tab — a
hidden tab reads as "this planner had nothing to add", which is indistinguishable from "this
planner ignored the instruction". Over-long documents are **trimmed and stored, with the trim
reported**, never refused: refusing would reject the whole plan submission over its prose, which
is the `note_progress` trade-off (cheap and frequent beats strict) rather than the
`report_finding` one (testimony, so refuse what cannot be attributed).

### 3. The plan modal

A shared `web/src/components/PlanModal.tsx`, owned by the shell, opened through the skin seam as
`viewPlan(planId: string | null)` on `CockpitActions`.

**Why the shell owns it.** `CockpitActions` already carries `select(agentId)` — pure UI state on
the seam, on the stated grounds that "which drawer is open is cockpit state, not skin state".
`viewPlan` is the same thing for the same reason, and it keeps the modal one implementation
across both skins while each keeps its own drawing of the plan itself (the precedent
`TechTree.tsx` already names for `replan`: the mutation has one implementation however many skins
draw a plan). A skin must not reach `api.js` — `test/cockpitSkins.test.ts` asserts it — so the
seam is the only way a skin-side button can open a shared modal.

**Two tabs**, which is a deliberate choice over one long scroll:

- **Plan** — the decision view. The planner's reason in full; **Risks** and **Deliberately out
  of scope** side by side; then every part in dispatch order with its scope, `rationale`
  (_why its own PR_), `acceptance` (_done when_), stack edge spelled out as a sentence
  (`stacks on signer — based on issue/231/signer, not main`, not the terse `on signer` chip),
  status, PR/branch when it has one, and its Up-next queue state (`unapproved` / `capped` /
  `▶ now`). The amber cut line is the same device the Up-next queue and Plans panel already use.
- **Full write-up** — `document`, rendered.

Tabs, because the decision view must stay short enough to hold in your head. The cost is that
the write-up is one click away rather than in front of you.

**Markdown rendering is a new pure `web/src/components/markdown.ts`** — a subset (headings,
lists, fenced and inline code, emphasis, blockquotes, links through the existing `linkify`)
returning React nodes, **never `dangerouslySetInnerHTML`**. Same precedent as `ansi.ts` being
hand-written rather than pulling xterm, and for a sharper reason: this text is agent-authored, so
a renderer that never interprets HTML has no injection surface to reason about at all. Pure and
unit-tested, like `ansi.ts`.

**Entry points** — the button appears wherever the plan is mentioned:

- the approval card in "Needs you", when `proposal.kind === 'plan'`;
- each row of the classic Plans panel and each node of the factory tech tree;
- the issue row, where the pickup chip already reads `2/5 parts merged` — the chip becomes the
  button.

**Actions in the modal.** Approve / Reject route through the same `decideProposal` the
escalation card uses, so one verdict has one implementation and the "Needs you" card clears
either way; they appear only while the plan is `awaiting_approval`. Replan and Discuss sit apart
from them, because they settle nothing. That Approve/Reject exists in two places is accepted:
you are looking at the full plan, and that is where you would decide.

The modal is useful **after** approval too, as the record of what was agreed — which is most of
why it is a modal reachable from anywhere rather than a section of the approval card.

### 4. Discussing a plan

**Discuss is a Replan with a conversational planner.** Framing it that way is what lets it
inherit every safety property already argued for rather than inventing parallel ones.

`POST /api/plans/:id/discuss`:

1. `store.setPlanStatus(id, 'planning')` — what `/replan` does.
2. Withdraw any pending plan proposal (`proposals.reject`, "superseded by a discussion"). Safe
   for the identical reason the replan route's withdrawal is safe: the status write lands first,
   so `refusePlan` finds the plan is no longer `awaiting_approval` and no-ops — the withdrawal
   is only the inbox item closing. And **necessary**, because a pending proposal holds rule 3d
   (`planProposalHold`), so the amended decomposition would never be put to anyone, and the
   stale card, if accepted, would release a plan its reader never saw.
3. Set `plans.discussing` (new column, `ensureColumns`).
4. Kick a cycle.

**The only dispatcher change**: rule 3c (`issue-plan`) already routes a `planning` plan to a
planner on origin `issue:<n>:plan`, branch `plan/issue/<n>`. When `discussing` is set it renders
a new `discuss-plan` template instead of `issue-replan`. Same origin, same branch, same cooldown
window, same attempt cap, same fail-open. `discuss-plan` is an ordinary overridable entry in the
template book, and tells the agent: this is a conversation; here is the current plan and its part
states; use `escalate` to answer and ask; when the operator is satisfied call `plan_submit` with
the amended document; then finish.

**Nothing runs away while you are talking**, and each reason is an existing gate rather than a
new one:

- rule 4a schedules parts only for `active` / `awaiting_approval` — `planning` schedules none;
- rule 3c cannot dispatch a second planner, because the discussion agent holds
  `issue:<n>:plan` (`findActiveTaskByOrigin`);
- rule 3d proposes only for `awaiting_approval`, so no card appears mid-conversation.

**The conversation needs no new transport.** The agent parks with `escalate`; replies go through
`POST /api/agents/:id/respond`, which works on any live agent and drives another turn on the
default stream runtime (stdin stays open — `StreamJsonSession.send` writes one user message per
turn); the transcript comes from `GET /api/agents/:id/transcript`. The modal's chat pane is
those two plus a link to the real drawer for tool calls.

**Three endings:**

- **It amends.** `plan_submit` → `ingestPlanDocument` → `awaiting_approval`, `discussing`
  cleared → the next pulse's rule 3d puts a **fresh** proposal up. The stale card was withdrawn
  at step 2, so nothing holds it.
- **You end it.** `POST /api/plans/:id/discuss/end` completes the agent through the existing
  clean-done path (`AgentManager.complete` — task `done`, worktree reclaimed on the reap, not the
  abandonment `kill` records), clears `discussing`, and puts the plan back to
  `awaiting_approval` so the proposal is re-asked. Without that last step the plan sits in
  `planning` and rule 3c immediately starts another discussion.
- **It dies.** The plan stays `planning` with `discussing` set, so rule 3c re-dispatches,
  bounded by the existing `dispatchVerdict` attempt cap; a spent cap fails back to `parts`
  exactly as a spent replan does. Deliberately the same failure envelope as Replan, not a new
  one.

**The cost, stated:** a discussion holds a fleet slot and a worktree for as long as you take to
reply. Nothing reclaims it on a timer, and adding one would end a conversation mid-thought.

## Out of scope

Stated so it is not re-derived:

- **No change to what `autoSend` may authorise**, and no new outbound capability. A plan
  proposal has no act to send; that is unchanged.
- **No new proposal kind.** A discussion is not a proposal — it has no verdict a rule re-reads.
- **No auto-approval knob.** `requireApproval: false` remains the whole of "don't ask me", and
  there is no confidence threshold for plans; a plan carries no `confidence` for a decider to
  read.
- **Fixing artifact lifetime** (a chip surviving its agent's reap) is a real problem this design
  routes around rather than solves. Worth its own issue.
- **Making `scope` checkable.** It stays free prose; `rationale` and `acceptance` are prose too.
  Nothing validates them, and nothing should pretend to.

## Testing

- `test/planPart.test.ts` — the inverted default assertion (both polarities).
- `test/planApproval.test.ts` — the existing `planProposalHold` / `proposalHold` polarity
  assertions stand unchanged; extend for the new fields surviving an amendment.
- `test/planIngestion.test.ts` — the five optional fields round-trip on both transports
  (`plan_submit` and `plan.json`), an older document without them still validates, and an
  over-long `document` is trimmed rather than refused.
- `test/planDiscussion.test.ts` (new) — discuss withdraws the pending proposal; schedules
  nothing; dispatches on the planner origin with the discussion template; an amended submit
  lands a _fresh_ proposal; `discuss/end` restores `awaiting_approval`; agent death falls back
  through the attempt cap exactly as a replan does.
- `web` — `markdown.ts` unit tests beside `test/ansi.test.ts`; `test/cockpitSkins.test.ts` and
  `test/factorySkin.test.ts` continue to assert no skin imports `api.js`.

## Spec documents to update in the same change

`docs/spec/08-planning.md` (the gate default, the widened document, discussion),
`docs/spec/14-persistence.md` (five columns plus `discussing`), `docs/spec/16-http-api.md` (two
routes), `docs/spec/17-cockpit.md` (the modal and its entry points), and the CLAUDE.md line
about `plans`/`plan_parts` needing no `migrate()` entry.
