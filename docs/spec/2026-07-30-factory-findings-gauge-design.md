# Design: findings becomes the fourth gauge

Follows [`2026-07-29-factory-two-rail-layout-design.md`](2026-07-29-factory-two-rail-layout-design.md),
which deleted the act rail by turning three of its panels into status-bar gauges. This one
applies the same rule to the panel that rail never held.

## The problem

`Off-Blueprint` — the findings list and the file-overlap list — stood in the floor rail as a
full panel, and it is read exactly the way the three that just left were: as a **count**. Most
of the time the count is zero, and the panel rendered nothing at all in that case
(`findings.length > 0 || overlaps.length > 0`), so its contribution to the floor alternated
between a column of cards and an absence. An absence is not a reading: at zero there was
nothing to say nothing was wrong, and at one the rail reflowed.

It also sat in the wrong rail. The floor rail is _what the harness is doing_; a finding is
something **nobody** is doing, and every transition on one is the operator's click — nothing in
the dispatcher reads `findings`. That makes it a desk, which is the category the previous design
named and then left one member short.

## What ships

A fourth `.fx-act` gauge in the status bar, and the panel becomes a modal — renamed `Findings`,
for the reason in decision 4.

| today                        | new home                                 |
| ---------------------------- | ---------------------------------------- |
| `[data-fx='off-blueprint']`  | the **Findings** modal                   |
| the panel's conditional head | the gauge, which is drawn at every count |

## The four decisions

### 1. Its own gauge, not a fold into Blueprints

The first shape considered was hanging it off the existing `Queued` gauge — one drawer for
"blueprints, and things that are not on one" — and it was refused because the two are read for
opposite reasons. `Queued` answers _is the fleet going to get to my job_, which is a question
about capacity; off-blueprint answers _is there something here nobody has decided about_. Folded
together the number means neither, and a queued blueprint clearing would mask a finding
arriving.

The icon is `chest`, which the panel already wore, so the glyph is unchanged by the move. It
keeps the four adjacent buttons distinct, which is the rule section 2 of the previous design
states.

### 2. The count is open findings, and nothing else

A finding that was promoted, filed or dismissed is **done**. A `filing` one is **decided** — an
agent is creating the ticket — and the operator is not the blocker for it, so it drops off the
face the moment the click lands rather than lingering until the ticket exists.

**Overlaps are excluded from the count and kept in the panel.** Nothing actions an overlap: it
is diagnostic, deliberately after-the-fact, and there is no button on it here or anywhere else.
The gauge's whole claim is that pressing it leads to a decision, so a number a click cannot move
would be the `see the fault log at the foot of the floor` dead-end in a new place. They stay in
the desk because they answer the same question the findings do — what is going on that no rule
accounts for.

**Amber, never red.** The skin's rule is unchanged and predates this: red means an agent is
parked on a question only you can answer. A finding is something a bot noticed on its way past,
not something it is stuck on.

### 3. Muted at zero, never removed

The previous design's rule, applied unchanged: a gauge that vanishes reflows the bar every time
its number leaves zero, and this is the only way to the desk. `FindingsPanel` already carries
its own empty line, so the modal says something at zero rather than being blank.

### 4. It is renamed to `Findings`, and the width is why the question came up

`Off-blueprint` was kept as the label first, on the grounds that it is what the panel was
called. The width sweep refused it: at 170px against 121px for `Alerts` / `Faults` / `Queued` it
moved the bar's wrap point from ~1453px to ~1639px, so a 1600px laptop wrapped the skin picker to
a second row — which is precisely the failure the previous design spent ~260px of duplicate
readings to remove. A fourth gauge costs width whatever it is called; the label is the part that
was negotiable.

`Findings` is the choice rather than a mere abbreviation because it is **already the harness's
word** for these: the `findings` table, the `report_finding` tool, the shared `FindingsPanel`
this desk places. So the rename removes a second name for one subject rather than adding one —
there is now one word from the tool call an agent makes to the number on the gauge.
`Off-Blueprint` survives only as history in the module headers.

**It does not buy the wrap back, and that is stated rather than glossed.** The label went 170px →
135px; the bar needs 1603px of content with all five gauges, the ident and the skin picker, and
the page gives it `viewport − 51px`. So it is one row above ~1654px and two rows below — ~1616px
without the demo chip, which is 38px of the measurement and absent from a real cockpit. A fourth
gauge costs more than any label can give back; what the rename bought is 35px of that and one
name for one subject.

The overlap list keeps riding along under that name. It is not literally a finding, but it
answers the same question — what is going on that no rule accounts for — and the panel's
`nothing schedules these` note is the honest description of both.

## Costs, stated

- **The findings list is behind a click.** The amber count is what says to click; that is the
  trade, and it is the same one alerts took.
- **An overlap is now two clicks from the floor and contributes no number.** Two agents editing
  one file is arguably the most urgent thing in the drawer, and it is the one thing in there with
  nothing to press — so it is the one thing the face cannot advertise. This is the honest
  consequence of tying the count to actionability rather than to severity.
- **The bar carries a fourth act gauge, and wraps to two rows below ~1654px** (58px → 93px tall).
  Nothing becomes unreachable — every gauge is still there and still pressable — but the
  single-row bar the previous design bought back is a ≥1654px property now rather than a ≥1500px
  one. The previous fix for this was removing duplicate readings, and there are none left to
  remove: the one remaining repetition in the bar is the skin's name, which is both the ident's
  `<h1>` and the selected value of the picker beside it. Collapsing that is a separate change to
  the page's heading, not a side-effect of adding a gauge, so it is noted here and not taken.

## Out of scope

`FindingsPanel` is re-placed and otherwise untouched — no refusal rule, action, route or
snapshot field changes, and the classic skin is unaffected. The overlap list moves verbatim.
Nothing in the harness reads findings or overlaps before this change or after it.

## Testing

`test/factorySkin.test.ts`, extended rather than added to:

- `Findings` joins the four labels asserted to be real `.fx-act` buttons, and the chevron
  count goes 3 → 4 (the bar's one word for "there is a panel behind this").
- `data-fx="off-blueprint"` joins the "must not also be a panel" assertions, so the panel cannot
  come back alongside the desk.
- A new case pins the count to open findings: a mixed list of `open` / `dismissed` / `filing` /
  `filed` reads `1`, an overlap with no findings reads `0`, and the desk rendered on its own
  still draws that overlap — asserted on the number rather than on the markup that draws it.

Then the demo build driven at the widths the previous design lists. The bar's wrap point was
measured directly (content width against `viewport − 51px`) rather than eyeballed, which is what
caught the label at 170px.
