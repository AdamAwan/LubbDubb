# Design: the factory floor stops being a ribbon

## The problem

The factory skin is `max-width: 1240px`, centred. On a 3440×1440 ultrawide that is
**36% of the width** carrying a **4127px page** — 2.9 screens of scroll — with the rest
of the display empty. Three separate costs, all measured against the demo fixtures:

- **Scroll.** Nine full-width bands stacked vertically. Faults and Signals, which an
  operator checks constantly, sit at the very bottom.
- **Wasted width.** A thin ribbon floating in background breaks the floor illusion the
  skin exists for.
- **Wrong prominence.** The vertical order is the order the panels were written in, not
  the order they are read in.

Classic has the same shape and is not in scope; this is the factory skin's layout only.

## What ships

**One skin, three arrangements chosen by width alone** — no new skin id, no picker entry,
no operator toggle, no JavaScript. The operator's laptop and their ultrawide are the same
build in the same session.

| width       | arrangement       | shape                                                            |
| ----------- | ----------------- | ---------------------------------------------------------------- |
| < 940px     | ribbon, 1 column  | today's narrow behaviour                                         |
| 940 – 1499  | ribbon, 2 columns | today's behaviour                                                |
| 1500 – 1899 | **Tiled Floor**   | one 4-column page grid; each panel a tile with a span            |
| ≥ 1900      | **Control Room**  | three rails, each scrolling on its own; the page does not scroll |

Four tracks in the tiled band rather than six: the band tops out at 1899px, where six
would leave a span-1 tile ~250px wide — narrower than the same panel gets in the plain
two-column layout below it.

Measured on the demo fixtures: 3440×1440 and 2560×1440 both go from a ~4100px page to
**exactly one viewport**. A 1600×1000 window goes to 3095px with no horizontal overflow.

## The three decisions

### 1. Panels are named once; an arrangement only says where they go

`FactoryRoot` binds every panel to a `const` (`line`, `production`, `bots`, `stamp`,
`launches`, `workOrders`, `research`, `yard`, `shiftLog`, `signals`, `faults`,
`offBlueprint`, `alerts`, `recovery`) and then places them. This is what made three
candidate layouts cheap to build and compare, and it is what keeps a future fourth cheap.
A panel's _contents_ and a panel's _position_ stop being the same edit.

### 2. One DOM for all four widths — the rails dissolve rather than being re-rendered

The rail wrappers are always in the DOM. Below 1900px `.fx-rail` is `display: contents`,
so its panels fall through and become children of `.fx-rails` directly — which is then a
1-, 2-, or 4-column grid depending on width.

The alternative is matching the media query in React and rendering a different tree. That
buys nothing and costs a resize listener, a re-render on drag, and a second definition of
where the breakpoint is. **The breakpoint must be stated once, in CSS**, or the two
definitions will disagree the first time either moves.

The consequence is that the rails' document order is not the narrow reading order — the
act rail comes before the floor rail. So the narrow and tiled arrangements set `order`
per panel, restoring exactly today's shipped reading order (line → production → bots →
stamp → …). `order` is reset to `0` inside a rail at ≥1900, or those same values would
reshuffle each rail internally.

### 3. Full-bleed SVG panels get a width cap, and that is not optional

The rejected "just widen it" option exposed this: The Line and Production scale with
their container, so at 2600px Production becomes a ~500px-tall chart that eats the entire
first screen. **Widening without capping these makes the skin worse, not better.** Under
the tiled and railed arrangements they are constrained by their span, which is why the
problem does not arise there — but the cap is stated explicitly rather than left as a
property of the current spans.

## Rails: what goes where

Three rails, split on **whose turn it is**, not on subject matter:

- **Act** (left, fixed width): recovery, alerts, awaiting your stamp, work orders, faults.
  Everything the operator is the blocker for. A glance answers "is anything waiting on me"
  without moving.
- **Floor** (centre, fluid): the line, production, bots, research, the yard, off-blueprint.
  What the harness is doing. Widest because the line is the widest picture.
- **World** (right, fixed width): launches, signals, shift log. What the outside is doing
  back.

Each rail is `overflow-y: auto` with `overscroll-behavior: contain`. At ≥2400px the act and
world rails widen (26rem → 30rem); at ≥2000px the floor rail goes two-abreast, with the
line and the yard spanning both.

## Costs, stated

- **Reading order is no longer top-to-bottom.** An operator learns where things live. This
  is the trade for a glanceable wall and is the point, not a side-effect.
- **Panels scroll out of their rail.** A rail of 2100px content in 1330px of viewport still
  scrolls — but it scrolls _by itself_, so reading the yard does not move the alerts.
- **Row gaps in the tiled arrangement.** Grid rows align to the tallest tile, so a short
  tile leaves space under it. Accepted at 1500–1900px; the railed arrangement above it does
  not have the problem.
- **No operator escape hatch.** A width toggle was considered and refused: it is a second
  definition of the breakpoint, in a second place, that the operator has to maintain. If
  the automatic choice turns out wrong at some width, the fix is the breakpoint.

## Out of scope

The classic skin's layout. Any change to what a panel _contains_, to any refusal rule, or
to a shared component (the escalation card, findings, recovery, the drawer, the world
summary) — those stay exactly as they are and are only re-placed.

## Testing

`web/` carries no render tests, so this is verified the way the mockups were: the demo
build (`npm run web:dev:demo`) driven at 3440×1440, 2560×1440, 1600×1000, 1100×1000 and
820×1000, asserting at each that the expected arrangement engages (`.fx-rail`'s computed
`display`), that nothing overflows horizontally, that the console is clean, and that the
page height equals the viewport height at ≥1900px. `npm run check` covers the
`FactoryRoot` refactor and passes (887 tests).

That sweep earned its keep immediately: it caught `align-items: start` — correct for a
tile, wrong for a rail — leaving the railed page 2238px tall instead of 1440. The
symptom is invisible in any single screenshot, which is why the page-height assertion is
part of the check rather than a look.
