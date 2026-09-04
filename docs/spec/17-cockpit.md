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
  `EscalationCard`, `RecoveryPanel`, `HumanTaskActions`, `ObstaclesPage`, `LaunchPanel`,
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
covers `--r-*` (radius), `--pad-*` ([the frame's density ramp](#the-frame)), `--font-ui|mono|display`,
and `--border-hi`/`--border-lo`, the light/dark pair that makes a bevel expressible.

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

- **The tokens live in exactly two `:root` blocks**, and the scoped families — `--cn-tone-*` on
  `.cn-t-*`, [`--tone-*` on `.t-*`](#the-tag), `--sp-*` on `.sp`, `--rl-*` on `.rl` — are **pure
  aliases** of them. They have to be. A
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

### Fields

A field — a text box, a note box, a dropdown — is drawn once, at the **element**, in the `fields`
block of `styles.css`. Not as a class, and the reason is the failure it replaces.

Left to the call sites, the cockpit had eleven answers to what a field looks like. Four grounds
(`--bg`, `--well`, `--panel`, `--panel-2`) among sites two rows apart, two radii, five type sizes,
seven paddings — and, because neither an `<input>` nor a `<select>` inherits the page's font, two of
those rules forgot `font: inherit` and drew in the UA's Arial beside Segoe UI prose. Underneath that
was the sharper version: **a bare `<select>` had no rule at all**, so the two on the queue rail that
offer a different parent and a different area path were drawn white-on-black by the platform, in the
middle of a dark instrument. The tick boxes were the same story in one property — no `accent-color`
anywhere but one rule in the plan sheet, so every checkbox in the cockpit drew in the platform's
blue.

None of that is a thing a class fixes. A class reaches the controls somebody remembered to put it on,
which is exactly the set that was already fine; the ones that read wrong are the ones nobody had
looked at. An element selector has no such gap — there is no field it can miss, including the ones
not written yet — which makes this the same argument [scrollbars](#scrollbars) settle the same way:
some of what the cockpit draws is furniture rather than a component, and furniture is drawn once for
everything.

Four decisions inside the block are load-bearing:

- **The type exclusions ride inside `:where()`.** A tick box, a radio, a colour swatch, a file
  picker and a slider are not text boxes and a ground and a padding would wreck them, so they are
  excluded — but `input:not([type='radio'])` counts (0,1,1), which beats every `.pm-note`-shaped rule
  in the sheet and would take the sizing off the twelve fields that had it right. `:where()`
  contributes nothing, so the base weighs (0,0,1) and a single class still wins. A plain `:not()`
  here is the bug, and it is not a subtle one to look at — it is subtle to _write_.
- **`font: inherit`**, for the reason above. It is the one declaration a field cannot be left to
  inherit on its own.
- **The ring is inset** — `outline-offset: -1px` — because fields sit in flex rows at 6px gaps and a
  halo outside one overlaps the control beside it. `:focus-visible`, so a select that has been used
  does not keep a ring while its value is being read.
- **`option` is given a ground.** Chromium hangs the dropdown's list off the control from the
  platform palette unless the options say otherwise, so a dark cockpit otherwise gets a white menu.
  It is one answer for both families rather than one each, and that is the trade: the alternative is
  a `.cn option` — the descendant-element trap below, on markup four shared components render — for a
  menu the platform draws in its own geometry anyway. macOS draws it entirely itself and ignores this,
  which is its right: that one is the platform's menu, not the cockpit's.

What a call site is left to say is what makes its field _that_ field — how wide it is, whether it
grows, a mono face for a cron expression, a smaller size in a dense row. Nothing in either sheet
restates a ground, an edge or a radius, and the one field that overrides its ground says why in place:
`.kn-commit textarea` sits in a panel that _is_ the well, where an inset box on an inset box is a
border and nothing else.

**The console draws its own fields with `.cn-in`**, the counterpart to `.cn-btn`. The base draws in
the page's family, which is a step lighter and a different edge from a console card, so a control the
console draws itself wears the `--cn-*` face instead — same as `.cfg-in` and `.th-search` already do.
It is a class and **not `.cn input`**, and that is the [layering](#tokens) rule rather than a
preference: the console _embeds_ shared components, so a descendant selector on the element reaches
inside the escalation card and the launch composer at (0,1,1) and restyles a component that is
supposed to be restyleable through tokens alone. Until this section was written, `test/console.test.ts`
checked the named classes and nothing checked an element selector — which is how there came to be one:
a `.cn textarea` no console markup needed, silently overriding five shared components' note boxes,
`rows={2}` included, with a 64px floor. It guards both shapes now.

**`accent-color` is settled by container, not by control.** It is one property the browser owns the
shape of, and the only thing the cockpit gets to say is which hue — but the two families genuinely
differ here, `--accent` being orange and `--cn-accent` blue, so a single answer is wrong on one of
them. So `body` carries the shared hue and `.cn` carries the console's, and each tick box inherits
whichever surface it landed on with no call site naming either. Keyed on `input[type='checkbox']`
instead it would not work at all: a declaration on the element beats an inherited one unconditionally,
so the console's answer could never reach a box inside the console.

### Scrollbars

Left alone, a scrollbar is the one thing on the screen the theme does not reach: the browser draws it
from the platform's own palette, so a dark cockpit gets a light grey bar down its side and every
preset gets the same one. Three tokens fix that — `--scrollbar-track`, `--scrollbar-thumb` and
`--scrollbar-thumb-hover`, on `:root` in `styles.css`.

**They are overlays, not tints of a ground.** Each is `--text` at a low alpha over `transparent`,
because a scroll pane's ground is `--cn-bg` on the overview, `--panel` inside a modal and `--well` in
a transcript: ink over whatever it happens to be over reads on all three, where a mix of any one of
them is a stripe on the other two. It also means the bar inverts with the theme for free — near-white
at 24% on Dark, near-black at 24% on Light — so no preset owes them a value.

**There is one family, and it is the shared one.** A scrollbar is furniture rather than a component,
drawn on both families' grounds, so it is neither's — which is why `console.css` says nothing about it
at all. The alternative, a `--cn-scrollbar-*` declared on `.cn`, is the shadowing trap above in its
worst position: it would sit on the element that contains nearly every scroll pane in the cockpit, so
an operator's override of the scrollbar could reach almost nothing.

**Both grammars are written, and exactly one is ever live.** Firefox styles a scrollbar through
`scrollbar-color` / `scrollbar-width` and has no `::-webkit-scrollbar`; Blink and WebKit do the
opposite, handing a box a fully custom scrollbar as soon as a pseudo-element rule applies to it and
ignoring `scrollbar-color` from then on. So the standard properties sit behind
`@supports not selector(::-webkit-scrollbar)`. Written unguarded the two would not conflict so much
as make it unknowable which one a given browser drew. The gate fails safe in the right direction: an
engine too old to evaluate a `selector()` query leaves the `not` false and keeps the pseudo-elements,
which is the grammar such an engine supports.

The thumb's corner is `var(--r-sm)` — square with the rest of the instrument by default, and it
follows the operator's [Corners](#the-theme) rather than deciding for them.

## Shape

Five surfaces and one shell.

```
┌──────────────────────────────────────────────────────────────────────┐
│ ident │ Overview Tickets② Obstacles Insights │ Fleet ⏸ 14s │ Issue! Claude ↗   62%⁵ʰ / 30%⁷ᵈ │ #390  ☰ │ top bar
├────────────────────────────────────────────────────────────────────────┤
│ the recovery banner, when a previous run left work orphaned            │
├───────────────┬────────────────────────────────────────────────────────┤
│ NEEDS YOU  6  │  ‹ Overview / #142 Retry the intake   ← only on a goal │
│ ┌───────────┐ │                                                        │
│ │ Blocking  │ │                                                        │
│ │ escalation│ │             the situation area                         │
│ │ plan      │ │  (a tab — overview, tickets, obstacles, insights, pets,│
│ │ permission│ │   or a goal)                                           │
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

### Nesting

The ladder is three rungs — **tab, goal, pull request** — and it is a real containment rather than a
render order: a goal is drawn over the tab that _lists_ it, and a pull request over the goal it was
reached from. `Place` holds all three at once precisely so that stepping out of one restores the one
underneath, and the **crumb at the head of the situation area draws every rung**, each above the last
a control (`Crumb`, `ConsoleRoot.tsx`).

**A goal and a pull request hang off the tabs that list work, and off nothing else** — Overview,
Tickets and the feature board. Everything else the nav offers is a reading or a settings page, and
neither contains a goal.

That has to be _enforced_, because nothing that opens a goal moves the nav. The queue rail is drawn
on every tab, and a `<Ref>` opens a goal or a pull request from wherever it is drawn — so the tab an
operator happens to have last clicked is not evidence of where they came from. Left alone it read as
one anyway: an operator on Insights who clicked a rail row got a goal page whose way out said
_‹ Insights_, and a pull request under it whose trail led back there. No reading on that page contains
that goal. The trail led somewhere the operator had never been, and it looked exactly like navigation
that works.

So `homeTab` (`place.ts`) narrows the tab to one that could have led there, and it is applied at
**both** ways in: `selectGoal` and `selectPr` carry it on a click, and `readPlace` applies it to a
link, so a saved or hand-edited `?tab=insights&goal=412` cannot land on the lying shape either. The
fallback is the overview — the tab every deployment has, since the board is behind a flag, and the one
the queue rail belongs to, which is where most such selections actually come from.

The crumb and the rule are one change rather than two: **drawing the whole ladder is what makes a
wrong foot visible, and narrowing the foot is what makes drawing it worth doing.** The crumb was a
single back button labelled with the rung beneath it, which on a pull request drew two of three rungs
and left the tab the page hung off entirely off screen — so the label being wrong was a thing only the
click revealed.

What is _not_ nesting: **Insights' readings, the Tickets tab's layouts and the config sections are
facets of one page, not pages under it.** Each is on `Place` — they are places, and a link to one has
to work — but the strip that switches them is the navigation, and a crumb over it would offer a parent
that is the page you are already on. A back control that goes nowhere is worse than none.

The **nav** is four tabs: Overview, Tickets, Obstacles and Insights. Every button clears _both_ pieces
of state, because a nav click means "go here" and either half left standing would land somewhere else.

**A destination is not the same thing as a nav slot.** Config and Pets are reachable without being drawn
there, and `TABS` in `place.ts` is therefore wider than `TABS` in `TopBar.tsx`. The two are separate
lists on purpose: the address bar must round-trip every destination, or a link somebody saved parses
straight back to the overview with nothing saying so, while what the nav costs is the most expensive
space in the cockpit and is spent one tab at a time. Obstacles was the standing example of the gap —
reachable by URL only, deliberately, while the operator decided — and it is in the nav now, which is
what the two lists being separate made possible without either of them being wrong at any point.

**One of them carries a badge, and it is a number and nothing else** (`navBadge`, `TopBar.tsx`).
Tickets carries the untriaged count — `untriagedCount` (`web/src/worldBuckets.ts`) over the same watch
bucket the tab's Unwatched filter uses. It is the same number the surface behind it draws, so the badge
and the rows cannot differ, and it is hidden at zero because a badge that always shows is one nobody
reads.

Tickets used to spell it out — `2 to triage` — and that half is worth stating. A badge answers one
question, _is there anything here for me_, and the answer is the digit: the words were a sentence in the
one row an operator glances at without reading, and they widened the button by however long they happened
to be, which is the thing the nav most has to not do. The sentence survives as the button's `title`,
where it costs no width. The badge is `.cn-nav .cn-badge` — a pill with a `min-width` and a `999px`
radius, so one digit is a circle and three a lozenge rather than the button changing shape by the width
of the number in it, and its margin is in the stylesheet rather than a space in the markup, since a space
is a line-break opportunity and a badge wrapping under its own label is a nav two rows tall.

**Obstacles is the third in reading order, and it holds the slot Knowledge held.** Knowledge was a panel
before it was a tab, and it is neither now: the claim store behind it is gone
([27](27-obstacles.md#what-the-claim-store-left-behind)), and the board that replaced it took the slot
rather than a fifth — two tabs answering one question is how an operator ends up ruling on the same
thing twice. It carries **no badge**, and that is the whole of it rather than an omission: Knowledge's
badge counted corroborated claims nobody had ruled on, which is a queue only a person emptied, and
nothing on the board is waiting on a decision. `readPlace` aliases `?tab=knowledge`, `?panel=knowledge`,
`?panel=findings` and `?panel=lessons` all onto Obstacles, because every link an operator saved to any
of them spells a name the parser no longer knows: without the alias each parses back to the overview
with the rest of the place still in the URL. The `fact` id beside one is **dropped** rather than
carried — there is no longer a row it could open, and a parameter kept for a page that cannot honour it
is a stranded link one layer down. An explicit `?tab=` still wins over a panel alias, since an alias
must not overrule the operator saying where they meant to be.

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
readings are glanced at and the nav is aimed at, and it is `nowrap` where the readings wrap — tabs
stacked one per line is not a tab strip. When the bar runs out of room the _bar_ wraps, dropping the
readings to a second line and leaving the nav whole.

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
the nav and asserts every label, so a tab added to the type and forgotten in the nav is a view
nothing can reach — and fails. It asserts `Work` is **not** among them for the mirror reason: a slot
given back is given back.

**Pets was the fifth and is not a tab any more.** The vivarium is drawn at full size in the
bottom-left corner already, on a strip that was itself a button, so the tab was a second way to a
surface the eye lands on anyway — and a nav slot is the most expensive space in the cockpit. The
[vivarium strip](22-pets.md#the-vivarium) carries the destination now, which also puts the way in
where the thing it names is. It stays a `ConsoleTab` and stays on `Place`, because a destination has
to round-trip whatever draws it; `tabBody` still refuses it where `state.pets` is null, so a stale
`?tab=pets` URL on a deployment drawing no vivarium lands on a sentence rather than on an empty
catalogue. → [22](22-pets.md#the-pets-page)

### The console at width

There is **one DOM for every width**; the arrangement is chosen in CSS alone. Matching the breakpoints
in React as well — rendering a different tree per width — buys nothing and costs a resize listener, a
re-render on every drag, and a second definition of each boundary that will disagree with the first
time either moves.

| width     | arrangement                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------- |
| < 1100    | one column — rail, then situation area, then vivarium — scrolling as a single page             |
| 1100–1199 | the rail beside the situation area (360px), vivarium on its floor; situation one column        |
| 1200–1999 | overview cards in two tracks; the goal page gains its rail, and its plan waves go side by side |
| ≥ 2000    | overview cards in four tracks; the three spanning cards take two each                          |

**The breakpoints are therefore stated once**, in `console.css`, and each is a statement about a
different surface: 1100 is the shell, 1200 the overview grid _and_ the goal page, 2000 the overview
again. The plan's waves use `auto-fit` above 1200 rather than a fixed track count, so how many waves
sit in a row is a question about the card and not about the viewport.

**The goal page moved from 1500 to 1200, and that is a consequence rather than a decision.** Both
numbers were the same number: the plan's waves needed width, and the card was inside a 1.6fr column,
so the point at which the waves could turn sideways was the point at which the column stopped halving
them — around 1680px in practice, for a plan of three waves. The plan and the validation card are
[full width now](#the-goal-page), outside the two-column grid entirely, so the waves answer only to
the card and what is left in the grid is four row-lists. Neither needs 1500 of its own, and at 1200
the situation area clears 800px with the shell's 360 taken for the rail.

**The plan's waves stack vertically below 1200px** rather than scrolling sideways. A horizontally
scrolling plan is the failure this layout is a reaction to.

**Document order is reading order.** No card carries a CSS `order`; a section moved in `Overview.tsx`
or `GoalPage.tsx` moves on screen, which is the point.

**Which is why the vivarium is the last child of `.cn-body` and not a child of the rail.** One column
is the arrangement the shell falls back to, and in it document order is the whole layout — so an
enclosure written inside `.cn-rail` drew half way down the page, between the queue and the work the
operator scrolled to, whatever the sheet said about it being a corner. Written last it is the end of
the page there, and the wide arrangement is recovered by placement rather than by order: `.cn-body`
gains a second row above 1100, the rail takes `minmax(0, 1fr)` of the first, the vivarium the `auto`
second, and the situation area spans both. → [22](22-pets.md#the-vivarium)

**There is one scroller in one column, and two beside each other.** Which is the same statement about
panes: above 1100 the rail and the situation area are panes with a bottom edge — each scrolls its own
content, the body does not scroll at all, and the vivarium sits on the rail's floor because that is
where a pane's footer goes. Below it there are no panes, so each draws at its full height and
`.cn-body` is what scrolls, top to bottom: the whole queue, then the work, then the enclosure at the
end of it. Every `overflow: auto` and `min-height: 0` on those two is therefore stated **under the
breakpoint**, not on the rules themselves — a `min-height: 0` left on says "shorter than its content
is fine" to a grid whose rows are the page, and the tracks collapse towards nothing with the panes
drawing over one another. It is also why the enclosure is reached by scrolling rather than pinned
across the bottom of the glass: a strip that is always there is a pane's footer, and one column has
no pane to be the footer of.

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

| Parameter                            | Carries                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tab`                                | `tickets` / `obstacles` / `insights`; the overview is the absent value. `backlog` and `work` are aliases for `tickets`, and `knowledge` for `obstacles` — as are the `knowledge`, `findings` and `lessons` panel names — so links to a deleted tab or a retired panel still land. Narrowed by `homeTab` whenever `goal` or `pr` is set — a link naming one of those is a place one rung in, and the tab is the rung under it → [nesting](#nesting) |
| `goal`                               | the open goal page, as `issue:<n>`. It outranks `tab`, which it is drawn over and which the crumb's first rung names                                                                                                                                                                                                                                                                                                                               |
| `pr`                                 | the open [pull request page](#the-pull-request-page), by number. It outranks `goal`, which it is drawn over and which is the crumb's second rung; a value that is not a positive integer is nowhere                                                                                                                                                                                                                                                |
| `panel`                              | `faults` / `launch` / `build` / `record` / `localRun` / `setup` / `pets`                                                                                                                                                                                                                                                                                                                                                                           |
| `ask`                                | the queue row a `{ ask }` panel is showing                                                                                                                                                                                                                                                                                                                                                                                                         |
| `agent`                              | the open drawer's agent                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `plan` / `retro` / `pad`             | the plan sheet, the retrospective, the notepad                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pack`                               | the pull request whose [review pack](#the-review-pack) is open over the goal page, by number                                                                                                                                                                                                                                                                                                                                                       |
| `idea`                               | which idea of that pack is unfolded, by the id the author minted, or `all` for the open-all control. Carried only under `pack`: a fold on a page that is not open is not a place                                                                                                                                                                                                                                                                   |
| `obs`                                | the obstacle whose sightings are unfolded on the Obstacles tab, by id → [27](27-obstacles.md#in-the-cockpit)                                                                                                                                                                                                                                                                                                                                       |
| `ended`                              | whether the Obstacles tab's terminal tail is **opened**. Opened rather than folded away, so the page as it stands is a bare URL; what a fold would otherwise cost is paid for by the heading stating its own size → [27](27-obstacles.md#in-the-cockpit)                                                                                                                                                                                           |
| `settings` / `spend` / `reliability` | the three top-bar modals                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `open`                               | the goal page's reference sections held open, as `record,ticket`                                                                                                                                                                                                                                                                                                                                                                                   |
| `collapsed`                          | the tickets tab's features folded away, as `3,12`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `watch`                              | the Tickets tab's harness axis: `watched` / `unwatched`; `any` is the absent value                                                                                                                                                                                                                                                                                                                                                                 |
| `tracking`                           | what the harness is doing about it: `any` / `frozen`; `live` is the absent value, since the tab is the surface work happens on                                                                                                                                                                                                                                                                                                                     |
| `state`                              | its tracker axis, in the tracker's own word; `any` is the absent value. `open` / `closed` are read as the old `tracking` axis                                                                                                                                                                                                                                                                                                                      |
| `feature`                            | one feature by issue number, or `none` for the orphans; every feature is the absent value                                                                                                                                                                                                                                                                                                                                                          |
| `group`                              | how the list is arranged: `flat`; `feature` is the absent value                                                                                                                                                                                                                                                                                                                                                                                    |
| `order`                              | how the Tickets tab is ordered: `cost`; `added` is the absent value                                                                                                                                                                                                                                                                                                                                                                                |
| `view`                               | the Tickets tab's layout: `card` for the board of state columns; `table` is the absent value                                                                                                                                                                                                                                                                                                                                                       |
| `hide`                               | the board columns folded away, as `Closed,Removed` — the **hidden** ones, so an untouched board is a bare URL                                                                                                                                                                                                                                                                                                                                      |

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
permission requests, goals the appraisal refused at intake, unanswered goal-profile proposals, usage-limit
parks, bench tasks, close-outs, validate rows, dispatches the executor keeps refusing, pull requests
somebody assigned to the operator and the recovery hold. `buildNeedsYou`
(`web/src/view/needsYou.ts`) is the merge, and it is pure.

**The snapshot carries only the escalations that are still open** — the rail's own
`status === 'open'` filter is belt-and-braces over a list that already holds nothing else
([16](16-http-api.md#bulk-text)). Nothing in the cockpit draws a settled escalation, and each carries a
transcript tail, so the all-time list was half a megabyte a refresh spent on rows that were filtered
straight back out. A surface that wanted the settled ones would need a route of its own.

**Nine kinds, and the split is about what answers them.** `permission` and the four proposal kinds are
escalations underneath, named apart because the verdict differs — a permission goes to `/permission`, a
proposal carries accept/reject, a plain question takes free text. Drawing them as one kind is how a
surface ends up offering the wrong control.

**A proposal is four kinds — `plan`, `reply`, `merge`, `shortfall` — and was one.** It was `proposal`,
tagged `Plan`, which is the name of the one act among the four it might be: a drafted reply held for
sign-off, a merge waiting on a verdict and an assessment's follow-up all arrived on the rail, and in
the ask panel's own header, under the word `Plan`. `PROPOSAL_KIND` (`web/src/view/needsYou.ts`) is
total over `ProposalKind`, so a fifth act fails the typecheck rather than inheriting whichever word the
last one wore. A shortfall the harness only _asks_ about — the arm where the goal itself is what the
assessor found wrong, so nothing is dispatched and no proposal is written
([13](13-jobs-and-tickets.md)) — is `shortfall` too, read off its `issue:<n>:shortfall` origin: it is the
same news, and a row reading `Escalation` would file the one ask about a delivered goal with the ones
about a stuck agent. `bench` and `close_out` are human tasks, likewise split, since a
close-out is the step after a launch and reads as one ([13](13-jobs-and-tickets.md#the-step-after-the-launch-the-close-out)).
`validate` is split from both for the same reason one layer on: it is the _other_ step after a launch
([13](13-jobs-and-tickets.md#the-other-step-after-the-launch-the-validation)), and a row that read
`Bench` would tell an operator nothing about why it appeared the day the goal was delivered. All three
are answered the same two ways — done, or declined with a reason — which is why they share a body.

`watch` is the fourth human task and the one that does **not** share it. It answers the same two ways
and carries a third control the others have no use for — **Raise a bug…**, which opens the bug modal
already holding the row's own detail: the check, what it expected and what it read. A seed rather than
a payload, so what is filed is still what the operator sends and the fleet is handed the numbers
rather than a paraphrase somebody retyped ([13](13-jobs-and-tickets.md#the-other-filing-kind--a-bug-the-operator-raised)).
It is drawn only where there is a tracker to file into and a goal to relate the bug back to, and a
false draws no button rather than a disabled one.

That click is the whole bound on the subsystem: nothing under `src/dispatcher/` may read a watch, so
no reading ever dispatches an agent, and the route from a number to new work is a person deciding the
number means something. The row itself is a `human_tasks` row like every other on the rail, which is
also how the rail folds off the reading the desk already took rather than computing a second one.
→ [29](29-post-deploy-watch.md#the-bench-row)

**`profile` is the second kind with no row of its own underneath it** — it is read off
`issue.appraisal.awaitingProfileAnswer`, the goal-profile gate ([06](06-issue-pickup.md#the-second-arm-an-unanswered-profile-proposal-issue-342)),
because the harness raises no escalation and files no task for it: the proposal _is_ the ask. It is in
the queue for what makes that gate different from every other hold — it expires on nothing but the
answer, so a gate nobody sees is a goal stopped for good. It was drawn on the goal's own page and
nowhere else, which is the page an operator has no reason to open for a goal that looks like it merely
has not come up yet. Its verdict is the two the gate has always had — take the proposal, or keep what
is standing — both through one write, so "keep mine" settles the question rather than leaving it
re-readable as an unanswered disagreement. It is derived from `world.issues` and never the retained
runs: a goal the world no longer carries is not one the funnel is refusing to dispatch.

**`placement` is the third kind with no row of its own underneath it**, and the first that holds
nothing at all. It is read off `issue.appraisal.placement` — the goal's missing parent and its missing area
path ([06](06-issue-pickup.md#where-the-goal-belongs-the-placement-proposals-issue-463)). **The parent
row is the fact and the area-path row is the appraiser's proposal**, which is why the parent row draws
with no first choice under it where nothing was proposed and the area-path row does not exist at all
in that case; the difference is argued in 06, and `ParentPicker` already leads with its own container
list when it has no suggestion to compare against.
Every other row on this rail stands between the fleet and some work; this one does not. The work is
dispatched, done and merged whatever the answer is, and what is wrong is that the ticket is invisible
to whoever plans the backlog — a fault nobody sees until they go looking for work that is not on the
board. That is `config_gap`'s reading, which is why it borrows that **tone** rather than the profile
gate's blue.

One row per open question rather than one per goal, because the two are answered separately and by
different writes. Its verdict is **three** buttons where the profile gate has two, and the third is
what the shape needs: nothing here blocks, so without an explicit "it wants none" a goal that
legitimately has no parent would sit on the rail for ever — the two blocking gates get their third
answer free, because somebody has to clear them. The alternatives are offered rather than typed:
`world.parentCandidates` — the same `candidateParents` the appraiser's own orphan note is written
from, derived server-side and shipped whole — and the area nodes from `config.areaPaths`, which is the
tracker's own tree read by the harness.

**The container list is shipped, never re-derived in the browser.** It was `world.issues` filtered by
`config.containerTypes`, which is one half of `candidateParents` and the half that is almost always
empty: an Azure item list is narrowed by tag and assignee, so an open Feature is usually visible only
as some _other_ item's parent, and `world.issues` carries it nowhere. `ParentPicker` draws no select at
all where its list is empty — correct in itself, and here it meant the deployments that raise the
missing-parent warning were the deployments with no way to answer it: "Not applicable" was the only
button under a warning about filing (issue #683). Nothing was red. The question was drawn, every button
worked, and the one answer that resolves the fact was simply not there.

**The proposed parent is drawn as a `<Ref>` beside the button and never inside one** — the rule
([links](#links)), and here also the point: verifying the suggestion has to be as cheap as accepting
it, or three buttons collapse into one rubber stamp. Like the profile gate it is derived from
`world.issues` and never the retained runs, and it is drawn nowhere at all where the sink cannot make
the write — a proposal answered by three buttons that all 400 is the dead end this cockpit's rules
exist to prevent.

**The parent question's three answers are `ParentPicker`, one component and two placements.** The
goal page states the same gap louder and offers the same write
([a goal with no parent Feature](#a-goal-with-no-parent-feature)), and two copies of three buttons is
two sets of wording, two disabled rules and two chances for one of them to be wired to nothing. The
band on the goal page is not this row drawn twice: the page filters `placement:parent:` out of its own
bands, so a goal carrying the question is asked it once per surface. The area-path half keeps its own
three answers here — a different question, offered from the tracker's tree rather than from the
board.

**`intake` is the fourth kind with no row of its own underneath it**, and the only one of the four that
is a refusal rather than a proposal. It is read off `issue.appraisal.verdict === 'unclear'` — the goal
appraisal's own hold, which stops pickup for the whole goal ([06](06-issue-pickup.md#block-or-inform-and-why-blocking-is-safe)) —
and it is `yours` on the profile gate's terms: a whole goal's dispatch is held and no agent is sitting
in it.

It was drawn on the **tickets tab and nowhere else**, as a call-out above the list. That is a page an
operator opens to groom the backlog, not to find out what is waiting on them — so the one verdict that
stops a goal dead was the one ask the surface that exists to say what is waiting never mentioned, and a
held goal read to anybody who did not open that tab as a goal that simply had not come up yet. The same
argument the profile gate is on the rail for, and the same fix.

The row's line says which ask it is and which goal it is about; the **appraiser's sentence is quoted whole
in the band**, never reworded and never clamped, because it is the only account of why the goal is held.
Its verdict is one button — `Override → workable`, through `setIssueAppraisal`, the call the tickets tab
already used — because the hold's other two exits are not buttons: it expires when the goal's own text
changes, and it is cleared in the tracker.

An **unwatched** item is never intake, whatever a stale verdict says: nothing appraises a goal nobody opted
in, so a verdict on one is left over from before it was dropped, and the drop outranks it. Derived from
`world.issues` and never the retained runs, for the profile gate's reason.

**`limit` is the one kind with no row of its own underneath it.** It is built from the _fleet_ —
`state.parkedOnLimit`, keyed on the agent — because a usage-limit park raises no escalation on purpose:
there is no question in it to answer ([10](10-agent-runtimes.md#the-limit-park)). Its verdict is
`Resume`, and its second control is the transcript, which is where an operator decides whether carrying
on is worth it. Most of these rows clear themselves: the pulse ends a park once the window `claude`
named has turned over ([10](10-agent-runtimes.md#ending-it-on-the-clock)), so `Resume` is for going
early, and for the parks that carry no reset time and would otherwise sit there for good. It draws no reply box anywhere, because the agent's process is usually gone with the
limit and a box that cannot send is worse than no box.

**`dispatch` is the one kind derived from the decision log**, and the only one whose subject is
something the harness _tried_ rather than something anybody raised. A dispatch the executor has
refused on three separate pulses running draws a row naming the origin, the refusal verbatim, and how
long it has been going on ([09](09-execution.md#a-refusal-that-keeps-repeating)). Nothing else in the
harness records it: no escalation, no task, no error — the attempt's own task row is settled
`interrupted` on the way out — so a fleet stuck on one reads as a fleet with nothing to do, which is
what it did for four minutes with a branch checked out where the pool could not lease it.

Three pulses rather than one, because a slot is held from `ensure` until an agent's process is reaped:
a fleet at its cap trips a refusal that the next pulse clears, and a rail that cried wolf on that
would be noise on a working deployment. The run has to be **unbroken at the head** of that origin's
history, which is what clears the row the instant one dispatch gets through rather than when the old
rows age out of the hundred the snapshot ships. It keys on the `rejected` outcome and never on the
sentence, so both refusals the worktree pool raises arrive here together and so does the next one.

**It has no control, and must not grow one.** What is in the way is outside the harness in both
cases — a checkout of the operator's own standing on the branch, or a cap that has to come down — and
a button that could perform neither is the dead end this cockpit's rules exist to prevent. The band
draws the thrower's own message instead, which already names the branch, the path and what clears it.

**`assigned` is the one kind that did not come from the harness at all.** Every other row here is
the fleet saying it is stuck; this one is a pull request a colleague put on the operator, which the
fleet does not know exists and will never act on. It is read off `attention.assignedToYou`
([07](07-pull-requests.md#a-pull-request-a-person-put-on-you)) — the field the verdict sets **only**
when the assignment is what makes the pull request the operator's court, so a PR assigned to them with
an agent already on its branch, or one whose merge is waiting on their verdict, draws nothing here.
Both would be the same ask twice, which is how a queue teaches an operator to skim it.

Keyed on that field and never on the assignment itself, for the reason `dispatch` keys on an outcome
rather than a sentence: a surface matching the leading reason's wording would file every future
rewording of it as "not assigned".

**Its age is how long the pull request has been waiting on _them_** — `reviewWaitingSince`, the
review-wait watermark the pulse folds, which the verdict carries on an assigned court for exactly this
([07](07-pull-requests.md#how-long-it-has-been-waiting-on-a-reviewer)). It is deliberately **not** when
the assignment was made: no provider payload says that, and stamping the snapshot's "now" for it would
draw a fresh age on every poll, a row that has been theirs all week reading as one that arrived a
moment ago. A pull request whose clock is not running — red CI, an unhandled comment, a staffed branch,
or one the harness has not yet observed a pulse of — draws no age, and sorts to the top of its group,
which is where an ask whose age is unknown belongs.

**The row says who asked, and what they asked about.** Its line is the verdict's leading reason —
which names the person ([07](07-pull-requests.md#a-pull-request-a-person-put-on-you)) — followed by the
pull request's own title: `Priya Raman marked you as a reviewer on “Retry the sweep on a 429”`. The
arm's own reason is deliberately dropped here and nowhere else: `waiting on review` is this very row
said back to the operator, and `not tagged … — the harness is leaving it alone` explains the _fleet's_
silence rather than their obligation. Both still stand on the pull request row, where the question
being answered is what the harness makes of the PR. Which kind of reviewer they are rides on the
metadata line instead (`Required reviewer` / `Optional reviewer`), read off `assignedToYou` — a real
distinction, and a clause every row would carry and no two rows would differ by.

**And it carries the way to the pull request.** A row that merely _named_ the pull request left the
operator to go and find it, which is the surface this queue exists to replace; the `<Ref>` opens the
pull request's own page, or the provider's where the world no longer carries it. The
`<Ref>` sits **beside** the row body, never inside it: one click may not have two destinations, so the
body stays the control that opens the ask and the reference is its own target — the same shape a config
row's fix strip takes ([links](#links)).

**It has no control either, and for `dispatch`'s reason turned around**: there is no verdict to record
and no act to authorise, because the harness has no part in this one. The band says what the pull
request is, why nothing is coming, and offers the `<Ref>` to it — which is the whole of what the row
owes. It stops being drawn the moment somebody takes the assignment off again — or the moment the
operator approves the pull request, which is the same thing said by the provider
([07](07-pull-requests.md#when-the-assignment-ends)).

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

| Kind         | Tag         | Tone  | Glyph | Why that tone                                                 |
| ------------ | ----------- | ----- | ----- | ------------------------------------------------------------- |
| `recovery`   | Recovery    | red   | `↺`   | A restart left runs orphaned. Something went wrong.           |
| `escalation` | Escalation  | red   | `?`   | An agent hit a question it cannot get past.                   |
| `permission` | Permission  | amber | `⊘`   | A gate, not a fault — a command is waiting on a yes.          |
| `limit`      | Usage limit | amber | `‖`   | Nothing broke; an allowance window has to turn over.          |
| `burn`       | Spend       | amber | `▲`   | A heads-up on a run that carries on either way.               |
| `plan`       | Plan        | blue  | `◇`   | A plan to read and decide on.                                 |
| `reply`      | Reply       | amber | `↵`   | A drafted reply, held until you send it.                      |
| `merge`      | Merge       | amber | `⊕`   | A merge waiting on your verdict.                              |
| `shortfall`  | Shortfall   | blue  | `✗`   | Delivered work that did not reach its goal.                   |
| `intake`     | Intake      | blue  | `◌`   | The appraisal could not say a goal is workable.               |
| `profile`    | Profile     | blue  | `⊙`   | Which profile a goal runs on.                                 |
| `placement`  | Backlog     | amber | `▣`   | Nothing is held; the ticket is off the board.                 |
| `bench`      | Bench       | blue  | `◆`   | Work only a person can do. Informative, not broken.           |
| `close_out`  | Close-out   | green | `⚑`   | A goal was **delivered**; this is the step after it.          |
| `validate`   | Validate    | green | `✓`   | The other step after a delivery — run its checks.             |
| `watch`      | Watch       | amber | `◎`   | The running system is answering outside what a goal declared. |
| `dispatch`   | Refused     | red   | `⊠`   | The harness keeps trying this and keeps being told no.        |

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

### The plan band shows the plan's summary, not the ask's prose

The band on the goal page had the same fault one layer down, and worse: a plan approval drew its whole
prompt — the template's sentence, why the planner split it that way, and a paragraph on what approving
and rejecting do — _above_ `context.detail`, which is the planner's diagnosis and approach, the same
summary the plan sheet leads with. Two accounts of one plan, the longer one first, on a card that also
carries the buttons.

`EscalationCard` now drops that prose for a `plan` proposal and keeps the summary, which is what the
operator is deciding on; the split, the evidence and what it rules out stay behind **Read the full
plan**, and what approving and rejecting do is what the two buttons' own hints say. A drafted reply
drops its prose for the plainer version of the same reason — its body _is_ the draft, which the card
already draws under a label of its own, now open rather than folded away, since it is the thing being
approved.

**What is kept is the appended caution.** `caveatNotice` (`src/plans/planCaveats.ts`) writes its
bullets under a `Before you decide:` line, appended to the rendered ask rather than interpolated into
it — the planner's own uncertainty, an unclaimed pull request on the branch, parts already blocked. It
is the one part of the ask that is about _this_ decision and appears nowhere else, so `splitCaution`
keeps it while the rest goes — **unless the same caveats are drawn as tick boxes**, and then the
paragraph is the checklist restated and the card drops it too.

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

### A row is one factual line

**The row says which ask it is and which goal it is about, and nothing else.** It used to draw the
ask's own prose — `escalation.prompt` verbatim — and a plan approval's prompt is four paragraphs, so
the row that mattered most was the tallest thing on the rail and a queue of them could not be read at
a glance. `askLine` (`web/src/view/needsYou.ts`) words each row instead: a summary of the act, then
`for #395 · <the goal's title>`.

- **The act, from the row's own source and never from the prose.** A proposal knows which act it is,
  so `Plan ready`, `Draft reply to <the reviewer> for PR #412`, `Merge waiting on your verdict for
PR #412`, `The delivered work did not reach the goal`. A permission states its tool and command; a
  questionnaire states its count; a plain question is the only one with no act to name, and its own
  first line is the most factual thing there is.
- **The goal is named, not numbered.** `#395` alone is not something an operator recognises, so the
  goal's title rides with it — resolved through `goalIssue`, and simply absent for a goal the world no
  longer carries.
- **The ref is dropped where the summary already spells it out**, so a close-out reads
  `Close issue #364 in the tracker · …` rather than naming `#364` twice. `subjectBeside`
  (`web/src/console/QueueRail.tsx`) does the same for the metadata line: the subject is drawn beside
  the row only when the row's line has not already said it, which leaves it exactly where it is still
  needed — a pull request no ticket owns.
- **Free text is clamped to one line**, and `.cn-qtitle` clamps the drawn result to two, because a
  goal title or an agent's own question is whatever length its author felt like. The whole of it is in
  the band the row opens, one click away.

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

**A retained run is marked stale, never removed.** The overview's goals-in-flight list draws a retained
run beside the live goals _while it still has work in flight_, and the rest behind that card's `kept`
disclosure ([the overview](#the-overview)); the page header and the row both carry `StaleChip`: the tracker
stopped returning this item, and — where the ticket mirror has a row — what the tracker now calls it
(`tracker: Resolved · seen 3h ago`). The chip's title says exactly what the marking covers: the title,
description, labels and state are the harness's copy from the last pulse the item was live, and the
run, plan, pull requests, agents, spend and notes are the harness's own record and current. It exists
because an Azure item moved to `Resolved`, or one whose watch tag was removed, used to vanish from every
list in the cockpit the moment it left the open set, with its pull requests still open and its money
still on the table — reachable only by address. The header's state chip on such a goal is the harness's
copy, which is why the stale chip sits beside it. The marking rides only on `retainedRuns`
([03](03-world-model.md#issue)); a live issue never carries it, and the dispatcher's union of the same
stubs is untouched.

**A null page is drawn as a null page, not as the tab underneath.** Returning null is the right answer
and falling through to the tab body was the other half of that decision left unmade: the address bar
said `goal=issue:412` while the screen went on showing the list, so the click read as a control that
does nothing — the dead end this spec calls the cockpit's most repeated bug, one level up. So a selected
goal the snapshot does not carry gets a short panel naming it, saying why there is nothing to draw, and
offering the **tracker** — which is where the answer actually is — plus the crumb back to the tab.

On the Tickets tab this is the common case rather than the corner. The tab lists the **mirror**, which
keeps every item ever swept; the page is built from the **snapshot**, which holds only what the last
scan returned. Every frozen row is therefore in exactly this position, and under `tracking=any` that is
most of them.

`needs` is **passed in** rather than rebuilt, so the rail and the page are one reading — answering on
either settles the row and the next snapshot clears both, with nothing kept in step by hand.

Order on the page, top to bottom:

1. **The goal header**, in three rows with fixed roles — what the goal _is_, then what anybody has
   decided about it, then what you can do to it ([The header](#the-header)).
   1a. **The track** — the goal's pipeline in one row, each stretch a way to the section that owns it
   ([The track](#the-track)).
2. **The "Needs you" bands** — every open ask on this goal, stacked, answerable in place. Red for
   asks blocking an agent, amber for the operator's own, the rail's own split carried over so a row
   and the band it opens read the same. **A goal with no ask draws no band at all** — a band that is
   sometimes furniture stops being read as a demand — and `test/console.test.ts` asserts that from both
   sides. The band is `NeedsBand` (`web/src/console/NeedsBand.tsx`), its own module rather than the
   goal page's private component, because the goal page is not the only place an ask is read: the ask
   panel draws the same band for a row with no goal page. One band, two placements — a second wiring
   is a second set of verdicts to keep in step.
3. **The ticket as it stood at pickup**, drawn through `renderRichText` because the body is the
   _tracker's_ prose and Azure DevOps writes it as HTML ([Tracker-authored prose](#tracker-authored-prose)).
   **Open until the work starts, folded from the moment it has**
   ([Folding what is not relevant yet](#folding-what-is-not-relevant-yet)).
4. **The plan**, left to right in dispatch order. **Full width**, because the waves are a board read
   left to right and a column is what kept them stacked to 1500px.
5. **Validation** — how anyone checks the goal was met, and what anybody concluded from running each
   check. Full width ([Validation](#validation-on-the-goal)), and **below the plan**, which is the
   ordering the card itself has always asked for: its own subtitle says the checks are written by the
   plan, and the plan was underneath it. Then **Signals** — what this goal asked production to show for
   the work. Both are folded until the work is somewhere
   ([Folding what is not relevant yet](#folding-what-is-not-relevant-yet)).
6. **Two columns**, from 1200px. The live reading and what is still owed on the left — **pull
   requests for this goal**, open and closed, with the court chip and the checks mark, then
   **environments** ([Environments](#environments)). On the right, **On this goal** (who is working
   it now, [below](#who-is-on-the-goal)), **What you've asked for**, **The tail** and **Spend**. Below 1200 the two stacks are one
   column.
7. **The record** — this goal's own subtree of the durable work graph, folded away at the foot of the
   page ([The record](#the-record-on-the-goal-it-belongs-to)).

### Folding what is not relevant yet

A goal page draws the whole pipeline whether or not the goal has reached any of it. That rule is what
keeps a quiet surface distinguishable from a broken one, and it stands: **no card vanishes**. Drawn
_open_, though, it cost three screens of "no checks", "nothing declared", "not shipped" between the
plan and the work on every goal that had only just started.

So a card with nothing in it yet is drawn **folded**, and its heading carries the reading it would have
given — `Validation · no checks`, `Environments · 0/3 reached`, `The tail · ticket open`. Folded is the
third answer between drawn and gone, and the one that is true of a stage the goal has not reached.

`goalSectionsOpen(page)` (`web/src/view/goalPage.ts`) is where each section starts, and the order the
defaults unlock is the order the questions are asked in:

| Section        | Open from                                                                             |
| -------------- | ------------------------------------------------------------------------------------- |
| `ticket`       | until the work starts — a plan, a pull request or an agent folds it                   |
| `validation`   | the work reaching an environment **and** there being a check, or one anybody ruled on |
| `signals`      | the same arrival **and** a declared check, or one awaiting the operator               |
| `environments` | any environment reading that is not `absent`                                          |
| `tail`         | a delivery, a shortfall, a write-up, or a shut ticket                                 |
| `record`       | never — it has no relevant moment, and folded away it fetches nothing                 |

**The arrival is what makes a card relevant; it is not what puts anything in it.** A goal that
shipped without ever declaring a check reads `Validation · no checks` in its heading, and opening it to
say so at length is the emptiness the fold exists to spare — so both of those rows want an arrival _and_
something to draw. The second arm of each is what opens the card wherever the work is: a check somebody
has already ruled on, or one waiting on the operator, is a card with something in it.

`partial` counts as arrived and **`unknown` does not**: half the work being out there is what the
validation card is most needed for, and a probe that could not say is not a reading that the work
arrived ([24](24-environments.md#the-three-verdicts)).

The **ticket is the mirror image** of the rest, and that is why it is back at the top. It was moved to
the foot of the page as one of "the two surfaces that ask nothing of the reader", which was true of it
and half the story: it is what every other card on the page is measured against, and reaching it meant
scrolling past all of them. Open, it is a screen of prose over a running goal; folded, it is a heading.
So it goes back above the plan and folds itself the moment there is any work to read instead.

**Two `Place` lists, `?open=` and `?shut=`.** A disclosure held in a `useState` compiles, renders and
works right up until the back button steps over it or a reload drops it, and both are silent
([The address bar](#the-address-bar)). Two lists rather than one, because the default is no longer
"shut": it moves as the goal does, so a single list could only say _not the default_ — and a card the
operator folded away mid-flight would spring open the moment the goal shipped, with a card they opened
early slamming shut for the same reason. The operator's word outranks the reading in both directions,
and the empty pair is still the page as it stands.

**A jump opens what it lands on.** The track's stages and the header's validation chip scroll to a
card, and a card the goal's progress had folded away made both read as controls that do nothing — the
page moved and the reading it moved to was not drawn. `jumpTo` opens the section first and scrolls a
frame later, once the card has grown.

**The environment gate's hold is drawn folded or not.** Nothing is filed while a gate holds, so a
delivered goal with an empty bench is indistinguishable from a finished one; a fold is not a reason to
stop saying so.

**The record's disclosure is its own, not the page's.** Its heading carries the node count and only
it knows that, so a heading drawn outside it would either carry no count or carry a stale one. That
also keeps "fetched on open, never polled" true now the card no longer opens with the page: folded
away it issues no request at all.

### The header

**Three rows with fixed roles**, rather than one row of everything with the controls floated off its
end.

1. **What the goal is** — `#390 · Validate job payloads in the catalog`, the item type, and the
   tracker's workflow state in the operator's own colour. Neither chip is a verdict anybody passed on
   the work, which is why they are up here and not in the row below.
2. **What anybody has decided about it** — the appraisal verdict with the appraiser's own summary in its
   title, the conclusion verdict, and the validation verdict as a settled count (absent when the goal
   has no checks: "no plan" is a third reading and not a synonym for clear, [20](20-validation.md)).
   **Each chip is prefixed with what it is a reading of** — `Appraisal ·`, `Harness verdict ·` — or `Your verdict ·`, read off the
   conclusion's own `by`, because telling an operator their override was the harness's is the same
   fault pointed the other way —
   `Validation · 2 of 5 settled` — because the two words the conclusion chip most often reads,
   "more work", were also the name of a control an operator presses, and a chip that can be read as
   either is the header's oldest confusion. The prefix is what makes a chip say _judgement_ before it
   says anything else; the glyph beside it repeats that.
   Every chip quotes a reading the server already made; nothing here is a second opinion. The
   validation chip is the one that is a **button**: the checks are on this page, so the reading has
   somewhere to go, and a verdict you can act on should not be the only chip that does nothing. After
   the verdicts, one plain run of the measurements — when the run started, the agent count (the same
   one **On this goal** carries, pull-request dispatches included, [below](#who-is-on-the-goal)), what it
   has cost — a step fainter, which is the difference between a reading you scan and a judgement you
   read. A `null` spend draws no reading at all, because nothing was ever measured and `$0.00` would
   report a goal that cost nothing ([18](18-observability.md#per-goal-spend)).
3. **What you can do to it**, [below](#the-headers-controls).

**How many parts have merged is deliberately not in row 2 any more.** It is the track's first stage,
and stating it in both places is how a header and the card it summarises come to disagree.

### The control kit

**One button, one link, one dropdown, one group of grouped buttons, and the captioned group they sit
in** — `web/src/components/controls.tsx`, dressed by the `.cn-ctl*` block in `console.css`. A surface
that draws controls reaches for these rather than writing class strings.

It exists because the goal header proved what the alternative costs. Nine controls were hand-written
as `cn-tgl`, `cn-tgl cn-danger`, `cn-tgl ${on ? 'cn-watch' : ''}` — and three faults rode along,
each invisible to every check the repo runs:

- **`.cn button { font: inherit }` outranks a bare class.** The controls that were `<button>`s drew at
  the console's 13px while the two that were `<a>`s drew at 11.5px. One row, two sizes, for as long as
  the rule was spelled `.cn-tgl`. Anything in the kit that sets a control's font is scoped `.cn` first.
- **The "on" tint reused `cn-watch`, which is also the environments _card_.** Nothing in `.cn-tgl`
  resets a margin, so the card's `margin: 0 13px 10px 26px` and its 2px left border came with it — on
  every watched, prioritised or instructed goal, which is to say on the goals an operator looks at
  most. The tone is `cn-tglon` now, a name no card wants.
- **A `<select>` sizes itself.** From the same padding it drew shorter than its neighbours, with the
  platform's own caret, because the platform renders it. `ControlSelect` turns that off and draws the
  glyph and the caret itself; the picker inside keeps owning its options.

Every one of those is a class string being asked to remember something. A component remembers it once,
which is the whole argument for the kit:

| component                            | what it is                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `ControlBar`                         | the row; groups wrap as units, never through one                            |
| `ControlGroup`                       | a captioned group, and the rule before it                                   |
| `ControlButton`                      | one control that acts, with an optional count pill                          |
| `ControlSegments` / `ControlSegment` | grouped buttons: mutually exclusive states sharing an edge                  |
| `ControlSelect`                      | the chrome a `<select>` wears to sit in a bar                               |
| `CONTROL_CLASS`                      | the seam for `TicketLink` and `PrLink` — components that take a `className` |

**Tone is a prop, never a class string**: `on` for an engaged toggle, `primary` for the one control a
surface expects to be pressed, `danger` for one that destroys something. A caller cannot invent a
fourth, which is what stops the next surface inventing a second vocabulary of its own. **One height,
one edge, one size** — 28px, the same border, radius, padding and 11.5px lettering, whatever element
the control is built from. And **an icon never appears without its label** ([`Icon`](#the-headers-controls)):
the glyph finds a control faster for somebody who already knows the row; it is not the name of it.

`CONTROL_CLASS` is `cn-tgl`, the class the pull-request page and the human-task actions already wear,
so adopting the kit is a change of _who writes the class_ rather than a second control family beside
the one the cockpit has.

**The kit is the cockpit's, not the goal header's.** `cn-tgl` appears as a literal in exactly one
place — `CONTROL_CLASS` — and every surface that draws a control reaches it from there: the goal
header, the pull-request masthead and its thread controls, the retrospective and scratchpad openers. A
change to how a control looks is then one edit, and every surface takes it.

**`ProfilePicker` dresses itself through `ControlSelect`**, rather than each caller wrapping it. It is
the cockpit's one dropdown and it is drawn in three places — the goal header, the plan sheet's parts,
Up next's rows — which is exactly the shape that drifts: three callers, three answers to "how tall is a
`<select>` next to a button". What the component keeps is the _options_; what the kit answers is the
glyph, the caret and the height. `--cn-r-sm` is 4px for the same reason it is a token at all: one
decision, made once, taken by the console's chips, inputs and controls alike.

### The modal

**One overlay** — `Modal` in `web/src/components/Modal.tsx`. Every sheet that covers the cockpit is
drawn through it: the plan sheet, the goal's three composers, the questionnaire, the review pack, the
retrospective and notepad readers, the issue and bug filers, the agent drawer, the console's panels,
the prompt-template viewer and the hatching ceremony.

It exists for the same reason the control kit does, and the copy it replaced cost more. Thirteen
surfaces hand-wrote the same three lines — a `plan-modal-backdrop` with `onClick={onClose}`, a
surface with an `onClick={(e) => e.stopPropagation()}` guard, a `pm-head` and a `pm-foot` — and the
copy dropped something on eleven of them:

> **Escape closed two of the thirteen.** `HatchModal` and the prompt viewer registered a key
> listener; nothing else did. So the sheet covering the goal an operator is reading could only be
> dismissed by finding one small button, on every modal but two — and the sheet rendered correctly,
> the CSS was right, and every check in `npm run check` was green about it.

**Three ways out, always**: the backdrop, the close control, and Escape. That is the rule
`console/Panel.tsx` already stated for itself — a thing that covers the console must not have exactly
one exit — and the overlay is that rule made general rather than a claim each file makes separately.

**The face is a prop, never a class string.** The `--cn-*` console family and the shared family are a
real distinction rather than a namespace ([Tokens](#tokens)), so `face` names which pair of classes
the overlay wears and neither sheet has to learn the other's names. There are six, and a caller
cannot mint a seventh:

| face     | backdrop               | surface         | drawn for                                       |
| -------- | ---------------------- | --------------- | ----------------------------------------------- |
| `modal`  | `.plan-modal-backdrop` | `.plan-modal`   | the composers, the readers, the filers          |
| `sheet`  | `.plan-modal-backdrop` | `.plan-sheet`   | the plan, which is wider and scrolls its middle |
| `drawer` | `.drawer-backdrop`     | `.drawer`       | the agent drawer, pinned to an edge             |
| `panel`  | `.cn-backdrop`         | `.cn-panel`     | the console's panels — a `<section>`            |
| `hatch`  | `.cn-backdrop`         | `.cn-hatch`     | the hatching ceremony                           |
| `prompt` | `.prompt-backdrop`     | `.prompt-modal` | the prompt-template viewer                      |

The classes are the ones those surfaces already wore, so adopting the overlay is a change of _who
writes the class_ and not a restyling: the two sheets are untouched.

**The head and the foot are props, and both are optional.** `title` draws the `pm-head` — `lead`
before it for what the modal is _about_ (the goal's number, a `Ref`), `chips` after it for what state
it is in, then the one close control, spelled the same way everywhere it appears. `foot` draws the
`pm-foot` as the last child of the surface, so a decision bar never scrolls away from the thing being
decided. A face with a head of its own — the drawer's, the console panel's, the viewer's `<header>` —
passes it as a child instead, because those are three genuinely different heads rather than one
drifting.

**Escape closes the layer on top, never the one behind it.** The dismissable layers are a stack and
only its last entry answers the key. A nested modal — the template viewer inside the settings page, a
questionnaire inside a "Needs you" panel — is always the one opened last, so registration order _is_
depth. `PromptsTab` used to rely on nobody else listening for that, which was true only for as long
as it stayed true; it is a rule now.

`test/modal.test.ts` pins all of it, including from the sharp end: **no `.tsx` outside `Modal.tsx`
may write a backdrop class.** A fourteenth modal written the old way is a modal Escape does not
close, and nothing else in `npm run check` would see it.

### The button

**One control that does something when pressed, drawn one way everywhere** — `Button` in
`web/src/components/button.tsx`, dressed by the `.btn` block in `styles.css` and by nothing else. It is
the [control kit](#the-control-kit)'s argument a third time, for the family the kit never covered.

The cockpit drew about two hundred and thirty of these across **two** families and had no component for
any of them. `AsyncButton`, `SubmitButton` and `ConfirmButton` owned the _lifecycle_ — the spinner, the
settled flash, the two-step arm — and took the _look_ as a raw class string, so tone was hand-written at
every call site and travelled through props as one: `buttonClass="ghost small"`.

**There is one family now, and that is the point.** `.cn-btn` and its four modifiers are gone. They were
a second vocabulary for the same four readings and the two had already parted company: a 7px
steel-blue primary in a modal and a 4px vivid-blue one on a goal page, both called "primary", with
nothing saying which was meant. A primary button is the same act wherever it is pressed, so it is the
same button.

**The second family existed because of a specificity fault, not a design one.** `console.css` resets its
own markup with `.cn button` at (0,1,1), which outranks a single class — so a `.btn` inside `.cn` lost
its ground and its border and drew as bare text, and the console grew its own class to get a button
back. `.btn.btn` in `styles.css` answers that at the source, the same doubling `.th-preset.th-preset`
already uses, so **`buttonClass` writes the base twice** and one rule dresses a button anywhere. Every
modifier below it is already (0,2,0) or higher and needs no doubling.

**Tone is a prop, never a class string**, the same rule the [tag](#the-tag) and the control kit keep:

| Prop               | What it says                                                    |
| ------------------ | --------------------------------------------------------------- |
| `tone="primary"`   | the one control a surface expects to be pressed                 |
| `tone="danger"`    | one that destroys something                                     |
| `tone="secondary"` | the plain one — the default, and it carries no class of its own |

`secondary` is spelled even though it resolves to nothing, because a caller who means "the quiet one
beside the primary" should be able to say so rather than say nothing.

**Weight is `ghost`, not a third tone**, which is the bargain the tag makes with `fill` read the other
way up. The quiet button and the ordinary one are the same box in the same colour and the ground is
what ranks them — so a _destructive_ button can also be a quiet one, `tone="danger" ghost`, which two
of `ConfirmButton`'s call sites are. Spelled as a tone those two readings could not combine and both
would have had to give up their red to keep their transparency. `size="small"` is the second weight,
and it is the one the codebase reaches for most.

**`className` carries shape, never tone.** A surface with geometry of its own — a header row that is a
toggle, a drop target, a close cross — passes that class beside the props, which is the bargain
[the review mark](#the-fleet-reviews-mark) already makes with `t-green`. A station that composes on top
of a caller's tone uses `withShape`, so the caller's half and the station's half stay two things:
`withShape(look, onCloseTicket === null && 'go')`.

**`buttonClass` is the seam for the controls that are not buttons.** The three async components resolve
their class through it and add their own ring; `DesktopLink` reaches it for itself, because a deep link is a
destination, and wears the button's look through the same call. It is what `CONTROL_CLASS` is for the
control kit.

**The state a button is in is drawn once.** `:disabled` and `[aria-busy]` sit on the base, and the
settled-flash ring — `is-done` / `is-error` — is unscoped, because the ring is the _async components'_
statement rather than the button's. Under `.btn.is-done` a console button settled with no feedback at
all, so a click that went through and a click the route refused looked identical.

**This is not the tag's bargain.** `Tag` keeps `.t-*` and `.cn-t-*` as two families on purpose, because
`--accent` is orange and `--cn-accent` is blue and a tag is a _tint_ that has to sit inside its
surface's palette. A button is not a tint: it is an act, and an act reads the same everywhere or the
vocabulary is not one.

`test/cockpitButton.test.ts` pins the vocabulary, the doubled base, and — from the sharp end — that
**no `.tsx` outside `button.tsx` writes `btn`, `cn-btn` or `armed` as a class**. A hand-written `btn` is
single-class, so inside the console it draws as bare text; a hand-written `cn-btn` asks for a family
that no longer exists. Neither is red in `npm run check` any other way.

### The tag

**The** small tinted box — `Tag` in `web/src/components/tag.tsx`, dressed by the `.tag` and `.t-*`
blocks in `styles.css`. There is one, on every surface, and this is it.

The cockpit had **twenty-one**. Two vocabularies of shape — a pill in the UI face and sentence case, a
square one in mono and uppercase — and inside each, a family per surface: `.chip`, `.badge`,
`.cn-chip`, `.cn-tag`, `.pm-dtag`, `.rm-tag`, `.cfg-badge`, `.rp-gate-tag`, `.lrun-tag`,
`.tickets-state`, `.tickets-type`, `.ob-state`, `.cn-thmark`, `.cn-lbl` and the rest. That is not a
tidiness problem; nothing about it was visible from any one call site, and the copies had drifted:

- `.badge.interrupted` was **declared twice**, 1,025 lines apart — red in the block that grouped it
  with `failed`, grey in a later one. The later won everywhere, so the red was a statement nothing on
  screen made.
- `.badge.crashed` took its ground from `--cn-red` and its ink from `--red`. The two are different
  reds, so the tint and the word disagreed by construction.
- Three ambers — `cn-warn`, `cn-stall`, `cn-orphan-chip` — said "somebody has to look at this" in
  three weights, with nothing saying which was meant. Two reds, `cn-you` and `cn-bad`, the same.
- `SetupPanel` asked for `cn-good`, which no sheet declares, so "now" and "at restart" drew alike; the
  feature board's standing column wore `cn-fb-c-*`, which tints a `b` and not the chip, so every
  standing was one grey.

**One shape.** Square, uppercase, mono — 10.5px/600 at 0.4px tracking, `--cn-r-sm`, a 1px border
always drawn. There is no size prop and no second face: the shape is not a decision a call site gets
to make, which is what stops a twenty-second family. What it costs is that the pill is gone as a way
of telling two axes apart — the tickets table used to draw the type square and the state as a pill,
and now tells them apart by column and hue.

**Tone is a prop, never a class string**, the same rule the [control kit](#the-control-kit) keeps:

| Tone     | What it says                                             |
| -------- | -------------------------------------------------------- |
| `red`    | a fault, or a claim that did not hold                    |
| `amber`  | a gate — a call somebody has to make                     |
| `green`  | something landed, or held                                |
| `blue`   | something to read                                        |
| `violet` | a person, a desk run, a container                        |
| `accent` | the one thing on this surface worth going to first       |
| `grey`   | a label rather than a verdict — and the default, omitted |

**One palette, and it is the console's.** The tones name `--cn-*` and nothing else, everywhere. The
two hue families still exist for everything that is not a tag — a lamp, a band header, a rail's edge,
a stripe — but a red tag is one red wherever it is drawn, and `accent` is the console's blue rather
than the page's orange. This is a **reversal**: the tag drew the shared family only, on the argument
that `--accent` is orange and `--cn-accent` is blue and so the two mirrors had to stay two. That
argument holds for chrome and not for a tag. A tag that changed hue when it moved from the config page
to the console _was_ the drift the component exists to end, one layer further down; a rebind per
surface (`.cn .t-red`) is still two families wearing one class.

**Weight is `fill`, not a second hue.** The outlined and the filled tag are the same box in the same
colour and the ground is what ranks them, which is the bargain [the rail](#hue-is-the-kind-weight-is-the-group)
already makes with `cn-parked`. **`dashed` is the box that is not the plain case** — a region outside
the diff being walked, a tracker's copy gone stale, a label a person overrode the checker on.
**`lower` is an id that gets typed back**: those are lowercase kebab-case, and the tag's own uppercase
would be a lie about the one string on the surface that has to be copied exactly.

The tint is seven alias blocks — `.t-red`, `.t-amber`, `.t-green`, `.t-blue`, `.t-violet`,
`.t-accent`, `.t-grey` — each setting `--tone`, `--tone-line` and `--tone-fill` from `:root` and from
nowhere else, for exactly the reason [`.cn-t-*` is an alias](#tokens): a declaration on a tone class
shadows an inherited value unconditionally, so a tint written there is a tint no theme can reach
_inside_ a tone.

**A rail row's tone is inherited, not passed.** `.cn-t-*` aliases `--tone*` beside its own
`--cn-tone*`, so a tag inside a toned queue-rail row takes the row's hue without the call site
repeating the row's decision — and `.cn-parked .tag` reads the same triple for its fill. That is the
only way a tag takes a tone nobody handed it.

**The alias is reusable without the component**, and a few surfaces take it that way: `.flag-chip` is
a link, `.ci-urgent` and `.esc-expiry` add a margin and a numeric variant, and two chips carry a
colour the operator chose in `stateColours`. Each wears `tag` and a `t-*` beside its own class and
adds only what it owes. What they give up is the copy of the triple, which is the thing that drifts.

**What is not a tag.** `.rv-badge` is a count bubble — a number in a circle on the corner of a mark,
not a verdict about a row — and `.tickets-fchip` is a filter _control_. Folding either in would be
renaming a different thing after this one.

`test/cockpitTheme.test.ts` holds the aliases pure: a `.t-*` or `.cn-t-*` block may declare tone
properties and their values must every one be a bare `var(--token)`. It is the only test in
`npm run check` that reads CSS at all.

### The frame

**One card** — `Panel` in `web/src/components/panel.tsx`, dressed by the `.pl` block in
`styles.css`. A card, a panel and a tile are one idea, and the cockpit had written it out at some
thirty class names: `.card`, `.cfg-card`, `.tb-card`, `.tickets-card`, `.pet-card`, `.species-card`,
`.finding-card`, `.lesson-card`, `.cn-fb-card`, `.sp-tile`, `.lrun-tile`, `.ob-tile`, `.cn-box`,
`.cn-warnbox` and the rest. Under the names the same four declarations, and they had drifted the way
copies do:

> **Padding ran 6px 8px, 8px 10px, 9px 10px, 8px 12px and 14px 16px, with nothing choosing between
> them**, and the radius alternated between three named steps and bare `4px`, `7px` and `20px`
> literals. `.finding-card` and `.lesson-card` had become the same five declarations twice under two
> names — with no live call site left on either.

**One variation, and it is who owns the inset.**

| Density  | Inset   | Drawn for                                                  |
| -------- | ------- | ---------------------------------------------------------- |
| `flush`  | none    | a frame whose own children pad — a card with a header band |
| `padded` | `--pad` | every other frame                                          |

That distinction is structural: a card with a full-bleed header band cannot carry an inset of its
own without double-insetting the band, so the frame has to be told which of the two it is. **The
insets under it were not.** The first collapse shipped a three-step ramp — `snug` at 10px 12px and
`roomy` at 14px 16px — on the argument that a ramp short enough to make picking a step a decision is
the fix for five paddings nobody chose. In use it was two call sites and one, 4px apart, and no
principle told anybody which: "the page's subject" describes a Feature card and an escalation card
equally well. A step used once is not a ramp. One inset, `--pad`, on `:root` and in
[the registry](#the-theme) under Corners and density, and a second is a token somebody adds on
purpose.

**One ground, and it is the console's.** The frame also carried a `face` prop — `shared` or
`console`, the two token families, on the argument the [Tokens](#tokens) section makes: they are a
real distinction and not a namespace. They are, on the surfaces that draw on different grounds — a
drawer and a plan sheet mount outside the console, and that is what [`Modal`](#the-modal)'s `face`
is for. **A frame is never one of those.** All four call sites that named the shared face — the
escalation card, the recovery banner, a pet card, a species card — are drawn by `NeedsBand`,
`ConsoleRoot` and the two Pets surfaces, every one of them under `.cn`. So `face` was not choosing
between two grounds a card might sit on; it was making four cards two steps lighter and square in
the middle of a console of `--cn-panel` cards with an 8px corner. The frame draws `--cn-panel`,
`--cn-line` and `--cn-r`, because that is where every frame is. The tier fills on a species card are
mixed over the same ground for the same reason — a band tinted over a ground its card no longer has
is a seam.

**There is no `as` prop.** Thirteen call sites asked for `<section>`, and a `<section>` is a landmark
only when it has an accessible name — which the frame passed none of, and cannot, since it takes no
ARIA props. Thirteen generic elements with a different tag name, selected on by no rule in either
sheet.

**There is no second `Panel`.** `console/Panel.tsx` exported one too: a full-surface overlay, under
the name the frame has, so which box a file got depended on which path its import resolved to. It
was [`Modal`](#the-modal)'s `panel` face plus a two-element header, used twice — now `PanelShell`,
local to `ConsoleRoot.tsx`, where those two call sites are. A backdrop and three ways out are the
modal's; a shared component was never what was left over.

**`className` is a modifier, never a second face.** What makes a frame _that_ frame stays at the call
site — `.cn-fb-wants` tinting a Feature that wants a person, `.cfg-pending` bordering staged edits,
`.tickets-card` clipping its rows — and every one of those weighs (0,1,0) just as the base does, so
`.pl` sits high in the sheet and source order is what lets a card override its own frame.

**There is no `Tile`.** A tile differs from a card in its inset and in nothing else, which is what
the density prop is for; a second component would be the same four declarations again under a name
that means "smaller".

### The head row

`display: flex; align-items: center; gap: 8px; flex-wrap: wrap` was the most duplicated declaration
set in the cockpit — eleven names for one row, in two sheets, differing in nothing but whether they
said `center` or `baseline`. `HeadRow` is that row once, and **alignment is the only axis**:
`baseline` where the row is words of two sizes rather than a row of boxes.

A different _gap_ is a different row and keeps its own rule. The 6px variants — `.finding-head`,
`.pm-part-head`, `.cn-prchips` — are not folded in, because folding 6px into 8px would be a
restyling rather than a collapse, and the point of this one is that nothing on the screen moves.

`test/cockpitTheme.test.ts` pins both from the sharp end, as shapes rather than name lists so a
twelfth cannot be written: a block whose whole content _is_ that declaration set is a hand-written
head row, and a `.pl*` block whose radius or padding is anything but a `var()` naming a `:root` token
is a frame no theme can reshape.

**What deliberately keeps its own frame.** `.tb-card` carries a status bar in an asymmetric left
inset; `.sp-tile`, `.lrun-tile` and `.ob-tile` are readings in a grid at a tighter inset than the
ramp offers; `.rp-panel`, `.build-panel` and `.qn-box` were never frames at all. `.finding-card` and
`.lesson-card` are dead and are left dead rather than migrated. Those are a separate change, and this
one is deliberately shallow: the frame and the head row have one definition each now, and the
remaining names can come to them one at a time.

### The eyebrow

**One uppercase caption** — `Label` in `web/src/components/label.tsx`, dressed by the `.lb` / `.cn-lb`
block in `styles.css` and the four `--label-*` tokens on `:root`. It is [the tag](#the-tag)'s argument
one property further down: not the tint this time, but the size and the tracking — the two things a
reader notices last and a designer notices first.

A caption over a block, a table's column head, a tile's word above its figure. One thing, and the two
sheets drew it at **seventy-seven rules over forty distinct font-size/letter-spacing pairs**:
11px/0.04em, 11px/0.03em, 11px/0.5px, 10.5px/0.7px, 10.5px/0.06em, 9.5px/0.14em, 9.5px/0.12em,
11.5px/0.8px, 10px/0.9px and on. Nobody meant those to differ. Each is a call site answering a
question the sheet had never answered once, and it was the worst drift in the stylesheet by a
distance. Nothing catches it: every rule is valid, every label renders, and two labels a page apart
being a half-pixel and three hundredths of an em different is visible only to somebody holding the two
surfaces up together.

**The ramp is two steps, and a third would be a size somebody picked.**

| step    | token                    | what it is                                                                 |
| ------- | ------------------------ | -------------------------------------------------------------------------- |
| `lb`    | `--label-size` (11px)    | the section label: the caption over a block, a group, a panel              |
| `lb-sm` | `--label-size-sm` (10px) | the dense one: a table's column heads, a stat tile's word above its figure |

The dense step earns its place on one argument: those labels sit in a grid of many, over figures they
must not compete with. Everything else that used to be 9.5px, 10.5px or 11.5px was one of these two
and drew a decimal apart from it.

**There is one tracking, and that is a decision rather than an omission.** `--label-track` is
`0.08em` — em-relative, so it scales with the step and holds at both sizes. A second tracking token
would put "how much tracking at this size" back in front of every future call site, which is the
question the forty pairs were each answering separately. `--label-weight` is the fourth token, and it
takes the choice away from the element: a label written as a `<b>` and one written as a `<span>` used
to differ by a weight nobody declared.

**The ramp owns size, tracking, weight and case — never family, never colour.** Those are the two
axes where the cockpit's registers genuinely differ, and folding them in would make a two-value
component a four-value one:

- **Family.** The review pack, the species sheet and most of the console draw their labels in mono.
  That rule keeps its own `font-family`, which is one line.
- **Colour.** `--muted`/`--grey` against `--cn-fg-faint`/`--cn-fg-dim` is [the two
  families](#tokens), not a namespace, so there are two faces — `.lb` and `.cn-lb` — and a label that
  wants the brighter ink of its family says so on its own rule. `face` is a prop, never a class
  string, the same rule [the modal](#the-modal) keeps for its six.

**Both faces are declared in `styles.css`, and `console.css` says nothing about them.** They are one
decision with two answers, and splitting them across two files is exactly how they drift back apart —
the same argument [scrollbars](#scrollbars) settle the same way. The `--label-*` tokens are core and
not `--cn-*` for the same reason: a ramp is furniture, and furniture is drawn once for everything.

**A label that is markup comes through `Label`; a label that is structure wears the class.** A `<th>`
in a stats table, a `<dt>` in a detail list, an `<h4>` over a briefing — those are elements a surface
already renders, and the class is what reaches them. Thirty-odd such names — `.pm-section-label`,
`.tickets-thead`, `.cfg-railhead`, `.rp-kicker`, `.sp-tbl th`, `.cn-coln`, `.cn-fact-k`, `.ob-tile-l`
and the rest — join the ramp's rule rather than being renamed: renaming forty classes is a diff about
names, and this one is about the type. What they each keep is their own layout, family and colour.

**What deliberately keeps its own size: a badge.** `.tag`, `.cls`, `.pet-rarity` and the others are
boxes — a border, a padding, a ground — where the type is part of a shape rather than a caption over
one, and [the tag](#the-tag) already said those are shapes of their own. Every pair that remains is
inside a box, and most of what used to be listed here is now the one tag.

That is what makes the guard a shape rather than a list. `test/cockpitTheme.test.ts` asserts that
**uppercase text that is not in a box takes its size and its tracking from `var(--label-*)` and from
nowhere else** — no selectors and no allow-list, so it cannot rot as the sheets grow, and a
forty-first pair cannot be written. The `--label-*` tokens are themeable like every other, so the ramp
is also something an operator can move: they carry `kind: 'metric'`, the grammar for a decimal length
or a bare weight, because `space`'s whole-number form would refuse the sheet's own `10.5px`.

### The header's controls

The run's state, what steers the work, and what happens somewhere other than this goal — **in three
groups, each with a caption saying what the group is for**, drawn through [the control
kit](#the-control-kit) rather than as class strings.

| caption         | controls                                               |
| --------------- | ------------------------------------------------------ |
| Run state       | Working / Done / Abandon… — one segmented control      |
| Steer the work  | Give instructions, Watch, Prioritise, the profile pin  |
| Check the work  | Validate locally                                       |
| Leave this page | Open in Claude Code ↗, Open ticket ↗, File a new bug |

_Check the work_ is one control and still its own group, because it is the only one here whose effect
is on **the operator's own machine** rather than on the tracker or on the queue. The whole group is
absent when there is nothing to press — a caption over nothing is furniture — and the card below says
which of the three reasons it is. → [32](32-local-validation.md#the-cockpit)

The row was nine controls at one weight that **wrapped**, so no control had a stable position and no
muscle memory could form. Grouping was the first fix; the captions are the second, and they are the
one that carries. A caption answers "how is this control different from that one" **once, for a whole
group**, which is what lets the control names stay short — `Give instructions` does not have to defend
itself against `File a new bug` when one is captioned _Steer the work_ and the other _Leave this
page_. A group
does not wrap internally, so a narrow page breaks _between_ captions rather than through a group.

**Every control carries an icon, and no icon appears without its label** (`Icon`,
`web/src/components/icons.tsx`). They are recognition aids for an operator who already knows the row —
the glyph finds the control faster than the word does, once. Stripping the label to leave the glyph
turns a legible row into a quiz, which is the trade this header cannot make: it is the surface an
operator reaches when they are least sure what is going on.

**The run's three states are one control, not two buttons at opposite ends of the row.** `Mark done`
and `End the run…` (now `Abandon…`) looked alike and read alike, and what separated them — one writes a verdict and
stops scheduling, the other kills the goal's live agents, cancels its queued jobs and settles its
standing instructions — was stated nowhere either of them could be seen. As segments of a **Run
state** they are obviously alternatives, and which one the goal is in is readable without pressing
anything:

- **Working** is pressed while no conclusion stands. Pressing it on a finished goal withdraws `done`,
  which is what `Unfinish` was.
- **Done** writes the `done` conclusion. Agents already running are left alone; nothing further is
  scheduled.
- **Abandon…** is drawn while the harness holds a run, and once one has been abandoned the segment
  stays, **inert, reading `Abandoned`** — a control that vanished on being used would leave the state
  control saying the run is still working.

Ending still wears `cn-danger`'s red at rest rather than only on hover, and still opens `EndRunModal`
rather than posting: being a segment of the state it ends does not soften what it does. What it lost
is the `auto` margin that pushed it to the far end — distance was standing in for an explanation, and
the caption is the explanation.

**Open ticket is always drawn, and resolves through three keys in order of how much
each can be trusted**: the item's own `url`, which is the provider's; then
`issue:<n>`, which `stateSnapshot` keys for every world issue _and_ every retained
run and which nothing else ever writes; then `#<n>` last, because `buildRefUrls`
walks the pull requests before the issues and the first writer wins — so on a
tracker carrying both issue 412 and PR 412, `#412` is the _pull request's_ address.

Both halves of that were faults, and both were silent. Resolving through `#<n>`
alone opened the wrong thing on a number collision, and it made the control vanish
on a **retained run** — `#<n>` is built from `world.issues`, and a run the harness
kept after its ticket left the world is by definition not in that list, so the goals
whose ticket is hardest to find by hand were the ones offering no way to it.

When nothing resolves the control is still drawn, **inert rather than absent**: a
`<span>` with `aria-disabled`, dimmed, saying in its title that the tracker gave the
item no address and the harness could not derive one. A control that comes and goes
is a row whose shape depends on what a provider happened to resolve, which is the
opposite of what the groups are for; and "the ticket is not reachable from here" is a
fact worth stating, where a missing button says nothing and reads as the cockpit
having forgotten. It stops being an `<a>` because a link that leads nowhere is the
dead end [refs](#links) exists to prevent.

- **Open in Claude Code** is the row's one control that writes nothing, and it is named for where it
  goes — the one label every deep link in the cockpit carries
  ([above](#opening-the-operators-own-claude-code)). An `<a>` carrying
  `claude://code/new?q=/lubbdubb ask <n> &folder=<config.desktopFolder>`, built by the same
  `desktopDeepLink` the plan sheet's and the validation card's hand-offs
  use ([20](20-validation.md#starting-a-run-from-the-cockpit)), so it opens the operator's own Claude
  Code on the goal's checkout with the command already in the composer and the harness's whole record
  of the goal one `goal_read` away ([11](11-mcp-tools.md#answering-a-question-about-a-goal)). It is
  what the cockpit had no answer for before: a question about a goal — what was actually done, which
  pull request, why four goes, is it on hallway yet — was answered by reading this page, reading the
  repository, and joining the two by hand.
  - **The question is not in the link.** The other three deep links start a job with one meaning, so
    the whole command is prefilled; this one starts a conversation whose subject the operator has not
    said yet, and `q` fills the composer without sending. What lands is `/lubbdubb ask 284` with the
    cursor after it — the half they should not have to type — because there is no reading of a click
    that says which question it was.
  - **The command is in the title as well as the `href`**, the deep link's standing rule: the link
    fires only on the machine the browser is on, and a client that is not installed answers nothing
    at all, so an operator reading the cockpit from another desk is left with the line to type rather
    than a control that did nothing.
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
- **Give instructions** opens `InstructionModal` and writes what the operator wants done next, in
  words. It is captioned under _Steer the work_ rather than sitting beside the conclusion, because what
  it writes is not the opposite of `done`: it is an instruction, plus everything that puts the goal back
  in front of the harness once no PR is open — the `more_work` verdict, which retracts a standing
  delivery, and a plan that had rolled up `complete` sent back to a planner for the operator to approve
  again
  ([06](06-issue-pickup.md#concluding-an-issue),
  [16](16-http-api.md#post-apiissuesnumberinstruction)). The modal says both, because a control that
  quietly unwinds a delivery is one an operator has to be able to predict. It is offered on any open ticket, **including
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
- **File a new bug** is gated on `config.canFileTickets` and opens the shared `RaiseBugModal`. It files
  into the tracker rather than writing a verdict about the item, and it leaves the goal's own verdict
  where it found it — which is exactly why it is captioned **Leave this page**, beside the two
  destinations,
  and not beside `Give instructions`. The pair had no visible difference and one is a second ticket.
- **Abandon** is keyed on the run **existing and not yet ended**, never on anything else the page
  is showing — the lesson `planId` and `retroRef` learned. It is how a retained run is ended, so it
  has to be reachable for exactly as long as the harness still holds one
  ([16](16-http-api.md#post-apiissuesnumberdismiss-run)). It is the header's one **destructive**
  control: it wears `cn-danger` (red at rest, not only on hover — the warning has to be there before
  the pointer is), it reads `Abandon…` on every goal — the word the modal it opens uses, because a
  control and the confirmation it raises disagreeing about what is about to happen is the one thing a
  confirmation exists to prevent — and it opens `EndRunModal` rather than posting. That is unconditional now, and the change is earned by what the route became: ending a run
  kills the goal's live agents, cancels its queued jobs and settles its standing instructions, none of
  which can be undone. A one-click toggle that abandons work in flight is the friction rule pointed
  the wrong way — the rule is against friction nobody's decision asked for, and this is a decision.
  The modal **states the counts** rather than summarising them: "2 running agents killed mid-turn" is
  a sentence an operator can check against the header they are looking at, and "stops work in flight"
  is one they cannot. The live count is read over the `issue:<n>` subtree alone, which is the exact
  scope `clearGoalWork` sweeps — a `pr:` dispatch is not in it. Since the page counts a pull
  request's agents as the goal's ([below](#who-is-on-the-goal)), the header's number and this one can
  differ, so the modal **says so**: a line naming the agents on the goal's pull requests that keep
  running, and where to stop them. Silently killing fewer agents than the operator just read is the
  failure the stated counts exist to prevent, and quietly widening the sweep to match would end runs
  the route was never asked to end. The flagged-plan note is one more requirement _inside_
  the modal — [below](#saying-the-sentence-a-refusal-asks-for).

### The track

**The goal's pipeline in one row, each stretch a way to the section that owns it.** Plan → Validation →
Shipped → Close-out, built by `buildGoalStrip` (`web/src/view/goalPage.ts`).

It exists because the answer to _where has this goal got to_ was in four places and none of them was
one: "2 of 5 parts merged" and "Validation 3/7" in the header, "5 parts" on the plan card, "2/3" per
environment, four lamps in The tail — three screens apart, in three vocabularies.

Three rules make it safe to put at the top of the page.

- **Every reading is one a card below already draws.** The strip folds `parts`, `issue.validation`,
  `environments` and the tail's own fields; it computes no verdict of its own. A stage that measured
  something itself would be a fifth opinion that can disagree with the card it points at, which is the
  fault it replaces, made bigger and moved to the top.
- **A stage with nothing to measure draws no bar**, and `done` is `number | null` for that reason. Null
  is a third reading and not a synonym for zero: a goal with no validation plan has no checks
  outstanding, and an empty bar under "no checks" would report every one of them still to run. The same
  distinction `ValidationVerdict` makes one layer down, and the same one the three reach verdicts make
  for an environment ([24](24-environments.md#the-three-verdicts)) — which is why the Shipped stage
  answers `unknown` in its own words, before it would ever say "not shipped".
- **The Shipped stage is absent when no environment is configured**, exactly as the card is. A stage of
  question marks on a deployment that never set one up is a feature announcing itself as broken.
- **It carries the post-deploy watch's reading folded off the card** — `reached liveUk · watch clean`
  — rather than computing a second verdict, which is the first rule applied to the newest card. This
  is the one place a watch is reduced to a word, and the reduction is one-directional: `regressed`
  first, then anything not `clean` reads _watch not read_, and only a window whose every check came
  back clean says so. A row with space for one reading must never fold an unread environment into an
  all-clear. → [29](29-post-deploy-watch.md#in-the-cockpit)

Each stage takes its hue from a `cn-t-*` tone alias, so it invents no colour and owes no new token —
green settled, blue moving, amber held or failed, grey not reached.

They are **anchors, not refs**: each jumps to one element on this page, so each is a `<button>` with a
`scrollIntoView` and not an `<a href="#…">`. The cockpit's address bar is `Place`, and a hash the place
knows nothing about is a history entry the back button steps through to nowhere. The `ANCHOR` map in
`GoalPage.tsx` is keyed on `GoalStageAt`, so a stage the strip learns to draw cannot ship without
somewhere to land — a missing entry is a compile error rather than a control that does nothing.

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
Decline already had — as does **Close the ticket…**, since the flag is about the goal rather than
about which verb settles the row, and one box serves all three. `EndRunModal` mirrors the same condition **inside itself** rather than in whether
it opens: on a flagged goal the box is required and the confirm stays disabled until it is filled; on
every other goal it is offered and optional, since an operator with a reason should not need a flagged
plan to record it. The condition is mirrored, the counts are not: they are `issue.validation`, folded
once on the server, and the row's own detail already lists what is outstanding.

The header no longer draws a `.launch-error` of its own for this control. It had one because ending a
run was a one-click post with nowhere else to put a refusal; the refusal now lands in the modal that
sent it, which is where the text that was refused still is.

**A `close_out` row carries a third verb: Close the ticket.** The obligation the row states is a close
in the tracker, so the button that takes it sits beside the two that record it and leads them —
`HumanTaskActions` draws Done as the secondary where it is on offer, because Done is what an operator
presses having already closed the item somewhere else. It posts
`POST /api/human-tasks/:id/close-ticket` ([16](16-http-api.md)), which closes the item and settles the
row together.

It is drawn only where all three hold: the row is an open `close_out`, its origin is an `issue:<n>`,
and `config.canCloseIssue` is true — the connector's own answer, asked once on the server rather than
inferred in the browser from the provider's name, exactly as `canSetWorkItemState` is for the board's
drag. Where it is false there is no button and no disabled ghost of one: the row's own detail already
states the other way out, and a control that cannot work teaches nothing that sentence does not.
→ [13](13-jobs-and-tickets.md#the-step-after-the-launch-the-close-out)

**A band whose source has left the snapshot draws nothing at all.** A header over an empty box would
claim something is waiting while offering no way to answer it.

#### A goal with no parent Feature

Above every band and every card, between the header and the track, a goal that hangs off nothing gets
an amber warning of its own, wherever the tracker could be handed a parent — the feature board's flag
is not part of this. It is not one of the bands above and wears no tone class: the tone
families are the _needs-you_ palette, and a goal is an orphan whether or not the rail is holding a row
about it.

The reading is `orphanGoal` (`web/src/view/orphanGoal.ts`), and it is three facts read fresh on every
draw:

- **`config.canPlaceWorkItem`** — the connector's own answer to whether one item can be hung off
  another, asked once on the server exactly as `canCloseIssue` and `canSetWorkItemState` are. Where it
  is false the warning would be a dead end rather than a warning, and it is drawn nowhere.

  It was **`config.featureBoard`**, which is that same probe _and_ the operator's own flag, folded by
  `featureBoardOn` ([the two gates](#the-two-gates)). The argument for the conjunction was that
  somebody who has not asked for the tier above their stories has not asked to be told which stories
  are missing from it — but that argument is about a **tab**, and this band is about a fact: the goal
  merges, closes, and rolls up to nothing. One flag was answering both questions with the tab's
  answer, so a real Azure board with Features and Epics in it, six goals hanging off nothing, and a
  tracker that would take the write said nothing at all, because nobody had asked for the tab. The
  rail does not cover that gap either — its row rides inside `issue.appraisal`, and five of those six
  had no appraisal row. → [#683](https://github.com/AdamAwan/LubbDubb/issues/683)

- **`issue.parent === null`** — the tracker saying this item hangs off nothing. `undefined` is a
  provider that tracks no hierarchy at all, and folding the two together is the silent direction: an
  amber band on every goal of every GitHub deployment.
- **Nothing stored.** An operator who sets the parent by hand in Azure ends the warning on the next
  world read — no timer, no world event to have missed. Same derivation `placementAsks` takes, pointed
  at the item rather than at the question ([06](06-issue-pickup.md), `src/intake/placement.ts`).

**Why it is louder than the ask it sits above.** The warning is the **fact** and never the question:
a goal that hangs off nothing merges, closes and disappears from the backlog whether or not anybody
proposed a container for it, so the proposal — where there is one — is what the band _offers_ rather
than what makes it appear. The rail's `placement` row was gated on the appraiser having _proposed_ one
and now takes the same reading ([06](06-issue-pickup.md#the-parent-question-is-the-fact-the-area-path-question-is-the-proposal)),
which leaves this band two things of its own: the goal picked up before the appraiser ran at all —
`placement` rides inside `issue.appraisal`, so there is no row for a goal with no appraisal row — and
the weight, which is the next paragraph.

**Two weights, one fact.** Unanswered, it draws in full with the three answers under it. Answered —
"this goal wants none" — it goes grey and one line tall, keeping the way back. The item is still an
orphan and the board still cannot roll it up, so the reading does not go away; it has stopped being an
ask, and an amber band standing over a decision somebody made is how a warning gets ignored.
`IssueAppraisal.parentSettledAt` is what separates the two, shipped on the wire beside `placement`
because it is the one half of the pair the browser could not derive: `placement` says a question is
_open_, and an orphan with none open is either a goal nobody proposed anything for or one whose
answer was "it wants none".

**The three answers are `ParentPicker`, shared with the rail's band.** One write to one tracker field,
put in two places, offering the one `world.parentCandidates` list the server derives. The goal page therefore draws the `placement:parent:` row _only_ through this
warning and filters it out of its own bands — one question, once, per page. The rail keeps its row,
and the ask panel still answers it for an operator working down the queue rather than down a page. The
area-path half of `placement` is untouched: a different question, with a different answer.

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

**Every row carries a rail on its left, coloured by state, and the hues are weighted rather than
merely coded.** The chip already says the state in a word; the rail says it in a scan, which is the
reading a card of nine checks actually gets. What is still owed draws at full hue — amber for `unrun`,
red for `failed` — and what is done draws at a fraction of one, a `color-mix` of green at 45% for
`passed` and the flat `--grey` for `waived`. A list of checks is a list of work left, so a done row at
full strength is the card overstating how much of it there is. A withdrawn row's rail is transparent:
it is not a state anybody is owed an action on.

**A row still owed is washed in its own hue** — amber at 15% for `unrun`, red at 15% for `failed`, and
amber at 7% for `deferred`, which is half of one: still owed, but waiting on something named rather
than on somebody finding the time — so the outstanding checks are one shape a glance resolves before it
resolves a word. A pass is washed too, in green at 6% — a settled row with no ground at
all only says "not amber", which is a thing a reader works out rather than sees. The **ratio** is the
whole of it: green loud enough to be its own state, quiet enough that a card of nine shows what is left
before it shows what is done. A waiver takes no wash, because it is the one settled row whose reason is
a decision rather than a reading, and the grey rail is what says so.
The rail and the muted head are readings of a _row_; the wash is a reading of the _card_. It is the
outstanding rows that lift rather than the settled ones sinking, which was the first attempt: this
component is drawn on two stations, and the console's card ground is already the darkest value in that
palette, so there is nothing below it to sink onto. A translucent wash owns no ground and works on
both. It stays a wash on purpose — the amendment and hand-back bands are the two things on a closed
row that must remain the loudest, so this has to read as tinted paper behind them, never as a surface
competing with them.

**A settled head is drawn a step back.** A passed or waived check is a reading somebody already took,
and at the weight of one still to run it reads as work — a card of nine says "nine things to do" at a
glance when it means two. So the title drops to `--muted` at a lighter weight, the letter and the
identifying chips fade, and hover puts the ink back so the row still reads as a control. Three limits
make it a de-emphasis and not a hiding: it is scoped to the **head**, so the amendment band, the
hand-back band and the result note keep their full weight — those are the things a reader must not
scroll past, and dimming them would undo the reason a closed row draws them at all; it lifts the
moment a row is **opened**, because an operator who opened one is reading it; and it is deliberately
lighter than the `.gone` treatment on a withdrawn check, since _withdrawn_ and _done_ are not the same
news.

The check's hand-off is the odd one out and is the reason it exists: it writes nothing. A desktop
session is started from the operator's own Claude Code, not from here, so the control is an `<a>`
carrying a `claude://code/new` deep link that opens that client on the goal's checkout with
`/lubbdubb <issue>:<letter>` prefilled — the same builder the plan sheet's hand-off uses — and the
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

**A part carrying an open pull request draws that request's checks mark and court chip, embedded from
the pull-request card rather than re-derived.** The column a part stands in says where it is in
_dispatch order_ and nothing at all about whether it is moving: "Now" covered a part with red CI, a
part sitting on a reviewer and a part an agent was mid-way through, and telling the three apart meant
scrolling to the pull-request card and matching PR numbers by eye — on the one surface whose whole
job is to be read at a glance. The two components are `CiMark` and `CourtChip`, the same two the card
draws, for the reason the track strip is folded rather than written: a second
reading of `ciVerdict` or `attention` beside the first is a second chance to classify a check the CI
policy already classified, or to disagree about whose court a PR is in, from a component sitting
nowhere near the one it duplicates.

**A dead pull request's word is drawn only where it disagrees with the column.** The checks are not
drawn for one at all — on a closed PR they are history, which is why the card's own closed rows carry
a word and no chip — and `merged` under the **Merged** heading is the heading a second time. What
survives that cut is the pair that says something the board cannot: a merged pull request on a part
grouped anywhere else, and a pull request closed without merging.

**A part's agent is found through its pull request as well as through its own ref.** A part is
dispatched at `issue:<n>:part:<slug>`, and everything that happens to it after it opens a pull
request — the CI fix, the review round, the retarget — is dispatched at `pr:<n>`. Read off the part's
own origin alone the row drew no agent at all on exactly the parts that were moving, which is the
same blindness `agentOnGoal` is resolved through `goalOfOrigin` to avoid one tier up. Both origins
are read, and the **live** one wins where there are two: what is happening now outranks the record of
what happened, and the snapshot's newest-first order settles it when neither is live.

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
([03](03-world-model.md)).

**The closed rows are kept for ever, and they are stale on purpose.** `world.closedPullRequests` is a
window `closedPrWindowMs` wide, and drawn off it alone a goal's pull requests disappeared from its page
a few hours after they merged — the page of a goal delivered last month said nothing had ever named
it, which is the one question that page is opened to answer. So the closed list here is the union of
that window and `archivedPullRequests`, the same rows kept in `pr_archive`
([14](14-persistence.md#the-closed-pull-request-archive)), deduplicated by number with the **window's**
copy winning: the two disagree only while a pull request is recent, and the window is then the fresher
reading of the two. Nothing re-fetches an archived row and no rule reads one — what is drawn is the
last thing the world said about a pull request nothing will happen on again, which is what the
alternative (no row at all) was hiding. The same pair answers [the pull request page](#the-pull-request-page),
so a closed row still opens the page it links to rather than the gone screen.

**The pull request's name is the way onto [its own page](#the-pull-request-page)**, with the
provider reference beside it — never inside it, since one click cannot have two destinations and the
provider is a different place from the cockpit's page for the same pull request. The
[review pack](31-review-packs.md#reading-it) is asked for and opened there rather than on this row,
which is where it sat while there was no pull request page to put it on. What the row keeps is the
one bit that says whether going there is worth it: the [pack mark](31-review-packs.md#on-the-row),
third in the reading slot, drawn only where there is a pack or one being written.

One number does come back to the row: how many review threads the fleet still owes an answer, as
_n on us_. It is drawn only when there is one — a chip reading `0` on every settled pull request is
furniture — and never at all where the provider reports no threads, since a chip there would be a
claim about a review the harness cannot see ([07](07-pull-requests.md#review-threads)).

Whose court a PR is in is `attention.status`, and which check is red is `ciVerdict`; both are quoted,
never re-read. The chip prints the server's own word with `attention.reasons` in its title, and the
checks are [their own mark](#the-checks-mark) — with **no check name written anywhere in this
repository**: every one comes off the verdict. Where the provider reported no per-check detail at all
the aggregate speaks under a generic name rather than drawing nothing, because missing detail is not a
clean bill of health.

`CiMark` is `web/src/components/CiMark.tsx` and every surface draws that one component, since two
readings of one verdict side by side is how the same PR comes to wear two tones nobody chose.
`CourtChip` stays in `GoalPage.tsx`: the rack draws the same verdict behind its row marker — the card
wears no state word ([the state column](#the-row-grammar)) — and this page has no marker to put it
behind.
`waitedFor` is shared for the chip's reason — the rack draws the same age as a fact.

**And the row itself carries it.** `PanelRowModel.live` puts a green edge down the row and a slow
sweep across it — the whole line, rather than one more mark in one more slot. That is the honest shape
for what it says: every other reading on a row is a fact _about the thing_ and sits in the slot for
that fact, while this one says the row's subject is under somebody's hands as you read it, and is
about to make the rest of the row out of date. A card where one row is moving is readable across a
room; a 6px mark in the fifth column is not. The two are one signal with two jobs — the sweep is what
is _happening_, the marker is where to _go_ — and the motion is what a `prefers-reduced-motion` reader
gives up, never the edge or the marker.

The chip itself is **`web/src/components/AgentOnIt.tsx`, shared**, because it is one fact and the
cockpit had been saying it two ways: the rack in the slot its checks would be in, and a plan part as
`open the agent ↗` inside its dependency line — two wordings, two weights and two hovers for one
sentence, which is how a reader learns to treat one of them as furniture.

**It is a glyph and no words** — a pulsing green disc carrying the shared set's `play`, and the icon
set's **one stated exception** to "an icon never appears without its label" (`Icon`,
`web/src/components/icons.tsx`). It earns the exception on two counts. It is not a control an operator
has to _find_: it appears in a fixed slot on rows they are already reading, and its job is to be
countable down a column rather than read. And it _repeats_ — `agent on it` written out eight times down
a rack is eight copies of one sentence, which is how the one row where it is news stops standing out.
Nothing is lost: the sentence, and the agent's own last answer to "what are you doing" where the row has
one, is the `title` and the `aria-label`.

**It rides the lamp slot, at the head of the row, on both racks.** It stood in the reading slot on the
pull-request rack — third of three glyphs — and in the chips group on the goal rack, behind the
environment and the orphan chip; either way its distance along the row moved with whatever its
neighbours happened to have to say, so the one mark that means _something is happening to this right
now_ was the one an eye could not find twice in the same place. `PanelRow`'s lamp column is what that
grammar is for: held open on every row of the card once any row fills it, so the mark is either there or
visibly not. Both racks, because they sit one above the other and a glyph that means the same thing on
both has to be in the same place on both. The column is **absent altogether** while no agent is out, so
a quiet rack pays no gutter for it, and its width is the card's (`.cn-lamp-mark .cn-rows`, 30px) rather
than the token's — every other rack's lamp really is an 8px dot, and the extra room is what keeps the
chip off the watch eye beside it. → `test/panelRows.test.ts`

A part draws it while its agent is live and keeps the plain way in once that agent has finished, which is why `GoalPartView`
carries `agentLive` beside `agentId`: a finished agent is still the way to what happened there, and
only a live one is a claim that something is happening now. Folded into one field, a merged part would
pulse. → `test/goalPage.test.ts`

**A live agent on the branch replaces the checks, on the overview's rack.** Not beside it —
it supersedes it: the checks are a reading of a commit the agent is in the middle of replacing, so a
green dot next to a working agent is the least true thing the row can say. The marker is a way into
that agent's transcript, and it is drawn from `agentOnBranch` — the two-hop join from an agent's
`taskId` to its task's branch, derived once in the view model because a card doing it itself is a card
that will do it slightly differently. **Live agents only**: a finished agent's branch is history, and a
marker that outlived it would be a pull request that looks staffed forever, which is the one row
nobody re-checks. The moment the agent ends, the checks come back. → `test/panelRows.test.ts`

**A failing check reads red.** It was drawn in `--cn-inert` — the grey the token block calls
_deliberately not a verdict_ — on the reasoning that a red check the harness is already dispatching on
is not your move. But at 6px that is the empty track, so the most actionable reading on the row was
drawn as the least, and the row said nothing where it should have said the loudest thing it knows.
Whose move it is is the row marker's answer now, which frees the checks to answer only _is this
broken_. → [the checks mark](#the-checks-mark)

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

### Who is on the goal

**On this goal** lists the agents this goal has had, live ones lamped and finished ones plain, each a
way into its drawer.

**A pull request is for a goal, so an agent on one is on the goal.** A dispatch names the goal's own
subtree (`issue:390`, `issue:390:part:writes`, `issue:390:retro`) or it names a pull request
(`pr:412`) — and a card that read only the first said _no agent is on this goal_ while somebody was
fixing its build, restarting its review round or retargeting its branch. That is most of the time a
goal has anybody on it, and it is the one question this card exists to answer. Which pull requests are
the goal's is `goalOfPr`'s three-way match, the same one the pull-request card is drawn with, so a
second reading cannot put an agent on a goal the card below it says the PR does not belong to.

**The row names that pull request**, as a `<Ref>` beside the name rather than as text: a row that says
an agent is on something and does not say where is the dead end [Links](#links) exists to stop. It sits
**beside** the name and never inside it — the row's own click opens the transcript, and one click
cannot have two destinations — which is why the row is a `div` carrying a `cn-grow` button, the shape
the fleet card and the backlog row already use.

**The header's agent count is this list's length**, pull-request dispatches included, because it is the
same question asked in fewer words. What ending the run kills is _not_ read from it — that is the
`issue:<n>` subtree alone, and the modal states the difference
([the header's controls](#the-headers-controls)).

→ `test/goalPage.test.ts`

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

**The post-deploy watch is drawn inside the environment's own row**, indented on the well behind a
tinted left edge — the layer above reach, saying what the running system has done since the work
arrived ([29](29-post-deploy-watch.md#in-the-cockpit)). Inside the row and not beside it, because a
watch belongs to an arrival: drawn as a sibling, the two surfaces would be free to disagree about
which environment a reading came from. The block says how long the window has left, or when it
settled — and, where somebody extended it, that it was extended, since otherwise the line states a
window length no configuration would produce. The **extend** control sits at the end of that line
rather than among the readings, because what it acts on is the window: a control level with the checks
would read as an answer to one of them, and what it actually does is re-open the window and let the
readings under it carry on ([29](29-post-deploy-watch.md#closing)). Then it draws **every check** — because a goal whose one signal passed and whose other
regressed is a fix that worked and a thing that is still broken, and one word for the pair would hide
the half the ticket was about.

A measure draws as **expected, before, now** — `Expected no worse than its baseline · before 8,400 ms
· now 310 ms`. The before is what makes the row worth looking at: a p95 of 310ms means nothing alone
and everything beside the number it replaced, and it is available precisely because the baseline was
taken at declaration rather than inferred later. A measure whose baseline was never taken says _before:
never taken_ rather than printing a number with nothing beside it, which is the same reading its
verdict takes — `unknown`, because a comparison against nothing is not one that passed.

Three readings, and the third is the one that matters: `clean`, `regressed`, and `unknown` for a watch
that could not **read** the environment at all. `unknown` says why in words, on the row, and never in
the vocabulary of a clean one — it takes the same tone as an unknown reach verdict, for the same
reason. A check nothing has read yet says so as well, in the plan sheet's own words: not yet put to an
environment is not a clean reading. Nothing renders where nothing is watched — not an empty block, not
a row of question marks — because null is a third fact and not a synonym for clean.

### What the goal page deliberately does not draw

**This goal's slice of the decision log.** `buildGoalPage` computes `decisions` — the rows whose
`subjectRef` names the goal — and nothing renders it. The snapshot ships the last hundred audit rows
fleet-wide and a cycle spends one of them every pulse on its own rationale, so filtered to one goal the
list is a handful of dispatches at best and empty for any goal not touched in the last few hours. The
design's stated arm was that this becomes its own route, and this takes that arm: **deferred, not
half-built.** A per-goal activity list is a route away, and the derivation is already here to draw it
from.

## The pull request page

One rung further in than the goal page: **a selected pull request outranks a selected goal, which
outranks the nav**. It is reached from a goal's pull-request row, from the overview's pull-request
rack — whose row name is the way onto it — and from any `<Ref>` that names the pull request at all
([links](#links)), and the crumb at its head draws the
whole ladder — the tab, then the goal it was reached from, then the pull request. On one no ticket
owns, which the harness works and which therefore reaches this page too, the middle rung is simply
absent: the trail is as deep as the place is, never padded to a fixed shape. Leaving it with the
page's own control (`selectPr(null)`) lands on the goal underneath, which the place never cleared;
and because a `<Ref>` reaches this page from anywhere at all, the tab it hangs off is narrowed to one
that lists pull requests on the way in → [nesting](#nesting).

**The goal rung _selects_ the goal, rather than clearing the pull request over it.** The two are the
same move only when the place already holds the goal, and it does not always: the overview's
pull-request rack — and every `<Ref to="pr:…">` drawn away from a goal page — opens this page with
`pr` and nothing under it. The rung is still drawn there, because the page derives what owns the
pull request from the snapshot rather than from the place (`goalRef`, `web/src/view/prPage.ts`), so
`selectPr(null)` fell through the rung the operator had just clicked and landed on the tab: a crumb
that named the goal and went to the overview. `web/src/console/PrPage.tsx` draws it; `web/src/view/prPage.ts`
derives what it draws.

**The pull request is resolved out of three lists**: the open world, the closed window, and the
archive behind it — `closedPrs` in `goalPage.ts`, the same pair the goal page's closed rows are drawn
from. That is what keeps a closed row a link rather than a dead end: a page that could only find a
pull request the window still held would answer the gone screen for every row the goal page now keeps.
An archived reading carries no verdicts, exactly as the window's does not, and the page draws what is
absent as absent.

**It has no route of its own.** Every reading on it is one the harness has already made and already
ships on the snapshot — the threads and their state, the checks, `attention`, `health`, `ciVerdict`,
the tasks dispatched onto the branch. A second read would be a second answer to a question
`/api/state` has answered, and the three verdicts in particular are quoted rather than re-derived,
for the reason the goal page quotes them.

What it draws:

- **The masthead** — number, title, branch → base, head, author; then the state chips: open/merged/
  closed, the [checks mark](#the-checks-mark), approval, `mergeableState`, how many threads are on the
  fleet, and whose
  court it is. The goal's reference sits at the far end of that line, and only the goal's: a ref onto
  this pull request opens this very page, so the provider's own is a control of its own —
  `Open pull request ↗`, the shape the goal page's `Open ticket ↗` already has. The
  [review pack](31-review-packs.md#reading-it) control rides the masthead beside it: a pack is a
  reading of _this diff_, which is what the masthead is about.
- **The review threads**, which is what the page is for — see below.
- **The checks**, in the CI policy's own three categories: what the harness will fix, what it will
  put to a person, what it has been told to leave alone. No check name is written in this repository;
  every one comes off `ciVerdict`. Where the provider reported no detail, the card says whether it was
  withheld by policy or never reported — neither is a clean bill of health.
- **What is holding it up**, from `health.reasons`, and nothing at all when nothing is. A card
  reading "healthy" on every green pull request would be furniture.
- **Work on this branch** — every dispatch onto it, newest first, each a way into the run. Joined by
  **branch**, which is the only join that is true of a pull request: a goal's other pull requests are
  worked on their own branches.

### The threads, and the one control

Each thread is a **card**, and the conversation inside it is drawn as one: the root comment, then the
replies indented under it on a single line, each message on its own ground and any reply the harness
wrote tinted and marked. That mark matters more than it looks — on a single-operator deployment the
fleet posts under the operator's own credential, so the name alone cannot say "the fleet has already
answered this", which is the fact a reader needs before doing anything about it. A card rather than a
row in a ruled list, because a thread is a conversation with a state: hairlines alone put one thread's
reply hard against the next thread's question, and a flat run of messages made a thread of three read
as three threads.

The state is a chip whose title says what the state _means_, and it is the card's **left edge** as
well, so one glance down the edges says what is still owed. The two states that are still work tint
the card's ground too, since "what is still on us" is what the page is for.
Threads are ordered by what is owed — reopened, open, answered, resolved — and within a state the
provider's own order stands, which is the order the review was written in. A resolved thread is drawn
back rather than hidden: it is the record of what was asked.

**Absent and empty are different answers and are said differently.** A provider that reports no
threads gets a sentence saying so; a pull request nobody has commented on gets a different one.
Folding the two would claim nobody reviewed a change the harness simply cannot see the review of.

The one thing the page _does_ is [reopen a thread](07-pull-requests.md#reopening-a-thread) — put it
back in front of the fleet, so the harness reads it as unanswered and comes back to it. It is offered
on `answered` and `resolved` threads and on nothing else: an open thread is already work, so a control
claiming to reopen it would be a button that changes nothing. On a reopened thread the same control
takes the ask back, which is the only way out of a mark set by mistake. Both are absent on a pull
request that has left the open set, since nothing acts on one.

There is deliberately **no reply and no resolve here**. A reply the harness sends is signed by the
harness and written by an agent that read the diff; a box on this page would be the operator posting
through the fleet's identity with none of that behind it. Answering a reviewer is the fleet's job, and
this page's job is to say when it has not done it well enough.

## The overview

What the situation area shows when no goal is selected: five cards, rows rather than pictures, in
reading order — **Fleet**, **Goals in flight**, **Pull requests**, **Build**, **Project**. The
fleet's **runway** is a band along the foot of the first of them rather than a card of its own, because "who
is out" and "what is behind them" are one thought — and for the same reason, so is
[**Up next**](#the-queue-rides-the-fleet-card), which used to be the fourth card here.

**Environments used to be the fourth card, and is [a chip on the bar](#the-environments-gauge) and a
panel now.** Health is a fact about the world the work ships into rather than about anything on this
page, and the answer is _well_ nearly all of the time — a sixth of the overview spent saying so, on the
page that answers _what is happening_. What was glanced at is the chip beside the fleet cap, drawn only
while something is not well; the card's rows are the panel behind it.

**World signals used to be the fourth card too, and is [a panel](#world-signals) now.** It is the one
surface here that was not about what is happening but about what happened to bring it about — read
when a queued row, or an empty queue, wants explaining, and not glanced at on every pulse. As a card
it spent a full-width slot on ten rows of a feed nobody had come to the page for.

**Build and Project are last, and they are the two cards not about the fleet's work** — Build is the
process the fleet runs inside and Project is the repository it is pointed at, two different checkouts
read on one timer. Project is the only card that reports a git status on the glass, because that
status is half the answer to why Build beside it has no buttons — and it carries the one control the
cockpit offers on a repository the harness does not own, because the project config arrives by that
pull. Both headers carry a refresh glyph beside the count and the time the reading was taken.
→ [21](21-self-update.md#where-it-lands-in-the-cockpit)

Build is a card rather than a rail row because being behind is a _standing condition_: true
continuously, for weeks if nobody looks, and answerable only by upgrading. The rail is for asks that
settle when they are answered, and a row that cannot be discharged is the furniture that teaches an
operator to skim the whole queue. → [21](21-self-update.md#where-it-lands-in-the-cockpit)

Two rules run through all of them. **Nothing here re-decides what the server decided**: a PR's court is
`attention.status`, its checks are `ciVerdict`, a queued item's hold is the queue's own sentence, and a
goal's state is its `pickup.status`. And **an empty card still draws**, muted, because a surface that
vanishes when quiet is indistinguishable from one that broke.

A third now runs through all of them as well: **no card writes a row.** Each builds a `PanelRowModel` and
hands it to `PanelRow` — see [the row grammar](#the-row-grammar) below.

### The row grammar

`<Ref>` settled how a reference is _drawn_. What it did not settle is where a row puts one, and the
the cards answered that several ways: the refs group on Fleet and World signals, a prefix inside
`cn-name` on Pull requests and on the queue's rows. The rest of the row had drifted the same way — a
dot-separated sub-line whose parts differed per card, and one `cn-num` slot carrying a cost on a fleet
row and a `×3` on a signal row. Each card read correctly alone, which is why none of it was ever a
bug anybody filed; the overview is only ever read two cards at a time.

So the row is a **value**, `PanelRowModel` in `web/src/console/PanelRow.tsx`, and the card builds one
rather than writing markup. The fields are the grammar: `lamp`, `title` with its optional `open`,
`toggle`, `who`, `refs`, `facts`, `why`, `reading`, `chips`, `action`, and the `group` a row sits under.
Three of them carry the rules that kept being forgotten:

- **`refs` is required.** Null is how a row says it points at nothing — the goal rows say it, because
  the row _is_ the way to that goal — and a card that simply never got round to drawing a way
  somewhere no longer compiles into a row that looks finished. It is the cockpit's most repeated bug
  and every previous fix for it was a convention.
- **`facts` are labelled pairs**, not a concatenation: `for 41m`, `cost $2.14`, `branch feature/x`,
  `when 12m ago`, `times ×3`. `41m` alone is an age on one card and a remaining time on another, and
  the label is the whole of what says which. The count that used to share the cost's slot is a fact
  with a name now.
- **`why` is the row's one long sentence, and it is not on the glass**, and **`whyLabel` is the word
  it wears where the row's state has one.** A queue item's `reason`, a
  goal's `pickup.reasons`, a pull request's `attention.reasons` — held behind a `?` marker and given
  up on hover or focus. On the glass it made Up next the one card whose rows were three lines tall and
  whose shape every other card was an exception to; behind the marker it is one hover away, and the
  structured half of the same fact (the rule, and the word _held_) stays visible in its place. The
  marker holds **prose only** — never a ref, never a control: a reason naming `#412` draws it as
  plain text, and the way there is in the row's own refs slot, where every card keeps one. It is a
  `button`, so it answers to the keyboard; a reason only a pointer can reach is a reason half the
  operators do not have.

  **Where the sentence is a clause, it goes on the glass under the title** — `words="subline"` on
  `PanelRows`, which the rack takes and nothing else does yet. The marker's case is the queue's: a
  reason that is a _paragraph_ is the card's whole subject and cannot be on every row without making
  the card three lines tall. The rack's is the opposite, and taking the state word off it is what
  exposed the difference — what the marker left behind there was a bare `?` on every row, a mark that
  says only _there is something to know here_, which is the reading the word was removed for being
  worse than. The court's sentence is a clause. So the quantities and the sentence are drawn together
  as a **sub-line** under the title, in the faint ink a caption takes, wrapping rather than clipped
  since the half that says what is holding the row is usually its tail. A card takes the sub-line
  because its sentence is short, which is a fact about what the server writes rather than a preference
  about layout — the same kind of fact `layout` turns on. The row's own line gaps and padding tighten
  when it has one (`cn-subrow`): the two lines have to read as one row, and a gap the size of the gap
  between rows makes a card of eight rows look like a card of sixteen.

  **The bubble is positioned against the row, not against the marker**, and it stays that way past
  its own measure cap. Anchored to a 16px button it leaves the card on every row whose marker sits
  near an edge, and a tooltip clipped by its own panel is a reason nobody can read — so it is pinned
  to the row's two edges and capped at a readable measure between them. The cap is where that went
  wrong once: `left` and `right` together with a `max-width` is an over-constrained box, which CSS
  resolves by **dropping the `right` offset**, so on every card wider than the cap the bubble stopped
  spanning the row and hugged its left edge — 420px of explanation under the _title_, columns away
  from the marker it belongs to. `margin-inline: auto` is what a browser will not drop: the slack
  goes to the margins and the box stays between the two edges. Neither the sheet nor a narrow card
  shows the difference, so `test/console.test.ts` pins it.

  A bare `?` says only _there is something to know here_, so a column of them tells an operator
  scanning a card nothing until they hover every row. Where a card has a word for what is going on —
  the Fleet card does — the marker wears it and the sentence is the detail behind it. The word is
  drawn as the cockpit's own chip, in the tone the state deserves: `ask` red, `hold` amber, `quiet`
  neither. The column widens to `--cn-w-state` on a card that uses words.

  **The Fleet card's four states are ranked, not merged**, because they are read from four different
  facts and an agent can be in more than one: an open escalation naming the agent (`question`, and it
  outranks everything — it is your move), the limit park (`limit`), the stall park (`stalled`), and a
  plain `waiting` (`blocked`). A running agent wears none, which is the point of the column: on a fleet
  of five the two words in it are the two rows worth looking at. Behind the ended-shifts disclosure a
  row names how it ended where that is not `done` — `failed`, `crashed`, `killed`, `stopped`. The desk
  run wears `at a keyboard` here rather than a chip of its own, in its violet: the hollow lamp, the
  dashed edge and this word are one signal, and it is the same question the column answers on every
  other row. A [readying row](#work-that-is-not-an-agent-yet) wears its step there, in its own tint,
  for the same reason.

  **The Pull requests card wears no word at all**, and it is the one card that does not. The court
  stayed on the row — `attention.reasons`, behind the marker, in the server's own words — and
  `prAttentionStatus`'s arms came off the glass.

  A state column earns its 104px when its rows _disagree_. The rack's did not: four of five rows read
  `unwatched`, which the struck eye and the spent dimming had each already said, so the loudest ink on
  the row went to restating the one thing an operator could not miss — and four repetitions of a word
  that is nobody's move drowned `you`, the one arm that is. A column whose rows agree is a caption.
  What stays on the glass is the state each row already carries in a mark: **the eye** for the watch,
  **the checks mark** for a stall, **the `Assigned to review` band** for the ones somebody put on you.
  The chip is gone from the overview and stays on the goal page, where the row has no marker either.
  → `test/panelRows.test.ts`

  This is the general rule and the rack is only where it bit first: **a state a row already says in a
  control or a mark is not a state word.** The other cards keep theirs because theirs differ row to
  row — an agent's `question` against its `limit` against its `stalled` is the column doing its job.

  **The Goals in flight card's word is `pickup.status`, in the operator's words.** Same shape as the
  rack's, one card up: the verdict was a `pickup` fact with a bare `?` beside it holding
  `pickup.reasons`, which is one verdict said twice and a marker that said nothing until hovered. It
  now wears the state column and the reasons stay behind it. The words are translated, because the
  kind is an identifier the dispatcher passes between its own rules and every one of them reached the
  glass unedited — `has_pr` is the shape of that, and it asks the operator to know the enum before the
  row means anything: `in review`, `working`, `up next`, `no capacity`, `kept`, `a container`. A kind
  with no translation falls through as itself, so one added server-side degrades to the old reading
  rather than to a blank. `escalated` is the only `ask` — the one status parked on a person by design;
  `unwatched`, `blocked`, `cooldown` and `appraisal` are `hold`, the harness stopped and waiting on
  something. The tone is about whether the row wants anything, never about how far along it is.
  → `test/panelRows.test.ts`

  **The Up next band's word is `QueueStatus`** — `dispatching`, or the named reason it is not:
  `cooldown`, `capped`, `unapproved`, `superseded`, `waiting`. Third card with the same fix: the
  status was a fact and the sentence expanding it was a bare `?` one column over, so the slot with the
  width said nothing until hovered. `unapproved` is the only `ask` — a decomposition nobody has
  accepted waits on a person; the rest are the harness stopped, and `hold`. The reason itself is still
  quoted verbatim and still behind the marker: it is a paragraph on the held rows, and re-wording it
  would put the cockpit's opinion where the queue's own answer to "are we working on the right thing"
  belongs.

- **Every rail is a ceiling, and the subject has a floor.** The widths are `minmax(0, var(--cn-w-*))`
  and the subject is `minmax(var(--cn-w-title), 1fr)`. Fixed, the rails were sized against a
  full-width card and simply overran a half-width one — `1fr` takes what is _left_, so with nothing
  below it the title was the only track that could give: the queue's titles had 80px of 534 and
  clipped to a word, while World signals — same width, fewer slots — kept 277. The floor is what makes
  the ceilings bite. It does not make an over-subscribed card fit: a card carrying a state word, a
  control and a refs group at half width is short on room whatever gives way, and the honest fix for
  that one is the card's width or one slot fewer. **The queue needs the width**: its rows carry a state
  word, a profile picker and a refs group beside a title that is a sentence, which is a full-width
  row's worth of slots — and it has it, because the Fleet card it now rides is `cn-span2` too. World
  signals was full width for a different reason — not its own two slots, but that left narrow it was
  the one card off the grid, a quarter wide under a page of half-width ones. It is a panel now, which
  is the room its rows always wanted.

- **`toggle` is the row's switch, and it leads the readings.** Whether the harness takes an
  interest in this row at all — the rack's watch tag — is not the row's _work_, which is what `action`
  is for and why `action` has the width. It sits with the readings because it answers the same kind of
  question they do: the checks say whether the branch is sound, the review whether anybody has read
  it, and this whether the harness is looking at all. Ahead of the subject — where it was — it was the
  row's only control marooned between two marks that mean _state_, the agent lamp and the author, with
  the readings it belongs to a column away. That it **leads** the group is the readings' own ordering
  rule and not an exception to it: a switch is on every row of a card that has one, so it is the
  group's most reliable box and the anchor everything after it sits against. It is sized as one of
  them — the same 22px box `.rv` and `.pk` keep — so the run starts on a square edge. It is drawn as
  the **state it is in** rather than as the word for the other one: `watch` / `unwatch` was a verb that contradicted every row it appeared on
  (a row said `unwatch` precisely when it _was_ watched) until you worked out it was an instruction.
  An open eye is the harness looking; a struck one is not. The verb survives in the hover, where an
  instruction belongs.

  What a pull-request row states in `facts` are the _reasons it is not merged yet_ — a `merge`
  conflict, how long it has been `waiting` on a reviewer — each drawn only where it is true, so a row
  with none of them is visibly a pull request with nothing in its way. `branch` used to be among them
  and was the row's least useful fact: the title says what the work is and the refs say where it is.
  Unresolved `comments` was one too, and left for the opposite reason — it is not a quantity about the
  pull request the way an age is, it is a verdict on it, and it wears
  [its own mark](#the-comments-mark) beside the three it belongs with.

The card draws its rows as **one line each on a fixed rail**: lamp, switch, subject, why, reading,
chips, action, refs — or, where the card is over-subscribed, [cut in two](#the-strip) with the same
slots at the same widths. A slot is held open on every row of a card where _any_ row fills it — the census is
one function, `slotsUsed`, read once per card — which is what makes a slot a fixed **position** and not
merely an order. Packed as a flex line, the fleet card's verdict sat where the rack's control did and
every row shifted when the row above it grew a chip, which is why "always look here" had only ever been
true of the refs group. An empty cell in a column that exists says _this row has no verdict_; a
closed-up gap says nothing and moves everything after it. The census becomes a `grid-template-columns`
the card sets once, off the `--cn-w-*` widths stated once for every card.

### The strip

The rack is **over-subscribed**, and the row grammar's own paragraph above names the two honest fixes
for that — a wider card, or one slot fewer. It had already spent both: the card is `cn-span2`, and
each of the seven slots is a different question the card exists to answer. A pull-request row carries
the agent mark, the watch switch, who asked, a title that is a sentence, the court, three readings and
two references, and at a half page every one of them is right and the line is unreadable.

So the rack — and only the rack — takes the **stacked cut**: `layout="stacked"` on `PanelRows`, which
keeps what the row _is_ on the first line and drops how it _stands_ onto a strip under the subject.

**The cut is a ceiling, not a shape.** Over-subscription is a fact about the card's _width_, and the
card cannot see its own — `cn-span2` is a quarter of the page at 2000px and the whole of it at 1250,
and the rack is over-subscribed only in the first. Stacked at full width it cost 105px a row to leave
the identity line 640px of gutter and the strip 810px: a card that took 610px to draw five pull
requests, and read as five cards rather than one. So a stacked row carries **both rails** —
`--cn-cols-stacked` and `--cn-cols-line`, built by `unstackedTemplate` — and `console.css` picks
between them on a **container query** against `.cn-rows`. Past it the strip goes `display: contents`
and its children fall into the row's own grid, on a rail built in the order they are already written:
nothing is dropped, no mark changes column, the row simply stops wrapping.

**Beside the subject every rail is a width, not a ceiling** — which is what makes the card read as a
grid rather than as eight rows that each obey the same rule. Each row is its own grid element, so
`minmax(0, X)` resolves against _that row's_ content, and the subject's `1fr` takes back whatever the
row gives: a slot that gave any back moved **every column after it**, on that row alone. `facts` was
the one that varied — a pull request with nothing in its way sized that track to zero and drew its
switch, its checks and both its marks 62px right of the row above it, each of them individually
obeying a rail that was never the thing out of line. So the one-line rail is fixed widths throughout,
`--cn-w-facts` included, and the subject alone takes the slack. Under the subject the strip is the
row's last track, nothing sits after it, and the ceilings stay. The give a ceiling used to provide is
the query's job now: below it the row takes the stacked cut, which is the real answer to a card with
no room.

Two things this forces, both load-bearing. **Nothing on a stacked row is placed by an inline style** —
an inline `grid-template-columns` is the one declaration a container query cannot outrank, so the two
rails, the strip's own and the subject's column index all ride as custom properties and the sheet
applies them. And the query is a **container** query, never a media query: a media query measures the
window, which on this page is four different card widths at once. `test/rackStrip.test.ts` reads both
the rails off the markup and the query out of the sheet, because a stacked card that lost the ceiling
looks exactly like one that never had it.

It is not the table that lost. Nothing about the model changes, no card names a heading, and the slots,
their order and their widths are the same values `slotsUsed` and the `--cn-w-*` tokens already state —
the rail simply wraps. What a card chooses is not how its rows are _read_ but whether they fit on a
line, which is a measurable fact about the card rather than a preference, and `test/rackStrip.test.ts`
holds it to the one card that has it.

Three things are load-bearing:

- **The strip stops at the refs rule.** It is placed on the subject's column — `StackedRow` counts
  which column that is, since the three slots ahead of the subject are each drawn only where some row
  fills them — and never spans the whole rail. The card keeps one unbroken vertical edge between what
  a row _is_ and what it _names_; a strip running under the refs crosses it on every row, and the rule
  stops reading as a rule.
- **The strip is drawn before the refs in the markup and after them on the glass.** Both are placed by
  hand, so the eye reads title → readings → refs while a screen reader and the keyboard get the row's
  state before its destinations — which is the order somebody asking "what is going on with this"
  wants.
- **The readings run by how often they exist**, which is the one place the strip departs from the
  line's slot order: the `reading` slot leads, then the court, then the facts. A strip is a short run
  of boxes with a ragged end, and where the gaps fall is the whole of whether a card reads as a column
  or as a scatter. Inside the reading slot the rack applies the same rule — **the checks first**, since
  a provider reports checks on nearly every pull request, the fleet has read most and a pack exists for
  a handful.

  The run is **checks, review, comments, pack**, and the comments are where that rule gives way to a
  better one. The first three are the conversation about this diff **in the order it happens** — the
  machine read it, the fleet read it, then a person asked something — so a reader following the
  sequence finds the unanswered question where the sequence puts it, rather than after a mark about a
  document. The pack is not in that sequence at all, which is why it is the one that moves.

  That order costs the marks their fixed x unless two things follow it, and both do. The checks were
  the one variable-width thing in the slot while they were a chip of words (`passing` against
  `2 failing`), so they were given `--cn-w-ci` rather than left to their text; they are
  [a mark](#the-checks-mark) now and the token is that box's width, kept because `CiSlot` has to match
  it exactly. And the review and pack marks now `reserve` on **every**
  row of the card rather than only where some row fills the column: `reserve` asked whether the reading
  exists anywhere on this card, which made a rack of unread pull requests a different shape from a rack
  of read ones — each fine to look at alone, which is how that kind of drift survives. Where the row is
  _withholding_ the checks rather than lacking them — an agent is on the branch, so they describe a
  commit being replaced — `CiSlot` keeps the gap. It is deliberately not the mark's own class: it is a
  gap the width of a mark, not a mark with nothing in it, and the rule that a live agent's row draws no
  checks is read out of the markup by `test/panelRows.test.ts`.

**A new class name in this sheet is grepped for first.** `cn-strip` is the goal page's pipeline track
and drew the strip as a bordered filled panel; `cn-reads` is the top bar's readings group, whose
`margin-left: auto` slid it to the right-hand end of the title's column. Both are a thousand lines from
the rack, both matched silently, and neither is a thing `npm run check` can see — the sheet is valid
and the page renders, wrong. The strip is `cn-rowreads`.

**There was a second rendering, and it lost.** `columns` drew the card as a table whose headings were
the union of the `facts` labels its rows carried, with each card naming its own subject and refs
columns (`Agent is on`, `Dispatch`, `On`); a preview switch on `Place.panelGrammar` spanned the grid so
both were a link somebody could send while the choice was open. It was a fair second reading of one
model — but alignment inside a card is a weaker thing than alignment across the page, and a
seven-column card did not fit the overview's two-up width, so it scrolled sideways. The switch, the
place field, the table and the per-card heading names all went together; what stayed is the model,
which is what the exercise was for. Do not reintroduce a per-card layout choice: two ways to draw a
card is the drift `PanelRowModel` exists to end, one level up.

`test/panelRows.test.ts` holds the rail to one grid per card and pins the prose-only rule on the marker.

- **Goals in flight** carries the **furthest environment** holding a goal whole, where any is —
  last-declared in the operator's list, since that list is the order the work travels in. `partial`
  gets no chip: a row reading `liveUs` for half a feature is the boolean rollup the reach fold refuses
  to make, one layer up. → [24](24-environments.md#in-the-cockpit)
- **Goals in flight** also names the goals hanging off **no parent Feature** — `orphanGoal`'s verdict,
  the same predicate the goal page's band reads
  ([a goal with no parent Feature](#a-goal-with-no-parent-feature)). Three readings of one fact, each
  doing a job the others cannot: an alarmed **count beside the header's own**, which is what an
  operator can act on without opening anything; a **tinted row**, which is what makes it one of the two
  an eye stops at while scanning past six; and the **chip**, which is the word. The count is
  `orphanCount` over the very rows the card draws, so the header and its list cannot disagree — a
  header filtering differently from its own list looks right on both halves and is wrong only where it
  matters. Zero draws nothing: a muted `0 with no Feature` on every card teaches an operator to stop
  reading the header. **The chip is not a link.** The row's title already opens the goal, and a
  reference inside a row that is itself a control is two destinations for one click
  ([links](#links)); the way to fix it is the band on the page the row opens.
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
  folded into one.
  **A retained run is listed only while it still has work in flight** — an agent on it, an ask about
  it in the rail, or a plan part that is not finished (`retainedWorkInFlight`, folding the parts
  through the same `buildGoalTrack` the row draws its track from, so the gate and the row cannot
  disagree). The others — a finished run on a closed ticket, which every deployment accumulates
  forever — go behind the header's **`kept` disclosure**, the fleet card's `shifts ended` pattern: one
  click away rather than dropped, since dismissing one is still the operator's to do, and out of a card
  whose whole reading is what the fleet is working on now. The disclosure draws at zero, muted, so the
  way in never moves, and the header count stays the count of the list beneath it. Each row is a way into that goal's page, carries its segment track, and takes a
  **court read off `needsYou`** — a goal is in your court exactly when the rail is holding an ask
  about it. Anything else would let the row say "you" with nothing to answer. That is said **once**,
  as the alarmed `asking you` count: the `You` / `Harness` chip that used to sit beside it had no
  reading of its own beyond that count being non-zero. The row also takes the `live` treatment while an
  agent is on one of its parts — read off the parts' `agentLive`, not off the track, because the
  track's moving segment counts `in_review` too and an open pull request is not somebody's hands on
  the work.
  **A goal wears the live treatment while an agent is on it**, the same edge, tint and sweep the rack
  draws, and the same `AgentOnIt` chip in the same lamp slot. Its **track survives it**, unlike a pull
  request's checks: on a pull request the marker supersedes the checks mark, because those are a verdict on a
  commit being replaced, and a goal's track is how far the plan got, which an agent working does not
  make untrue.
  Resolved off the dispatch's **origin** (`agentOnGoal`, through `goalOfOrigin`), not off a branch and
  not off the parts: an agent's origin is a pull request as often as the goal itself, so a reading that
  only understood `issue:<n>` would say nothing is happening on every goal whose work has reached a
  pull request — most of the ones being worked, and indistinguishable from a quiet fleet.
  → `test/panelRows.test.ts`
  The track's four colours carry their key in the **hover**: a legend would cost more room than the
  bar, and four tones with nothing to read them against is a reading only somebody who has read the
  source can take.
- **Pull requests** — every open PR with its court behind the row's marker, its checks mark, and the
  watch eye at the head of them. The **row's name opens
  [its page](#the-pull-request-page)**, and the ref beside it carries **both destinations on one
  token** ([both doors](#a-reference-carries-both-its-doors)): the number opens the cockpit's page,
  the arm opens the provider's. The row raises two questions and each answers one — what the harness
  makes of it (the threads it owes an answer, the checks, the work on the branch) and what the diff
  says — but they are two doors onto one pull request, and drawn as two separate tokens they read as
  a repeat of the same number, which is what this card did until the arm existed.
  An **unwatched** PR stays in the list, with its health, and is drawn **spent** — the same dimming a
  closed PR and an unwatched goal take, off `attention.status === 'unwatched'` rather than a
  second reading of the labels. The chip alone left the one row nothing will happen on sitting at the
  same weight as the ones being worked, which is the whole thing the absent tag is meant to say.
  **The fade is deep** — a third, not the two thirds it began at. The rack is eight rows of one shape
  and most of them are unwatched, and the reading it exists to give is _which of these is the fleet
  actually working_: at a fraction that still reads as a legible row, a scan finds eight rows of
  slightly different grey instead of two rows and a background. The marks fade with the row, since a
  verdict about a pull request nobody is working is exactly what should not catch an eye. The
  **switch** is the one thing held at full strength, because it is how the row comes back for good.

  **And it is drawn out of focus**, which is the part opacity cannot do. A faint row is still a row an
  eye tries to read — the words are sharp, so it costs a fixation to find out they were not worth one,
  and eight of those is the scan the card exists to save. Blurred, the row stops offering itself as
  text and becomes texture: the card's shape, the column of marks and the row's position all survive,
  and only the reading is withheld until it is asked for. Sub-pixel (0.7px) on purpose — past about a
  pixel the marks turn to smudges and the row stops being locatable, which is the one thing it still
  has to be. Hover or focus takes both the blur and the fade off, so reading one is a gesture rather
  than a squint, and the keyboard gets the same escape the pointer does. Nothing a mark opens is caught
  in the filter: `.tip` is portalled to the body, which is what the portal was already there for —
  a filter is a containing block for fixed descendants, exactly as `opacity` is a stacking context.

  **A spent row draws no sub-line.** Both halves of it answer _why is this not moving_, and the struck
  eye has already given the only answer that matters: nobody asked it to. A row nothing will happen to
  spending a second line on what it is waiting for is the state word's mistake one line lower, drawn on
  the rows least worth reading. `prRow` withholds `why` and `facts` on that arm rather than the sheet
  hiding them, so the row is a one-line row in the markup as well as on the glass — and `cn-subrow` is
  applied per **row**, not per card, since a second line held open says nothing the way an empty cell
  in a column does: there is no column to read the absence against, only a row taller than its
  content.
  Most pull requests here are tagged by the harness itself ([07](07-pull-requests.md#watching)), so
  the button is normally an **un-watch**: the way to stop a runaway agent's pull request.
  **The ones assigned to you are a band, above the fleet's** — see [below](#yours-then-the-fleets).
  A PR is joined to its goal through **`goalOfPr`** — the server's own three-way match (a part's
  `prNumber`, the tracker's `linkedPrNumber`, the branch convention), read backwards — and the goal is
  drawn as a way onto its page, behind the word **`delivers`** — two bare refs state that the row names
  two things and nothing about how they are joined, and on this card the joining is the row's whole
  reason for existing. Through the parts alone the goal was drawn for almost no PR at all: a goal
  the funnel failed open on has no parts and its PR is on the flat `issue/<n>` branch. A PR no ticket owns
  resolves to nothing and draws nothing — the word goes with it — which is honest about what is known. The toggle is **disabled rather than absent** with no watch label configured: the gate
  being off is a fact about the deployment worth seeing, and a control that comes and goes with a
  config key reads as a bug in the page. The merged count is drawn only where the snapshot carries a
  closed list at all — absent means the retention window is off, which is not the claim "none merged".
  **At zero it is drawn quiet** (`cn-quiet`) rather than dropped, for that same distinction: the two
  claims stay apart, and a zero stops being the loudest thing in the card's top-right corner.

- **Up next** — the last pulse's ranked queue, each row carrying `QueueItem.reason` verbatim. Not a
  card of its own any more: it is [a band on the Fleet card](#the-queue-rides-the-fleet-card), whose
  rows the card shares a budget with, and the rest of it is the `upnext` panel. The reason is the
  direct answer to "are we working on the right thing" and nothing here re-words it; it is the row's
  `why`, so it sits behind the marker with the status as the word in front of it. The origin is drawn
  as a ref, so a goal-scoped one opens its page. A row whose goal is marked a priority draws a
  `priority` chip off `QueueItem.expedited`: the flag is set on a goal and the row names an origin, so
  without it a flagged goal's parts sit at the top of the queue with nothing anywhere connecting the
  order to the click that caused it.
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
- **Environments** — one row per environment that declares a `health` command: the word its own check
  answered, how long it has been that word, when it was last read, and the check's own reasons behind
  the row's marker. Here rather than on a goal page because health is a fact about the environment and
  not about any goal, and the question it answers — "is anything broken out there" — is asked with no
  goal selected. It is **the one card here that draws nothing when it is empty**, which is the
  deliberate exception to the rule below: an environment surface on a deployment that configured none
  is a row of question marks announcing a feature as broken. No new tones — `unknown` takes the same
  amber as an `orange` tier and is told apart by the word beside it, because a check that could not
  answer is a thing to look at and drawing it green or red would claim an answer it did not give.
  → [24](24-environments.md#is-the-environment-well)

### World signals

`worldEvents` grouped by `(kind, ref)` with a count, **plus the environment arrivals** of the last
week (`WorldSignals`, `web/src/console/WorldSignals.tsx`). Three review comments on one pull request
are one signal, not three unrelated rows; two environments reaching one goal are two things that
happened, so arrivals are one row each. The row draws **the goal behind the signal** beside the
sentence and never the pull request: the summary's own `#412` already links out, so repeating it
would be one ref twice, and what a signal never offers is the way onto a goal's page.

The arrivals are merged **here**, at render time, rather than carried in `worldEvents`. A world event
is derived by diffing consecutive snapshots, and a standing delivery verdict is expired by any world
event on its issue ref — so an arrival written as one would lift the delivery park on the goal it
announced and hand the work straight back to the fleet. → [24](24-environments.md#in-the-cockpit)

**A panel, and it has two ways in.** `ConsolePanel` gained `signals`, so the address bar carries it
as `?panel=signals`, the back button steps out of it, and Escape and the backdrop close it. It is
named in [the bar's menu](#the-bars-menu) alongside Faults and Record — the other things read rather
than watched — and it is reached from the **Up next band on the Fleet card**, which is the reading it
actually serves: what the harness would do next is decided off what the world just did, so _why is
that queued_ and _why is nothing_ are both answered here. The band's way in draws at every size of
queue, including an empty one, because an empty queue is exactly when an operator wants to know
whether the world moved at all.

**That control is a sentence — `Up next is determined by world signals →` — and it is the one control
on a band that carries no count.** It read `Signals 5 →` first, which put the feed beside the queue
and left the relation between them to be guessed; on the one band where that relation is the whole
reason the control exists, saying it is worth the width. The number comes off for the same reason: a
figure on the end of that sentence reads as _how much of the queue_, which is the one thing it does
not count. How big the feed is belongs on the menu row, where the value column means what it says.

**The panel is uncapped where the card drew ten.** The cap was a card borrowing a page's room; the
list is bounded anyway — the server caps `worldEvents` at 100 rows and arrivals age out after a week
(`SIGNAL_WINDOW_MS`). The menu row's count is `signalRows`, the same function the panel draws from,
so the row cannot report a number the panel it opens then contradicts.

### Yours, then the fleet's

The rack's question is _is anything waiting on me_, and it was answered one row at a time:
a pull request a colleague handed you wore `you` in a state column, which is a reading an operator
has to take down the whole card before they know the answer is no. Worse, it is the **same word** a
pending merge proposal and a conflict put on a row — so "yours" and "your court" were one red chip,
and the two are different obligations.

So the rack **orders and bands** instead. The pull requests somebody handed you are drawn first, under
an `Assigned to review` heading in the `ask` red the row grammar already speaks, and the rest under
`The fleet's`; each heading carries its own count, so how much is yours is read without counting rows.

**The heading names the obligation, not the possession.** It read `Yours` first, which is a claim of
ownership over pull requests the fleet wrote and the fleet will land — the one thing they are not —
and it was a second word for what the band beneath it already says by being called `The fleet's`. What
is true of every row in the band is that somebody put the operator on the reviewer list, so that is
what it says. The predicate is **`attention.assignedToYou`**, never `attention.status === 'you'`: that field is set on exactly the
arm where an assignment _is_ the court ([07](07-pull-requests.md#a-pull-request-a-person-put-on-you)),
and it is what the queue rail keys on — one field, so the two surfaces cannot come to disagree about
whose a pull request is.

Beside each row, in a slot of its own, is **who asked**: the person's initials on a filled disc, the
harness's rows a hollow dashed one. The name is the tracker's — `PullRequest.author`, as the provider
reported it — and `initials` reads the three shapes that field arrives in off one rule: a GitHub login
(`adamawan` → `AD`, two letters, because a column of rows that all start with `A` distinguishes
nobody), an Azure display name (`Priya Raman` → `PR`) and an Azure unique name, whose domain is
dropped. **Nothing invents a person.** A provider that reported no author draws the same hollow mark
the fleet's rows wear, because _we were not told who_ and _nobody asked_ are both honestly "no person
here". The mark's accessible label is the whole name, never the initials, which are two letters that
mean nothing said out loud.

**Both appear exactly when they have something to say.** With nothing assigned, there is no band and
no column of marks: one heading over every row separates nothing, and a column of identical hollow
diamonds is furniture announcing there is no news. The card takes back precisely the shape it had.
`RowGroup` is a general field on the row model rather than a rack-only rule — a heading is drawn where
`group.key` changes, so a card that interleaves two bands draws the heading twice, which is the honest
rendering of rows ordered against their bands rather than a silent regrouping.
→ `test/prRackGroups.test.ts`

### Rate, removed

There was a sixth card here — **Rate**, the fleet's dispatches, merges and escalations per hour over a
fixed six hours, with dispatches-per-merge under them as a churn ratio. It is gone, and so is the
derivation behind it: the production module under the cockpit's view layer is deleted rather than left
unimported, since knip runs every rule at `error` and an export nothing names fails `check`.

It was the surviving half of the Output panel, kept on the overview on the argument that rates are a
_now_ question and the money behind them an analytical one. What that argument did not survive is how
little the card said on a real deployment: three figures a fleet's own pace makes unreadable at this
resolution — most six-hour stretches have one merge in them or none — under which every series
routinely drew _nothing in the first half to compare against_, which is a card whose whole content is
an admission it cannot answer yet. The reading it was pointing at is on [Insights](#insights), over a
window the operator chooses, and the nav carries the way there.

### Work that is not an agent yet

The harness spends minutes turning a planned dispatch into a running agent, and the Fleet card draws
that window as a row of its own: one per action `ActionExecutor.execute` currently has in hand,
straight off the readying board it publishes
([09](09-execution.md#what-is-being-readied)) as `state.readying`.

Without it the card was wrong in the one way an operator acts on. A cycle planning three appraisals
with full headroom starts them minutes apart, because the executor's loop is serial and each dispatch
waits on the worktree pool; in between, the Up next queue said all three had been dispatched and this
card showed one agent. The reading an operator took from that — _three to do, one picked up_ — was the
only one available.

**It is drawn as not-an-agent, in [the keyboard entry](#the-keyboard-entry)'s grammar**, because it is
making the same distinction: a **`div`, not a button** (there is no transcript to open, nothing to kill
and nothing to inject into — there is no process yet), a **hollow lamp**, a **dashed left edge**, and
**no cost column**, where a `$0.00` would read as a cheap agent rather than as no agent. What differs
is the tint: `--cn-readying`, a mix of the console accent and the faint ink, rather than the desk run's
violet. The two rows differ in exactly what an operator is reading them for — a desk run is somebody at
their own keyboard and will never take a fleet slot, while this is the harness itself, on its way to
taking one — and one colour for both would have merged them.

The state column carries the step (`handing a slot over`, `reading CI output`, `authorizing`,
`picked up`) in the same slot every other row wears its state, in the tint. The words are
[09](09-execution.md#handing-a-slot-over)'s own; the hover behind them says what that step waits on and
the two things a glance cannot — that it holds no slot the cap counts _yet_, and that it leaves the
list on its own, when the agent starts or when the dispatch fails.

**It takes no slot and is not counted as one.** `view.live` excludes it, exactly as it excludes a desk
run, so the header's `N out` and the cap readout are untouched; the count is stated beside them as
`· 2 being readied`. Folding it in would make the number move twice for one dispatch — once when the
executor picked the action up and again when the agent appeared.

Its place in the list is the sentence the card reads as: the agents that are out, then what is being
sent, then what nobody sent at all — and then, under a band of its own,
[what has not been sent yet](#the-queue-rides-the-fleet-card).

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

### The queue rides the Fleet card

**Up next is not a card. It is a band on the Fleet card**, because it is the same list one stage
further back. That card is already ordered by _dispatch stage_ — the agents that are out, then what
the executor is [readying](#work-that-is-not-an-agent-yet), then the
[desk run nobody dispatched](#the-keyboard-entry) — and a queued candidate is one step behind the
readying row: ranked by the last pulse, not yet handed to `ActionExecutor`.

As a card it was **fourth in reading order**, three cards below the one an operator opens the
overview to read. So "who is out, and what is behind them" was a reading every operator assembled
themselves, out of two surfaces that never agreed on what counted as work — the same argument that
put the runway band on this card's foot rather than in a card of its own, one stage further out.

Folding it in costs no new mechanism. Both cards were already `cn-span2`, so no rail narrows; both
already build `PanelRowModel`s, so the slots, their order and their widths are the ones
[the row grammar](#the-row-grammar) states; and the heading is `RowGroup`, the same value the rack
uses for [Yours and the fleet's](#yours-then-the-fleets).

#### The card has a row budget, not two lists

`FLEET_ROWS` is **7**, across both bands. The agents spend it first — they are the card's subject,
and the cap already bounds how many there can be — and the queue takes what is left. A card gains a
queued row exactly when an agent finishes, and loses one when a dispatch goes out.

A budget rather than a cap each, because the two lists answer one question between them: what the
fleet is doing, and what it would do next. Two caps would make the card two lists that happen to sit
together, and it would grow and shrink again on every pulse — which is the thing
[one height per card](#every-card-is-one-height-and-scrolls-inside-it) exists to stop, arrived at
from the other direction.

At a full fleet the queue draws no rows at all and keeps its band, its count and its way to the
panel. That is the honest reading: nothing is queued _next_ when nothing is free.

**The band is pinned to the card's foot** (`RowGroup.foot`), because its size is what the rows above
it left over. Floated up against them, a quiet fleet drew the queue halfway up the card with a field
of empty panel underneath. The runway band gives up its own `margin-top: auto` for this: on a card of
a fixed height the slack belongs to one item, and two auto margins split it — which would open a gap
between the queue's rows and the summary of that same queue.

Ended shifts are not counted against the budget. They are history, and an explicit expansion the
operator asked for, so they scroll the card rather than pushing the queue out of it.

#### The queue is joined against the fleet before it is drawn

`state.upcoming` is the **last pulse's** projection, and the pulse that dispatches a candidate writes
it into that list as `dispatching` in the same breath — see
[the rule book](05-dispatcher.md#the-rule-book). The dispatcher's own de-duplication is
`activeOrigins`, derived from active tasks, and the task an action creates does not exist yet at the
moment of the push. So for the length of one interval the queue claims work that is already out, and
the card drew the same issue twice: once as an agent, once as up next.

`CockpitView.upNext` is that list with the staffed rows taken out — every origin a live agent's task
names, and every origin a [readying](#work-that-is-not-an-agent-yet) action names. Both surfaces that
draw the queue read it, so the band and the `upnext` panel cannot disagree about the queue's size,
and the row budget above is spent against the honest length.

**Live only.** An ended agent staffs nothing: an origin the fleet finished with and the harness
queued again is a genuine queue row, and a filter that read history would hide it forever.

The join is here rather than in the dispatcher because it is a reading, not a decision — the
`dispatching` row is load-bearing for `Harness.busy` and for the priority-override reconcile set, and
a queue that stopped reporting its own dispatches would take both with it.

#### Three shapes that did not work

Each of these read correctly in the diff, and each failed on the glass:

- **A disclosure in the card's header**, beside the ended shifts. The count sat three slots from the
  rows it governed, which is a message about a list rather than the list's own heading — and what it
  governed was invisible until pressed, so the card said nothing about the queue at a glance.
- **The band's heading as the disclosure, at the foot, opening upward.** The bar stayed put and the
  rows came up out of it, which sounds right and reads backwards: every other heading in the cockpit
  names what _follows_ it. Worse, it put the runway band — a filled, tinted strip — between the
  agents and the queue, cutting the card into two row blocks with a summary wedged in the middle.
- **The same bar as a heading, still at the foot, rows below it.** Better, and still two muted
  full-width strips stacked at the bottom of the card, which is the shape an eye learns to skip.

What is left is a band in the list where a band belongs, no fold at all, and the rest of the queue
behind a control.

#### What the band says, and where the rest of it is

**It always draws, and it states the whole count beside its rows** — `14 queued`, and where any of
them is the operator's own move, `· 2 on you` in the amber the state column already speaks. The
predicate is `status === 'unapproved'`, the one `QueueStatus` that waits on a person rather than on
the harness; every other hold is the harness stopped, which is what the rest of the card is about.
Without it the head of the queue would pass for all of it, and the row that wants an answer is as
likely to be below the cut as above it.

**The rest is a panel, not a disclosure.** `ConsolePanel` gained `upnext`, so `All 14 →` on the
band's right opens the whole queue on the console's own overlay. That means the address bar carries
it as `?panel=upnext`, the back button steps out of it, and Escape and the backdrop close it — none
of which a fold gets. Both surfaces build their rows through the same `queueRow`, so three on the
card and thirty in the panel cannot come to say different things about one candidate.
→ [the address bar](#the-address-bar)

**A queued row is drawn as further back than a readying row, not as an agent.** It takes the
`--cn-readying` tint — this is the harness's own work, and the violet is reserved for a person at
their keyboard — but its lamp and left edge are **dotted** where the readying row's are dashed. No
fourth colour: a new tint would claim a fourth kind of thing where there are three, and the band
heading above the rows is what names them. What the row does _not_ borrow is that tint on its state
word: `unapproved` is a real ask and `capped` a real hold, so the chip keeps the tone the verdict
earns. That is the one place a queued row departs from the two rows above it, and it departs
deliberately — a readying row's step is a progress report, and a queued row's status is a verdict.

**The card draws in two `PanelRows` calls and one rail runs through both.** `slotsUsed` is the union
of the rows it is handed, so a card measured per call re-cuts its columns whenever a band's contents
change — one dispatch, and the titles of the agents above would move. `PanelRows` takes a `rail` for
that: the rows the census is measured from, where they are not the rows being drawn. The card hands
both calls its whole set. → `Fleet`, `test/panelRows.test.ts`

### Every card is one height, and scrolls inside it

`.cn-grid` sets `grid-auto-rows: var(--cn-card-h)`, and a card fills its track rather than sizing to
what it holds.

Two failures, and the second is the one nobody would predict. A card sized by its content made the
overview **a different page on every pulse**: it grew as the fleet picked work up and shrank as it
put it down, and everything below it moved, so what an operator was reading was somewhere else by the
time they looked back. And grid's own stretch made a card's height its **neighbour's** content, which
is worse than either — a quiet card beside a busy one grew a field of empty panel under its last row,
so "this card has little to say" and "this card is padded out" drew the same.

One height for the track settles both. How much a card has to say is answered by its scrollbar, which
is a reading that moves nothing else on the page. The scrollbars themselves need no work: they are
[furniture on `:root`](#scrollbars) and every new pane takes them.

**The card is the scroller, and its head and foot are stuck to it** — `position: sticky` on the `h3`
and on the runway band. The alternative is a scroll region inside the card, which is a wrapper
element in seven components and a rule none of them can be made to keep, where this is one rule the
eighth card cannot forget. What it costs is that the header needs a ground of its own, since rows now
pass under it. Both rules are scoped `.cn-grid > .cn-card`: the goal page's cards have no track and
no height to fill.

`--cn-card-h` is declared on `.cn-grid` rather than `:root` for the reason the rail's widths are on
`.cn-rows` — every token on `:root` is a [theme token](#tokens), owed a value by each preset and a
row in the registry, and this is a layout metric rather than a colour anybody would want to change.
On the grid it also scopes itself: a `.cn-card` anywhere else resolves it to nothing, the declaration
is dropped, and the height is the overview's alone.

#### The reason bubble flips rather than clips

A card that clips is a card that would have cut off [the row's own sentence](#the-row-grammar) — the
`why` bubble hangs _below_ its row, so every marker within a bubble's height of a card's bottom edge
lost the one reading the marker exists to give.

So the bubble opens upward where there is no room below it. `Why` measures the marker against the
nearest scrolling ancestor on hover or focus and adds `cn-why-above`, which changes `top` and
`bottom` and nothing else: the two edges, the measure cap and the `margin-inline: auto` that keeps it
between them are the row's whichever way it opens.

**It cannot be CSS**, which is the whole reason there is script here at all. Whether a row has room
below it is not a fact about the row but about where it is sitting in its card's scroll at the moment
you point at it, so `:nth-last-child` and its relatives answer a different question. The room needed
is an estimate — the bubble is `display: none` until it is wanted, so there is no height to measure
before deciding where to put it — and it is sized against the long end of what it holds, so the
answer errs towards flipping. That fails to a bubble with room to spare rather than to one cut off at
the card's edge.

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
happens _on_. And the bar is reachable from everywhere: a selected goal outranks every tab, so the
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

A goal's own subtree of the graph, drawn as a card on its page (`WorkRecord`), in the
at the foot of the page and [folded away](#folding-what-is-not-relevant-yet). The roots of the work graph _are_
`issue:<n>` nodes, so a goal page was already sitting on top of its own record without drawing it —
the card is `GET /api/work/:ref` and nothing else.

**It fills a hole the page already had.** Every other card there reads the snapshot, and
`closedPullRequests` remembers a merge for `closedPrWindowMs` and then drops it — so a goal that
shipped three pull requests a month ago draws "No pull request names this goal yet", on a page about
work that demonstrably happened. It also carries what nothing else on the page keeps: the `inferred`
chip on a merge the harness never watched, concerns raised and cleared, and the requeues, sitting
under the part they redid.

Four things it does deliberately:

- **Its disclosure is its own**, not the footer's — the heading carries the node count, and only this
  card knows it. Folded away it fetches nothing at all, which is what keeps "on open, never polled"
  true now that the card no longer opens with the page.
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
**asked** to do, and what you are asking it to do next. It has two views — a table and a
board of state columns — and the table is the default because it is what the tab has always been: the
tracker id, the ticket, the readings, the cost and the date, each row taking the list's tracks by
subgrid so the columns line up however long one title runs.

**Two facts about state writes ride on the snapshot**, because neither is the cockpit's to infer.
`canSetWorkItemState` is asked of the connector — `setWorkItemState` _throws_ where no integration
implements it, so a surface that wants to **offer** the operation rather than attempt it has no other
way to find out, and inferring it from the provider name would be a second opinion about a capability.
`stateRules` carries the state words the three work-item rules act on, with `pickup` as the
**effective** set: `effectivePickupStates` folds `issueInProgressState` in, so a reader built from the
raw key would report that the state work is _in_ is one the harness will not work. It is null where
`issuePickupStates` is unset, because all three rules are switched out entirely then — the same fact
the dispatcher acts on, rather than an object of nulls inviting a reader to imply otherwise.

**Why one surface and not two.** The backlog was open items grouped by watch bucket; this tab was the
same items plus the closed ones, filtered by the same bucket. Two surfaces that can be told different
things about one item is the drift `src/watchLabels.ts` exists to prevent, one level up — so the
backlog is deleted and every part of it is named a destination here rather than assumed to survive.

| The backlog had                                | It is now                                                   |
| ---------------------------------------------- | ----------------------------------------------------------- |
| four groups (watched/intake/unwatched/ignored) | the **Watch** filter's values, now two                      |
| intake pulled out of Watched                   | a **lamp** on the held row, and its ask on the queue rail   |
| `Override → workable` on intake rows           | the same button, the same call, in the rail's `intake` band |
| features as headings, folds on `Place`         | `group=feature`, the same `collapsed` field                 |
| the name opening the goal page                 | unchanged — `selectGoal`, refs beside it                    |
| 25 rows then "…and 31 more"                    | the keyset cursor and infinite scroll this tab already had  |
| the nav's unwatched count                      | the same number on the Tickets badge (`untriagedCount`)     |

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
appraisal, the current labels — is read off the **state snapshot the cockpit already has**, and that split
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
always returns nothing. A `▲` marks the states the harness picks up from, read from config rather
than inferred: _why is Ready worked and New not_ is the most-asked question about an Azure deployment,
answered where the states are.

**The mark is the _effective_ pickup set, not `issuePickupStates` itself.**
`effectivePickupStates` (`src/dispatcher/issuePickup.ts`) folds `issueInProgressState` in, and
[02](02-configuration.md#item-selection-labels-priority-states) tells the operator not to list that
state — an item the harness left there stays pickup-eligible either way. So a mark built from the raw
key is missing on exactly the state work is _in_, and the chip then answers the question it exists to
answer with the wrong half. The route therefore passes the dispatcher's own function through to the
facets: a lens quoting a decision made elsewhere, which is the direction that is allowed.

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

### The board, and what a card says

The second view: one column per tracker state, drawn from `issueBoardStates`
([02](02-configuration.md#board-columns)) and falling back to the state facets' own order where that is
empty. `boardColumns` (`web/src/ticketBoard.ts`) owns the three cases — a configured order taken
exactly as written, a listed state with nothing in it still drawing its column, and a state the mirror
carries that the list omits reported under the board rather than dropped. The last is the one that
matters: those items are on no board at all, and unreported that is indistinguishable from a quiet
tracker.

The toggle is **disabled**, not hidden, where the tracker reports no native states — there are no
columns to draw, and a control that vanishes on some deployments is one nobody can ask about.

**A column is a `/api/tickets` request pinned to its own state**, with its own cursor and its own
`IntersectionObserver` rooted on its own scroll box. There is no board route and no new payload: the
list route already filters `state` as an exact match on `work_item_state`, which is a column's
definition. Bucketing one shared page client-side was the alternative, and it makes a column's
contents depend on how far somebody scrolled a list that is not on screen. The board scrolls sideways
and each column scrolls inside itself, so a column running off the right edge hides nothing in the
others and one running long pushes nothing off the bottom. A column's header count is its own
response's `total` once the first page lands, and the whole-mirror facet before that, so both numbers
in "12 of 218" are about one set. Its foot distinguishes three emptinesses, because they are three
facts: nothing has ever been in this state, nothing under it is still in the open set (with the widen),
and nothing here matches these filters.

**The board takes the whole situation area; nothing else on the tab does.** The `1400px` cap is about
reading _across_ — a row's id and its date are two ends of one fact, and let out to the width of a
monitor the eye loses the line between them. That is true of the head, the filter rail and the table
alike. A board column is read _down_ and is its own list, so the cap buys it nothing and costs it
columns: on a wide monitor it drew a sideways scroll with a page of empty margin beside it (#632). The
scroll stays, because a tracker with twenty states outruns any monitor, but it now begins where the
screen ends. The board runs past the rail that filters it, which reads as the board using the room
rather than as an edge that failed to line up.

**The cap is `.tickets > *` with `.tickets > .tb` as the one exception, and the difference from a cap
on the tab is the whole point.** On the tab it bounded whichever body was up _and_ the chrome above it,
so lifting it for the board moved the head, the filter rail and the view toggle _itself_ — the control
changing width under the pointer that pressed it, which reads as the page lurching rather than as a
view opening. Per child, every block keeps its width in both views and only the board differs. The
toggle does still shift on the click, by the width of `Group` giving way to `Order` — that is the rail
differing in card view, three paragraphs down, and it predates any of this.

**A card's reason lane is always drawn, and it is the board's whole advantage over the table.** A
column of cards answers _why is nothing on this_ without a click on any of them. `cardReason` decides
which of five readings supplies it — an intake hold, then the outcome word, then the dispatcher's own
first sentence, then frozen, then unwatched — and it is pure for `cascadeNote`'s reason: the invariant
is about which reading wins, which no render can show. An **unwatched** item is never held, whatever a
stale verdict says, exactly as in the list. A blank lane would read as a card that failed to draw,
which is why the absence of any reading is itself a sentence.

**The watch dot is the control.** The list's Watch/Unwatch pair does not fit a card and the lane has
the space it would take, so the dot both reports the tag and writes it, carrying `cascadeNote`'s phrase
in its title — a click that writes eight tags says eight. It is refused in the three cases the list
refuses it, each with its reason in the title. It is a button and the drag handle is the card body, so
a drag beginning on the dot moves nothing.

**In card view the rail differs in three ways.** `Group` hides, because a flat board has no headings to
indent under, and the ordering takes its place — the list sorts from its column headers, which is where
a reader of a table looks, and a board has none. The State tier becomes **column visibility**: the same
chips and counts, `aria-pressed` now meaning "drawn", the hidden ones in `Place.ticketColumns`. And
`state` stops meaning anything once every state is a column, so switching to cards **clears it and says
so** — the `widenedFor` band pointed the other way, with the way back restoring both the view and the
narrowing. A control silently ignored is worse than one that moved and told you.

### Dragging a card between columns

A drop writes the tracker's state through `POST /api/issues/:number/state`
([16](16-http-api.md#post-apiissuesnumberstate)) — the only place the cockpit writes one.

**Every column is a drop target, and every header says what dropping there costs.** The alternative
considered was refusing the columns the rules own, and it was rejected: it forbids the genuinely useful
move of parking something in review by hand, and a dead drop target is the hardest thing on a board to
explain. So the operator decides, and the board tells them first — the whole board at once, the moment
a card is lifted, rather than one column at a time as the pointer finds it.

`dropWarning` composes the sentence from independent clauses rather than picking a case, because a
column can be outside the pickup gate _and_ the one a rule writes _and_ hold nothing live, and any
enumeration would report whichever of the three the reader did not need. Three of its wordings are
counter-intuitive and each is checked against the rule rather than against the config key:

- **The in-progress state reads as a pickup state.** `effectivePickupStates` folds it in, so a warning
  built from the raw `issuePickupStates` would say the fleet stops on exactly the column work is _in_.
- **The review state names the condition on its bounce and never promises one.**
  `work-item-back-to-pickup` fires only on an explicit `more_work` verdict — never on a missing PR,
  which was changed deliberately after a merged PR bounced its ticket back to "Ready" and put a fresh
  agent on merged work.
- **A column with nothing live claims nothing about closing.** Whether a state maps to closed is the
  tracker's workflow, which the harness has no reading of, so the clause states only what the State
  tier already states.

With no `issuePickupStates` at all there is no state gate and all three rules are switched out, so the
board says the drop changes the tracker and nothing else. Warning about a mechanism that is not running
would be worse than silence.

**The card moves on release and says it is still writing**, because the write is a round trip — a
provider call, both patches, a broadcast and a pulse before the route answers — and a card that sits
still that long reads as a drop that missed.

**A landed write re-reads every column, and the placement is released once they have.** Both halves are
load-bearing, and getting either wrong is a board that lies about where work is:

- Without the re-read the placement is the _only_ thing holding a card in its new column, and a
  placement is one slot. A second drop replaces it, the first card falls back to its column's
  never-refreshed page — where it started — and one drag appears to move two cards. The mirror is
  already patched by the route, so re-reading is what makes the move real rather than drawn.
- Without the release the placement outlives its usefulness and starts overriding the rail: it drew a
  card in a column the operator had just filtered it out of. So it is retired on a condition rather
  than a delay — when every drawn column has completed a read — because any timeout long enough to
  cover a provider write plus a pulse is long enough to see.

**A drag is disarmed when it ends, however it ends.** A drag released outside every column fires
`dragend` and no `drop`, so without handling it the board stays armed: the headers go on speaking, and
the next stray drop writes the state of a card nobody is holding. That was a real unintended write, not
a cosmetic one.

A refusal puts the card back **and quotes the provider on it**. A snap-back with no sentence attached
reads as the board being broken rather than as the tracker refusing a transition, which is why the drop
handles its own rejection instead of routing the click through `AsyncButton` — that component folds a
refusal into a tooltip, which is right for a button and wrong for a card that has just moved.

**Where the provider cannot write states at all, nothing is draggable and the board says so once**,
above the columns, off the `canSetWorkItemState` flag the snapshot ships. Letting each drop fail
separately would teach the same thing five times and explain it none.

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
through `stateColour` (`web/src/stateColour.ts`). The goal page's header chip reads the same map, and so
does the **name of a board column**, so a state is one colour wherever it is drawn. On the board it
letters the word itself rather than striping the header: a rule along the top edge reads as decoration,
and the whole point of the setting is that the state is something you read.

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

### Intake is raised on the rail, and marked in the list

An `unclear` appraisal is the one intake reading that **stops dispatch** ([06](06-issue-pickup.md)), and it
is raised where every other ask waiting on a person is raised: [the queue rail](#the-queue-rail--needs-you),
as an `intake` row. What is left here is the reading — a **lamp** on the held row, so a page of tickets
still says which of them nothing is moving on.

It was a call-out above this list, and that was the whole of it. The argument for pulling it out of the
rows still holds — among a page of rows a hold reads as a detail rather than as the thing stopping the
work — but the surface was wrong: this tab is where an operator grooms the backlog, and the rail is where
they find out what is waiting on them. A held goal was invisible to anybody who did not open this tab,
which is the same fault the profile gate was moved onto the rail to fix, and it is the same fix.

An **unwatched** item is never intake, whatever a stale verdict says: "leave this alone" is the
operator's own instruction and outranks a reading about a goal nobody is going to work. The rail's
derivation asks the same question of the same tag, so the lamp here and the row there cannot disagree.

### Unrecorded work

What the harness did that nothing in the tracker accounts for, with `File a work item` and `Ignore`
beside each row — since nobody outside can ever mark done what nothing records. `UnrecordedWork`, drawn
as a call-out above the list.

**It is here because it is triage.** Filing or ignoring is a verdict cast on a row, which is what this
whole tab is for; it sat at the head of the work tab while that existed, and by the end it was the only
part of that tab an operator ever acted on. It is now the tab's only call-out — it shared the head of the
list with intake until the intake hold moved to the rail.

It reads `/api/work` on mount, **fetched on open and never polled** — the same route and the same
reasoning as [the record panel](#the-record-panel), and the rows change on a pulse at most. Both
surfaces reading one route is also what keeps them from disagreeing about what is outstanding.

It draws **nothing at all** when there is nothing outstanding. That is the opposite of the
rule the overview's cards obey, and deliberately: those are gauges an operator glances at the same spot
for, where a card that vanishes when quiet is indistinguishable from one that broke — this is a call-out
above somebody else's list, and a permanent "nothing to record" heading over the tickets table is a row
of chrome saying so on every visit. Ignored rows stay behind a disclosure at the tail, since an ignore
that could only be set would make an accidental click permanent.

That list is only worth a reader's attention while it is **short and true**, and for a time it was
neither: a job requeued after a crash, and a job queued for a claim, both named the tracker item
they stood in for and neither was adopted by it, so the panel filled with rows reading
`Requeued: Plan issue #35699` — a tracker link on the face of the row and a filing button beside it.
The predicate did not change; the fold's [third adoption arm](16-http-api.md#get-apiwork) did, and the
rows cleared themselves on the next pulse. Worth stating because it is the failure mode a surface like
this one has: a list of things that are owed is read exactly as long as everything on it is owed.
→ [16](16-http-api.md#get-apiwork)

### One control, and no more

This tab used to state that nothing in it changed the world. That was true of a record and is false of
a work surface, and the sentence changed with the code rather than after it. What it says now is
narrower and holds: **the watch switch, and nothing else.** It was two until the intake override went
with its ask to the rail; a row is otherwise a reading, the lamp included.

- It writes through a call that already existed — `POST /api/issues/:number/watch` — so the merged
  surface introduces no new way to change the world.
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

The strip carries the ident, the nav, the fleet gauge, the two ways off it to a tracker, the [**Env**](#the-environments-gauge)
chip where there is an outage to report, **two
gauges** — [Usage](#the-usage-chip) and **Local**, in one pill — and a **menu** holding the seven
ways-in that are not gauges: **Faults**, **Launch**, [**Build**](#the-build-gauge),
[**Env**](#the-environments-gauge), [**Signals**](#world-signals), [**Record**](#the-record-panel)
and **Config**. Findings and
Lessons were readings here too until the claim stores merged, and the merged store has since gone with
the count that stood for all of it. Each is one subject stated once. None reaches `api.js`: every one
is a method on `CockpitActions`, and the fleet cap is the shared `FleetControl`, which is already on
that seam.

**The cut between the strip and the menu is what a reading is _for_, not what it costs to draw.** Usage
and Local are numbers that move on their own and are glanced at on every pulse. The seven behind the
button are counts that are usually zero (Faults, Launch), a state that is `current` nearly all its life
(Build, Env) and three surfaces that are aimed at rather than read (Signals, Record, Config) — and spread across
the strip they were what wrapped the bar to two rows at laptop widths. Folded, each keeps its count and
its sentence; what the fold could have cost — noticing a fault or a waiting upgrade without opening
anything — is bought back by the **dot on the button**, which appears whenever a row inside has a tint.

**The fleet gauge holds the pulse countdown, beside the pause control** (`.cn-cap`, `.cn-countdown`).
The two are one subject: Pause is the control that stops the next dispatch decision from happening, and
the countdown is the clock running down to it — so as two chips separated along the bar they only meant
anything together, and a reader asking _is anything about to happen_ had to read both to learn either.
Inside one reading they are one gauge, left to right: what the fleet is allowed to do, and when it next
gets to.

**Beside it, and not under it.** Stacking the countdown below the pause button was tried first and reads
worse whatever the pixels say: the strip is a single row of chips at one height, and a two-row gauge in
it is a gauge that has grown a row. Inline it costs the bar nothing and stays on the baseline the
readings share. It is selected as `.cn-cap .cn-countdown` rather than by its bare class, and that is
load-bearing: `.cn button` resets `font` to `inherit` at (0,1,1), so a single-class rule loses the
shorthand and the line renders at the bar's 13px/1.45 — taller than the row it sits in, which grows the
whole bar with nothing red to say so.

**The countdown carries no label.** It read `Scan 14s`, and "Scan" named the mechanism rather than the
question — `14s`, `paused` and `held` each say what they are, in the one spot on the bar where the only
thing that could be counting down is the next scan. The word cost a third of the chip to restate the row
it was in. The sentence it carried is the `title`, which is where the two states that are _not_ a
countdown explain themselves. Its `line-height` is stated with its size rather than left to the shorthand
because `.cn button` resets `font` to `inherit` at (0,1,1) and would otherwise hand it the bar's 1.45.

### The bar's menu

One button (`BarMenu`, `TopBar.tsx`; `.cn-menu-wrap`, `.cn-menu`, `.cn-menu-row`) and the seven
ways-in behind it, in reading order: Faults, Launch, Build, Env, Signals, Record, Config. Every row
is a glyph, a word and — where it has one — a value, drawn at the right-hand edge so seven rows of
different word lengths still read as one column of numbers.

**Env is in here _and_ on the strip**, which is the one reading that is both, and the two are not the
same question: the chip is _is something broken_ and is drawn only when it is, and the row is _what did
every environment say_, which is where an operator goes to confirm that nothing is. Both open the one
panel. → [the Environments gauge](#the-environments-gauge)

**Every row names itself in words, and that is the difference between here and a rack.** A glyph in a
fixed slot on a row somebody is already reading can go wordless — the agent mark is the icon
set's one exception — but a row in a list an operator
has just opened cannot, because nothing around it says what it is. The glyphs come from the shared set
(`Icon`, `web/src/components/icons.tsx`) rather than being drawn inline here: the console has one icon
set now, and a second one for six rows would be a second colour system for six glyphs.

**A row's tint is on its value and its glyph, never on the row.** Faults above zero is red, a Build at
`behind` or `ready` is amber, Env wears the tone `environmentsReading` gives it. A filled red or amber
box among six list rows reads as a banner rather than as a reading, which is the opposite of what a
tone is for.

**A row can also be _pending_, which is a fact and not a quantity** (`MenuEntry.pending`) — an unsaved
theme edit on Config, and so far only that. It draws a dot beside the word rather than a value, and it
lights the menu's own button along with the tones: a mark visible only once the menu is open is the same
invisibility the mark was added to fix. → [the theme](#the-theme)

**A zero mutes a row; it never removes one.** The strip's own rule, carried into the fold — a row that
vanished on the days it had nothing to say would be one an operator had to hunt for.

**It closes on Escape and on focus leaving the group** — the pair a keyboard and a pointer each need.
Not a document-level listener: that is a third thing to unsubscribe on a component the shell mounts and
unmounts with the connection.

**`menuEntries` is exported for `test/console.test.ts`**, as `usageReading` and `environmentsReading`
are, and for a reason the fold shares with neither: the rows are behind a button, so a rendered bar says
nothing about whether the list that fills them is right. Every assertion that used to read Faults,
Launch, Env or Record off the bar's own markup reads the fold now.

**Signals is here rather than a tab for the reason it is not a card**: it is consulted, not worked
on. Its value is the whole feed, so the row says whether there is anything in there before it is
opened, and it mutes at zero like every other. → [World signals](#world-signals)

**Record and Config are in here rather than in the nav, and it is one rule keeping both out**: the nav
is the surfaces work happens **on**, so a tab beside the others would say the archive is somewhere work
happens and configuration is something you do rather than the thing you set up once. Record has a
second reason of its own — a selected goal outranks every tab, so as a tab the record could not be read
beside the goal that sent you looking for it.

**The two ways off this bar to a tracker ride the readings' end, together** (`Asks`, `.cn-asks`), and
`Issue!` has two faces onto _one_ destination. Connected it is a button opening a compose modal and the
issue is created directly; offline it is `↗ Issue!`, the external link it has always been. They sit
with the readings rather than against the wordmark because that is where every control on this strip
is — the wordmark's job is to say where you are — and because inheriting the ident's 600 read them as a
second half of the product name. They move as a **group**, so the pair cannot come apart when the strip
wraps: the cheaper offer is only offered first while it is beside the other one. `.cn-issue` sizes them
out of the bar's own face through a console-owned wrapper and `.cn-issue-btn` takes the button's padding
off, since `console.css` styling `.ext-ref` directly is what this stylesheet is tested not to do.

**Beside it is the Claude Code hand-off, which answers instead of filing.** Most of what reaches the tracker
as a complaint about the fleet is not a fault in it — it is _why has this not moved_, which the
harness's own record settles in a sentence, and which nobody asked because asking meant opening a
client, finding the checkout and remembering the skill. The control is that, as a link: a
`DesktopLink` (`questionPrompt`, `web/src/cockpit/desktopLink.ts`) carrying `/lubbdubb ` and the
checkout the fleet works on, so the operator's own Claude Code opens with the skill in the composer
and the cursor after it. It carries **no argument**, unlike the four hand-offs drawn beside the thing
they address: this one is drawn beside the wordmark, before the operator has decided which goal the
question is about, and the skill routes on the words they type — a goal number in them is the goal
job, none is the fleet one ([20](20-validation.md#the-skill)). Unsent for `Ask`'s reason one step
further along: there is not even a subject yet.

It sits beside `Issue!` because the two are the same moment — something looks wrong — and the cheaper
reading of it should be the one nearer to hand. Unconditional, like every other deep link, and with
the command in its title for the operator whose machine the link cannot reach.

**Both are drawn as chips, one word and a mark each** (`.cn-ident-act`, and `.cn-ident-ask` for the
accent border the question wears). They were two sentences in one weight and one ink a hand's width
apart, and read as a single run of small print — an operator scanning the bar saw neither, which is
the whole failure for a control whose value is being noticed at the moment something looks wrong. The
punctuation carries the difference between them, because that is the difference: one files, one asks.
The chrome is on the **wrapper** and not the control, since the offline face is `ExtLink` and takes no
class of its own — and a rule naming `.ext-ref` is the one thing this stylesheet is tested not to do.
`.cn-ident-act` rather than [the tag](#the-tag): the tag is a reading, and borrowing it dressed the
pair as verdicts — and, because a `<button>` does not take the inherited
`text-transform` an `<a>` does, drew one of them in sentence case beside the other in capitals. The
question's ink is set as `.cn .cn-ask-btn`, since the console's `.cn a` reset counts as (0,1,1) and
beats a bare class.

**Both faces of `Issue!` go to LubbDubb's own repository, and neither follows
`github.owner`/`github.repo`** (issue #449). Those name the repo the fleet _works on_, which is LubbDubb's only while it is dogfooding itself.
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
nav: a reading you go to and come back from rather than a number you glance at, and one whose _window_ an
operator changes rather than accepts. What is left here is what a glance can actually settle — counts of
things waiting on a person, and the state of this build.

Three rules hold them:

- **A reading that opens something carries a chevron; a reading that acts does not.** The countdown
  presses to run a pulse rather than opening a panel, so it carries no chevron — a reading that opens
  something and a reading that does something are different promises, and the chevron is the only thing
  that says which. It stays pressable while paused or held: that is precisely when an operator wants to
  confirm nothing moves.
- **A zero count mutes a reading; it never removes it.** The gauge staying put is what lets an operator
  glance at the same spot every time rather than hunting for a control that reflows when its number
  happens to hit zero.
- **Launch counts the queue, not the history.** A launched brief that has been dispatched is an
  agent in the Fleet, and counting it here would have the reading climb as work starts rather than as
  it waits.

**Which panel is in front is one value**, `ConsolePanel`, not a boolean each: a boolean per panel
admits far more states than there are, and two panels in front at once is not something this layout can
draw. The **ask** panel rides in that same value as `{ ask: <row id> }` rather than beside it, for that
reason exactly: a second field would let an ask and the fault log both be in front, which is the state
the type exists to rule out. A `Panel` has **three ways out** — the backdrop, the button and Escape —
because a thing that covers the console must not have exactly one exit; `test/console.test.ts` pins
them.

### The Usage chip

What the Claude account has left, and the only surface that draws the usage the wire has carried since
#60 ([18](18-observability.md#usage-accounting)). It leads the readings because it is the one gauge here
that can stop everything: an allowance that runs out parks the whole fleet
([10](10-agent-runtimes.md#the-account-usage-windows)), and learning that from a parked agent's row is
learning it afterwards. Beside the fleet cap it reads as the second half of one sentence — what the
fleet is allowed to run, and what the account has left to run it on.

**Both windows are on the chip, because either one parks the fleet.** `62%⁵ʰ / 30%⁷ᵈ`. A chip
carrying the five-hour alone reads fine on the morning a weekly allowance runs out, which is the failure
a gauge exists to prevent — and the two are not a proxy for each other: a fleet with a whole five-hour
window and no weekly left has plenty of room today and none by Thursday.

**It carries no label of its own.** A percentage on this bar is the account, and nothing else here is
one, so `Usage` was width spent restating what the figures already say — on a strip that wrapped to two
rows at laptop widths. The name survives as the head of the `title`.

**Each window keeps a two-character tag, as a superscript.** Position alone was tried and is not
enough: the pair is always five-hour then weekly, but an operator glancing at _one_ number cannot tell
which of the two they landed on, and "which window is that" is the whole question the chip answers. The
tag is the smallest thing that settles it — 8.5px, faint, and set on the ascender the `%` leaves empty,
so it costs the strip no width and does not move the figures off the baseline the readings share
(`.cn-usage-win em`). Between the two is a faint `/` (`.cn-usage-sep`), which separates and does not
measure.

**Usage and Local are one pill** (`.cn-pill`, `.cn-pill-sep`), the fleet gauge's argument applied to
the other two readings that are about the operator's own situation rather than about the work — what
the allowance has left, and whether anything is up on this machine. Each is two or three characters
wide, and two boxes around six characters was more chrome than reading. Each half keeps its **own
button**, because they open different surfaces; what they lose is the border, the padding and the
chevron. `.cn-sub` is (0,2,0) through the pill, which is how it beats the usage tone classes' border and
background: inside the pill a tint is the value's, never a second box around it.

**Five-hour left, weekly right, always — the weight says which one bites.** Ordering the pair by which
is worse was the obvious alternative and is the one thing this chip must not do: the bar is the row an
operator glances at without reading, and a gauge whose big number changes slot as the account moves is
one they have to read. So the position is fixed and the emphasis moves instead. The window nearer its
limit is lettered at `--cn-fg` and is the one the tone reads; the other sits at `--cn-fg-dim`. Without
that mark the chip is two numbers and a shrug — comparing them is precisely the work it exists to have
already done. Figures are `tabular-nums` in fixed slots, so the chip is the same width at 9% as at 93%
and the readings beside it never shuffle when an agent reports.

**A window nothing reported draws an em dash, not `0%`.** Each is independently nullable on the wire,
and a zero would claim a fresh allowance nobody measured. An unreported window can never be the one
nearer its limit either, whatever the other reads.

**Where neither was reported, the five-hour cost stands in.** `usage.rateLimits` is null on API-key
auth, on an older CLI and on a fleet that has not taken a turn; `usage.windows` is self-computed and
always there. There is no pair to draw then, so the chip shows money rather than going blank — a hole in
the bar on the deployments least able to spare one. It is never both: two subjects in one chip.

**A stale reading is drawn stale, in the weight and not as a figure.** The limits are turn-bound —
they arrive only when an agent takes a turn, and an operator's own Claude Code spends from the same
allowance — so an idle fleet's figures age while the real windows keep moving underneath them. Past ten
minutes both percentages go faint (`.cn-usage-old`) rather than hiding numbers that are still the best
answer anyone has. It printed the age beside them for a while and that is the version to not go back
to: `11m ago` next to `62% / 30%` is three numbers on a chip that has two measurements, and the one an
operator does not want is the one that changes every minute. The age is the `title`'s. No probe could
ask the account directly, so rendering the staleness is the whole of handling it.

**Two tints and a mute, tinting only what wants acting on.** Amber from three quarters spent, red from
nine tenths, the mute below a quarter — all read off the binding window, so a weekly at 91% is red while
the five-hour is empty. The resting state is the plain reading its neighbours wear. Both tints go
through the token layer (`--cn-amber-*`, `--cn-red-*`), so a theme switch takes them with it.

**The slots are `i`/`em`/`b` and not `span`, which is load-bearing.** `.cn-read span` is a _descendant_
rule, so a wrapping `<span>` is lettered as a chip label — uppercase, faint, 11px — and that face is a
reading's own name, which is not what a window tag is.

**It is the one reading here whose way-in is a whole page.** It carried no chevron for as long as the
honest answer to "spent on what?" was nothing: the chip could give a percentage, and no surface had a
span that matched it — by the chevron rule above, promising a destination there would have been
promising an answer. `5h session` is that span, anchored to the same reset this chip reads
([18](18-observability.md#the-session-window)), so the chevron is now owed rather than promised. It
opens Insights on Economics over that window, because "where did it go" is a question about money and
that is the tab that splits it; landing on the page's own default would answer for a week, which is a
different question with a bigger number — and the number is the half an operator would remember.

The title is the same either way, with one clause added. The click is an **addition** to the reading:
an operator who has always glanced at the figures and moved on loses nothing, and a gauge that can park
the whole fleet is no longer one that cannot be asked what spent it.

### The Build gauge

The one reading in [the bar's menu](#the-bars-menu) that is about the process rather than the work:
where the harness's own build stands against its upstream ([21](21-self-update.md)). It follows the mute
rule above rather
than being an exception to it — `current`, muted, in a fixed place, is the state it is in almost all
of the time, and that is the point. A notification that appears only when there is news is one an
operator has to notice; a gauge in a fixed spot is one they can glance at.

It goes amber only at `behind` and `ready`, the two states where something is waiting on a decision.
It is deliberately **not** drawn as the crash-recovery banner. That treatment is a stop sign, and it
is loud because the harness is running no cycles at all while it is up; an available update stops
nothing, so borrowing it would say something untrue — and after the second time, be scrolled past.

### The Environments gauge

The only reading on the bar about the world the work ships into rather than about the fleet or this
build: whether any environment's health check says something out there is broken
([24](24-environments.md#is-the-environment-well)). It sits **beside the fleet cap**, which is the same
gauge one step out — what the fleet is allowed to do, when it next gets to decide, and whether where it
ships is up.

**It draws only while something is not well, and that absence is the healthy reading.** The one
departure from this bar's rule that a quiet reading is dimmed rather than removed ([the readings
strip](#the-readings)), and it earns the exception the way nothing else here would: an environment is
well nearly all of its life and there is nothing to do about it when it is. There is no Environments
card behind it any more — it was a sixth of the overview spent saying _well_, on the page that answers
_what is happening_, and what an operator actually wanted from it was the outage. `unknown` counts as
not-well and draws: it is not a claim that anything is right, and folding it into the healthy silence
is the one way this chip could hide an outage.

**The value is a count and a word, never a bare number**: `1 red`, `2 not well`, `1 no answer`,
`4 well`. `Env 1` would leave an operator hunting for which of three quite different things it meant,
which is the only thing they wanted to know. The count is of the environments sharing
the _worst_ word rather than of every environment that is not well, so `2 red` and `1 orange` never add
up into one figure describing neither.

The fold is `environmentsReading` in `TopBar.tsx`, exported for `test/console.test.ts` exactly as
`usageReading` is, because it is the whole of the chip's judgement. Its ranking is the card's tones read
as an ordering: an **untiered `unhealthy` ranks with a red**, since an unstated severity is not a reason
to rank an outage below one that stated it, and `unknown` sits below both — it is not a claim that
anything is wrong — and above `healthy`, since it is not a claim that anything is right. Red and an
untiered unhealthy take `.cn-env-ill`; an orange and an `unknown` take `.cn-env-watch`, told apart by
the word beside them rather than by a third colour claiming an answer the check did not give.

**Absent, not zeroed, where no environment declares a check** — the old card's exception, for its
reason: a reading of `0 well` on a deployment that configured none announces a feature as broken. That
holds for the menu row as well as the chip, and `test/console.test.ts` asserts the row on the fold and
the chip on the rendered bar, in all three of the chip's arms: no check declared, every check well, and
an outage.

**Both open the Environments panel** (`EnvironmentsPanel`, `web/src/console/EnvironmentsPanel.tsx`) —
one row per environment, the word it is in, how long it has been that word, when it was last read, and
the check's own sentences behind the row's marker, drawn verbatim. One panel for the two ways in,
because two surfaces drawing one check's sentences are two places for them to disagree. Its rows are the
card's exactly; what changed is that they are opened rather than occupying the overview.

Four panels open from the bar, the ask panel opens from a queue row ([the rail](#the-queue-rail--needs-you)), and Settings is a shell-owned modal beside them:

- **Obstacles** — `ObstaclesPage`, a **nav destination rather than a panel**, and the tab that
  replaced Knowledge (`web/src/components/ObstaclesPage.tsx`, over `GET /api/obstacles`). What is in
  the fleet's way, what owns each one, and — behind a fold on the row — the sightings in their authors'
  own words with the key that matched each. It is described here with the panels because everything
  about the surface is the same either way, and `ConsoleRoot` mounts the page for the tab.

  **It is read-mostly, and it has no badge.** _What is blocking the fleet, and what owns each one_ —
  not a queue, not a triage surface, and nothing on it is waiting on a decision. Four controls, none
  of them on any path: mute, own it, retire, and write it down. → [27](27-obstacles.md#in-the-cockpit)

  **What was here before it was the claim store's page**, and that store is gone
  ([27](27-obstacles.md#what-the-claim-store-left-behind)): with it went the queue, the nine sections,
  the table, the reach controls, the exits, the composer an operator wrote a claim in, and the budget
  meter that drew what the injected block was costing. The cross-fleet pool's status strip, which was
  drawn above it, is on [Insights](28-cross-fleet-pool.md#in-the-cockpit) now — it is a reading about
  what this fleet publishes and reads, on the tab that answers what the fleet is costing and reaching.

  **Every link to any of those surfaces lands on this tab.** `?tab=knowledge`, `?panel=knowledge`
  (with or without `&fact=`), `?panel=findings` and `?panel=lessons` are aliased in `readPlace`; the
  `fact` id is dropped, because there is no longer a row it could open.

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

`AttachmentStrip` draws what was attached to a queued brief (`job:<id>`). The URL comes from
`attachmentUrls`, never string-built, because it carries a short-lived capability that the cockpit's
bearer token structurally cannot substitute for — an `<img>` load sends no `Authorization` header
([16](16-http-api.md#get-attachmentsid)). Clicking opens the image at its own size in a new tab,
`rel="noreferrer"` so the capability does not ride out in a referrer.

`SchedulePanel` puts a brief on a clock: a cron expression, a prompt, code/desk, and every
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
  → [13](13-jobs-and-tickets.md#schedules)

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

## The feature board

`web/src/components/FeatureBoard.tsx`, off `/api/features`, derived by `src/features/featureBoard.ts`.
**Off by default and absent on most deployments** — see [the two gates](#the-two-gates) below.

A fleet worked at the story level answers _is #583 done_ and never _how is the Environments work
going_, and the second question is the one anybody outside the fleet actually asks. The board is that
question: one card per container the mirror's items hang off, with the work beneath it folded.

It is a **lens**, on the terms the work graph, `buildStacks` and `prAttentionStatus` are held to
([05](05-dispatcher.md)): nothing under `src/dispatcher/` reads it, it decides nothing, and every
reading on it is a quotation — the outcome word is `ticketOutcomes`', the money is `buildSpendGoals`',
the watch bucket is [`src/watchLabels.ts`](../../src/watchLabels.ts)', which items are containers is
`isContainerType`'s, and the environment fold is `rollUpReach`'s. It is fetched on open and never
polled, for the tickets tab's reason: it reads the whole mirror, and the snapshot comes round every
couple of seconds.

### The two gates

The board needs **both** the operator's `featureBoard` flag ([02](02-configuration.md)) and a provider
that can place a work item. The second is not a permission check and not a guess at the provider's
name: `canPlaceWorkItem` is asked of the connector exactly as `canCloseIssue` and `canSetWorkItemState`
are, and it is the right predicate rather than a near one — placing a work item _is_ setting its
parent, so a provider that can do it is exactly a provider with the container hierarchy this board
rolls up. GitHub answers false by design ([15](15-integrations.md)).

Without that second half the flag alone would draw a page where every item is its own orphan and the
whole board is one grey card. So on a flat tracker the tab is **absent**, not empty.

The conjunction is one predicate — `featureBoardOn` in `src/features/featureBoard.ts` — read by four
callers that must never disagree: the route's own refusal, the `config.featureBoard` on `/api/state`
that the nav draws its tab off, the dossier a summariser is handed, and the digest its submission is
stamped with. Two copies would drift into the cockpit's worst shape, a tab whose every fetch 404s. The
refusal is a **404 and not a 403** for the same reason: neither gate is about permission, and a 403
would send whoever reported it looking for a token problem.

**The flag switches on an agent as well as a surface.** Rule `feature-summary`
([05](05-dispatcher.md)) spends one desk agent per Feature whose work has moved, and both halves of
this gate hold it: a deployment with the flag off, or a tracker with no hierarchy, summarises nothing
and does not read the mirror to find out whether anything moved. That is worth stating where the flag
is described, because "draw a tab" is not what an operator expects to start a fleet.

### Six standings, because they are six different facts

The bar over each card is segmented, and the four segments that are not `delivered` are the ones a
reader acts on differently. The precedence is strict and every step of it is load-bearing:

| Standing    | Is                                            | Beaten by                 |
| ----------- | --------------------------------------------- | ------------------------- |
| `unwatched` | no watch tag — **nothing has ever read it**   | nothing; it wins outright |
| `inFlight`  | a run the harness minted and has not finished | `unwatched`               |
| `delivered` | `ticketOutcomes`' word                        | `unwatched`, `inFlight`   |
| `fellShort` | worked, and the goal still not reached        | `unwatched`, `inFlight`   |
| `settled`   | `concluded` or `abandoned`                    | `unwatched`, `inFlight`   |
| `queued`    | watched, and none of the above                | everything                |

**`unwatched` first, and it is the reading the whole board most has to get right.** An item carrying
no watch tag has not been appraised, not been read and not been spent on — it is _unseen_, not late.
Drawn as `queued` it would report a fleet working through a backlog it cannot see, and the card would
say the opposite of the truth while looking entirely reasonable. It is drawn **hatched** rather than as
a sixth colour, exactly as the tickets tab hatches "no feature": it is the absence of the fleet having
looked, and a solid block reads as a fifth kind of progress.

**`inFlight` above the outcome words**, because a re-picked goal carries the verdict of its _last_
attempt while an agent works its next one. The board is a reading of now — and the verdict is not
erased by it, only outranked: the row carries both.

**`settled` is its own segment** rather than folded either way. Into `delivered` it overstates the
Feature; into `queued` it understates it for ever.

### Three buckets for a parent link, not two

The mirror's `parent` is three-valued and stays three-valued all the way to the screen: a Feature, a
resolved `null`, and an **unresolved** absence. The orphan card counts the second and the third is a
line of its own under the board. Folding them would tell a reader the tracker says an item has no
parent when the truth is that nobody could read the link — the same distinction the tickets tab draws
by leaving unresolved rows [flush with no heading](#features-are-headings-not-rows).

**The orphan card is the most valuable thing on the page and the most uncomfortable.** Work answering
to no container is invisible at portfolio level by construction, and a board that quietly dropped it
would report a fleet whose every hour rolls up somewhere. It carries its own spend for that reason:
_this much was spent under no Feature_, which is also the sentence that says every roll-up above it
understates its own.

### The briefing

Under the bar, each card carries three short lists — **In the way**, **Being worked**, **Delivered** —
which are the questions somebody outside the fleet asks in that order: _what is stopping this_, _is it
moving_, _what of it is done_. The counts above answer none of them: `3 fell short` is a number, and
what a person needs is the sentence saying what fell short.

**Every line in it was written by somebody.** A delivered line is `IssueDelivery.summary` as its
author wrote it, attributed to them; a blocked line is either the agent's own escalation prompt or the
assessor's shortfall summary; a working line is a goal and the age of the run on it. Nothing in the
briefing is composed, scored, summarised or forecast — which is the same discipline the attention line
one row up keeps from the other side. That line **counts facts and phrases them**; this one **quotes
sentences and phrases nothing**. A briefing that wrote its own sentence would be exactly the verdict
about a Feature this surface refuses, wearing an agent's voice.

**Blocked is two words, not one.** `asked` is an agent parked on an escalation nobody has answered —
the fleet is stopped and what it needs is a reply. `fell short` is an assessor's verdict that the work
did not reach the goal — nothing is stopped, and what it needs is a decision. Folded into one word a
reader could not tell which of the two things they owe, so they are drawn in two colours and questions
sort first: one has an agent waiting against it and the other has been waiting anyway.

**A question counts only where the escalation names the goal.** One raised against a pull request
(`pr:42:ci`) names no goal here, and it is counted under **no** Feature rather than attributed to a
guess at which one the PR was for. It is still on the needs-you rail, which is where a parked agent is
answered.

**Only `open` escalations block**, never "unanswered": `dismissEscalation` stamps no `answeredAt`, so a
briefing keyed on that field would leave a Feature reporting a question nobody is being asked any more.

**The outcome word decides the done and blocked lists, not the standing.** A re-picked goal is
`inFlight` and still carries the verdict of its last attempt, and both readings are true at once —
keying the delivered list off the standing would take finished work off the board for as long as an
agent is on the goal.

Each list is bounded (`FEATURE_BRIEFING_ROWS`, `src/features/featureBoard.ts`) and **says what it stood for**: `3 of 11`, never three
rows and silence. Three of eleven blocked items read as three blocked items is the one number on this
card somebody would act on being wrong about. The orphan card carries a briefing on the same terms —
work answering to no container is still work, and a person asking what is in the way wants that answer
too.

A Feature with nothing worked, nothing delivered and nothing blocked draws **no briefing at all**. The
bar has already said so, and three empty headings would be the loudest thing on the card saying
nothing.

### The order its stories go in

Between the summary and the briefing, when the Feature has one: a **proposal to answer** while nobody
has, and one line once somebody has. It groups the children list already on the card rather than
adding a second one, and the copy on the Goal page is folded shut. Both surfaces, and why the order
is amended by talking to Claude Code rather than by dragging, are
[33](33-story-sequencing.md#the-cockpit). Absent on every deployment with `issueSequencing` off,
which is the default.

### The feature summary

Above the briefing, and above everything except the bar and its counts, a card draws **the one piece
of prose on this board**: where the Feature actually is, written by an agent, in its own voice.

The board answers every question about a Feature except the one it is opened with. A bar, six counts,
three lists of quotations and a row per child are each true, and a reader assembles _where is this_
out of them themselves — which two readers do differently. The summary is that sentence, said once,
by somebody who read the whole Feature.

It is four fields, not a document: **where this is** (required), **usable now**, **blocking**, **left
to do**. They are four questions, and a reader must not have to find each of them inside a paragraph.
A field the agent left out is drawn as nothing at all, never an empty heading: nothing usable yet,
nothing blocked and nothing left are ordinary states, and the lede is where an agent says so.

**It is a quotation like everything else on this card.** The board still composes no sentence: what it
draws is the four fields as they were submitted, stamped and attributable. That is not the same thing
as [the verdict this surface refuses](#what-it-deliberately-does-not-draw) — a status word is the
harness asserting a policy nobody stated, where this is one agent's account of what it read, and the
prompt refuses it dates, percentages and _on track_ for exactly that reason.

#### It is rewritten when the Feature moves, and the trigger is a comparison

Rule `feature-summary` ([05](05-dispatcher.md)) dispatches one desk agent per Feature whose standing
has changed since anybody last wrote about it. The obvious trigger — an event, fired when something
happens — is the one thing it must not be: an event is lost to any restart that straddles it, and
"since **you** last looked" is a per-reader state the harness has no honest source for.

So the summary stores a **digest of where every child stood when it was written**
(`featureStandingKey`, `src/summaries/featureSummary.ts`), and the rule fires exactly when that digest
no longer matches the standing now. An unmoved Feature costs one string comparison a pulse and no
agent, for ever.

What goes into the digest is **standings, never text**: the tracker's state and its native state, the
delivery and shortfall verdicts, a run in flight, a landing. Not `changedAt` — a title fixed or a
comment added moves that, and re-writing a Feature's account because somebody corrected a typo is an
agent spent on nothing. An item _moving_ is what a summary is about, and an item newly linked under
the Feature is a movement too.

The key is stamped **at submission**, not at dispatch. A key taken when the agent was launched would
record where the Feature stood before the run, so anything that moved during it would match for ever
after and that Feature would never be summarised again — silently, and indistinguishably from a
Feature at rest.

#### Nothing gates on it

A Feature is exactly as delivered with a summary as without one, so a missing summary is silence
rather than a hold — `issue-retro`'s answer, one tier up ([05](05-dispatcher.md)). An agent that
crashes, is killed or spends its attempt cap costs the paragraph and nothing else, and no escalation
is raised: there is nothing a person can do about a summary that did not happen that they cannot do by
reading the board under it.

The orphan card carries **no summary**, and the omission is the point rather than a gap. A summary
says where a _Feature_ has got to; the orphan bucket is every item the tracker says answers to
nothing, which share no goal for anybody to have got anywhere with.

### What it deliberately does not draw

**No verdict about a Feature.** There is no _at risk_, no _on track_ and no forecast date, and their
absence is the point rather than an omission: each would be a policy no config file states and no
module owns, and a card asserting one would be exactly the second opinion this surface is arranged to
avoid. What it draws instead is one line naming what is waiting on a person — and that line is a
**count of facts, phrased**: an appraisal the appraiser marked `unclear`, items that fell short, items
nothing can see, a reach the probe could not read. Ordered hardest-first, and it stops at the first
thing that bites, because a card that says four things says none of them.

**No age judgement.** `lastLandingAt` is drawn as an age and nothing is said about whether it is too
old. How stale is too stale is a policy nobody has stated.

**No sizing or forecast.** Extrapolating the remaining work from recent spend is the one reading that
would make the board feel finished, and it is the one it has no honest basis for.

The ordering — features wanting a person first, then the ones carrying the most work — is an
**ordering and not a verdict**, the same distinction the queue rail draws. It says which card to read
first and nothing about whether a Feature is in trouble.

### Reach folds with the same function, one tier up

A Feature is to its goals what a goal is to its landings, so the per-environment fold is
`rollUpReach` — the **same function**, exported from `src/environments/reach.ts` rather than copied
([24](24-environments.md)). That is what keeps `unknown` from collapsing into `absent` one tier up,
which is the whole reason the verdict is three-valued: an expired credential and work that genuinely
has not shipped read identically on the glass, and only one of them is about deployment. A goal that
is `partial` or `unknown` counts as **unresolved** here — half a goal in an environment is not a goal
in it.

Only goals `allGoalReach` produced a row for are counted, which is that module's decision and not a
second one. A goal with nothing merged has been nowhere; counting it as `absent` would put every
never-started story in the denominator and make a shipped Feature read as a third deployed, for good.

### Where it sits

In `components/` and not in `console/`, because it rides its own route and **nothing under `console/`
imports `api.js`** — the tickets tab's arrangement exactly, asserted in `test/console.test.ts`. Its
styles are in `web/src/styles.css` for the same reason, drawing `--cn-*` tokens all the same: the
prefix boundary is by component family, [not by file](#tokens).

The tab is inserted **beside Tickets** rather than appended, because the two are one backlog read at
two altitudes and a reader moving between them should not cross the obstacle board to do it. A goal is still
opened, and still acted on, on its own page: the board links down and never grows a control of its
own.

Each card ships a bounded slice of its children, ordered so that what wants attention survives the
cut — an arrival ordering would show twenty delivered stories and drop the one that fell short. What
was cut is **said**, not silently trimmed: a list that simply stopped would read as the whole Feature.

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

Configuration is a **page** (`web/src/components/ConfigPage.tsx`), reached from the cog at the tail of
the top bar and addressed as `?tab=config`. It was a modal with three tabs until the surface outgrew
it: fifty keys, five sections and a file to reconcile against is a thing you work in rather than glance
at and dismiss. The decisive argument is smaller than that, though — **a modal cannot be linked to**,
and "look at what `agentMode` is set to on the box" is a URL now.

It is not in the nav. The nav is where you **go** — the surfaces an operator moves between during a day
— and configuration is not one of them: a button beside the others would say it is another thing you
_do_ rather than the thing you set up once, and the cog at the tail of the bar is where an operator
already reached for it. That is the rule [Insights](#insights) is in the nav under, and the earlier phrasing of
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

| Drawn from                  | Decided by                                                                  |
| --------------------------- | --------------------------------------------------------------------------- |
| the widget                  | `entry.type` — `configFields.ts` ([02](02-configuration.md#fields))         |
| applies now / needs restart | `entry.live` — true only where `configApply.ts` holds an arm                |
| not editable                | `entry.env` (the environment beats the file), or `access: 'fileOnly'`       |
| where the value came from   | `entry.env`, `entry.isDefault` and `entry.fromProject` — one of four words  |
| what else requires it       | `entry.requiredWhen` — the declaration, judged here against the staged edit |

**Four words, because there are four layers.** `env`, `file`, `project` and `default`: a harness
pointed at a repository carrying a `lubbdubb.project.json` is running a config assembled from two
files, and only one of them is the one this page writes ([02](02-configuration.md#the-project-layer)).
A team's value drawn as `default` would send an operator looking for a key their own file does not
have — and a row cleared while the project sets it says it will fall back to the project's value,
because it will. `isDefault` is therefore _what you would have without your own file_, which is the
same question as "what does clearing this leave", since the form writes one file and nothing else.

`requiredWhen` is the one row in that table whose _answer_ is not the server's, and the exception
proves the rule: the question is about the edit in front of the operator, not about the config the
harness booted on. `fleetId` is required while `integrations.pool` is anything but `fake`, and both
keys are edited here — so the row is marked, the value on offer (`userId@pool.project`) is drawn beside
it as a button, and **Review & write** is refused, naming the key and why, with a way to the group it
is in. The server still refuses the same save; what the page adds is that the operator never reaches
it ([02](02-configuration.md#a-key-another-key-requires),
[28](28-cross-fleet-pool.md#configuration)). A deployment that got the pool without the id anyway — a
team's committed project file arriving before the operator named their fleet — is asked by the `fleet`
row on the rail rather than by a harness that will not boot
([28](28-cross-fleet-pool.md#a-fleet-with-no-name-yet)).

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

|            |                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stored     | `localStorage` under `lubbdubb.notify`, beside the token — a property of this browser, so two people on one deployment can want different things. Not `Place`: the address bar holds where you are, and this is not somewhere you can be.                                                                                                  |
| Categories | `needsYou`, `errors`, `agents`, `environments`, each independently switchable. `environments` fires on a health reading's change of state or tier ([24](24-environments.md#being-told)). `agents` is described in the panel as frequent rather than quietly defaulted off — switchable is the answer to noise, not a default nobody finds. |
| Permission | Requested only from the button, never a mount effect: every engine requires a user gesture and some refuse silently. `enabled` is written only once the browser has actually granted, so a switch can never read on and do nothing.                                                                                                        |
| Suppressed | Only while the cockpit is **both** `document.visibilityState === 'visible'` **and** `document.hasFocus()`. A notification for a row you are looking at is noise, and the point is to reach you when you are elsewhere.                                                                                                                     |

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

Seventeen, and **Dark has no block**: Dark _is_ `:root`, which is what makes it the default with no
second copy of the palette to drift. The other sixteen live in `web/src/theme.css` as
`html[data-theme='x']`. Thirteen are ports — Solarized Dark and Light, Monokai, Dracula, Atom One Dark,
Moonlight, Nord, Gruvbox Dark, Catppuccin Mocha, Tokyo Night, Night Owl, GitHub Dark and Light — one is
Light, one is High contrast, and **Amber is not a port of anything**: a warm low-blue palette for a room
with the lights off. Amber is deliberately _not_ monochrome, which is the obvious reading of an amber
phosphor screen and the wrong one here, because this cockpit carries verdicts in colour and a green that
is amber makes a passing pipeline look like a failing one.

Each preset declares a **ground**, `dark` or `light`, on its `PRESETS` entry in `theme.ts`. It is the
one fact about a palette the picker needs before the sheet is consulted — which row to draw the tile
in — and it is declared rather than read off `--bg` because the list is drawn where the sheet is not
loaded. Fourteen are dark; Light, Solarized Light and GitHub Light are the light row.

They are CSS rather than a TypeScript table because sixteen at sixty-three tokens each is over a thousand
values: in a module they would ship in the JS bundle and nobody could review them against the sheet they
override. `html[data-theme='x']` counts (0,2,0) against `:root`'s (0,1,0), so a preset wins on
**specificity, not order** — which matters because Vite injects styles through JS in dev and extracts a
stylesheet in production.

A block declares only the tokens whose `:root` value is a **literal**; the `color-mix` ones follow from
the core on their own. That rule is not written down anywhere but the CSS itself — the test derives the
required set by reading `:root` — so adding a core token makes every preset fail until it has an answer.
Each preset was built from ~27 anchors with the tints derived by the same ratios `:root` uses, and the
ratios differ between a dark theme and a light one on purpose: 31% of a hue over a dark ground is a
border you can see, and the same 31% over near-white is a tint you cannot. What stays constant is the
contrast against the ground, not the proportion.

Four of the ports needed a value changed to be usable rather than faithful. Dracula's comment grey and
Monokai's sit at 2.4 and 2.2 against their own panels, Tokyo Night's at 2.5 and Night Owl's at 2.9 —
fine for a comment, too quiet for the secondary text this UI puts there — so all four are lifted. Every
text pair in every preset clears 3:1.

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
- **The bar's statement is carried off the section by a dot on the Config row.** The bar lives on the
  Theme section and the preview does not, so once you leave, an unsaved theme is drawn exactly like a
  saved one and nothing says an edit is pending — the cost stops being visible at the moment it starts to
  matter. The section publishes `dirty` to a module store in `theme.ts` (`setThemeUnsaved`), which
  [the bar's menu](#the-bars-menu) and the Theme tab inside Config read through `useThemeUnsaved`. It is
  a module store and not React state because the two ends are not in one tree, and it is **not** on
  `Place` and **not** persisted: an unsaved edit is a fact about this tab, not a destination, and a flag
  surviving a reload would mark a draft the reload dropped. The publishing effect has **no cleanup**, for
  the same reason the applier has none — unmounting the section must not clear the marker. A dot rather
  than a count on every surface, because what is pending is one edit however many tokens it moved, and
  Config carries no value at all.

  **It reaches the menu's own button as well as the Config row inside it** — `MenuEntry.pending` is what
  the row draws, and the button's flag dot reads it beside the tones. Config moved behind that button
  after the mark shipped on a cog on the strip, and a mark visible only once the menu is open is the same
  invisibility one fold further in, which is the whole of what #680 was.

- **The dirty sentence never counts zero.** A preset change sets `dirty` but moves no token, so
  "**0** tokens changed · unsaved" read as "nothing pending" and got left unsaved (issue #680). With no
  token moved the bar names the preset instead: `Preset ‹label›, unsaved — a reload drops it`.
- **The picker is two rows of tiles and one caption.** A tile carries the four swatches and the name
  only, and the tiles sit in a Dark row and a Light row by the preset's `ground`. Nine cards with a
  blurb each fitted above the token editor; seventeen did not, and a picker that pushes the editor off
  the screen has made the page about choosing rather than tuning. The blurb is drawn once, beneath the
  rows, for the preset that is on — and stays on every tile as its `title` — because the question the
  picker answers is "which one", and the blurb is the answer to "what is it" about the one you chose.
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

**One page, one window, nine readings of it — eight of them windowed.**

- **Economics** — is the fleet worth what it costs? The ratio headline, the phase split, the timeline,
  the goals and the costliest runs.
- **Allowance** — what has the account got left, and what spent it? The percentage over time with the
  agent runs beneath it, the apportionment, the weekly burn-down and allowance per landed change. See
  [below](#allowance).
- **Reliability** — did it finish, and did it go green? Outcomes, the CI timeline, the reddest pull
  requests, the phase health and the repeats.
- **Causes** — what keeps sending the fleet back? The guard split, both cause tables, and Lately.
- **Trend** — is what I changed working? The eight-period cohort view.
- **Work mix** — why does _this kind_ of work cost what it does? By task type, and by failing check.
- **MCP** — which tools the fleet reaches for, and which it never does. The odd one out, and
  deliberately: every other tab is a reading about work the harness did, and this is a reading about a
  **channel**. See [below](#mcp).
- **Review** — what the [review packs](31-review-packs.md#the-operators-reading) say about the agents
  that write them: where reviewers overrode the checker's attention label and which way, the ratio of
  `plumbing` hunks to owned ones, and how often a pull request merged with a false claim nobody marked
  as read. The one tab whose subject is the harness's own output rather than the fleet's work — and
  **never shown to the checker**, because a label that has learned to agree with its reader has stopped
  being evidence. Fetched on the tab's first visit for a window, like Trend and MCP: it folds every pack
  against every mark.
- **Pool** — what the whole [cross-fleet pool](28-cross-fleet-pool.md) spent, across fleets. The one tab
  that ignores the window bar, and it has to: the digest's bucket is a UTC day and its retention is
  ninety of them, so the page's five spans are not a question anybody asks of it. What it takes instead
  is a **project**, on `Place` as `poolProject` — because `byCheck` is comparable only inside one
  pipeline, and the tab draws the reason rather than an empty table when it is not narrowed.

Every table the three panels drew lands in exactly one of these, and the duplicates collapse on the way
in: there is one phase table rather than two, and one completion rate rather than the reliability fold's
and the trend's.

### The page is bounded, because a reading is not

Every surface here is read **across** — a phase against its share, a goal against its runs, a cause
against what would have caught it — so the page is capped at `1400px` like the tickets table. A row let
out to the width of the monitor puts the two ends of one fact far enough apart that the eye loses the
line between them, and none of the graphs say anything more for the space.

Two consequences of that are in the stylesheet rather than left to the grid:

- **The ratio row is flex, not the `sp-tiles` grid.** The two operators are punctuation, and
  `auto-fit` gave each of them a full `1fr` column — so the sentence arrived as three figures marooned
  a couple of hundred pixels apart with a lone `÷` adrift in each gap, the division still true and no
  longer legible as one thing.
- **A graph is capped at `800px`**, about `1.3x` its own viewBox. Axis labels are drawn in user units,
  so a chart handed the whole page scales its text up with its bars and arrives in a size nothing else
  on the panel uses. The two-column charts sit under that bound already; the Trend tab's three, which
  have a section each, were being drawn at twice their size.

And in a table, **a left-aligned column that follows a right-aligned one pays the gutter at the join**
(`.sp-tbl .n + td`). A `.n` cell pays its own on the leading edge and nothing on the trailing, which is
right between two figures and wrong at that boundary: the Causes table met its reddest check with no
space at all, drawing `4 of 9format:check` under a header reading `UNDOCUMENTEDREDDEST CHECK`.

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

Because it is `Place`, **the tabs and the window buttons are `Place` moves**, and their fields must be
`Place`'s own — `insightsView` and `insightsWindow`, which is why `openInsights` takes those names
rather than the shorter `view` / `window`. The action spreads what it is given straight into a place
patch, and a spread is exactly where TypeScript stops checking for excess properties: named for the
page rather than for the place, both halves landed on the place as keys nothing read, and **every tab
and every window button on the page was a control that changed nothing** — no state, no query string,
not even a history entry to go back from. `useNavigation`'s patch type now makes a key `Place` does not
have a type error at the call site, since nothing else about that failure was visible: the page
rendered correctly and simply did not move.

### The time bar

One control, **above the tabs rather than inside one**, because it is page state: switching tabs keeps
the window, and every reading under it obeys the same one. That is the whole argument for the five
sharing a surface.

Six windows — `5h session`, `6h`, `24h`, `7d`, `30d` and `All` — resolved server-side by
`resolveWindow` (`src/insightsWindow.ts`) and shipped back on every payload
([18](18-observability.md#the-window)). **The page draws the window it was handed, never the one it
asked with**: a caption derived from the key is free to disagree with the buckets the server actually
cut, and the caption is the half a reader would believe. The resolution is stated beside the control —
`6h buckets` — rather than left to be counted off the bars.

Before this, each reading picked its own span and none of them lined up: six hours for the production
graph, five and seven days for the spend tiles, a fortnight for the spend timeline, another fortnight
for CI, eight weeks for the trend — and all-time for the run half and the spend totals. Two figures side
by side on one surface described different stretches of the fleet's life with nothing saying so.

**The Trend tab obeys it too**, by showing the last eight windows _of the length the operator picked_:
`7d` gives eight weeks, `24h` gives eight days ([18](18-observability.md#the-spend-trend)). That is what
keeps one control meaningful on a tab that is inherently about change, and it has a second payoff — the
comparison a headline draws against "the previous window" is literally the last two bars of that chart,
rather than a second notion of "before" for a reader to reconcile. `5h session` is the exception that
holds the rule: its periods are whole five-hour windows on the account's own reset boundaries, because
an eight-bar comparison between arbitrary fractions of a window is a comparison between nothing
([18](18-observability.md#the-session-window)).

**`5h session` leads the six**, because it is the only one an operator arrives at with a question
already formed: the [usage chip](#the-usage-chip) said the five hours are nearly spent, and this is the
one span that can say on what. It is also the only window not measured from `now` — it is anchored to
the account's own reset — so the page draws a line under the control saying which five hours these are.
Three sentences for three cases: the window the account named, and the two the harness could not anchor
to, where the control's own label reads `Last 5h` instead. The anchor is the server's, taken off the
payload like every other caption here; the page has no reading to draw it from and must not acquire one.

That note carries the one thing the split beneath it cannot say for itself: **the limit meters something
this harness cannot see, and the breakdown is money.** The account's percentage is drawn beside it — the
one the fold anchored on, not the chip's — precisely because an operator will make the comparison
whether or not it is offered, and a stated pair is better than an inferred one.

### Economics

**The ratio is the headline**, read left to right as one sentence: what the window cost, what landed in
it, what one landed change therefore cost, and how much of the spend never landed at all. The operators
between the tiles are drawn because they _are_ the reading — four unrelated boxes would leave the
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

**Fetched on open, three states, and the third is the point.** Loading, the reading, and a _failure_ —
because a fetch that failed must not render as a fleet that has spent nothing. `$0.00` is a real answer
here (a fresh harness, or one run entirely on the mock runtime), so it cannot also be the failure mode. The
all-unmeasured case gets its own sentence rather than a table of zeroes: **unmeasured is not free**.

### Allowance

`web/src/components/AllowanceTab.tsx`. The usage chip on the top bar says how much of the five hours is
gone and can say nothing else, because `account_rate_limits` keeps one row and overwrites it on every
turn. This tab is the series behind that number
([14](14-persistence.md#the-accounts-usage-windows-and-their-history)) drawn four ways, in the order an
operator asks them:

1. **The timeline** — the percentage over the window, with every agent that ran beneath it on the same
   x axis.
2. **Where it went** — the same rise apportioned to the goals that were spending while it happened,
   with the remainder carried rather than divided.
3. **The week** — whether the current pace reaches the weekly limit before the limit resets.
4. **Per landed change** — the Economics tab's one sentence, re-denominated in percentage of the
   account rather than in dollars.

**The lanes are the timeline's whole argument.** They let a reader see which agents were running while
the line climbed without the chart ever claiming that the tallest one caused it — adjacency drawn
honestly, which is all the readings can support. A number _per goal_ is offered one panel down, where
it is labelled as apportioned. A run that reported no usage still gets a lane and is drawn muted: it
was running, which is the only thing a lane claims, and it moved the account by nothing this harness
can see.

**A lane row is a goal, and it is named in a gutter.** Two dispatches onto one goal are two bars in
one row, which is what lets the row carry a name down the left — and a name in a gutter is the only
kind a reader gets without a pointer, which a screenshot, a touch screen and a reader who does not
hover all are. The name is a `<Ref>`, so the row is a way _to_ the goal rather than a mention of it
([links](#links)). The rows come in the apportionment's order, so the band and the table at the foot of
the tab are the same list twice rather than two orders to reconcile; a goal with no run in the window
is not a row, because the band is about what ran. The runs that reached no goal share the last row —
an absence is one row however many agents are in it. This is why the timeline is laid out in a
1000-unit viewBox where the rest of the page uses 620, and drawn at `.al-wide` rather than
`.sp-graph`'s bound: it spends its first fifth naming rows, and scaled down to the narrower bound its
axis text would arrive smaller than anything else on the panel.

**The band is HTML and the plot is SVG, laid out on one set of fractions.** The band is a gutter and
some bars on a linear time axis, which the document draws as well as a viewBox does — both are
percentages of the same box, so a bar still stands under the stretch of line it ran during. Drawing it
in the document buys the two things SVG was costing. A gutter cell can hold a link, which an SVG
`<text>` cannot: the goal numbers down the left were the tab's dead ends. And the hover can be the
cockpit's own element rather than the browser's `<title>` tooltip, which arrives a second late, cannot
be styled, is unreachable from the keyboard and never arrives at all on a touch screen — the chart said
`hover a bar` and, for a reader who tried it, nothing happened.

**The readout is one element for the plot and the band together**, because a pointer is in one place
and the thing under it is either a reading or a run. The whole plot is the reading's hover target and
it answers with the **nearest** reading, marked on the line where it stands — a dot is three units
across, and a chart that asks a pointer to find one has no hover at all. A lane bar is focusable for
the same reason its readout exists: focus is how a reader without a pointer reaches it. It is not a
control, though — there is nowhere in the cockpit to send a click from a finished run, and the goal's
own way through is the `<Ref>` in the gutter beside it.

**The plot is a grid, and its two edges are states rather than scale ends.** A reader tracing a run up
to the line needs something to trace along, so the window is ruled at quarters both ways and the x
axis labelled in ages. 100% is where the fleet stops, so it is drawn in the alarm vocabulary and says
so; on the weekly burn-down the same is true of the floor, which carries a red zone marked `PARKED`.
The last reading takes a larger dot and its percentage beside it — the one figure a reader came for,
said in the chart rather than only in the tile above it — and a faint area under the line is what
makes a step chart read as consumption rather than as a path.

**An idle stretch is a column, not just a dashed segment.** It is shaded through both panels, so the
lanes and the line agree about where the harness was not watching, and captioned in place when it is
wide enough to hold the words. The burn-down draws `now` under its first point and the span to
exhaustion under its last, with the span to the reset beside the reset line — dropped when the two
marks are close enough to read as one figure disagreeing with itself, since the verdict sentence
below carries both either way. Spans rather than clock times, for that sentence's reason.

**Two discontinuities are drawn as discontinuities.** A reset breaks the line rather than drawing a
cliff, which would read as the fleet having given something back. A gap — the fleet idle, so no reading
arrived — is drawn dashed rather than solid: the rise across it is real and counted
([18](18-observability.md#a-fall-is-a-reset-a-gap-is-not)), and what is unknown is what happened inside
it. Joining either with a plain line is a chart asserting something the readings do not say.

**The residual is a different kind of thing, not a sixth goal.** It is hatched rather than filled,
because "the account moved and no agent of ours was spending" is not another goal — a solid segment
beside the goals invites reading it as one, which is the single misreading this tab can cause. The
goal colours are slots (`issueNumber % 5`), so a colour is stable for a goal across every redraw and
says nothing about which goal it is; the table below is the legend, exactly as it is on Economics.

**Nothing here is derived in the browser**, Economics' rule and for its reason: the reset test, the gap
threshold and the apportionment are statements about what the readings _mean_, and a cockpit free to
compute its own would draw a line the server's own totals disagree with. What the cockpit owns is
presentation — the colours, which live in the stylesheet as `--al-*` on `.al`, aliases of themeable
tokens in the way `--sp-*` are.

**The tab merges the route's own `refUrls` over the shell's** (`RefLinksExtended`), the Tickets tab's
arrangement and for a reason this tab feels hardest: a goal that spent inside a five-hour window has
usually closed, so the snapshot's map — built from the world — does not carry it, and the row whose
title reads `no longer on the tracker` is precisely the one an operator most wants to open. Unmerged,
every goal number on the tab renders as plain text ([16](16-http-api.md#get-apiallowance)).

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
_verdict_ and carries the alarm vocabulary. Grey is doing real work in it: a killed run is not a fault.

A fleet with runs still out and none settled gets its own sentence rather than a table of zeroes —
**not yet is not perfect**.

### Causes

Drawn on a tab of its own rather than as the third block of the reliability panel, and it is the section
that gained most from the move: three tables and a quotation list read _below_ two other readings is
where an operator stops scrolling, and this is the one surface on the page that shows the taxonomy is
being used rather than guessed at ([18](18-observability.md#causes-why-the-fleet-came-back)).

The guard split leads it as one bar and a legend, ordered by what acting on each costs; the two cause
tables follow, one per kind, ranked by accounts with the empty causes kept at the foot — "nothing was a
flake this window" is a reading, and a table that dropped its own zero rows could not make it. Then
**Lately**: the most recent accounts in the agents' own words. The section's caveat is drawn with its
total rather than in a footnote — every share in it is a share of what was _reported_, and
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
the _place_ rather than the click that changed it, so arriving on `?view=trend` from a shared link is a
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

### MCP

`web/src/components/McpUsageTab.tsx`, and the tab that does not fit the page's pattern. The other five
fold records the harness was already keeping for some other purpose; this one folds `mcp_calls`
([14](14-persistence.md#mcp-calls)), a table that exists only for it — because the failure it is about
leaves no trace anywhere else.

It is here rather than on the config page's MCP tab because the two answer different questions. That
one answers _how do I connect my own Claude Code to this_, and is a set of instructions. This answers
_is the channel doing anything_, and is a reading over a window — which is a thing the config page has
no way to take.

**It leads with the silence.** Call counts are the least interesting thing on it and are drawn last.
What comes first is the two ways the channel fails without saying so:

- **A run that called nothing.** An operator `--allowedTools` in `claudeArgs` is appended last, so it
  beats the harness's and drops every `mcp__lubbdubb__*` grant. The channel connects, every call is
  refused before it arrives, and the agent finishes on the sentinels with nothing to show it ever tried.
  A call that never arrives cannot be recorded, so this is measured against the **runs** that settled:
  a run with no rows against it is the alarm. It is drawn above every table, because it is the reading
  that invalidates the others — a per-tool count taken over a window in which three runs could not reach
  the channel is a count with three runs missing from it.

  **A silence is asked of the run's whole life, and every other figure on the page of the window.** That
  asymmetry is deliberate and is the one thing here worth writing down. The window admits a run on
  `runInstant` — where it ended — so a run that opened before the window and finished inside it is in
  the denominator, and every call it made may be outside. Counted the window's way it is reported as a
  run that could not reach the channel, and _any_ run alive at the instant the window opens qualifies:
  up to the concurrency cap's worth of phantoms, every time a 24h view is opened, each carrying the full
  `claudeArgs` remedy. The failure being reported is a property of the whole run — grants dropped at
  launch — so the evidence has to be too, which is what `callsEverByAgent` is for. Narrowing the
  denominator to runs that fit _entirely_ inside the window was the alternative, and it drops runs that
  legitimately belong to it and quietly changes `callsPerRun`.

- **A tool nothing named.** `tools/list` is not an instruction: an agent reaches for what its prompts
  named, and a tool nothing names loses to `gh` with nothing red anywhere
  ([11](11-mcp-tools.md#where-a-tool-is-named-to-the-agent)).

**A count of zero is four facts wearing one face, and the server says which.** This is the part that
earns the tab. `src/mcpInsights.ts` ships a verdict per silent tool with the evidence behind it, rather
than three numbers for the cockpit to interpret — the same rule `PHASE_COPY` and `OUTCOME_COPY` follow,
and for the same reason: it is a claim about what the harness did, and a cockpit re-deriving it would
be a second opinion drawn inches from the first. The ladder, worst first:

| Verdict                        | What it means                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **Called, always refused**     | Agents are reaching for it and its contract turns every one away. The one case where the silence is the tool's own fault. |
| **Retired, still called**      | A withdrawn name ([11](11-mcp-tools.md#retired-tools)) something still names. Every call spends a turn on a refusal.      |
| **Nothing named it**           | In neither the addendum nor any prompt the window dispatched. Nobody was told it exists.                                  |
| **Named, never reached for**   | Agents were told and none called it. The job did not come up, or the wording is not landing.                              |
| **No desktop session used it** | A person did not sit down and run one. A reading, and the one verdict with no remedy.                                     |

**"Tools to answer for" is a fraction, so both halves count the advertised set.** `toolsAdvertised` is
what `tools/list` offers and nothing else, and the quiet count is over the same names — a retired name
something is still calling is a _different_ finding from a live tool gone quiet, and counted in the
numerator it read `24/20` in amber on precisely the deployment the "Retired, still called" verdict
exists to help. Retired names still being called are counted apart and said beneath the fraction. The
per-channel `toolsCalled/toolsAdvertised` counts the advertised names called, for the same reason.

**Traffic under a name that was never a tool is stated, not dropped.** A call to a name that is neither
advertised nor retired belongs to no tool row, so it would be in the total and in none of the naming
shares — the Work mix table's remainder, unstated. It is its own naming class instead, since a prompt
or a model reaching for a tool that has never existed is itself a finding; like the retired class, the
row is drawn only when something is in it.

The evidence is drawn beside the verdict — whether the addendum names it, and how many dispatch prompts
did — so the claim is checkable rather than merely stated. That separation is load-bearing:
`TOOL_NAMING` says where a tool is _supposed_ to be named and the text says whether it was, so a tool
classified `addendum` whose name is not actually in `MCP_PROTOCOL_ADDENDUM` is a defect the tab names
outright, where a check of the classification alone would agree it was fine.

**The `--allowedTools` override is reported before it costs a run.** It is a live config read and the
only thing on the payload that is not a fold of the window, because the point is to catch the flag
rather than to explain a silent run afterwards.

**The two channels are never summed.** They are different credentials over different tool sets, and
`validation_report` is two different tools with one name. The desktop channel gets its own section; the
one graphic that draws both is a _relative_ width — which channel this harness's traffic is — never a
total.

**Naming colour is a token, not a value**, on `.mc` as the phase and outcome palettes are on `.sp` and
`.rl`. It is a _category_ palette rather than a verdict one: `addendum` and `point-of-use` are two
places a tool can be named and neither is better. The alarm colours are the cockpit's own red and amber,
because a fleet that cannot reach its tools is the alarm vocabulary.

**It fetches on its own first visit**, keyed by window, exactly as Trend does and for a sharper version
of the reason: its naming evidence is a scan of every dispatch prompt in the window, which is the one
query in the harness that reads `tasks.prompt` in bulk.

### Usage

`web/src/components/UsageTab.tsx`. Every other tab on this page is a reading about work the **fleet**
did; this is the one about the person beside it — what the harness asked of them, what they did about
it, and what the waiting cost. It is here rather than anywhere else because that question is decided
against the same window as the spend it competes with for the next month of work.
→ [34](34-usage-metrics.md)

**Two tables and a list, and the split is the reading.** An _ask_ is the harness stopping and waiting
for a person; an _act_ is a person reaching in when nothing asked them to. They want opposite
readings — an ask by whether it was answered and what waiting for it cost, an act by whether it
happened at all — so folding them into one "activity" figure is the measure that document refuses to
be. The list beneath is [surface reach](34-usage-metrics.md#surface-reach): a verdict per surface,
worst first, with the evidence it was reached on.

**A `null` is never drawn as a zero.** A dash means the record behind that row cannot answer the
column — an obstacle carries no stamp for the moment it started asking, a landing records the click
and never the offer — and a zero there would manufacture a finding out of a missing column, which is
the one way this reading could talk somebody into removing a control that works.

**It draws no reference.** There is nothing on this payload to link to: the store behind the reach
half has no ref, no title and no id in it by construction, and a `<Ref/>` here would be one drawn
from a table that must never hold one. That is the [links rule](#links) satisfied by the payload's
shape rather than waived.

**The verdicts are the server's words** ([34](34-usage-metrics.md#a-quiet-surface-is-four-different-facts)),
on the MCP tab's argument exactly, and the verdict stripe borrows the alarm vocabulary rather than
introducing a palette: `never-linked` is red because it is the harness's own navigation at fault.

**It fetches on its own first visit**, keyed by window, as Trend and MCP do: it sweeps every
settled-record table the harness keeps about a person plus the whole reach table, and an operator who
came here to read the phase table should not pay for it. The two halves ride one payload over one
window, because the pairing they exist for is only a pairing if both describe the same stretch.

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
- A WebSocket connection delivers events. `dirty`, `world:changed` and `world:events` each trigger a
  refetch; `cycle:end` also resets the heartbeat countdown anchor.
- **`control:changed` triggers no refetch at all.** `ControlState` is exactly `{cap, paused}` and the
  frame carries both, so the cockpit applies it to the state it holds — pushing the fleet cap costs
  no request. ([16](16-http-api.md#controlchanged-is-the-delivery-not-a-signal-to-fetch))
- **A refetch asks for the sections the signals named.** A `dirty` carries `sections`, or carries none
  and means all of them ([16](16-http-api.md#sections)); the answer is a `Partial<AppState>` that the
  cockpit **merges over the state it holds**. That merge is the whole reason sections cost the
  presentation layer nothing: the cockpit's state stays one complete `AppState`, so `buildViewModel`
  and every surface under it go on receiving a whole object and never learn that anything arrived in
  parts. `refUrls` is merged rather than replaced — a ref's URL is stable, so an entry can only go
  stale by being absent, and a ref learned in one patch has to survive the next.
- **Refetches are coalesced** (`scheduleRefresh`, `REFRESH_COALESCE_MS`): at most one request in
  flight, at most one queued behind it, and a short trailing window so a burst collapses into one. The
  server pairs a `dirty` with almost every specific frame, so one pulse alone is four signals, and
  `agents.on('files')` fires once per file an agent writes — fetching per signal made the request rate
  a function of agent tool-call volume. The queued refetch **always runs**: coalescing may merge the
  signals in between but must never drop the last, or the cockpit settles on a state older than what
  it was told about. The initial fetch on mount is immediate, not delayed, and asks for everything.
- **Coalescing widens, never narrows.** The pending request is the **union** of what the merged
  signals named, and becomes "everything" the moment one of them names nothing. A signal that lands
  while a fetch is in flight is recorded before the early return, so it belongs to the queued fetch
  rather than being lost — narrowing past something a signal reported had moved is the one silent
  failure this machinery can have.
- **An operator's own write is followed by a full refresh.** A click can move anything — a watch
  toggle re-decides pickup, a job lands in the queue and on the graph — and unlike a socket signal
  there is nothing on the client that knows what it touched. Sections are for the fleet's own chatter,
  which is what there is a lot of.
- `agent:output` deltas accumulate into a per-agent scrollback (capped at ~1M characters) — but only
  for the agent whose drawer is open, because output is delivered to subscribers only.
- `agent:tail` lines land in a separate map.
- The WS client is held in a ref so subscribe/unsubscribe survives effect churn, and it reconnects on
  its own.

The drawer subscribes to full output on open and unsubscribes on close or switch.

## The agent drawer

`AgentDrawer` opens over the page for one agent, asked for by `actions.select(id)` from wherever an
agent is drawn — the Fleet card, a goal page's **On this goal** rows, the escalation card's own way in.

**The transcript is polled every five seconds while the run is live, and the poll is the load-bearing
half of how the pane moves** (issue #639). The socket delivers an agent's output the moment it
happens, but only what it produced _since this drawer subscribed_ — so what arrives there is a suffix
of a stream whose earlier part came from `GET /api/agents/:id/transcript`, with no marker joining the
two. The drawer's rule was therefore "prefer the socket buffer once it is longer than the fetched
seed", which is the safe reading of that and also meant a run opened mid-flight showed a **frozen
pane**: the socket had to deliver more bytes than the entire transcript before it before anything
moved, which on a long run is never. Watching an agent work was the one thing the drawer is for, and
it was the thing it could not do.

So the seed is re-read on a five-second timer, and the route is
[ranged](16-http-api.md#get-apiagentsidtranscript) — each poll names what the drawer already holds and
is answered with the tail, so a quiet run costs an empty string rather than the whole record. The
socket buffer is still preferred where it is **safe**, which is exactly when the transcript was empty
when the drawer opened: the socket then carries the stream from its first byte, the two strings are the
same, and the pane moves at the speed of the agent rather than the timer. Anywhere else it is ignored
— appending a suffix to a prefix across an unknown gap would draw output that never existed.

Two things about the timer are deliberate:

- **It stops when the run does.** A finished transcript never grows again, so a closed-out agent left
  open on the glass is not a request every five seconds. A first read that has not landed yet is
  retried regardless of status, so a drawer opened on a slow response still fills.
- **A status change does not restart it.** `running ⇄ waiting` is every question an agent asks, and
  keying the seed effect on liveness would drop the buffer and reseed the pane on each one — every
  expanded tool call folding shut mid-read. Liveness is read through a ref inside the tick instead.

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

**The pane is a component, `TranscriptPane`, and every surface showing a session's output draws it
there.** It is not the drawer's private business, because what a session emits is `renderBlocks` output
whoever is watching it: the local run panel's tail is the same bytes off the same `output` event
([23](23-local-runs.md#the-cockpit)), and it used to go into a `<pre>` — which showed an operator the
SGR escapes raw, with every tool call at full length, on the one surface there is to read when a
bring-up did not work. That is not a plainer rendering of the same text, and nothing in `check` has an
opinion about it: it compiles, it renders, and it is unreadable. The component takes the text, a
`streamId` naming which stream it is, and an aria label; `compact` on its wrapper caps it for a panel
rather than letting it fill a drawer.

**A reseed is any text that is not an extension of what was written**, as well as a `streamId` change.
The drawer's buffer only ever grows, so this is the agent-switch case there — but the local run's tail
is a rolling two hundred lines, and once it rolls, every poll drops lines off the top. That reseeds,
which is correct: those lines are gone. The cost is that the blocks come back collapsed while a
bring-up is still printing, and it is the right trade — the pane sticks to the bottom, and what is being
read at that moment is the newest output rather than an expanded call from four minutes ago.

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
recognises the labelled lines the server writes and emits DOM operations the pane applies. Its tests
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

The drawer also shows the artifact chips, the **files changed** list, and offers respond, interrupt
and kill.

The files list is **fetched by the drawer**, on open and again on its five-second poll while the agent
is live — `GET /api/agents/:id/files` ([16](16-http-api.md#get-apiagentsidfiles)), the same seam and
the same beat as the transcript above. It came off `/api/state`, where a fleet-wide `files` list was
87% of the payload and existed so that this one panel could take one agent's slice of it in the
browser; `filesByAgent` is gone from the view model with it. Nothing else drew it.

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

**A rail tab goes amber while its section is asking for something.** Two do: `Caveats`, which carries
a ticked/total count and stays amber until the last box is ticked, and the `History` control on the
right when a change is waiting on the operator. The rail is otherwise navigation, so the tint is the
only thing on it that means "not done", and it is what a held Approve points back to — the checklist
sits in the scroll, and an operator who has not scrolled that far would otherwise have a disabled
button and nowhere on the sheet saying where the boxes are.

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

**A part in review carries a restart**, beside its PR chip: a two-step `ConfirmButton` that closes the
pull request, drops the branch and puts the part back to `ready`
([08](08-planning.md#restarting-a-part)). Offered only on `in_review`, which is exactly the state that
means an open pull request with no agent running — the other states are refusals the route would have
to explain. And drawn **not at all** where `config.canClosePr` is false, the way the board draws no
drag where `canSetWorkItemState` is false: the whole feature is absent on a provider that cannot close
a pull request, rather than a control that fails on the deployments nobody tested.

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

### The watch digest

`WatchDigest` (`web/src/components/WatchDigest.tsx`) — what a running system would have to show for
this work to have done what it claimed, drawn under the validation digest because it is the later
question: validation asks whether the goal was met, this asks whether the thing is behaving once it
is there ([29](29-post-deploy-watch.md#in-the-cockpit)).

Each row is the check's title, its kind, its query, its `presence` query where it declares one, what
it expects, and what the dry run read against the environment. The expectation is phrased by kind
rather than in one sentence over both: a signal declares a count it must not exceed, and a measure
declares a number against a threshold or against the baseline the dry run took before the work
arrived. A check nothing has asked about yet says so in those words — not yet put to an environment is
not a clean reading — and a goal that declared no checks draws nothing at all, because null is a third
fact and not a synonym for clean.

**Read-only but for one control, and the exception is the whole point.** A check the working agent
declared through `watch_declare` arrived _after_ the approval that authorises a query to be run
against the operator's own telemetry with the operator's own credential — so it draws as a **pending
change** with accept and decline beside it, over the live declaration it amends, which stands
untouched until somebody rules. Accepting applies it, clears the readings of the text it replaced, and
runs it once against an environment; declining leaves a live check exactly as it was and drops a row
that was never anything but a proposal. Nothing else on this sheet takes a verb, for
`ValidationDigest`'s reason.

The state lives on the check itself (`goal_watches.live` and `goal_watches.proposal`) rather than on
the plan-amendment path: a declaration made at conclude time would otherwise put a goal's whole plan
back through approval to carry one query, which holds the goal's own work to move a sentence about
telemetry.

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

### The four answers to a plan

**One component, both surfaces.** `web/src/components/PlanAnswers.tsx` draws the four answers on the
inbox card and in the plan sheet's footer, and the sheet adds only what the card cannot know: the
`Decision` strip above them, which is what approving _starts_. Two rows of controls for one decision is
how the sheet came to offer six answers where the card offered four, and how the card came to be the
better-organised of the two — it already set the ticket answers apart under _"Not the work you want?"_,
and the sheet, the surface where the plan is actually read, did not.

What the four are, and why there are no longer six, is [08](08-planning.md#the-four-answers). What is
the cockpit's own:

**Nothing asks for words until an answer that needs them is chosen.** There is no note box at rest.
`Change something first` and `Close the ticket` each open a drawer under the row, focused, captioned
with what happens to what is typed, and **held until there is something** — `disabled` rather than left
to a 400, the same call the held Approve makes. The change drawer is tinted in the accent and the close
drawer in the red family, because only one of them writes anything outside this harness.

**Objection pins seed the change drawer.** A part can be pinned _question_ or _drop_ while reading. The
pins used to be composed into the one free-text note and could only be sent by choosing a verdict
first — so an operator who disagreed with one part of five had to accept or reject the whole plan to
say so. They are the drawer's opening text now, still editable, on the one answer that does something
with them.

**Escape closes a drawer and decides nothing.** A question you cannot back out of is a commitment.

Approve and the change arm appear only while the plan is `awaiting_approval`, and route through the
same `decideProposal` the escalation card uses — one verdict, one implementation, so the rail's row
clears whichever surface you decided from. **Abandon** is gone: it retired the unstarted parts and
worked the goal as one pull request, which was a distinct act only while a plan with no parts was a
different kind of plan ([08](08-planning.md#a-plan-is-a-list-of-parts)).

The sheet's hand-off is an `<a>`, not a button — the only control on the sheet that is. It carries
`desktopDeepLink(config.desktopFolder, discussPrompt(n))` (`web/src/cockpit/desktopLink.ts`), which
opens the operator's own Claude Code on the goal's checkout with `/lubbdubb discuss <n>` prefilled.
A destination belongs on an anchor rather than behind a click handler. It is drawn only when the plan's
origin names a goal number, which is what `plan_amend` resolves a plan by.

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

The control is absent until there is a second revision **or a change is waiting on the operator**, and
a fetch that fails leaves it absent rather than drawing an error for a view nobody has asked for.

### A change waiting on the operator

Above the history, when `history.pending` is set: a plan that is still running, with a correction
somebody has asked about it — the author's own words, the same `DiffBody` the applied diff is drawn
through, and the warnings saying what applying it would leave standing. It is the only part of this
view that is a **question** rather than a record, and the control on the rail says so (_Change
waiting_) rather than naming the history it will become. Drawn on the amber the cockpit already carries
(`--amber`, `--amber-line`, `--amber-fill`); no token was added, because "something is waiting on you"
is not a new meaning for colour here.

The reason it is on this sheet at all is that the inbox card is the other half of one reading: a plan
sheet that showed a running decomposition with no sign that a correction to it was pending reads as a
plan nobody has questioned, and this is the surface somebody goes to when they actually want to read
the plan.

**It carries no verdict.** Accepting or declining is the proposal's, on its card; a second pair of
buttons over one decision is two places for it to be answered differently. What this owes the reader is
the case and its consequences — including the sentence a running plan drawing its parts would otherwise
leave them to infer wrongly: nothing is paused while they decide.
→ [08](08-planning.md#amending-a-running-plan)

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

**A fork is drawn apart from a note.** An entry carrying a `decision`
([31](31-review-packs.md#the-witness-log)) gets a `fork` chip in its head and, under its note, a
labelled block: _chose_, _because_, the _rejected_ list with each alternative's reason, and the
_paths_ where the agent gave them. The rejected list is the part a diff can never show, so it is the
part given the room. Drawn on the blue tint the cockpit already uses for the fleet's own reasoning
(`--blue-line`, `--blue-line-2`, `--blue-fill`) — a fork is not a new meaning for colour to carry, so
no token was added.

## The review pack

`ReviewPackModal` (`web/src/components/`) is a pull request's [review pack](31-review-packs.md#reading-it)
over the goal page it was opened from: the change restated as ideas, each followed through the code
it touched, every claim with the checker's verdict beside it. It is the one rendering of a pack that
takes input — the reviewer's marks — and the page it draws is `ReviewPackPage`, a pure function of
the payload, so the order of things on it is asserted on static markup rather than hoped for.

**Shell-owned**, opened through `viewReviewPack(prNumber | null)` and its fold through
`openReviewIdea(id | null)` — the notepad's seam, for its reason: the modal reaches `api.js` for the
pack, for the two pads the claims cite and for the marks, while the control that opens it is on the
pull request's row the console draws. Both are `Place` fields (`?pack=`, `?idea=`), so the back
button steps out of an idea and a link somebody sends lands on one; `idea=all` is the open-all
control, a value of the same field rather than a second one. An idea row is a `<details>` whose open
state is the address bar's — the click is a move, not a toggle the element does on its own.

**Four states, and the 404 is one of them**: loading, no pack (not asked for, with the ask; or being
written, with nothing to press), the pack, and an error — a fetch that failed must not read as
"nobody asked". While an author or a checker is on the pull request the modal re-reads on a short
clock; the `dirty` the hub emits for either is a snapshot signal the modal is not on.

**The page is [31](31-review-packs.md#the-page)'s order and nothing else**: masthead, the gate above
the ideas when any claim is false, the idea rows numbered by the checker's order (or document order,
and the rule says which), the walk and the claims on opening one — a false or disputed claim at the
top of its idea, before the walk — the finding boxes, where to spend the time, the folded colophon.
A pack whose `schema` this build does not know is refused whole at the top, never drawn as far as it
is recognised. What a reviewer does rides the marks routes ([16](16-http-api.md#post-apiprsnumberreview-packideasidread))
and the rows the write returns replace what the page holds, laid over the ideas by `layMarks`
(`web/src/view/reviewPack.ts`): read only when every hunk the idea owns says so, and the same for
`seen`.

**Three marks, and the third is under a finding.** Read and the attention override sit in the idea's
own row; _I have taken this_ sits at the foot of each finding box and nowhere else, because it is a
statement about the checker's output rather than about the walk, and it is the one number that says
whether [prominence](31-review-packs.md#whether-prominence-works) works. Nothing about it blocks
anything — the sentence beside it says so, since a control at the end of a red box otherwise reads as
an approval.

**Sharing has an inverse, drawn beside it.** The share control's six states include _unshared, waiting
for the next pool publish to take it out_: the withdrawal is recorded at once and the copy leaves on
the pool's own clock, so the modal's short re-read clock covers it exactly as it covers a share
waiting to go out ([31](31-review-packs.md#unsharing-a-pack)).

**Colour is a verdict or a mark the document states, never decoration.** The four attention labels
and the three verdicts take the shared family's hues — `--red` for read and false, `--amber` for
decide, can't tell and a dispute, `--blue` for split, `--green` for true — and the diff lines four
tokens of their own, `--diff-add-fill` / `-ink` and `--diff-del-fill` / `-ink`, all `color-mix` of
the two verdict hues over the well so a theme that moves green or red moves the diff with it. A
dashed box is the one visual rule the colophon explains: code that is _not_ in the pull request.
Pad notes and cited entries render as plain text with their newlines kept, for the
[notepad](#the-notepad-modal)'s reason.

## Running locally

A **Local** reading in the top bar's `cn-reads` row, quiet when nothing is up and carrying the goal's
number when something is, opening the running-locally panel
([23](23-local-runs.md#the-cockpit)). The number goes amber (`cn-stale`) when the environment is behind
the tip of its own branch: the code on the glass is old, and the panel has a control for it.

A reading rather than a nav tab, and the distinction is the one `TABS` is built on: the nav is the
surfaces work happens on, and this is a state of the operator's own machine. The **number** is the
value because that is the question — "running" alone leaves somebody opening the panel to find out
whether it is the goal they are looking at, which is the only thing they wanted to know.

`'localRun'` is a member of `ConsolePanel`, so the panel is a **place**: it survives a reload and the
back button steps out of it, exactly as every other panel does. It draws a card and two folds rather
than a table of runs — a list would imply two environments could be up, which is the one thing the
store refuses. The card is the environment: status, goal, ref and commit, the stage line while a turn
is in flight, the readings as tiles (the URL and whether its port answered, the ports the session holds,
how far the checkout is behind its branch, the spend), and the reply box. Its controls wear what they
are — Stop is the danger button with the two-click arm, Refresh is primary and drawn only while there is
something to pick up, Start appears once a row is picked — and none is ever disabled: a control that
would be is absent, and the stage line says why. The output and the picker are `<details>` folds, the
picker folded under "Run a different goal" while something is up, saying beside it that starting stops
what is running now. Which fold is open is local state, not `Place`
([23](23-local-runs.md#the-cockpit)).

Beside the ref it draws **what the run has cost**, climbing while the environment comes up. It is the
only spend figure in the cockpit read while the money is still going out, and it is here because this is
where the decision to leave something running is made. Absent rather than `$0.00` when nothing was
measured, the convention every spend surface keeps. The goal page's Spend card names the count in a row
of its own for the same reason: the row above it says "Agents".

## Opening the operator's own Claude Code

Six controls hand work to the operator's own Claude Code rather than to the fleet: the goal header's
question hand-off and its **run it locally**, the top bar's, the validation card's, the Feature
board's story-order one, and the plan sheet's. They are all `<DesktopLink>`
(`web/src/components/DesktopLink.tsx`), over the scheme and the prompt builders in
`web/src/cockpit/desktopLink.ts`.

**Every one of them says "Open in Claude Code ↗".** They said six different things — `Ask Claude Code`,
`run it locally`, `Question?`, `Run it in Claude Code` and `Discuss…` twice — and six names for one act
is a vocabulary an operator learns per surface rather than once. The argument about which verb a given
site deserves also has no end, because every site can make a case for its own; naming the destination
ends it. What still differs between call sites is what the session **arrives with** (`prompt`) and what
it **does** (`explain`), which is the pair that was always genuinely theirs.

**They are anchors, never buttons.** A deep link is a destination.

**The look is the component's, and it is the shared button kit's.** `className` used to stay the
caller's, on the argument that the sites live in rows with different tones — and what that bought was
`cn-tgl`, `cn-linkish`, `cn-ask-btn` and two different `buttonClass` looks on one control. It draws
`buttonClass({ ghost: true, size: 'small' })` now, which carries `btn` twice and so survives
`console.css`'s `.cn button` reset: the same element is native inside the console, where the goal
header and top bar draw it, and outside it, where the plan sheet and the escalation card do. A control
drawn on **both** grounds is exactly the case a second class would have had to keep in step by hand.

**The command is in the title as well as the `href`, and the component is what puts it there.** The
link fires only on the machine the browser is on, and a client that is not installed answers _nothing
at all_ — no error, no tab, no window. So an operator reading the cockpit from another desk is left
with the line to type, and the title is the only place to put it. This was a rule each site was
trusted to remember, and two of the five had already forgotten: the plan sheet's two **Discuss…**
anchors said what the session would do and never what command it would arrive with. So the title is
now **assembled** — `Opens your own Claude Code with "<command>" <ready>, <explain>` — and a call site
supplies only the half that is its own. `test/validationDesktopPrompt.test.ts` pins the composition,
and pins that no other `.tsx` builds one of these links.

**`ready` is why the clause is a prop and not a constant.** Most commands are complete and send as
they land; the two that start a **conversation** deliberately are not — the goal's fills the composer
with `/lubbdubb ask 284 ` so the cursor sits after the number, and the bar's with `/lubbdubb `. A title
promising a send that never comes is worse than none. It is also the only thing left distinguishing
those two from the rest, now that the label does not.

## Links

A surface that _names_ another thing and gives no way there is the cockpit's most repeated bug. It kept
coming back because linking was something each site had to remember to do rather than the only way to
draw a ref at all — so there is one component and one vocabulary, in
**`web/src/components/refs.tsx`**.

**The vocabulary is the harness's own colon-form ref** — `issue:212`, `issue:212:part:writes`, `pr:412`
— which is what tasks, queue items, claims, world events and plan parts already carry. Most call
sites pass a value they are already holding rather than re-deriving a number.

**The destination is the ref's own business, not the call site's.** `<Ref to={ref} />` decides:

- A **goal opens its page in the cockpit, and its ticket on the tracker** — both, as
  [two doors on one token](#a-reference-carries-both-its-doors). The page is the richer of the two —
  the plan, the asks, the pull requests are all on it — and it is the one no other route from a row
  that merely mentions the goal can reach; the tracker holds the story as it was written, which the
  page can only summarise. A part ref resolves to its goal; the part has no page of its own.
- A **goal the world does not carry links to the tracker instead**. Whether a ref has a page is
  `goalIssue`'s answer, handed to the provider as `hasGoal`, for the reason the queue rail asks it
  rather than guessing: `buildGoalPage` returns null for a ref the snapshot dropped, the console draws
  the tab behind it, and a link onto one is a click that appears to do nothing.
- A **pull request opens [its page](#the-pull-request-page) and the provider's**, the same two doors
  and for the same reason: the review threads, the checks and the work on its branch are all in the
  cockpit, the diff is not. Whether the cockpit has one is `hasPrPage`'s answer, handed to the
  provider as `hasPr`.
- A **pull request the world does not carry links to the provider instead** — a closed one on a
  deployment retaining none. `pr:412` and `#412` are both tried against `refUrls`; which of the two
  the snapshot happens to carry is not a row's business.
- **Anything the provider could not resolve renders as plain text.** A ref the provider could not
  resolve is absent from the map, which is what the `fake` provider produces, and a link that goes
  nowhere asserts more than a bare number does.

`<RefText text={…} />` is the second of them, for prose that mentions refs — a queue reason, a world
signal, an agent's note. Deliberately **not** routed through `<Ref>`: a bare `#412` in a sentence does
not say whether it is a goal or a pull request, and guessing would link onto whichever of the two
shares the number. The tracker's page answers either.

`<PrLink number={…} />` is `<TicketLink>`'s twin for a pull request — the `Open pull request ↗` its
page carries — and exists for the same reason, since a ref onto a pull request the world carries now
opens its page rather than the provider's. Two keys, most-trusted first: `pr:<n>` is unambiguous where
`#<n>` is shared with an issue of the same number.

`<TicketLink number={…} url={…} />` is the fourth, and the destination `<Ref>` deliberately does not
offer: a ref onto a goal the world carries opens its **page**, so the goal header's `Open ticket ↗`
needs a control of its own. Three keys are tried, in the order of how much each can be trusted — the
item's own `url`, then `issue:<n>`, then `#<n>` — and where it lives is the point. Both the ordering
and the inert `<span>` drawn when none of them resolves are judgements about _how a ref resolves_,
which is this module's job; written into the page instead, the next surface that wants a ticket writes
its own third ordering, and `#<n>` first is the one that opens a pull request on a tracker where issue
412 and PR 412 both exist.

`refLabel(ref)` is the third, and **the only place a ref becomes text** — `#212` for a goal from any of
its forms, `PR 412` for a pull request. It was written three times over, and the fourth surface that
wrote it printed the label with no link on it — which is the bug exactly: shortening a ref by hand is
how a surface ends up naming a thing instead of pointing at it. `test/refLinks.test.ts` pins that
nothing else strips a ref down to a number.

**The family is in the name because the marks cannot carry it.** The three marks below say where a
reference _goes_; none of them says what it _is_. So the rack drew `#412` for a pull request and `#212`
for the goal it delivers as the same token in the same slot, and the one question that pair raises —
which of these is the ticket? — was answered by clicking one to find out. A goal keeps the tracker's
own `#`, which is what every tracker, commit message and operator already calls it; a pull request says
`PR`. Nothing has to be taught and no fourth mark is spent, which is the trade: a notch, a tint or a
second glyph would each have cost a legend, on a row that already carries lamps, chips and hairline
rules.

The `PR` belongs in `refLabel` and not in the token that draws it, for the reason the function exists:
two call sites had already written `` `PR ${refLabel(ref)}` `` by hand, which is the same
fourth-surface bug one step along — the rows that said `PR` were the rows somebody remembered to make
say it. Both now pass a bare `<Ref>`.

### A `job:` origin stands in for other work

A crash recovery's **requeue** is dispatched at `job:<id>` and carries the origin it is redoing —
`issue:41:retro`, `pr:42:ci` — on `Job.originRef` ([13](13-jobs-and-tickets.md#standing-in-for-another-origin)). The task, the agent
row and the queue item all see the job ref and nothing else, so a surface that reads `task.originRef`
literally draws an opaque `job:job_F9Iy9o2rZQ`, which resolves against nothing and renders as plain
text: the fleet's most conspicuous row is the one row with no way anywhere.

The silent half is worse. `goalOfOrigin` matched `issue:` and `pr:` only, so a requeued run answered
null — it staffed no goal, so the goal whose work was out on the fleet read as **unstaffed**, and an
escalation it raised routed to no goal page.

So the origin is read through **`standsFor(state, ref)`** (`web/src/view/goalPage.ts`) first: a
`job:<id>` becomes the origin that job stands in for, and every other ref comes back unchanged. A job
that stands in for nothing, and one the snapshot's 100-row job list has dropped, come back **as
themselves** — the job ref is a true statement about the dispatch, and null would trade an opaque
reference for none at all. The walk follows a chain (a requeue of a requeue) to a small bound, so a
cycle ends rather than spins. It is the cockpit's side of the same edge the work graph draws on the
server, off the same field ([16](16-http-api.md) — the work graph's arm C).

Three readers: `goalOfOrigin` (so `agentOnGoal` and the goal page see the requeue), `goalOf` in
`needsYou` (so its asks reach the right page), and the fleet row's `OnWhat`, which draws **both** refs
— the job it was dispatched at, and what that job is redoing — on the pair-position rule the PR-and-goal
pair already follows. The agent drawer draws both too, resolved at the shell since it is handed one
agent rather than the snapshot.

### How a reference is drawn

**One vocabulary of three marks**, in `web/src/styles.css`:

- a **box** means this is a thing you can go to, not a number in a sentence;
- a **fill** inside the box means the destination is here, in the cockpit (`.ref-goal`, the only filled
  form — a goal's page, and a pull request's);
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
slot is space rather than a tick. Row anatomies differ after that slot (the rack carries two marks and
two buttons, a signal carries its count), so this is a slot rather than a table column, and there is no
header over it.

**Every selector in that block doubles its class** — `.ref-goal.ref-goal`, not `.ref-goal` — and it has
to. The same rule holds for the three marks in the reading slot
([review](#the-fleet-reviews-mark), [pack](31-review-packs.md#on-the-row), [checks](#the-checks-mark)):
each is drawn as a `button` on a row, so the reset below took its border, its ground and its ink, and a
tint that is declared, computed and then thrown away looks exactly like a mark nobody styled. `console.css` resets its own markup with `.cn button` and `.cn a`, which counts as (0,1,1) and so
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
tickets rows, the obstacle board, escalations, the plan sheet, the recovery cards, the agent drawer,
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

### A reference carries both its doors

A goal and a pull request each exist in **two places**, and the two answer different questions: _what
does the harness make of this_ is the cockpit's page, _what does the tracker or the diff actually say_
is the provider's. A `<Ref>` used to offer only the first, which made the provider somewhere you had to
go and find — and the one row that minded fixed it locally, by drawing a **second token with the same
number in it**. The overview's pull-request rack therefore read `#412` `#412` `#212`: two of the three
a repeat, and all three the same mark.

So it is **one token with two hit targets**, drawn by `RefDoors`: the number is the filled box that
stays here, the arm is the arrow that leaves, and the dashed border between them is the joint. No new
mark — the same three the vocabulary already has, arranged so a pair reads as one thing. The two halves
share an outer edge (the button gives up its right border), so it is one shape at rest and two targets
under the cursor, and the arm takes the same `:focus-visible` ring as the token, being the next tab
stop along.

**The arm is absent, not inert, where the provider resolved nothing.** It stands against a token that
_did_ resolve, so a dead second target reads as a broken link where a missing one reads as a token with
one door — which is what it is. That is the opposite of `<TicketLink>`'s rule, and deliberately: a
page's lone control saying "no address for this" is a stated fact; a row's second target saying it, on
every row, is noise.

Which key each arm resolves against is the same judgement `<TicketLink>` makes and matters for the same
reason. A goal's arm tries `issue:<n>` then `#<n>`, a pull request's `pr:<n>` then `#<n>`: `#<n>` is
**shared**, and `buildRefUrls` walks the pull requests before the issues, so on a tracker where issue
412 and PR 412 both exist `#412` is the pull request's address. A goal's arm that tried it first opened
the wrong thing on exactly the deployments busy enough to have both.

**A pair of references is joined by its order, not by a word between them.** On the rack and the fleet
row a row's two refs are a pull request and the goal it delivers, always in that order, and the row
once said so with a muted `delivers` between them. It cost more than it said: the word was the widest
thing in the refs slot, and the group packed to the right, so on a half-width card the pair overflowed
its column to the _left_ and painted the pull request's own token over the reading slot beside it —
`agent on it` read as `ag`. The word is gone, `--cn-w-refs` is wide enough for the two tokens, and the
group is `overflow: hidden` so it can never again spill onto its neighbour. The relation stays in the
goal ref's hover, which is where a sentence belongs.

**And on the grid the group packs from the rule, not from the card's edge.** The order being fixed is
what makes a position mean something, and packing right threw that away: the _first_ reference sat at
a different x on every row depending on whether there was a second, so a column of one kind of thing
drew as a scatter. From the left each reference sits where its own kind always sits; the raggedness
moves to the end of the row, which the card's own border already closes.

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
  modals, a claim's evidence, and an escalation's `detail` — everything on the page an agent wrote.
  The ticket body is the exception, and the section below says why.
- **Captured output stays `<pre>`.** An escalation's `recentOutput` and a draft reply are what the
  process emitted, and preformatted is what they _are_. Markdown-rendering them would reflow columns
  that mean something.
- **A field the operator scans is drawn as one line.** An obstacle's claim is one line by the intake's
  own rule ([27](27-obstacles.md#the-intake)) and clamped in CSS regardless, because free text an agent
  wrote is free text however it was asked for.

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

- **A plan approval's caveats are tick boxes, and Approve is held until they are ticked.**
  `CaveatChecklist` draws what the proposal's action declares (`planCaveatsOf` reads the same row the
  accept route enforces against, so the boxes and the gate cannot disagree), each as a **short label
  with what it is about quietly beneath it** — the label weighted, the detail smaller and behind a hair
  rule, one hairline between boxes. Drawn, not folded behind a disclosure, since a box ticked without
  the thing it is about on the page is the paragraph again; the split of label and detail is what keeps
  four of them a list rather than the wall of prose the checklist replaced
  ([08](08-planning.md#what-the-plan-raises-is-acknowledged-not-merely-rendered)). The header is
  `Tick to approve` and a count. Amber, not red: a caveat is a precondition on the verdict,
  not a fault. The button is **disabled with a hint naming how many are outstanding** rather than left
  to 400 — the route refuses it either way ([08](08-planning.md#what-the-plan-raises-is-acknowledged-not-merely-rendered)),
  and this is that answer where the operator is already looking. Reject, Hold and Close stay live: only
  releasing the work is gated. The same checklist is drawn on the plan sheet, because that is the
  other surface the plan can be released from — and the surface where it has actually been read.
  There it sits **inside the scroll, as the last thing in the caveats section**, not in the decision
  bar: the sheet is one column whose middle scrolls between a fixed head and a fixed decision bar, so
  every line the checklist grew by in the bar came straight out of the plan being read — a plan
  raising several caveats, each with the planner's words under it, left a slot a few lines tall to
  read it in, and capping the checklist only traded that for a scroll inside a scroll. In the
  document it grows downward and costs the plan nothing, and it lands where the rail's `Caveats`
  jump already goes, beside the prose it is asking about. The held Approve stays in the bar with its
  hint naming how many are outstanding, which is what points back up to the boxes.

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

A **plan proposal carries two more arms**, `Close the ticket` and `Hold — stop watching`, set apart
below the two verdicts the way `Dismiss` is — because neither answers the question the card asked.
Approve and Reject are both about the plan, and a rejection sends the goal back to a planner; these
two are about the **ticket**, and they are what an operator reaches for when the plan is fine and the
work is not wanted ([08](08-planning.md#backing-out-of-a-plan)). They post to
[`/api/proposals/:id/back-out`](16-http-api.md#post-apiproposalsidback-out). Close is disabled until
there is text, for the overrule arm's reason and one
more: those words go on somebody else's tracker as the reason the item closed.

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
`health.reasons`, `QueueItem.reason`, `pickup.reasons` and the appraisal summary are quoted, never parsed —
the rule that keeps the cockpit from holding a second opinion about a decision made elsewhere, drawn
inches from the first. The **lenses** that produce them — the work graph (`src/graph/`), `buildStacks`,
`prAttentionStatus` and `overlaps` — stay read-only views out of `src/dispatcher/`, asserted
structurally in `test/workGraph.test.ts`, `test/stacks.test.ts` and `test/prAttention.test.ts`.

### The fleet review's mark

The fourth per-item verdict, and the only one drawn as a **glyph alone**: the review mark
(`web/src/components/ReviewMark.tsx`), one pair of spectacles on a pull request's row and in its
masthead, tinted by what the reviewer said — green `clear`, red `findings`, dashed blue `deciding`,
faint `skipped` and `elsewhere`. It sits left of [the checks mark](#the-checks-mark), so the two
verdicts read in the order the harness produces them.

**`routed` takes no tint, alone among the arms.** It was amber, which in this vocabulary is the
harness stopped and waiting — so a rack of pull requests nobody has got to yet drew an amber box on
every row, and the two rows that had a verdict to report were the quiet ones. Not read _yet_ is the
state every pull request starts in: the glyph is enough to hold the column, and the tint stays for the
marks that are saying something.

**One badge slot on the glyph's shoulder, four meanings** — how many findings, a tick where they have
been dealt with, a dash for a review that will not happen, an arrow for one that happened somewhere
else. A mark drawn _through_ the lenses is mud at 15px; a badge beside them holds at every size a row
uses.

**Findings somebody dealt with take the clear arm's green**, tick and all: `addressed` on the reading,
which is the fleet's own findings threads reading resolved on the provider — the thread it published
into ([07](07-pull-requests.md#what-the-publication-is-recorded-as)), or every thread carrying the
project's declared stamp ([07](07-pull-requests.md#a-thread-the-harness-stamped)), the arm that reaches
a deployment publishing its findings itself rather than through the reviewer agent. The verdict is
unchanged and the findings are still listed — what changes is how loudly the row asks to be looked at,
and a mark that keeps shouting after the thread was resolved is one an operator learns to stop reading.

**The tooltip is a summary; the page is the record.** The heading the `aria-label` carries, what the
reviewer understood the diff to do, its first two findings and when it read — then `and N more` and a
line saying the click opens the whole thing. It used to carry the triage's reason and every finding at
full length, which on a four-finding review ran past the bottom of the window with its own heading
scrolled off the top, inside an element that takes no pointer events and so cannot be scrolled. The
cockpit's own element rather than the browser's `title`, which arrives a second late, cannot be styled
and never arrives at all on a touch screen.

**And the mark is the way there.** On a row it is a `button` onto the pull request's page — where
`ReviewDetail`, from the same module, draws the same record at full length with the triage's reason
and every finding — rather than a span with a click handler, which no keyboard reaches. On that page's
own masthead it stays a plain span: a control that goes where you already are is a dead click. The
console owns the card, the shared component owns the words, so the two surfaces cannot come to word
one record differently.

**It is the exception to `icons.tsx`' rule that an icon never appears without its label**, and it
earns it the way `AgentOnIt` does: a dense rack of pull requests, one recurring subject, the words one
hover away. The checks beside it are a **chip and carry their name**, because they are the reading an
operator has to act on and the one nobody should have to learn. The `aria-label` carries the same sentence the tooltip heads with and the tooltip opens
on keyboard focus, so the glyph is never the only channel. The glyph is deliberately not `eye`, which
already means _watching_ — reading a diff and watching an item are different claims.

Absent where the deployment has no fleet review. → [07](07-pull-requests.md#where-the-operator-sees-it)

### The comments mark

The review threads nobody has answered, drawn as the **speech bubble** with how many on its shoulder
(`web/src/components/CommentsMark.tsx`). Amber, for the reason the cockpit's other ambers are: nothing
is going to happen to this on its own. A thread the harness has already handled is not counted, so a
row wearing this mark is a row with an answer outstanding — `PrComment.handled`, which is
[a record and never an identity](07-pull-requests.md#attribution-is-a-record-never-an-identity).

**It was a `fact` and it was in the wrong grammar.** `comments 1` sat on the row's sub-line beside
`waiting 3d` as though the two were the same kind of thing. They are not: `waiting` says how long
something has been true, and this says somebody asked a question and it is unanswered — a verdict
about the pull request, which is what the three marks beside it are. On the sub-line it also read at a
caption's weight, which is the wrong weight for the one reading on the row that is a person waiting.

**The tooltip quotes whose question it is**, three threads at most, each clamped to two lines. A review
comment is written for somebody reading the diff, so each one is a paragraph; what the mark owes a
reader on a dense rack is _who is waiting_, and the threads themselves are on the page it opens.

### The checks mark

A pull request's CI, drawn as the **flask**, tinted by what the checks said, with a count on its
shoulder where a number is the reading (`web/src/components/CiMark.tsx`). One component on all
four surfaces that draw checks: the overview's rack, the goal page's pull-request card, a plan part
carrying an open PR, and the pull-request page's masthead.

**It replaced a ladder of 6px squares**, one per check the policy classified. Those said all of it in
**hue alone**: no word, no shape between a passing check and a failing one, and their per-check names
only in a native `title` — which arrives a second late, cannot be styled and never arrives at all on a
touch screen. A reader who did not already know what the dots were had nowhere to find out, and a
reader who could not separate the red from the green had nothing at all. On the densest card in the
cockpit that is the most actionable reading on the row, drawn as the least legible thing on it.

**The fold is verdict first, aggregate second**, which is the harness's own order. `ciVerdict`
classifies the **failing** checks and is the only thing that knows which failure is the fleet's to fix
(`dispatch`, red), which is yours (`escalate`, amber — the policy says the harness must not touch it),
and which the operator has muted (`ignored`, grey — the absence of a verdict, which is what a muted
check is). Only where it says nothing does `ciStatus` speak, as `n/n`, `running`, `green` or `red`.

**It was a chip of words before it was a mark**, and the words are the second thing this reading has
spent. `CI 1 failed`, `CI 2 running`, `CI 1 muted` said the obligation outright, which is the bargain
the ladder could not make. What it cost was the rail: a chip of words is the one variable-width thing
on a row of 22px boxes, so it had to be pinned at `--cn-w-ci: 96px` to stop the two marks behind it
moving from row to row — four times its neighbours' width, on the densest card in the cockpit, for one
of the three verdicts a row carries. As a mark it is the same box as
[the review's](#the-fleet-reviews-mark) and [the pack's](31-review-packs.md#on-the-row), and the three
read as one run rather than as a chip with two marks after it.

**What the badge keeps and what it spends.** The hue says which kind of trouble and the number says
how much of it, which is the half a glance uses; the sentence is one hover away, where the two marks
beside it keep theirs. The distinction it does spend is worth naming: **amber is both `for you` and
`stalled`**, which the words told apart and a count does not. Both are the same call — nothing will
happen to this on its own — and `said` separates them in the tooltip and in the accessible name, which
is where the mark's whole reading lives now.

**The glyph is the flask — the test run, not its verdict.** A tick would be a green mark drawn red on
exactly the rows that matter.

**A pending check with nothing in flight is amber, not blue.** `CiCheck.expired` is the
provider saying the last run is stale against the branch and resolves only when somebody queues
another ([07](07-pull-requests.md)); a mark that read as running would be the row promising an
answer that is never coming. Amber, because it is waiting on a person.

**Advisory checks are in no count**, the same silence `ciNeedsAttention` keeps: they are reported for
visibility, nothing acts on them, and a comment policy counted here would hold a pull request at `3/4`
forever.

**Missing detail is not a clean bill of health.** Where the provider named no check the aggregate
speaks under its own name (`CI green`, `CI red`) rather than drawing nothing, and the tooltip says
whether the detail was never reported or **withheld** by an `off` policy mode
([02](02-configuration.md#azuredevopspolicychecks)) — two opposite instructions that would otherwise
look identical on the row. Only `ciStatus: 'unknown'` draws nothing at all: a column of grey chips on a
provider that reports no checks is a claim about a reading nobody took.

**No check name is written in this repository.** Every name in the chip's tooltip comes off
`ciChecks`, and every word about what will happen to a failing one comes off `ciVerdict` — the same
rule the ladder kept, and the reason the browser holds no second copy of the CI policy.

**And the mark is the way there**, on a row: a `button` onto the pull request's page, a plain span on
that page's own masthead, exactly as the review mark is. → `test/ciMark.test.ts`

### The tooltip the marks share

All three marks draw the cockpit's own hover card (`web/src/components/tip.tsx`) rather than the browser's
`title`, and it is **one module rather than one per mark**. The placement is measured rather than
declared — fixed to the window, from the anchor's left edge unless that would leave it, below unless
there is no room below — and every line of it is a bug somebody has already had: the marks sit in a
rack hard against the right edge of the window and in a masthead a few pixels under its top, so a
second copy is a second chance for one of them to be positioned against the wrong edge.

**It is portalled to the body**, which `position: fixed` alone does not achieve: a closed pull
request's row carries `opacity: .55`, which is a stacking context, so the card was positioned against
the row rather than the window, painted under the rail's cards, and dimmed to 55% along with the rest
of the row.

**It opens on keyboard focus as well as hover**, which is what buys the glyph marks their exception to
`icons.tsx`' rule that an icon never appears without its label, and what makes the reading reachable
on a touch screen at all. It takes no pointer events — a tooltip that can be hovered is a tooltip that
flickers — so anything a pointer has to reach belongs on the page the mark opens, never in here.

## What ships and nothing draws

Stated rather than left to be discovered, because a snapshot field with no reader is indistinguishable
from a reader that broke, and because each of these is a decision rather than an omission:

- **`CockpitActions.setStackLanding` has no caller.** The console draws pull requests as a **flat
  rack** — one row per open PR, ordered by the server, with the court chip and the checks mark — and not
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
- **`plan.statusCommentRef` and `issue.appraisal.commentRef` are drawn nowhere.** Both are canonical comment
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
publishes improvements as pull requests. Every goal, pull request, plan, claim, transcript and spend
row in `fixtures.ts` and `demoBackend.ts` is work on that one codebase, with its real file paths and its
real vocabulary. The theme is load-bearing rather than decorative: an operator meeting the cockpit for
the first time is trying to follow one story across nine panels, and a fixture set drawn from three
unrelated products reads to them as a console that is showing them noise. A new fixture joins that story
or it does not go in.

**Every pickup status has a goal in the fixtures.** `issuePickupStatus` answers thirteen ways
([06](06-issue-pickup.md)), and each answer is somebody's whole explanation of why nothing is happening
to their ticket — so `done`, `retained`, `has_pr`, `active`, `container`, `unwatched`, `planning`,
`delivered`, `appraisal`, `cooldown`, `escalated`, `blocked` and `eligible` are each carried by at least
one issue, with the reason string the real gate would have written. A demo showing eight of them
teaches an operator that the rest are a bug on the day they first appear. The roll-call is
stated in a comment above the `issues` array, and the arithmetic around it has to hold as well: the cap
is 3 with two agents live, so exactly one goal is `eligible` and the rest of the ready ones are
`blocked` — a world with six eligible goals under a cap of three is one the dispatcher could not have
produced. Eleven of the thirteen are reachable by clicking, through the Twelve of the thirteen are reachable by clicking — eleven through the tickets tab's watch filter,
and `retained` from the overview, whose goals-in-flight card lists a retained run beside the live goals
while work is still on it and the rest behind its `kept` disclosure; `done` is
carried without being listed anywhere, because no surface lists a closed goal the harness holds no run
for — it is still a reading the wire ships and the goal page draws.

**Every state a check can be in has a check in the fixtures.** Goal #395 carries ten, for the reason
the pickup roll-call carries thirteen: `passed`, `failed`, `waived`, `deferred` and `unrun` are each
weighted differently on the card ([Validation on the goal](#validation-on-the-goal)), and a weighting
is not a thing anybody can judge from a demo that only ever shows two of them. The three readings that
are not a pass are the ones a demo would otherwise never reach — recording one needs a note, and a note
needs somebody to type it — and the withdrawn check is there because nothing in the cockpit amends a
plan, so the fold that lists what an amendment dropped would never draw at all. The same fixture set
carries every marker for _who_ ran a check: by hand, by the fleet, from a desktop session, claimed by
one right now, handed back, and amended out from under a reading.

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

Eleven files, split on what they can see:

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
  matching the value it is declared with, every preset — and paper — answering every literal, and the
  two [field](#fields) guards: that the base's type exclusions stay inside `:where()` where they cost
  no specificity, and that `accent-color` is only ever declared on a container.
- `test/insightExport.test.ts` — the [exports](#exporting-a-reading): the CSV quoting, the sections and
  their order, that figures leave unrounded, and that each caveat the panel speaks leaves as a row.
- `test/markdown.test.ts` and `test/richText.test.ts` — the two prose renderers, and the line between
  them: agent-authored markdown never interprets HTML, tracker-authored HTML is drawn as structure.
- `test/refLinks.test.ts` — [Links](#links): where each family of ref goes, that a goal with no page
  links out instead, that an unresolvable ref is plain text, that `refLabel` is the only shortener, and
  — structurally, over the rendered console — that no reference is ever drawn inside a button.
- `test/reviewPackPage.test.ts` — [the review pack](#the-review-pack): the derivations, and on the
  rendered page the masthead-gate-ideas order, the flag on a collapsed row, the false claim at the top
  of its idea, the three standings and three currencies each drawn as themselves, the unknown schema
  refused whole, and the renderer's schema number pinned to the harness's.

The renders are wrapped in a **clock pin**, because `buildDemoState` stamps every timestamp relative to
`Date.now()` and the rendered relative times would drift between runs otherwise.

`test/console.test.ts` holds the three structural assertions the layer split rests on — nothing under
`console/` imports `api.js`, `console.css` never targets a shared component's class, and it reaches no
form control through `.cn` either, which is [the same rule](#fields) at the one selector shape that
gets past naming a class — and pins the
renders where being wrong would be worse than being absent: the rail carrying every blocking kind in one
list, its array order surviving the grouping, the holding count agreeing with its noun, an empty queue
muting rather than removing the rail, a group with no rows drawing no heading, a row with a goal being a
button and the recovery hold not, the ask drawn above the plan, a goal with no ask drawing no band, the
goal page answering through the shared card, a held part quoting the reconciler, a retired plan drawing
what it proposed rather than only saying it has no live parts, an HTML ticket drawn as HTML, a goal with
no measured spend drawing no `$0.00`, the overview's five cards, the environments chip drawing only where something is not well, an empty rack still drawing, the
the intake hold arriving on the rail rather than on the tickets tab, that tab's rows being ways into
their goals and its container cascade, the fault
log keeping its clear at zero, a panel's two ways out, the demo gate on injection, the precedence
between a goal and whichever tab the nav is on, all three tabs appearing in the nav (a destination added
to `ConsoleTab` and forgotten there is a view nothing can reach) and `Work` appearing in none of them,
the work graph reachable from the bar at every tab and over an open goal, the tickets tab mounting the
unrecorded-work call-out and drawing nothing when it has nothing, the recovery banner outside the
situation area, a dropped socket drawing nothing at all, and the shell rendering the drawer the console
only asks for — and no longer the work graph.

## Setup

The harness's own configuration is **rows on the Needs you rail**, not a surface of its own. It used
to be three: a reading in the top bar, a first-run card on the Overview, and a panel. All three are
gone, and the reason is the failure they made together — the bar counted outstanding checks and
opened a screen that showed none of them, while each check's remedy was a sentence with no control
attached. A count that opens the wrong surface is worse than no count.

A config row is `config` (red) or `config_gap` (amber), always in `yours` rather than `blocking`
(nothing is parked on a worktree, whatever else is stopped), and carries no age — the reading is
fetched, not stamped. Its **body** is the control that opens the key on the config page; its **fix**
sits in a strip beneath, because a control may not nest inside a control and the fix is a shortcut
past the config page rather than the only road to it.

The one screen left is the **confirm sheet** that points the fleet at a project, reached from the
`pointed` row. It is a modal and deliberately _not_ on `Place`: restoring it on a reload would restore
a review of answers the reload has already dropped. Same exception, and the same reason, as
`ReviewWrite`'s on the config page.

→ [26](26-setup.md)
