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
  `fake` provider. A real-integration deployment does not see it, and the route refuses anyway.
- **`LaunchPanel`** — queue an operator job (prompt, optional title, code/desk, optional branch) and
  see the queue, including cancel.
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
  scheduled until you accept the proposal in "Needs you".
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
  toggle; issues with their state, linked PR and pickup chip, and a watch toggle; stories with a watch
  toggle; and a **Recently closed** section marking each PR merged vs closed-unmerged.

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

## Links

The cockpit never builds a provider URL. `refUrls` in the state snapshot is a `ref → URL` map, and
`linkify` / `refLink` (`web/src/components/util.tsx`) look refs up in it. A ref the provider could not
resolve is absent from the map and renders as plain text — which is what the `fake` provider produces.

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
