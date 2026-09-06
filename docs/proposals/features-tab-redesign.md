# Features tab — redesign proposal

A proposal, not a patch. Scope is the Features tab only; the Overview and the Needs-you rail stay as
they are. Everything below was checked against `src/features/featureBoard.ts`, `src/wire.ts`,
`web/src/components/FeatureBoard.tsx`, `web/src/view/needsYou.ts`, `src/prAttention.ts`,
`src/sequence/readiness.ts` and [17](../spec/17-cockpit.md#the-feature-board).

## 0. Two corrections to the brief

- **The demo has no feature board.** `demoApi.getFeatures` returns an empty payload and the demo
  fixture sets `config.featureBoard` false, so `?tab=features` on the demo falls through to the
  overview. There is no `buildDemoFeatureBoard`. Slice 1 below includes writing one, because a
  redesign nobody can look at is not reviewable.
- **Most of the "known gaps" are not gaps on the wire — they are gaps in `/api/features`.** The
  state snapshot the cockpit already holds every two seconds carries `escalations`, `humanTasks`,
  `proposals`, `agents`, `tasks`, `parkedOnLimit`, `world.pullRequests[].attention`,
  `world.issues[].pickup`, `world.issues[].gateHold`, `reach`, `stacks` and `featureSequences`. The
  board component already reads the live world for `wantsYou` (the `unclear` appraisal). So most of
  this proposal is a **client-side view module** over facts the browser has, and the lens grows by
  two fields.

## 1. Recommended design — "the brief, and what clears it"

One list. One card per Feature, and one card per goal with no parent, in the same list. Every card
has two bands with fixed roles, and the page opens with every card **folded to its first band**.

### Band 1 — the brief (always drawn, ~4 lines tall)

Left to right, top to bottom:

1. **Hue bar, title, `<Ref issue:n>`, tracker state tag** — as today.
2. **The standing**, quoted whole from `FeatureSummary.standing`, stamped `written 30m ago`. No new
   one-sentence field (see §4). Beside the stamp, one of three facts:
   - nothing — the summary was written against the standing the Feature has now;
   - `moved since this was written` — `summary.standingKey !== rollup.standingKey` (new field, §3);
   - `being rewritten` — an active task whose `originRef === featureSummaryOrigin(n)`
     (`issue:<n>:summary`, already on `state.tasks`).
3. **Progress**: the six-segment bar and counts as today, then the reach chips as today
   (`reached` / `partial` / `absent` / `unknown`, drawn four ways, `unknown` dashed amber with `?`).
4. **Movement**: `3 landed in the last 7 days · last 3h ago`, counted in the browser from the
   landing stamps the rollup ships (§3). `never landed` in italics where none. No age judgement.
5. **Who clears what is in the way** — three count chips, drawn only when non-zero:
   `you 3` · `fleet 1` · `world 1`. The counts are the length of the three lists band 2 draws.
6. **Who is on it** — one `AgentOnIt` per live agent under the Feature (running, green pulse) and
   one per agent parked (`status === 'waiting'`, amber, paused glyph — a second state on the same
   mark, not a new mark). Clicking opens the drawer. Nobody on it draws nothing.

The brief is the quotable unit. An operator reads the standings down the page and has the PO update;
the chips tell them which card to open.

### Band 2 — the detail (one card open at a time, `?card=<n>` on `Place`)

Three columns from 1200px, one below:

- **What the summariser wrote** — `usable`, `blocked`, `remaining` as today, under the standing.
- **In the way, grouped by who clears it** — three lists, in this order, each row a quotation or a
  count of facts with a `<Ref>` to where the answer is:
  - **You**: this Feature's rows from `buildNeedsYou` (escalation, plan, reply, merge, shortfall,
    intake, profile, bench, close-out, validate, watch, assigned) and PRs whose
    `attention.status === 'you'`. Each row is the rail's own row component, so the control is the
    rail's control and answering opens the same ask panel. No second set of verdict buttons.
  - **Fleet**: goals whose `pickup.status` is `cooldown`, `blocked` (the sequence hold, whose reason
    string names what it waits on), `planning`, `appraisal`, `obstacle`; the headroom cut (a candidate
    in `Up next` behind the cap); agents in `parkedOnLimit`; PRs `attention.status === 'harness'`.
    Row text is `pickup.reasons[0]` or `attention.reasons[0]`, quoted.
  - **World**: PRs `attention.status === 'elsewhere'` (reviewer, CI, the rung below) or `stalled`;
    goals with a non-null `gateHold` (quoted). Unwatched children stay in the brief's attention line
    where they are today — "unseen" is neither a hold nor anyone's court.
- **Its stories and PRs** — the children table as today (waves when an order is accepted), and
  **under each story, its pull requests in stack order**: `ownsPr` from `web/src/view/goalPage.ts`
  picks the PRs, `state.stacks` gives rung order, each row carries `PR n`, `[2/3]` position,
  `CiMark`, `ReviewMark`, `CommentsMark`, `PackMark` and `AgentOnIt` where a task names `pr:<n>`.
  Filter chips `open` / `done` / `all` on `Place`.

### Promoted goals

A child of the orphan bucket becomes a card of its own, in the same list, drawing only the parts that
apply: band 1 without a standing (the harness writes accounts of Features, and the card says
`no account — the fleet summarises Features, not stories`), its own reach from `state.reach`, its
holds, its agents; band 2 without the summariser column and with itself as the only story. The
orphan bucket's own card goes — the money line it carried (`$x spent under no Feature`) moves to the
page header as one sentence, because that reading is about the page, not a card.

### Ordering — `?sort=` on `Place`

Default (absent value) is **`wants-you`**: `you` count desc, then `fleet` count desc, then size — the
existing `byWantsYouThenSize` widened to count the holds it now knows about. It is still an ordering,
not a verdict. Alternatives: `moved` (last landing, newest first), `done` (delivered ÷ total), `spend`.
Promoted goals sort on the same keys; a goal with a question on it lands at the top like anything
else. "Closest to done" is offered, never default (§4).

### The first twenty seconds

Read the standings top to bottom (the PO update). Look at the first card, which is the one with the
most in your court. Open it. The **You** list is what to do; each row opens where the rail would.
Twenty minutes of work is the top card's You list; the rail keeps telling you when it changes.

## 2. Alternatives rejected

**B. The ledger.** One table row per Feature: bar, reach, moved, you/fleet/world, agents; prose in a
side pane for the selected row. Better at twenty Features, worse at the page's first job — the
standing is the deliverable and a table demotes it to a hover. Keep as a future `?view=table` if
a deployment grows past a dozen Features; the view module in §3 serves both.

**C. The inbox.** Organise the page around holds grouped by who clears them, Feature as a column.
Answers question 2 well and question 1 not at all, and it is the Needs-you rail redrawn wider. The
rail owns "what needs me"; this page owns "how is each Feature". Two surfaces answering one question
drift.

**D. Environment swimlanes.** Features as cards in `staging` / `prod` columns. Reach is per goal and
three-valued; a Feature is `partial` almost always so every card sits in one column, and `unknown`
has no column to sit in without lying.

## 3. Every reading, and where it comes from

| Reading                              | Source today                                                                                                                      | New?                                                                                                                                                                                                                                               |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title, ref, hue, tracker state       | `FeatureRollup`                                                                                                                   | —                                                                                                                                                                                                                                                  |
| Standing, usable, blocked, remaining | `FeatureRollup.summary` (`FeatureSummary`)                                                                                        | —                                                                                                                                                                                                                                                  |
| Summary stamp                        | `summary.updatedAt`                                                                                                               | —                                                                                                                                                                                                                                                  |
| "moved since written"                | `summary.standingKey` exists; the current digest is computed in `src/system.ts` for `ctx.featureStandings`                        | **`FeatureRollup.standingKey: string`** — the lens quotes the same `featureStandingKey` result the rule compares. Owner `src/summaries/featureSummary.ts`; threaded via the route's `buildFeatureBoard` input. The cockpit compares equality only. |
| "being rewritten"                    | `state.tasks` with `originRef === issue:<n>:summary`, active                                                                      | —                                                                                                                                                                                                                                                  |
| Bar, six counts                      | `FeatureRollup.counts`                                                                                                            | —                                                                                                                                                                                                                                                  |
| Reach per environment                | `FeatureRollup.reach` (`rollUpReach`, three-valued plus absent)                                                                   | —                                                                                                                                                                                                                                                  |
| Movement                             | `lastLandingAt` only                                                                                                              | **`FeatureRollup.landings: { at: string; prNumber: number; goal: number }[]`**, newest first, bounded (25). Quoted from `store.listGoalLandings`, already an input. The 7-day window is the cockpit's, said in the label.                          |
| Spend                                | `FeatureRollup.costUsd`                                                                                                           | —                                                                                                                                                                                                                                                  |
| You-holds                            | `buildNeedsYou` rows → `standsFor` → `goalIssue`; PRs via `goalOfPr` + `attention.status === 'you'`                               | **`web/src/view/featureHolds.ts`**, pure, mapping each row to a Feature by child membership. No server change.                                                                                                                                     |
| Fleet-holds                          | `issue.pickup.status` ∈ cooldown/blocked/planning/appraisal/obstacle; `parkedOnLimit`; `attention === 'harness'`; the Up-next cut | same module                                                                                                                                                                                                                                        |
| World-holds                          | `attention.status` ∈ elsewhere/stalled; `issue.gateHold`                                                                          | same module                                                                                                                                                                                                                                        |
| Agent presence                       | `state.agents` + `state.tasks` (`originRef` under `issue:<n>…` or `pr:<n>` of an owned PR); `waitingReason`                       | `AgentOnIt` gains a `waiting` variant. `FeatureWorkingRow.agentId` is **not** needed — the join is client-side, like the goal page's "On this goal".                                                                                               |
| Stories                              | `FeatureRollup.children`, waves from `sequence`                                                                                   | —                                                                                                                                                                                                                                                  |
| PRs under a story, stack order       | `ownsPr` (goalPage.ts), `state.stacks`, `world.pullRequests` / `closedPullRequests`                                               | — (`FeatureChildRow` needs no PR field)                                                                                                                                                                                                            |
| CI / review / comments / pack marks  | `OpenPullRequest`                                                                                                                 | —                                                                                                                                                                                                                                                  |
| Promoted goal's reach, holds, PRs    | `state.reach`, same module, same helpers                                                                                          | —                                                                                                                                                                                                                                                  |
| Orphan spend                         | `orphans.costUsd`                                                                                                                 | — (moves to the header)                                                                                                                                                                                                                            |
| `card`, `sort`, PR filter            | —                                                                                                                                 | three `Place` fields (`featureCard`, `featureSort`, `featurePrs`), both legs, `test/cockpitPlace.test.ts` extended                                                                                                                                 |

Nothing above is a verdict about a Feature. The three buckets are a total mapping over unions that
already name a party — `PrAttention.status`, `NeedGroup`, `IssuePickupStatusKind` — the same species
as `KIND_TONE` and `wantsYou`: facts counted and phrased, sentences quoted. No dispatcher rule reads
any of it; `featureHolds.ts` lives under `web/src/view/` where nothing in `src/` can import it.

## 4. What the mockup gets wrong

1. **"Closest to done" as the default sort.** It buries the Feature most blocked on the operator,
   and "closest" needs a percentage that invites the forecast the lens refuses. Default is wants-you.
2. **A new one-sentence field.** `standing` is already two or three sentences with status words,
   dates and percentages banned by the tool description. Adding a shorter field is a second account
   that will disagree with the first. Draw `standing` whole; it is bounded at 1,200 characters.
3. **"2 things have changed since" and "Stale: since this was written, #376 hit a conflict and PR 413
   turned green".** A digest says _whether_ the standing moved, never how many things or which. The
   second is a sentence in the harness's voice about a Feature — exactly what the board refuses.
   Draw `moved since this was written`, nothing more.
4. **A card-level primary button ("Open the merges", "Read the draft").** Choosing which hold gets the
   big button is an opinion about what matters most. Controls live on the rows, and they are the
   rail's own controls.
5. **"2 stories can move" on a merge row.** A forecast. Draw the stack order and stop.
6. **"nothing is moving on #310" in the header.** An age judgement. Cards say `never landed` or the
   landing age; the header counts.
7. **`world 0` drawn.** Zero draws nothing (the overview's rule); a chip row that always shows three
   chips teaches the eye to skip it.
8. **Merge and Answer as bare buttons in the card.** Fine as long as they are the rail row's own
   controls; a second implementation of accept/answer here would be two verdict paths to keep in step.
9. **Every card fully open.** Three screens per Feature defeats the twenty-second scan. Fold to the
   brief; open one.
10. **A summary line for a promoted goal.** `feature-summary` dispatches per container only. Say so
    on the card rather than substituting `appraisal.summary`, which is what the goal _asks for_, not
    where it is.

What it gets right and this keeps: one quotable line per Feature, reach beside progress, holds
labelled by who clears them, live presence distinguished from parked, promoted goals in the same
list, PRs under their story in stack order, and the rail left alone.

## 5. The smallest slice worth shipping

**Slice 1 — fold, holds, order. No server change.**

- `web/src/view/featureHolds.ts`: pure, `featureHolds(state, board) → Map<number, {you, fleet, world}>`
  over the snapshot the component already has. Unit-tested in `test/featureHolds.test.ts` against a
  written-out snapshot.
- Card folds to band 1 (title, standing + stamp, bar, reach, you/fleet/world chips, `AgentOnIt` per
  live agent). `?card=<n>` opens band 2, which is today's card content plus the three hold lists
  drawn with the rail's row component.
- Default order becomes wants-you over the three counts; `?sort=` with `moved`, `done`, `spend`.
- `Place` gains `featureCard` and `featureSort`, both legs.
- `buildDemoFeatureBoard` in `web/src/demo/demoBackend.ts` with three Features and two orphans,
  `config.featureBoard: true` in the demo fixture, so the tab is visible on the published demo.
- Spec: [17 — the feature board](../spec/17-cockpit.md#the-feature-board) gains "Who clears it" and
  "Folded by default"; the address-bar table gains the two fields.

**Slice 2 — the two lens fields.** `standingKey` and `landings` on `FeatureRollup`; "moved since
written" and the movement line. `test/featureBoard.test.ts` extended.

**Slice 3 — PRs under stories, promoted goals.** Stack rows with the four marks and `AgentOnIt`;
orphan children as cards; orphan spend to the header; `featurePrs` on `Place`.

Slice 1 alone changes what an operator does with the page: the card they open first is the one with
the most in their court, and the reason is on it.
