# Factory Floor — the Factorio pass

Design for a visual revision of the `factory` cockpit skin. Mockup:
<https://claude.ai/code/artifact/8e476de0-76fb-4fa1-9df7-609e5370b5fe>

## The problem

The skin borrows Factorio's _chrome_ — square corners, a 1px light/dark bevel, a condensed
display face, `#ff9c1a` — and almost none of its **vocabulary of signs**. Factorio conveys
state through a small set of conventions a player reads without thinking; the skin
re-invents each one as a caption, and then has to draw the caption at full weight because
it is the only carrier.

Three consequences, all visible on a one-agent floor:

- **The visual budget is inverted.** The belt is the largest and most saturated object on
  screen and animates at full width while carrying nothing (`0 on the belt`). The Line's
  stage is ~1970px wide with bays ending at ~480px. Three of five Goal Floor machines are
  `unbuilt` ghosts drawn at the same size and ink as the two that are live.
- **Zero-count gauges read as one dead band.** `ALERTS FAULTS FINDINGS QUEUED`, all at `0`,
  all identical, occupy the same pixels whether or not anything is wrong.
- **Everything is one warm value.** `--panel: #2a2827` on `--bg: #1c1b1a` with
  `--accent: #ff9c1a` is warm-on-warm; Factorio's orange sits against a cool grey-slate,
  which is most of why the skin reads "generic industrial dark" rather than like the game.

Nothing here is a behaviour bug. Every verdict the skin draws is correct and computed
server-side; this is entirely about how those verdicts are rendered.

## Scope

**In:** `web/src/skins/factory/**` and the token block at `:root[data-skin='factory']` in
`skin.css`. Presentation only.

**Out:** any change to a dispatcher rule, a store schema, an API payload, or a shared
component's own CSS. No new fields on `/api/state`. The `classic` skin is untouched, and
`test/fixtures/classic-markup.html` — a byte-exact golden — must not move.

**A note on the token block.** Per `skin.css`'s own header, the tokens under
`:root[data-skin='factory']` are the _shared_ components' only styling contract: the
drawer, the escalation card, recovery and the plan panel are tinted through them. So the
palette shift in §8 re-tints those four panels for free — and equally, they are where a
bad value shows up first, so they are checked as part of that change, not after it.

## The eight changes

### 1. Status lamps

Every bay, crate, Goal Floor machine and PR row gains a small square lamp — the indicator
Factorio puts on the lower-left of every entity. Green working, yellow idle, orange your
turn, red stopped, dark off.

The seam already exists: `MachineStatus { word, tone }` and `toneColor(tone)` in
`vocabulary.ts` are exactly a caption plus a colour, and every machine on the floor already
routes through them. The lamp is a second renderer of `tone`; **no new status vocabulary is
introduced**, and no caller learns a new type.

What changes alongside it: `word` drops to ~9.5px at reduced opacity. That is the actual
win. Today `UNBUILT` / `NO RECIPE` / `NOT YET BUILT` are set at the same weight as the live
machines' status, so the eye is drawn to the three things that are _not_ happening. With a
lamp carrying the state, the caption becomes confirmation rather than the signal.

**Must not break:** the caption is demoted, never removed — it is the accessible reading and
the only one that survives `prefers-contrast` or a colourblind operator. Lamps are additive.

### 2. Alt mode

Holding <kbd>Alt</kbd> floats an overlay tag over every entity carrying its origin, branch,
rule id and spend — Factorio's alt-mode, which shows recipe icons over machines. Releasing
it returns the floor to lamps and titles.

This is the answer to label density, and it is why §1 can demote captions without losing
information: the detail is one key away rather than deleted. The `.fx` markup already
renders `issue:203:plan` and `plan/issue/203` inline on every bay; those move under Alt.

Three properties:

- **Held, not toggled**, matching the game. A click on the corner badge toggles it for
  keyboards where Alt is spoken for, and `blur` clears it so the overlay cannot get stuck
  on when focus leaves the window.
- **Alt is preventDefault'd** while the cockpit has focus, or the browser menu bar steals it.
- **The overlay adds nothing that isn't already in the DOM.** It is a display switch over
  values the skin already has, so there is no fetch, no snapshot key and no way for it to
  disagree with the row it sits on.

**Cascade hazard, found while building the mockup and worth writing down:** `.alt-tag`'s
`display: flex` and `.alt-only`'s `display: none` are both single-class selectors, so source
order alone decides. Declared in the wrong order the overlay is permanently open. `.alt-tag`
must be declared first and switched on only by `body.alt`.

### 3. Belt tiers, and an empty belt that collapses

Queue pressure drives the belt's colour through the game's own speed hierarchy — yellow,
red, blue — and an empty belt goes still, dark, and collapses from 62px to a 22px rail
reading `belt clear`.

The tier thresholds are a function of the queue length against the cap, computed in
`production.ts` or beside the existing belt constants in `TheLine.tsx`; they are presentation
and belong nowhere near `DISPATCH_RULES`.

**Must not break:** `test/factorySkin.test.ts` already asserts the belt animates only while
cycles run (paused or held on recovery stops it). Collapsing adds a second reason for a
still belt and must not weaken that assertion — a paused belt with items on it is still full
height and still stopped.

### 4. Bot flight on dispatch

A dispatch animates: a bot leaves the roboport, takes the crate off the belt, and flies it
into the bay that just filled. The floor already draws the roboport, the flight paths and
`inserterPhase`; this is the payload the paths never carried.

It rides on the existing `inserterPhase(agent, now, intervalMs)` window rather than a new
timer, so a dispatch that happened between polls does not animate — which is correct. The
animation is decoration over a transition that has already occurred; nothing waits on it,
and under `prefers-reduced-motion` the bay simply fills.

### 5. Radar sweep for the pulse

`SCAN 55s` becomes a small rotating radar sweep with the digits demoted beside it. Factorio's
radar literally sweeps. The animation is driven off `heartbeatIntervalMs` and **stalls** when
the harness is paused or held on recovery, which gives that state a peripheral signal it does
not currently have — today a held pulse is a word in a panel.

The digits stay. A countdown you can read is worth keeping; it is the _prominence_ that was
wrong, not the number.

### 6. Alerts appear rather than persist

A zero-count gauge is not drawn at all. When every count is zero the cluster reads `all clear`
in one place. A non-zero count draws its chip: needs-you warm orange with a hand icon, a fault
red and blinking.

This is the `capped` / `unapproved` argument from `QueueItem` pointed at the status bar: an
invisible condition and a visible zero are different failures, and four permanent zeros make
the one chip that _does_ light up harder to see, not easier.

**Must not break:** the desks these gauges open (`Desks.tsx` — stamp, fault log, findings,
blueprint) must stay reachable when their count is zero. An empty findings desk is a thing an
operator opens deliberately. So the cluster keeps one always-present affordance — the
`all clear` reading is itself the control that opens the desk drawer.

### 7. Named marks on a PR row that is not green

**This is the change the existing code most constrains, and the mockup over-reached on it.**

`Ladder` in `Inspection.tsx` draws `scannersFor(pr)` as abstract cells sharing a fixed track,
with the detail on hover. Its comment gives the reason: the cells share their track so a big
CI matrix cannot push the human gates out of column, and the strip stays readable _downward_
across rows. Replacing the ladder with labelled chips — which is what the mockup drew — would
destroy both properties on any repository with more than a handful of checks.

So the ladder stays. What is added: a row whose court is **not** green gains **at most two**
named marks, derived from the same `Scanner[]` / `MergeGate[]` the ladder already folds — the
blocking condition in words, with the game's status-icon glyph (warning triangle, speech
bubble, down-arrows, cross, chain-link for a stacked PR). A green row gains nothing.

That keeps the invariant the ladder exists for — the marks are bounded at two, so column
alignment is unaffected — while making the one thing an operator wants from a stuck row
legible without a hover. No new derivation: if a condition cannot be named from the existing
verdict, it does not get a mark.

**One tone change, using a tone that already exists.** `prCourt` returns tone `bad` (red) for
`Your call`. Red is the fault colour everywhere else on the floor, and "the harness is asking
you a question" is not a fault. It becomes `next`, which `toneColor` already maps to
`var(--accent)`. One line, and it is the change that makes §6's warm needs-you chip agree with
the row it counts.

### 8. Cool-shift the palette

`--bg`, `--panel`, `--panel-2`, `--border`, `--well` and the two bevel tokens move from warm
brown to cool grey-slate. `--accent` does not move. The orange is meant to be the only warm
thing in the frame; today it competes with the ground.

Roughly eight token edits, and the cheapest change here by a wide margin. Values are sampled
from Factorio's own UI rather than eyeballed, and checked in the four shared panels the token
block tints (see §Scope).

**Must not break:** contrast. `--muted` and `--dim` against the new `--panel` need re-checking,
not assuming — a cooler ground is usually darker in perceived value and the two greys were
picked against the warm one.

## Rejected alternatives

**Fold the marks into the ladder cells (§7).** Wider cells with inline labels reads better on
a three-check repo and falls apart on a thirty-check one. The bounded-two-marks form is worse
in the small case and survives the large one.

**Derive belt tier from dispatch rate rather than queue length (§3).** Rate is a better model
of "pressure" and is unreadable: the operator cannot see the rate, so the colour would change
for reasons nothing on screen explains. Queue length is visible in the same panel.

**A third skin rather than a revision.** The before/after switch is a device for _reviewing_
this proposal, not a feature. Shipping it would mean maintaining the warm palette forever and
doubling the surface `test/factorySkin.test.ts` covers, to preserve a look nobody chose on
purpose.

**Sprite art.** The icons are thin line glyphs where Factorio is chunky shaded pixel art, and
this is the other half of "why doesn't it feel like the game". It is deliberately **not** in
this design: it is a different kind of work (asset production, licensing questions, a sprite
pipeline) and none of the eight changes above depend on it. Worth its own spec later.

## Testing

`test/factorySkin.test.ts` is the home for all of it; it already asserts skin behaviour
structurally rather than by snapshot, which is what makes these changes testable at all.

- **Pure functions get unit tests**: the tier threshold, the mark selection (a green row
  yields none; a row with four conditions yields two), the `prCourt` tone change.
- **Structural assertions for the properties that must survive**: the belt animates only
  while cycles run (existing, extended for the collapsed case); the ladder's cell count still
  equals `scannersFor(pr).length` regardless of marks; a demoted caption is still present in
  the markup.
- **The Alt overlay renders no value not already on the row** — asserted by rendering with
  and without the class and diffing the text content against the source data, so the overlay
  cannot become a second source.
- `test/cockpitSkins.test.ts` and `test/fixtures/classic-markup.html` must pass unchanged.
  If the golden moves, the change leaked into shared markup and is wrong.

## Order of work

Sequenced so each step is independently viewable against live data and independently
revertable:

1. **Palette (§8)** — smallest, touches only tokens, and every later step is judged against
   the ground it establishes.
2. **Lamps + caption demotion (§1)** and the `prCourt` tone (§7, second half) — the largest
   read change, and it is what makes the rest legible.
3. **Alerts (§6)** and **radar (§5)** — status bar, independent of the floor.
4. **Belt tiers and collapse (§3)**.
5. **Named marks (§7, first half)** — the most constrained, done once the tone work is in.
6. **Alt mode (§2)** — last, because it removes inline detail and should only do so once
   everything it hides has a lamp carrying its state.
7. **Bot flight (§4)** — pure decoration, safe to land or drop at any point.

`docs/spec/17-cockpit.md` is updated in the same change as the step that alters what it
describes, per `CLAUDE.md`. `npm run check` after each step.
