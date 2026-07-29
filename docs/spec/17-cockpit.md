# 17 — The cockpit

`web/` is a React 18 + Vite SPA. It has its own `web/tsconfig.json` and its own `web/src/types.ts`;
**the web bundle never imports server code**, so the two type files are intentionally separate and
`npm run typecheck` and `npm run typecheck:web` are separate passes.

`npm run web:build` bundles it into `web/dist`, which the server serves in production.

## Layers, and what a skin is

The cockpit is three layers, split so that how it _looks_ is replaceable without touching how it
behaves:

| Layer        | Path                        | Job                                                                                            |
| ------------ | --------------------------- | ---------------------------------------------------------------------------------------------- |
| Wiring       | `web/src/cockpit/`          | fetch, websocket, coalesced refresh, which drawer is open, the bound `CockpitActions`. No JSX. |
| Derivation   | `web/src/view/viewModel.ts` | the pure `buildViewModel` → `CockpitView`. No React.                                           |
| Presentation | `web/src/skins/<id>/`       | one directory per skin, listed in `skins/registry.ts`.                                         |

`App.tsx` is only the shell: acquire state, resolve the skin, render its root. The two screens it
still owns — "Connecting…" and the locked-out page — stay there because neither has a view-model to
draw, and a refused credential must read the same however the cockpit is themed.

**A skin owns its whole layout.** It is handed a finished `CockpitView` and renders whatever tree it
likes, rather than overriding slots in a shared page: the treatments worth having redraw the data
(a dispatch queue as a belt feeding machines) rather than rearrange the panels, and a slot contract
wide enough for that is no longer a contract.

What stops that becoming N divergent cockpits is the split on **behaviour weight**:

- **Shared** (`web/src/components/`) — anything with an async flow, a refusal rule or hold
  semantics: `AgentDrawer`, `EscalationCard`, `RecoveryPanel`, `InjectPanel`, `LaunchPanel`,
  `FindingsPanel`, `PlanPanel`, the buttons, and the leaf helpers. The escalation 409 rules and the
  recovery verdicts get exactly one implementation.
- **Skin-owned** (`web/src/skins/<id>/`) — anything that draws over data it was handed: the fleet
  card, the queue, vitals, the feeds, the chips, the topbar.

`UpNext` sits on the line: it carries the reorder drag, which is a mutation, and it is also exactly
what another skin would replace wholesale. Resolved by putting the _call_ on `CockpitActions` and
leaving only the drag UI skin-side.

**Two panels hang off the shell rather than off a skin**, below it, so they read the same whichever
theme is on: the work graph (`WorkTreePanel`) and the prompt book (`PromptsPanel`). Both are absent
from the view-model because both ride their own routes, **fetched on open, never polled** — the graph
because it only ever grows, the book because it never changes at all. A skin drawing either would have
to reach `api.js` directly, which is exactly what the skin seam forbids and `test/cockpitSkins.test.ts`
asserts.

The Prompts panel is a collapsed button that opens the list of ids (each with the opening sentence of
its doc and an `overridden` badge), and a row opens a modal carrying the doc in full, the placeholders
an override may use, the path of the override file, and the effective template text. It is read-only:
the path is what makes it actionable, since overriding is a file drop
([16](16-http-api.md#get-apiprompts)). Under `dispatcher: 'claude'` it says so — that dispatcher
composes its own prompts and none of the book fires. The demo build serves an empty book: the web
bundle imports no server code, and a copy of eighteen prompts shipped to fill the panel would be free
to drift from the originals with nothing to catch it.

`WorldSummary` moved the other way — out of Classic and into `components/` when the second skin
arrived. Most of it is drawing, but the watch/ignore toggles, the conclusion verdict and the assay
override are operator controls with refusal rules behind them, which is the side of the split they
belong on. A skin reimplementing it would sooner or later ship a world view missing a toggle, and
switching skins would silently take a capability away. The assay override is the sharpest case, which
is why it is here and not only on the Goal Floor: an `unclear` verdict is the one intake reading that
_blocks_ dispatch ([06](06-issue-pickup.md)), so a skin without it is a cockpit you cannot un-block an
issue from.

**Skins never import `api.js`.** Every mutation is enumerated on `CockpitActions`, pre-bound, so a
skin cannot grow a capability another lacks — a difference that would surface only as a button
existing in one theme. Asserted structurally in `test/cockpitSkins.test.ts`.

### Tokens

Tokens in `styles.css` are the styling contract **for shared components**, which is narrower than
the usual meaning: a skin may write whatever CSS it likes for its own markup, but a shared component
must be restyleable without being edited. So shared components style themselves only through tokens,
and skins define the tokens. Beyond colour that means `--r-*` (radius — the one non-colour token
that genuinely blocks a treatment, since a square-cornered skin is unreachable by palette alone),
`--font-ui|mono|display`, and `--border-hi`/`--border-lo` so a bevel is expressible. Classic points
both border tokens at `--border`, so its panels stay flat.

A skin's stylesheet is imported from `main.tsx`, not from the skin's own module. A `.css` import
inside a skin would be invisible to `tsx`, which has no CSS loader and would throw when
`test/cockpitSkins.test.ts` pulls the skin modules in. Each sheet is scoped to its own `[data-skin]`
selector, so loading all of them costs a few kilobytes and collides with nothing.

### The skins

**Classic** — three columns: fleet, your inbox, the queue and the feeds. Rounded, cool, flat.

**Factory Floor** (`skins/factory/`) — the dispatcher's decision drawn as a production line. The
fleet cap is a roboport with a pad per slot, each slot is a machine bay, the "Up next" queue is a
belt of crates, and the headroom cut is a hazard-striped gate the belt backs up behind. It exists to
make one claim visible that Classic makes you assemble from three panels: **a bay runs only when it
has both an item and a bot**.

Three properties keep it a view rather than a costume, and they are what to preserve when changing
it:

- **Nothing is drawn that isn't in the snapshot.** Every bay is a live agent, every crate is a
  `QueueItem`, every launch is a row in `closedPullRequests`. There is no progress bar, because
  nothing reports progress — a bay shows elapsed time instead. The rocket fires only when the
  retained window actually contains a merge.
- **The belt is the harness running, so it stops when the harness does** (paused, or held on
  recovery), as does the radar sweep. A belt still moving while no cycle will run is the one
  genuinely misleading thing this layout could draw, so `test/factorySkin.test.ts` asserts it rather
  than trusting the CSS. The same test pins the gate to the dispatching prefix — a gate that drifted
  off the cut would be confidently wrong, which is worse than no picture.
- **The vocabulary is stated once**, in the pure `factory/vocabulary.ts`, so the belt and the bay
  cannot disagree about what a plan part looks like.

Red means exactly one thing on that floor: an agent parked on a question only you can answer.

#### The floor at width

`FactoryRoot` binds every panel to a `const` and then places it, so what a panel contains and where
it sits are separate edits. It renders **three rails** — `act` (recovery, alerts, awaiting your
stamp, blueprints, faults), `floor` (the line, bots, research, the yard, off-blueprint) and `world`
(production, launches, signals, shift log) — split on _whose turn it is_ rather than on subject, so
a glance answers "is anything waiting on me" without moving. Production heads the world rail rather
than the floor because its subject is output, and output is merges — the world's answer to the
floor's effort.

There is **one DOM for every width**; the arrangement is chosen in CSS alone:

| width     | arrangement                                                                         |
| --------- | ----------------------------------------------------------------------------------- |
| < 940     | one column                                                                          |
| 940–1499  | two columns; the line, research and the yard span both                              |
| 1500–1899 | tiled — one four-column page grid, each panel spanning what it needs                |
| ≥ 1900    | railed — the three rails, each scrolling on its own, the page fixed to the viewport |

Below 1900px `.fx-rail` is `display: contents`, so its panels fall through and become tiles of the
page grid directly. **The breakpoint is therefore stated once.** Matching it in React as well —
rendering a different tree per width — buys nothing and costs a resize listener, a re-render on
every drag, and a second definition of the boundary that will disagree with this one the first time
either moves.

Three consequences to preserve:

- **The rails' document order is not the floor's reading order**, so the two dissolved arrangements
  set `order` per panel: the line, then the detail it cannot hold, then the readings you consult
  rather than watch. `order` is reset to `0` inside a rail at ≥1900, or those same values would
  reshuffle each rail internally.
- **A rail must stretch to its row, not to its content.** `.fx-rails` carries `align-items: start`
  for the tiled arrangement, which is right for a tile and wrong for a rail: a rail sized to its
  content is tall enough to hold everything, so its `overflow-y` never engages and the _page_
  scrolls instead. The railed block sets `align-items: stretch` back.
- **The full-bleed pictures need a container that caps them.** The line and the production graph
  scale with their container; given the whole of a 3440px display, the graph alone became a
  ~500px-tall chart that ate the first screen. Their spans are what stop that, which is why widening
  the old centred ribbon without also tiling it made the skin worse rather than better. The graph is
  no longer on the floor at all (below), but the constraint is the line's too.

#### What the floor draws beyond the queue

Each of these is a game mechanic kept only because a snapshot field already carried the reading; the
argument for each is in its module's header, and the reason for the shape is worth stating here:

- **Machine status** (`bayMachineStatus` / `crateMachineStatus`) replaces the old two-word
  `beltTag`. The game already has a word for each of these conditions — an assembler with nothing to
  consume says _no ingredients_, one whose output nobody takes says _output full_ — and those carry
  a diagnosis "Cooling down" does not. Both halves of the floor route through the one file so the
  two `waiting`s stay apart: a **waiting agent** is parked on a human and is red, a **waiting item**
  merely has no free bay and is not. A paused floor answers `No power` before anything else, since
  nothing else explains every machine at once.
- **The floor is laid out from the cap**, not from a fixed four slots, up to `MAX_BAYS`. The old
  array named the surplus in the header and cropped it off the picture, which made the one control
  an operator actually turns invisible in the panel that exists to show it. Pads shrink to fit the
  roboport's face so "one pad per slot" stays literally true.
- **The belt is drawn as a belt**: chevrons in the tier colour running along a dark body, pointing
  the way the queue moves. They are a mask rather than an inline SVG background, because the arrow
  has to take `--fx-belt` and a data URI cannot read a custom property. The crossed diagonals this
  replaced read as hazard tape — a warning, which is the one thing a belt is not — and drew no
  direction at all, leaving the animation as the only thing that said which way the queue ran. An
  arrow says it standing still, which matters because a stopped belt is a state this floor draws.
- **The floor fills the panel; the plan does not stretch to it.** The bay count sets the plan's own
  width, which at one or two bays is narrower than any screen — so the width goes in as an inline
  `--fx-plan-w` and `.fx-line` takes it as a **`min-width`** with `width: 100%`. The sunk floor and
  the belt then reach the panel's edge at any cap, because a belt that stops where the bays stop is
  the one thing a line never does; above the panel's width the scroller takes over as before. The SVG
  is pinned to `--fx-plan-w` rather than to the floor: stretched, it rescales and centres its viewBox,
  and the crates — laid out in the same px units as the bays — would stop lining up with the
  inserters they feed.
- **The belt compresses behind the cut.** The boarding prefix keeps the crate pitch; everything
  behind butts together with no gap, because that is what a belt does when nothing is taking from
  it. Each run is omitted when empty — an empty flex child still takes the row's gap, and that gap
  is exactly where the gate sits.
- **Inserters swing on a transfer, not on occupancy** (`inserterPhase`). An arm that ran for the
  life of an agent was the one moving thing on the floor carrying no information. A swing is one
  heartbeat from the agent's `startedAt`, and it carries the item while it swings.
- **Silos** (`silo.ts`) draw open PRs filling toward a launch, beside the Launches log of PRs that
  already closed. The fill is a **fixed four gates** — `health.reasons` names only what is wrong, so
  it is a numerator with no denominator — while `attention.status` names the court, read off the
  server and never re-derived. `health.reasons` is quoted underneath, never parsed.
- **Production** (`production.ts`) is the only panel that reads against time, which is the only way
  to answer whether the floor is producing rather than merely busy. Rates come from the timestamps
  already on `decisions` and `worldEvents`; a held or skipped dispatch is not counted, because it
  produced no work. The churn ratio (dispatches per merge) is the point of the panel. When the
  decision log does not reach back to the window's start the panel **says so**: a rate that silently
  under-reports is worse than no rate. It is the one panel an operator _consults_ rather than
  watches, so it draws at two sizes off one set of plotting functions: a **tile** at the head of the
  world rail carrying the whole reading a glance wants (the shape of the three series, the three
  rates, the churn number), and the **full panel** — axes, deltas, spend, the truncation caveat —
  behind a click, in the skin's `Modal`. Two components drawing the same series independently would
  be two things to keep in step for no gain; the only difference between them is the rectangle they
  plot into and whether the axes are labelled. The modal is an `.fx-card` with a backdrop rather than
  a second surface, and closes on the backdrop, the button _and_ Escape — a thing that covers the
  floor must not have exactly one exit.
- **The Goal Floor** (`goalFloor.ts` + `components/GoalFloor.tsx`) draws **one ticket's whole
  production line**, patch to launch, and takes the slot the tech tree had. See
  [The Goal Floor](#the-goal-floor) below.
- **Circuit signals** group `worldEvents` by `(kind, ref)` and carry a count — three comments on one
  PR read as one signal, not three unrelated rows. Polarity comes from the **kind alone**
  (`signalPolarity`); the summary is prose written for a human, and parsing it here would be a
  second reader of a string nobody promised to keep stable, so `pr_ci` is neutral rather than
  guessed.
- **Power** (`power.ts`) pairs satisfaction (the 5h window) with an accumulator bank (the 7d one),
  because they fail differently: full satisfaction over a draining bank is a week's budget going on
  an afternoon. The bank is a **segmented gauge** filled from one number, not a staircase of
  per-cell levels that do not exist. A brownout dims the machinery and nothing else — the reading
  belongs on the floor, but not at the cost of the text needed to act on it. Both are absent
  entirely when the subscriber limits were never captured; there is no denominator on an API key.

Two panels on the act rail carry a rule of their own:

- **Blueprints** (`data-fx="blueprints"`) is the `LaunchPanel`, and on this skin the `InjectPanel`
  hangs off **`view.demo`** — the static Pages build — rather than off `config.injectable`. Injection
  fakes a world change, which is only ever something the demo needs: a real run against a fake
  provider is still a real run, and a panel that lies to the harness there is a way to lie to yourself
  about what it is reacting to. The empty-floor line reads from the same predicate, so it never offers
  an injection there is no panel for. Classic keeps `config.injectable`.
- **Faults** offers a two-step **clear** in its head whenever it has any, posting
  `POST /api/errors/clear`. Two-step because the rows go: nothing in the harness reads the fault log
  back, so a clear costs nothing anything decides on — but it costs the only copy, and for every
  cockpit rather than this one.

#### The Goal Floor

`TheLine` draws the **dispatcher** — bays, belt, headroom gate, subject: agents. The Goal Floor draws
the **work**: one ticket's whole production line, in the order
[`docs/workflow.md`](../workflow.md) describes it. Ticket → is there enough here to act on → plan →
do the work → checks → merge → is the goal achieved → report → update the ticket → done. Its design
is [`2026-07-29-goal-floor-design.md`](2026-07-29-goal-floor-design.md), and the mockup it was
written against carries a node-by-node conformance table against the workflow doc.

| Factory              | Harness                                            |
| -------------------- | -------------------------------------------------- |
| Ore patch            | A ticket, and the strip that picks which floor     |
| Assay drill          | The goal assay, rule 3f                            |
| Furnace              | The planner, rule 3c                               |
| Splitter / merger    | Where the plan's edge list branches and rejoins    |
| Assembly machine     | A plan part, carrying the pull request it produced |
| Scanners on the belt | CI checks, classified — plus human review          |
| Silo                 | The goal, filling with settled parts               |
| Satellite            | The assessment, rule 3e                            |
| Manifest             | Report what was done — `issue.conclusion.note`     |
| Signal post          | Update the ticket — state and status comment       |
| Launch               | `delivered`, or a launch that failed verification  |

Six properties, and they are what to preserve:

- **Every machine is a work item.** A splitter and a merger have no status, no agent and no origin
  ref — they are where the edge list branches — so they are belt _fixtures_. Drawing one as a machine
  also stretches it to the full height of the fan-out, which is the same mistake showing up as a
  visual bug.
- **Position comes from structure alone.** `layoutFloor(refs, edges)` is pure over refs and
  dependency edges — no status, no tone, no timestamps — and memoised on the shape, so a machine moves
  only when a part appears, is retired, or opens a pull request. Without the split a floor is re-laid
  on every poll and jitters exactly when an operator is watching it most closely. Column is
  **longest-path depth**, not `dependsOn[0]`'s: a part waiting on several must never draw to the left
  of something it waits on. That also means it tolerates **in-degree > 1** today, before the plan
  schema can emit it (#170), so relaxing the arity cap needs no cockpit change.
- **Absent is not stopped.** A goal nothing has assayed draws **no drill**; one refused at intake
  draws a drill that is red, stopped, and carrying its reason. Collapsing the two would put #158 back
  — the whole point of intake having a verdict. That refusal's plate is a **second entry point** onto
  the shared assay override above (`PlanModal`'s pattern, where three surfaces reach one `viewPlan`),
  and the only plate carrying one: `FloorPlate.assayIssue` names the issue an override would rewrite
  and is null on every other plate, so the component never decides for itself which plate that is —
  the first `workable` plate anyone adds cannot silently grow buttons. The buttons sit beside the
  assayer's words rather than over them, with the expiry sentence under both.
- **A CI machine's state comes from the verdict, never a check's name.** Scanners are generated from
  `pr.ciVerdict` (`dispatch` → damaged, `escalate` → not ours, `ignored` → muted), so a floor running
  against a config naming any check at all renders with no code change, and **no check name from any
  workplace appears in this repository**. Human review is the exception worth knowing: reviewer
  policies deliberately do not fold into `ciChecks` — they map to `approved`/`unresolvedComments` —
  so that one scanner is fed from `pr.approved` or it is permanently absent.
- **A stopped machine says why, in the harness's own words.** Every plate under the floor quotes a
  string the server computed: an assay summary, a planner's reason, a `health` reason, a
  `QueueItem.reason`. No prose is assembled in the browser and none is parsed, for `signalPolarity`'s
  reason. The queue's own words are reused on a held machine too — a part the cap is holding says
  _output backed up_ rather than _ready to start_ beside a bot that is never coming.
- **The belt is the harness running.** A lit belt animates only while cycles run; paused or held on
  recovery, they all stop. `cold` is a different fact and a different class — an edge nothing can
  travel yet, because the machine behind it has not produced anything. Asserted in
  `test/factorySkin.test.ts` rather than trusted to the CSS.

**Two sources, with different jobs.** `/api/state` is the live reading and wins wherever both speak;
`GET /api/work/issue:<n>` is fetched **once** when a floor is opened, never on a poll, and may only
_add_ settled machines the world has forgotten — a PR merged past `closedPrWindowMs`. That one line is
the whole of the merge: two sources each partly owning a field is how they start disagreeing. The
fetch goes through `fetchWorkSubtree` on `CockpitActions`, because a skin may not import `api.js`.

**It replaced the tech tree rather than joining it.** The tree's one unique claim — depth is how many
merges must land before a part can start — survives intact as the floor's column, and `stateOf` /
`depths` moved into `goalFloor.ts` as `partProgress` and `layoutFloor`. Keeping both would have left
two components deriving a part's state from `PlanPart.status` independently, which is the drift class
this codebase has already paid for twice.

**Two verdicts are computed server-side and shipped** (`pr.ciVerdict`, `issue.assay` — see
[16](16-http-api.md)), and that is _why_: nothing under `web/` may import `src/dispatcher/` or
`src/graph/`, asserted structurally in `test/workGraph.test.ts` beside the two that say the same of
the dispatcher.

**The signal post claims both signals the harness sends** (#171): the work item's state move, and the
one living status comment the plan reconciler keeps. Three things hold it together. **A plan with no
comment says so rather than falling silent**, which is what having a writer on the wire buys: both
states are readings rather than one reading and one blank. **No plan is not the same as no comment** —
an unplanned issue has no plan row, so nothing *could* have written one, and that third reading gets
its own words rather than being folded into the second. And **the reading and the way in are separate
facts**: the meta line states which of the three it is and is drawn whatever the provider can resolve,
while the machine's `link` — captioned `notice ↗`, never printing the ref, which is machinery —
appears only when `refUrls` has a URL for it. Keeping them apart is what lets a plan under a provider
that builds no URLs still say a notice went out, without offering a way in that goes nowhere.
`signalPostStatus` is a closed fold with a word per combination of the two signals, asserted arm by
arm in `test/factorySkin.test.ts`.

`Machine.link` is `{ref, label} | null` and is **never set beside `prNumber`**: they share one corner
of the node, so a machine claiming two ways out would draw one over the other. The test asserts that
rather than trusting it.

One thing is still deliberately **not** drawn. Quality-pillar commentary is not drawn at all, for the
stronger version of the old reason — nothing in the harness writes it, so a third line there would be
a machine reading a field with no writer.

The icons are original marks in `Sprite.tsx`. The game the treatment nods at owns its art outright
and licenses none of it for redistribution, so none of it is used or traced; what carries the
reference is the vocabulary — a bay, an inserter, a roboport — which is nobody's property. The
display face is Bahnschrift/DIN Alternate, already present on Windows and macOS respectively, rather
than a bundled webfont.

### Choosing one

`localStorage['lubbdubb.skin']`, stamped onto `<html data-skin>` by a small script in `index.html`
**before first paint** — in the bundle it would run after the default had already painted, so
switching would flash the old skin. An unrecognised or missing id falls back to Classic silently: a
stale id is a normal thing to find after a skin is renamed, not an error. The picker is a _shared_
component so a half-built skin is never the one you cannot escape from, and applying is a reload,
since a skin owns the whole tree and switching unmounts everything anyway.

The choice is deliberately **not** in `Config` or `/api/state`. It is a per-viewer preference;
shipping it in the snapshot would make one operator's taste global to every cockpit.

### Tests

`test/cockpitViewModel.test.ts` covers the derivations (untestable while they lived inside a
component). `test/cockpitSkins.test.ts` holds the structural no-`api` rule, a conformance render of
every registered skin against the demo fixtures, the unknown-id fallback, and a byte-for-byte golden
of Classic's markup (`test/fixtures/classic-markup.html`, regenerate with `UPDATE_GOLDEN=1`). The
golden fixes the static tree only — not effects, not CSS — and its value is forward-looking: a
change to Classic's DOM has to be deliberate enough to regenerate it.

The golden render is wrapped in a **clock, locale and timezone pin**. The clock is obvious
(`buildDemoState` stamps relative to `Date.now()`), the other two less so: `UsageChip` formats the
rate-limit reset with `toLocaleTimeString([])`, i.e. the _runtime's_ locale and zone, so the same
instant is `14:20` on one machine and `02:20 PM` on another and the golden silently records whichever
laptop generated it. It did — the test was red on the Linux runner from the day it landed while
passing locally. The formatters are pinned rather than the component changed, because which clock
format an operator sees is correctly their machine's business; it is only the golden that needs it to
be nobody's. An assertion beside the comparison fails if the pin ever stops taking effect.

`test/factorySkin.test.ts` covers that skin's pure vocabulary exhaustively (every `QueueItem.status`
and every Goal Floor stage has a machine word; only `waiting` reads as jammed; the two `waiting`s do
not read alike; a paused floor outranks every other diagnosis; every `StatusTone` resolves to a
colour) plus each derivation added beside it: the floor's longest-path columns, lanes, fixtures,
retired parts and a cycle that must not hang the cockpit; every `PlanPart.status` folding to a
progress; absent-is-not-stopped; scanners generated from the verdict with human review fed from
approval; ghosts; the tail; the silo's fixed denominator; production counting only what landed and
admitting when the log is too short; the accumulator gauge clamping. It also pins the renders where
being wrong would be worse than being absent: both belts stopping, the gate tracking the cut, the
belt splitting into a moving and a compressed run, and the floor widening with the cap up to its
bound.

A skin registered but not otherwise tested still gets the conformance render for free, which is the
point of driving it off `SKINS` — it is asserted on the day it is written rather than the day it
breaks.

## Data flow

One state object, one socket.

- `api.getState()` fetches `/api/state`. The whole UI renders from that object.
- A WebSocket connection delivers events. `dirty`, `world:changed`, `control:changed` and
  `world:events` each trigger a refetch; `cycle:end` also resets the heartbeat countdown anchor.
- **Refetches are coalesced** (`scheduleRefresh`, `REFRESH_COALESCE_MS`): at most one request in
  flight, at most one queued behind it, and a short trailing window so a burst collapses into one.
  The server pairs a coarse `dirty` with almost every specific frame, so one pulse alone is four
  signals, and `agents.on('files')` fires once per file an agent writes — fetching per signal made
  the request rate a function of agent tool-call volume. The queued refetch **always runs**:
  coalescing may merge the signals in between but must never drop the last, or the cockpit settles on
  a state older than what it was told about. The initial fetch on mount is immediate, not delayed.
- `agent:output` deltas accumulate into a per-agent scrollback (capped at ~1M characters) — but only
  for the agent whose drawer is open, because output is delivered to subscribers only.
- `agent:tail` lines land in a separate map and drive the fleet-card previews.
- The WS client is held in a ref so subscribe/unsubscribe survives effect churn, and it reconnects on
  its own.

The drawer subscribes to full output on open and unsubscribes on close or switch.

## Layout

A top bar and three columns.

### Top bar

Brand, a **heartbeat countdown** (a progress track showing the fraction of `heartbeatIntervalMs`
elapsed since the last pulse), a **world age** chip, a live/offline connection chip, the usage chip, the
active dispatcher, a `paused` chip when paused, the fleet control, and **Pulse now**.

- **World age** — `worldObservedAt` rendered relative ("world 2m ago"), or "world not yet observed"
  before the first cycle. Stated rather than implied because the cockpit's world is the reading the
  last pulse took, not a live one (see [16](16-http-api.md)); a reading that keeps ageing past an
  interval is the visible symptom of pulses failing, which no countdown can show.

- **`UsageChip`** — the account 5h/weekly rate limits when the PTY status-line capture has seen any;
  otherwise it falls back to the rolling 5h/7d cost windows.
- **`FleetControl`** — live count against the cap, with the cap and pause both editable. Writes go to
  `POST /api/control`, and the `control:changed` broadcast updates every open cockpit.

### Above the grid

- **`RecoveryPanel`** — rendered above everything else when `state.recovery` is non-empty: one card per
  agent the previous run orphaned, with **Restore** / **Requeue** / **Remove**. A banner rather than a
  panel because while it is up the harness runs **no cycles at all**, so every other surface on the page
  is stale for the same one reason — and the heartbeat countdown in the top bar reads `pulse held`
  instead of counting down to a pulse that will not fire. Restore is replaced by the reason it cannot be
  offered (`restoreBlocked`) rather than hidden. Each card shows how the run ended (crashed vs shut
  down), the agent's last progress note, and the question it was parked on if it was parked on one.
- **`InjectPanel`** — rendered **only** when `state.config.injectable`, i.e. some capability uses the
  `fake` provider. A real-integration deployment does not see it, and the route refuses anyway. (The
  factory skin narrows this further to the demo build — see below.)
- **`LaunchPanel`** — stamp a blueprint: an operator job (prompt, optional title, code/desk, optional
  branch) and the queue, including cancel. The button is `+ New blueprint` behind a blue blueprint
  plate — drawn inline in the component rather than added to a skin's sprite sheet, because the panel
  is shared and the sprites are not. It is the one glyph in the cockpit that is not `currentColor`: a
  blueprint is blue the way a warning is amber, so the colour is the noun.
- **`Vitals`** — fleet-level counts.

### Left column — Fleet

`AgentCard` per live agent: status dot, the task title and its origin ref (linked through `refUrls`),
elapsed time, cost/tokens where reported, the agent's `note` where it has one, the compact tail line,
artifact chips from `flags`, and a kill button. Clicking opens the drawer. Below, a **History**
section shows the last 8 finished agents.

When the fleet is empty the panel says so, and tells the operator whether to inject an event or wait
for the world to change — chosen from `config.injectable`.

### Middle column

- **Needs you** — open escalations, newest first, as `EscalationCard`s. Each card carries the task
  title, the origin ref, a tail of the agent's output, and — when the park came through the `escalate`
  tool — the `detail` and one-click `options`. Answering posts to
  `POST /api/escalations/:id/answer`; the card can also open the agent's drawer. A **permission
  request** (`context.permission`, issue #130) renders the command and **Allow / Deny** buttons
  instead of the answer box — the agent is blocked in a tool call, so the verdict goes to
  `POST /api/escalations/:id/permission`, not `/answer`.
- **Plans** (`PlanPanel`, rendered only when plans exist) — each plan's parts drawn as a stack, joined
  to `upcoming` **by origin** (`issue:<n>:part:<slug>`) so the dispatch cut is visible, with a
  **Replan** button. A plan `awaiting_approval` says so on the card and states that nothing below is
  scheduled until you accept the proposal in "Needs you". Each row also opens the plan modal (below).
- **Findings** (`FindingsPanel`, when any exist) — the open count in the heading, since a finding
  never expires into work on its own and this is the only nudge there is. Each has **Queue job**
  (work it now), **File ticket** (defer it — hidden unless `config.canFileTickets`) and **Dismiss**. A
  finding being filed shows `filing…` and is drawn among the open ones, since an agent that died
  before creating the ticket is only visible here; a filed one carries its ticket ref as a link.
- **File overlaps** (`OverlapPanel`, when any exist) — the **live** count in the heading, since those
  are the only ones an operator can still act on; a settled overlap stays as the record of what
  collided. Each row shows the path, its writers with their origins and branches, and marks the
  `sameWorktree` case.
- **World** (`WorldSummary`) — open PRs with their attention chip, their health verdict and an exclude
  toggle; issues with their state, linked PR, pickup chip, conclusion chip and **shortfall** chip, a
  watch toggle, the conclusion toggles and the **assay override**; stories with a watch toggle; and a
  **Recently closed** section marking each PR merged vs closed-unmerged.

  The assay override draws on an issue the intake verdict **refused** and nowhere else
  (`POST /api/issues/:number/assay`, [16](16-http-api.md)). A `workable` verdict blocks nothing, so a
  button on one would offer to change a reading that changes no behaviour. It is **two buttons and not
  one toggle**: `work anyway` writes `workable`, while `clear assay` deletes the row — `null` is not
  `workable`, it is the store's one representation of "nobody has decided", which is also what a
  crashed assayer leaves behind. The assayer's own summary is quoted into the title and never
  rewritten. Both titles carry the sentence the buttons cannot say for themselves: the hold **also
  ends by itself** the moment the ticket's own text fingerprints differently, with no timer and
  nothing re-asking — an operator who does not know that reaches for the override where editing the
  goal was the honest fix. It writes the harness's own record and touches no tracker, the same
  discipline as the conclusion route.

  The shortfall chip (`plan fell short` / `part fell short` / `goal is wrong`, with the assessor's
  summary in its title) sits **beside** the pickup chip and inside neither it nor the conclusion
  chip, for the reason `attention` sits beside `health`: pickup answers "would an agent start on this
  next cycle", and a shortfall's honest answer to that is "yes, and that is the point"
  ([06](06-issue-pickup.md#the-shortfall--the-same-verdicts-other-polarity)). What it adds is _what_
  fell short, which is the whole of what makes the verdict routable and the one thing an operator has
  to see before being asked to authorize a replan. A shortfall with no cause draws nothing — the
  conclusion chip beside it already reads `work left`, and one home per fact.

  Rows are filed under three tabs — **Watched** / **Unwatched** / **Ignored** — by the pure
  `watchBucket` (`web/src/worldBuckets.ts`) over each item's labels, with the server's precedence
  (ignore wins, then watch, else the type default: PRs opt-out, issues and stories opt-in) and each
  tab's count on its label. It is deliberately a _three_-way split where `resolveWatchState` is
  binary: the gate only cares that an untagged issue won't be worked, while the panel has to tell
  "you tagged this leave-alone" from "you haven't triaged this yet" — the same `ignored`/`unwatched`
  distinction `issuePickupStatus` reports.

  Three consequences. **The tab bar disappears when both labels are empty** (`labelPrefix: ''`, the
  gates off): every item then sits on its type default, so two tabs could only ever be empty _and_
  filtering to Watched would hide every issue — so nothing is filtered at all and the panel reads
  exactly as it did before. **The chips a tab already states are dropped** — the pickup chip and the
  `ignored`/`unwatched` chips render in the Watched tab only, which is what stops one identical
  `no watch label "…"` chip repeating down every untriaged row. Dropping the pickup chip wholesale
  is safe because the bucket reads _labels_ while the Azure state gate reports through _status_: a
  watched issue parked by `pickupStates` is filed under Watched, where its `in review` reason still
  shows. **"Recently closed" lives in the Watched tab alone**, since it exists so a PR you were
  following doesn't silently vanish mid-session — a statement to someone monitoring — and bucketing
  those rows by their own labels would scatter them. Tab counts cover live world items only, so the
  Watched number doesn't climb as work finishes.

  An issue's `→ PR #n` chip is dimmed and marked `(not open)` when `n` isn't in the open PR list the
  snapshot ships — the same list `openPrForIssue` is given, so the chip and the harness's `has_pr`
  reading can't disagree. `linkedPrNumber` is the last PR that ever referenced the issue and never
  clears, so most of them point at long-closed PRs. It says only "not open", never merged or closed:
  which of the two it was is not something the harness observed.

### Right column

- **Up next** (`UpNext`) — the last cycle's ranked queue with the headroom cut drawn. Each row shows
  its rule (expandable into the rule's description from `dispatchRules`), title, branch and status
  (`dispatching` / `waiting` / `cooldown` / `capped` / `unapproved`), plus **▲/▼ re-order controls**
  (issue #128). Moving a row sends the whole new order of candidate origins to
  `POST /api/upnext/order`, which the dispatcher persists as a priority override and reads back into
  its ranking — so the order survives pulses and restarts while the panel stays a projection. It
  re-orders only: a held row keeps its held status wherever it lands, and rule-0 jobs stay first. New
  work the harness surfaces later slots in behind the arranged order until you re-arrange. Empty under
  the `claude` dispatcher, which materialises no plan.
- **Decision log** (`DecisionLog`) — the last 100 decisions with outcome, detail and, where present,
  the rule that fired, expandable into that rule's standing rationale.
- **Activity** (`ActivityFeed`) — the last 100 world events.
- **Errors** (`ErrorsPanel`) — the last 100 recorded failures, with the count marked urgent when
  non-zero.

## The agent drawer

`AgentDrawer` opens over the page for one agent.

**The transcript pane is HTML, not a terminal.** What reaches the cockpit is already legible text in
every mode (`renderBlocks` output, or settled PTY session-file text), never raw TUI bytes, so it
renders into a scrollable `<div>` with `white-space: pre-wrap; overflow-wrap: anywhere`:

- Words wrap on their boundaries and the browser scrolls natively.
- The pane sticks to the bottom **only when you are already there**, and offers a "New output" jump
  pill otherwise, so a full-rewrite frame no longer snaps you away from where you were reading.
- The text is selectable.

The one terminal feature it reproduces is SGR colour, via the pure parser in
`web/src/components/ansi.ts` (`parseAnsi` / `ansiClass`, tested in `test/ansi.test.ts`), which handles
the five codes `renderBlocks` emits and threads the active style across streamed deltas.

**No xterm remains anywhere.** The browser-side `@xterm/xterm` and `@xterm/addon-fit` went first, and
`@xterm/headless` went with the server-side screen-scraping it existed to do.

The drawer also shows the artifact chips, the **files changed** list from `files`, and offers respond,
interrupt and kill.

## The plan modal

`PlanModal` (`web/src/components/`) is the whole decomposition, on demand — the record of what was
agreed, not just the question that was asked. Before it, a plan was legible only while it was a
pending proposal: the approval card rendered a template string and vanished on the click, and the
Plans panel drew rows whose `scope` was a tooltip. There was no way to say "show me the plan for
#231" from anywhere, at any time, once or after it was answered.

**It is shell-owned**, opened through `viewPlan(planId: string | null)` on `CockpitActions` — the same
seam `select(agentId)` already uses for "which drawer is open is cockpit state, not skin state", and
for the same reason: one implementation of the modal across both skins, while each skin keeps its own
drawing of a plan elsewhere (Classic's `PlanPanel` rows, the Goal Floor's assembly machines). A skin must
not reach `api.js` (`test/cockpitSkins.test.ts`), so the seam is the only way a skin-side button can
open a shared modal.

**Two tabs**, because the decision view has to stay short enough to hold in your head:

- **Plan** — the planner's reason in full; **Risks** and **Deliberately out of scope** side by side
  when present; every part in dispatch order with its scope, `rationale` (why its own PR),
  `acceptance` (done when), the stack edge spelled out as a sentence rather than the terse `on <slug>`
  chip, its status, its PR when it has one, and its "Up next" queue state
  (`unapproved` / `capped` / `▶ now`). The same amber cut line the Up-next queue and Plans panel
  already draw.
- **Full write-up** — `plan.document`, rendered. Absent renders "This planner wrote no write-up",
  never a hidden tab (see [08](08-planning.md)).

Approve / Reject appear only while the plan is `awaiting_approval`, and route through the same
`decideProposal` the escalation card uses — one verdict, one implementation, so the "Needs you" card
clears either way whichever surface you decided from. Replan and Discuss sit apart, because they
settle nothing. While a plan is being discussed the modal shows the conversation instead — the
agent's status and last note, and a reply box that posts through `POST /api/agents/:id/respond` — and
offers **End discussion** instead of a verdict.

**Markdown rendering is a new pure `web/src/components/markdown.ts`**: a subset — ATX headings,
unordered and ordered lists, fenced and inline code, blockquotes, paragraphs, and inline `code`,
`**strong**` and `*emphasis*` — returning React nodes, **never `dangerouslySetInnerHTML`**. It does
**not** render links: there is no `linkify` call in it, so a URL in a write-up appears as literal
text. The same precedent as `ansi.ts` being hand-written rather than pulling in a library, and for a
sharper reason here: `document` is agent-authored text, so a renderer that never interprets HTML has
no injection surface to reason about at all.

**Entry points** — the button or chip appears wherever a plan is mentioned:

- the approval card in "Needs you" (`EscalationCard`), when `proposal.kind === 'plan'`;
- each row of the classic `PlanPanel`, and the Goal Floor's blueprint plate for a plan awaiting approval;
- the issue's pickup chip in the **shared** `WorldSummary` — the chip that already reads
  `2/5 parts merged` becomes the button, so both skins get it for free.

The modal is useful **after** approval too, as the record of what was agreed — which is most of why it
is a modal reachable from anywhere rather than a section of the approval card that disappears once
answered.

## Links

The cockpit never builds a provider URL. `refUrls` in the state snapshot is a `ref → URL` map, and
`linkify` / `refLink` (`web/src/components/util.tsx`) look refs up in it. A ref the provider could not
resolve is absent from the map and renders as plain text — which is what the `fake` provider produces.

`refChip(ref, label, refUrls, title?)` is the third of them, for refs whose canonical shape is
machinery a human does not read (`issue:12:comment:456`), where `refLink`'s "the token is the label"
would put a ref string on screen. It renders **nothing at all** unless the provider resolved the ref:
a caption with no link asserts something exists while giving nobody a way to read it, which is the
outcome #171 ruled out. So an unwritten comment, an older server that sends none, and a provider that
builds no URLs are all one silence.

### What the harness has said on a ticket

Two records carry a comment the harness maintains by itself, and both reach the cockpit as canonical
refs (see [15](15-integrations.md#comment-refs)):

| Record      | Wire field               | Where it is drawn                                                                          |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| Plan status | `plan.statusCommentRef`  | `PlanPanel`'s plan head (`status comment ↗`), and the Goal Floor's signal post (`notice ↗`) |
| Goal assay  | `issue.assay.commentRef` | The shared `WorldSummary` issue row (`comment ↗`), beside the two assay overrides           |

The assay's is the sharper case of the two: that comment is the harness explaining, on somebody else's
ticket, why it will not act — so it sits **beside** the overrides and not among them. The two buttons
change the verdict; this only opens what was already said.

## Chips and verdicts

Three per-item verdicts are computed **on the server** and merely rendered here, so the UI can never
disagree with what the dispatcher does:

- **PR health** — `prHealth(pr, allOpenPrs)`, attached per PR. It names an inherited CI failure as
  `CI failing on base PR #n`, which is the only place an operator sees why no agent came for a red
  stacked PR.
- **PR attention** — `prAttentionStatus(pr, ctx)`, attached per PR beside health and rendered by
  `attentionChip`. The chip names the **court** and nothing else — `your turn`, `harness on it`,
  `waiting on others`, `settled`, `stalled` — because scanning a list for "what is mine" is what it
  exists for; the health chip beside it carries the visible detail of _why_, and the full reasons are
  in the `title`. `done` and `ignored` render nothing: the row already draws a "merged" and an
  "ignored" chip, and one home per fact. Only `your turn` and `stalled` warn — the two arms actually
  asking for a person. An older server that ships no verdict renders nothing at all.
- **Issue pickup** — `issuePickupStatus(issue, ctx)`, attached per issue and rendered by `pickupChip`.
  `done` and `has_pr` render nothing, because the state chip and the "→ PR" chip already say it; an
  older server that ships no verdict renders nothing at all. Every other status shows its first reason,
  with the full list in the `title`.

## Demo mode

`npm run web:dev:demo` (and `web:build:demo`) build with `mode: demo`. `web/src/api.ts` then swaps
`api` and `connectWs` for `demoApi` / `connectDemoWs` (`web/src/demo/`), which serve a scripted
fixture world with no server and no real integrations. The top bar shows a `demo` chip. This is what
the GitHub Pages deployment publishes.
