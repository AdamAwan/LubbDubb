# 17 — The cockpit

`web/` is a React 18 + Vite SPA with its own `web/tsconfig.json`, so `npm run typecheck` and
`npm run typecheck:web` are separate passes.

**The web bundle never imports server code**, and that constraint is about _runtime_. The shapes the
routes ship are declared once in `src/wire.ts` and re-exported by `web/src/types.ts` under the
cockpit's own names; every import along that path is `import type`, which is erased before anything is
bundled. `test/wireContract.test.ts` asserts both halves — that the shared modules declare no runtime,
and that `src/wire.ts` is the only server module the SPA names at all. See
[16 — HTTP API](16-http-api.md#the-wire-contract).

`npm run web:build` bundles it into `web/dist`, which the server serves in production.

## Layers

The cockpit is three layers, split so that how it _looks_ stays separable from how it behaves:

| Layer        | Path               | Job                                                                                            |
| ------------ | ------------------ | ---------------------------------------------------------------------------------------------- |
| Wiring       | `web/src/cockpit/` | fetch, websocket, coalesced refresh, which drawer is open, the bound `CockpitActions`. No JSX. |
| Derivation   | `web/src/view/`    | the pure `buildViewModel` → `CockpitView`, and the derivations it folds. No React.             |
| Presentation | `web/src/console/` | the console — the whole drawn surface, rooted at `ConsoleRoot`.                                |

`App.tsx` is only the shell: acquire state, hand the console a finished `CockpitView`. **The console
owns its whole layout.** It is given the view-model and renders whatever tree it likes rather than
filling slots in a shared page.

What keeps that from swallowing the cockpit's rules is the split on **behaviour weight**:

- **Shared** (`web/src/components/`) — anything with an async flow, a refusal rule or hold semantics:
  `EscalationCard`, `RecoveryPanel`, `HumanTaskActions`, `FindingsPanel`, `LaunchPanel`,
  `SchedulePanel`, `InjectPanel`, `FleetControl`, `AgentDrawer`, the modals, the buttons and the leaf
  helpers. The escalation 409 rules, the recovery verdicts and the decline-needs-a-note refusal get
  exactly one implementation, and the console **embeds** them rather than redrawing them.
- **Drawn** (`web/src/console/`) — anything that draws over data it was handed: the rail rows, the
  goal page's sections, the overview's cards, the backlog's groups, the top bar's readings.

`test/console.test.ts` pins the embedding from the sharp end: a goal page answering an ask must render
the shared card, not a compact copy of it, because a copy is how one surface ends up offering free
text on a proposal that only takes a verdict.

**Six surfaces hang off the shell rather than off the console**, and each for one reason — it reaches
`api.js`, which `console/` may not:

| Surface                                        | Why the shell                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `AgentDrawer`                                  | seeds itself from the persisted transcript over its own route        |
| `WorkTreePanel`                                | its own routes, fetched on open, never polled — the graph only grows |
| `PlanModal` / `RetroModal` / `ScratchpadModal` | fetch the document they draw                                         |
| `SettingsModal`                                | `GET /api/config`, `/api/ci-policy`, `/api/prompts`                  |
| `SpendModal`                                   | `GET /api/spend`                                                     |
| `ReliabilityModal`                             | `GET /api/reliability`                                               |

The console asks for each the way it asks for a plan — a method on the seam (`select`, `viewPlan`,
`viewRetro`, `viewScratchpad`, `openSettings`, `openSpend`, `openReliability`) — and the shell answers.
Which one is open is cockpit state, not console state, or closing the drawer would lose its
subscription.

The two screens `App.tsx` still draws itself — "Connecting…" and the locked-out page — stay there
because neither has a view-model to draw.

**Nothing under `console/` imports `api.js`.** Every mutation is enumerated on `CockpitActions`,
pre-bound, so drawing code cannot grow a capability with no refusal rule behind it — it would surface
only as a button nobody wrote a rule for. Asserted structurally in `test/console.test.ts`.

### Tokens

Tokens on `:root` in `web/src/styles.css` are the styling contract **for shared components**, which is
narrower than the usual meaning: `web/src/console/console.css` writes whatever CSS it likes for its own
`.cn` markup, but a shared component must be restyleable without being edited. So shared components
style themselves only through tokens, and **nothing in `console.css` targets a shared component's
class** — the moment it reaches into `.escalation-card` the two stop being separable and a change to
one silently redraws the other. `test/console.test.ts` asserts that by name. Beyond colour the set
covers `--r-*` (radius), `--font-ui|mono|display`, and `--border-hi`/`--border-lo`, the light/dark pair
that makes a bevel expressible.

The console's own colours are `--cn-*` properties on `:root` in `console.css` — a separate prefix so
the two sheets cannot collide while both are loaded, and custom properties rather than literals at
each use site because **no visual theme is settled**: the palette ported from the mockup is a
placeholder, and the point of the token seam is that replacing it is one block.

`console.css` is imported from `main.tsx`, not from a module under `console/`. A `.css` import there
would be invisible to `tsx`, which has no CSS loader and would throw when `test/console.test.ts` pulls
those modules in.

## Shape

Three surfaces and one shell.

```
┌──────────────────────────────────────────────────────────────────────┐
│ ident · Scan · Fleet      Spend Yield Output Findings Faults Launch ⚙ │  top bar
├──────────────────────────────────────────────────────────────────────┤
│ the recovery banner, when a previous run left work orphaned          │
├───────────────┬──────────────────────────────────────────────────────┤
│ NEEDS YOU  6  │  Overview · Backlog · #142 Retry the intake job      │
│ ┌───────────┐ │  ──────────────────────────────────────────────────  │
│ │ Blocking  │ │                                                      │
│ │ escalation│ │            the situation area                        │
│ │ plan      │ │      (the overview, a goal page, or the backlog)     │
│ │ permission│ │                                                      │
│ │ Yours     │ │                                                      │
│ │ bench     │ │                                                      │
│ │ close-out │ │                                                      │
│ └───────────┘ │                                                      │
└───────────────┴──────────────────────────────────────────────────────┘
```

**The recovery banner sits outside the situation area and above it, at every width.** While a crashed
run stands, the harness runs no cycles at all — so every goal the rail or the situation area would draw
is stale for the same one reason, and the banner is the one thing on screen still true. It is a block,
not a card in a track, so it needs no span rule to be full width. `test/console.test.ts` asserts the
placement rather than trusting the stylesheet.

**The situation area draws exactly one of three things**, and the precedence is load-bearing: a
selected goal outranks the backlog, which outranks the overview. Selecting a goal is what a queue row
does, and it does not close whatever the nav left open — so with the backlog winning, clicking an ask
would land the operator on a triage list instead of on the ask.

The **nav** is two destinations and a crumb: Overview, Backlog (carrying the unwatched count — the one
number that says whether triage is worth opening, read off the same `backlogGroups` the view draws so
the count and the rows cannot differ), and, when a goal is open, its number and title. Both buttons
clear _both_ pieces of state, because a nav click means "go here" and either half left standing would
land somewhere else.

### The console at width

There is **one DOM for every width**; the arrangement is chosen in CSS alone. Matching the breakpoints
in React as well — rendering a different tree per width — buys nothing and costs a resize listener, a
re-render on every drag, and a second definition of each boundary that will disagree with the first
time either moves.

| width     | arrangement                                                                   |
| --------- | ----------------------------------------------------------------------------- |
| < 1100    | the rail above the situation area; one column throughout                      |
| 1100–1199 | the rail beside the situation area (360px); situation in one column           |
| 1200–1499 | overview cards in two tracks; Fleet, Goals and Pull requests span both        |
| 1500–1999 | the goal page gains its right-hand column, and its plan waves go side by side |
| ≥ 2000    | overview cards in four tracks; the three spanning cards take two each         |

**The breakpoints are therefore stated once**, in `console.css`, and each is a statement about a
different surface: 1100 is the shell, 1200 the overview grid, 1500 the goal page, 2000 the overview
again. The plan's waves use `auto-fit` above 1500 rather than a fixed track count, so how many waves
sit in a row is a question about the card and not about the viewport — the same 1500px that turns the
waves sideways also halves the card by giving the goal its right-hand column.

**The plan's waves stack vertically below 1500px** rather than scrolling sideways. A horizontally
scrolling plan is the failure this layout is a reaction to.

**Document order is reading order.** No card carries a CSS `order`; a section moved in `Overview.tsx`
or `GoalPage.tsx` moves on screen, which is the point.

## The queue rail — "Needs you"

A permanent left column holding **every** blocking item in one list: escalations, plan proposals,
permission requests, bench tasks, close-outs and the recovery hold. `buildNeedsYou`
(`web/src/view/needsYou.ts`) is the merge, and it is pure.

**Six kinds, and the split is about what answers them.** `permission` and `proposal` are escalations
underneath, named apart because the verdict differs — a permission goes to `/permission`, a proposal
carries accept/reject, a plain question takes free text. Drawing them as one kind is how a surface ends
up offering the wrong control. `bench` and `close_out` are human tasks, likewise split, since a
close-out is the step after a launch and reads as one ([13](13-jobs-and-findings.md#the-step-after-the-launch-the-close-out)).

**Two groups, split on who is stopped.** `blocking` means an agent is parked and cannot proceed;
`yours` means the obligation is the operator's and nothing inside the fleet is waiting. That is the
whole of the colour rule: **red means an agent is parked on a question only you can answer, and
nothing else.** A bench task genuinely blocks no agent, so it is amber, and the merge of six surfaces
into one list preserves the distinction rather than flattening it.

**The order is the derivation's, and the rail never re-sorts.** `buildNeedsYou` sorts:

1. **Recovery first** — while it is up no pulse runs at all, so every other row is waiting on it
   whether or not it says so.
2. **`blocking` before `yours`.**
3. **Most-holding first.**
4. **Oldest first.**

`QueueRail` groups the already-ordered array by `NeedGroup` for its two sub-headings and does nothing
else, so the rail and the view-model stay one reading. `test/console.test.ts` feeds it deliberately
out-of-order rows and asserts array order survives — a second sort in the component is the drift that
would make the rail's own claim about urgency stop being `needsYou`'s.

**Every row states what it is holding**, and that count is the sort key within a group. `holding` is
**live direct dependents only** — the parts whose `dependsOn` names this ask's slug and which are not
retired. A transitive count would claim work that a sibling, not this ask, is the blocker for.
`partHolding` is the one implementation, lifted out of the station that first had it so the rail, the
goal page and the count cannot disagree; the sentence is worded once too, by `holdingLabel`, so "1
part" and "3 parts" agree with their noun on both surfaces. **A row holding nothing draws no count
rather than a zero.**

**A row is a link to a goal, not to a modal.** Clicking one calls `selectGoal(row.goalRef)` and opens
that goal's page with the ask pinned at the top of it. The recovery hold has no `goalRef` — it is
harness-wide — so it renders as a `div` rather than a `button`: there is nowhere for a click to go, and
it is answered on the banner above. `test/console.test.ts` asserts both shapes.

**At zero the rail keeps its place and says so** ("Nothing is waiting on you"). A surface that vanishes
when quiet is indistinguishable from one that broke, and a column that came and went would reflow the
whole shell every time the last ask was answered. A group with no rows draws no heading, though — an
empty "Yours to do" under a full "Blocking" is furniture.

## The goal page

**A queue row opens the goal it is about, with the ask pinned at the top of that goal's page.** That is
the console's one novel claim, and it is the answer to the fault the redesign was for: an escalation
shown without the goal it is about is a sentence with no subject. Answering "Redis or Postgres?" wants
the ticket, the plan, the part's siblings and what is waiting on it — so the ask is drawn _with_ them
rather than in an inbox beside them.

`buildGoalPage(state, ref, needs)` (`web/src/view/goalPage.ts`) assembles the whole page from the
snapshot. It returns **null** for a ref the world does not carry: a page of empty sections is
indistinguishable from a goal that exists and has nothing on it, and only one of those is worth
drawing. A **retained run** is found too (`retainedRuns`), so a goal whose ticket the tracker has
stopped returning still has a page to be dismissed from.

`needs` is **passed in** rather than rebuilt, so the rail and the page are one reading — answering on
either settles the row and the next snapshot clears both, with nothing kept in step by hand.

Order on the page, top to bottom:

1. **The goal header** — number, title, item type, workflow state, the assay verdict with the
   assayer's own summary in its title, the conclusion verdict, when the run started, the agent count,
   what it has cost, and how many parts have merged. Every chip quotes a reading the server already
   made; nothing here is a second opinion. A `null` spend draws no reading at all, because nothing
   was ever measured and `$0.00` would report a goal that cost nothing
   ([18](18-observability.md#per-goal-spend)).
2. **The "Needs you" bands** — every open ask on this goal, stacked, answerable in place. Red for
   asks blocking an agent, amber for the operator's own, the rail's own split carried over so a row
   and the band it opens read the same. **A goal with no ask draws no band at all** — a band that is
   sometimes furniture stops being read as a demand — and `test/console.test.ts` asserts that from both
   sides.
3. **The plan**, left to right in dispatch order.
4. **The ticket as it stood at pickup** — what a plan, an assay or an ask is judged against.
5. **Pull requests for this goal**, with the court chip and the CI ladder.

At ≥1500px a right-hand column carries **On this goal** (who is working it now), **Spend** and **The
tail**. Below that, the two stacks are one column.

### The header's controls

Watch, the conclusion, raising a bug, the ticket, and ending the run.

- **The watch toggle writes both tags.** `setIssueWatched` tags the watch label and clears the ignore
  label, or the reverse — so the title names both. Saying only "remove the watch label" understates a
  click that also tags the goal ignored, and the difference is visible: the goal lands in the
  backlog's Ignored group rather than back in Unwatched.
- **Three conclusion controls, not two.** `Mark done` / `Unfinish` writes or withdraws `done`. **Work
  left** writes `more_work`, and it is a third control rather than the finished toggle's other end
  because `more_work` is not the opposite of `done` — it is the verdict that puts a goal back in front
  of the harness once no PR is open ([06](06-issue-pickup.md#concluding-an-issue)). It is offered only
  on an open ticket that does not already carry it.
- **Raise a bug** is gated on `config.canFileTickets` and opens the shared `RaiseBugModal`. It files
  into the tracker rather than writing a verdict about the item, and it leaves the goal's own verdict
  where it found it.
- **End the run** is keyed on the run **existing and not yet ended**, never on anything else the page
  is showing — the lesson `planId` and `retroRef` learned. It is how a retained run is ended, so it
  has to be reachable for exactly as long as the harness still holds one
  ([16](16-http-api.md#post-apiissuesnumberdismiss-run)).

### The bands

Each band embeds the **shared** component that owns its refusal rules — `EscalationCard` for a
question, a permission or a proposal, `HumanTaskActions` for a bench task or a close-out. Embedded,
never redrawn: a second wiring is a second way to answer a proposal with free text on one surface only.
`buttonClass` is the one seam the console passes, so the shared buttons wear the console's face without
the console reaching into their class.

**A band whose source has left the snapshot draws nothing at all.** A header over an empty box would
claim something is waiting while offering no way to answer it.

### The plan

Four groups — **Merged**, **Now**, **Held**, **Not started** — folded by `PartGroup` off `status`
alone. Four rather than eight statuses because the page is read as a sequence, and `ready` versus
`pending` is a distinction the queue's own reason states better than a column heading can. `retired`
folds to nothing and is not drawn.

**A held part quotes the reconciler's `blockedReason` verbatim.** It is the one status nothing else in
the world explains — a blocked part has no branch, no PR and no agent to read — so a paraphrase here
would be the only account there is, and wrong ([08](08-planning.md#the-ref-collision-guard)).

The overview's segment track is folded by `buildGoalTrack` off **the page's own groups**, not off
`status` a second time, so a row and the page it opens cannot disagree about whether a part is held or
merely not started.

### The pull requests and the tail

Whose court a PR is in is `attention.status`, and which check is red is `ciVerdict`; both are quoted,
never re-read. The chip prints the server's own word with `attention.reasons` in its title, and the
ladder is one dot per check the policy classified — failing, not-ours, muted — with **no check name
written anywhere in this repository**: every one comes off the verdict. Where the provider reported no
per-check detail at all the aggregate speaks under a generic name rather than drawing nothing, because
missing detail is not a clean bill of health.

`courtTone` and `CiLadder` are exported from `GoalPage.tsx` and drawn by the overview's rack too. Two
readings of one verdict side by side is how the same PR comes to wear two tones nobody chose.

**The tail** is what is left after the parts: the goal check (the delivery's or the shortfall's own
summary), the write-up, closing the ticket, and the notepad. Each states its own author's verdict or
that nothing has run — "not reached yet" is a fact about the goal worth seeing, not an empty section.
The write-up and the notepad carry a way in, each keyed on the document **existing** and on nothing the
page is doing.

### What the goal page deliberately does not draw

**This goal's slice of the decision log.** `buildGoalPage` computes `decisions` — the rows whose
`subjectRef` names the goal — and nothing renders it. The snapshot ships the last hundred audit rows
fleet-wide and a cycle spends one of them every pulse on its own rationale, so filtered to one goal the
list is a handful of dispatches at best and empty for any goal not touched in the last few hours. The
design's stated arm was that this becomes its own route, and this takes that arm: **deferred, not
half-built.** A per-goal activity list is a route away, and the derivation is already here to draw it
from.

## The overview

What the situation area shows when no goal is selected: five cards, rows rather than pictures, in
reading order — **Fleet**, **Goals in flight**, **Pull requests**, **Up next**, **World signals**.

Two rules run through all five. **Nothing here re-decides what the server decided**: a PR's court is
`attention.status`, its checks are `ciVerdict`, a queued item's hold is the queue's own sentence, and a
goal's state is its `pickup.status`. And **an empty card still draws**, muted, because a surface that
vanishes when quiet is indistinguishable from one that broke.

- **Fleet** — who is out, what they are on, and what it has cost. The lamp reads red off
  `escalationByAgent`, not off `status === 'waiting'`: an agent can be parked with nothing asked of the
  operator, the two disagree in exactly that case, and the ask wins. **Ended shifts are behind a
  disclosure in the card's own head**, not a second card: they are the same rows read for a different
  question, and the count stays in the header at zero, muted, so the way in does not move.
- **Goals in flight** — every goal whose `pickup.status` says the harness has it in hand now
  (`active` / `has_pr` / `planning` / `delivered`). Read off the dispatcher's own word rather than
  re-inferred from agents, plans and pull requests, which are three inputs the server has already
  folded into one. Each row is a way into that goal's page, carries its segment track, and takes a
  **court chip read off `needsYou`** — a goal is in your court exactly when the rail is holding an ask
  about it. Anything else would let a chip say "you" with nothing to answer.
- **Pull requests** — every open PR with its court chip, its CI ladder, and the watch/ignore toggle.
  A PR is joined to its goal through the **plan parts** rather than guessed from the branch name; a PR
  nobody's plan claims is left out of that map and draws its branch instead, which is honest about what
  is known. The toggle is **disabled rather than absent** with no ignore label configured: the gate
  being off is a fact about the deployment worth seeing, and a control that comes and goes with a
  config key reads as a bug in the page. The merged count is drawn only where the snapshot carries a
  closed list at all — absent means the retention window is off, which is not the claim "none merged".
- **Up next** — the last pulse's ranked queue, each row carrying `QueueItem.reason` verbatim. The
  reason is the whole point of the card, being the direct answer to "are we working on the right
  thing", so it wraps rather than being clipped and nothing here re-words it. A held item is toned off
  `status`, which is a fact the same sentence already states in words.
- **World signals** — `worldEvents` grouped by `(kind, ref)` with a count, ten rows. Three review
  comments on one pull request are one signal, not three unrelated rows. **The server's order (newest
  first) is kept**: re-sorting by count would move the row an operator is watching the moment it moves
  again.

## The backlog

A nav view, opened rather than always present, because triage is periodic — **nothing in it blocks an
agent**, which is the whole difference between this surface and the rail. Four groups, every open item
in exactly one of them:

| Group             | Holds                                                   |
| ----------------- | ------------------------------------------------------- |
| Watched           | what the harness will pick up                           |
| Blocked at intake | an `unclear` assay, quoted, with the override beside it |
| Unwatched         | the triage list, newest first                           |
| Ignored           | tagged leave-alone, a tail, with un-ignore              |

**Which items the harness will work is `watchBucket`'s answer** (`web/src/worldBuckets.ts`), read once
here rather than re-derived from the labels — a second reading of the same tags is how two surfaces
start disagreeing about what is watched. It carries the server's precedence: ignore wins, then watch,
else the type default.

**Intake is pulled _out_ of Watched rather than greyed inside it.** An `unclear` assay is the one
intake reading that _stops dispatch_ ([06](06-issue-pickup.md)); among the watched rows it reads as a
detail rather than as the thing holding all the work. An **ignored** item is never intake, whatever a
stale verdict says: "leave this alone" is the operator's own instruction and outranks a reading about a
goal nobody is going to work.

**One pass and one assignment per item**, not four filters. An item matching two predicates would draw
twice, with two toggles, and the second would be a different answer to the same question. Closed items
are left out altogether — a closed ticket is neither watchable nor ignorable. Each group draws 25 rows
and then states the remainder; a group with nothing in it is muted, never removed.

**The row quotes and never parses.** The intake group prints the assayer's own sentence
(`Assay: unclear — "…"`); every other group prints `pickup.reasons[0]`. The watch and ignore labels are
filtered out of the chips a row shows: which group a row is filed under already states its watch state,
and the toggle beside it states it again — a third copy is the noise that made the old flat world panel
unreadable.

**The override is `Override → workable`**, on intake rows alone, writing through `setIssueAssay`. A
`workable` verdict blocks nothing, so a button on one would offer to change a reading that changes no
behaviour.

**A container type is disabled rather than absent** (`WatchToggle`), carrying the dispatcher's own
refusal as its title: "cannot be picked up" is a fact about the item worth seeing. It is disabled only
in the direction that would opt the item _in_ — that is the click whose promise the harness will not
keep — so un-watching one still works, or a container tagged once could never be untagged from here.
The same rule covers a deployment with the gate off (`labelPrefix: ''`): there is no tag to write in
either direction, and a button that writes nothing is worse than one that says why.

Assignment filtering is a server-side concern (`workItemAssignedTo` for Azure; GitHub has no issue
assignee filter) and is deliberately not a cockpit one — the view shows whatever the tracker returned.

## The top bar and the panels

The strip carries the ident, the pulse, the fleet cap, and seven readings: **Spend**, **Yield**,
**Output**, **Findings**, **Faults**, **Launch** and **Settings**. Each is one subject stated once, in
a plain label-and-number face. None reaches `api.js`: every one is a method on `CockpitActions`, and
the fleet cap is the shared `FleetControl`, which is already on that seam.

Four rules hold them:

- **A reading that opens something carries a chevron; a reading that acts does not.** `Scan` presses
  to run a pulse rather than opening a panel, so it wears the same raised chrome and no chevron — a
  reading that opens something and a reading that does something are different promises, and the
  chevron is the only thing that says which. Scan stays pressable while paused or held: that is
  precisely when an operator wants to confirm nothing moves.
- **A zero count mutes a reading; it never removes it.** The gauge staying put is what lets an operator
  glance at the same spot every time rather than hunting for a control that reflows when its number
  happens to hit zero. Yield extends this from a muted count to an **absent** one: nothing is drawn
  until the first run settles, since a rate over no runs is not 100% and a gauge reading perfect on an
  idle fleet is the one lie this bar must not tell.
- **The gauge and the panel behind it share one derivation.** Output reads `productionReading`
  (`web/src/view/production.ts`) — the same function the output graph is built from — rather than a
  differently-shaped count of the same events, so the two agree from the first paint. It sits in
  `view/` for exactly that: a pure, React-free derivation neither surface owns.
- **Launch counts the queue, not the history.** A launched blueprint that has been dispatched is an
  agent in the Fleet, and counting it here would have the reading climb as work starts rather than as
  it waits.

**Which panel is in front is one value**, `ConsolePanel`, not a boolean each: a boolean per panel
admits far more states than there are, and two panels in front at once is not something this layout can
draw. A `Panel` has **three ways out** — the backdrop, the button and Escape — because a thing that
covers the console must not have exactly one exit; `test/console.test.ts` pins them.

Four panels open from the bar, and Settings, Spend and Yield are shell-owned modals beside them:

- **Findings** — the shared `FindingsPanel`, with promote / file / dismiss. The count is findings at
  `open` and nothing else: promoted, filed and dismissed are done, and `filing` is decided. Nothing in
  the dispatcher reads `findings`, so those three buttons are the only way one becomes anything.
- **Faults** — the recorded failures, forty rows, the surface you went looking for rather than a crop
  for a column. It offers a **two-step clear**, drawn **above** the rows and **at zero rows as well**:
  nothing in the harness reads the fault log back, so a clear costs nothing anything decides on, but it
  costs the only copy and for every cockpit rather than this one. One misclick between "leave" and
  "delete the only copy" is too few, and the only route to it must not depend on there being rows.
  Amber, never red — the log blocks nothing.
- **Output** — the one reading that is against _time_, which is the only way to answer whether the
  fleet is producing rather than merely busy. Rates come from the timestamps already on `decisions` and
  `worldEvents`; a held or skipped dispatch is not counted, because it produced no work. **The churn
  ratio (dispatches per merge) is the point of the panel**: dispatches are effort and merges are
  output, and a rising first line over a flat second one is a fleet spinning. A series with nothing in
  the first half of the window draws no delta rather than a 0% one — there is nothing to have changed
  from. When the decision log does not reach back to the window's start the panel **says so**: a rate
  that silently under-reports is worse than no rate.
- **Launch** — the shared `LaunchPanel` and `SchedulePanel` together, since a recurrence is the same
  act with a `when` attached: a firing writes the identical job the composer writes, into the identical
  queue drawn below both. `InjectPanel` rides here under **`view.demo`** alone. Injection fakes a world
  change, which only the static demo has any use for — a real run against a fake provider is still a
  real run, and a panel that lies to the harness there is a way to lie to yourself about what it is
  reacting to. There is no server route behind it for a second predicate to disagree with.

### Launching work

`LaunchPanel` stamps an operator job: prompt, optional title, code or desk, optional branch, and the
queue including cancel. It also takes **images** (#249) — a screenshot of the panel to change, the
broken screen — by **paste** into the prompt, by **drop** anywhere on the composer, and by an **Attach
image** button over a hidden file input. Each attachment shows as a thumbnail with the operator's
filename and a × that removes it before launch.

- **The thumbnail is the same base64 the request carries**, scaled by CSS. Nothing here resizes,
  re-encodes or generates a thumbnail: the stored bytes are the operator's bytes.
- **The composer states no bounds.** How many, how big and which formats are the server's rules
  (`src/jobs/attachments.ts`), and a second copy here is how the two come to disagree — so the panel
  refuses only what is not an image at all (a category, not a number) and otherwise reports the
  server's refusal verbatim, keeping the prompt and its attachments for a retry.
- **The browser's mime is not sent.** It drives the local preview only; the server decides the type
  from the bytes, so a field it ignores would read as one it honours.

`AttachmentStrip` draws what was attached to a queued blueprint (`job:<id>`). The URL comes from
`attachmentUrls`, never string-built, because it carries a short-lived capability that the cockpit's
bearer token structurally cannot substitute for — an `<img>` load sends no `Authorization` header
([16](16-http-api.md#get-attachmentsid)). Clicking opens the image at its own size in a new tab,
`rel="noreferrer"` so the capability does not ride out in a referrer.

`SchedulePanel` puts a blueprint on a clock: a cron expression, a prompt, code/desk, and every
recurrence with its next run, its last run, and pause / run now / delete.

- **The expression is typed, and four common ones are buttons.** Reading `0 9 * * 1-5` and writing it
  are different asks, and only one of them is the operator's actual intention.
- **A refused expression is shown in the server's own words.** The cron parser names the field and
  what that field accepts, and a second wording in the browser would be a worse one written further
  from the syntax. The form is kept for a retry — a rejected expression is usually one character away
  from a good one.
- **A paused recurrence is dimmed, not hidden or moved.** It is a standing intention the operator
  wrote, and this panel is the only surface anywhere that says it exists.
- **Two times, in two registers.** `relTime` clamps a future instant to "0s ago", so the next run is
  rendered by the panel's own `untilTime` ("in 3h") beside the last run's "ran 2d ago".
  → [13](13-jobs-and-findings.md#schedules)

### Nothing at all when the link drops

Every reading in the console is one the harness confirms, and a stale one is drawn in exactly the
chrome of a live one — so a chip in the corner would ask an operator to remember to check it before
believing anything else. A dropped socket therefore **empties the console**: the bar is the ident plus
a single `Link · offline` reading, and the rail, the situation area, the recovery banner and the panels
are not rendered at all — one `Off the air` card in their place, saying that the harness is unaffected
and that the console returns by itself. `test/console.test.ts` asserts that no gauge, no rail and no
situation area survive the drop.

## Settings

A reading in the top bar opens a shared modal carrying **three tabs**, which is everything an operator
configures answering to one control:

| Tab         | Reads                | Shows                                                           |
| ----------- | -------------------- | --------------------------------------------------------------- |
| `Settings`  | `GET /api/config`    | The live controls, and the configuration this process ran up on |
| `CI policy` | `GET /api/ci-policy` | What the harness does about a red PR, check by check            |
| `Prompts`   | `GET /api/prompts`   | The rule dispatcher's prompt book                               |

The tabs exist because the last two were, in practice, unreadable: `ci.checks` was visible only by
opening `lubbdubb.config.json` on the host, and the prompt book hung off the work panel, a place nobody
looks for a setting. Stacking all three down one scrolling panel would have reproduced that inside the
modal.

A tab's body is **mounted on its first visit and never unmounted**, hidden rather than torn down when
another is selected. Each fetches a constant once, so unmounting would buy nothing and cost a re-fetch
on every switch — and the filter typed into the running-config block survives a look at CI.

The **prompt book's own modal nests inside this one**, and that is why the settings modal registers no
Escape listener: `PromptModal` has one, so Escape and a backdrop click close the template being read
and leave the modal behind it standing. Two listeners would close both layers on one key.

The prompt book lists the prompt ids (each with the opening sentence of its doc and an `overridden`
badge), and a row opens a modal carrying the doc in full, the placeholders an override may use, the
path of the override file, and the effective template text. It is read-only: the path is what makes it
actionable, since overriding is a file drop ([16](16-http-api.md#get-apiprompts)). The demo build
serves an empty book — the web bundle imports no server code, and a copy of eighteen prompts shipped to
fill the panel would be free to drift from the originals with nothing to catch it.

The config tab is **read-only and fetched on open**, both for the prompt book's reasons:
`loadConfig` runs once at boot so polling would be paying for a constant, and a write route's honest
answer to "when does this take effect" is "at the next restart". Values are grouped, and each one that
differs from the built-in default is marked — the question an operator opens this to ask is not "what
are the values" but "what did I change", and answering it needs a baseline, which is why the server
computes the comparison rather than shipping the object alone.

Two values would make that block a lie, and are drawn separately above it: `maxConcurrentAgents` and
`startPaused` are both shadowed at runtime by `RuntimeControl` ([09](09-execution.md)) and revert on
restart. The modal shows the live cap and pause state from `control`, naming the configured value it is
overriding where the two differ. Both halves of that pair are read out of the same fetched block, so
they can never come from two readings that disagree.

Nothing is redacted, and that is not an oversight: `Config` holds no secrets by construction
([02](02-configuration.md)), which is the same rule that keeps `GITHUB_TOKEN`, `AZURE_DEVOPS_PAT` and
`LUBBDUBB_TOKEN` in the environment. `auth.tokenFile` is a path worth reading, and blanking it would
hide a useful value while implying the invariant is not real.

### The CI policy tab

The ordered `ci.checks` rules as the running server has them: the glob, the **effective** `states`, the
**effective** `onFailure`, its `guidance` and `urgent` flag, numbered so "first match wins" is
readable. A rule that omitted `onFailure` is drawn as `ignore` and said to have **inherited** it — an
operator reading the config file sees an absent field and has no way to know the omission means "leave
it alone" rather than "fall through to the default". `states` is marked the same way, and a rule that
watches `pending` without `failing` says so explicitly: a failure of that check falls through to a
later rule, which is the one consequence of `states` an operator would not predict from the file.
Below the table, the routing a failing check matching **no rule** takes: `dispatch` — and the note that
a check in any other state matching no rule does nothing, since watching one is opt-in per rule. Under
Azure, the branch-policy kinds and the mode each is surfaced under follow, marked default-or-chosen.

An empty policy is a full answer rather than a blank tab: no rules means every failing check takes the
unmatched routing, and the tab says so.

Every effective value is computed by `describeCiPolicy` on the server
([16](16-http-api.md#get-apici-policy)) — the component asserts nothing of its own about the policy, so
it cannot claim a routing the dispatcher would not take. Read-only, and deliberately: there is no
config-write path in the harness at all.

## Spend

`web/src/components/SpendModal.tsx`, opened from the Spend reading, drawing the payload
`GET /api/spend` returns ([18](18-observability.md#the-spend-breakdown)). It is the answer to the
question every cost figure in the cockpit raises and none of them can hold.

**Fetched on open, three states, and the third is the point.** Loading, the breakdown, and a _failure_
— because a fetch that failed must not render as a fleet that has spent nothing. `$0.00` is a real
answer here (a fresh harness, or one run entirely in PTY mode), so it cannot also be the failure mode.
The all-zero case gets its own sentence rather than a table of zeroes: **unmeasured is not free**, and
a panel of `$0.00` rows says the wrong one of those.

**Nothing here is derived in the browser.** The server ships the splits, for the reason `PrAttention`
and `StackLandingView` are shipped: a cockpit-side re-derivation of which goal a pull request's money
belongs to would be a second opinion about a decision made elsewhere, drawn inches from the first. What
the cockpit owns is presentation — the phase **colours**, which live in the stylesheet as `--sp-<phase>`
so the component names a phase and the sheet decides what that looks like.

Four pictures, in the order the questions arrive:

- **Four tiles** — all-time, the 5h and 7d windows, and the token split. The windows restate exactly
  what the reading the operator just clicked says, and are there for that reason rather than their own:
  a panel opened from a gauge must begin by agreeing with it.
- **Where it went** — one stacked bar over the whole fleet, and a legend that is also the table (cost,
  share, runs, average per run). The blurb under each phase name is the phase's definition, shipped
  with the figures rather than held here, because it is a claim about what the harness did and not
  about how to draw it.
- **The trend** — 14 rolling daily buckets as **bars, not lines**: these are totals over a period and
  not samples of a rate, and a line between two days implies money moved smoothly between them, which
  is exactly what a fleet that ran for one afternoon did not do.
- **By goal**, then **the costliest runs**. Each goal row's bar is drawn at the width of its share of
  the fleet and split by phase inside, so it carries two readings at once: how much of the budget this
  goal was, and what inside it the money went on. The runs table is capped and **says so** — a silently
  truncated table reads as a complete one.

**The method note is part of the panel, not a footnote**, and it sits level with the figures it
qualifies rather than three screens below them. It states the one thing the numbers cannot: dollars are
the provider's own, already net of cache pricing, while tokens are gross with cache reads and writes
folded into input — so the tile's dollars-per-million-input-tokens is a measure of how much cache the
fleet is getting and never a rate card
([18](18-observability.md#dollars-are-net-of-cache-tokens-are-gross)). It also names the unmeasured
runs, which appear in no figure above it.

**It [exports](#exporting-a-reading)**, seven sections in the order the panel draws them — totals,
phases, days, task types, failing checks, goals, runs — with the phase split riding inside each goal
row as it rides inside that goal's bar, and each of the three remainders (reached no goal, named no
check, attributed to a check) carried as its own row.

## Exporting a reading

`web/src/components/Downloads.tsx`. [Spend](#spend) and [Yield](#yield) are the two surfaces that
answer a question nobody asks at the glass — what a month cost, split how, and what it bought — and
those answers are wanted in a spreadsheet, a ticket or a budget review rather than in a tab that is
gone on the next poll. The twins offer the **same three files**, which is the same rule that makes them
twins at all:

- **CSV is what the panel drew**, table by table, in the order it drew them, parted by blank lines and
  each section headed by its own name. Sections rather than one grid, because a panel _is_ several
  tables and flattening them loses which figure was a whole and which was a part. The two files read
  across: opened side by side they answer where the money went and what it bought, which is what the
  panels are for.
- **JSON is what the panel was handed**, unrounded and unformatted — for the next program rather than
  for a person.
- **PDF is the panel itself, printed.** Not a document built to resemble it: the panel is cloned into
  a `#print-sheet` under `body` and the browser lays out the same nodes under the same stylesheet, so
  the graph on paper is the graph on screen and cannot drift from it. **No PDF library** — bundling one
  would mean hand-placing every table and bar a second time, which is a second presentation of one
  reading and the drift this cockpit refuses everywhere else it derives something twice.

Four rules hold them:

- **Figures leave raw.** `fmtUsd` rounds to the cent, `fmtTokens` to three significant figures, a rate
  to a whole percent and a wait to `3.5h` — right for a glance and wrong for a sum, since a hundred
  rows of `$0.00` add up to real money. A rate leaves as a fraction and a duration in milliseconds. The
  cockpit's formatting is presentation and stops at the screen.
- **Every caveat the panel states in prose leaves as a row** — the truncated rankings, the unattributed
  and unnamed remainders, the two halves measured over different windows, a red being a verdict rather
  than a pull request, cost-per-red being per verdict rather than per fix, stopped not being failed. A
  file read six months from now has no method note beside it, so a cap it does not carry is a cap
  nobody will know about. A `null` stays an empty cell and never a `0`.
- **A table added to a panel is added to its export in the same change.** An export that quietly
  forgets one arrives as a complete-looking file that under-reports, which is the failure every rule
  above exists to prevent — and the one the reader has no way to detect.
- **Nothing exports what it could not fetch.** The control is drawn only once there is a payload —
  each panel's own "a failed fetch must not read as a clean fleet" rule, applied to the one artefact
  that outlives the tab.
- **Built in the browser from the data already on screen.** There is no export route, and adding one
  would be a second derivation of a reading the server has already shipped. The CSV carries a
  byte-order mark, because Excel reads a BOM-less UTF-8 file as the local codepage and mangles the one
  goal title with an em dash in it. The print sheet turns the lights on — the tokens are overridden on
  `#print-sheet`, not the components restyled, which is the division the phase colours already keep —
  and keeps the accents, because a phase bar with no colour is not the panel.

`test/insightExport.test.ts` pins the quoting, the sections, the precision and the caveat rows.

## Yield

`web/src/components/ReliabilityModal.tsx`, opened from the Yield reading, drawing the payload
`GET /api/reliability` returns ([18](18-observability.md#the-reliability-breakdown)). It is
[Spend](#spend)'s twin and is built as one deliberately — the same chrome, the same tables, the same
phase vocabulary — because the two answer halves of one question: where the money went, and what it
bought.

**Fetched on open, three states**, for Spend's reason with the sign flipped: a fetch that failed must
not render as a fleet that never fails. 100% is a real answer here, so it cannot also be the failure
mode. A fleet with runs still out and none settled gets its own sentence rather than a table of zeroes
— **not yet is not perfect**.

**Nothing here is derived in the browser**, again for `PrAttention`'s reason. What the cockpit owns is
presentation: the outcome **colours**, which live in the stylesheet as `--rl-<outcome>` beside the phase
palette. The two palettes differ in kind on purpose — a phase is a category whose colours only have to
read apart, while an outcome is a _verdict_ and carries the alarm vocabulary. Grey is doing real work
in it: a killed run is not a fault, and colouring it like one would make every steered fleet look
broken.

Four pictures:

- **Four tiles** — runs finished, money lost to faults, the CI red rate, and the median time back to
  green. The first restates exactly what the reading just said, for the reason Spend's windows do. The
  other two are the rates' _prices_: a rate with no cost beside it is a statistic, and the question an
  operator opened this on was whether to do something about it.
- **How runs ended** — one stacked bar over every settled run, and a legend that is also the table. The
  blurb under each ending is shipped with the figures rather than held here, as the phase copy is.
- **CI verdicts** — 14 rolling daily buckets, red **stacked on** green rather than two series, because
  the reading is a ratio and two lines make that a comparison instead of a glance. Bars for the spend
  trend's reason.
- **By phase**, then the two rankings — the reddest pull requests and the origins that ran more than
  once. Both are capped and **say so**. The repeats table is a ranking and never a count of mistakes: a
  part agent that lands and then answers review comments legitimately runs twice, and what earns it a
  table is that the expensive kind of repetition is invisible everywhere else — a goal whose row shows
  one number quietly went round four times.

**The method note states the two things a reader would otherwise discover by disbelieving the panel:**
the two halves are measured over different windows, and a red is a CI verdict rather than a pull
request. It also names the unmeasured runs, which count in every rate above it and in no dollar.

**It [exports](#exporting-a-reading)** as Spend does, and the twins offer the same three files for the
reason they share their chrome. Six sections — tallies, outcomes, CI days, phases, the reddest pull
requests, the repeats — and the phase table is keyed the way Spend's is, from the same server-side
classifier, so the two files join on it.

## Data flow

One state object, one socket.

- `api.getState()` fetches `/api/state`. The whole UI renders from that object.
- A WebSocket connection delivers events. `dirty`, `world:changed`, `control:changed` and
  `world:events` each trigger a refetch; `cycle:end` also resets the heartbeat countdown anchor.
- **Refetches are coalesced** (`scheduleRefresh`, `REFRESH_COALESCE_MS`): at most one request in
  flight, at most one queued behind it, and a short trailing window so a burst collapses into one. The
  server pairs a coarse `dirty` with almost every specific frame, so one pulse alone is four signals,
  and `agents.on('files')` fires once per file an agent writes — fetching per signal made the request
  rate a function of agent tool-call volume. The queued refetch **always runs**: coalescing may merge
  the signals in between but must never drop the last, or the cockpit settles on a state older than
  what it was told about. The initial fetch on mount is immediate, not delayed.
- `agent:output` deltas accumulate into a per-agent scrollback (capped at ~1M characters) — but only
  for the agent whose drawer is open, because output is delivered to subscribers only.
- `agent:tail` lines land in a separate map.
- The WS client is held in a ref so subscribe/unsubscribe survives effect churn, and it reconnects on
  its own.

The drawer subscribes to full output on open and unsubscribes on close or switch.

## The agent drawer

`AgentDrawer` opens over the page for one agent, asked for by `actions.select(id)` from wherever an
agent is drawn — the Fleet card, a goal page's **On this goal** rows, the escalation card's own way in.

**The transcript pane is HTML, not a terminal.** What reaches the cockpit is already legible text in
every mode (`renderBlocks` output, or settled PTY session-file text), never raw TUI bytes, so it renders
into a scrollable `<div>` with `white-space: pre-wrap; overflow-wrap: anywhere`:

- Words wrap on their boundaries and the browser scrolls natively.
- The pane sticks to the bottom **only when you are already there**, and offers a "New output" jump pill
  otherwise, so a full-rewrite frame no longer snaps you away from where you were reading.
- The text is selectable.

The one terminal feature it reproduces is SGR colour, via the pure parser in
`web/src/components/ansi.ts` (`parseAnsi` / `ansiClass`, tested in `test/ansi.test.ts`), which handles
the five codes `renderBlocks` emits and threads the active style across streamed deltas.

### Tool calls fold out of the way

The pane is read to follow an agent's **reasoning**, and tool output drowned it — one `grep` filled the
view and pushed the thinking into fragments. So a tool call renders as a **collapsed block**: one dim
line carrying the tool name, its one-line input summary, and the result's `· N lines` suffix
([10](10-agent-runtimes.md)). Clicking it reveals the output. Prose reads continuously between them.

- **An error result is never collapsed.** It opens expanded and red, because a failure that hides is
  worse than one that takes up space.
- **Expansion is DOM-only state.** A reseed — an agent switch, or a non-append change to the buffer —
  rebuilds the pane with every block collapsed. Nothing is remembered per tool call.
- **A result folds into the call above it only when that call is unambiguous.** Two tool calls with no
  result between them means the agent fired them in parallel, and the stream carries no ids to pair
  them by; each result then renders as its own standalone collapsed block rather than being attributed
  to the wrong call.
- **A PTY transcript carries no markers**, so it renders as plain prose with nothing to collapse. That
  is a property of the runtime, not a gap.

The structure is found, not shipped: the transcript is still a flat text stream, and
`web/src/components/transcriptBlocks.ts` (`feedBlocks`, pure, tested in `test/transcriptBlocks.test.ts`)
recognises the labelled lines the server writes and emits DOM operations the drawer applies. Its tests
feed it **real `renderBlocks` output**, so the writer and the reader of those markers cannot drift apart
quietly. A partial trailing line is held in parse state — a marker split across two deltas must not
half-parse — and rendered separately so streaming text is still shown while it arrives.

**No xterm remains anywhere.** The browser-side `@xterm/xterm` and `@xterm/addon-fit` went first, and
`@xterm/headless` went with the server-side screen-scraping it existed to do.

The drawer also shows the artifact chips, the **files changed** list from `files`, and offers respond,
interrupt and kill.

## The plan modal

`PlanModal` (`web/src/components/`) is the whole decomposition, on demand — the record of what was
agreed, not just the question that was asked. Before it, a plan was legible only while it was a pending
proposal: the approval card rendered a template string and vanished on the click. There was no way to
say "show me the plan for #231" at any time, once or after it was answered.

**It is shell-owned**, opened through `viewPlan(planId: string | null)` on `CockpitActions` — the same
seam `select(agentId)` uses, and for the same reason: one implementation of the modal, reachable from
whichever surface mentions the plan.

**Two tabs**, because the decision view has to stay short enough to hold in your head:

- **Plan** — the planner's reason in full; **Risks** and **Deliberately out of scope** side by side
  when present; every part in dispatch order with its scope, `rationale` (why its own PR), `acceptance`
  (done when), the stack edge spelled out as a sentence rather than the terse `on <slug>` chip, its
  status, its PR when it has one, and its "Up next" queue state (`unapproved` / `capped` / `▶ now`).
- **Full write-up** — `plan.document`, rendered. Absent renders "This planner wrote no write-up", never
  a hidden tab (see [08](08-planning.md)).

Approve / Reject appear only while the plan is `awaiting_approval`, and route through the same
`decideProposal` the escalation card uses — one verdict, one implementation, so the rail's row clears
either way whichever surface you decided from. Replan and Abandon sit apart, because they settle
nothing about the proposal in front of you. While a plan is being discussed the modal shows the
conversation instead — the agent's status and last note, and a reply box that posts through
`POST /api/agents/:id/respond` — and offers **End discussion** instead of a verdict.

**Every entry point is keyed on the plan existing, and none on what it is doing.** That is a
correction, not a restatement: entry points keyed on a transient condition left the modal reachable
only during the approval window, so the click that approved a plan was also the click that took away
the only way to read it back.

## The notepad modal

`ScratchpadModal` (`web/src/components/`) is a goal's shared scratchpad, on demand: every note every
agent working it left, oldest first, attributed to the origin that wrote it. It is the testimony the
retrospective is written _from_ — and until it existed, the write-up was the only account of a run that
anybody outside the fleet could read. The pad was written by agents (`scratch_append`), read by agents
(`scratch_read`), and quoted by one retrospective agent, so a claim in the write-up was checkable
against nothing.

**Shell-owned**, opened through `viewScratchpad(issueRef: string | null)` — the plan and retrospective
modals' seam, and for their reason. The trail is fetched on open (`GET /api/scratchpads/:ref`); the
snapshot carries only the count and the age, which is what the goal page's tail draws its way in from.

**Three states, and the third is the point**: loading, the trail, and an **error** — a fetch that
failed must not render as "nobody wrote anything". That matters more here than for the write-up,
because an empty pad is unreachable by construction: nothing draws a way in unless the snapshot says
there are entries, so an empty trail on screen means the fetch and the snapshot disagree.

**Notes render as plain text with their newlines kept**, not as markdown — the opposite choice to the
plan and retrospective documents, which are written to be read as documents. A pad note is one agent's
testimony, and rendering it would let a stray backtick or hash change what that testimony looks like.

## Links

The cockpit never builds a provider URL. `refUrls` in the state snapshot is a `ref → URL` map, and
`linkify` / `refLink` (`web/src/components/util.tsx`) look refs up in it. A ref the provider could not
resolve is absent from the map and renders as plain text — which is what the `fake` provider produces.

`refChip(ref, label, refUrls, title?)` is the third of them, for refs whose canonical shape is
machinery a human does not read (`issue:12:comment:456`). It renders **nothing at all** unless the
provider resolved the ref: a caption with no link asserts something exists while giving nobody a way to
read it.

**Every reference the UI shows is routed through one of the three (#199), with no exceptions.** The
rule is uniform: a PR/issue number links as `refLink('#'+n, refUrls)`, a colon-form origin or structured
ref as `refLink(ref, refUrls)`, free text carrying `#n` mentions through `linkify(text, refUrls)`. So
the goal page's pull requests, the overview's rack and up-next rows, the backlog's rows, the world
signals, the findings panel, escalations, the plan modal, the recovery cards, the agent drawer and the
work-tree panel all draw links wherever the provider can resolve them.

For those link sites to resolve, five ref families the item lists do not cover are keyed on their own in
`buildRefUrls` (see [16](16-http-api.md#the-state-snapshot)): **world-event refs** (`pr:42`, `issue:13` — the
structured ref each signal draws), **task origin refs** (`pr:142:ci`, `issue:13:part:x` — what the
fleet, overlap and recovery cards link), **every goal's own canonical ref** (`issue:13` for each world
issue and each retained run — a family keyed only when a task or event happens to name it is one that
links on a busy world and renders plain on a quiet one), **each decision's subject ref**, and, on the
`/api/work` routes, the **work roots and stacked base refs**. A `job:<id>` origin, or anything the
provider cannot map, is simply omitted and renders plain.

**A decision's subject ref is derived on the server and shipped on the row**, not re-derived in the
browser from the action bag — [16](16-http-api.md#the-state-snapshot) has why.

## Agent-authored prose

Text an agent wrote for a human to read is drawn by **structure**, not as one run of characters. Three
rules, and the split between the first two is the whole of it:

- **Prose is markdown.** `renderMarkdown` (`web/src/components/markdown.ts`) — a hand-written subset
  (ATX headings, unordered and ordered lists, fenced and inline code, blockquotes, paragraphs, and
  inline `code`, `**strong**` and `*emphasis*`), returning React nodes and **never**
  `dangerouslySetInnerHTML`. It does **not** render links: a URL in a write-up appears as literal text.
  The same precedent as `ansi.ts` being hand-written rather than pulling in a library, and for a
  sharper reason here: agent-authored text meets a renderer that never interprets HTML, so there is no
  injection surface to reason about at all. Used by the goal page's ticket and bench detail, the plan
  and retro modals, a finding's `detail`, and an escalation's `detail`.
- **Captured output stays `<pre>`.** An escalation's `recentOutput` and a draft reply are what the
  process emitted, and preformatted is what they _are_. Markdown-rendering them would reflow columns
  that mean something.
- **A field the operator scans is drawn as one line.** A finding's `summary` is validated to be one
  ([13](13-jobs-and-findings.md#the-three-text-fields)) and clamped to two in CSS regardless, because
  rows filed before that validation existed hold an entire report in it.

### How an escalation card is laid out

The rule behind it: **`prompt` is the harness speaking to you, and `context.detail` is text the harness
is _quoting_ from an agent.** Two mechanisms follow, doing two different jobs, and neither subsumes the
other.

- **The prompt splits at its first blank line.** The first paragraph is the headline; the rest is the
  body, rendered as markdown. Both halves are the same author's words — a rule writing "here is what
  happened" and then "here is what accepting does" is writing one message with two paragraphs — so the
  split is the card's and not the author's. Asking every rule and every operator override to file its
  second half somewhere else would be a second contract to get wrong.
- **Quoted text lives in `context.detail`**, never spliced into the prompt. It is up to two thousand
  characters of someone else's prose; interpolating it is what turned a shortfall card into one
  unreadable paragraph, and it leaves the cockpit unable to label a block whose edges it cannot see.
  `renderMarkdown` draws it, with `refUrls`, so a `#142` inside it stays a link.
- **`context.detailFrom` names who wrote that block, declared by whoever quoted it.** Never derived
  from `agentId`: the harness quotes an assessor on a shortfall and a planner on a decomposition and
  both arrive with no agent behind them, so "no agent, therefore an assessor" mislabels every plan
  approval. Absent, the card names no role.
- **The body is open and uncapped.** No `<details>`, no `max-height`. It is the thing you opened the
  band to read. Every block of prose is held to a ~72ch measure. `recentOutput` and `draft` keep their
  `<pre>` and their 180px cap — they are evidence you glance at, not the thing you are deciding.

A **permission request** (`context.permission`, #130) renders the command and **Allow / Deny** instead
of the answer box — the agent is blocked in a tool call, so the verdict goes to
`POST /api/escalations/:id/permission`, not `/answer`. A **questionnaire** (`context.questions`) is the
third replacement: a count chip and an **Answer N questions →** button opening `QuestionnaireModal`, one
card per question. The list does not unpack into the band — one ask that becomes three is no longer one
ask. Its options **fill** the box rather than sending, which is what separates them from the card's
one-click chips: those settle a question, where here every answer waits for the others. One **Send
answers** posts the whole array to `/answer`; a question left blank is sent as an explicit non-answer,
so the agent knows not to wait on it.

## Chips and verdicts

Three per-item verdicts are computed **on the server** and merely rendered here, so the UI can never
disagree with what the dispatcher does:

- **PR health** — `prHealth(pr, allOpenPrs)`, attached per PR. It names an inherited CI failure as
  `CI failing on base PR #n`.
- **PR attention** — `prAttentionStatus(pr, ctx)`, attached per PR and drawn as the court chip. The
  chip names the **court** and nothing else — `you`, `harness`, `elsewhere`, `settled`, `stalled`,
  `done`, `ignored` — because scanning a list for "what is mine" is what it exists for; the full
  reasons are in the `title`. Four of the seven take a tone (`courtTone`); the rest print plain.
- **Issue pickup** — `issuePickupStatus(issue, ctx)`, attached per issue. The backlog draws its first
  reason as the row's sentence, and its `container` arm is what disables a watch toggle.

**Nothing is derived in the browser that the server decided.** `attention.status`, `ciVerdict`,
`health.reasons`, `QueueItem.reason`, `pickup.reasons` and the assay summary are quoted, never parsed —
the rule that keeps the cockpit from holding a second opinion about a decision made elsewhere, drawn
inches from the first. The **lenses** that produce them — the work graph (`src/graph/`), `buildStacks`,
`prAttentionStatus`, `findings` and `overlaps` — stay read-only views out of `src/dispatcher/`, asserted
structurally in `test/workGraph.test.ts`, `test/stacks.test.ts` and `test/prAttention.test.ts`.

## What ships and nothing draws

Stated rather than left to be discovered, because a snapshot field with no reader is indistinguishable
from a reader that broke, and because each of these is a decision rather than an omission:

- **`CockpitActions.setStackLanding` has no caller.** The console draws pull requests as a **flat
  rack** — one row per open PR, ordered by the server, with the court chip and the CI ladder — and not
  as chains. The stack model itself is unaffected and is the server's
  ([07](07-pull-requests.md#landing-a-stack)); what is absent is a surface that authorizes landing a
  whole chain. The seam keeps the method because the refusal rules behind it are the server's and a
  future surface must reach them through here rather than through `api.js`.
- **File overlaps ship in `/api/state` and no console surface draws the list.** Only
  `liveOverlapCount` is folded on the view model. [12](12-artifacts-and-files.md#file-overlap-detection)
  states this from the detector's side; it is not restated here.
- **`groupByFeature` (`web/src/issueGroups.ts`) is drawn by nothing.** The Azure work-item tree arranged
  the old flat world panel's rows; the backlog groups by watch state instead, which is the axis triage
  acts on. The fold is pure and tested (`test/issueGroups.test.ts`) and is what a hierarchy view would
  be built from.
- **`reorderUpNext`, `dismissHumanTask` and `fetchWorkSubtree` have no caller either.** The overview's
  Up next is a reading rather than a control; the rail carries only `open` human tasks, so there is no
  settled tail to dismiss from; and the work graph is shell-owned and reaches its own route directly.
- **`tailByAgent` is folded and drawn nowhere.** `agent:tail` frames still arrive and still cost
  nothing to keep — they are one line per agent — but the fleet row draws the agent's `note`
  instead, which is what the agent chose to say rather than whatever its last line happened to be.
- **`plan.statusCommentRef` and `issue.assay.commentRef` are drawn nowhere.** Both are canonical comment
  refs the harness maintains on a ticket ([15](15-integrations.md#comment-refs)); the surfaces that
  captioned them were the old world panel's rows.

Each of these is a surface's absence, not a wire change: removing the field would make re-adding the
surface a server change, and the fold under it is what a future one is built from.

## Demo mode

`npm run web:build:demo` builds with `mode: demo`. `web/src/api.ts` then swaps `api` and `connectWs`
for `demoApi` / `connectDemoWs` (`web/src/demo/`), which serve a scripted fixture world with no server
and no real integrations. The top bar shows a `demo` mark beside the ident.

**The statically hosted Pages build is the only demo there is**, and that is the whole of what the demo
code has to serve. There is no second demo entry point — no dev-server demo mode, and no server-side
demo either: the harness has no `/api/inject` route, no `config.injectable` flag and no inject panel of
its own. Injection lives entirely in the browser fake, reached through `injectDemoEvent` in
`web/src/api.ts`, which folds on the same `VITE_DEMO` constant `api` does so the demo module stays out
of the production bundle.

**Schedules are real in the demo, and never fire there.** Writing a recurrence, editing it, pausing it
and deleting it all work against the fixture state, and "run now" queues the job exactly as the launch
composer does — which is the honest demo of the feature, since what a schedule _does_ is queue a job and
the queue is on the same panel. What is missing is the clock: nothing in the browser drives a pulse, and
`nextRunAt` is left null rather than computed, for the reason `getPrompts` ships an empty book — the
cron parser is server code, and a second implementation here would be a copy free to disagree with the
only one that schedules anything.

That is the bar for anything under `web/src/demo/`: it earns its place by being something the Pages
build reaches. What that does **not** license is trimming the constant-answering arms of `demoApi`
(`getPrompts`, `getConfig`, `getWorkRoots`, `decideRecovery` and the rest). They answer a constant
because the demo has no server to ask, and they exist because `api` is one seam both halves satisfy
structurally — a missing arm is a compile error at the call site, not dead weight. The honest reading of
"unused" here is the panel that never draws, not the method that never runs.

## Tests

Five files, split on what they can see:

- `test/cockpitViewModel.test.ts` — the derivations `buildViewModel` folds, untestable while they lived
  inside a component.
- `test/needsYou.test.ts` — the merged queue and, first among them, its ordering.
- `test/goalPage.test.ts` — the page's assembly: which parts, PRs, agents and decisions belong to a
  goal, and the prefix trap `issue:14` versus `issue:1`.
- `test/console.test.ts` — the structural rules and the renders, against the demo fixtures.
- `test/insightExport.test.ts` — the [exports](#exporting-a-reading): the CSV quoting, the sections and
  their order, that figures leave unrounded, and that each caveat the panel speaks leaves as a row.

The renders are wrapped in a **clock pin**, because `buildDemoState` stamps every timestamp relative to
`Date.now()` and the rendered relative times would drift between runs otherwise.

`test/console.test.ts` holds the two structural assertions the layer split rests on — nothing under
`console/` imports `api.js`, and `console.css` never targets a shared component's class — and pins the
renders where being wrong would be worse than being absent: the rail carrying every blocking kind in one
list, its array order surviving the grouping, the holding count agreeing with its noun, an empty queue
muting rather than removing the rail, a group with no rows drawing no heading, a row with a goal being a
button and the recovery hold not, the ask drawn above the plan, a goal with no ask drawing no band, the
goal page answering through the shared card, a held part quoting the reconciler, a goal with no measured
spend drawing no `$0.00`, the overview's five cards, an empty rack still drawing, the backlog's four
groups and its disabled container toggle, the fault log keeping its clear at zero, a panel's two ways
out, the demo gate on injection, the precedence between a goal, the backlog and the overview, the
recovery banner outside the situation area, a dropped socket drawing nothing at all, and the shell
rendering the drawer the console only asks for.
