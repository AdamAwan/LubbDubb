# 22 — Pets

`src/pets/`. On by default; `pets.enabled: false` stops the scan and hides the vivarium without
deleting anything.

A **pet** hatches when you do something in the cockpit. **Beats** accrue from what the fleet spends,
and buy the food a pet grows on. One collection per database, so a deployment has one vivarium
however many projects, profiles or repositories it works across — a pet belongs to the harness, not
to a corner of it.

The feature is decorative and says so everywhere: nothing here gates, ranks, dispatches, blocks or
reports. What it buys is that the corner of the rail you already look at a hundred times a day has
something alive in it, and that the collection ends up being a record of the nights you were in
here.

## What it is not

Stated first, because each boundary is a thing that would otherwise be re-litigated by the first
change that finds pets convenient:

| Not                     | Because                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A metric                | Nothing is ranked, compared or scored. There is no total, no level, no streak and no leaderboard, and a collection twice the size of another's means nothing.   |
| An incentive            | Rewarding an operator for _acting_ would price a decision that must stay free — including the decision to answer nothing today, which is often the correct one. |
| Visible to agents       | No prompt mentions pets, no MCP tool touches them, and no agent can read the tables. A score an agent can see is a target it can optimise.                      |
| A dispatch input        | `src/pets/` is a lens. Nothing under `src/dispatcher/` may import it, for the reason the work graph and `prAttentionStatus` may not — see [05](05-dispatcher.md). |
| A reason to spend       | Beats are a rebate on money already gone. Spending more to raise a pet faster is a worse trade than not raising it, and the arithmetic is deliberately that obvious.  |
| A thing you can lose    | Nothing decays, starves, dies or is taken away. The harness runs unattended by design, and a creature that sulked about a quiet Sunday would be lying about it. |

## The two economies

They are separate on purpose, and the separation is the whole of what keeps the feature honest.

**Pets drop from operator actions.** Answering an escalation, settling a human task, accepting a
plan, authorising a stack landing, launching a job, triaging a finding. The fleet cannot earn a pet,
at any spend, ever.

**Beats come from fleet spend.** Cumulative `costUsd` across every recorded usage event, converted
at `pets.beatsPerDollar`. Money already spent, re-read as pet food.

So neither half can be farmed by the half you would not want farmed: the fleet cannot buy itself a
pet, and no amount of clicking produces a beat. An operator who wants a full vivarium has to use the
harness; an operator who wants a well-fed one has to have _been_ using it.

### Beats are derived, never stored

`beatsEarned` is `floor(totalCostUsd × beatsPerDollar)`, computed from `usage_events` at read time.
`beatsSpent` is `SUM(beats)` over `pet_purchases`. The balance is the subtraction.

Nothing accumulates a running total into a column, because a running total is a second copy of a
number the store already holds and drifts from it the first time a write lands twice. `usage_events`
only ever grows, so the derived figure only ever grows with it — and a restore, a re-import or a
recount changes the balance to the truth rather than to the truth plus whatever the column had
remembered.

## The roll

Every qualifying operator action is rolled exactly once, and the roll is a **hash of the action's own
identity**, never a random number:

```
roll   = hash32(`${kind}:${ref}`)      → drops when (roll % 10_000) < dropChance × 10_000
species = weighted pick from the kind's table, using hash32(`${kind}:${ref}:species`)
```

This is the load-bearing decision in the whole subsystem. A random roll would need the scan to be
exactly-once, and the scan is a walk over tables that a restart, a clock change, a restored backup
or a re-read can all walk twice. Hashing the action makes re-reading it free: the same action
produces the same answer forever, so the scan is idempotent by construction rather than by care.
`UNIQUE (origin_kind, origin_ref)` on `pets` then makes the insert idempotent too, and the two
together mean nothing anywhere has to remember whether it has already paid out.

The consequence to keep in mind: **a drop is a property of the action, not of when it was looked
at.** Changing `dropChance` re-rolls history for actions the scan has not reached yet, and does not
re-roll the ones it has.

### Pity

Actions since the last hatch are counted over `pet_actions`, and at `pets.pity` the next one is
forced whatever the hash says. Nothing stores the counter: a count is one query, and a stored total
is one more thing a torn write can leave wrong — wrong here meaning the rule either never fires or
fires forever, neither of which announces itself.

The count orders on **insertion, not on `at`**. A scan settles several actions in one pass and a busy
minute stamps them identically, so a `WHERE at > …` comparison reads a tie as "not after" and reports
zero. Every row is present and correct, the counter simply never moves, and pity never fires.

A pity counter exists because the failure mode of a purely independent roll is not unfairness, it is
**silence**: a fortnight of clicking with nothing to show teaches an operator to stop looking at the
corner, and the corner does not get a second chance at being interesting.

### Night

`nocturne` is drawn only by an action whose timestamp falls between 22:00 and 05:00, read in the
harness's local timezone as `job_schedules.cron` is — 2am means 2am where the operator was. The hour
comes off the **stored** timestamp rather than the clock, so a scan that reaches a 2am action at noon
still draws the animal that 2am earned; taking the hour at scan time would stop the roll being a
property of the action.

It is the one species whose availability depends on something other than what you were doing.

## The catalogue

`src/pets/catalogue.ts`, one exported `SPECIES` const — one const rather than one export per
species, because knip runs every rule at `error` and nine separately-exported records read as nine
unimported symbols.

| Species     | Rarity   | Drawn by                          |
| ----------- | -------- | --------------------------------- |
| `pip`       | common   | any qualifying action             |
| `nib`       | common   | a plan accepted                   |
| `tuft`      | common   | a human task settled              |
| `warden`    | uncommon | an escalation answered            |
| `cinder`    | uncommon | a job launched from the cockpit   |
| `nocturne`  | uncommon | any action taken between 22 and 5 |
| `lander`    | rare     | a stack landing authorised        |
| `quill`     | rare     | a finding triaged                 |
| `ouroboros` | mythic   | the harness updating itself       |

Each action kind carries a weighted table over the species it can draw. Every table includes `pip`,
so no action is a dead end, and the weights are what make a rarity rare — the tier on the row above
is a label for the cockpit, never an input to the pick.

### The first action ever

The **deployment's first qualifying action, of any kind**, drops unconditionally and picks from the
table with the common weights removed. This is the only place the roll is overridden, and it exists
because the first thing an operator ever settles in the harness is the single most memorable action
they will take in it, and rolling a 98% chance of nothing on it is a waste of the one moment the
feature is guaranteed an audience.

It fires **once per deployment**, not once per kind, and the distinction is the whole of why the
rule is worth stating. Per kind it fired seven times — and because stripping the commons leaves most
tables holding exactly one non-common species by day, each of those seven was a *deterministic
rare*: a guaranteed `quill` on the first plan and again on the first finding, a guaranteed `lander`
on the first landing. That inverted the tiers it was meant to decorate. The rare species became the
easiest in the catalogue to collect, `nib` and `tuft` became the hardest — reachable only through a
roll that excludes them the one time it is certain to fire — and an afternoon that touched each kind
once ended with seven pets and most of the rare tier.

The flag is therefore carried across the scan rather than re-read per action. `petActionKeys` is
captured once before the loop, so a flag derived from it and never advanced would call *every*
action in a first scan the deployment's first — the same seven-pet afternoon, arriving by a
different route.

## Growth

A pet is fed beats. `fed` is the cumulative count, and the stage is derived from it:

| Stage       | Fed                          |
| ----------- | ---------------------------- |
| `hatchling` | below the juvenile threshold |
| `juvenile`  | `1_500 × growth`             |
| `adult`     | `8_000 × growth`             |

`growth` is a per-rarity multiplier — 1 for a common, up to 4 for the mythic — so a rare animal
takes visibly longer to raise, which is most of what makes it feel rare once the novelty of drawing
it has passed.

Stage is computed by `src/pets/catalogue.ts` and **shipped on the wire**. The cockpit never holds a
copy of the thresholds: two implementations of one arithmetic is the drift that ends with a card
saying `JUVENILE` above a sprite drawn as an adult.

Beats spent on a pet are gone. There is no un-feeding, no reallocation and no refund, so a fed pet
is a decision the operator made about a finite thing — which is the only reason feeding one rather
than another means anything.

## The sprites

Pixel grids, hand-placed, drawn at an integer scale with smoothing off.

They live in `web/src/pets/sprites.ts` and never leave it. The wire carries `species`, `stage` and
`seed`; what a species looks like is a cockpit fact, and a server that also knew would be a second
place to change when a sprite changes.

### Why a hatchling has no species

Every species in a rarity tier shares one hatchling grid, so four grids cover all nine. The juvenile
is the first form that says what you have.

This started as an art-bill saving — twenty-two grids instead of twenty-seven — and turned out to be
the better mechanic: a hatchling is a thing you are waiting to find out about, and the reveal is
worth more than the extra four sprites would have been.

### Why a seed as well as a species

The pet's `seed` is the action key it hatched from. `web/src/pets/palette.ts` derives a colour ramp
and a small marking overlay from it, so two `pip`s are recognisably the same animal and visibly not
the same pet.

That trick is doing the work of an art budget: the alternative to it is either forty hand-drawn
species or forty identical sprites, and both are worse than nine species that each have individuals.

### Why they beat

The idle bob quickens with the number of agents out, in a double beat — lub, dub, rest — and stops
entirely while dispatch is paused. A vivarium that moves with the fleet is a status you can read from
across the room without parsing anything, and that is the argument for putting creatures in the
chrome at all rather than only on a page you visit.

Derived from the running-agent count rather than from `heartbeatIntervalMs` directly, because the
default pulse is five minutes and a bob with a five-minute period is a still image that redraws twice
an hour. The period is clamped to a range a heart could plausibly beat at.

`prefers-reduced-motion: reduce` stops all of it.

## The vivarium

`web/src/console/Vivarium.tsx`, rendered inside `.cn-rail` **below** `.cn-rail-list`. It draws through
`web/src/components/PetSprite.tsx`, which is shared with the panel and so styles itself through the
token layer rather than a `cn-` class.

The rail is already a flex column with a scrolling list, so the vivarium is a pinned footer: a queue
longer than the rail scrolls behind it rather than pushing it off the bottom. It is always in frame
and it never covers anything.

Four pets stand in it, chosen by the operator — and the first four to hatch stand there without
being asked for, because an empty enclosure under a full queue is exactly what teaches somebody the
corner is decoration. Putting out a fifth is refused rather than silently swapping one out: evicting
whoever was there is the cockpit deciding something the operator did not. Clicking it opens the panel.

Four rather than all of them because the rail is 268 pixels wide and a vivarium that scrolled would
be a second queue in the one place on the screen reserved for the first.

## The panel

`ConsolePanel` gains `'pets'`, so the panel is a place — it survives a reload and the back button
steps out of it, which is what `Place` (`web/src/cockpit/place.ts`) exists to guarantee and what a
`useState` in `useCockpit` would silently not.

`web/src/components/PetsPanel.tsx` draws every pet as a card: sprite, name, rarity, the action it
hatched from with its timestamp, a fed meter, and controls to feed, rename and place it.

The origin line is the point of the panel. A grid of creatures is a toy; a grid of creatures each
labelled with the night you answered the thing that produced it is a record, and it is the only part
of this subsystem that gets better the longer a deployment runs.

## Where the scan runs

`src/pets/scan.ts` collects every operator action, `src/pets/keeper.ts` drops the ones already
rolled, rolls the rest in timestamp order, and inserts what hatched.

It is wired in `src/system.ts` against the harness's `cycle:end` event. Neither `src/harness.ts` nor
anything under `src/dispatcher/` names pets — the harness has no reason to know the vivarium exists —
and a scan that throws is recorded through `errors.record` rather than allowed to reach the pulse.

An `onResponse` hook in `src/server/app.ts` also runs it after **any** successful `POST`, so a
creature an operator's click earned appears while they are still looking at the screen rather than at
the next pulse. One hook rather than a call in each settling route, and that is the point: the scan
is idempotent, so calling it after every write costs a few small reads and cannot be forgotten by a
route written later. The `cycle:end` scan is what guarantees delivery for anything that settles off
the surface — and a scan triggered twice for one action still produces one pet, because the roll is
a hash and the origin is unique.

### The sources

`src/pets/scan.ts` holds one table of sources, each naming a store read and how to key a row:

| Kind         | Source                                                    |
| ------------ | --------------------------------------------------------- |
| `escalation` | escalations with an answer                                       |
| `human-task` | `ask` tasks settled `done` — not declined, and not `close_out`   |
| `plan`       | plans that reached `active`                                      |
| `landing`    | stack landings recorded                                          |
| `job`        | jobs launched from the cockpit, which carry no `originRef`       |
| `finding`    | findings triaged — promoted, filed or dismissed                  |
| `upgrade`    | a self-update applied, keyed on the commit it accepted           |

Three exclusions are deliberate. A **declined** human task is the operator saying the ask should not
have been made, and a **`close_out`** one is the harness's own, which the harness also settles — so
neither is a person doing work. A **requeued** job carries an `originRef`, which marks it as the
harness redoing work a crash lost rather than an operator starting something. And a **retrospective**
is written by an agent, not by a person, which is why it is absent from a list it would otherwise
obviously belong to.

Adding a source is an entry in that table and a row in the loot tables. Nothing else changes, and a
source nobody adds is invisible rather than broken.

## Routes

`src/server/routes/pets.ts`, in `ROUTE_MODULES`. Every handler is wrapped in `checked(...)` and
refuses by returning a 400, never by throwing ([16](16-http-api.md#request-validation)).

| Route                     | Does                                                            |
| ------------------------- | --------------------------------------------------------------- |
| `POST /api/pets/:id/feed` | Spends beats on one pet. Refuses more than the balance.        |
| `POST /api/pets/:id/name` | Renames it. An empty name restores the species' display name.  |
| `POST /api/pets/:id/place`| Puts it in the vivarium or takes it out. Refuses a fifth.      |

There is no read route. `PetState` rides on the state snapshot with everything else the cockpit
draws, so the vivarium updates on the same socket as the rail above it — and it is **null** rather
than empty when `pets.enabled` is off, so the cockpit draws nothing at all instead of an enclosure
that reads as a deployment nobody has used.

## Persistence

`src/store/pets.ts`, three new tables. New tables need no `ColumnMigrations` entry — and a column
added to any of them later does ([14](14-persistence.md#migrations)).

| Table           | Holds                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `pets`          | One row per hatched pet. `UNIQUE (origin_kind, origin_ref)` is what makes the scan idempotent.  |
| `pet_actions`   | One row per operator action rolled, hatched or not, keyed `(kind, ref)`.                        |
| `pet_purchases` | One row per beat spent, with the pet it was spent on. The only source of `beatsSpent`.          |

**There is no scan cursor.** `pet_actions` is the watermark: an action whose key is already in it is
skipped rather than re-rolled, which is stronger than a timestamp high-water mark and needs nothing
kept in step. A source whose own timestamp moves under it — a plan re-saved, a finding re-triaged —
cannot pay out twice or consume a second slot of the pity counter.

`pets.fed` is a cached sum of that pet's purchases, kept because the vivarium reads it on every
snapshot and the panel reads it per card. The purchase and the increment are written in one
transaction, so there is no window in which a pet has been paid for and not grown.

## Configuration

| Key                    | Default | Does                                                        |
| ---------------------- | ------- | ----------------------------------------------------------- |
| `pets.enabled`         | `true`  | Off stops the scan and hides the vivarium. Nothing is lost. |
| `pets.beatsPerDollar`  | `25`    | The conversion. Raising it makes every pet cheaper to raise. |
| `pets.dropChance`      | `0.02`  | Per qualifying action, before pity.                         |
| `pets.pity`            | `15`    | Actions without a hatch before the next one is forced.      |

The defaults are set so a pet is an event rather than a receipt: one guaranteed drop to open the
vivarium, and roughly one per thirteen actions after it. At a fleet spending thirty dollars a day an
adult common is about ten days of feeding.

`dropChance` and `pity` are two limits over one rate, and the **lower one wins** — which is worth
reading off the arithmetic rather than the table, because the table makes them look independent. At
`0.02` the roll misses fourteen times running in 75% of streaks, so **three pets in four arrive
because pity forced them**, and the drop chance has largely stopped being the thing that decides.
Lowering it further barely moves the rate; raising `pity` is what hands the decision back to the
roll. An empty vivarium is still the failure mode worth tuning against, so the first move on a quiet
deployment is `dropChance` up, not `pity` down.

## Sharp edges

- **A new operator action is added to `src/pets/scan.ts`'s source table, and nowhere else.** The
  temptation is to call the keeper from the route that settles it. That works, and it is also how the
  scan quietly stops being the thing that guarantees delivery — one source recorded at its call site
  and not in the table is a source that pays out only while that route is the one that settles it.
- **The roll is a hash, and must stay one.** `Math.random` anywhere in `src/pets/roll.ts` turns every
  re-read into a fresh chance at a pet, and the tables have no way to tell that from a first read.
- **Nothing under `src/dispatcher/` may import `src/pets/`.** Asserted structurally in
  `test/pets.test.ts`, alongside the assertion that nothing under `src/mcp/` or `docs/prompt-templates/`
  ever names the vivarium to an agent.
