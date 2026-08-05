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
([16](16-http-api.md#get-apiprompts)). The demo build serves an empty book: the web
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
  `QueueItem`, every scanner cell is a check the CI policy classified. There is no progress bar,
  because nothing reports progress — a bay shows elapsed time instead.
- **The rocket means one thing: a goal closing.** `iconForStage('launch')` and
  `iconForEventKind('issue_closed')` are the only two places it appears. It used to be spent on
  `pr_merged` as well, which double-booked it and left the one event that _is_ a launch falling
  through to a flask; `test/factorySkin.test.ts` now asserts that nothing about a pull request wears
  it.
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
it sits are separate edits. Placement is **one CSS grid**: every panel is a direct child of
`.fx-grid`, in the order it reads — the line, then Parts Inspection and Bots in the Field side by
side, then the goal floor, the yard, the shift log and signals. Production is not a panel at all: it
is the **Output** gauge in the status bar, and the graph opens from it.

**Inspection and Bots share a row from 1500px up, half the width each.** The parts on the rack and
the bots that will work them are one reading, and the old arrangement made you join them by eye —
the strip full-width above two rails, Bots partway down the left one. At four tracks each half is
still wider than either panel gets in the two-column arrangement below; below 1500 they stack,
because an inspection row's fixed columns (the scanner ladder, the court chip) squeeze the title to
nothing at half of 940px.

There were **two rails** here — `floor` (the line, bots, the goal floor, the yard) and `world`
(signals, shift log) — split on _whose turn it is_, each scrolling on its own with `.fx` pinned to
`100dvh`. They are gone, and so are their scrollbars. A column that scrolls independently means the
page has no single reading position: what you are looking for can be out of sight inside a box that
itself has not moved, and the panel beside the one you are reading does not travel with it. One grid
scrolls as one page. A third rail went earlier for a different reason — `act`, what _you_ are the
blocker for, whose panels are read as a count far more often than as contents, and a count is a
gauge rather than a column.

There is **one DOM for every width**; the arrangement is chosen in CSS alone:

| width    | arrangement                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| < 940    | one column                                                                                                                                 |
| 940–1499 | two columns; everything but the shift log and signals spans both                                                                           |
| ≥ 1500   | four columns — the line, the goal floor and the yard span all four; Inspection and Bots take two each, and so do the shift log and signals |

**The breakpoints are therefore stated once.** Matching them in React as well — rendering a
different tree per width — buys nothing and costs a resize listener, a re-render on every drag, and
a second definition of the boundary that will disagree with this one the first time either moves.

Four consequences to preserve:

- **Document order is reading order**, so no panel carries an `order`. The `order` values that used
  to restore the reading order when the rails dissolved are gone with them; a panel moved in
  `FactoryRoot` moves on the floor, which is the point. `test/factorySkin.test.ts` pins the sequence
  and pins every panel as a _direct_ child of the grid — a wrapper re-introduced round any of them
  takes it out of the grid and its span rule then does nothing.
- **The goal floor and the yard span the full width, and the goal floor's drawing grows into it.**
  Both are laid out left to right across a goal's whole span, so a half-width column turns the patch
  belt into something you scroll sideways — the reading the panel exists to give at a glance. The
  floor SVG therefore takes its intrinsic width as a custom property and carries
  `width: 100%; min-width: <intrinsic>; max-width: <intrinsic> * 1.8`: it scales up to the panel
  (which is where its height comes from — height follows the viewBox), keeps 1:1 and scrolls when the
  panel is narrower, and stops at 1.8× so a two-machine goal on a 3440px display is not blown up into
  a poster. It is the pattern `.fx-line` already used for the belt.
- **The full-bleed pictures need a container that caps them.** The line and the production graph
  scale with their container; given the whole of a 3440px display, the graph alone became a
  ~500px-tall chart that ate the first screen. Spans are what stop that, which is why widening the
  old centred ribbon without also tiling it made the skin worse rather than better. The graph is no
  longer on the floor at all (below), but the constraint is the line's too.
- **Recovery is outside `.fx-grid` entirely**, above it, because while it is up no pulse runs and
  every other surface is stale for the same reason. It is a banner, so it needs no `grid-column` to
  span — it is a block at every width.

#### The five ways in

Alerts, faults and blueprints stood in the act rail, and each is read as a **number** far more often
than as contents. So the number is a gauge in the status bar and the panel opens from it as a
[`Modal`](#what-the-floor-draws-beyond-the-queue) — `FactoryModal` is one value rather than a boolean
per modal, because a boolean each admits far more states than there are, and two panels in front at
once is not something this floor can draw. The desks themselves are `components/Desks.tsx`
(`StampDesk` / `FaultLog` / `BlueprintDesk` / `FindingsDesk`), each taking `{ view, actions }`
like `StatusBar`: a `ConfirmButton`, a forty-row log and a demo gate are _contents_, and the root's
job is placement. Being components is also the only way `renderToStaticMarkup` can reach a panel
behind a click, which is what keeps them tested.

**Findings is the fourth**, and it was never in that rail — it stood in the floor rail as the
`Off-Blueprint` panel, which drew nothing at all when there was nothing to report, so at zero
there was no reading and at one the rail reflowed. The rename is to the harness's own word for
these (the `findings` table, `report_finding`, `FindingsPanel`), so one subject has one name from
the tool call to the gauge, and it is 35px narrower than `Off-blueprint` was. It does not buy the
single-row bar back, and Output made that worse rather than better: the bar's content is 1878px
now, so it is one row above ~1900px and two below, and the duplicate-removal that fixed this last
time has nothing left to remove. That is the cost of the spark — 213px against a counted gauge's
~122px — and it is paid knowingly: the alternative is a gauge whose face is a number that cannot
say what the panel was for. The threshold landing on the railed breakpoint is a coincidence, not a
rule; nothing keys on it. It belongs with the desks rather than on the floor because the floor
rail is what the _harness_ is doing, and a finding is something nobody is doing: nothing in the
dispatcher reads `findings`, so promote / file / dismiss is the only way one becomes anything.

**Output is the fifth**, and it is the one that was never a count. Production had already been
reduced to a panel at the head of the world rail whose entire content was a tile you clicked to open
the graph — a way in standing in a rail, above two panels an operator actually watches. It is read
the way the desks are read, so it became a gauge the same way; the difference is only what a gauge
of it can say. A rate over a 6h window collapsed to one number is a snapshot again, which is the
thing the graph exists to escape, so the **face is a spark** — `ProductionSpark`, the same plotting
functions the graph uses, at gauge weight — and the value beside it is the output rate alone,
merges an hour. Dispatches per merge is the number that joins the two and it is a sentence rather
than a glyph, so it is the hover and the graph's own note. The spark drops the escalation series:
in a 64-unit box a third colour is a smudge, the bar already speaks for escalations in a gauge of
its own four inches to the right, and what is left — a filled ground of dispatches with a merge line
over it — is exactly the comparison the churn ratio is a number for.

Five rules hold them:

- **A gauge that acts must look like it does.** `Power` is an inert reading, so an `onClick` on a
  plain `.fx-read` is invisible — indistinguishable from a neighbour that does not respond, which is
  exactly how it was first reported. A gauge that does something is `.fx-act`: a real `<button>` with
  a raised face, a hover lift and a pointer. Icons are distinct per gauge (`alert`, `gear`, `chest`,
  `blueprint`, `lamp`) so five adjacent buttons stay legible. **The chevron is the narrower word** —
  it says _there is a panel behind this_ — so all five carry one and `Scan`, which runs a pulse
  rather than opening anything, does not (`.fx-run`). `test/factorySkin.test.ts` counts the ways in
  by chevron for that reason.
- **Only Alerts is ever red**, and that is the skin's existing rule rather than a new one: red means
  an agent is parked on a question only you can answer. A recorded fault blocks nothing (amber), a
  finding is something a bot noticed on its way past rather than something it is stuck on (amber),
  and a queued blueprint is waiting on a slot, not on you (neither).
- **A gauge counts what a click resolves.** Findings counts findings at `open` and nothing
  else: promoted, filed and dismissed are done, `filing` is decided (an agent is creating the
  ticket), and **overlaps are excluded** — an overlap is diagnostic, with no button on it anywhere,
  so a number a click could not move would be the dead `see the fault log at the foot of the floor`
  line in a new place. They still show in the desk, because they answer the same question the
  findings do. The consequence is honest and stated in the design: two agents editing one file is
  the most urgent thing in that drawer and the one thing the face cannot advertise.
- **A zero count mutes a gauge; it never removes it.** Faults is the only way to the fault log, which
  carries the two-step `clear` — a control that must not become unreachable because the log happens
  to be empty — and a gauge that vanished would reflow the bar every time its number left zero.
  `test/factorySkin.test.ts` asserts all four survive a zero, counting the ways in by chevron.
- **The alert bay is deleted, not relocated.** It was a one-line summary sitting above the panel that
  listed the same escalations in full: one reading in two places. `StampDesk` is the whole inbox, and
  answering still happens on the shared `EscalationCard`, which owns the refusal rules.

**Shifts Ended is a sixth panel behind a click, and the one that does _not_ open from the bar.** The
bots whose shift has ended are history, and a list of them under the bots that are out _now_ makes
the panel read as longer than the fleet is — with a tail that never empties, since a finished agent
is kept forever. So the treatment is the desks' and the placement is not: the count is a button in
the **Bots panel's own head** (`.fx-head-act`, beside the pads-free reading) and the cards open in
front of it. Panel-local because the reading is only meaningful against a fleet — "3 shifts ended"
among the bar's gauges says nothing the Bots panel does not say better — and because the bar is
already two rows below ~1900px. The list is **bounded at 24** with the note naming the total, the
shift log's convention.

#### One subject, once — and nothing at all when the link drops

Absorbing the act rail made the bar the busiest surface on the floor, and it was carrying two of
everything. The fleet was a `Bots` reading _and_ the `live/cap` inside the cap control an inch to its
right; the pulse was a `Scan` countdown at one end _and_ a "Run a scan" button at the other. Three
rules now hold it, and each removes a duplicate rather than shrinking a survivor — the bar's wrap
point moved in by ~260px without a reading being lost:

- **The reading and its control are one gauge.** `Bots` _is_ `FleetControl`, wearing the gauge's icon
  and label; the shared component is unchanged, because a skin may not reach `api.js` and embedding it
  is the sanctioned route to a control. Its own `cap` caption is hidden in the skin's CSS — a third
  word for one number.
- **The gauge is the button.** `ScanRead` presses, and the countdown on its face is what says whether
  pressing it is worth anything. It stays pressable while paused or held: that is precisely when an
  operator wants to confirm nothing moves. The radar still stops turning in both.
- **Config is a hover, not a caption.** Which dispatcher is wired cannot change while the harness is
  up, so it is the ident's `title`. `demo` stays on the face — it is the difference between a floor
  and a picture of one.

The **live/offline chip is gone entirely**, and this is the one change that is not only about width.
Every panel on this floor is a reading the harness confirms, and a stale one is drawn in exactly the
chrome of a live one, so a chip in the corner asked an operator to remember to check it before
believing anything else — the same failure `capped` and `unapproved` were added to `QueueItem` to
fix, one level up. So a dropped socket **empties the floor**: the bar is the ident plus a single
`Link · offline` reading, and the rails, the recovery banner, the modals and the drawer are not
rendered at all — one `Off the air` card in their place. Nothing is being polled into a lie, the
harness is unaffected and says so, and the reconnect brings the floor back by itself.
`test/factorySkin.test.ts` asserts both halves: one fleet reading and no second scan button while
connected, and no gauge at all while not.

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
- **Parts Inspection** (`inspection.ts` + `components/Inspection.tsx`) draws every open PR as one
  row, **above both rails**. It replaced two panels — the silo towers and the Launches log — and the
  reason is the analogy: a launch is a _goal closing_ (`iconForStage`), so a PR drawn as a silo topped
  with a rocket claimed the merge was the ending. A merge loads one part into the silo. Six things
  carry it:
  - **It sits above the rails, breaking their whose-turn split on purpose.** A PR is the world object
    an operator is most often the blocker for, so it outranks the split rather than living inside it.
    It needs no breakpoint case: it is one full-width child above a grid that collapses to one column.
  - **Two groups, on `attention.status` alone** (`rack`/`rackGroup`) — `you` and `stalled` are yours,
    everything else is in hand, dimmed and **never collapsed** (a fold puts a click between an
    operator and _is anything stuck_). A merge-ready PR needs no arm of its own: it is already `you`
    through the pending-proposal arm, and under `autoSend` it reads `harness` and correctly drops to
    _in hand_. Inside a group the order is PR number — the old sort was fullest-first, which put the
    PRs you had to decide on below the ones the harness was already fixing.
  - **The ladder is two groups, and the split is an argument about denominators.** The fixed four
    existed because `health.reasons` names only what is wrong — a numerator with no bottom. That holds
    for the three gates a _human_ moves (`mergeGates`: approved, comments, conflicts) and **fails for
    CI**, because `ciVerdict` is an enumerable list of named checks with states. So CI became the
    **scanner group**: one cell per check the policy classified, from the shared `scannersFor`
    (`scanners.ts` — moved out of `goalFloor.ts` so the strip and the Goal Floor's PR machine cannot
    disagree about which check is red). The scanner cells **share one fixed track**, so a big CI matrix
    gives thin cells rather than pushing the three gates out of column.
  - **Five scanner states, and none of them is red.** `damaged` is unlit — failing, a bot is coming;
    `not_ours` is amber — failing and none is, which the old single CI cell could not say and which is
    the whole reason per-check policy exists; `muted` is a dashed outline, `awaiting` blue, passing
    green. Red is left to the court chip and the row stripe, so it keeps meaning _a question only you
    can answer_ on a row with four failing checks. No check **name** is written in the skin; every one
    comes off the verdict.
  - **`attention.status` names the court, read off the server and never re-derived**
    (`prCourt`); `attention.reasons`/`health.reasons` are quoted, never parsed. An empty rack still
    draws — a surface that vanishes when quiet is indistinguishable from one that broke. The merge
    count from `closedPullRequests` is all that survives of the Launches log, in the header.
  - **The Yard gives up its PR list.** `WorldSummary` takes `showPullRequests` (default `true`, so
    Classic — which has no strip — is unchanged, golden included); the factory passes `false`, and the
    flag gates the tab counts and the recently-closed list as well as the rows, or the counts would
    not match what the tab shows. One subject, one place: the argument that dissolved the act rail.
  - **The watch/ignore toggle moves with the PRs.** `showPullRequests={false}` also drops the
    exclude toggle `WorldSummary` renders on every PR row, so once the factory moved its PRs onto the
    rack the toggle had no home — the only way to `-ignore` a PR from the cockpit was to switch to
    Classic. So each open rack row carries it (`onToggleExclude` → `actions.setPrExcluded` →
    `POST /api/prs/:n/exclude`, the same label write Classic makes): `ignore` when untagged, `watch`
    to lift it, read off `pr.labels.includes(ignoreLabel)`. With **no `ignoreLabel` configured** the
    gate is off, so the button renders **disabled rather than absent** — the control keeps its place
    on the row and the reason is one hover away, the same rule the empty rack is drawn for. A merged
    PR has none: there is nothing to leave alone.
- **Production** (`production.ts`) is the only panel that reads against time, which is the only way
  to answer whether the floor is producing rather than merely busy. Rates come from the timestamps
  already on `decisions` and `worldEvents`; a held or skipped dispatch is not counted, because it
  produced no work. The churn ratio (dispatches per merge) is the point of the panel. When the
  decision log does not reach back to the window's start the panel **says so**: a rate that silently
  under-reports is worse than no rate. It is the one panel an operator _consults_ rather than
  watches, and it is **not on the floor**: it draws at two sizes off one set of plotting functions —
  the **spark** on the status bar's Output gauge (two series, gauge weight; see
  [the five ways in](#the-five-ways-in)) and the **full graph** — axes, deltas, spend, the
  truncation caveat — behind the click, in the skin's `Modal`. Two components drawing the same
  series independently would be two things to keep in step for no gain; the only difference between
  them is the rectangle they plot into, how heavy the strokes are in it, and whether the axes are
  labelled. `FactoryRoot` derives the reading once and hands it to both, so the gauge and the graph
  cannot disagree. The modal is an `.fx-card` with a backdrop rather than
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

Two of the three desks carry a rule of their own:

- **`BlueprintDesk`** is the `LaunchPanel`, and on this skin the `InjectPanel` hangs off
  **`view.demo`** — the static Pages build — rather than off `config.injectable`. Injection fakes a
  world change, which is only ever something the demo needs: a real run against a fake provider is
  still a real run, and a panel that lies to the harness there is a way to lie to yourself about what
  it is reacting to. The empty-floor line reads from the same predicate, so it never offers an
  injection there is no panel for. Classic keeps `config.injectable`.
- **`FaultLog`** offers a two-step **clear** whenever it has any, posting `POST /api/errors/clear`.
  Two-step because the rows go: nothing in the harness reads the fault log back, so a clear costs
  nothing anything decides on — but it costs the only copy, and for every cockpit rather than this
  one. It sits _above_ the log rather than in the modal head beside `Close`: one misclick between
  "leave" and "delete the only copy" is too few. The log draws forty rows, not the eight a rail had
  room for — eight was a crop for a column, and this is the surface you went looking for.

#### The Goal Floor

`TheLine` draws the **dispatcher** — bays, belt, headroom gate, subject: agents. The Goal Floor draws
the **work**: one ticket's whole production line, in the order
[`docs/workflow.md`](../workflow.md) describes it. Ticket → is there enough here to act on → plan →
do the work → checks → merge → is the goal achieved → report → update the ticket → done. Every node
below corresponds to a stage of that document, which is what the floor is checked against.

| Factory              | Harness                                            |
| -------------------- | -------------------------------------------------- |
| Ore patch            | A ticket, and the strip that picks which floor     |
| Assay drill          | The goal assay, rule `issue-assay`                 |
| Furnace              | The planner, rule `issue-plan`                     |
| Splitter / merger    | Where the plan's edge list branches and rejoins    |
| Assembly machine     | A plan part, carrying the pull request it produced |
| Scanners on the belt | CI checks, classified — plus human review          |
| Silo                 | The goal, filling with settled parts               |
| Satellite            | The assessment, rule `issue-assess`                |
| Manifest             | Report what was done — `issue.conclusion.note`     |
| Signal post          | Update the ticket — state and status comment       |
| Launch               | `delivered`, or a launch that failed verification  |

Seven properties, and they are what to preserve:

- **The strip is the goals we have a claim staked to.** Issues are opt-in
  ([06](06-issue-pickup.md)), so an untagged ticket has no production line and is drawn none:
  `floorGoals(issues, {watchLabel, ignoreLabel})` keeps what `watchBucket` — the World panel's own
  predicate, not a second reading of the same labels — calls `watched`. Two exceptions, and each is a
  way the panel could otherwise go confidently blank. An **empty watch label** filters nothing
  (`labelPrefix: ''` is the act-on-everything escape hatch, and issues default opt-out, so filtering
  there would hide every goal on exactly the deployments that turned the gate off). And **anything in
  flight is drawn whatever its tags say** (`inProduction`: `active` / `has_pr` / `planning` /
  `delivered`) — a tag pulled mid-flight must not make a live plan, an open pull request or a running
  agent invisible, which covers `ignored` as much as `unwatched`, because the reason is the visibility
  of live work and not the tag's polarity. Order is **claimed first, then ascending issue number**: the
  strip is a place positions are learned, so it is sorted on the two things that barely move rather
  than on status or activity, which would shuffle it under an operator exactly while something is
  going wrong. `inProduction` lives beside the filter because it is also the default pick's heuristic
  — a floor with nothing moving on it is the least useful thing to land on — and nothing staked at all
  gets its **own** empty line, since "nothing is tagged" and "the provider returned no goals" are
  different facts and only one of them has an action.
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

**A run is kept until the operator dismisses it (#203, #234).** The floor is otherwise built from the
live world, so a goal — and the Manifest's way in to its retrospective — dropped off the moment the
tracker stopped returning the issue (closed by hand) or its watch tag came off. So the harness's run
at a goal is recorded server-side while the issue is still live (`issue_runs`, keyed on the issue
origin), and the row keeps the issue's title, body, labels, linked PR and workflow state as they last
stood, because a retained run is **dispatched from** and not merely drawn.

**Minted at pickup, not at completion (#234).** #203 recorded a _completion_, which is a row that is
never written for a goal nobody finished — so an abandoned goal, or one whose ticket was closed
mid-flight, disappeared with no card to dismiss. A run is minted the first pulse the harness has work
under the goal (`hasPriorWork`, the same predicate `issue-assess` uses to tell "nothing has started"
from "something finished"), and the completion instant is stamped later, when the signals say the goal
is reached. "Complete" (`isGoalComplete`, `src/floor/runs.ts`, recorded each pulse in `harness.ts`)
folds two kinds of input, and the rule between them is **evidence adds; a standing verdict
subtracts**:

- **Evidence** — a write-up exists, or a `delivered` verdict was ever reached. Each says the goal was
  reached at least once, and they are why the conclusion alone is not enough: a finished goal nobody
  declared resolves to `undeclared`. The delivery is read as _presence_, not as still standing.
- **The standing verdict**, from [`resolveIssueConclusion`](06-issue-pickup.md#concluding-an-issue) —
  `done` completes, and **`more_work` outranks every piece of evidence above**, because the operator,
  the assessor, the working agent or a plan being re-drawn is saying _now_ that work remains.

The conclusion and the plan are asked through that resolver rather than read as two more raw signals,
and reading them raw was a defect with two faces: an operator's `more_work` toggle was argued with by
a `complete` plan — the exact contradiction the resolver's first arm exists to forbid — and a standing
shortfall was not consulted at all, so an assessor's "nothing was delivered" lost to the stale `done`
of the agent it was assessing.

**The gate is on stamping a completion, never on keeping a run.** Retention stays one-way: nothing
deletes a row, `recordIssueRun` never clears a completion instant or resurrects a dismissal, and a
genuinely finished goal resolves to `done` or `undeclared` — never `more_work` — so it cannot fall off
the floor on its own. What no longer happens is the harness recording a goal as finished on the same
pulse its own scheduler is putting agents on it. The snapshot then does two things: it stamps every
issue the harness has a run at with a `run` field (`startedAt`, `completedAt`, `outcome`,
`dismissed`), and it rebuilds the runs the world has forgotten into a separate `retainedRuns` list —
through `retainedRunIssues`, the _same_ function the dispatcher unions into its issue list, and then
the _same_ `enrichIssue` path a live issue takes, so the card the operator sees and the subject the
harness acts on are one thing. The floor merges that list in, the world's copy winning for a goal
still present, so the Yard and world panels stay a view of the live world. `floorGoals` gains a third
way onto the strip beside claimed and in-flight: a **retained run**, drawn until dismissed. The order
of its checks is load-bearing — in-flight is tested first, so a dismissed goal that re-enters
production is drawn as live work.

**Dismissal is the terminal act, and since #234 it is a gate as well as the card** (`POST
/api/issues/:n/dismiss-run` → `Store.dismissIssueRun`). This reverses #203's stated invariant that
dismissal is _never_ a gate, deliberately and for the reason the retention exists at all: a run that
outlives the ticket has to be endable, or the dispatcher would keep asking about a goal the operator
has finished with. Two routes reach it and the row decides which — a run the harness had judged ends
`judged`, one it had not ends `abandoned` — so the outcome is never claimed beyond the evidence.
Operator-only, one-way, and it persists across a restart: a dismissed run is not unioned back into the
issue list, so nothing further is scheduled for a goal whose ticket the tracker has stopped returning.
While the ticket _is_ still returned it is the tracker's own answer that puts the goal in the world, so
dismissal ends the retention rather than parking a live issue — the operator's `-ignore` tag is what
says "leave this one alone", and a dismissal that could silently park an open ticket would make a
mis-click far more expensive than the card it was aimed at. An accidental dismissal is undone by the
goal being worked again, not by an un-dismiss. The report itself is untouched — the row is the run,
not the write-up, which `GET /api/retrospectives/:ref` still serves. The Dismiss control hangs off the
run **existing and not yet ended** (`retainedRun`), never off the floor's state — the lesson `planId`
and `retroRef` learned.

**The tail reads the goal check's verdict, and nothing else (#234).** The Manifest, the Signal post
and the Launch sit on the satellite's yes arm; they used to be drawn off `delivery !== null ||
pickupStatus === 'delivered' || pickupStatus === 'done'`, and `done` is _any closed issue_ — so three
stations drew as built, under a green **Delivered · Away**, with the goal check beneath them reading
**Not yet built**. They now read the delivery row the satellite reads. Where there is no verdict they
are drawn `presence: 'unbuilt'` — the vocabulary the furnace already uses — rather than cut from the
route: an omitted station says "not reached" in a shape indistinguishable from the floor simply ending
there, which is how the contradiction went unnoticed. The Launch therefore has **three** readings, not
two: `away`, `returned`, and `unbuilt`. A shortfall still returns before the Manifest, which is the
one arm that draws nothing.

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
an unplanned issue has no plan row, so nothing _could_ have written one, and that third reading gets
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

The picker itself lives inside the **settings modal** below; what each skin embeds is the cog that
opens it. That inherits the picker's own rule rather than weakening it — the cog is now the way _to_
the picker, so a skin failing to draw one is still a skin you could not leave.

### Settings

A cog in each skin's chrome opens a shared modal carrying two things: the skin picker above, and the
configuration this process is actually running on.

The arrangement is `PlanModal`'s exactly. The modal reads `GET /api/config`, which a skin may not do,
so it hangs off the shell in `App.tsx` and the skin-side cog only flips `settingsOpen` through
`CockpitActions.openSettings` — the same seam `viewPlan` uses, for the same reason.

The config half is **read-only and fetched on open**, both for the prompt book's reasons
([16](16-http-api.md)): `loadConfig` runs once at boot so polling would be paying for a constant, and
a write route's honest answer to "when does this take effect" is "at the next restart". Values are
grouped, and each one that differs from the built-in default is marked — the question an operator
opens this to ask is not "what are the values" but "what did I change", and answering it needs a
baseline, which is why the server computes the comparison rather than shipping the object alone.

Two values would make that block a lie, and are drawn separately above it: `maxConcurrentAgents` and
`startPaused` are both shadowed at runtime by `RuntimeControl` ([09](09-execution.md)) and revert on
restart. The modal shows the live cap and pause state from `control`, naming the configured value it
is overriding where the two differ. Both halves of that pair are read out of the same fetched block,
so they can never come from two readings that disagree.

Nothing is redacted, and that is not an oversight: `Config` holds no secrets by construction
([02](02-configuration.md)), which is the same rule that keeps `GITHUB_TOKEN`, `AZURE_DEVOPS_PAT` and
`LUBBDUBB_TOKEN` in the environment. `auth.tokenFile` is a path worth reading, and blanking it would
hide a useful value while implying the invariant is not real.

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

`test/demoBackend.test.ts` covers the other thing driven off a declared table: that the demo backend
has heard of every route the server declares. See [below](#what-the-demo-owes-the-server).

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
  piece of work the previous run orphaned, with **Restore** / **Requeue** / **Remove**, each keyed on the
  task id (an orphan may never have had an agent). A banner rather than a
  panel because while it is up the harness runs **no cycles at all**, so every other surface on the page
  is stale for the same one reason — and the heartbeat countdown in the top bar reads `pulse held`
  instead of counting down to a pulse that will not fire. Restore is replaced by the reason it cannot be
  offered (`restoreBlocked`) rather than hidden. Each card shows how the run ended (crashed, shut down,
  or `never started` — a task recorded before a restart caught it, which no agent ever ran), the agent's
  last progress note, and the question it was parked on if it was parked on one. A `never started` card
  says outright that no work was done and that the item is what is holding its origin and branch shut,
  since that is the fact behind an otherwise unexplained idle fleet.
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
  toggle; issues with their state, linked PR, pickup chip, **plan chip**, conclusion chip and
  **shortfall** chip, a watch toggle, the conclusion toggles and the **assay override**; and a
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
  (ignore wins, then watch, else the type default: PRs opt-out, issues opt-in) and each
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
  shows. The **plan chip is exempt** and draws on every tab: it states no pickup verdict, and a plan
  on an issue somebody has since tagged leave-alone is exactly the record worth reading.
  **"Recently closed" lives in the Watched tab alone**, since it exists so a PR you were
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
  re-orders only: a held row keeps its held status wherever it lands, and `manual-job` items stay first. New
  work the harness surfaces later slots in behind the arranged order until you re-arrange.
- **Decision log** (`DecisionLog`) — the last 100 decisions with outcome, detail and, where present,
  the rule that fired, expandable into that rule's standing rationale.
- **Activity** (`ActivityFeed`) — the last 100 world events.
- **Errors** (`ErrorsPanel`) — the last 100 recorded failures, with the count marked urgent when
  non-zero.

## The stack panel

Chains of stacked pull requests, from `/api/state`'s `stacks` (see
[07](07-pull-requests.md) for the fold). Drawn in both skins, differently on purpose:

- **Classic** — `web/src/components/StackPanel.tsx`, one card per stack, styled through tokens only,
  so the treatment follows whichever skin is active.
- **Factory** — on **the rack** (`Inspection.tsx`), not on the line. A stack is a fact about _pull
  requests_, and the rack is where pull requests are read; a belt would have said it was a fact about
  scheduling, which is the confusion the plan panel already risks by drawing parts as a stack.

Rungs are listed **top-first**, with the one that merges next at the bottom — `Stack.rungs` is
bottom-first, which is the order the dispatcher and the reconciler think in, so the reversal happens
in the view and nowhere else. Each rung names its base, so the chain is legible without the reader
holding branch names in their head.

The health chip is the one the PR list already shows rather than a new one: a rung _is_ a pull
request, and an operator reading it in two places must not get two accounts of it. A rung with no
matching open PR draws no health at all rather than asserting health the snapshot does not carry.

A stack is drawn whether or not a plan produced it — `from plan` versus `observed` — which is the
whole point of the model being derived from pull requests rather than from `plan_parts`.

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
- each row of the classic `PlanPanel`, and the Goal Floor's own plan bar;
- a **`plan · <status>`** chip on the issue's row in the **shared** `WorldSummary`, so both skins get
  it for free.

The modal is useful **after** approval too, as the record of what was agreed — which is most of why it
is a modal reachable from anywhere rather than a section of the approval card that disappears once
answered. **Every entry point is therefore keyed on the plan existing, and none on what it is doing.**
That is a correction, not a restatement: two of the three were keyed on a transient condition, and
between them they left the modal reachable only during the approval window.

- The Goal Floor's controls rode on the **Blueprint plate**, and a plate is a stopped machine's
  reason — that one draws only while a decomposition is `awaiting_approval`. So the click that
  approved a plan was also the click that took away the only way to read it back. They now hang off
  `GoalFloorModel.planId`, which was declared for exactly this and never wired, and `FloorPlate` no
  longer carries a `planId` at all — one way in, rather than a second answer about when it may be
  offered. The plate keeps quoting the planner; only the buttons moved.
- `WorldSummary` made the **pickup chip itself** the button. `pickupChip` returns null for `done` and
  `has_pr` — precisely where an issue sits once its parts have pull requests — and the whole chip is
  hidden off the watched tab, so the plan became unreadable at the point it started being worked. A
  plan's existence is not a pickup verdict, so the chip is now its own, is neither gated on one nor
  drawn out of one, and names the plan's status because that is the one fact deciding whether opening
  it is a decision or a reading.

`test/factorySkin.test.ts` asserts the floor's way in across **every** plan status rather than only
the one that was broken, so a later attempt to hang it off a plate fails a test.

## The notepad modal

`ScratchpadModal` (`web/src/components/`) is a goal's shared scratchpad, on demand: every note every
agent working it left, oldest first, attributed to the origin that wrote it. It is the testimony the
retrospective is written _from_ — and until it existed, the write-up was the only account of a run
that anybody outside the fleet could read. The pad was written by agents (`scratch_append`), read by
agents (`scratch_read`), and quoted by one retrospective agent, so a claim in the write-up was
checkable against nothing, and an operator watching a goal go wrong could not read the reasoning as it
was written.

**Shell-owned**, opened through `viewScratchpad(issueRef: string | null)` on `CockpitActions` — the
plan and retrospective modals' seam, and for their reason: one implementation across both skins, and a
skin may not reach `api.js` to open it another way. The trail is fetched on open
(`GET /api/scratchpads/:ref`); the snapshot carries only the count and the age.

**Three states, and the third is the point**: loading, the trail, and an **error** — a fetch that
failed must not render as "nobody wrote anything". That matters more here than for the write-up,
because an empty pad is unreachable by construction: nothing draws a way in unless the snapshot says
there are entries, so an empty trail on screen means the fetch and the snapshot disagree.

**Notes render as plain text with their newlines kept**, not as markdown — the opposite choice to the
plan and retrospective documents, which are written to be read as documents. A pad note is one agent's
testimony, and rendering it would let a stray backtick or hash change what that testimony looks like.

**Entry points**, both keyed on the pad **having entries** and neither on what the goal is doing —
`planId`/`retroRef`'s lesson, applied rather than relearned:

- a **`notepad · <n>`** chip on the issue's row in the **shared** `WorldSummary`, so both skins get it;
- a **Notepad** button in the Goal Floor's readings cluster, before Retrospective, because the pad is
  what the write-up was made from — the raw testimony first, the account of it second.

The floor draws it off `GoalFloorModel.padRef`, beside `retroRef` and on the same terms. It appears on
goals with no retrospective at all, which is the case it exists for: a run still going, or one nobody
ever wrote up.

**The floor's two readings are a pair of ordinary buttons pinned to the top right**, not a full-width
plate each. A plate carries something with a sentence to say — a stopped machine's reason, or a plan
that can also be sent back — while these only open a document, so a bar apiece spent a band of the
panel to hold one button and read as though each were making a claim. They sit above the patch strip
rather than in the card's own head, which belongs to the panel and not to whichever goal is picked.
The Blueprint bar keeps its plate: Replan is an act, not a reading.

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

**Every reference the UI shows is routed through one of the three (#199).** The rule is uniform: a
PR/issue number links as `refLink('#'+n, refUrls)`, a colon-form origin/structured ref as
`refLink(ref, refUrls)`, free text carrying `#n` mentions through `linkify(text, refUrls)`. So the
decision log, the activity feed (`ActivityFeed`) and its factory twin (`Signals`), the findings
panel, escalations, the plan panel/modal, the PR and issue rows, the up-next queue, the fleet cards
(origin ref and branch), the overlap and recovery panels, and the work-tree panel all draw links
wherever the provider can resolve them.

For those link sites to actually resolve, three ref families the item lists do not cover are keyed on
their own in `buildRefUrls` (see [16](16-http-api.md#refurls)): **world-event refs** (`pr:42`,
`issue:13` — the structured ref each activity entry draws), **task origin refs** (`pr:142:ci`,
`issue:13:part:x` — what the fleet/overlap/recovery cards link), and, on the `/api/work` routes, the
**work roots and stacked base refs**. A `job:<id>` origin, or anything the provider can't map, is
simply omitted and renders plain.

Two surfaces are deliberately left as plain text, because their medium cannot host a practical link
rather than for want of a URL: the factory **Line**'s belt crates (a continuously-moving target) and
its SVG bay HUD, and the Goal Floor's **patch-tab strip** (each tab is a `<button>` that selects the
goal, and an `<a>` nested in a button is invalid interactive content). Every ref they show is linked
elsewhere — the shared `WorldSummary`/`WorkTree` panels, the fleet cards, and the classic skin — so
nothing is unreachable; this mirrors the Goal Floor's own SVG `<text>` meta lines, which stay plain
while only the compact PR chip is `foreignObject`-wrapped.

### What the harness has said on a ticket

Two records carry a comment the harness maintains by itself, and both reach the cockpit as canonical
refs (see [15](15-integrations.md#comment-refs)):

| Record      | Wire field               | Where it is drawn                                                                             |
| ----------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| Plan status | `plan.statusCommentRef`  | `PlanPanel`'s plan head (`status comment ↗`), and the Goal Floor's signal post (`notice ↗`) |
| Goal assay  | `issue.assay.commentRef` | The shared `WorldSummary` issue row (`comment ↗`), beside the two assay overrides            |

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

`demoBackend` is kept side-effect-free at module scope, so the `VITE_DEMO` branch in `api.ts` being
statically false in the real build lets Rollup drop the whole thing. Good for the bundle, and it is
also why the parity below has to be asserted: the module is invisible in every normal build, so
nothing about day-to-day work surfaces drift in it.

### What the demo owes the server

**Every route `src/server/app.ts` declares has an entry in `web/src/demo/routes.ts`.** That table maps
`METHOD path` — the path exactly as `app.ts` writes it, params and all — against either the `demoApi`
method that answers it or `{absent: reason}`. It is the correspondence itself: `demoBackend`
dispatches by method name rather than by URL, so before the table nothing anywhere held which route a
demo method stood for.

**Coverage is what is owed; fidelity is not.** The demo has no tracker, no worktrees and no
`loadConfig`, and a route it answers with a constant is the honest arm — the prompt book and the
running config both answer empty and say so rather than shipping a copy free to drift, and
`fileWorkItem` refuses exactly as the real route does when the issues provider is `fake`. A route the
demo cannot reach at all is a legitimate entry too, declared `absent` with the reason: `/api/health`
is a supervisor's probe, `/artifacts/:id` is a browser navigation the demo world mints no URLs for,
and `POST /api/issues/:number/{delivered,shortfall}` are reached by hand rather than by any cockpit
control. **What must not be possible is a route the demo has never heard of** — that is the shape
that survives `npm run check` and breaks after deploy.

`test/demoBackend.test.ts` holds the table against the real one in both directions: no route without
an entry, no entry naming a route that is gone, every named method callable, every `demoApi` method
answering something, and no `absent` without a reason written out. The route table is read out of
`app.ts`'s source by `declaredRoutes()` in `test/support/routeTable.ts`, shared with
`test/cockpitAuth.test.ts` so the two walks cannot drift into matching different sets of routes.
