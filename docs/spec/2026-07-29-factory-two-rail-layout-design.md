# Design: the act rail dissolves into the header

Follows [`2026-07-27-factory-wide-layout-design.md`](2026-07-27-factory-wide-layout-design.md),
which gave the factory skin three rails split on _whose turn it is_. This one deletes the
first of them.

## The problem

The act rail was the right idea about **prominence** and the wrong one about **cost**. Its
five panels answer "is anything waiting on me", and four of the five answer it with a
number: how many escalations, how many faults, how many blueprints queued. A permanent
26rem column — 19% of a 2200px display, more of a laptop — spent standing by to render
counts that are usually zero is the wrong trade, and the operator's own reading was that
they never used two of the panels in it at all.

Two of the five had a second problem. **Blueprints** carried a demo-only injection panel
beside a control the operator does use, and **Faults** sat at the foot of a rail with the
one thing that pointed at it — the alert bay's `see the fault log at the foot of the floor`
line — being dead text on a disabled button. A panel nothing can navigate to is a panel
nobody reads.

## What ships

The act rail is deleted. Its five panels go five different places, and the floor drops to
two rails.

| today (act rail)    | new home                                           |
| ------------------- | -------------------------------------------------- |
| `RecoveryPanel`     | full-bleed banner between the status bar and rails |
| `AlertBay`          | **deleted** — replaced by a header gauge           |
| Awaiting Your Stamp | the **Alerts** modal                               |
| Blueprints          | the **Blueprints** modal                           |
| Faults              | the **Faults** modal                               |

## The five decisions

### 1. A count belongs in the header; the thing it counts belongs behind a click

This is the whole argument. Three of the act rail's panels are read as a number far more
often than they are read as contents, and a number is a gauge. So each becomes a gauge in
the status bar carrying the count, and the panel it summarises opens from it as a modal.

The alternative — the strip of one-line alert boxes the rail already drew, hoisted to a
full-width header row — was considered first and refused. It is the same vertical cost
moved, it duplicates the panel below it (the bay was a _summary_ of the escalations the
Stamp panel then listed in full), and at zero alerts it either draws an empty strip or the
page reflows as alerts arrive.

**Consequently `AlertBay` is deleted outright** rather than relocated. Its job was to make
an alert visible without scrolling; a red count in the status bar does that in a tenth of
the space, and the modal it opens is the real inbox rather than a summary of one. The tone
split it carried (crit for a permission request or an idle bot, warn for something merely
awaiting a stamp) is **not** preserved: the skin's stated rule is that red means exactly
one thing — an agent parked on a question only you can answer — and that is true of every
open escalation. One reading, not two.

### 2. A gauge that opens something must look like it does

The existing gauges are deliberately inert: `Scan`, `Power` and `Bots` are readings, and
nothing happens when you press them. Three of them now navigate, and the operator's report
on the first attempt was that they could not see it. So the clickable ones are a distinct
`.fx-act` variant — a real `<button>` with card chrome, a hover lift, a pointer cursor and
a trailing chevron — rather than an `onClick` bolted to a `<div>` that looks like its inert
neighbours.

Icons are distinct per gauge, which is what makes three adjacent buttons legible at a
glance: `alert` for alerts, `blueprint` for blueprints, and `gear` for faults — the one
glyph in the sprite sheet nothing else uses, so a fault is not also saying "production"
the way a second `lamp` would.

**Faults stays clickable at zero**, muted rather than hidden. It is the only way to the
fault log, and the log carries the two-step `clear` — a control that must not become
unreachable by the log happening to be empty. Alerts and Blueprints go quiet the same way
for consistency, and because a gauge that vanishes makes the bar reflow.

### 3. One modal state, not one boolean per modal

There are four modals now (production, alerts, faults, blueprints) where there was one.
Four booleans admit sixteen states, fifteen of which are wrong, and two modals open at
once is not a thing this floor can draw. So `FactoryRoot` holds a single
`'production' | 'alerts' | 'faults' | 'blueprints' | null`.

### 4. Recovery leaves the grid rather than moving inside it

Recovery is a **banner, not a panel** — while it is up no pulse runs at all, so every other
surface on the page is stale for the same reason and one card among the rails would leave
an operator hunting for why their fleet is frozen. It was already full-bleed
(`grid-column: 1 / -1`) at every dissolved width, which is a grid item pretending not to be
one.

It becomes a direct child of `.fx` above `.fx-rails`, so it is a block-level banner at
every width and a flex child of the railed column at ≥1900. The `grid-column` and `order`
rules that made it span go away entirely — there is no grid to span.

### 5. Two rails, and the breakpoints do not move

`floor` (fluid) and `world` (fixed) survive unchanged in contents. At ≥1900 the tracks
become `minmax(0, 1fr) 26rem`, widening to `30rem` at 2400; the floor rail still goes
two-abreast at ≥2000. Below 1900 the dissolved arrangements lose `stamp`, `blueprints` and
`faults` from their spans, their `order` chain, and (in the tiled band) the `max-height`
that stopped two of them running away vertically.

No breakpoint changes value. The arrangement bands are still stated once, in CSS, for the
reason the previous design gives: matching them in React is a second definition bought with
a resize listener.

## Costs, stated

- **Escalations are behind a click.** The red count is what says to click; that is the
  trade for the width. An operator who wants the inbox permanently visible has lost that.
- **The status bar is now the only way into four surfaces.** It already carried nine
  things. If it wraps badly at a narrow width the entire act half becomes hard to reach,
  which is a failure mode the three-rail layout did not have — so the width sweep checks
  the bar, not only the rails.
- **The summary reading is gone.** `AlertBay` named which bay each alert came off in one
  line without scrolling. That now costs a click.
- **Demo injection is one level deeper.** It stays `view.demo`-gated and moves inside the
  Blueprints modal, so the public demo is still interactive, but the floor no longer offers
  it in the open.

## Out of scope

The classic skin. Anything a panel _contains_: `EscalationCard`, `LaunchPanel`,
`InjectPanel`, `RecoveryPanel` and `FindingsPanel` are re-placed and otherwise untouched,
and no refusal rule, gate or snapshot field changes. The Faults list cap rises from 8 —
that was a rail-sized crop, and a modal is the surface you went looking for — which is the
one content change, and it changes no behaviour.

**The shell's `work-panel` is not rehomed**, and the reason is a seam rather than a
preference: `WorkTreePanel` hangs off `App.tsx` because it fetches on open, and a skin may
not reach `api.js`. So a factory gauge structurally cannot open it. This has a consequence
for the invariant below.

## Testing

`web/` carries no render tests, so this is verified the way the two previous factory layout
changes were: `npm run check` for the refactor, then the demo build (`npm run web:dev:demo`)
driven at 3440×1440, 2560×1440, 1600×1000, 1100×1000 and 820×1000, asserting at each that

- the expected arrangement engages (`.fx-rail`'s computed `display`, and the track count),
- nothing overflows horizontally,
- the console is clean,
- **`.fx` height equals the viewport height at ≥1900** — restated from the previous
  design's "the page height equals the viewport height", which has been false since
  `work-panel` was added to the shell and was not caught because nothing asserted it. The
  floor filling the screen is the property the railed arrangement is _for_; shared shell
  content below it is a second screen by design, and clipping it to keep a rounder number
  would delete the work tree and the prompt book from the page.
- every gauge opens its modal, and Escape and the backdrop close it.
