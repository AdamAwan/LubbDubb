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

**Three surfaces hang off the shell rather than off the console**, and each for one reason — it is
_overlaid_ rather than placed. Which one is open is cockpit state, not console state (the drawer's
output subscription is tied to it), and the surfaces that open one are scattered across the page:

| Surface                                        | Opened from                                                 |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `AgentDrawer`                                  | a fleet row, a goal's part, an ask — `select`               |
| `PlanModal` / `RetroModal` / `ScratchpadModal` | the goal page — `viewPlan` / `viewRetro` / `viewScratchpad` |
| `SettingsModal`                                | the top bar — `openSettings`                                |

Two more used to: the spend and reliability breakdowns. They are the [Insights](#insights) destination
now, and the move is the argument against overlaying a reading at all — a sheet that covers the queue
rail hides the ask that sent the operator to it.

The console asks for each the way it asks for a plan — a method on the seam — and the shell answers.

**Reaching `api.js` is not itself a reason to sit on the shell.** The rule is that no module under
`console/` _imports_ it; a shared component that does is embedded like any other, and several are —
`LaunchPanel`, `SchedulePanel` and `RecordPanel` all ride their own routes from inside the console.

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
the two sheets cannot collide while both are loaded. The two families are a real distinction rather
than a namespace: `--accent` is orange and `--cn-accent` is blue, and `--panel` sits two steps lighter
than `--cn-panel`. The prefix boundary is by component family and **not by file** — `styles.css`
carries more `var(--cn-*)` references than `console.css` does, because the Tickets tab and the config
page are console-family surfaces that happen to be styled in the shared sheet.

The token layer is also the theme. Every colour the cockpit draws is a custom property that an
operator can set from [the Theme section](#the-theme), which turns the old claim that the palette is
"a placeholder nobody has replaced yet" into a rule with teeth:

> **A colour written as a literal at a use site is a colour no theme can reach.** That is a bug, not a
> style preference.

It reads as a tidiness rule and is not one. The failure is silent in the way this repo cares about: the
sheet is correct, the component renders, every test is green, and the panel is simply still dark when
somebody switches to Light. Getting here meant sweeping 189 such literals out of the two sheets, and
what keeps them out is `test/cockpitTheme.test.ts` — a colour may appear on a line that declares a
custom property, and nowhere else, in either sheet. No line ranges and no allow-list, so it cannot rot
as the sheets grow. Note that neither `format:check` nor `lint` reads CSS at all, so that test is the
only thing in `npm run check` that does.

Three consequences worth stating, because each is a thing a reasonable change would undo:

- **The tokens live in exactly two `:root` blocks**, and the four scoped families — `--cn-tone-*` on
  `.cn-t-*`, `--sp-*` on `.sp`, `--rl-*` on `.rl` — are **pure aliases** of them. They have to be. A
  declaration on `.cn-t-red` shadows an inherited value unconditionally, so while those tints were
  written there a theme setting them on the root could not reach inside a tone at all. The alias form
  also keeps their names, which matters more than it looks: `--sp-*` and `--rl-*` are never `var()`-ed
  from CSS but composed at runtime in TSX as ``var(`--sp-${phase}`)``, where a rename typechecks,
  passes and silently paints nothing.
- **Most `--cn-*` tints are `color-mix` of the core rather than values.** `--cn-red-bg`, `-fill`,
  `-line` and `-ink` are all mixes of `--cn-red` with a ground, so setting the hue moves all four — in
  a preset, and under a picker drag. That is the leverage; it is also why a preset is sixty-odd lines
  instead of a hundred.
- **The shared family's warm tints stay literals**, and that is deliberate. A mix that reproduces
  `--amber-fill` numerically has to be read as something like "6% accent over the well", and a formula
  nobody can reason about is worse than a value they can see. They were hand-tuned against stated
  contrast targets; a formula does not reproduce hand-tuning.

`console.css` is imported from `main.tsx`, not from a module under `console/`. A `.css` import there
would be invisible to `tsx`, which has no CSS loader and would throw when `test/console.test.ts` pulls
those modules in.

## Shape

Five surfaces and one shell.

```
┌──────────────────────────────────────────────────────────────────────┐
│ ident ↗issue │ Overview Tickets Insights │ Scan · Fleet  Findings … Record ⚙ │ top bar
├────────────────────────────────────────────────────────────────────────┤
│ the recovery banner, when a previous run left work orphaned            │
├───────────────┬────────────────────────────────────────────────────────┤
│ NEEDS YOU  6  │  ‹ Overview / #142 Retry the intake   ← only on a goal │
│ ┌───────────┐ │                                                        │
│ │ Blocking  │ │                                                        │
│ │ escalation│ │             the situation area                         │
│ │ plan      │ │  (a tab — overview, tickets, insights, pets — or a goal) │
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
a reading, instead of on the ask.

The **nav** is three tabs: Overview, Tickets and Insights — the second carrying the untriaged count,
the one number that says whether triage is worth opening. It is `untriagedCount` (`web/src/worldBuckets.ts`)
over the same watch bucket the tab's Unwatched filter uses, so the number on the button and the rows
behind it cannot differ, and it is hidden at zero because a badge that always shows is one nobody
reads. Every button clears _both_ pieces of state, because a nav click
means "go here" and either half left standing would land somewhere else.

**Work was the second of these and is not a destination any more** ([below](#the-record-panel)). Every
part of it had found a better home — a goal's own record onto its goal page, the unrecorded-work
call-out onto the tickets tab, the roots nothing has claimed into the `record` panel — so what the slot
held by the end was a disclosure triangle over an index of pages that are one click away anyway. A nav
slot is the most expensive space in the cockpit, and the rule for what earns one is the same rule that
keeps Config out: **the nav is the surfaces work happens on**. `readPlace` aliases `?tab=work` onto
tickets, where the one half of it an operator acted on went.

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
nothing can reach — and fails. It asserts `Work` is **not** among them for the mirror reason: a slot
given back is given back.

**Pets is the fourth, and it is conditional.** It is appended to the list only when
`state.pets` is non-null — the same reading that decides whether the rail draws a vivarium at all —
because a tab opening on a page that explains a subsystem this deployment does not run is worse
than no tab. `tabBody` refuses it on the same reading, so a stale `?tab=pets` URL lands on a
sentence rather than on an empty catalogue. → [22](22-pets.md#the-pets-page)

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

`?section=theme` is a place; **the theme is not.** The distinction is the one the address bar is for: a
section is somewhere you can be, and a theme is true of every place at once. Putting it in the query
string would give a Light operator two spellings of the overview, make every link the cockpit writes
re-theme whoever clicked it, and — since live preview writes tokens on every frame of a drag — push a
history entry sixty times a second.

`Place` is every piece of state that answers _what am I looking at_ — the tab, the selected goal, the
panel in front, the open drawer, the plan sheet, the retrospective, the notepad, and the three top-bar
modals — and nothing that answers _what is true_. It replaced ten independent `useState`s in
`useCockpit`, and one record rather than ten is the load-bearing part: a drawer opened over a goal
page on the tickets tab is **one** place, and stepping back out of it has to restore all three at
once.

| Parameter                            | Carries                                                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `tab`                                | `tickets` / `insights`; the overview is the absent value. `backlog` and `work` are aliases for `tickets`, so links to either deleted tab still land |
| `goal`                               | the open goal page, as `issue:<n>`                                                                                                |
| `panel`                              | `findings` / `lessons` / `faults` / `launch` / `build` / `record` / `localRun` / `setup` / `pets`                                  |
| `ask`                                | the queue row a `{ ask }` panel is showing                                                                                        |
| `agent`                              | the open drawer's agent                                                                                                           |
| `plan` / `retro` / `pad`             | the plan sheet, the retrospective, the notepad                                                                                    |
| `settings` / `spend` / `reliability` | the three top-bar modals                                                                                                          |
| `collapsed`                          | the tickets tab's features folded away, as `3,12`                                                                                 |
| `watch`                              | the Tickets tab's harness axis: `watched` / `unwatched`; `any` is the absent value                                                |
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

**The snapshot carries only the escalations that are still open** — the rail's own
`status === 'open'` filter is belt-and-braces over a list that already holds nothing else
([16](16-http-api.md#bulk-text)). Nothing in the cockpit draws a settled escalation, and each carries a
transcript tail, so the all-time list was half a megabyte a refresh spent on rows that were filtered
straight back out. A surface that wanted the settled ones would need a route of its own.

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
agent is sitting in it. The rule is about a held slot, and widening it here would cost the group the
only thing it means. A limit park is `blocking` for the rule's own reason and not by analogy: the agent
is stopped, its worktree and its slot are held, and the harness will not resume it on its own — all
that differs from a question is what the operator does, which is wait for the window to turn over.

### Hue is the kind, weight is the group

The rail once spent its whole palette on that one bit — red for `blocking`, amber for `yours` — and the
cost of it was that **everything that ever landed on the bench arrived in an alarm colour**. A goal
delivered and waiting to be closed out drew in the same two hues as a restart that orphaned six runs,
and an operator glancing at the rail could not tell a queue of successes from a queue of faults without
reading every row. The palette now answers _what the ask is_, and the group is carried as weight
within it.

| Kind         | Tag         | Tone  | Glyph | Why that tone                                        |
| ------------ | ----------- | ----- | ----- | ---------------------------------------------------- |
| `recovery`   | Recovery    | red   | `↺`   | A restart left runs orphaned. Something went wrong.  |
| `escalation` | Escalation  | red   | `?`   | An agent hit a question it cannot get past.          |
| `permission` | Permission  | amber | `⊘`   | A gate, not a fault — a command is waiting on a yes. |
| `limit`      | Usage limit | amber | `‖`   | Nothing broke; an allowance window has to turn over. |
| `burn`       | Spend       | amber | `▲`   | A heads-up on a run that carries on either way.      |
| `proposal`   | Plan        | blue  | `◇`   | A plan to read and decide on.                        |
| `profile`    | Profile     | blue  | `⊙`   | Which profile a goal runs on.                        |
| `bench`      | Bench       | blue  | `◆`   | Work only a person can do. Informative, not broken.  |
| `close_out`  | Close-out   | green | `⚑`   | A goal was **delivered**; this is the step after it. |
| `validate`   | Validate    | green | `✓`   | The other step after a delivery — run its checks.    |

`KIND_TONE` and `KIND_SYMBOL` (`web/src/console/QueueRail.tsx`) are total over `NeedKind`, beside
`KIND_LABEL`, so a new kind fails the typecheck rather than drawing in whatever the last rule in the
sheet said.

**The glyph is a second reading of the word, never a replacement for it.** The tag still spells the
kind out beside it, which is what makes the set need no legend, and the glyph is `aria-hidden` — a
screen reader announcing "black diamond bench" is worse than one announcing "bench". The set is drawn
from BMP codepoints that have **no emoji variant at all**: a character that has one is rendered by the
platform's colour font on some machines and its text font on others, which puts a full-colour sticker
inside a 10px monospace tag on exactly the operator's machine nobody tested on. There is nothing here
for a variation selector to fix, which is the point — `✔`, `☑` and `🏳` are out for that reason and `✓`,
`⚑` and `◆` are in.

**The group is said three ways instead of one.** The `Blocking` sub-heading, the sort order, and each
row's own weight: `blocking` draws `cn-parked` — a full-strength stripe and a filled tag — against the
softened stripe and outlined tag of a row nothing is waiting on. Opacity within one hue rather than a
second colour per tone, so the two readings cannot drift apart. `test/console.test.ts` renders every
kind with the group alternating beneath it, so a rail that quietly went back to colouring by group
fails rather than merely looking wrong.

**The band carries the tone and the glyph but not the weight**, and that is the one thing the two
surfaces differ on. Weight is a triage aid for a list of asks competing for attention; the band is a
single ask already in front of the operator with its verdict controls under it, and there is nothing
there to rank it against. Hue and glyph are what make a row and the band it opened read as one ask, and
both hold — asserted in `test/console.test.ts`.

A tone is five custom properties on the row or the band — `--cn-tone`, `--cn-tone-fill`, `--cn-tone-bg`,
`--cn-tone-line`, `--cn-tone-ink` — set by one `.cn-t-*` class and inherited by everything inside. Five
values that have to move together, and the alternative is the near-identical copy of each rule per tone
this replaced.

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

**A row names the run it is about, never that run's id.** An agent id is minted
(`agent_${nanoid(10)}`, `src/store/agents.ts`) and an agent has no name of its own, so `agent_ab4sc`
on a queue row was a label that identified nothing and read as though it ought to. The harness's own
answer to "what is this run" is its **task's title**, which the fleet card, the drawer and the goal
page all already use — so `buildNeedsYou` resolves it onto the row as `agentLabel`, clamped to its
first line because a title is free text and a queue row is one line. The id stays on the row as
`agentId`: it is what a control resumes and what the drawer is keyed on, and it is simply not what
the rail prints. A row whose agent the snapshot no longer carries draws the phrase _a run with no
task on record_ — the fact stated, rather than an id offered as a name. `test/needsYou.test.ts`
pins the resolution, the clamp and both fallbacks.

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
7. **Environments** — what a delivered goal still owes ([Environments](#environments)).
8. **The record** — this goal's own subtree of the durable work graph, last because it is the only
   card in the column that asks nothing of the reader: the five above it are the live reading and
   what is still owed, and this is what is left of the same work once the snapshot has forgotten it
   ([The record](#the-record-on-the-goal-it-belongs-to)).

At ≥1500px a right-hand column carries **On this goal** (who is working it now), **Spend** and **The
tail**. Below that, the two stacks are one column.

### The header's controls

Watch, the priority flag, the profile pin, the conclusion, raising a bug, the ticket, and ending the
run.

- **The watch toggle writes one tag.** `setIssueWatched` adds the watch label or takes it off, and
  the title says which — un-watching writes nothing in its place, so the goal lands back in the
  tickets tab's Unwatched filter rather than in a bucket of its own.
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
  ([16](16-http-api.md#post-apiissuesnumberdismiss-run)). On a goal whose validation plan is flagged
  it reads `End the run…` and opens `EndRunModal`, because the route refuses a dismissal with no note
  while it is — [below](#saying-the-sentence-a-refusal-asks-for).

### The bands

Each band embeds the **shared** component that owns its refusal rules — `EscalationCard` for a
question, a permission or a proposal, `HumanTaskActions` for a bench task or a close-out. The
goal-profile gate is the one band whose controls live in `NeedsBand` itself — its verdict is two
buttons on one write and there is no shared card underneath it — and it is drawn there rather than on
the goal page for the same reason the others are: the page and the rail's panel then hold one copy of
the write between them. Embedded, never redrawn: a second wiring is a second way to answer a proposal with free text on one surface only.
`buttonClass` is the one seam the console passes, so the shared buttons wear the console's face without
the console reaching into their class.

#### Saying the sentence a refusal asks for

A route that refuses for a reason the operator can act on needs two things on the glass, and for a
while had neither. **The reason** — every route refuses with `{error}` and `api.ts` rethrows it as
the `Error`'s message, and `useAsyncAction` used to drop it in a bare `catch`, leaving a red ring
that faded in two seconds as the whole account of what happened. It is now kept until the next run,
hung off the button's own `title` (which costs no layout, so every `AsyncButton` in the cockpit gains
it) and handed to `onRefused` for the stations with room to draw it — `HumanTaskActions` and the goal
header both draw it as a `.launch-error` line, the same one the composer uses, because a refusal is
one thing wherever it lands.

**And somewhere to answer it.** The two controls a flagged validation plan refuses
([20](20-validation.md#where-it-lands)) posted no note and offered no box to type one in, so the
refusal was not merely invisible — it was unsatisfiable, and the control could not work at all. The
bench verdict's Done reads `Done…` on a `close_out` whose goal is flagged and opens the note box
Decline already had; `End the run` opens `EndRunModal` on the same condition and stays one click on
every other goal. The condition is mirrored, the counts are not: they are `issue.validation`, folded
once on the server, and the row's own detail already lists what is outstanding.

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
Waive, each opening a one-line note the server also requires, the hand-over, **Run it in Claude
Code**, and one way back to `unrun` from any settled state.

**Run it in Claude Code** is the odd one out and is the reason it exists: it writes nothing. A desktop
session is started from the operator's own Claude Code, not from here, so the control is an `<a>`
carrying a `claude://code/new` deep link that opens that client on the goal's checkout with
`/lubbdubb <issue>:<letter>` prefilled — the same builder the plan sheet's **Discuss…** uses — and the
cockpit's part in that run ends there. Without it the third runner is the only one with no trace on
the surface managing the other two. → [20](20-validation.md#starting-a-run-from-the-cockpit)

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

**The agent on a part is a door, not an id.** The row used to end ` · agent_ab4sc`, which named
nothing — agent ids are minted and an agent has no name — while the one thing an operator wanted from
it, that run's transcript, its cost and its controls, sat on a surface the row did not lead to. It is
drawn as `open the agent ↗` instead, on `select(agentId)`, the same seam every other way into the
drawer uses ([The agent drawer](#the-agent-drawer)). A control rather than a name because the row
already says which part this is, and repeating the task's title beside it would name the same work
twice. It sits **beside** the pull-request reference inside the dependency line and never around it:
one click cannot have two destinations, which is why the row is not itself a button.

**The card's header carries the way into the plan sheet** — `open the full plan ↗`, `viewPlan` on the
plan this goal's parts came from, drawn only when there is a plan to open. The waves are the shape of
the work and nothing else: the diagnosis, the approach, the map, each part's `touches`, `rationale`
and acceptance checklist, and the record of the decision that was made on it are all the sheet's
([The plan sheet](#the-plan-sheet)). Until this control the only way onto it from a goal page was the
validation card's aside about amending the checks — a door that reads as being about checks, on the
card below the one an operator looking for the plan is reading. The sheet is the same one the
approval band opens, which is the point: what was approved and what is being worked are one document,
read at any time and not only while the question is open.

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

### Environments

Under the pull requests, one row per configured environment: what it holds of this goal, the count on
every row that is not whole (`0/3` and `2/3` are the difference between work that has not started
moving and work that is halfway there), and the verdict as a chip. `partial` takes the _attention_
tone rather than a success one, because half a feature in production is the state most likely to want
somebody. The card is absent entirely when nothing is configured — a row of question marks on every
deployment that never set one up would be a feature announcing itself as broken.

A row that **opens** something says so, on the row that would do the opening: an operator reading a
held goal asks "waiting for what" exactly once, and the answer is configuration they may not remember
writing.

**A held goal says it is held**, in `gateHold`'s own sentence, with the release control beside it.
This is the one place it is said: nothing is filed while a gate holds, so without the line a delivered
goal with an empty bench is indistinguishable from a finished one. It is deliberately **not** a
"Needs you" row — with a gate on the first environment every delivered goal is held for as long as a
deploy takes, and a rail carrying all of them would bury the asks somebody can answer. The release
takes a required note through a modal, on `InstructionModal`'s reason: it is prose the operator has to
compose, and every other control on this page is a verdict.
→ [24](24-environments.md#what-an-arrival-means)

### What the goal page deliberately does not draw

**This goal's slice of the decision log.** `buildGoalPage` computes `decisions` — the rows whose
`subjectRef` names the goal — and nothing renders it. The snapshot ships the last hundred audit rows
fleet-wide and a cycle spends one of them every pulse on its own rationale, so filtered to one goal the
list is a handful of dispatches at best and empty for any goal not touched in the last few hours. The
design's stated arm was that this becomes its own route, and this takes that arm: **deferred, not
half-built.** A per-goal activity list is a route away, and the derivation is already here to draw it
from.

## The overview

What the situation area shows when no goal is selected: six cards, rows rather than pictures, in
reading order — **Fleet**, **Goals in flight**, **Pull requests**, **Up next**, **Rate**, **World
signals**. The fleet's **runway** is a band along the foot of the first of them rather than a seventh
card, because "who is out" and "what is behind them" are one thought.

Two rules run through all five. **Nothing here re-decides what the server decided**: a PR's court is
`attention.status`, its checks are `ciVerdict`, a queued item's hold is the queue's own sentence, and a
goal's state is its `pickup.status`. And **an empty card still draws**, muted, because a surface that
vanishes when quiet is indistinguishable from one that broke.

- **Rate** — is the floor producing, or merely busy? The one reading in the cockpit that is against
  _time_, drawn from the timestamps already on `decisions` and `worldEvents` (`web/src/view/production.ts`);
  a held or skipped dispatch is not counted, because it produced no work. **The churn ratio (dispatches
  per merge) is the point**: dispatches are effort and merges are output, and a rising first figure over
  a flat second one is a fleet going round. A series with nothing in the first half of its window draws
  no delta rather than a 0% one — there is nothing to have changed from — and when the decision log does
  not reach back to the window's start the card **says so**, because a rate that silently under-reports
  is worse than no rate.

  It was the Output panel. The half of it that was about money is [Insights](#insights)' headline ratio
  now; this is the half that belongs on the overview. It keeps a **fixed six hours** while everything on
  that page obeys a control, and deliberately: this card answers "what is happening", and a window an
  operator has to set before the answer means anything is not that question. It says the span out loud
  for the same reason, and carries the one way through to the money behind the rates.
- **Goals in flight** carries the **furthest environment** holding a goal whole, where any is —
  last-declared in the operator's list, since that list is the order the work travels in. `partial`
  gets no chip: a row reading `liveUs` for half a feature is the boolean rollup the reach fold refuses
  to make, one layer up. → [24](24-environments.md#in-the-cockpit)
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
  Along the card's **foot** is the **runway band** ([25](25-supply.md#in-the-cockpit)): who is out,
  then what is queued behind them, in that order and in one card. The foot rather than the head
  because the agents are the card's subject and this is its consequence, and it costs nothing to
  reach — Fleet's rows are bounded by the agent cap, so the band never travels far down the page. It
  quotes `state.runway` and re-decides nothing, draws **no control** (the reading is a statement about
  the fleet, and a "watch something" shortcut would make it a prompt for the quickest fix rather than
  the truest one), always draws — muted when healthy, grey while paused — and **changes unit rather
  than lying**: with nothing queued there is no runway to state, so it counts idle slots instead.
- **Goals in flight** — every goal whose `pickup.status` says the harness has it in hand now
  (`active` / `has_pr` / `planning` / `delivered`). Read off the dispatcher's own word rather than
  re-inferred from agents, plans and pull requests, which are three inputs the server has already
  folded into one. Each row is a way into that goal's page, carries its segment track, and takes a
  **court chip read off `needsYou`** — a goal is in your court exactly when the rail is holding an ask
  about it. Anything else would let a chip say "you" with nothing to answer.
- **Pull requests** — every open PR with its court chip, its CI ladder, and the watch toggle.
  An **unwatched** PR stays in the list, with its health, and is drawn **spent** — the same dimming a
  closed PR and an unwatched goal take, off `attention.status === 'unwatched'` rather than a
  second reading of the labels. The chip alone left the one row nothing will happen on sitting at the
  same weight as the ones being worked, which is the whole thing the absent tag is meant to say.
  Most pull requests here are tagged by the harness itself ([07](07-pull-requests.md#watching)), so
  the button is normally an **un-watch**: the way to stop a runaway agent's pull request.
  A PR is joined to its goal through **`goalOfPr`** — the server's own three-way match (a part's
  `prNumber`, the tracker's `linkedPrNumber`, the branch convention), read backwards — and the goal is
  drawn as a way onto its page. Through the parts alone it was drawn for almost no PR at all: a goal
  the funnel failed open on has no parts and its PR is on the flat `issue/<n>` branch. A PR no ticket owns
  resolves to nothing and draws nothing, which is honest about what is known. The toggle is **disabled rather than absent** with no watch label configured: the gate
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
  Each row ends in the **`ProfilePicker`**, drawn from `QueueItem.profile` / `profileSource` /
  `override`: the queue is the one surface that says what a dispatch will run on _before_ it
  runs, and the one place the judgement is available — an operator who reads "resolve the conflict on
  `issue/390/watcher`" knows it is mechanical work, and the row is in front of them. The empty option
  names what the row resolves to unpriced ("Auto (standard)", or "Pinned (deep)" where a goal tag or
  a part profile already answered), so the panel states the profile whether or not anybody has
  touched it; with an override standing it reads plain "Auto", because `profile` is then the override
  itself and naming it as the fallback would promise that clearing the control changes nothing. The
  control draws nothing at all on a deployment with no `agentModels` — `ProfilePicker`'s own rule,
  not a second one here.
- **World signals** — `worldEvents` grouped by `(kind, ref)` with a count, ten rows, **plus the
  environment arrivals** of the last week. Three review comments on one pull request are one signal,
  not three unrelated rows; two environments reaching one goal are two things that happened, so
  arrivals are one row each. The row draws **the goal behind the signal** beside the sentence and
  never the pull request: the summary's own `#412` already links out, so repeating it would be one ref
  twice, and what a signal never offers is the way onto a goal's page.

  The arrivals are merged **here**, at render time, rather than carried in `worldEvents`. A world
  event is derived by diffing consecutive snapshots, and a standing delivery verdict is expired by any
  world event on its issue ref — so an arrival written as one would lift the delivery park on the goal
  it announced and hand the work straight back to the fleet.
  → [24](24-environments.md#in-the-cockpit)

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

## The record panel

The durable record: `RecordPanel`, opened from the **Record** reading on the top bar. It is **the one
surface that outlives the world snapshot** — every other panel draws the snapshot and so forgets a pull
request the moment it ages out of `closedPrWindowMs`, while this one still knows that #40 merged and
which issue it delivered.

It has been three shapes, and the argument each time was the same one about where a reader finds it. It
was a strip below the console, reachable only by scrolling past everything else; then the second nav
destination, which is what a record an operator opens the cockpit to check deserved; and it is a panel
now, because by the end the tab was drawing almost nothing at full weight. Its two halves had both
found somewhere better to be: a goal's own subtree onto [its goal page](#the-record-on-the-goal-it-belongs-to),
where the reader already is, and the unrecorded-work call-out onto [the tickets tab](#unrecorded-work),
where the rest of triage happens. What was left in the slot was a disclosure triangle over an index of
pages that are one click away anyway.

**A panel is the right shape for an archive, and it is also a better one than the tab was.** A record is
consulted — you go to it with a question, read one thing and leave — where the nav is the surfaces work
happens *on*. And the bar is reachable from everywhere: a selected goal outranks every tab, so the
record-as-a-tab could not be read beside the goal that sent you looking for it, while a panel draws over
whatever is in front. What it costs is the glance: nothing on the bar says the graph has anything new in
it, and nothing should — the reading carries **no count**, because every number the strip states is a
thing waiting on a person and the record is never waiting on anyone. It sits at the tail of the strip
with Config, the two ways-in that are not gauges.

It is **fetched on open and never polled** — `/api/work` for the roots, `/api/work/:ref` for a subtree —
because `/api/state` comes round every couple of seconds and the graph only ever grows. Being a panel is
what makes "on open" honest, since nothing fetches until the operator opens it.

**Goal roots are collapsed behind a disclosure**, because each is now drawn in full on its own goal page
([below](#the-record-on-the-goal-it-belongs-to)). Collapsed and not dropped: `Ref` is the only thing that
knows whether a ref _has_ a page — a ticket the snapshot has forgotten does not — so hiding those rows
would make their record unreachable rather than relocated. They stay, drawn as references, and the
component picks the destination. What is left at full weight is what has nowhere else to be: operator
jobs, and the work items filed for them.

It is a **lens**: nothing here, and nothing in the dispatcher, decides anything from what it draws.
→ [16](16-http-api.md#get-apiwork)

### The record, on the goal it belongs to

A goal's own subtree of the graph, drawn as a card on its page (`WorkRecord`), below **Pull
requests**. The roots of the work graph _are_ `issue:<n>` nodes, so a goal page was already sitting on
top of its own record without drawing it — the card is `GET /api/work/:ref` and nothing else.

**It fills a hole the page already had.** Every other card there reads the snapshot, and
`closedPullRequests` remembers a merge for `closedPrWindowMs` and then drops it — so a goal that
shipped three pull requests a month ago draws "No pull request names this goal yet", on a page about
work that demonstrably happened. It also carries what nothing else on the page keeps: the `inferred`
chip on a merge the harness never watched, concerns raised and cleared, and the requeues, sitting
under the part they redid.

Three things it does deliberately:

- **The root is dropped.** The route returns the root with its subtree, and the root here is the page
  you are standing on. `depth`'s missing-parent arm then lands its children flush left on their own.
- **A row draws a ref only for `issue:<n>` or `pr:<n>` exactly.** `refLabel` shortens a whole family
  to its number, so `issue:395:plan` and `issue:395:part:api` both read `#395` — the number of their
  _ancestor_, drawn four times over on a listing of that ancestor's subtree, each one a link back to
  the page the reader is on. A dead end wearing the shape of a destination is the thing
  [refs](#links) exists to prevent, so a sub-origin draws none: its identity is its title and its
  indent, and both are already right.
- **The row is one component** (`workTree.tsx`), shared with the tab. Two copies would drift where it
  is least visible — `inferred` is a chip that says the harness never watched the merge it is
  claiming, and a surface that quietly stopped drawing it reports a stronger fact than it holds.

Both surfaces wrap it in `RefLinksExtended` with the **route's** `refUrls`, never the shell's: the
shell's map is assembled from the world, and the graph's whole job is remembering what left it.

The demo derives this from `buildGoalPage` rather than returning the empty graph `getWorkRoots` does.
The two are asked different questions — the panel lists roots _nothing has claimed_, and a world rebuilt
each load has none, but answering "nothing is recorded" for a goal the demo is visibly working
misrepresents the surface rather than under-claiming it. It is derived so it cannot contradict the
cards above it; what it cannot show is the one thing the record is _for_, since this world has never
forgotten anything.

## The tickets tab

Every item the tracker's assignment filter has returned since the harness first swept — worked or
not, live or frozen — and, since the backlog was folded into it (#351), **the one surface triage
happens on**. Where [the record](#the-record-panel) is what the harness _did_, this is what it was
**asked** to do, and what you are asking it to do next. It is drawn as a table because it
is read as one: the tracker id, the ticket, the readings, the cost and the date, each row taking the
list's tracks by subgrid so the columns line up however long one title runs.

**Why one surface and not two.** The backlog was open items grouped by watch bucket; this tab was the
same items plus the closed ones, filtered by the same bucket. Two surfaces that can be told different
things about one item is the drift `src/watchLabels.ts` exists to prevent, one level up — so the
backlog is deleted and every part of it is named a destination here rather than assumed to survive.

| The backlog had                                | It is now                                                  |
| ---------------------------------------------- | ---------------------------------------------------------- |
| four groups (watched/intake/unwatched/ignored) | the **Watch** filter's values, now two                     |
| intake pulled out of Watched                   | the **intake call-out** above the list                     |
| `Override → workable` on intake rows           | the same button, the same call, on the same rows           |
| features as headings, folds on `Place`         | `group=feature`, the same `collapsed` field                |
| the name opening the goal page                 | unchanged — `selectGoal`, refs beside it                   |
| 25 rows then "…and 31 more"                    | the keyset cursor and infinite scroll this tab already had |
| the nav's unwatched count                      | the same number on the Tickets button (`untriagedCount`)   |

`?tab=backlog` **resolves to this tab** rather than falling through to the overview, which is what an
unknown tab does: every bookmark and shared link to it would otherwise land somewhere else with
nothing saying so. One alias entry in `place.ts`; a stranded link is a bug report. `?tab=work` resolves
here too, and that one is the weaker claim of the two — tickets is not a superset of the retired work
tab, it has [the half of it](#unrecorded-work) an operator acted on, while the record itself is a panel
a tab alias cannot open.

It is **fetched on open and per page rather than polled** (`/api/tickets`), for the record panel's
reason: the list is all-time and only grows, and `/api/state` comes round every couple of seconds.
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

**Watch is the harness's reading** — the `${labelPrefix}-watch` tag, resolved through `isWatched`
(`src/watchLabels.ts`), the same question the dispatcher's gate asks. It is **two-valued**: an item
carrying the tag is `watched` and every other item is `unwatched`. It used to be three, with a second
`-ignore` tag for "leave this alone"; that reading is retired
([06](06-issue-pickup.md#the-retired-ignore-tag)) and an item still carrying the old tag simply reads
`unwatched`, which is what it meant.

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

**A closing state is on the tier, and picking it widens the tracking axis.** The two axes are
near-disjoint on a tracker with native states: every `Closed` row has by definition left the open set,
so under the tab's default `live` narrowing a pick of it would return an empty list while the chip
that was just clicked counted sixty-eight. Each facet therefore carries `live` beside `count`, and
`statePick` (`web/src/cockpit/place.ts`) widens `tracking` to `any` on exactly the picks that number
says are unreachable — never on any other, so a state with live rows narrows as it always did and
nothing here ever makes the list smaller than the chip's own count implies. The chip's tooltip says it
before the click, because a filter that moves a control the reader did not touch has to say so.

**And the widening says so after the click too, with the way back beside it.** The tooltip warns the
reader who reads tooltips; the axis then moves, and nothing put it back — the State tier's own `Any`
returns every state under the _widened_ axis, so a reader who lands on the tab, picks `Closed` and then
asks for every state again is left on the whole history with no sentence anywhere saying which control
moved. That is issue #418, and the symptom is exact: the filter set the tab _starts_ on is the one it
cannot offer. So a band between the two controls names the state the axis is widened for — `widenedFor`
(`web/src/cockpit/place.ts`), which is `statePick`'s own predicate read back off the two `Place` fields
that state it, never a third field remembering it happened.

**The offer is the coarse pair, not the axis.** Narrowing to `live` while `Closed` is still picked is the
empty list the widening exists to avoid, so the button restores `LIVE_WORK` — both axes at once, which is
the view being asked for. `LIVE_WORK` is read off `NOWHERE` rather than written out, so it cannot drift
from the default it is offering back. And it **announces and offers; it never moves an axis nobody
touched** — an operator who chose `any` by hand and then picked a closing state reads the same band and
keeps their axis, because undoing it for them would be the silent move the band exists to apologise for,
in the other direction.

That the closed rows are _in_ the mirror with their own word on them at all is the store's business
and was not always true — the state used to be taken only from the live overlay, so a closed item
carried none. → [14](14-persistence.md#the-ticket-mirror)

The harness's own outcome for a goal — `delivered`, `fell short`, `concluded`, `abandoned` — rides on
the row as a chip and is deliberately **not a filter**: it answers a different question from any axis.
It is folded to one word on the server (`src/tickets/outcomes.ts`) from `resolveIssueConclusion` plus
the delivery and run rows, because a precedence rule re-implemented in a component is a second opinion
about it.

**A goal being worked has no outcome word.** `resolveIssueConclusion` resolves a plan in flight —
`planning`, `awaiting_approval` or `active` — to `more_work` with `by: 'plan'`, which is a derivation
about where the fleet is and not a judgement anyone cast. `fell short` is reserved for a `more_work`
somebody actually said: an assessor's shortfall, the operator's toggle, or the working agent's own
`conclude_work`. Reading the verdict without its author put the chip on every goal with a live plan,
which on a running fleet is most of the ones in progress — the column then said "fell short" about
work that had not finished yet. Where the goal has got to is the row's state and the dispatcher's own
pickup reasons; this chip is for how the harness _left_ it.

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

### The state is coloured by the operator, never by the harness

A row's state chip is the tracker's own word (`workItemState`) where there is one, and it draws in
whatever colour the operator gave that word — `issueStateColours`
([02](02-configuration.md#item-selection-labels-priority-states)), shipped on `CockpitConfig` and read
through `stateColour` (`web/src/stateColour.ts`). The goal page's header chip reads the same map, so a
state is one colour wherever it is drawn.

This is the opposite arrangement from the type chip above, and for the same reason. A type has
_families_ the harness genuinely knows, so it can tint one and fall through on the rest. A state has
none: `New`, `Doing`, `Worthyable`, `Closed` is one board's vocabulary, the next board renames all four,
and the cockpit has no reading of which of them matter — only the operator does. So there is no built-in
scheme to fall through from, and the fall-through is _grey_: an uncoloured state draws exactly as it did
before the setting existed. Which is the failure the setting answers — a dozen state words rendered as
one grey is a column you read by squinting.

The lookup folds punctuation and case, so a map written against `In Review` keeps working when the
tracker reports `in-review`. A malformed colour resolves to no colour rather than reaching the `style`
attribute: the config route refuses one on the way in, but the map also arrives from a hand-edited
file. **Frozen keeps its dashed border** whatever colour its state carries — closed in the tracker is a
fact about the item, not a shade of the state it stopped in.

### Intake is pulled out, never greyed inside the list

An `unclear` assay is the one intake reading that **stops dispatch** ([06](06-issue-pickup.md)). Among
a page of rows it reads as a detail rather than as the thing holding all the work, so it is drawn as a
call-out **above** the list: what is held, the assayer's own sentence quoted whole, and
`Override → workable` beside it. A lamp marks the same rows in the table.

The sentence is quoted and never reworded — it is the only account of why the goal is held, so a
paraphrase would be the only account there is, and wrong. An **unwatched** item is never intake,
whatever a stale verdict says: "leave this alone" is the operator's own instruction and outranks a
reading about a goal nobody is going to work.

Unlike the group it replaces, the call-out is **absent when nothing is held** rather than drawn empty.
A group that vanishes when quiet reads as one that broke; an exception nobody has is not a heading.

### Unrecorded work

What the harness did that nothing in the tracker accounts for, with `File a work item` and `Ignore`
beside each row — since nobody outside can ever mark done what nothing records. `UnrecordedWork`, drawn
as a second call-out above the list, below intake.

**It is here because it is triage.** Filing or ignoring is a verdict cast on a row, which is what this
whole tab is for; it sat at the head of the work tab while that existed, and by the end it was the only
part of that tab an operator ever acted on. It is drawn **below** the intake
call-out because intake is the louder of the two: an unclear assay stops dispatch, while an unrecorded
job is a debt that costs nothing until somebody outside asks what the harness has been doing.

It reads `/api/work` on mount, **fetched on open and never polled** — the same route and the same
reasoning as [the record panel](#the-record-panel), and the rows change on a pulse at most. Both
surfaces reading one route is also what keeps them from disagreeing about what is outstanding.

Like intake, it draws **nothing at all** when there is nothing outstanding. That is the opposite of the
rule the overview's cards obey, and deliberately: those are gauges an operator glances at the same spot
for, where a card that vanishes when quiet is indistinguishable from one that broke — this is a call-out
above somebody else's list, and a permanent "nothing to record" heading over the tickets table is a row
of chrome saying so on every visit. Ignored rows stay behind a disclosure at the tail, since an ignore
that could only be set would make an accidental click permanent.

That list is only worth a reader's attention while it is **short and true**, and for a time it was
neither: a job requeued after a crash, and a job promoted from a finding, both named the tracker item
they stood in for and neither was adopted by it, so the panel filled with rows reading
`Requeued: Plan issue #35699` — a tracker link on the face of the row and a filing button beside it.
The predicate did not change; the fold's [third adoption arm](16-http-api.md#get-apiwork) did, and the
rows cleared themselves on the next pulse. Worth stating because it is the failure mode a surface like
this one has: a list of things that are owed is read exactly as long as everything on it is owed.
→ [16](16-http-api.md#get-apiwork)

### Two controls, and no more

This tab used to state that nothing in it changed the world. That was true of a record and is false of
a work surface, and the sentence changed with the code rather than after it. What it says now is
narrower and holds: **the watch switch and the intake override, and nothing else.**

- Both write through calls that already existed — `POST /api/issues/:number/watch` and
  `setIssueAssay` — so the merged surface introduces no new way to change the world.
- The switch is **two-valued**, in both directions: Watch adds the tag, Unwatch takes it off, and
  there is no third state to draw or to land in.
- **A container cascades, and the heading says so before the click** — `cascadeNote` states the
  number it will reach, because a click that writes eight tags must say eight. A container is still
  never dispatched at; the rows under it are the work.
- It is **inert on a frozen row** (nothing in the tracker left to tag), on a row the world no longer
  holds, and on a deployment with the gate off (`labelPrefix: ''`) — each with a title saying which.
  A button that writes nothing is worse than one that says why.
- **It draws the world's reading of the tag, never the row's.** `watchReading`
  (`web/src/issueGroups.ts`) answers from `Issue.labels` wherever the world holds the item, and falls
  back to `TicketRow.watch` only for the rows it no longer does — which are exactly the rows the
  previous point refuses a click on, so the fallback decides how a dead row reads and never what a
  click does.

  The two disagree, and which is believed is load-bearing. The world is the live one: the route folds
  a confirmed write onto the baseline and the click refetches `/api/state`, so it moves under the
  reader's hand. `TicketRow.watch` comes off the mirror, and this tab **does not refetch its page on a
  click** — it fetches per filter change, not per action ([16](16-http-api.md#get-apitickets)). Reading
  the row first left Unwatch lit and Watch disabled on an item nobody was watching, however many times
  it was clicked: issue #417. The server's half of the same fix is that the route now patches the
  mirror too ([14](14-persistence.md#folding-a-watch-click-onto-the-mirror)), so a reload agrees with
  the click; this half is what makes the click land without one.

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

The strip carries the ident, the nav, the pulse, the fleet cap, and seven readings: **Findings**,
**Lessons**, **Faults**, **Launch**, **Build**, **Record** and **Config**. Each is one subject stated
once, in a plain label-and-number face. None reaches `api.js`: every one is a method on
`CockpitActions`, and the fleet cap is the shared `FleetControl`, which is already on that seam.

**The last two state no number, and they sit together at the tail for that reason.** Every reading
before them is a count or a state — a thing waiting on a person, or where this build stands — and is
_glanced at_; [Record](#the-record-panel) and Config are destinations, _aimed at_, and interleaving them
among numbers that change would put two things you look for in a fixed spot behind two things you read.
Neither is in the nav, and it is one rule keeping both out: the nav is the surfaces work happens **on**,
so a button beside them would say the archive is somewhere work happens and configuration is something
you do rather than the thing you set up once. Record is on the bar rather than a tab for a second reason
of its own — a selected goal outranks every tab, so as a tab the record could not be read beside the goal
that sent you looking for it.

**The ident carries the one way off this bar to a tracker**, and it has two faces onto _one_
destination. Connected, `Raise an issue` is a button opening a compose modal and the issue is created
directly; offline it is `↗ Raise an issue`, the external link it has always been. It sits in the ident
rather than among the readings for the reason the readings are a group at all — each is a gauge on the
fleet or on this build, read left to right as one sentence about what is happening, and "raise an issue"
answers nothing in it. `.cn-issue` sizes it out of the wordmark's weight through a console-owned wrapper,
and `.cn-issue-btn` gives the button the link's colours through the token layer, since `console.css`
styling `.ext-ref` directly is what this stylesheet is tested not to do.

**Both faces go to LubbDubb's own repository, and neither follows `github.owner`/`github.repo`** (issue
#449). Those name the repo the fleet _works on_, which is LubbDubb's only while it is dogfooding itself.
A fault in the cockpit belongs on the cockpit's tracker whatever repo the deployment is pointed at — the
bug #449 reported was this control filing a cockpit complaint into a customer's backlog. The fallback URL
is a constant in `TopBar.tsx` and lands on the _form_ rather than the repo or the issue list, because the
feature is the number of clicks between noticing something and having written it down; the modal reaches
the same repository through `POST /api/issues`, which files with the operator's own `gh` login
([15](15-integrations.md)).

**The compose modal is gated twice, and every refusal lands on that link** (issues #413, #449). One cut
is made before it opens, and it is `view.connected` alone: a modal that posts to this harness's own
server has nothing to post to with the socket down, which is precisely when an operator has something to
report. `config.canFileTickets` is deliberately _not_ in this gate any more — it says whether the tracker
the fleet is pointed at accepts new items, which since #449 has nothing to do with where this goes, so an
Azure deployment and a read-only tracker both compose. The second cut is live: the modal fires
`GET /api/issues/filing-target` on mount and **holds the title and body disabled until it answers**,
because the byline is not the harness's credential but whichever account `gh` is signed in as. So the
head names the target and that identity — `AdamAwan/LubbDubb as octocat` — before a word can be typed,
and a probe that answers `available: false`, or that cannot be reached at all, shows the CLI's own reason
and offers the external form. → [15](15-integrations.md), [16](16-http-api.md)

Three rules the modal keeps. The submit is dead until **both** fields are non-empty, trimmed, which is
the rule `RaiseIssueBody` enforces rather than a second opinion about it. A failed post keeps the modal
open with the text intact and quotes the server's refusal — losing what the operator just typed is the
one outcome here worth writing code to prevent. And the watch label is an **opt-in checkbox, off by
default, drawn only where the probe says `watchable`**: it is what makes the fleet pick an issue up, so a
checked box would mean agents are working a thought before its author has finished reading it back — and
on any deployment but the dogfooding one the report lands in a tracker these agents never sweep, where
the box would be a promise nothing keeps. The done state is an external link to the new issue rather than
a `<Ref>`, for the same reason the wire carries a URL: `issue:<n>` resolves against the fleet's tracker,
which is the one place this did not go. The open state is local `useState` and not `Place`, for
`GoalPage`'s reason — a half-typed report is not somewhere you can come back to, so it is not somewhere
the URL should be able to send you.

**Spend, Yield and Output are not on this bar.** They were three readings of one subject — what the
fleet cost, what it landed, how much of that survived — and each of the three had grown a version of the
other two on the panel behind it. They are the [Insights](#insights) destination now, which is in the
nav: a reading you go to and come back from rather than a number you glance at, and one whose *window* an
operator changes rather than accepts. What is left here is what a glance can actually settle — counts of
things waiting on a person, and the state of this build.

Three rules hold them:

- **A reading that opens something carries a chevron; a reading that acts does not.** `Scan` presses
  to run a pulse rather than opening a panel, so it wears the same raised chrome and no chevron — a
  reading that opens something and a reading that does something are different promises, and the
  chevron is the only thing that says which. Scan stays pressable while paused or held: that is
  precisely when an operator wants to confirm nothing moves.
- **A zero count mutes a reading; it never removes it.** The gauge staying put is what lets an operator
  glance at the same spot every time rather than hunting for a control that reflows when its number
  happens to hit zero.
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

Six panels open from the bar, the ask panel opens from a queue row ([the rail](#the-queue-rail--needs-you)), and Settings is a shell-owned modal beside them:

- **Findings** — the shared `FindingsPanel`, with promote / file / dismiss. The count is findings at
  `open` and nothing else: promoted, filed and dismissed are done, and `filing` is decided. Nothing in
  the dispatcher reads `findings`, so those three buttons are the only way one becomes anything.

  **The promote button says what promoting _this kind_ does.** On a `docs` claim it reads "Queue docs
  PR", because the click produces a pull request against the worked repository's own documentation and
  not a fix for the thing described — "Queue job" there would read as scheduling the work the claim
  names, which is a different decision the operator did not make. Every other kind keeps "Queue job"
  (`PROMOTE` in `web/src/components/FindingsPanel.tsx`, keyed by kind so a fifth kind cannot be added
  without answering the question). The kind chip and its tooltip come from the same map they always
  did. → [13](13-jobs-and-findings.md#the-four-kinds)

- **Lessons** — the shared `LessonsPanel`: what working a goal taught about working this repository,
  the composer that writes one down, and the promote / retire buttons that are the only way one moves
  (#355). Three sections, because the three statuses are three different questions — _what wants a
  decision_, _what is vouched for_, _what did we stop believing_. The count is lessons at `proposed`
  and nothing else, for the Findings count's reason: a count of what is already promoted would tick
  up on the operator's own click and never come down.

  Three things about this panel are load-bearing rather than presentational. **Retired lessons are
  drawn**, muted, rather than dropped: this is the surface one prunes from, and a row that vanished
  on being pruned would leave no way to tell a list you have finished with from one that lost rows.
  Every card carries its **provenance**, the goal it was learned on drawn as a `<Ref>` and the date
  beside it, since those are exactly the two things a bare block of assertions strips — and since
  #355 phase 3 they are rendered to the agent too. Retire is a `ConfirmButton`: it is the one
  irreversible act on the surface.

  And every **promoted** row says whether agents are actually getting it — a `sent to agents` chip,
  or `over the cap`. Promoted lessons are rendered into the fleet's system-prompt append newest-vouched
  first, up to `lessonBlockChars`, and whatever does not fit is dropped whole
  → [10](10-agent-runtimes.md#the-lesson-block). The agent is never told the list it reads is partial —
  a partial list presented as whole is the failure the cap exists to bound — so this panel is the only
  place a dropped claim is visible, and the only place something can be retired to make room for it.
  Per row rather than as a count, because "two are over the cap" leaves the operator to work out
  _which_ two before they can act. `rendered` is computed server-side by the same `renderLessonBlock`
  the launch calls (`LessonView` in `src/wire.ts`), never re-derived in the browser: a second
  implementation of "what fits" would be free to disagree with the one that actually ran.

- **Faults** — the recorded failures, forty rows, the surface you went looking for rather than a crop
  for a column. It offers a **two-step clear**, drawn **above** the rows and **at zero rows as well**:
  nothing in the harness reads the fault log back, so a clear costs nothing anything decides on, but it
  costs the only copy and for every cockpit rather than this one. One misclick between "leave" and
  "delete the only copy" is too few, and the only route to it must not depend on there being rows.
  Amber, never red — the log blocks nothing.
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

- **Record** — the durable work graph, `RecordPanel`, which was the console's second nav destination
  until every part of it found a better home. It is the one surface here that carries no count and no
  verdict: an archive, consulted when a question sends you to it. → [the record panel](#the-record-panel)

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

**The ident survives it whole, tracker link included.** `Ident` is one component drawn by both arms of
`TopBar` — the lamp turning red is the only difference — because a socket that just went down is a
moment an operator has something to report, and a way to report it that is only there while the harness
is healthy is missing exactly then. Both arms are asserted, since the offline one is the return a change
to the bar forgets.

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

### Configuration

Configuration is a **page** (`web/src/components/ConfigPage.tsx`), reached from the Config reading in
the top bar and addressed as `?tab=config`. It was a modal with three tabs until the surface outgrew
it: fifty keys, five sections and a file to reconcile against is a thing you work in rather than glance
at and dismiss. The decisive argument is smaller than that, though — **a modal cannot be linked to**,
and "look at what `agentMode` is set to on the box" is a URL now.

It is not in the nav. The nav is where you **go** — the surfaces an operator moves between during a day
— and configuration is not one of them: a button beside the others would say it is a fifth thing you
_do_ rather than the thing you set up once, and the reading in the bar is where an operator already
reached for it. That is the rule [Insights](#insights) is in the nav under, and the earlier phrasing of
it — "the three surfaces work happens on" — did not survive contact with a destination that is read
rather than acted on. `?settings=1`, which opened the modal, is
honoured as a way in for `?tab=backlog`'s reason.

Its place is on `Place`, never a `useState`: the section (`?section=`) and the group of keys it is
showing (`?keys=`). `keys` rather than `group` because the tickets tab already owns `?group=` — two
surfaces reading one parameter is a page that opens showing whatever the other one was set to, which
`test/cockpitPlace.test.ts`'s round-trip caught on the day it was written.

Seven sections: **Values**, **Raw file**, **CI policy**, **Prompts**, **MCP**, **Notifications**, **Theme**. Fetched on
open for the prompt book's reason — the config is read once at boot, so polling would be paying for a
constant; the page re-reads after a write and when the socket says the file moved. Values are grouped,
and each one that differs from the built-in default is marked: the question an operator opens this to
ask is not "what are the values" but "what did I change", and answering it needs a baseline, which is
why the server computes the comparison rather than shipping the object alone.

It was read-only until #401, on the argument that a write route's honest answer to "when does this take
effect" is "at the next restart". The answer differs per field, the harness knows which is which, and
the form says so **per row** rather than the surface claiming one answer for fifty keys. Three facts
per row all come from the server for `isDefault`'s reason — a browser that decided them would be a
second copy free to drift:

| Drawn from                  | Decided by                                                                 |
| --------------------------- | -------------------------------------------------------------------------- |
| the widget                  | `entry.type` — `configFields.ts` ([02](02-configuration.md#fields))        |
| applies now / needs restart | `entry.live` — true only where `configApply.ts` holds an arm               |
| not editable                | `entry.env` (the environment beats the file), or `access: 'fileOnly'`      |
| where the value came from   | `entry.env`, `entry.isDefault` and `entry.fromProject` — one of four words |

**Four words, because there are four layers.** `env`, `file`, `project` and `default`: a harness
pointed at a repository carrying a `lubbdubb.project.json` is running a config assembled from two
files, and only one of them is the one this page writes ([02](02-configuration.md#the-project-layer)).
A team's value drawn as `default` would send an operator looking for a key their own file does not
have — and a row cleared while the project sets it says it will fall back to the project's value,
because it will. `isDefault` is therefore _what you would have without your own file_, which is the
same question as "what does clearing this leave", since the form writes one file and nothing else.

A `colourMap` is the one `entry.type` that draws more than a field: `issueStateColours` becomes a
swatch per state over a `datalist` of the state words the tracker is currently reporting, read off the
world the page already holds rather than fetched again ([02](02-configuration.md#fields)).

Each swatch is `ColourField` (`web/src/components/ColourField.tsx`), the same control the
[Theme](#the-theme) section uses — the picker and a hex field beside it. **That is the only thing the two
share, and deliberately so:** a tracker state's colour is a harness setting in `lubbdubb.config.json`
that every operator sees, and a theme is one browser's preference; tying them together would put one of
them in the wrong place. What is worth sharing is the mechanics of picking a colour, which were got
wrong twice independently — `onChange` on a colour input fires only when the picker closes, and a colour
input speaks `#rrggbb`, so dragging one over an eight-digit value silently drops the alpha. Validity is
still the caller's: a state colour is `#rrggbb` only, a theme token admits three, four, six or eight
digits. `test/console.test.ts` asserts no second colour input exists anywhere under `components/`,
because writing one is a one-line temptation and only one of the two would get the next fix.

Saving writes `lubbdubb.config.json` and nothing else — never the project's file, which belongs to the
team and changes by a commit — and the files stay the source of truth: editing either by hand lands on
the same apply path ([02](02-configuration.md#the-watcher)). The project's path is named in the page
header when there is one, so an operator whose harness is behaving unlike their config says can see
that a second file is in play at all. A **reset clears the key**
rather than writing the default back — the browser is never told what a default _is_, only `isDefault`.
Staged edits are counted in a save bar and nothing reaches the file until the write; a save whose
baseline has moved is refused with "reload" rather than clobbering whoever moved it.

**The write goes through a review step** (`ReviewWrite.tsx`), which draws its diff from the _server's own
candidate bytes_ (`POST /api/config/preview`) rather than splicing the file in the browser. That is the
whole reason it can promise anything: the edit that preserves comments, key order and every untouched
line is server code, and a second implementation of it here would be free to disagree with the one that
actually writes — silently, and in the direction of "your file is fine, honestly". Beside the diff, each
change says whether it applies now or waits for a restart.

**The Raw file section** is the escape hatch that keeps the rest of the page a layer rather than a
replacement: the same bytes, edited as a file, for everything a form cannot draw — a key this build does
not declare, a comment, a block being restructured. It is not a way to brick a deployment, because the
check is the loader's own: the preview route builds the config the text would produce and hands back its
refusal, so a removed key is named here exactly as it would be at boot. The file moving under an unsaved
edit is a first-class state — the page is told, and says so, rather than writing over whoever moved it.

**Paths, Server and the agent command line sit behind an advanced disclosure** with a warning. Not
because they are harder, but because `repoRoot`, `dbPath`, `host`, `port` and `auth` can leave an
operator unable to reach their own cockpit, and an `--allowedTools` in `claudeArgs` silently drops the
harness's own MCP grants (`CLAUDE.md`).

What has reached the file and is waiting for a restart is drawn as a **pending block**, with an
_Apply and restart_ control that pauses dispatch and hands this process off to the supervisor. Where no
supervisor launched it (`canRestart: false`) the reason is drawn instead of the button: a control that
would stop the harness without bringing it back is worse than none.

Two values would make the block a lie, and are drawn separately: `maxConcurrentAgents` and
`startPaused` are both shadowed at runtime by `RuntimeControl` ([09](09-execution.md)) and revert on
restart. The page shows the live cap and pause state from `control`, naming the configured value it is
overriding where the two differ. Both halves of that pair are read out of the same fetched block, so
they can never come from two readings that disagree. Saving `maxConcurrentAgents` re-seats the live cap
as well as the configured one; the live one stays ephemeral.

Nothing is redacted, and that is not an oversight: `Config` holds no secrets by construction
([02](02-configuration.md)), which is the same rule that keeps `GITHUB_TOKEN`, `AZURE_DEVOPS_PAT` and
`LUBBDUBB_TOKEN` in the environment. `auth.tokenFile` is a path worth reading, and blanking it would
hide a useful value while implying the invariant is not real.

### Notifications

A preference of the _browser_ rather than of the harness — held in `localStorage` beside the token and
never sent anywhere, which is why two people on one deployment can want different things without either
being wrong. It is the one thing on this tab that is not a config key at all.

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

**One notification per category per batch.** The diff is per subject, and that is the right record of
what is new — it is not the right number of interruptions. A cascade records thirty errors inside one
pulse and a restart fills the queue rail in one go, so an operator got thirty desktop banners for one
event and ten for one glance's worth of work, every one of them saying the same thing: go and look at
the cockpit ([#458](https://github.com/AdamAwan/LubbDubb/issues/458)). `coalesce` folds a batch to a
single notification per category — three subjects named, the rest counted — because what each row _is_
lives in the queue rail and the error list, which is where it gets answered. A batch of one is left
exactly as it was, tag and all. The summary's tag is the first subject's plus the batch size: stable
for the same batch, so a re-render replaces rather than repeats, and different for the next one, so a
second burst stacks beside the first instead of overwriting its count with a smaller number.

**A null previous snapshot yields nothing.** The first state after a load, a reconnect or a token
entry seeds the comparison. Without it every row already waiting announces itself at once — a storm on
exactly the deployments with the most waiting.

### The theme

A preference of the _browser_, for [Notifications](#notifications)' reason exactly, and the second thing
on this page that is not a config key: `localStorage` under `lubbdubb.theme`, never sent anywhere, no
route and nothing on the wire. Two operators on one deployment want different colours and neither is
wrong. The whole feature is `web/src/cockpit/theme.ts`, `web/src/cockpit/tokens.ts`, `web/src/theme.css`
and `web/src/components/ThemeSettings.tsx`.

#### What is stored

A preset id and a **sparse** map of the tokens moved off it — not a snapshot of all hundred-odd. Two
things fall out of sparseness that a snapshot would lose. Switching Dark → Light keeps three deliberate
edits, where a snapshot would carry ninety dark values into Light and produce a hybrid nobody chose. And
a token added in a later build themes itself, because an absent key means "whatever the preset says"
rather than "the value that was current when this was written".

There is deliberately **no `version` field**. Every field is validated on the way in, as
`loadNotifyPrefs` does it; a version number is a promise to write migrations for a preference cheap
enough to lose. Two degradations are worth naming because both are one line to get wrong:

- **A renamed preset** resolves through `PRESET_ALIASES`, the `TAB_ALIASES` idea from `place.ts`. An
  unknown id falls back to Dark **keeping the overrides** — landing on Dark with your edits intact is
  recoverable, a wiped theme is not.
- **A token removed in a later build** has its override dropped on load, rather than retained and
  ignored, because a retained `--foo` gets re-applied the day someone adds a token by that name meaning
  something else. The drop is not persisted until the operator saves, so upgrading, looking and going
  back loses nothing.

Values are validated against a grammar per `kind`. That is not tidiness: they are handed to
`style.setProperty`, and a custom property substituted into a property that accepts a URL is the
ordinary shape of CSS-variable injection. A colour is a hex literal and nothing else — which is why the
four overlay tokens are eight-digit hex rather than `rgba()`, since alpha is part of their value and a
colour input cannot express it in any other form.

#### The presets

Nine, and **Dark has no block**: Dark _is_ `:root`, which is what makes it the default with no second
copy of the palette to drift. The other eight live in `web/src/theme.css` as `html[data-theme='x']`.
Five are ports — Solarized Dark, Monokai, Dracula, Atom One Dark, Moonlight — one is Light, one is High
contrast, and **Amber is not a port of anything**: a warm low-blue palette for a room with the lights
off. Amber is deliberately _not_ monochrome, which is the obvious reading of an amber phosphor screen and
the wrong one here, because this cockpit carries verdicts in colour and a green that is amber makes a
passing pipeline look like a failing one.

They are CSS rather than a TypeScript table because eight at sixty-three tokens each is 504 values: in a
module they would ship in the JS bundle and nobody could review them against the sheet they override.
`html[data-theme='x']` counts (0,2,0) against `:root`'s (0,1,0), so a preset wins on **specificity, not
order** — which matters because Vite injects styles through JS in dev and extracts a stylesheet in
production.

A block declares only the tokens whose `:root` value is a **literal**; the `color-mix` ones follow from
the core on their own. That rule is not written down anywhere but the CSS itself — the test derives the
required set by reading `:root` — so adding a core token makes every preset fail until it has an answer.
Each preset was built from ~27 anchors with the tints derived by the same ratios `:root` uses, and the
ratios differ between a dark theme and a light one on purpose: 31% of a hue over a dark ground is a
border you can see, and the same 31% over near-white is a tint you cannot. What stays constant is the
contrast against the ground, not the proportion.

Two of the ports needed a value changed to be usable rather than faithful. Dracula's comment grey and
Monokai's sit at 2.4 and 2.2 against their own panels — fine for a comment, too quiet for the secondary
text this UI puts there — so both are lifted. Every text pair in every preset clears 3:1.

#### How it reaches the DOM

Two mechanisms, one per half of the shape, mirroring the split VS Code makes between a theme
contribution and `colorCustomizations`:

- the **preset** is `data-theme` on `<html>`, because the palettes are CSS and a block wins on
  specificity;
- the **overrides** are inline custom properties on the root element, because only those express a
  sparse set — one `setProperty` per moved token.

The default preset **removes** the attribute rather than writing `dark`, so each theme has one spelling
in the DOM, for the reason `placeQuery` omits defaults.

`applyTheme` visits **every** registered token, not only the overridden ones. That is what makes it
idempotent and two-way: applying a draft that has dropped a token clears it, where tracking what was set
last time would leave a reverted edit standing — the bug that makes live preview one-way.

#### Before the first paint

Vite extracts the stylesheets to a blocking `<link>` and `main.tsx` is a deferred module, so the browser
can paint `body{background:var(--bg)}` from `:root` well before any of our code runs. Applying the theme
from the bundle therefore shows a dark frame and then a light one, on every load, to everyone not on
Dark. So `web/index.html` carries a **classic inline `<script>`** in `<head>`: synchronous at parse time,
before `<body>` exists.

It is a second implementation of "apply", and that is the cost of the feature. Two things contain it. It
knows the storage key and nothing else — no registry, no preset list — so it never needs editing when
either grows; and `applyTheme` runs moments later and _does_ filter against the registry, so a stale
override the script over-applies is corrected rather than needing to be kept in step. What has to stay in
step is the key, and `test/cockpitTheme.test.ts` asserts the HTML names the string `THEME_KEY` exports.
Renaming it otherwise leaves the script reading a key nothing writes, and the only symptom is a flash of
dark nobody can attribute.

`applyTheme` is then called once at **module scope** in `main.tsx`, not from a hook: `<StrictMode>`
double-invokes effects in dev, so a mount effect with a cleanup would apply, revert and apply again.

#### Paper is not a theme

The print block restates every literal colour token, and the mechanism is worth understanding because it
is what the rule rests on: it declares them **on `#print-sheet`**, and a declaration targeting an element
beats any inherited value — including an inline one on `<html>`. So the theme cannot reach paper. That
only holds for tokens the block actually restates, though. Restating the greys was enough while every
preset was dark; with Monokai or Dracula live, an unrestated warm tint prints as a dark smudge on white.
So paper owes every literal an answer exactly as a preset does, and is held to it by the same test.
`theme.css` names no class selector at all, and in particular never `#print-sheet`.

#### The section

Live preview: a change applies to the whole cockpit as it is made, with **Revert unsaved** and **Save**.
"Revert unsaved" rather than "Revert" because with the preview already applied, "Revert" is ambiguous
between "undo my edits" and "back to the preset" — the latter is a third control, **Reset to ‹preset›**,
which sits beside the picker rather than in the save bar because it is a statement about the preset and
not about the edit.

Three things about the drawing that are decisions rather than details:

- **The picker writes the DOM, React does the bookkeeping.** `onInput` calls `applyToken` straight to
  `documentElement.style` — that _is_ the preview — and `setState` only so the rows and counts redraw.
  React never sits in the drag path. It must be `onInput` and not `onChange`: Chrome fires `change` on a
  colour input only when the picker is dismissed, so `onChange` alone gives no live preview at all.
- **Leaving the section with unsaved edits keeps the preview**, because the whole point is to go and look
  at a real goal page in the theme you are building. So the applier is a plain call and **never an effect
  whose cleanup reverts it**, and the bar states the cost: a reload drops them. Saving is not a visual
  event — the colours are already on screen — so the bar has to make a statement, or a Save that appears
  to do nothing gets pressed twice.
- **A preview card cannot lie about its preset.** Each preset block in `theme.css` carries a second
  selector, `[data-theme-swatch='x']`, and a card is a `<span>` with that attribute whose swatches read
  `var(--bg)` and friends — so a card's colours arrive through the same declaration block as the theme.
  Dark needed its own four-value block for this and only this: with no rule to match, the Dark card
  inherited whatever theme was live and drew Monokai's colours while offering Dark. The one card that had
  to be honest about the default was the one lying about it. Those four values are the feature's only real
  duplication, and the test holds each against `:root`.

Each row names the property as well as labelling it, because `--panel-2` is what appears in a bug report
and a label alone cannot answer "which token is that". It also carries one line of _what will change_,
which is the question a colour picker actually raises. The registry (`tokens.ts`) holds all three, and the
reset control is drawn only on an overridden row — a hundred disabled buttons is furniture. Search covers
name, label and reason together, since someone typing "border" and someone typing "the line between two
cards" are both after `--border`. Radii and typefaces are in as well as colours: the two halves of the
cockpit disagree about corners today (`--r-*` are all `0`, `--cn-r` is `8px`), and the theme page is where
that becomes choosable.

Not on `Place` — see [the address bar](#the-address-bar). Deliberately untested: whether a colour _looks_
right. There are no WCAG assertions in the suite and no screenshot diffing; the presets were checked for
contrast when they were written, and the section offers the operator no opinion about what they pick.

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
it cannot claim a routing the dispatcher would not take. Read-only, and deliberately: `ci.checks` is an
**ordered** rule list where the order is the semantics, so a rule editor is its own shape and its own
decision. The config tab saves the list _whole_, which is the part #401 covers.

### The MCP tab

`web/src/components/McpTab.tsx`, reading `GET /api/mcp` ([16](16-http-api.md#get-apimcp)). How the
operator points their **own** Claude Code at this harness, in the three steps it actually takes:
register the bridge once, ask for a check with `/lubbdubb 284:C`, and what the channel can do when it
answers.

**The tab exists because the one manual step in an otherwise unconditional channel had nowhere to be
read.** Every start binds the socket, mints the credential and rewrites the skill; the operator's half
is a single `claude mcp add`, and it was written down in two places, neither of which is where anybody
looks: a boot line that has scrolled away, and [11](11-mcp-tools.md#the-desktop-channel). A channel
nobody registered fails the way this repo's sharp edges do — the **Copy desktop prompt** button on a
goal's validation section reaches nothing, and a harness that never asks for a check to be run here
looks exactly like one that has no checks needing it.

**Nothing on the tab is written down in the cockpit.** The command line comes from the channel's own
`registration()`, the paths from `validation.*`, the tools from what `tools/list` would answer — see
[16](16-http-api.md#get-apimcp) for why each is asked rather than composed. What the tab adds is the
one thing a payload cannot carry: the argv **quoted as a shell needs it back**. `process.execPath` is
routinely `C:\Program Files\nodejs\node.exe`, and unquoted that line registers a server
called `C:\Program` — which succeeds, and fails later as a channel that will not connect.

A channel that is not listening is said so, above a command that is otherwise correct: the stable
socket is refused when another harness already holds it, and the honest answer is what the tab draws
rather than a registration that would connect to the other one.

## Insights

`web/src/components/InsightsPage.tsx`, the fourth destination in the nav. It replaces three surfaces —
the Spend modal, the Yield modal and the Output panel — and the reason is not that they were busy: they
were the **numerator, the denominator and the leakage of one ratio**, and each had independently grown a
version of the other two. The output graph drew a cost row; the yield panel drew four dollar figures; the
spend trend drew a completion rate off a second server builder, one click from the first. That is the
shape of a wrong seam.

**One page, one window, five readings of it.**

- **Economics** — is the fleet worth what it costs? The ratio headline, the phase split, the timeline,
  the goals and the costliest runs.
- **Reliability** — did it finish, and did it go green? Outcomes, the CI timeline, the reddest pull
  requests, the phase health and the repeats.
- **Causes** — what keeps sending the fleet back? The guard split, both cause tables, and Lately.
- **Trend** — is what I changed working? The eight-period cohort view.
- **Work mix** — why does *this kind* of work cost what it does? By task type, and by failing check.

Every table the three panels drew lands in exactly one of these, and the duplicates collapse on the way
in: there is one phase table rather than two, and one completion rate rather than the reliability fold's
and the trend's.

### A destination, not a modal

The two modals covered the queue rail, and the rail is where the ask that sends an operator here comes
from — a `burn` row saying an agent is running at four times the median for its bucket
([18](18-observability.md#the-burn-watch)). Answering it behind a sheet that hid it was the arrangement.

It also makes the page's state part of [`Place`](#the-address-bar), which the modals' never was. The
window and the open tab are query parameters (`?tab=insights&view=causes&win=24h`), so a reading is a
link somebody can send. The three fields this replaced — `spend`, `reliability` and the `output` panel —
were independent booleans, so `?spend=1&reliability=1&panel=output` was a representable place that drew
all three at once. That is precisely the state `ConsolePanel` is one value to rule out, and these two
escaped it by being modals rather than panels.

**It fetches, so it lives under `components/` rather than `console/`.** The console may not reach
`api.js`, and the sanctioned route is the one the tickets tab and the work tree already take: a component
that fetches, rendered from the situation area, with the place it reads handed in as props.

### The time bar

One control, **above the tabs rather than inside one**, because it is page state: switching tabs keeps
the window, and every reading under it obeys the same one. That is the whole argument for the five
sharing a surface.

Five windows — `6h`, `24h`, `7d`, `30d` and `All` — resolved server-side by `resolveWindow`
(`src/insightsWindow.ts`) and shipped back on every payload
([18](18-observability.md#the-window)). **The page draws the window it was handed, never the one it
asked with**: a caption derived from the key is free to disagree with the buckets the server actually
cut, and the caption is the half a reader would believe. The resolution is stated beside the control —
`6h buckets` — rather than left to be counted off the bars.

Before this, each reading picked its own span and none of them lined up: six hours for the production
graph, five and seven days for the spend tiles, a fortnight for the spend timeline, another fortnight
for CI, eight weeks for the trend — and all-time for the run half and the spend totals. Two figures side
by side on one surface described different stretches of the fleet's life with nothing saying so.

**The Trend tab obeys it too**, by showing the last eight windows *of the length the operator picked*:
`7d` gives eight weeks, `24h` gives eight days ([18](18-observability.md#the-spend-trend)). That is what
keeps one control meaningful on a tab that is inherently about change, and it has a second payoff — the
comparison a headline draws against "the previous window" is literally the last two bars of that chart,
rather than a second notion of "before" for a reader to reconcile.

### Economics

**The ratio is the headline**, read left to right as one sentence: what the window cost, what landed in
it, what one landed change therefore cost, and how much of the spend never landed at all. The operators
between the tiles are drawn because they *are* the reading — four unrelated boxes would leave the
division to the reader, which is what three separate panels did.

- **Landed is pull requests merged**, not goals closed. A goal closes when a person says it is done,
  which can happen without the fleet having landed anything; a merge is the fleet's own output. It is
  the event the production graph counted, now asked over the same window as the money beside it.
- **A window with nothing landed draws no ratio at all.** Dividing by zero gives `Infinity`, and a fleet
  that spent forty dollars and landed nothing is the single most important state this tile has to render
  honestly — as the sentence it is, not as a symbol.
- **Never landed counts failures and crashes only.** A killed run is a steer, and counting an operator's
  own change of mind as waste makes every steered fleet look broken.

Under the headline: the phase bar and its legend-that-is-a-table, the cost timeline at the window's own
resolution, the goals ranked with the phase split inside each row, and the costliest runs — capped, and
**saying so**, because a silently truncated table reads as a complete one. A row in that last table can
be a **local run** rather than an agent, named by the branch it was pointed at, because the table ranks
what money went on and an operator's preview is money ([23](23-local-runs.md#what-it-costs)).

The timeline is drawn as **bars, not lines**: these are totals over a period rather than samples of a
rate, and a line between two buckets implies money moved smoothly between them, which is exactly what a
fleet that ran for one afternoon did not do. Each goal row's bar is drawn at the width of its share of
the window's spend and split by phase inside, so it carries two readings at once: how much of the
budget this goal was, and what inside it the money went on.

**Nothing here is derived in the browser.** The server ships the splits, for the reason `PrAttention`
and `StackLandingView` are shipped: a cockpit-side re-derivation of which goal a pull request's money
belongs to would be a second opinion about a decision made elsewhere, drawn inches from the first. What
the cockpit owns is presentation — the phase **colours**, which live in the stylesheet as `--sp-<phase>`
so the component names a phase and the sheet decides what that looks like. There are eight phases and
seven hues that read apart at swatch size, so `--sp-local` is a `color-mix` of two rather than a
literal — a hex at a use site is a swatch that stays put when somebody switches theme
([tokens](#tokens)).

**Fetched on open, three states, and the third is the point.** Loading, the reading, and a *failure* —
because a fetch that failed must not render as a fleet that has spent nothing. `$0.00` is a real answer
here (a fresh harness, or one run entirely in PTY mode), so it cannot also be the failure mode. The
all-unmeasured case gets its own sentence rather than a table of zeroes: **unmeasured is not free**.

### Reliability

Spend's twin, and built as one deliberately: the same chrome, the same tables, the same phase
vocabulary. Four tiles, the outcome bar, the CI timeline, the reddest pull requests, the phase table and
the repeats.

**Both halves are measured over the page's window.** The run half used to be all-time and the CI half a
rolling fortnight, so a completion rate and a red rate sat side by side describing two different
stretches. What replaces the note explaining that is the one thing a single window makes newly worth
saying: a rate over a short window is a rate over few runs, and the reader deciding whether to act on
64% wants to know it is 64% of eleven.

The outcome **colours** live in the stylesheet as `--rl-<outcome>` and differ in kind from the phase
palette on purpose — a phase is a category whose colours only have to read apart, while an outcome is a
*verdict* and carries the alarm vocabulary. Grey is doing real work in it: a killed run is not a fault.

A fleet with runs still out and none settled gets its own sentence rather than a table of zeroes —
**not yet is not perfect**.

### Causes

Drawn on a tab of its own rather than as the third block of the reliability panel, and it is the section
that gained most from the move: three tables and a quotation list read *below* two other readings is
where an operator stops scrolling, and this is the one surface on the page that shows the taxonomy is
being used rather than guessed at ([18](18-observability.md#causes-why-the-fleet-came-back)).

The guard split leads it as one bar and a legend, ordered by what acting on each costs; the two cause
tables follow, one per kind, ranked by accounts with the empty causes kept at the foot — "nothing was a
flake this window" is a reading, and a table that dropped its own zero rows could not make it. Then
**Lately**: the most recent accounts in the agents' own words. The section's caveat is drawn with its
total rather than in a footnote — every share in it is a share of what was *reported*, and
`unaccounted` is what says how much that is.

### The Trend tab

`web/src/components/SpendTrendTab.tsx`, drawing `GET /api/spend/trend`
([18](18-observability.md#the-spend-trend)). Three sections, each headed by the question it answers, and
**the shared axis is the design**: every chart is the same eight periods at the same x, so a change that
shows up in one is read against the other two without a click.

- **Are goals getting cheaper?** — median cost per closed goal as bars, with every goal in the cohort
  drawn as a point beside it. The spread is drawn rather than summarised because goals differ in size;
  the points are placed by index rather than jittered, since a random offset would reshuffle on every
  render. The current period is **outlined rather than filled** — it is an under-count by construction,
  and a hollow bar is the only honest way to draw a figure that is going to grow.
- **Which stages cost more, and which less?** — the cohort's phase split as a share band, and the same
  shift as **dollars** in the table beneath it. The table is not optional: a stage whose share rose
  while its dollars fell is a fleet doing everything else more cheaply, and the band alone draws that as
  a regression. This is the reading the tab exists for.
- **Has the success rate changed?** — completion rate and red checks per goal on two axes, plus four
  tiles including **reopened after close**. That last one is the honesty check: a fleet that got cheaper
  by closing goals it had not finished looks like progress on every other chart here.

**Colour is the direction the reading moves in, not the sign of the number.** `.sp-delta` takes a tone
from the call site — falling money is `good`, falling completion is `bad` — because deciding by sign in
the stylesheet would paint a halved completion rate green.

**The tab draws figures and never derives them.** Medians, the two halves and the phase shift are all
`buildSpendTrend`'s. When the server withholds the comparison — fewer than two complete periods a side —
the tab says so rather than drawing a percentage off one period of goals.

**It fetches on its first visit for a given window**, which is the settings modal's stance: a tab an
operator never opens should cost nothing. The window is part of that key rather than a boolean beside
it, because a window change invalidates the trend — holding "already fetched" as a boolean is how the
trend ends up drawn over one stretch while everything above it describes another. The fetch hangs off
the *place* rather than the click that changed it, so arriving on `?view=trend` from a shared link is a
first visit too.

### Work mix

The two tables that were the foot of the spend panel, where they were read about once a month and cost
every other reader a screen of scrolling. **A tab is a better fold than a collapsed section**: it is
named, it is addressable, and nobody scrolls past it to reach something else. They are a partition of
the same money Economics totals, cut by what the fleet was asked to do rather than by which phase it was
in — review comments get a figure of their own here, which no phase can give them, and so does
`dotnet test`.

**By task type can hold no local run at all**, and says so. Its rows are keyed on the dispatch rule that
sent the agent and nothing dispatched a local run, so that money is in the total above the table and in
none of its rows — stated as a remainder in the shape the checks table states its own
([23](23-local-runs.md#what-it-costs)).

## Exporting a reading

`web/src/components/Downloads.tsx`. [Insights](#insights) is the surface that
answers a question nobody asks at the glass — what a month cost, split how, and what it bought — and
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
line carrying the time it started, the tool name, its one-line input summary, and — folded off the
result line — the time it returned and the `· N lines` suffix ([10](10-agent-runtimes.md)). Clicking
it reveals the output. Prose reads continuously between them.

The two times on that one line are the answer to "is this still going": a call with no result under
it has been running since the time it names, and the pane no longer looks the same whether an agent
is thinking or died an hour ago. Nothing derives a verdict from them — they are read, not judged,
for the same reason `Agent.notedAt` is (the longest quiet stretches are the long test runs).

- **An error result is never collapsed.** It opens expanded and red, because a failure that hides is
  worse than one that takes up space.
- **Expansion is DOM-only state.** A reseed — an agent switch, or a non-append change to the buffer —
  rebuilds the pane with every block collapsed. Nothing is remembered per tool call.
- **A result folds into the call above it only when that call is unambiguous.** Two tool calls with no
  result between them means the agent fired them in parallel, and the stream carries no ids to pair
  them by; each result then renders as its own standalone collapsed block rather than being attributed
  to the wrong call.
- **The stamp is part of the marker the parser matches.** `TOOL` accepts an optional leading
  `[HH:MM:SS]`; a mismatch there does not misrender, it silently stops folding, which is why the
  round-trip tests below feed stamped output too.
- **Text carrying no markers renders as plain prose** with nothing to collapse — an older transcript,
  or a settled session whose records the tail could not label. Both runtimes write the same markers
  ([10](10-agent-runtimes.md)), so this is the degraded case rather than a mode.

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
plan ([08](08-planning.md#a-plan-is-a-list-of-parts)). Replan is the way out now.

**Discuss…** is an `<a>`, not a button — the only control on the sheet that is. It carries
`desktopDeepLink(config.desktopFolder, discussPrompt(n))` (`web/src/cockpit/desktopLink.ts`), which
opens the operator's own Claude Code on the goal's checkout with `/lubbdubb discuss <n>` prefilled.
A destination belongs on an anchor rather than behind a click handler, and `a.btn` in the stylesheet
is only the three things an `<a>` does not inherit from `.btn` — no colour of its own, because it is
the same control. It is drawn only while the plan is `awaiting_approval`, which is exactly what
`plan_amend` refuses outside of, and only when the plan's origin names a goal number, which is what
the tool resolves a plan by.

The sheet used to show a conversation instead: a fleet planner's status and last note, a reply box
posting through `POST /api/agents/:id/respond`, and an **End discussion** control. That surface is
what the deep link replaced — a conversation conducted one line at a time, holding a fleet slot.

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

## Running locally

A **Local** reading in the top bar's `cn-reads` row, quiet when nothing is up and carrying the goal's
number when something is, opening the running-locally panel
([23](23-local-runs.md#the-cockpit)).

A reading rather than a nav tab, and the distinction is the one `TABS` is built on: the nav is the
surfaces work happens on, and this is a state of the operator's own machine. The **number** is the
value because that is the question — "running" alone leaves somebody opening the panel to find out
whether it is the goal they are looking at, which is the only thing they wanted to know.

`'localRun'` is a member of `ConsolePanel`, so the panel is a **place**: it survives a reload and the
back button steps out of it, exactly as every other panel does. It draws one state and a picker rather
than a table of runs — a list would imply two environments could be up, which is the one thing the
store refuses — and its start button says, where the control is, that starting stops what is running
now.

Beside the ref it draws **what the run has cost**, climbing while the environment comes up. It is the
only spend figure in the cockpit read while the money is still going out, and it is here because this is
where the decision to leave something running is made. Absent rather than `$0.00` when nothing was
measured, the convention every spend surface keeps. The goal page's Spend card names the count in a row
of its own for the same reason: the row above it says "Agents".

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

A card raised by an **unannounced stop** carries a clock. The chip in its head reads `done in 4m 12s`
and the row beside `Open agent transcript` gains **Give me 15 minutes** next to **Mark work done** —
the harness settles that agent itself when the countdown runs out
([10](10-agent-runtimes.md#when-nobody-answers-the-stop)), so the two controls are "zero now" and "not
yet". The deadline comes from the wire's `stallParks` (agent id → expiry) by way of
`view.stallExpiryByAgent`, never from reading the park's sentence — three parks wear the `waiting`
status and only the fleet knows which is which, the same argument `parkedOnLimit` is shipped under.
Every other card on this panel is a question somebody asked, and none of them counts down: a question
that answers itself after five minutes is worse than no question at all.

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
  `done`, `unwatched` — because scanning a list for "what is mine" is what it exists for; the full
  reasons are in the `title`. Four of the seven take a tone (`courtTone`); the rest print plain —
  `unwatched` says which arm it is in the chip and dims its whole row instead, since it is the one arm
  that is about whether the item was opted in rather than where the work got to.
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
  Up next carries one control — the profile picker — and no drag handle; the rail carries only
  `open` human tasks, so there is no settled tail to dismiss from; and the record panel reaches its own
  route directly — the seam keeps the method for the reason it keeps `setStackLanding`.
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

**Every pickup status has a goal in the fixtures.** `issuePickupStatus` answers thirteen ways
([06](06-issue-pickup.md)), and each answer is somebody's whole explanation of why nothing is happening
to their ticket — so `done`, `retained`, `has_pr`, `active`, `container`, `unwatched`, `planning`,
`delivered`, `assay`, `cooldown`, `escalated`, `blocked` and `eligible` are each carried by at least
one issue, with the reason string the real gate would have written. A demo showing eight of them
teaches an operator that the rest are a bug on the day they first appear. The roll-call is
stated in a comment above the `issues` array, and the arithmetic around it has to hold as well: the cap
is 3 with two agents live, so exactly one goal is `eligible` and the rest of the ready ones are
`blocked` — a world with six eligible goals under a cap of three is one the dispatcher could not have
produced. Eleven of the thirteen are reachable by clicking, through the tickets tab's watch filter; `done`
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

Ten files, split on what they can see:

- `test/cockpitViewModel.test.ts` — the derivations `buildViewModel` folds, untestable while they lived
  inside a component.
- `test/needsYou.test.ts` — the merged queue and, first among them, its ordering.
- `test/goalPage.test.ts` — the page's assembly: which parts, PRs, agents and decisions belong to a
  goal, and the prefix trap `issue:14` versus `issue:1`.
- `test/console.test.ts` — the structural rules and the renders, against the demo fixtures.
- `test/cockpitPlace.test.ts` — the [address bar](#the-address-bar)'s codec: the round trip, the one
  spelling per place, and what a hand-typed URL that names nothing reads as. Both whitelists are read
  off their types rather than listed, so a panel or a config section added to one and forgotten in the
  other fails here rather than becoming a control that cannot open.
- `test/cockpitTheme.test.ts` — [the theme](#the-theme) and the token layer, which is also the only
  thing in `check` that reads the stylesheets: no literal outside a declaration, every `var()`
  resolving, the registry and the sheets naming the same tokens in both directions, each token's kind
  matching the value it is declared with, and every preset — and paper — answering every literal.
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
to `ConsoleTab` and forgotten there is a view nothing can reach) and `Work` appearing in none of them,
the work graph reachable from the bar at every tab and over an open goal, the tickets tab mounting the
unrecorded-work call-out and drawing nothing when it has nothing, the recovery banner outside the
situation area, a dropped socket drawing nothing at all, and the shell rendering the drawer the console
only asks for — and no longer the work graph.

## Setup

Three surfaces lead to the first-run panel, and only one of them is permanent.

The **Setup reading** in the top bar counts what is outstanding and is **absent at zero** — a reading
that is always green is one nobody reads, so it earns its place by not being there most of the time.
The **first-run card** on the Overview is drawn only while the harness has not been pointed anywhere,
and is blue rather than amber: it is an offer about a harness that is working, not a warning about one
that is not. The **panel** itself is on `Place` like every other panel, so it can be linked to.

Its three steps are deliberately _not_ on `Place`. A step inside an unsaved edit is not somewhere to
send somebody — restoring "review" on a reload would restore a review of answers the reload has
already dropped. Same exception, and the same reason, as `ReviewWrite`'s on the config page.

→ [26](26-setup.md)
