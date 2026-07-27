# Concluding a ticket: who says an issue is finished

**Status:** design, approved 2026-07-27. Implemented alongside this document.

## The failure

An Azure DevOps work item sits in `Review`. The pull request opened against it merges. On
the next pulse the harness puts a fresh agent on it, and that agent re-does work that is
already on `main`.

Two things combine to produce it, and neither is a mistake on its own.

**Rule 3b's inverse arm cannot tell a merge from an absence.** `openPrForIssue` reads only
the _open_ PR list, so "this PR merged" and "there was never a PR" are one observation.
The arm at `ruleDispatcher.ts` fires on `state === inReviewState && !pr && !decomposed` and
moves the item back to the first pickup state, on the reasoning that work left over after a
PR merged should be pickable again. That reasoning is sound for the case it was written for
and wrong for the far more common one.

**Nothing in the harness has ever concluded a ticket.** `issuePickupStatus` has exactly one
`done` arm and it fires on `issue.state !== 'open'` — a human closed it. There is no action
that closes an issue or completes a work item; `set_work_item_state` only ever moves an item
_between_ pickup and review. So an item that is finished but not yet closed by a human is,
to the harness, indistinguishable from one that is waiting to be worked.

The operator's workflow makes this unfixable from the outside. In it, `Review` is genuinely
ambiguous: an item sits there when work remains **and** when all work is done and it is
waiting on test. No provider field, label or state distinguishes the two. The only party
that knows is the agent that did the work.

## What already works, and why it constrains the design

The decomposed path is already correct, and it is correct in a way worth copying.

`partsPlanFor` counts a plan as decomposed while its status is `active` **or `complete`**,
so an issue delivered as a multi-part plan is parked in the review state for the life of the
plan and never bounces back — including after the last part merges. `planComment.ts` states
the resulting contract out loud: _"Nothing further is scheduled for this item. Closing it is
a human decision."_

That path never asks an agent anything. It **derives** the verdict from the plan roll-up:
every live part merged means the issue is finished. Which yields the rule the whole design
turns on:

> The verdict is asked of whoever owns the whole issue. When a plan owns it, the roll-up
> derives it. When one agent owns it, that agent declares it.

A part agent is never asked. Its scope is a part, and the roll-up already speaks for the
issue. This is what makes "done" mean _the issue is finished_, not _my slice is finished_ —
and it is enforced structurally rather than by asking agents to be careful (below).

## The verdict

One resolved verdict per issue, from a pure function over the issue's stored declaration and
its plan:

| verdict      | meaning                                                          |
| ------------ | ---------------------------------------------------------------- |
| `done`       | the issue is finished; the harness schedules nothing more for it |
| `more_work`  | work remains; the item may return to pickup                      |
| `undeclared` | nobody has said either way                                       |

Precedence, first match wins:

1. **The operator's toggle** (stored, `by: 'operator'`) — always wins, on any item, plan or
   no plan. The escape hatch, and the only thing that can contradict a plan roll-up.
2. **The agent's declaration** (stored, `by: 'agent'`).
3. **Derived from the plan**: `complete` → `done`, `active`/`awaiting_approval` → `more_work`.
4. Otherwise `undeclared`.

`undeclared` is a first-class value, not a synonym for `more_work`. That is the whole point
of the fix: a `Review` ticket can legitimately be either finished or unfinished, so folding
"nobody said" into "not finished" is exactly the assumption that produced the bug.

## Silence stops the harness

The decision the design hangs on: **an undeclared item is not re-picked.** Rule 3b's inverse
arm inverts its default. It used to fire unless the issue was decomposed; it now fires only
on an explicit `more_work`:

```ts
} else if (state === inReviewState && !pr && conclusion.verdict === 'more_work') {
```

`done` and `undeclared` both leave the ticket parked in `Review`, and the cockpit shows which
of the two it is.

The alternative — silence means not done — was considered and rejected. It preserves today's
behaviour for every agent that forgets to declare, which is to say it preserves the bug and
makes the fix contingent on model diligence. The failure this direction causes instead is a
ticket sitting still with a visible `undeclared` marker on it; the failure the other causes
is agents re-doing merged work. The first is the cheaper mistake and the visible one.

Note what this makes of `decomposed`: it stops being a special case in rule 3b. An active
plan resolves to `more_work` through the derivation, a complete one to `done`, and the arm
reads one predicate instead of two.

## `conclude_work(status, note)`

A sixth MCP write tool, beside `report_finding` / `note_progress` / `link_ticket`.

**It takes no issue argument.** The ticket comes from the credential —
`agent → task → origin` — exactly as for every other write tool, and for the reason stated
in `tools.ts`: this is a write that speaks in an agent's name to an operator, and a verdict
that stops the harness scheduling work is one an agent must not be able to cast on another
agent's issue.

**Only a whole-issue origin may declare.** `issue:<n>` is accepted. `issue:<n>:part:<slug>`,
`issue:<n>:plan`, `pr:<n>:*`, `story:*` and `job:<id>` are refused, each with a refusal
naming why. The part refusal is the load-bearing one and says so: its verdict would be about
its part, and the plan roll-up already speaks for the issue.

Refusing rather than silently scoping is deliberate. A part agent that called this and got
`{ok: true}` would reasonably believe it had concluded the issue.

`status` is `done` | `more_work`; `note` is required prose saying what remains (or what was
delivered). Latest-wins per issue, so a second pickup's agent supersedes the first's.

**A `more_work` note is carried into the next agent's prompt** for that issue, appended the
way a rejected proposal's note is — templates are operator-overridable and
`loadPromptTemplates` only rejects unknown placeholders, so a new `{}` token would silently
drop the note on exactly the deployments that customised most. Appending has no fallback to
get wrong.

## Loop bound

`more_work` → back to pickup → a new agent → possibly `more_work` again. Nothing new is
needed to bound this: `dispatchVerdict`'s attempt cap on `issue:<n>` already counts executed
dispatches in the decision window and escalates at the cap. The note riding into the next
prompt is what makes the second attempt better than the first rather than identical to it.

## What reads the verdict, and what deliberately does not

**Rule 3b reads it. `issuePickupStatus` reports it but does not gate on it.**

Gating pickup directly was considered. It buys provider-agnosticism — it would work without
`issuePickupStates` configured, i.e. on GitHub — at the cost of the only genuinely tricky
state in the design: a `done` flag would block an item the operator had deliberately moved
back to a pickup state, so it would need signal-based expiry (the phase-4 rejection pattern)
to stay honest.

It is not worth it. With the state machine configured, an item in the review state is already
blocked by the state gate, so a pickup gate would be a second opinion about a decision made
elsewhere — the drift class this codebase has paid for twice. And the operator's override is
already free and obvious: move the ticket back to `Ready` in the tracker. Moving it _is_ the
override, which is why no expiry logic is needed.

Consequence, stated rather than discovered later: on a provider with no work-item state
machine (GitHub, the fake), `conclude_work` records a verdict and the cockpit shows it, but
nothing changes about dispatch. That is honest — GitHub has no review state to be parked in,
so there is no bounce-back to suppress.

The pickup chip reports the verdict (`concluded done — "…"`) so the two surfaces agree about
what the harness thinks, without the chip becoming a gate.

## Persistence

A fresh `issue_conclusions` table keyed on the `issue:<n>` origin ref — so no `migrate()`
entry. One row per issue, overwritten per declaration:

```
origin_ref TEXT PRIMARY KEY   -- "issue:12"
verdict    TEXT NOT NULL      -- done | more_work
note       TEXT NOT NULL
by         TEXT NOT NULL      -- agent | operator
agent_id   TEXT               -- null for an operator toggle
task_id    TEXT
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

Not a column pair on an existing row, unlike `note_progress`. A progress note belongs to an
agent and dies with the run; a conclusion belongs to the **issue** and must outlive every
agent that ever touched it — including across a replan, which rewrites the plan row.

The operator's toggle writes the same row with `by: 'operator'`, and clearing it deletes the
row (returning the issue to whatever the plan derivation says, or to `undeclared`).

## Surfaces

- `/api/state` ships `conclusion` per issue, beside the existing `pickup` verdict.
- `POST /api/issues/:number/conclusion` — `{verdict: 'done' | 'more_work' | null, note?}`.
  `null` clears. Runs a cycle afterwards like the watch toggle, so a `more_work` toggle
  bounces the item back to pickup immediately.
- The cockpit draws a chip on the issue row and a toggle beside the existing watch toggle.

## Out of scope

- Closing or completing the ticket in the tracker. Concluding it in the harness's own view is
  what stops the re-pickup; the tracker transition to `Done` remains a human act, and in this
  operator's workflow a `done` item is still waiting on test.
- Stories. `Story` has no plan graph and the fake provider is its only home.
- Any change to what `autoSend` may authorise, and any new outbound capability.
