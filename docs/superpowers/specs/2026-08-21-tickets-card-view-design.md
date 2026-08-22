# Tickets card view — design

**Date:** 2026-08-21
**Owner spec once built:** [`docs/spec/17-cockpit.md`](../../spec/17-cockpit.md)

A second view on the Tickets tab: a board of columns, one per tracker state, with cards that can be
dragged between them to write the state back to the tracker. The table stays exactly as it is.

## Why

The Tickets tab is the tab where triage happens, and it draws a list. A list answers "what is there"
well and "what is where" badly: the tracker's own state is one column among seven, so the shape of the
work — how much is waiting, how much is in review, how much is stuck — is something an operator
reconstructs by reading. A board draws it.

The second half is the write. Nothing in the cockpit can move a work item's state today, though
`ActionSink.setWorkItemState` has existed since the harness's own state rules needed it. An operator
who wants a ticket parked in review leaves the cockpit to do it.

## Scope

In:

- A card view on the Tickets tab, toggled against the existing table.
- Columns from the tracker's own state words, ordered by a new config key.
- Per-column vertical scrolling; the board scrolls sideways.
- Drag a card to another column to write that state to the tracker.
- Watch and unwatch from a card.

Out, deliberately:

- Changing state from the **table** view. The operator asked for the board first.
- Reordering cards inside a column. There is no priority field to write, and the order within a
  column is whatever `order` says it is.
- Swimlanes — a row of columns per feature. Rejected in design: twelve features is twelve stacked
  boards and twelve fetches per column, and it breaks the single meaning of "each column scrolls on
  its own".
- Dragging a card onto a feature to reparent it.

## 1. The two views and the toggle

`Place` gains `ticketView: 'table' | 'card'`, default `'table'`, written to the query string as
`?ticketView=card`. It is a `Place` field and not a `useState` in `useCockpit`, for the reason
[17-cockpit](../../spec/17-cockpit.md#the-address-bar) states: a surface held outside the address bar
works until the back button steps over it or a reload drops it, and both are silent.

The control is a fourth `Segment` in the existing `tickets-filters` rail, labelled **Table** and
**Cards**.

The board lives in a new component file, `web/src/components/TicketsBoard.tsx`, with the card in
`web/src/components/TicketCard.tsx`. `TicketsPanel.tsx` is already 920 lines and owns the filter rail,
the intake call-out and the table; the board is a peer of the table rather than more of it. The panel
keeps the rail and the fetch-shaping, and renders one or the other below it.

**A tracker with no native states gets a disabled toggle, not a missing one.** GitHub reports
`workItemState: null` on every row, so `TicketsPayload.states` comes back empty and there are no
columns to draw. The toggle is rendered `disabled` with a title saying why. A control that silently
vanishes on some deployments is one nobody can ask a question about.

## 2. Where the columns come from

New config key:

```
issueBoardStates: string[]     // default []
```

Registered in `src/configFields.ts` as `type: 'stringList'`, `access: 'plain'`, sitting beside
`issueStateColours`, and listed in the **Integrations** group in `src/server/runningConfig.ts`. Its
arm in `src/configApply.ts` assigns onto the running config and does nothing else — the state snapshot
reads the running config by reference at every poll, and no dispatcher rule reads this key, so there
is no consumer to re-seat and no second copy to disagree with. This is `issueStateColours`' arm,
for `issueStateColours`' reason.

Shipped to the cockpit on `CockpitConfig` as `boardStates: string[]`.

The column list is a pure function, `boardColumns(boardStates, facets)` in a new
`web/src/ticketBoard.ts`. Three behaviours, each of which is a silent failure if it goes the other
way:

- **Empty falls back to facet order.** With no config the board draws every state the mirror carries,
  count descending — the order `TicketsPayload.states` already arrives in. A fresh deployment gets a
  working board with nothing configured.
- **A configured state with no items still draws its column, empty.** Naming a column is the operator
  saying they expect work to arrive there. Dropping it would hide a state that is merely quiet today,
  and the board would silently differ from the config the operator is reading.
- **A state the mirror carries that the list omits draws no column — and the board says so.** A foot
  line under the columns names each omitted state and its count: `Removed · 7 items, no column`. Work
  vanishing off a board because a config list is short is exactly the quiet loss this codebase
  refuses; the line is what makes a typo in the key visible instead of invisible.

Column order is the config list's order. Fallback order is the facets' own.

## 3. Loading

**One `/api/tickets` request per drawn column.** Each carries `state=<that column's state>` and the
rail's `watch`, `tracking`, `feature` and `order` unchanged, and keeps its own cursor. There is no
route change and no new endpoint: `buildTicketPage` already filters `state` as an exact match on
`workItemState`, which is the column's definition. Five columns is five requests against the route's
120-per-minute limit, and a scroll spends one more per column.

The alternative — bucketing one paged list client-side — was rejected because a column's contents
would then depend on how far a reader had scrolled a list that is not on screen, and "load more" would
be global rather than per column, which is the opposite of what was asked for.

Each column is its own scroll box with a sticky header, and gets its own `IntersectionObserver` rooted
on **that box** rather than on `.cn-sit` as the table's is. The board itself scrolls horizontally, so a
column running off the right edge hides nothing in the others.

**Header counts come from the column's own response.** `total` on a column's page is the count matching
that column's filters; the facet count is the whole-mirror figure and is used only before the first
page lands. A header reads `12 of 218` and both numbers are about the same set.

**Three empty states per column, because they are three different facts:**

| Why the column is empty                | What it says                                                      |
| -------------------------------------- | ----------------------------------------------------------------- |
| Nothing is in this state at all        | `Nothing is in this state.`                                       |
| Nothing under the current **Tracking** | The `tickets-widened` wording, with the one-click widen to `Any`. |
| Nothing under **Watch** or **Feature** | Names the narrowing that emptied it.                              |

A column that simply stops reads as one that failed to load — the table's `footWords` exists for that
reason, and each column gets the same treatment.

## 4. The card

The card carries the readings on a header line, the title, a meta line, and **a reason lane that is
always drawn**. The lane is the board's whole advantage over the table: it answers "why is nothing on
this?" for every card on screen without a click on any of them.

```
┌──────────────────────────────────┐
│▎ #398  BUG  ◆  ●            ↗   │   stripe · number · type · lamp · watch · ref
│  Worktree slot handed to a       │   title (opens the goal)
│  second branch keeps dist/       │
│  $0.88 · 1d · ▪ Worktrees        │   cost · age · feature
│  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈  │
│  held at intake — the assay is   │   the reason lane
│  unclear                         │
└──────────────────────────────────┘
```

- **The left stripe is the feature's colour slot** (`f{slot}`), never a colour on the wire — the
  palette belongs to the theme, exactly as it does for the table's `tickets-stripe`.
- **The title is a button** calling `actions.selectGoal('issue:N')` — the same one way into a goal that
  every other surface uses. The `<Ref to={'issue:N'}/>` sits **outside** it in a `cn-refs` group,
  because one click cannot have two destinations.
- **The intake lamp** is drawn when `issue.assay?.verdict === 'unclear'`, the table's reading.
- **A frozen card keeps the dashed border** the table's frozen row has. Closed is a fact about the
  item, not a shade of its state.

### The reason lane

A new pure function in `web/src/ticketBoard.ts`:

```ts
cardReason(row: TicketRow, issue: Issue | null, watchLabel: string): { tone: string; words: string }
```

Precedence, first match wins:

1. **Held at intake** — `assay.verdict === 'unclear'` and the item is watched.
2. **The outcome word** — `row.outcome`, when the harness has reached one.
3. **The dispatcher's first reason** — `issue.pickup.reasons[0]`.
4. **Frozen** — the tracking reading, with the last-change age.
5. **Unwatched** — nobody has opted this in.

Every one of those is the server's own sentence, quoted and never re-derived — the tab's existing rule,
and the reason the function is pure: the invariant is about _which of five readings wins_, which no
render can show. It is unit-tested for `cascadeNote`'s and `watchReading`'s reason.

### The watch dot is the control

The table's Watch/Unwatch pair does not fit a card, and the reason lane has the space it would take. So
the dot both reports and writes: filled green for watched, hollow for unwatched, and a click toggles it
through the same `actions.setIssueWatched` the table calls, with `cascadeNote`'s phrase in the title so
a click that writes eight tags says eight.

The dot is a `<button>`; the **drag handle is the card body**, so a drag beginning on the dot does not
move the card and a drag across the board cannot fire it.

It is disabled, with the reason in its title, in the three cases `WatchSwitch` already refuses: no
`watchLabel` configured, a frozen row, and a row the world no longer holds.

## 5. Dragging, and the write

### The route

```
POST /api/issues/:number/state     body: { state: string }
```

In `src/server/routes/issues.ts` — the module that owns the issue group — wrapped in
`checked({ params: IssueNumberParams, body: StateBody }, …)`. A refusal is a returned value and a 400,
never a throw.

**It does not validate the state word against anything.** The provider is the authority on its own
process template: a check against the mirror's known states would refuse a legitimately configured but
still-empty column, and a check against nothing at all is what lets the provider's own refusal reach
the operator intact. An unsupported transition comes back as the provider's sentence, quoted.

Refused, each with its own message, before any write is attempted:

- The connector is not `isWorkItemStateCapable` — no provider call exists.
- The provider rejects the transition — its message is returned verbatim.

### After a successful write

Exactly what the watch route does, for the reasons that route already documents:

1. `store.patchWorldState(...)` — fold the new state onto the baseline. `/api/state` serves the
   baseline, so a broadcast ahead of the write only makes the cockpit redraw the old state.
2. `store.patchTicketState(...)` — patch the mirror. The tab's list is built from `tracker_items` and
   never from the baseline, and the sweep that would otherwise carry it runs last in a cycle that
   coalesces away to nothing while another is in flight.
3. `hub.broadcast({ type: 'world:changed' })`.
4. `await harness.runCycle('manual')`.

Both patch methods are new siblings of the label ones, in the modules that own those tables:
`patchWorldState` in `src/store/world.ts`, `patchTicketState` in `src/store/tickets.ts`, with `Store`
delegating under the same names. No new column and no migration: both tables already carry the state.

Every caught failure goes through `errors.record`. No swallowed catches.

`CockpitActions` gains `setIssueState(number, state)` beside `setIssueWatched`, and `web/src/api.ts`
the call behind it.

### What the board says while you drag

**Every column header speaks, from the moment a card is lifted.** Each header gains a line saying what
dropping there would do, so the whole board's consequences are readable before a choice is made rather
than after it. This is the tab's existing habit — `stateWhy` and `cascadeNote` both say what a click
costs before the click.

A pure function:

```ts
dropWarning(
  column: TicketStateFacet,
  from: string,
  rules: { inProgress: string | null; inReview: string | null; returnsTo: string | null } | null,
): { tone: 'none' | 'ok' | 'warn' | 'stop'; words: string }
```

It **composes clauses rather than enumerating cases**, because the facts are independent and an
enumeration would have to pick one to report. The column the card is already in short-circuits to
`none` / `where it is now`; otherwise:

| Clause                                   | When                                | Tone       | Words                                                                                          |
| ---------------------------------------- | ----------------------------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| pickup — always exactly one of these two | `column.pickup`                     | `ok`       | `a pickup state — the fleet can work this`                                                     |
|                                          | not `column.pickup`                 | `stop`     | `leaves the pickup states — the fleet stops picking this up`                                   |
| the in-progress state                    | `column.state === rules.inProgress` | keeps `ok` | `· a rule moves items here itself once an agent starts`                                        |
| the review state                         | `column.state === rules.inReview`   | `warn`     | `· work-item-back-to-pickup returns it to "<returnsTo>" if a verdict says work is outstanding` |
| nothing live under it                    | `column.live === 0`                 | `warn`     | `· nothing under this state is still in the tracker's open set`                                |

Three things that pin the wording to what the dispatcher actually does, each of which I had wrong on a
first pass:

- **The in-progress state is a pickup state**, even when `issuePickupStates` does not name it —
  `effectivePickupStates` folds it in, and `src/config.ts` says it should _not_ be listed. So a drop
  onto `"Doing"` must not read as leaving the gate. See the route fix below.
- **`workItemBackToPickup` fires only on an explicit `more_work` verdict**, never on the mere absence
  of a PR — that was deliberately changed, because a merged PR used to bounce its ticket back to
  `"Ready"` and put a fresh agent on work already on the default branch. So "a rule may move this
  back" is too strong: the warning names the condition.
- **A state with no live items does not mean dropping there closes the item.** Whether a state maps to
  closed is the tracker's workflow, which the harness has no reading of. The clause states the fact
  `stateWhy` already states and claims nothing further.

`CockpitConfig` gains the rules' own words, since nothing else on the wire carries them:

```ts
stateRules: { inProgress: string | null; inReview: string | null; returnsTo: string | null } | null
```

`returnsTo` is `issuePickupStates[0]` — the same "start here" `workItemBackToPickup` derives, quoted
rather than re-derived. The whole object is null when `issuePickupStates` is unset, because all three
rules are switched out entirely by the registry's `workItemStates` condition in that case — so a null
here is the same fact the dispatcher acts on rather than a second reading of it.

### One existing inaccuracy this fixes

`TicketStateFacet.pickup` is computed in `src/server/routes/tickets.ts` from `config.issuePickupStates`
raw, so today the State tier's ▲ mark is missing on the in-progress state — the dispatcher gates on
`effectivePickupStates`, which folds it in. The mark is cosmetic in the table and load-bearing on the
board, since it decides which columns say the fleet will stop.

So the route passes `effectivePickupStates({ pickupStates: config.issuePickupStates, inProgressState:
config.issueInProgressState })` to `buildTicketPage` instead of the raw list. It is a lens quoting the
dispatcher's own pure function, which is the allowed direction — the rule the other way, that a
dispatcher rule must never consult a lens, is untouched.

This corrects the ▲ mark in the table as a side effect. Called out here because it is a visible change
to an existing surface, not a silent one.

### The drop, and what it looks like

The card moves to its new column the instant it is released and is drawn busy, saying it is still
writing — the write is a round trip to the tracker, and a card that sits still for a second reads as a
drop that missed.

On refusal the card returns to the column it came from **and quotes the provider's message on the
card**. A snap-back with no sentence attached is the failure that reads as the board being broken.

**Where the provider cannot write states at all, no card is draggable and the board says so once,**
above the columns. `CockpitConfig` gains `canSetWorkItemState: boolean`, resolved from
`isWorkItemStateCapable(connector)` — the same shape and the same reason as the existing
`canFileTickets`: the one place that decides is the one the route asks. Letting every drag fail
separately would teach the operator nothing five times over.

## 6. The filter rail in card view

| Control      | In card view                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| **Watch**    | Unchanged.                                                                                                 |
| **Tracking** | Unchanged, and honest — a column empty only because of it says so and offers the widen.                    |
| **Feature**  | Unchanged. Still filters the whole board; still the stripe on every card.                                  |
| **Group**    | Hidden. A flat board has no headings to indent under.                                                      |
| **Order**    | **New segment**, shown in card view only. The table's sort lives in column headers that do not exist here. |
| **State**    | Becomes column visibility.                                                                                 |

The State tier keeps its chips and its counts; `aria-pressed` now means "this column is drawn". The
hidden columns live in a new `Place` field `ticketColumns: string[]` holding the **hidden** ones — so
the default is empty, the query string stays short, and a state that appears in the tracker later shows
up by default rather than being invisibly excluded.

**Entering card view clears `ticketState` to `any`, and says that it did.** The field stops meaning
anything once every state is a column, and a control silently ignored is worse than one that moved and
told you — which is the `tickets-widened` notice's whole argument, pointed the other way. The notice
names what was cleared and offers the way back to the table.

## 7. Styling

Every new colour is a custom property on both `:root` blocks in `web/src/styles.css` and registered in
`web/src/cockpit/tokens.ts`. No hex at a use site: `format:check` and `lint` do not read CSS at all, and
`test/cockpitTheme.test.ts` is the only thing in `check` that does, so a literal is a surface that stays
dark when somebody switches to Light and nothing goes red.

The drag tones (`ok` / `warn` / `stop`) are `color-mix` derivations of existing core tokens, so they
follow the theme's hue rather than introducing three new hues per theme.

## 8. Testing

Unit tests, over the pure functions — which is where the invariants actually are:

- `boardColumns` — config order honoured; empty config falls back to facet order; a configured state
  with no items still yields a column; a mirror state absent from the config is reported as unlisted
  with its count.
- `cardReason` — each of the five precedence steps, and that a held-but-unwatched item does not read as
  held (the table's existing rule: nothing assays a goal nobody opted in).
- `dropWarning` — each clause of the table in §5 and the combinations that matter: the in-progress
  state reads as a **pickup** state even when `issuePickupStates` does not name it; the review state
  names its return condition rather than promising a bounce; a state with no live items claims nothing
  about closure; and the same-column case short-circuits.
- `effectivePickupStates` reaching the facets — a deployment with `issuePickupStates: ["Ready"]` and
  `issueInProgressState: "Doing"` marks **both** as pickup states, which is the ▲ fix.

At the `buildSystem` seam, with `FakeIssuesIntegration` — which already implements `setWorkItemState`
and reflects it into the fake world, so the whole path is assertable without a network:

- `POST /api/issues/:number/state` patches **both** the baseline and the mirror, broadcasts, and runs a
  cycle.
- A provider refusal returns a 400 quoting the provider, and writes neither patch.
- A connector without the capability returns a 400 naming that, and never calls the sink.

`test/cockpitTheme.test.ts` covers the new tokens once they are registered. The structural assertion
over `src/server/routes/` is satisfied by the route going through `checked`.

## 9. Specs to update in the same change

- [`docs/spec/17-cockpit.md`](../../spec/17-cockpit.md) — the view, the toggle, the columns, the card,
  the drag, and the two new `Place` fields.
- [`docs/spec/02-configuration.md`](../../spec/02-configuration.md) — `issueBoardStates`.
- [`docs/spec/16-http-api.md`](../../spec/16-http-api.md) — `POST /api/issues/:number/state`.

## 10. Files this touches

**Server**

| File                           | Change                                                              |
| ------------------------------ | ------------------------------------------------------------------- |
| `src/config.ts`                | `issueBoardStates: string[]`, default `[]`                          |
| `src/configFields.ts`          | one `stringList` entry                                              |
| `src/configApply.ts`           | live apply arm                                                      |
| `src/server/runningConfig.ts`  | key in the Integrations group                                       |
| `src/wire.ts`                  | `CockpitConfig`: `boardStates`, `canSetWorkItemState`, `stateRules` |
| `src/server/stateSnapshot.ts`  | ship those three                                                    |
| `src/server/routes/issues.ts`  | `POST /api/issues/:number/state`                                    |
| `src/server/routes/tickets.ts` | facets built from `effectivePickupStates`, not the raw list         |
| `src/store/world.ts`           | `patchWorldState`                                                   |
| `src/store/tickets.ts`         | `patchTicketState`                                                  |
| `src/store/store.ts`           | delegate both                                                       |

**Cockpit**

| File                                  | Change                                                      |
| ------------------------------------- | ----------------------------------------------------------- |
| `web/src/cockpit/place.ts`            | `ticketView`, `ticketColumns`                               |
| `web/src/cockpit/actions.ts`          | `setIssueState`                                             |
| `web/src/api.ts`                      | the call                                                    |
| `web/src/components/TicketsPanel.tsx` | the toggle, the rail changes, renders one view or the other |
| `web/src/components/TicketsBoard.tsx` | **new** — columns, per-column paging, drag                  |
| `web/src/components/TicketCard.tsx`   | **new** — the card                                          |
| `web/src/ticketBoard.ts`              | **new** — `boardColumns`, `cardReason`, `dropWarning`       |
| `web/src/styles.css`                  | board and card styles, new `:root` tokens                   |
| `web/src/cockpit/tokens.ts`           | register them                                               |
