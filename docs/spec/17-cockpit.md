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

| Layer        | Path               | Job                                                                                                                        |
| ------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Wiring       | `web/src/cockpit/` | fetch, websocket, coalesced refresh, the [place in the address bar](#the-address-bar), the bound `CockpitActions`. No JSX. |
| Derivation   | `web/src/view/`    | the pure `buildViewModel` → `CockpitView`, and the derivations it folds. No React.                                         |
| Presentation | `web/src/console/` | the console — the whole drawn surface, rooted at `ConsoleRoot`.                                                            |

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
  goal page's sections, the overview's cards, the tickets table's rows, the top bar's readings.

`test/console.test.ts` pins the embedding from the sharp end: a goal page answering an ask must render
the shared card, not a compact copy of it, because a copy is how one surface ends up offering free
text on a proposal that only takes a verdict.

**Five surfaces hang off the shell rather than off the console**, and each for one reason — it is
_overlaid_ rather than placed. Which one is open is cockpit state, not console state (the drawer's
output subscription is tied to it), and the surfaces that open one are scattered across the page:

| Surface                                        | Opened from                                                 |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `AgentDrawer`                                  | a fleet row, a goal's part, an ask — `select`               |
| `PlanModal` / `RetroModal` / `ScratchpadModal` | the goal page — `viewPlan` / `viewRetro` / `viewScratchpad` |
| `SettingsModal`                                | the top bar — `openSettings`                                |
| `SpendModal`                                   | the Spend reading — `openSpend`                             |
| `ReliabilityModal`                             | the Yield reading — `openReliability`                       |

The console asks for each the way it asks for a plan — a method on the seam — and the shell answers.

**Reaching `api.js` is not itself a reason to sit on the shell.** The rule is that no module under
`console/` _imports_ it; a shared component that does is embedded like any other, and several are —
`LaunchPanel`, `SchedulePanel` and `WorkTreePanel` all ride their own routes from inside the console.

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

Four surfaces and one shell.

```
┌──────────────────────────────────────────────────────────────────────┐
│ ident │ Overview Backlog Work │ Scan · Fleet    Spend Yield … Launch ⚙ │  top bar
├────────────────────────────────────────────────────────────────────────┤
│ the recovery banner, when a previous run left work orphaned            │
├───────────────┬────────────────────────────────────────────────────────┤
│ NEEDS YOU  6  │  ‹ Overview / #142 Retry the intake   ← only on a goal │
│ ┌───────────┐ │                                                        │
│ │ Blocking  │ │                                                        │
│ │ escalation│ │             the situation area                         │
│ │ plan      │ │    (a tab — overview, work, tickets — or a goal page)  │
│ │ permission│ │                                                        │
│ │ Yours     │ │                                                        │
│ │ bench     │ │                                                        │
│ │ close-out │ │                                                        │
│ └───────────┘ │                                                        │
└───────────────┴────────────────────────────────────────────────────────┘
```

**The recovery banner sits outside the situation area and above it, at every width.** While a crashed
run stands, the harness runs no cycles at all — so every goal the rail or the situation area would draw
is stale for the same one reason, and the banner is the one thing on screen still true. It is a block,
not a card in a track, so it needs no span rule to be full width. `test/console.test.ts` asserts the
placement rather than trusting the stylesheet.

**The situation area draws exactly one thing**, and the precedence is load-bearing: a selected goal
outranks the nav's tab, whichever it is. Selecting a goal is what a queue row does, and it does not
move the nav — so with a tab winning, clicking an ask would land the operator on a triage list, or on
the record, instead of on the ask.

The **nav** is three tabs: Overview, Work, and Tickets — the last carrying the untriaged count, the
one number that says whether triage is worth opening. It is `untriagedCount` (`web/src/worldBuckets.ts`)
over the same watch bucket the tab's Unwatched filter uses, so the number on the button and the rows
behind it cannot differ, and it is hidden at zero because a badge that always shows is one nobody
reads. Every button clears _both_ pieces of state, because a nav click
means "go here" and either half left standing would land somewhere else.

**The nav sits in the top bar** (`TopBar.tsx`), not at the head of the situation area. The situation
area scrolls, and a page's primary navigation that scrolls away is navigation you have to scroll back
to find; the bar is the `auto` row of the `.cn` grid and is the only part of the shell always on
screen. It is drawn at the bar's own size rather than the smaller type the readings wear, because the
readings are glanced at and the nav is aimed at, and it is `nowrap` where the readings wrap — three
tabs stacked one per line is not a tab strip. When the bar runs out of room the _bar_ wraps, dropping
the readings to a second line and leaving the nav whole.

**The crumb is not in the nav**; it is drawn at the head of the situation area, and only when a goal
is open. Two reasons that are one reason: an issue title has no length limit, so a crumb in the bar
widens the nav by whatever a title happens to be and reflows the readings on the act of opening a
goal — and the bar is the row an operator glances at without looking, so it has to be the same shape
every time. And the crumb names what the _situation area_ is showing, so that is where it belongs. It
reads `‹ <the tab you left> / #<n> <title>`, and the back button is `selectGoal(null)` alone: the tab
was never cleared, so there is nothing to restore, and naming it is what makes the crumb a trail
rather than a label.

The tabs are a **list** (`ConsoleTab`, `web/src/cockpit/actions.ts`) rather than a hand-written pair
of buttons over a boolean, for `ConsolePanel`'s reason: a destination that has to be remembered in two
booleans and four call sites is a destination that arrives half-wired. `test/console.test.ts` renders
the nav and asserts all three labels, so a tab added to the type and forgotten in the nav is a view
nothing can reach — and fails.

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

## The address bar

Where the operator is lives in the URL's **query string**, so the browser's back button, a reload, a
bookmark and a second tab all mean what they say. `web/src/cockpit/place.ts` holds the whole of it:
one `Place` record, a `readPlace` that parses one out of a query string and a `placeQuery` that
writes one back.

`Place` is every piece of state that answers _what am I looking at_ — the tab, the selected goal, the
panel in front, the open drawer, the plan sheet, the retrospective, the notepad, and the three top-bar
modals — and nothing that answers _what is true_. It replaced ten independent `useState`s in
`useCockpit`, and one record rather than ten is the load-bearing part: a drawer opened over a goal
page on the tickets tab is **one** place, and stepping back out of it has to restore all three at
once.

| Parameter                            | Carries                                                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `tab`                                | `work` / `tickets`; the overview is the absent value. `backlog` is an alias for `tickets`, so links to the deleted tab still land |
| `goal`                               | the open goal page, as `issue:<n>`                                                                                                |
| `panel`                              | `findings` / `lessons` / `faults` / `output` / `launch`                                                                           |
| `ask`                                | the queue row a `{ ask }` panel is showing                                                                                        |
| `agent`                              | the open drawer's agent                                                                                                           |
| `plan` / `retro` / `pad`             | the plan sheet, the retrospective, the notepad                                                                                    |
| `settings` / `spend` / `reliability` | the three top-bar modals                                                                                                          |
| `collapsed`                          | the tickets tab's features folded away, as `3,12`                                                                                 |
| `watch`                              | the Tickets tab's harness axis: `watched` / `unwatched` / `ignored`; `any` is the absent value                                    |
| `tracking`                           | what the harness is doing about it: `any` / `frozen`; `live` is the absent value, since the tab is the surface work happens on    |
| `state`                              | its tracker axis, in the tracker's own word; `any` is the absent value. `open` / `closed` are read as the old `tracking` axis     |
| `feature`                            | one feature by issue number, or `none` for the orphans; every feature is the absent value                                         |
| `group`                              | how the list is arranged: `flat`; `feature` is the absent value                                                                   |
| `order`                              | how the Tickets tab is ordered: `cost`; `added` is the absent value                                                               |

**The query string rather than the path**, for three reasons that are one reason — nothing else has to
agree with the console about where it is served from. The token arrives in the fragment and is
stripped to `pathname + search` ([tokens](#tokens)), the demo is published wherever it is published,
and the harness's SPA fallback answers every non-`/api` path with `index.html`.

**Defaults are omitted**, so the overview with nothing open is a bare URL and each place has exactly
one spelling. That is what makes the comparison in `useNavigation` sound: it pushes nothing when the
query is unchanged, and two spellings of one place would be a history entry that goes nowhere —
clicking the tab you are on is not somewhere to go back from.

**A move made in one tick is one history entry.** Several surfaces navigate twice on a single click:
the nav clears the goal and then sets the tab, an ask closes its panel and then opens the goal page.
Two entries there would put a state nobody was ever on between the operator and the back button, so
`useNavigation` applies each patch to a ref immediately — the second `go` of a tick sees the first —
and pushes once, in a microtask, from wherever the place ended up.

**Every value is validated back into its type on the way in**, because this is the one input to the
cockpit an operator can type. An unrecognised tab or panel is not an error worth a screen; it is a
place that does not exist, and the answer to that is the overview. The entry the cockpit boots on is
normalised with `replaceState` for the same reason the push is skipped: a URL saying something the
console does not would make the first real move look like a change when it is not.

`test/cockpitPlace.test.ts` pins the codec — the round trip for every destination, the bare URL, the
single spelling, an unknown value reading as the overview, and an ask id surviving encoding.

**Reaching the URL is only the first leg.** A `Place` field is carried to the surface that draws it
through the view model — `useCockpit` hands the fields to `buildViewModel`, which defaults each one it
is not given. A field the hook never forwards therefore round-trips through the query string perfectly
and still draws its default: the button updates the address bar, highlights nothing and re-reads no
list. That is a dead control with nothing red, and it happened to the tickets tab's `tracking`,
`feature` and `group` at once. Adding a field to `Place` is both legs, and `test/cockpitPlace.test.ts`
reads the `ticket*` fields off `place.ts` and asserts the hook forwards every one.

## The queue rail — "Needs you"

A permanent left column holding **every** blocking item in one list: escalations, plan proposals,
permission requests, unanswered goal-profile proposals, usage-limit parks, bench tasks, close-outs,
validate rows and the recovery hold. `buildNeedsYou`
(`web/src/view/needsYou.ts`) is the merge, and it is pure.

**Nine kinds, and the split is about what answers them.** `permission` and `proposal` are escalations
underneath, named apart because the verdict differs — a permission goes to `/permission`, a proposal
carries accept/reject, a plain question takes free text. Drawing them as one kind is how a surface ends
up offering the wrong control. `bench` and `close_out` are human tasks, likewise split, since a
close-out is the step after a launch and reads as one ([13](13-jobs-and-findings.md#the-step-after-the-launch-the-close-out)).
`validate` is split from both for the same reason one layer on: it is the _other_ step after a launch
([13](13-jobs-and-findings.md#the-other-step-after-the-launch-the-validation)), and a row that read
`Bench` would tell an operator nothing about why it appeared the day the goal was delivered. All three
are answered the same two ways — done, or declined with a reason — which is why they share a body.

**`profile` is the second kind with no row of its own underneath it** — it is read off
`issue.assay.awaitingProfileAnswer`, the goal-profile gate ([06](06-issue-pickup.md#the-second-arm-an-unanswered-profile-proposal-issue-342)),
because the harness raises no escalation and files no task for it: the proposal _is_ the ask. It is in
the queue for what makes that gate different from every other hold — it expires on nothing but the
answer, so a gate nobody sees is a goal stopped for good. It was drawn on the goal's own page and
nowhere else, which is the page an operator has no reason to open for a goal that looks like it merely
has not come up yet. Its verdict is the two the gate has always had — take the proposal, or keep what
is standing — both through one write, so "keep mine" settles the question rather than leaving it
re-readable as an unanswered disagreement. It is derived from `world.issues` and never the retained
runs: a goal the world no longer carries is not one the funnel is refusing to dispatch.

**`limit` is the one kind with no row of its own underneath it.** It is built from the _fleet_ —
`state.parkedOnLimit`, keyed on the agent — because a usage-limit park raises no escalation on purpose:
there is no question in it to answer ([10](10-agent-runtimes.md#the-limit-park)). Its verdict is
`Resume`, and its second control is the transcript, which is where an operator decides whether carrying
on is worth it. Most of these rows clear themselves: the pulse ends a park once the window `claude`
named has turned over ([10](10-agent-runtimes.md#ending-it-on-the-clock)), so `Resume` is for going
early, and for the parks that carry no reset time and would otherwise sit there for good. It draws no reply box anywhere, because the agent's process is usually gone with the
limit and a box that cannot send is worse than no box.

**Two groups, split on who is stopped.** `blocking` means an agent is parked and cannot proceed;
`yours` means the obligation is the operator's and nothing inside the fleet is waiting. A profile gate
is `yours` for that reason and against how much it stops: it holds a whole goal's dispatch, and no
agent is sitting in it. The rule is about a held slot, and widening it here would cost red the only
thing it means. That is the
whole of the colour rule: **red means an agent is parked and only you can un-park it, and nothing
else.** A bench task genuinely blocks no agent, so it is amber, and the merge of eight surfaces into
one list preserves the distinction rather than flattening it. A limit park is red for the rule's own
reason and not by analogy: the agent is stopped, its worktree and its slot are held, and the harness
will not resume it on its own — all that differs from a question is what the operator does, which is
wait for the window to turn over.

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

**Every row that can be answered opens somewhere, and `row.opens` says where.** A row is a link to a
goal wherever there is one: `opens: 'goal'` calls `selectGoal(row.goalRef)` and draws that goal's page
with the ask pinned at the top of it, which is the console's whole claim about asks. The other two
values are the cases where that is not possible:

- **`'ask'` — the ask panel**, a full-surface panel drawing the same `NeedsBand` the goal page draws,
  through the same shared components. It is the destination for an ask with **no goal page to be
  answered on**: an escalation on a pull request no ticket owns, a bench task with no ticket, or a
  goal-shaped ref the world no longer carries. The panel closes itself — answering settles the row,
  the next snapshot drops it from `needsYou`, and a panel whose row is gone draws nothing rather than
  offering a second verdict on a settled ask.
- **`null` — the recovery hold alone**, which is harness-wide and is answered on the banner above the
  console. It renders as a `div` rather than a `button`, because it is the one row with nowhere to go.

**A `pr:<n>` origin is resolved to its goal, not read literally.** Most asks the harness raises come
from a pull request — every rebase and CI question does — and most pull requests belong to a goal.
`goalOf` therefore asks `goalOfPr` (`web/src/view/goalPage.ts`), which matches the same three ways
`ownsPr` does, read backwards: a part's `prNumber`, the tracker's `linkedPrNumber`, or the branch
convention. The convention itself has **one** implementation, `branchGoal`, because it is read in both
directions and two readings of one string shape is how `issue/14` comes to match `issue:1`. A PR no
ticket owns resolves to null and keeps the ask panel: the harness works ticketless pull requests as
first-class subjects ([05](05-dispatcher.md)), so that is a real answer rather than a lookup failure.

**`goalRef` is where an ask is read; `originRef` is what it is about.** Both ride on the row, because
a resolved PR ask needs to say both — its goal page is where it belongs, and `#142` is still the thing
in question. `subjectLabel` words it once for the rail and the panel: `#12`, else `PR #142`, else
nothing.

**The ask panel states its subject, always as a link.** It is the one surface with no context drawn
around it, so `AskSubject` sits above the scrolling body: a goal reads _On goal #12 — read it in
context →_, which closes the panel and opens that page (the band there draws the same ask, and a panel
left standing over it would be one verdict offered twice); an orphan reads _No linked goal · raised on
#142, a pull request no ticket owns_, linked out to the provider; and an ask with neither says so in
those words. Blank was the failure mode being fixed — an operator who cannot tell "no goal" from "the
goal did not load" is answering blind.

**A band on the goal page can be opened as that panel** (`Open` in its header), for a goal carrying
several asks or a page scrolled past one. It is the same `needBody`, so it is one ask reachable two
ways rather than two asks.

**The demo carries no goal-less ask.** Both fixture pull requests under work are owned by a ticket
(`#388` → PR #412, `#376` → PR #409), so every row in the demo's rail leads to a goal page. The
goal-less reading is still exercised — `test/console.test.ts` builds the orphan rather than fishing
one out of the fixtures — because what the harness does is not what a demo should teach.

**The destination is decided in `buildNeedsYou`, never in the rail**, and this is the load-bearing
part: only the derivation can tell a `goalRef` that _has_ a page from one that merely looks like it
does, which it asks through `goalIssue` — the same lookup `buildGoalPage` returns null on, so the two
cannot drift. A rail that routed on `goalRef` alone drew every PR-origin escalation as an inert `div`
and every ref the world had dropped as a click that landed nowhere; both read, to an operator, as a
console that is broken. `test/console.test.ts` asserts all three shapes and that the ask panel closes
on the row settling; `test/needsYou.test.ts` asserts the routing itself.

**While a goal's page is open, the rail says which of its rows are the ones on screen.** A row whose
`goalRef` names that goal is marked `aria-current` and drawn against the accent; every other row is
dimmed. The two halves are one reading — the page is the ask's context, so the rail's job while it is
open is to state which asks that context covers, and an unmarked rail leaves the operator matching
`#12` against a crumb by eye.

**Dimmed, never filtered.** The rail is the fleet's whole queue and it is the only surface carrying
some of these kinds at all; a row removed while a goal is open is a blocker nobody answers, and the
count in the heading would stop matching what is under it. So muting is opacity alone — the row stays
legible, clickable, and returns to full on hover or keyboard focus. **The recovery hold is never
dimmed**: while it stands no pulse runs at all, so it is not some other goal's business.

The focus is read off `goalPage`, not `selectedGoal` — a selected ref the world does not carry draws
no page, and highlighting against it would mute the entire rail in favour of a goal that is not on
screen.

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
   assayer's own summary in its title, the conclusion verdict, the validation verdict as a settled
   count (absent when the goal has no checks — "no plan" is a third reading and not a synonym for
   clear, [20](20-validation.md)), when the run started, the agent count,
   what it has cost, and how many parts have merged. Every chip quotes a reading the server already
   made; nothing here is a second opinion. A `null` spend draws no reading at all, because nothing
   was ever measured and `$0.00` would report a goal that cost nothing
   ([18](18-observability.md#per-goal-spend)). The validation chip is the one that is a **button**:
   the checks are on this page now, so the reading has somewhere to go, and a verdict you can act on
   should not be the only chip that does nothing.
2. **The "Needs you" bands** — every open ask on this goal, stacked, answerable in place. Red for
   asks blocking an agent, amber for the operator's own, the rail's own split carried over so a row
   and the band it opens read the same. **A goal with no ask draws no band at all** — a band that is
   sometimes furniture stops being read as a demand — and `test/console.test.ts` asserts that from both
   sides. The band is `NeedsBand` (`web/src/console/NeedsBand.tsx`), its own module rather than the
   goal page's private component, because the goal page is not the only place an ask is read: the ask
   panel draws the same band for a row with no goal page. One band, two placements — a second wiring
   is a second set of verdicts to keep in step.
3. **Validation** — how anyone checks the goal was met, and what anybody concluded from running each
   check. Full width, above the two columns ([Validation](#validation-on-the-goal)).
4. **The plan**, left to right in dispatch order.
5. **The ticket as it stood at pickup** — what a plan, an assay or an ask is judged against, drawn
   through `renderRichText` because the body is the _tracker's_ prose and Azure DevOps writes it as
   HTML ([Tracker-authored prose](#tracker-authored-prose)).
6. **Pull requests for this goal**, open and closed, with the court chip and the CI ladder.

At ≥1500px a right-hand column carries **On this goal** (who is working it now), **Spend** and **The
tail**. Below that, the two stacks are one column.

### The header's controls

Watch, the priority flag, the profile pin, the conclusion, raising a bug, the ticket, and ending the
run.

- **The watch toggle writes both tags.** `setIssueWatched` tags the watch label and clears the ignore
  label, or the reverse — so the title names both. Saying only "remove the watch label" understates a
  click that also tags the goal ignored, and the difference is visible: the goal lands in the
  tickets tab's Ignored filter rather than back in Unwatched.
- **Prioritise / Priority** puts this goal at the front of the queue — everything under it, its plan,
  its parts and its pull requests included — and clicking it again hands the queue back to its natural
  order ([05](05-dispatcher.md#marking-a-goal-a-priority)). It sits beside the watch toggle because it
  is the next thing an operator says after "work this", and its title is worded as a **queue**
  statement rather than an importance one: it changes what the fleet reaches for while it is short of
  slots, and it changes nothing about whether the goal is allowed to move. A goal held by a cooldown,
  a part cap or an unapproved plan is still held, flagged. The flagged state and its age are read off
  `Issue.priority`, so the button cannot claim a priority the dispatcher is not honouring.
- **Three conclusion controls, not two.** `Mark done` / `Unfinish` writes or withdraws `done`. **More
  work** opens `InstructionModal` and writes what the operator wants done next, in words — it is a
  third control rather than the finished toggle's other end because what it writes is not the opposite
  of `done`: it is an instruction, plus the `more_work` that puts the goal back in front of the harness
  once no PR is open ([06](06-issue-pickup.md#concluding-an-issue),
  [16](16-http-api.md#post-apiissuesnumberinstruction)). It is offered on any open ticket, **including
  one that already carries instructions** — a second thing the operator wants is a second instruction,
  and the button that hid itself once the verdict was set was a goal they could no longer say anything
  about. It carries the standing count, so the header says how much is waiting without opening
  anything.
- **What you've asked for** draws those instructions above the ticket, with a `Withdraw` beside each.
  Above, because an instruction is the newer statement of the same goal and reading it after the body it
  amends is reading them in the wrong order; drawn at all, because a surface that writes free text to an
  agent and shows the operator nothing back is one they cannot correct. It is the page's one card that
  is absent when empty — the empty-state rule ("a surface that vanishes when quiet is
  indistinguishable from one that broke") is about surfaces answering a standing question, and "has
  anyone written on this goal" is answered by the header's control, which is always drawn.
- **Raise a bug** is gated on `config.canFileTickets` and opens the shared `RaiseBugModal`. It files
  into the tracker rather than writing a verdict about the item, and it leaves the goal's own verdict
  where it found it.
- **End the run** is keyed on the run **existing and not yet ended**, never on anything else the page
  is showing — the lesson `planId` and `retroRef` learned. It is how a retained run is ended, so it
  has to be reachable for exactly as long as the harness still holds one
  ([16](16-http-api.md#post-apiissuesnumberdismiss-run)).

### The bands

Each band embeds the **shared** component that owns its refusal rules — `EscalationCard` for a
question, a permission or a proposal, `HumanTaskActions` for a bench task or a close-out. The
goal-profile gate is the one band whose controls live in `NeedsBand` itself — its verdict is two
buttons on one write and there is no shared card underneath it — and it is drawn there rather than on
the goal page for the same reason the others are: the page and the rail's panel then hold one copy of
the write between them. Embedded, never redrawn: a second wiring is a second way to answer a proposal with free text on one surface only.
`buttonClass` is the one seam the console passes, so the shared buttons wear the console's face without
the console reaching into their class.

**A band whose source has left the snapshot draws nothing at all.** A header over an empty box would
claim something is waiting while offering no way to answer it.

### Validation on the goal

`ValidationSection` (`web/src/components/`) — how anyone checks the _goal_ was met, and what anybody
concluded from running each check. **The plan defines the checks; the goal manages them**, and those
are two jobs. The plan sheet writes them and amends them and still renders them
([the digest](#the-validation-digest)); running one is work against the _delivered_ goal, done days
after the plan was approved and usually by somebody with no reason to open it. A control reachable
only from inside the document that proposed it is a control nobody finds.

The card is **full width, above the two columns and above the plan**. Not in either stack: a check
draws its `do` and `expect` side by side and carries a row of five verbs, and both are cramped in a
column. Above the plan because that is the order the page already reads in — what is being asked of
you, then the work — and running a check is the one thing on the page that is _owed_. Only the needs
bands outrank it. **The card draws even when the goal has no checks**, the rule every card on this
page follows: a surface that vanishes when quiet is indistinguishable from one that broke, and
"nobody wrote a validation plan" is the reading most worth having.

The section is **embedded, never redrawn** — the bands' rule, for the bands' reason. It owns the five
verbs and their refusals, and the console passes `buttonClass="cn-btn"` so they wear the console's
face without the console reaching into their class.

The checks reach the page off the **goal ref**, by equality and not by `belongsToGoal`. A verdict is
keyed on the goal rather than the plan that proposed it ([20](20-validation.md)), so routing them
through `plan` would lose every check on a goal whose plan was abandoned — the case where an operator
most needs to know what was never run — and matching descendants would pull a part's ref in as though
it were one of the goal's. `test/goalPage.test.ts` pins both sides.

Each row draws its **letter** in the gutter where a part's sequence number sits: it is the same kind
of handle, and it is the one that stays put across an amendment. **A row is collapsed to its head** —
letter, title, state, and who is on it — because six checks at full height is most of a screen and
the card sits above the plan. Opening one reveals the `do` and `expect` side by side, the resources it
names with a present/missing fact resolved server-side, and the controls: Passed / Failed / Defer /
Waive, each opening a one-line note the server also requires, the hand-over, **Copy desktop prompt**,
and one way back to `unrun` from any settled state.

**Copy desktop prompt** is the odd one out and is the reason it exists: it writes nothing. A desktop
session is started from the operator's own Claude Code, not from here, so the button copies the line
that starts one — `/lubbdubb <issue>:<letter>` — and the cockpit's part in that run ends there.
Without it the third runner is the only one with no trace on the surface managing the other two.
→ [20](20-validation.md#starting-a-run-from-the-cockpit)

**Two things stay on a closed row.** The bands — an amendment, and a hand-back — because they are
what a reader must not be able to scroll past without seeing, and a collapsed row that hid them would
do exactly that. Folding away the steps costs a click; folding away "the check you already ran was
rewritten" costs the reading. And the **result note**, because it is the answer to the question the
row asks, and a state chip without the sentence behind it is the half nobody can act on.

**Every control writes an operator's reading and derives nothing** — there is no "mark all", and no
state is inferred from a merged part or a green build, which is the acceptance checklist's rule one
layer up. Checks an amendment withdrew are drawn folded, as the record of what the plan stopped
asking for: filtering them would leave a reader unable to tell a dropped check from one nobody wrote.

**One amber line at the top, not two.** What is not settled, what closing the goal will ask for, and
the amendment count with its letters, in one sentence — amber and not red, because it blocks nothing.
The plan sheet drew these as two stacked bands; on a card this size two warnings only invite a reader
to rank them. The amendments are counted there as well as banded per row because a plan of nine checks
with one rewritten is exactly where a per-row band gets scrolled past.

A check an amendment changed carries a **band** in that amber, above its body: what the amendment
said, and — when it reworded a check somebody had already run — that their reading was withdrawn,
with the previous wording folded behind _What it used to say_. The band clears when the operator
records a reading against the new wording and by nothing else: a dismiss button would clear it for
somebody who had merely seen it.

A check the fleet **handed back** draws a band of the same weight and the same amber, carrying the
agent's reason. Same weight because it is the same kind of news — nothing is going to happen to this
check unless a person does it — and the reason is quoted rather than summarised because it is usually
the one sentence saying what a person can do that an agent could not.
→ [20](20-validation.md#the-hand-over)

Three chips and two markers say **who**, and each is there because its absence would be read as
something else. **with the fleet** on a handed-over check, ahead of the planner's nomination about it
— one is what will happen, the other is an argument. **running at ‹label›** while a desktop session
holds the check, with the timestamp on the hover rather than the chip. Only a **live** claim gets
here — the snapshot projects every check through `withLiveClaim` — so this chip and the fleet list's
[keyboard entry](#the-keyboard-entry) appear and go together, and neither outlives what
`validate-check` reads. And beside a reading,
**recorded by an agent** or **recorded from a desktop session**. A reading a person took draws
nothing at all, because that is already what a validation checklist means — the markers are the
exceptions, which is exactly what a reader deciding how much a tick is worth needs.
→ [20](20-validation.md#the-desktop-channel)

### The plan

Four groups — **Merged**, **Now**, **Held**, **Not started** — folded by `PartGroup` off `status`
alone. Four rather than eight statuses because the page is read as a sequence, and `ready` versus
`pending` is a distinction the queue's own reason states better than a column heading can. `retired`
folds to no group at all.

**Retired parts are carried on `retiredParts` and drawn in a column beside the four**, struck through
and dashed. They are held off `parts` rather than made a fifth group because every count on the page and
the overview's segment track are reads of `parts`, and what a plan _proposed_ is not what the goal is
made of. Drawn all the same, because what an amendment dropped is half of what the plan's record is
for: a goal whose part list shrank between two readings would otherwise simply have lost rows, with
nothing saying so. The empty line says which case it is: no plan drawn at all, or a plan every part of
which was retired, with those parts below it.

A part's row names its pull request as a way there rather than as text (`PR #412`), the one ref a wave
carries; the goal it is under is the page it is already on.

**A held part quotes the reconciler's `blockedReason` verbatim.** It is the one status nothing else in
the world explains — a blocked part has no branch, no PR and no agent to read — so a paraphrase here
would be the only account there is, and wrong ([08](08-planning.md#the-ref-collision-guard)).

The overview's segment track is folded by `buildGoalTrack` off **the page's own groups**, not off
`status` a second time, so a row and the page it opens cannot disagree about whether a part is held or
merely not started.

### The pull requests and the tail

**Which pull requests are this goal's is three questions, not one** (`ownsPr` in `goalPage.ts`): a part
row naming the number, the branch convention (`issue/<n>`, and `issue/<n>/<slug>` for a part whose row
has not caught up), or `linkedPrNumber` for a PR the provider linked itself. The part rows alone are not
enough, and that was the bug: a goal delivered **whole** has no parts at all, so the card drew nothing
for exactly the goals that are finished. The branch shape is restated in the cockpit rather than
imported — it is a string shape rather than a verdict, and the wire boundary
([16](16-http-api.md#the-state-snapshot)) admits only `src/wire.ts` — and `test/goalPage.test.ts` pins
the pair, including the prefix trap (`issue/1` versus `issue/19`).

Open and closed are both drawn, closed dimmed with `merged` / `closed` on the chip. A merged PR leaves
the open list, and a goal whose work has landed would otherwise draw an empty card
([03](03-world-model.md)); the closed list is retention-windowed, so what it holds is what the harness
still remembers.

Whose court a PR is in is `attention.status`, and which check is red is `ciVerdict`; both are quoted,
never re-read. The chip prints the server's own word with `attention.reasons` in its title, and the
ladder is one dot per check the policy classified — failing, not-ours, muted — with **no check name
written anywhere in this repository**: every one comes off the verdict. Where the provider reported no
per-check detail at all the aggregate speaks under a generic name rather than drawing nothing, because
missing detail is not a clean bill of health.

`CourtChip` and `CiLadder` are exported from `GoalPage.tsx` and drawn by the overview's rack too — the
whole chip rather than the tone lookup alone, since two readings of one verdict side by side is how
the same PR comes to wear two tones, or two thresholds, nobody chose.

**The court chip carries how long a review has been waiting.** A PR carrying
`attention.reviewWaitingSince` reads `elsewhere · 3d`, with the instant it started waiting in the
title, from the first pulse it is observed waiting. There was a `reviewReminderMs` threshold under
this once, on the argument that an age on every open PR says nothing about any — which is a team's
problem. One person's queue is short enough to read, and a threshold only hid how long the short
queue had been sitting.

It is an age on a row you were already looking at, and **deliberately nothing more**. It raises no
"Needs you" row, files no human task, and does not move the PR into your court: on a team the reviewer
is somebody else, and a queue of other people's obligations is exactly what makes an inbox stop being
read. The threshold changes display and nothing else — the harness has no more idea than the operator
does how to make a colleague review faster. What decides the age is
[07](07-pull-requests.md#how-long-it-has-been-waiting-on-a-reviewer); the cockpit only draws it.

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
  The card also draws a **keyboard entry** per live desktop claim — see
  [the keyboard entry](#the-keyboard-entry).
  A row parked on a **usage limit** (`view.limitParked`, from the wire's `parkedOnLimit`) says
  _Out of account limit_ in place of its progress note — which on a parked row otherwise reads as
  though it still is — and carries a **Resume** control beside the name, not inside it, for the
  refs' reason. The control is drawn here as well as in the drawer and the rail because it is the
  answer to the question the row raises where the row is: an operator who can see the park and has to
  go looking for the way out of it is one who leaves the slot held.
  **The name is the row's control and the refs sit beside it** (`cn-refs`), the tickets row's shape and
  for its reason: a link inside a button is a second destination for one click. A row draws **two**
  refs where there are two — the origin it was dispatched at (`pr:412`, `issue:212:part:x`), and, when
  that origin is a pull request some ticket owns, the goal behind it, resolved through `goalOfPr`. The
  card used to name both in text and offer a way to neither, so the two questions a fleet row raises —
  what is it working on, and what is that — could only be answered somewhere else.
- **Goals in flight** — every goal whose `pickup.status` says the harness has it in hand now
  (`active` / `has_pr` / `planning` / `delivered`). Read off the dispatcher's own word rather than
  re-inferred from agents, plans and pull requests, which are three inputs the server has already
  folded into one. Each row is a way into that goal's page, carries its segment track, and takes a
  **court chip read off `needsYou`** — a goal is in your court exactly when the rail is holding an ask
  about it. Anything else would let a chip say "you" with nothing to answer.
- **Pull requests** — every open PR with its court chip, its CI ladder, and the watch/ignore toggle.
  An **ignored** PR stays in the list, with its health, and is drawn **spent** — the same dimming a
  closed PR and an ignored goal take, off `attention.status === 'ignored'` rather than a
  second reading of the labels. The chip alone left the one row nothing will happen on sitting at the
  same weight as the ones being worked, which is the whole thing the tag is meant to say.
  A PR is joined to its goal through **`goalOfPr`** — the server's own three-way match (a part's
  `prNumber`, the tracker's `linkedPrNumber`, the branch convention), read backwards — and the goal is
  drawn as a way onto its page. Through the parts alone it was drawn for almost no PR at all: a goal
  the funnel failed open on has no parts and its PR is on the flat `issue/<n>` branch. A PR no ticket owns
  resolves to nothing and draws nothing, which is honest about what is known. The toggle is **disabled rather than absent** with no ignore label configured: the gate
  being off is a fact about the deployment worth seeing, and a control that comes and goes with a
  config key reads as a bug in the page. The merged count is drawn only where the snapshot carries a
  closed list at all — absent means the retention window is off, which is not the claim "none merged".
- **Up next** — the last pulse's ranked queue, each row carrying `QueueItem.reason` verbatim. The
  reason is the whole point of the card, being the direct answer to "are we working on the right
  thing", so it wraps rather than being clipped and nothing here re-words it. A held item is toned off
  `status`, which is a fact the same sentence already states in words. The origin is drawn as a ref, so
  a goal-scoped one opens its page; the reason goes through `RefText`, so the `#341` inside the
  sentence links out. A row whose goal is marked a priority draws a `priority` chip off
  `QueueItem.expedited`: the flag is set on a goal and the row names an origin, so without it a
  flagged goal's parts sit at the top of the panel with nothing anywhere connecting the order to the
  click that caused it.
- **World signals** — `worldEvents` grouped by `(kind, ref)` with a count, ten rows. Three review
  comments on one pull request are one signal, not three unrelated rows. **The server's order (newest
  first) is kept**: re-sorting by count would move the row an operator is watching the moment it moves
  again. The row draws **the goal behind the signal** beside the sentence and never the pull request:
  the summary's own `#412` already links out, so repeating it would be one ref twice, and what a signal
  never offers is the way onto a goal's page.

### The keyboard entry

A validation check a desktop session is holding is **in flight**, and the Fleet card draws it beside
the dispatched agents — that card is where an operator looks to find out what is happening, and a
person at their own keyboard running a check is part of the answer. `buildViewModel` synthesises it
from the claim (`DeskRun`), which names its own goal; it never becomes an `Agent`. Nobody
dispatched it, so there is no task, no branch, no worktree, no transcript and no spend — a row in
`agents` would be a fiction, and one every counter of live agents would then have to be taught to
filter back out, including the next counter somebody adds.

**It takes no fleet slot.** `view.live` excludes it, so the cap readout and the header's `N out` are
untouched; the entry is stated beside that count as `· 1 at a keyboard` rather than added to it.

Four differences from an agent row are drawn rather than left to be inferred, because the check
cannot be killed, injected into or opened as a transcript: the row is a **`div`, not a button**, so it
offers no way in at all; its lamp is **hollow and violet**, where an agent's is filled and wears a
status tone; it carries **no cost column**, since a `$0.00` would read as "cheap" rather than "not
ours to count"; and its left edge is **dashed**, the same grammar as the lamp. A card wearing an
agent's affordances with none of them working is worse than one that never offered them. The hover
carries the two facts a glance cannot: that it takes no slot, and that it ends by itself — when the
reading lands, when the session closes, or when the claim ages out.

**The claim it draws is live by construction.** The snapshot maps every check through `withLiveClaim`
(`src/validation/desktop.ts`), so `claimedBy` on the wire is a claim `claimIsLive`
([20](20-validation.md#the-claim)) still holds — the same definition rule `validate-check` and the
desktop tools read. The entry therefore leaves the fleet list at the same instant the claim stops
blocking a dispatch, and the sheet's **running at ‹label›** chip appears and goes with it. Off
`claimedBy` alone, a claim whose session died would stand in the list forever while the rule had long
since stopped honouring it.

The demo backend holds its own clock and reports the claim two beats after load, so the ending — the
entry leaving with nobody having pressed anything — is visible in the Pages build.

## The work tab

The durable record: `WorkTreePanel`, the shared component, drawn as the third nav destination. It is
**the one surface that outlives the world snapshot** — every other panel draws the snapshot and so
forgets a pull request the moment it ages out of `closedPrWindowMs`, while this one still knows that
#40 merged and which issue it delivered.

It is a **tab rather than a strip below the console**, which is where it used to sit. A surface hung
under a full-height layout is reachable only by scrolling past everything else, so the record an
operator opens the cockpit to check read as an afterthought of the page — and the two views above it,
already tabbed, said plainly what shape the third should be.

Two things it keeps from that move. It is **fetched on open and never polled** — `/api/work` for the
roots, `/api/work/:ref` for a subtree — because `/api/state` comes round every couple of seconds and
the graph only ever grows; being a tab is what makes "on open" honest, since nothing fetches until the
operator goes there. And **unrecorded work** stays at its head: what the harness did that nothing in
the tracker accounts for, with `File a work item` and `Ignore` beside each row, since nobody outside
can ever mark done what nothing records. → [16](16-http-api.md#get-apiwork)

It is a **lens**: nothing here, and nothing in the dispatcher, decides anything from what it draws.

## The tickets tab

Every item the tracker's assignment filter has returned since the harness first swept — worked or
not, live or frozen — and, since the backlog was folded into it (#351), **the one surface triage
happens on**. Where the [work tab](#the-work-tab) is the record of what the harness _did_, this is
what it was **asked** to do, and what you are asking it to do next. It is drawn as a table because it
is read as one: the tracker id, the ticket, the readings, the cost and the date, each row taking the
list's tracks by subgrid so the columns line up however long one title runs.

**Why one surface and not two.** The backlog was open items grouped by watch bucket; this tab was the
same items plus the closed ones, filtered by the same bucket. Two surfaces that can be told different
things about one item is the drift `src/watchLabels.ts` exists to prevent, one level up — so the
backlog is deleted and every part of it is named a destination here rather than assumed to survive.

| The backlog had                                | It is now                                                  |
| ---------------------------------------------- | ---------------------------------------------------------- |
| four groups (watched/intake/unwatched/ignored) | the **Watch** filter's four values                         |
| intake pulled out of Watched                   | the **intake call-out** above the list                     |
| `Override → workable` on intake rows           | the same button, the same call, on the same rows           |
| features as headings, folds on `Place`         | `group=feature`, the same `collapsed` field                |
| the name opening the goal page                 | unchanged — `selectGoal`, refs beside it                   |
| 25 rows then "…and 31 more"                    | the keyset cursor and infinite scroll this tab already had |
| the nav's unwatched count                      | the same number on the Tickets button (`untriagedCount`)   |

`?tab=backlog` **resolves to this tab** rather than falling through to the overview, which is what an
unknown tab does: every bookmark and shared link to it would otherwise land somewhere else with
nothing saying so. One alias entry in `place.ts`; a stranded link is a bug report.

It is **fetched on open and per page rather than polled** (`/api/tickets`), for the work tab's reason:
the list is all-time and only grows, and `/api/state` comes round every couple of seconds.
→ [16](16-http-api.md#get-apitickets)

### The mirror is the list; the world is the overlay

Rows come from the **local mirror**, so the tab opens instantly and a provider that is briefly down is
the same picture as one that is up. Everything that is a _live reading_ — the pickup reasons, the
assay, the current labels — is read off the **state snapshot the cockpit already has**, and that split
is the whole of the design: those are the server's own sentences, and a second derivation of them here
would be a second opinion about a decision made elsewhere.

**Frozen is not deleted.** An item that has left the tracker's open set is marked `frozen` by the
sweep: it keeps every field it was last seen with and stops being enriched from the world. That is why
the head counts **live** and **kept** as two numbers — a work surface's population and the size of the
history under it are different facts, and one shown as the other would report a history that shrinks
every time something closes. → [14](14-persistence.md#the-ticket-mirror)

### Three axes, because they are three questions

**Watch is the harness's reading** — the `${labelPrefix}-watch` / `-ignore` pair, resolved through
`watchBucketOf` (`src/watchLabels.ts`), the same precedence the dispatcher's gate resolves through.
It is **three-valued**: an item nobody has opted in is `unwatched`, one tagged leave-alone is
`ignored`, and folding the two would report a triage nobody made.

**Tracking is what the harness is doing about it** — live or frozen. **State is the tracker's own
word**, and it is a _second tier_ rather than a value on the first: a provider with native states
closes an item several ways, and `Closed` and `Removed` are both frozen and are not the same fact.

The state list is **discovered from the mirror with counts, never hardcoded**. A fixed Azure ladder is
wrong on the first customised process template, and silently: the missing state's items simply stop
being reachable by any filter. Where the provider has no native states — GitHub, the fake — the tier
is **not drawn at all**, because a control offering states the tracker cannot produce is one that
always returns nothing. A `▲` marks the states `pickupStates` lets through, read from config rather
than inferred: _why is Ready worked and New not_ is the most-asked question about an Azure deployment,
answered where the states are.

Facets are counted over the **whole mirror**, not the filtered set. A facet counted after its own
filter shows `1` beside whichever value is selected and nothing beside the rest — a control that
erases its own alternatives the moment it is used.

The harness's own outcome for a goal — `delivered`, `fell short`, `concluded`, `abandoned` — rides on
the row as a chip and is deliberately **not a filter**: it answers a different question from any axis.
It is folded to one word on the server (`src/tickets/outcomes.ts`) from `resolveIssueConclusion` plus
the delivery and run rows, because a precedence rule re-implemented in a component is a second opinion
about it.

### The type is tinted by family, never by name

A row's work-item type is drawn as a chip tinted by **family** — bug, story, debt, container, task —
by `issueTypeTone` (`web/src/issueGroups.ts`), which the goal page's header chip reads too, so a Bug
is the same red on the row it was opened from.

The families are the stock vocabulary [`src/issueRelations.ts`](../../src/issueRelations.ts) states
its own defaults in, and **a type outside them draws untinted** rather than being sorted into the
nearest one. That fall-through is the invariant: the vocabulary belongs to the tracker, a process
template can name its types anything, and a colour that guessed would be a claim about an item's kind
made by the surface that is only supposed to be reporting it. It is a tone and never a verdict — the
container hue tracks the default names, not the operator's `issueContainerTypes`, so a customised
container name is uncoloured here while the dispatcher's gate still knows exactly what it is.

### Intake is pulled out, never greyed inside the list

An `unclear` assay is the one intake reading that **stops dispatch** ([06](06-issue-pickup.md)). Among
a page of rows it reads as a detail rather than as the thing holding all the work, so it is drawn as a
call-out **above** the list: what is held, the assayer's own sentence quoted whole, and
`Override → workable` beside it. A lamp marks the same rows in the table.

The sentence is quoted and never reworded — it is the only account of why the goal is held, so a
paraphrase would be the only account there is, and wrong. An **ignored** item is never intake,
whatever a stale verdict says: "leave this alone" is the operator's own instruction and outranks a
reading about a goal nobody is going to work.

Unlike the group it replaces, the call-out is **absent when nothing is held** rather than drawn empty.
A group that vanishes when quiet reads as one that broke; an exception nobody has is not a heading.

### Two controls, and no more

This tab used to state that nothing in it changed the world. That was true of a record and is false of
a work surface, and the sentence changed with the code rather than after it. What it says now is
narrower and holds: **the watch switch and the intake override, and nothing else.**

- Both write through calls that already existed — `POST /api/issues/:number/watch` and
  `setIssueAssay` — so the merged surface introduces no new way to change the world.
- The switch is **three-valued to display and two-valued to write**: `unwatched` is a state you can
  leave and never one you can select.
- **A container cascades, and the heading says so before the click** — `cascadeNote` states the
  number it will reach, because a click that writes eight tags must say eight. A container is still
  never dispatched at; the rows under it are the work.
- It is **inert on a frozen row** (nothing in the tracker left to tag), on a row the world no longer
  holds, and on a deployment with the gate off (`labelPrefix: ''`) — each with a title saying which.
  A button that writes nothing is worse than one that says why.

### Features are headings, not rows

Under `group=feature` — the default — rows are arranged under the feature they hang off by
`featureBlocks` (`web/src/issueGroups.ts`), and the heading carries the feature's own controls.
**A container is a heading and never a row**: nothing is ever dispatched at one, so listing it among
the items being triaged asks an operator to remember which is which on every read.

The arrangement reads the **mirror's own parent columns**, not the world's relations, and that is what
lets a frozen row keep its heading: its feature is the one it was last seen under, where a
world-shaped grouping would drop every closed item into one nameless pile. The three values of
`parent` stay apart all the way to the screen — a feature, a resolved `null` (an orphan, which gets a
heading saying so), and an **unresolved** absence, which draws flush with no heading at all. Filing
the third under "no feature" would accuse a GitHub issue of missing something its tracker never had.

`group=flat` draws one list with the feature as a **column** instead, which is also what a tracker
with no hierarchy gets. The column is absent under grouping rather than repeated: the heading already
says which feature a row is under, and a third copy is the noise that made the old flat world panel
unreadable.

**Every feature is open until the operator folds one.** The tab's job is to show what is waiting, and a
surface that hides it behind a click reports an empty board. A fold is `Place.collapsed`
(`?collapsed=3,12`) rather than a `useState`: stepping back into the tab has to restore the same folds,
and a shared link has to show what the sender was looking at. Collapsed rather than expanded is what is
carried, so the default is the empty list and a bare URL; the list is deduplicated and sorted, so one
set of folds has one spelling and cannot push a history entry that goes nowhere.

### "Why is nothing on this?"

A row that is watched and has no agent and no PR carries a marker that opens the dispatcher's own
account of what it would do next cycle — `isIssuePickupEligible`'s `reasons[]` and the funnel's route,
**quoted verbatim**. The lens derives nothing: a surface that reasoned about pickup would be a second
dispatcher, and the two would drift the first time a gate changed.

It **expands** rather than living only in a `title`, because a tooltip nobody can select text out of is
where a stack trace goes to die. A frozen row has no reasons at all — eligibility is a reading of the
live world.

### Ordering, and the two things the mirror does not know

The default ordering is the **tracker id descending**, which is arrival order: an id is
auto-incremental, so there is no date to parse and no timezone to get wrong. The others are **cost**
and **last change**, and all of them live on the **column headers alone** — two controls for one job is
two places to leave disagreeing, so the filter row carries the axes and a _loaded of total_ reading
instead. An infinite list with no total says nothing about whether a reader is near the end.

Neither the watch bucket nor the cost is a column on the mirror, and that is deliberate: the bucket is
a function of the operator's label prefix, and cost is `buildSpendGoals`' answer, which moves every
pulse. Either as a stored column would be a stale copy of a verdict that changes, drifting invisibly.
So the mirror hands back its rows and one pure function (`src/tickets/ticketList.ts`) does the
filtering, ordering and paging. A ticket the fleet never ran on draws an em dash rather than `$0.00` —
never worked and worked for free are different facts.

### The feature colour

Each feature draws in a hue from a **fixed twelve-slot ladder**, assigned least-used-first the first
time it is seen and then persisted (`feature_colors`, [14](14-persistence.md)). Persisted because the
whole value is that the same feature is the same colour tomorrow; a _ladder_ rather than a random hue
per feature because a random one has two failure modes nothing catches — one that disappears against
the panel, and two features that land close enough to read as one. Past twelve the ladder repeats,
which is honest: a legend with forty colours is not a legend anyone reads.

The wire carries the **slot, not a colour**: the palette belongs to the stylesheet, and a hex on the
wire is one no theme could reach. The number and the name ride on every chip and heading too, so the
column works for a colour-blind reader and in a screenshot pasted into a ticket. The legend doubles as
the feature filter and is a `Place` field.

### The floor, and the foot of the list

The list is scrolled rather than paged, forty rows at a time, observed by an `IntersectionObserver`
rooted on `.cn-sit` — the element that actually scrolls, since against the viewport it would never
intersect and the list would simply stop. The cursor is a **keyset** rather than an offset, so a sweep
landing mid-scroll cannot make a row appear twice or not at all.

The **foot is a real state, not an absence**: a list that just stops reads as one that failed to load.
Reaching it names the floor — _"start of history — 14 Jul 2026, a month before the first scan"_ —
because the floor is a cap and this codebase ships no silent ones. While the first sweep is still
filling, the foot says so, since an empty list mid-backfill and an empty tracker are the same picture
and different facts. → [14](14-persistence.md#the-ticket-mirror)

### What it is still not

No un-dismiss, no re-open, no verdict toggle. The two controls above are the whole of what this
surface writes, and everything else on a row is a reading. The scroll offset is deliberately **not** on
`Place` either, unlike every filter: a URL that restored an offset into a list that has since grown
lands somewhere else entirely, so Back returns to the filter and the list re-reads its first page.

## The top bar and the panels

The strip carries the ident, the nav, the pulse, the fleet cap, and nine readings: **Spend**, **Yield**,
**Output**, **Findings**, **Lessons**, **Faults**, **Launch**, **Build** and **Settings**. Each is one subject stated once, in
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
draw. The **ask** panel rides in that same value as `{ ask: <row id> }` rather than beside it, for that
reason exactly: a second field would let an ask and the fault log both be in front, which is the state
the type exists to rule out. A `Panel` has **three ways out** — the backdrop, the button and Escape —
because a thing that covers the console must not have exactly one exit; `test/console.test.ts` pins
them.

### The Build gauge

The one reading on this bar that is about the process rather than the work: where the harness's own
build stands against its upstream ([21](21-self-update.md)). It follows the mute rule above rather
than being an exception to it — `current`, muted, in a fixed place, is the state it is in almost all
of the time, and that is the point. A notification that appears only when there is news is one an
operator has to notice; a gauge in a fixed spot is one they can glance at.

It goes amber only at `behind` and `ready`, the two states where something is waiting on a decision.
It is deliberately **not** drawn as the crash-recovery banner. That treatment is a stop sign, and it
is loud because the harness is running no cycles at all while it is up; an available update stops
nothing, so borrowing it would say something untrue — and after the second time, be scrolled past.

Six panels open from the bar, the ask panel opens from a queue row ([the rail](#the-queue-rail--needs-you)), and Settings, Spend and Yield are shell-owned modals beside them:

- **Findings** — the shared `FindingsPanel`, with promote / file / dismiss. The count is findings at
  `open` and nothing else: promoted, filed and dismissed are done, and `filing` is decided. Nothing in
  the dispatcher reads `findings`, so those three buttons are the only way one becomes anything.
- **Lessons** — the shared `LessonsPanel`: what working a goal taught about working this repository,
  the composer that writes one down, and the promote / retire buttons that are the only way one moves
  (#355). Three sections, because the three statuses are three different questions — _what wants a
  decision_, _what is vouched for_, _what did we stop believing_. The count is lessons at `proposed`
  and nothing else, for the Findings count's reason: a count of what is already promoted would tick
  up on the operator's own click and never come down.

  Two things about this panel are load-bearing rather than presentational. **Retired lessons are
  drawn**, muted, rather than dropped: this is the surface one prunes from, and a row that vanished
  on being pruned would leave no way to tell a list you have finished with from one that lost rows.
  And **the panel says out loud that nothing here reaches an agent** — promotion records the
  operator's judgement and changes no launch argument — because a control that looks like it changes
  what agents see and does not is worse than no control. Every card carries its provenance, the goal
  it was learned on drawn as a `<Ref>` and the date beside it, since those are exactly the two things
  a rendered block of assertions strips. Retire is a `ConfirmButton`: it is the one irreversible act
  on the surface.

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

- **Build** — what is waiting for the running build and how to take it, `BuildPanel`. It puts the two
  facts that decide which control to press next to each other: what changed upstream, and what the
  fleet is doing right now. **Draining is drawn first** and interrupting second — applying with agents
  live is not lossy, since they are restored on the way back up, but it is still a thing done to work
  in flight, so it sits behind the recommended path and says what it will do. A deployment started
  without a supervisor gets the commands instead of the buttons, and a line saying what to run to get
  the button; the commit list says when it has been capped, since a truncated history with no note
  reads as the whole of it.

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

### Notifications

The one **writable** thing on the settings tab, which is not the inconsistency it looks like: the
running config is read-only because its honest answer to "when does this take effect" is "at the next
restart", and this answers "now". It is a preference of the _browser_, not of the harness.

Everything the harness asks of a person lands in the queue rail, and the queue rail is only visible in
an open tab, on loopback, on the machine the harness runs on. Nothing carried it further — so a parked
agent held its slot and its worktree for as long as it took somebody to happen to look, and the
recovery queue holds _every_ pulse while it is up ([10](10-agent-runtimes.md#crash-recovery)), which
makes an unnoticed restart a stopped fleet.

**The Notification API, not Web Push.** Web Push survives a closed tab and costs a service worker,
VAPID keys, a persisted subscription and an outbound HTTPS connection from the harness to Google's or
Mozilla's push service. That last is the objection: this deployment binds loopback, keeps its token in
a 0600 file and sends nothing off the box, and a notification channel is a poor thing to make the
first exception. The cost is stated rather than hidden — **the tab must still be open**. Backgrounded,
buried behind another window, on another desktop all still notify; closed does not.

Two of those three take **`hasFocus()`, not visibility**, and the first cut of this got it wrong.
`document.visibilityState` is `hidden` only when the tab is not the selected one in its window or that
window is minimized — a window merely _behind_ another, or on another virtual desktop, reads `visible`
in every engine. Gating on visibility alone therefore suppressed the case the feature exists for, and
suppressed it silently: a notification that never fires is indistinguishable from a fleet with nothing
to say. Both halves are asserted in `test/notify.test.ts` against a stubbed engine.

|            |                                                                                                                                                                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stored     | `localStorage` under `lubbdubb.notify`, beside the token — a property of this browser, so two people on one deployment can want different things. Not `Place`: the address bar holds where you are, and this is not somewhere you can be. |
| Categories | `needsYou`, `errors`, `agents`, each independently switchable. `agents` is described in the panel as frequent rather than quietly defaulted off — switchable is the answer to noise, not a default nobody finds.                          |
| Permission | Requested only from the button, never a mount effect: every engine requires a user gesture and some refuse silently. `enabled` is written only once the browser has actually granted, so a switch can never read on and do nothing.       |
| Suppressed | Only while the cockpit is **both** `document.visibilityState === 'visible'` **and** `document.hasFocus()`. A notification for a row you are looking at is noise, and the point is to reach you when you are elsewhere.                    |

#### Proving it works

**The feature is otherwise unfalsifiable, which is the one thing about it an operator reliably hits.**
Every quiet link in the chain presents identically: a grant that was never given, a browser with no
`Notification` constructor, a desktop dropping what the browser accepted, and a fleet with simply
nothing to say all look like _no notification_. Neither of the two gates above helps — they are also
silent, and a correct suppression is indistinguishable from a broken one. So there is a button.

`sendTestNotification` (`web/src/cockpit/notify.ts`) raises one on demand and reports how far it got:
`sent`, `undelivered`, `blocked`, `unsupported` or `failed`. It skips **both** gates
`fireNotifications` applies, each for its own reason. The focus gate cannot survive a button — a press
means the window is focused by definition, so keeping it would make the test unpassable. And
`enabled` is skipped because the switch is what the operator is deciding whether to trust; a
diagnostic that answers only after you have committed to the thing diagnoses nothing.

`sent` is deliberately the weaker claim. The constructor returning is the browser _accepting_ the
notification and nothing further; whether a banner is drawn belongs to the desktop, and Do Not Disturb,
a focus mode and a per-application mute all drop it past the point the page can see. The wording says
so rather than declaring success and sending an operator to look for a cockpit bug that is not there.
`undelivered` is the engine's own `error` event arriving late to say the desktop refused it — the one
signal that separates that case from "it worked and you were not looking", and best-effort, since an
engine that drops one silently reports nothing.

**A request the browser never answers has its own wording.** `requestPermission` resolving `default`
leaves `Notification.permission` on the value it already held, so without the `asked` flag the button
is indistinguishable from one that did nothing — press, no prompt, no change, no message. Firefox is
where this bites: _Block new requests asking to allow notifications_ (Settings → Privacy & Security →
Permissions → Notifications) answers `default` with no prompt at all, permanently, and the panel now
names that setting instead of leaving a dead button.

**The demo cannot demonstrate this, and that is not a bug in the demo.** Nothing on the demo's
heartbeat produces a notifiable change — the beat moves `worldObservedAt` and settles the desktop
claim two beats after load, and neither is a needs-you row, an error or an agent ending.
Every change that _would_ notify is driven by a click, and a click means the window is focused, which
is the suppression. So on the Pages build the automatic path is unreachable by construction, in every
browser, and the button is the whole of what the demo has to show. Anyone concluding "notifications
are broken" from the demo has learned nothing about their browser.

**Decided from state, not from websocket frames.** `notifiableChanges` (`web/src/cockpit/notify.ts`)
is a pure diff of two reduced snapshots, and the needs-you half diffs the **rendered** queue —
`buildNeedsYou`'s own output. Watching frames instead would have covered escalations and missed human
tasks, plan approvals and recovery, the three that arrive as one coarse `dirty` and never announce
themselves; diffing the queue covers every kind by construction and stays true when a ninth is
added. Agents notify on the **transition** into a terminal status rather than on appearing, since an
agent is in the list from the moment it spawns and a dead one stays there.

**A null previous snapshot yields nothing.** The first state after a load, a reconnect or a token
entry seeds the comparison. Without it every row already waiting announces itself at once — a storm on
exactly the deployments with the most waiting.

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
folded into input ([18](18-observability.md#dollars-are-net-of-cache-tokens-are-gross)) — which is why
the tokens tile's second line is **the cached share of the input** and not a dollars-per-million rate.
The rate was only ever a proxy for that share, and one a reader had to be told how to interpret; the
share says it outright, and it is the one token figure a deployment can act on, since cost arrives with
the discount already in it. Its denominator is the input of the runs that _reported_ a split, so the
note names the shortfall whenever some run did not — a run from before the split was recorded is left
out of the fraction rather than drawn as a cache miss
([18](18-observability.md#the-cached-share-is-stored-not-inferred)). It also names the unmeasured runs,
which appear in no figure above it.

**It [exports](#exporting-a-reading)**, seven sections in the order the panel draws them — totals,
phases, days, task types, failing checks, goals, runs — with the phase split riding inside each goal
row as it rides inside that goal's bar, and each of the three remainders (reached no goal, named no
check, attributed to a check) carried as its own row. Three more sections follow **once the Trend tab
has been opened**; when it has not, the export says so in a row rather than omitting them silently,
because a file read six months from now has no panel beside it to explain a gap.

### The Trend tab

`web/src/components/SpendTrendTab.tsx`, drawing `GET /api/spend/trend`
([18](18-observability.md#the-spend-trend)). A tab rather than a second panel because the breakdown
and the trend are one subject read two ways, and the bar's rule is that a subject is stated once —
the same argument that put the breakdown behind the Power reading rather than beside it.

**It fetches on its first visit and both tabs stay mounted after**, which is the settings modal's
stance ([Settings](#settings)): a tab an operator never opens costs nothing, and switching back costs
nothing twice. Tab state is a `useState` and not a [`Place`](#the-address-bar) field, for the same
reason the settings modal's is — it is a position inside a surface the address bar already carries,
not a surface of its own.

Three sections, each headed by the question it answers, and **the shared week axis is the design**:
every chart is the same eight weeks at the same x, so a change that shows up in one is read against
the other two without a click.

- **Are goals getting cheaper?** — median cost per closed goal as bars, with every goal in the cohort
  drawn as a point beside it. The spread is drawn rather than summarised because goals differ in
  size; the points are placed by index rather than jittered, since a random offset would reshuffle on
  every render. The current week is **outlined rather than filled** — it is an under-count by
  construction, and a hollow bar is the only honest way to draw a figure that is going to grow.
- **Which stages cost more, and which less?** — the cohort's phase split as a share band, and the
  same shift as **dollars** in the table beneath it. The table is not optional: a stage whose share
  rose while its dollars fell is a fleet doing everything else more cheaply, and the band alone draws
  that as a regression. This is the reading the tab exists for.
- **Has the success rate changed?** — completion rate and red checks per goal on two axes, plus four
  tiles including **reopened after close**. That last one is the honesty check: a fleet that got
  cheaper by closing goals it had not finished looks like progress on every other chart here.

**Colour is the direction the reading moves in, not the sign of the number.** `.sp-delta` takes a
tone from the call site — falling money is `good`, falling completion is `bad` — because deciding by
sign in the stylesheet would paint a halved completion rate green.

**The panel draws figures and never derives them.** Medians, the two halves and the phase shift are
all `buildSpendTrend`'s, for the reason the breakdown ships its splits: a second implementation of
"the median goal" a tab away from the first is free to disagree with it, silently. When the server
withholds the comparison — fewer than two complete weeks a side — the tab says so rather than drawing
a percentage off one week of goals.

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

Under the origin block, the drawer shows **why this run was dispatched** and, when the operator
configured a model policy, **what it was launched on** — the `agentModels` profile the run's rule
resolved to at dispatch, read off `task.model` rather than re-derived from config, so what is shown is
what argv actually carried (issue #321). Drawn quieter than the dispatch reason, because it is context
rather than the thing the drawer was opened to read, and absent entirely on a deployment that assigns
no models. The policy itself is visible in the running-config panel, under **Agents** —
[02](02-configuration.md#model-assignment-by-rule).

The drawer also shows the artifact chips, the **files changed** list from `files`, and offers respond,
interrupt and kill.

**A usage-limit park replaces the reply box rather than sitting behind it.** An agent in
`parkedOnLimit` draws an amber notice above the transcript — the row's own reason, naming the window
and its reset — with **Resume** in it, and the reply box is gone for as long as the park is: the
process usually went with the limit, so typing there would reach nothing, and there is no question at
the other end of it to answer. Amber rather than red, because nothing failed. Kill stays where it is:
resume must not be the only thing an operator can ever say to a park.

## The plan sheet

`PlanModal` (`web/src/components/`) is the whole decomposition, on demand — the record of what was
agreed, not just the question that was asked. Before it, a plan was legible only while it was a pending
proposal: the approval card rendered a template string and vanished on the click. There was no way to
say "show me the plan for #231" at any time, once or after it was answered.

**It is shell-owned**, opened through `viewPlan(planId: string | null)` on `CockpitActions` — the same
seam `select(agentId)` uses, and for the same reason: one implementation, reachable from whichever
surface mentions the plan.

**One scroll with an anchor rail**, not tabs. It was two tabs, and a tab is a thing a reader has to
know to click: the write-up sat behind one, so the most considered thing a planner wrote was the part
least likely to be read. The rail jumps to Verdict / The shape / Parts / Validation / Caveats / Write-up, and
scrolling reaches all of them anyway. The head, the rail and the decision bar are fixed and the middle
scrolls between them, because a plan is read _while_ deciding and the verdict buttons must not scroll
away from the part being read.

### The verdict band

`diagnosis` and `approach` **side by side**, not stacked: a long "what's wrong" used to push "what
we'll do" off the first screen, and the two answer different questions. `verification` sits under the
approach, since "how we'll know it worked" is part of what is being agreed to. `evidence` renders
under the diagnosis as plain monospace citations — **not links**, because the cockpit has no source
browser and `refUrls` answers only for tracker items, so a link there would go nowhere.

**`reason` is a caption, not a heading.** Once `approach` carries the summary, the split justification
renders as one muted line above the map — _"Split this way because: …"_ — because that is the size of
the question it answers. On a plan stored **before** `diagnosis` and `approach` existed both are null
and `reason` falls back to the headline under the label it always had ("Why the planner split it", or
"The approach" on a one-part plan). The fallback is why the fields are separate rather than `reason`
being retargeted: a stored plan keeps meaning what it meant when it was written.

### The map

`PlanMap` draws the decomposition as a graph — the one thing about a plan only a picture can carry,
and the one that is expensive to get wrong, since the stack edge decides which branch each part is cut
from. It is the cockpit's only drawing.

- **Waves left to right, one column per `depth`.** The depth is the server's own (`partDepth`, shipped
  on `PlanPartView`) rather than one computed in the browser: a second implementation could draw a
  rejoin in a wave before the thing it waits for, be internally consistent, and disagree with what
  actually runs.
- **Two edge kinds, drawn differently because they mean different things.** One dependency is a
  **stack** — solid, work flowing along it, the part starting as soon as that sibling pushes. Several
  is a **rejoin** — dashed, because nothing flows down any single one of them and the part waits for
  every one to _merge_. An operator who reads a rejoin as a stack expects work to start far earlier
  than it will.
- **An edge that skips a wave is routed along a bus below the diagram.** Drawn directly it would pass
  through whatever sits between its ends, and a line crossing a node reads as an edge _to_ that node —
  exactly the wrong reading on the rejoin that needs it.
- A **human step** has a dashed amber border and no status stripe. Status is a 3px stripe rather than a
  fill: a fill dark enough to read on is a fill too dark to tell apart.
- Clicking a node scrolls to that part's card and marks it, which is what makes the map a way _in_
  rather than a second place the same facts are stated.

### The parts

Each part carries its `touches` as path chips, its prose `scope` below them (suppressed when the
planner answered both with the same thing), `size`, `rationale` (why its own PR), its `acceptance` as a
**checklist**, its status, its PR, its "Up next" queue state (`unapproved` / `capped` / `▶ now`), and
the stack edge spelled out as a sentence — a rejoin says _both_ out loud, which the old
`dependsOn[0]` rendering structurally could not.

**Acceptance is ticked by the reviewer**, through `POST /api/plans/:id/acceptance`; nothing derives it
([08](08-planning.md#acceptance-ticked)). **Scope drift** draws under a part in red when its agents
wrote outside what it declared — the plan disagreeing with reality, which is the thing the surface
exists to surface.

### The validation digest

`ValidationDigest` (`web/src/components/ValidationSection.tsx`) — the checks this plan proposes,
**read-only**, between the parts and the caveats, because the reading order is answer, then work, then
how anyone knows it worked.

A plan under review has to show what it intends to check; that is part of judging it. But a reading is
recorded against the _goal_, on [its own card](#validation-on-the-goal), so the sheet offers no verb
at all — no note field, no hand-over, no way back to `unrun`. Offering the verbs in two places is two
wirings of one set of refusals, and the surface that ends up wrong is the one nobody is looking at.
What the sheet draws instead is the way to the place that does: **Open the goal**, absent on a plan
that hangs off no goal ref, because then there is nowhere to send anyone.

Each row is the letter, the title, the state, the parts it `covers`, and the `do`/`expect` wording. A
plan with no checks says so rather than drawing nothing, the write-up section's rule.

**Checks an amendment withdrew stay here** rather than moving with the controls. What a plan dropped
is a fact about _this plan_; the goal's card lists what is still to be checked. They are drawn folded,
for the reason they always were: filtering them would leave a reader unable to tell a dropped check
from one nobody wrote.

The digest shares a file with `ValidationSection` rather than sitting beside it, because the two say
the same things about a check — its letter, its state, its wording, what an amendment withdrew — and
the failure worth designing against is the two drifting into describing one check differently on two
surfaces.

### The caveats

Four, folded shut behind their opening words, ordered by how much they bear on the decision:
**Considered and rejected**, **Least sure about**, **Risks**, **Deliberately out of scope**. Each
arrives at whatever length a planner writes it, and four open above the Approve button is four walls
where the answer to "what are we doing" is none of them. Folded is not hidden — the summary carries
the first ~110 characters flattened to plain text. **Least sure about opens by default while a verdict
is pending**: it is the field written for exactly that moment, and folded it is one more thing to click
before it can change a mind.

Every prose field renders as markdown through the same `renderMarkdown` the write-up uses — a planner
writes them with `**bold**` lead-ins, backticked identifiers and bullets, and printed raw those markers
are most of what a long one looks like.

### The decision bar

**The buttons say what they do.** Approve reads _"Approve — start N agents now"_; Reject names its own
arm, which differs between them (a refused decomposition falls back to one pull request, a refused
a refused plan goes back to the planner). Above them, what is being authorised in numbers: pull
requests, agents over time, `maxConcurrentPartsPerIssue`, how many start immediately, steps for a
person, parts that are large to review, and what the goal has cost so far.

**Nothing there is a forecast.** Every figure is read off state that already exists; the harness cannot
estimate what work will cost, and a made-up number on the button that authorises spending is worse than
no number. The spend shown is spend already made.

**Objection pins compose the note.** A part can be pinned _question_ or _drop_ while reading, and the
pins are joined into the free-text note the accept and reject verdicts already carry — no new verdict,
no new route, nothing the server has to learn. Reading a five-part plan and disagreeing with one of
them is the ordinary case, and the only way to say so used to be to remember the slug and type it into
a box at the bottom.

Approve / Reject appear only while the plan is `awaiting_approval`, and route through the same
`decideProposal` the escalation card uses — one verdict, one implementation, so the rail's row clears
whichever surface you decided from. Replan sits apart, because it settles nothing about the proposal in
front of you. **Abandon** sat beside it and is gone: it retired the unstarted parts and worked the goal
as one pull request, which was a distinct act only while a plan with no parts was a different kind of
plan ([08](08-planning.md#a-plan-is-a-list-of-parts)). Replan is the way out now. While a plan is being discussed the sheet shows the conversation instead —
the agent's status and last note, and a reply box posting through `POST /api/agents/:id/respond` — and
offers **End discussion** instead of a verdict.

### What changed

A replan and a discussion both rewrite the plan row, so ten minutes of conversation came back as the
whole decomposition again with nothing saying which two parts moved. The rail's right-hand control
opens the **diff** — the server's own (`GET /api/plans/:id/history`), never re-derived here — with the
revision list above it: parts added, dropped, changed (field by field) or unchanged, and which prose
fields the amendment rewrote. Prose is **named rather than diffed word by word**, because a planner
rewrites a paragraph wholesale and a word-level diff of one is two paragraphs marked entirely changed.

The control is absent until there is a second revision, and a fetch that fails leaves it absent rather
than drawing an error for a view nobody has asked for.

**Every entry point is keyed on the plan existing, and none on what it is doing.** That is a
correction, not a restatement: entry points keyed on a transient condition left the sheet reachable
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

A surface that _names_ another thing and gives no way there is the cockpit's most repeated bug. It kept
coming back because linking was something each site had to remember to do rather than the only way to
draw a ref at all — so there is one component and one vocabulary, in
**`web/src/components/refs.tsx`**.

**The vocabulary is the harness's own colon-form ref** — `issue:212`, `issue:212:part:writes`, `pr:412`
— which is what tasks, queue items, findings, world events and plan parts already carry. Most call
sites pass a value they are already holding rather than re-deriving a number.

**The destination is the ref's own business, not the call site's.** `<Ref to={ref} />` decides:

- A **goal opens its page in the cockpit**. That is the richer of the two destinations — the plan, the
  asks, the pull requests and the ticket's own `Open ticket ↗` are all on it — and it is the one no
  other route from a row that merely mentions the goal can reach. A part ref resolves to its goal; the
  part has no page of its own.
- A **goal the world does not carry links to the tracker instead**. Whether a ref has a page is
  `goalIssue`'s answer, handed to the provider as `hasGoal`, for the reason the queue rail asks it
  rather than guessing: `buildGoalPage` returns null for a ref the snapshot dropped, the console draws
  the tab behind it, and a link onto one is a click that appears to do nothing.
- A **pull request links out**. There is no PR page in the cockpit. `#412` and `pr:412` are both tried
  against `refUrls` — which of the two the snapshot happens to carry is not a row's business.
- **Anything the provider could not resolve renders as plain text.** A ref the provider could not
  resolve is absent from the map, which is what the `fake` provider produces, and a link that goes
  nowhere asserts more than a bare number does.

`<RefText text={…} />` is the second of them, for prose that mentions refs — a queue reason, a world
signal, an agent's note. Deliberately **not** routed through `<Ref>`: a bare `#412` in a sentence does
not say whether it is a goal or a pull request, and guessing would link onto whichever of the two
shares the number. The tracker's page answers either.

`refLabel(ref)` is the third, and **the only place a ref becomes text** (`#212` from any of its forms).
It was written three times over, and the fourth surface that wrote it printed the label with no link on
it — which is the bug exactly: shortening a ref by hand is how a surface ends up naming a thing instead
of pointing at it. `test/refLinks.test.ts` pins that nothing else strips a ref down to a number.

### How a reference is drawn

**One vocabulary of three marks**, in `web/src/styles.css`:

- a **box** means this is a thing you can go to, not a number in a sentence;
- a **fill** inside the box means the destination is here, in the cockpit (`.ref-goal`, the only filled
  form, because a goal's page is the only cockpit destination a reference has);
- an **arrow** means it leaves for the provider (`.ext-ref`, and `.ref-out` where that leaves from a
  standalone token).

**Where a reference stands decides which of them it wears.** A reference standing on its own — a row's
`cn-refs` group, a rack entry, a chip — is boxed; a reference _inside prose_ takes the arrow alone,
because a boxed token per mention turns a sentence lumpy and prose refs all leave anyway, so the arrow
is the whole distinction there. `<Ref>` always stands alone and so always boxes, through `ExtLink`'s
`boxed`; `<RefText>`, `linkify` and `refLink` do not pass it. The one exception is a **branch name**,
which `<Ref>` draws through `refLink` unboxed: `feature/context-budget` is already long, and a box round
it is a shape rather than a signal.

What this replaced was a 1px underline, dotted for out and solid for in. On a row that already carries
lamps, chips and hairline rules that line read as _ruling_ rather than as a way somewhere — the same
complaint the module exists for, one level down — and the dotted/solid pair drew a distinction nobody
was given a legend for. **Shape carries it now, not hue or a line weight**, so the distinction survives
the print sheet and an operator who cannot separate the colours. Hover keeps its meaning by
strengthening: the edge goes to full `--blue`, and a dashed one goes solid.

The three values are tokens of their own — `--link-line`, `--link-fill`, `--link-ink` — each restated
once under `#print-sheet`, since a dark-theme token on white loses its edge, muddies its fill and drops
its lettering under AA. They are separate from `--blue-line-2` / `--blue-fill`, which mean "border and
ground of a blue-filled surface" and are set against `--panel`; a reference has to hold at 12px on four
different grounds. Both classes take a `:focus-visible` ring shaped like `.pm-jump`'s, since `.ref-goal`
is a `<button>` reset to look like a token and has no ring of its own. The treatment lives entirely in
the shared classes, so every `<Ref>`, `ExtLink`, `refLink` and `linkify` site has it without knowing.
Controls that already read as controls — `.esc-open`, `.pm-jump`, `.cn-tgl`, the chip anchors — are
deliberately untouched: the failure this fixes is text that looks like text.

**`cn-refs` is the other half, and the half no token style can do**: a ruled slot at the right of a work
row, so a reference is findable by _position_ and not only by looking like one. The rule separates what
a row **is** from what it **names**. It is drawn on every row of a list, **empty where the row names
nothing** — a fleet row with no origin renders the group and puts nothing in it — because a rule that
comes and goes reads as ragged rather than as a column; `:empty` takes the line back off so an empty
slot is space rather than a tick. Row anatomies differ after that slot (the rack carries a CI ladder and
two buttons, a signal carries its count), so this is a slot rather than a table column, and there is no
header over it.

**Every selector in that block doubles its class** — `.ref-goal.ref-goal`, not `.ref-goal` — and it has
to. `console.css` resets its own markup with `.cn button` and `.cn a`, which counts as (0,1,1) and so
outranks a single class, and the console is where most references are drawn. Under one class the reset
won: `border: 0` took the box off a goal token and `color: inherit` took the colour off every reference
in the console, which is how a treatment can be right in the stylesheet, green in its test, and on
screen nowhere an operator looks. The reset is not the thing to fix — the rest of `console.css` is
written against it, and lowering it with `:where(.cn)` restyles 66 of the 70 controls on the overview —
so the token layer carries the weight to clear it, and `console.css` still names no shared class.

`test/refLinks.test.ts` pins the box, the fill, the arrow, the token count, the focus rule, the doubled
selectors and the slot's presence on every fleet row, because nothing in a render test can see a
stylesheet.

**One rule a call site still has to keep: a reference never goes inside a button.** A link nested in a
control is a second destination for one click, so a row that carries both draws its name as the control
and the refs beside it, in a `cn-refs` group — the fleet card, the rack and the tickets row all take
that shape. It is pinned structurally, because nesting one reads fine and renders fine.

**The provider is `RefLinks`, mounted at the shell** (`App.tsx`), carrying `refUrls`, the way onto a
goal's page (`selectGoal`) and `hasGoal`. At the shell rather than in the console because the drawer and
the modals draw refs too and none of them is inside `ConsoleRoot`. A `<Ref>` rendered outside it
**throws** rather than falling back to plain text: a silent fallback is the failure the module exists to
stop, and nothing would catch it.

`linkify` / `refLink` (`web/src/components/util.tsx`) are the primitives underneath, and remain in use
where a component is already handed `refUrls` — the markdown renderers, a branch name, a comment ref.
Nothing new reaches for them; new code draws a reference with `<Ref>`.

**Every reference the UI shows is routed through one of these (#199), with no exceptions.** So the goal
page's pull requests and its plan waves, the overview's fleet, rack, up-next and world-signal rows, the
tickets rows, the findings panel, escalations, the plan sheet, the recovery cards, the agent drawer,
the spend and reliability tables and the work-tree panel all draw links wherever there is somewhere to
go.

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
  injection surface to reason about at all. Used by the goal page's bench detail, the plan and retro
  modals, a finding's `detail`, and an escalation's `detail` — everything on the page an agent wrote.
  The ticket body is the exception, and the section below says why.
- **Captured output stays `<pre>`.** An escalation's `recentOutput` and a draft reply are what the
  process emitted, and preformatted is what they _are_. Markdown-rendering them would reflow columns
  that mean something.
- **A field the operator scans is drawn as one line.** A finding's `summary` is validated to be one
  ([13](13-jobs-and-findings.md#the-three-text-fields)) and clamped to two in CSS regardless, because
  rows filed before that validation existed hold an entire report in it.

### Tracker-authored prose

The **ticket body is not agent-authored**, and it is the one field on the page that isn't. Azure DevOps
stores `System.Description` as HTML — `<div>`, `<p>`, `<br>`, `<li>` — and GitHub stores markdown, and
the wire carries one `body` that never says which. Markdown-rendering an Azure body printed the tags as
text, which is what `renderRichText` (`web/src/components/richText.ts`) exists for: it sniffs for a
**structural** tag and hands the source to the renderer that understands it, so prose merely _mentioning_
`<script>` or `<T>` still goes to `renderMarkdown` unchanged.

`renderMarkdown` stays exactly as it is — its no-HTML rule is the whole safety argument for text an
agent wrote — and the HTML path earns the same guarantee by construction rather than by sanitising:
React elements only, an allow-list of tags (an unknown one unwraps to its children, so it costs a
wrapper and never the text), `<script>` and `<style>` dropped with their contents, **no attribute
carried over** but a scheme-checked `href`, and no `dangerouslySetInnerHTML` anywhere in the path. An
unclosed tag closes at the end rather than swallowing the rest of the ticket, and an inline `<img>`
becomes a link — a tracker attachment needs credentials the cockpit does not have, so it would draw as a
broken frame. `test/richText.test.ts` pins all of it.

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
- **A plan approval reads as _what the plan does_, plus a way into the plan.** The quoted block is the
  planner's diagnosis and approach ([08](08-planning.md#requiring-approval)) — not the decomposition,
  which is a diagram in the plan panel and a poor flat list here. Below it, `Read the full plan` is
  drawn full-width and toned like the accept button rather than as one more ghost link beside
  `Open agent transcript`: it is the click the card is asking for, ahead of the two that settle it, and
  everything an approver would want that will not fit on a card — the split, the evidence, the risks,
  what it ruled out — is behind it. One control on the card, not two: it was rendered in both arms of
  the agent-actions row before, which is how it ended up looking like an afterthought in each.

A **shortfall proposal carries a third arm**, `Overrule the assessment`, beside Approve and Reject.
The other two settle what to _do_ about the assessor's finding; this one settles the finding itself.
Without it the card has no arm that says "that is wrong": approving spends an agent on a follow-up
part for work already done, and rejecting leaves the verdict standing, so rule `issue-assess`
dispatches again and the next assessor records the same shortfall from the same evidence — a loop
with no exit on the surface that raises it. It posts to
[`/api/issues/:number/shortfall/overrule`](16-http-api.md#post-apiissuesnumbershortfalloverrule) and
then rejects the proposal, which is the honest verb for "no follow-up part"; the two are separate
calls because they settle two different things, ordered verdict-first so a failed rejection leaves
the goal correct with a stale card rather than a settled card with the loop still running.

Two properties of the arm are deliberate. It is drawn **only when `context.issueNumber` is present**,
since it writes a verdict against a goal and a button that would 400 is worse than two arms. And its
note is **required** where the other two take one optionally — the words are the act: they become the
delivery's reason and the correction the ticket gets, and an overrule with an empty box records
"delivered" for a reason nobody can read, which is the assessment problem again with the operator's
name on it. So the button is disabled rather than hidden until there is text, and the placeholder
says which of the three arms needs it.

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
  reasons are in the `title`. Four of the seven take a tone (`courtTone`); the rest print plain —
  `ignored` says which arm it is in the chip and dims its whole row instead, since it is the one arm
  that is a standing instruction rather than a reading of where the work got to.
- **Issue pickup** — `issuePickupStatus(issue, ctx)`, attached per issue. The tickets tab draws its first
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
  the old flat world panel's rows; the tickets tab filters by watch state instead, which is the axis triage
  acts on. The fold is pure and tested (`test/issueGroups.test.ts`) and is what a hierarchy view would
  be built from.
- **`reorderUpNext`, `dismissHumanTask` and `fetchWorkSubtree` have no caller either.** The overview's
  Up next is a reading rather than a control; the rail carries only `open` human tasks, so there is no
  settled tail to dismiss from; and the work tab embeds the shared panel, which reaches its own route
  directly — the seam keeps the method for the reason it keeps `setStackLanding`.
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

**The fixture world is one product, and the product is Markdown Magpie** — a Git-backed Markdown
knowledge system that indexes documents, answers with citations, clusters the weak answers into gaps and
publishes improvements as pull requests. Every goal, pull request, plan, finding, transcript and spend
row in `fixtures.ts` and `demoBackend.ts` is work on that one codebase, with its real file paths and its
real vocabulary. The theme is load-bearing rather than decorative: an operator meeting the cockpit for
the first time is trying to follow one story across nine panels, and a fixture set drawn from three
unrelated products reads to them as a console that is showing them noise. A new fixture joins that story
or it does not go in.

**Every pickup status has a goal in the fixtures.** `issuePickupStatus` answers fourteen ways
([06](06-issue-pickup.md)), and each answer is somebody's whole explanation of why nothing is happening
to their ticket — so `done`, `retained`, `has_pr`, `active`, `ignored`, `container`, `unwatched`,
`planning`, `delivered`, `assay`, `cooldown`, `escalated`, `blocked` and `eligible` are each carried by
at least one issue, with the reason string the real gate would have written. A demo showing eight of
them teaches an operator that the other six are a bug on the day they first appear. The roll-call is
stated in a comment above the `issues` array, and the arithmetic around it has to hold as well: the cap
is 3 with two agents live, so exactly one goal is `eligible` and the rest of the ready ones are
`blocked` — a world with six eligible goals under a cap of three is one the dispatcher could not have
produced. Twelve of the fourteen are reachable by clicking, through the tickets tab's watch filter; `done`
and `retained` are carried without being listed anywhere, because no surface lists a closed goal — both
are still readings the wire ships and the goal page draws.

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

Nine files, split on what they can see:

- `test/cockpitViewModel.test.ts` — the derivations `buildViewModel` folds, untestable while they lived
  inside a component.
- `test/needsYou.test.ts` — the merged queue and, first among them, its ordering.
- `test/goalPage.test.ts` — the page's assembly: which parts, PRs, agents and decisions belong to a
  goal, and the prefix trap `issue:14` versus `issue:1`.
- `test/console.test.ts` — the structural rules and the renders, against the demo fixtures.
- `test/cockpitPlace.test.ts` — the [address bar](#the-address-bar)'s codec: the round trip, the one
  spelling per place, and what a hand-typed URL that names nothing reads as.
- `test/insightExport.test.ts` — the [exports](#exporting-a-reading): the CSV quoting, the sections and
  their order, that figures leave unrounded, and that each caveat the panel speaks leaves as a row.
- `test/markdown.test.ts` and `test/richText.test.ts` — the two prose renderers, and the line between
  them: agent-authored markdown never interprets HTML, tracker-authored HTML is drawn as structure.
- `test/refLinks.test.ts` — [Links](#links): where each family of ref goes, that a goal with no page
  links out instead, that an unresolvable ref is plain text, that `refLabel` is the only shortener, and
  — structurally, over the rendered console — that no reference is ever drawn inside a button.

The renders are wrapped in a **clock pin**, because `buildDemoState` stamps every timestamp relative to
`Date.now()` and the rendered relative times would drift between runs otherwise.

`test/console.test.ts` holds the two structural assertions the layer split rests on — nothing under
`console/` imports `api.js`, and `console.css` never targets a shared component's class — and pins the
renders where being wrong would be worse than being absent: the rail carrying every blocking kind in one
list, its array order surviving the grouping, the holding count agreeing with its noun, an empty queue
muting rather than removing the rail, a group with no rows drawing no heading, a row with a goal being a
button and the recovery hold not, the ask drawn above the plan, a goal with no ask drawing no band, the
goal page answering through the shared card, a held part quoting the reconciler, a retired plan drawing
what it proposed rather than only saying it has no live parts, an HTML ticket drawn as HTML, a goal with
no measured spend drawing no `$0.00`, the overview's five cards, an empty rack still drawing, the
tickets tab's intake call-out, its rows being ways into their goals and its container cascade, the fault
log keeping its clear at zero, a panel's two ways out, the demo gate on injection, the precedence
between a goal and whichever tab the nav is on, all three tabs appearing in the nav (a destination added
to `ConsoleTab` and forgotten there is a view nothing can reach), the work graph drawn by its own tab
and no other, the recovery banner outside the situation area, a dropped socket drawing nothing at all,
and the shell rendering the drawer the console only asks for — and no longer the work graph.
