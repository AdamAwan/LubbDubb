# 22 — Pets

`src/pets/`. On by default; `pets.enabled: false` stops the scan and hides the vivarium without
deleting anything, and `pets.visible: false` hides it while the scan goes on filling it up.
→ [Configuration](#configuration)

An **egg** drops when you do something in the cockpit, and a **pet** comes out of it when you click
it. **Beats** accrue from what the fleet spends,
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

| Not                  | Because                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A metric             | Nothing is ranked, compared or scored. There is no total, no level, no streak and no leaderboard, and a collection twice the size of another's means nothing.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| An incentive         | Rewarding an operator for _acting_ would price a decision that must stay free — including the decision to answer nothing today, which is often the correct one.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Visible to agents    | No prompt mentions pets, no MCP tool touches them, and no agent can read the tables. A score an agent can see is a target it can optimise.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A dispatch input     | `src/pets/` is a lens. Nothing under `src/dispatcher/` may import it, for the reason the work graph and `prAttentionStatus` may not — see [05](05-dispatcher.md).                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A reason to spend    | Beats are a rebate on money already gone. Spending more to raise a pet faster is a worse trade than not raising it, and the arithmetic is deliberately that obvious.                                                                                                                                                                                                                                                                                                                                                                                                                |
| A thing you can dial | Nothing about the rates is configuration. Every rate used to be a key under `pets`, and every one of them wrote pets into existence that were indistinguishable from earned ones. → [Authenticity](#authenticity)                                                                                                                                                                                                                                                                                                                                                                   |
| A thing you can lose | Nothing decays, starves, dies or is taken away. The harness runs unattended by design, and a creature that sulked about a quiet Sunday would be lying about it. Blending is the one thing that ends an animal in the ordinary run of the feature, and it is the operator's own act on a duplicate — never the harness's, and never the last of its kind. The one exception is a **clearance**, which releases everything at once and is a named, once-ever act of the build rather than something the harness does on a schedule. → [Clearing the vivarium](#clearing-the-vivarium) |

## The two economies

They are separate on purpose, and the separation is the whole of what keeps the feature honest.

**Pets drop from operator actions.** Answering an escalation, settling a human task, accepting a
plan, authorising a stack landing, launching a job, ruling on a claim. The fleet cannot earn a pet,
at any spend, ever.

**Beats come from fleet spend.** Cumulative `costUsd` across every recorded cost delta — the agents'
and the local runs' alike ([18](18-observability.md#two-tables-of-deltas-added-in-one-place)) —
converted at `pets.beatsPerDollar`. Money already spent, re-read as pet food, whichever session spent
it.

So neither half can be farmed by the half you would not want farmed: the fleet cannot buy itself a
pet, and no amount of clicking produces a beat. An operator who wants a full vivarium has to use the
harness; an operator who wants a well-fed one has to have _been_ using it.

### Beats are derived, never stored

`beatsEarned` is `floor(totalCostUsd × beatsPerDollar)`, computed from the dated cost deltas
(`Store.sumUsageCostSince`) at read time.
`beatsSpent` is `SUM(beats)` over `pet_purchases`. The balance is the subtraction.

Nothing accumulates a running total into a column, because a running total is a second copy of a
number the store already holds and drifts from it the first time a write lands twice. Both delta
tables only ever grow, so the derived figure only ever grows with them — and a restore, a re-import or a
recount changes the balance to the truth rather than to the truth plus whatever the column had
remembered.

The one floor under it is a **clearance**: `beatsEarned` counts deltas from the last one's
timestamp rather than from the beginning, which is what lets a cleared vivarium start at zero instead
of opening with every beat the deployment had ever earned. With no clearance recorded the floor is an
epoch before any timestamp the harness can hold, so the sum is every event there has ever been.

## The roll

Every qualifying operator action is rolled exactly once, in **three stages**, and every stage is a
**hash of the action's own identity**, never a random number:

```
hatches = hash32(`${kind}:${ref}`) % 10_000 < rates[kind].dropChance × 10_000   -- or forced, or first ever
tier    = weighted pick from PET_RULES.rarity, using hash32(`${kind}:${ref}:tier`)
species = uniform pick from the kind's members of that tier, using hash32(`${kind}:${ref}:species`)
```

Every number in it comes from `PET_RULES` (`src/pets/rules.ts`) and none of them is a config key —
see [Authenticity](#authenticity) for why.

**The drop chance is per action kind; rarity is rolled once, globally.** The two are separate
decisions and it is worth keeping them apart: `PET_RULES.rates` says how much _one action of this
kind_ is worth, and `PET_RULES.rarity` says what a hatch turns out to be. Only the first varies by
action.

Stage 1 is priced roughly **inverse to how often the action comes up**. A single global rate reads as
fair and is not: the harness settles jobs and claims by the dozen and accepts an upgrade a handful
of times a year, so one chance in fifty everywhere means a vivarium drawn almost entirely from
whichever button the deployment happens to press most, and the animals behind the scarce actions are
never seen by anybody. The gap is wider than it first looks, because an `upgrade` is **one action per
accepted self-update**, keyed on upstream's tip — not one per commit the pull brings in.

| Kind         | `dropChance` | `pity` | About                                   |
| ------------ | -----------: | -----: | --------------------------------------- |
| `job`        |      `0.015` |  `130` | Launched from the cockpit, many a day.  |
| `claim`      |       `0.02` |  `100` | Ruled on in batches.                    |
| `human-task` |       `0.03` |   `66` | An ask settled.                         |
| `escalation` |       `0.04` |   `50` | Answered one at a time.                 |
| `plan`       |       `0.05` |   `40` | Approved a few times a week.            |
| `landing`    |       `0.08` |   `25` | A chain authorised to land.             |
| `upgrade`    |        `0.2` |   `10` | A self-update accepted. The rarest act. |

**Rarity is rolled once, globally.** It used to be an emergent accident of seven hand-tuned weight
tables — a ruled claim produced a rare 23% of the time and an answered escalation 5%, so no
sentence beginning "a rare is…" was true of the deployment. Stage 2 makes it one fact:
`PET_RULES.rarity` is the same table for every action, and only a pool that cannot fill a tier changes
the answer.

Stage 3 is **uniform**, not weighted. Stage 2 has already done the rarity work, and weighting here
too would put rarity in two places — the drift this replaced.

This is the load-bearing decision in the whole subsystem. A random roll would need the scan to be
exactly-once, and the scan is a walk over tables that a restart, a clock change, a restored backup
or a re-read can all walk twice. Hashing the action makes re-reading it free: the same action
produces the same answer forever, so the scan is idempotent by construction rather than by care.
`UNIQUE (origin_kind, origin_ref)` on `pets` then makes the insert idempotent too, and the two
together mean nothing anywhere has to remember whether it has already paid out.

The consequence to keep in mind: **a drop is a property of the action, not of when it was looked
at.** Changing a kind's `dropChance` re-rolls history for actions the scan has not reached yet, and
does not re-roll the ones it has.

### Pity

Actions since the last hatch are counted over `pet_actions`, and at that kind's own `pity` the next
one is forced whatever the hash says.

**One counter per kind, not one over the table.** A shared counter is spent almost entirely by
whatever the deployment does most, so pity fires constantly on job launches and, in practice, never
on a landing or a self-update — the kinds a floor is actually for. `petActionsSinceHatch` therefore
returns a count per kind, and both the scan and the attestation replay keep their counters the same
way. They have to: the counters are the one piece of state those two share, and a replay counting
globally while the harness counted per kind disagrees about which actions pity forced. That
disagreement does not read as a bug — it reads as `unearned`, on a pet that was honestly earned.

The map is **sparse**: a kind whose most recent rolled action hatched has no rows after it and so no
row of its own. Absent is how zero is spelled.

**Pity flips stage 1 and stops.** It never touches the tier: a pet you were given because you had
been unlucky is exactly as likely to be a mythic as one the roll granted. Paying out worse would
make a consolation a punishment; paying out better would make waiting the strategy.

Each kind's pity is set to **twice its own expected gap** (`2 / dropChance`), so it is a ceiling
rather than a schedule — you can be unlucky, never more than twice-unlucky, and the roll still decides
roughly six drops in seven. Set near the expected gap it becomes the schedule instead: at a drop
chance of 0.02 and a pity of 15 it supplied three pets in four, and lowering the drop chance moved
nothing. Nothing stores the counter: a count is one query, and a stored total
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

## The egg

A drop arrives as a **shell**, `pets.opened_at` null, and stays one until the operator clicks it. The
click writes the stamp, and the cockpit runs the ceremony: three rocks, a crack apiece, a flash, and
the hatchling.

**Nothing is rolled when the shell comes off.** The species, the tier and the colours were all
settled by `hash32(kind:ref)` the instant the scan reached the action — the shell withholds them, it
does not choose them. This is not a detail of the animation, it is the reason the animation is safe
to have at all: a roll at opening time would move the subsystem's one decision from the action to the
click, and every guarantee the hash buys goes with it. A re-scan would stop being free, `pet_actions`
would stop being a sufficient watermark, and two cockpits open on one database would crack the same
egg into two different creatures.

So an egg is a **reveal over a decided outcome**, and everything downstream follows from that:

- **A second open is a success, not a refusal.** A double click, a retried request and a reloaded
  link all arrive after the stamp is set, and none of them is the operator getting something wrong.
  The store's own `opened_at IS NULL` guard means they change nothing either way.
- **The modal draws from its own clock, never from the snapshot.** The write broadcasts, so the live
  row turns into a hatchling on whatever pulse the socket delivers — somewhere around the second
  rock on a quick machine. `HatchModal` therefore holds the shell on until its own sequence says
  otherwise. Drawing the prop would pop the egg open mid-wobble on one machine and hold it shut to
  the end on another, and the surface would be right both times. For the same reason it **finds its
  own pet in the collection and keeps the first match**, rather than being handed one by a caller
  that renders it conditionally: a snapshot arriving without that row — a reconnect, a refetch
  landing mid-write — would unmount the ceremony, and a remount starts the wobble again from the
  first rock. An egg that rocks twice as long as it should, on exactly the machines with the slowest
  socket.
- **The chain does not cover it.** `chainLink` hashes what the roll decided; opening is the
  operator's own act afterwards. Hashing it in would break every link the moment a shell came off,
  and an honest collection would start reporting `broken-chain` on the pets its owner had just
  enjoyed most. → [Authenticity](#authenticity)
- **An egg cannot be fed and cannot be blended.** Both are decisions about a creature, and nobody has
  been shown one yet — blending especially, since "only a duplicate goes" is a promise about
  something you have seen twice. It **can** be put out: a shell in the corner of the rail is the
  whole point of a shell. The flaw check runs _before_ the shell check in both, because "open it
  first" on a forgery is an invitation to carry on.
- **Nothing expires.** An egg sits for as long as the operator leaves it, the same way nothing else
  here decays. The enclosure counts them in its bar and the shell stirs every few seconds; that is
  the loudest this feature gets. → [What it is not](#what-it-is-not)

### What the shell gives away

The tier, and not the species. `mote` and `ouroboros` drop into the same corner of the rail and only
one of them is worth stopping what you are doing for, so an egg that gave away nothing would make
every egg the same egg — and one that gave away the animal would leave the click with nothing to
say. Markings carry the tier, from one speck on a common to a mythic banded end to end, and the
seed's palette does the rest, so no two eggs of a tier are the same egg either.

The species does ride on the wire from the moment of the drop — it has to, since the reveal is a
ceremony over something already decided — so **the one place it can leak is the cockpit**, and it
leaks silently: a surface reaching for `pet.species` or `pet.display` draws the answer through the
shell with nothing red. The drawing side is safe by construction: `spriteFor` resolves a **form** to
a grid, and the first two forms — `'egg'` and `hatchling` — ignore the species argument entirely, so
a surface passing a whole pet down to the canvas still cannot draw one. `'egg'` rides beside the
three stages rather than inside `PetStage` for the same reason it is a separate column: a stage is
what `fed` bought, and a shell is what nobody has opened yet. Naming is the side that needed a
guard, and every surface that names a pet goes through `petLabel` (`web/src/pets/reveal.ts`) — one
helper rather than a rule, because a rule is a thing a surface written later does not know about and
the field is right there on the view.

**The withholding runs to the juvenile, not to the shell.** A hatchling shares one grid per tier, so
its species is exactly as unknown as an egg's — and the panel named it anyway, in the name field's
placeholder, from the day it shipped. That quietly cost the juvenile stage its entire point, and
nothing was red: the card was correct, the sprite was correct, and the only symptom was that the
wait the sprites were built around had already been answered on the surface beside them. The hatch
modal is what made it obvious, by promising a wait the next click did not keep. Two rules follow, and
they are the same rule twice: **the operator's own name always wins** — it is theirs, chosen knowing
what they had — and copy that is _about_ the species without naming the pet (`this is your only
Ouroboros`) is reworded rather than renamed, on the server as well as in the cockpit, since a refusal
is a sentence the operator reads.

### Three reveals, not two

The shell fits the shape the sprites already had. A hatchling shares one grid per tier and the
juvenile is the first form that says which animal you have — so opening now reveals the **tier**, and
feeding still reveals the **species**. Each is a thing you wait for, and the wait was always the
mechanic. → [Why a hatchling has no species](#why-a-hatchling-has-no-species)

## The catalogue

`src/pets/catalogue.ts`, one exported `SPECIES` const — one const rather than one export per
species, because knip runs every rule at `error` and nine separately-exported records read as nine
unimported symbols.

Twenty-seven species across four tiers. Each action kind declares its members **per tier**; the tier
itself is rolled globally.

| Species     | Rarity   | Drawn by                          |
| ----------- | -------- | --------------------------------- |
| `pip`       | common   | any qualifying action             |
| `mote`      | common   | any qualifying action             |
| `nib`       | common   | a plan accepted                   |
| `tuft`      | common   | a human task settled              |
| `beck`      | common   | an escalation answered            |
| `berth`     | common   | a stack landing authorised        |
| `stoke`     | common   | a job launched from the cockpit   |
| `speck`     | common   | a claim ruled on                  |
| `patch`     | common   | the harness updating itself       |
| `warden`    | uncommon | an escalation answered            |
| `cinder`    | uncommon | a job launched, or a self-update  |
| `nocturne`  | uncommon | any action taken between 22 and 5 |
| `chit`      | uncommon | a human task settled              |
| `vellum`    | uncommon | a plan accepted                   |
| `drift`     | uncommon | a stack landing authorised        |
| `bramble`   | uncommon | a claim ruled on                  |
| `lander`    | rare     | a landing, or a self-update       |
| `quill`     | rare     | an escalation, a plan or a task   |
| `cairn`     | rare     | an escalation or a claim          |
| `ingot`     | rare     | a job launched from the cockpit   |
| `clarion`   | mythic   | an escalation answered            |
| `covenant`  | mythic   | a human task settled              |
| `oracle`    | mythic   | a plan accepted                   |
| `keystone`  | mythic   | a stack landing authorised        |
| `forge`     | mythic   | a job launched from the cockpit   |
| `lodestone` | mythic   | a claim ruled on                  |
| `ouroboros` | mythic   | the harness updating itself       |

**Every action carries three commons**: the two universals `pip` and `mote`, plus one signature of
its own. One common per pool put `pip` at 70% of hatches on five of the seven actions — a hundred
identical animals before anything else turned up, which is the boredom the extra six exist to fix.
No species now exceeds a fifth of hatches across a mixed workload, asserted in `test/pets.test.ts`.

**Every action also carries a full ladder** — a rare and a mythic of its own, one mythic per action
and no mythic shared between two. It did not: `upgrade` held the only mythic in the catalogue, and
`human-task` and `job` held no rare at all. The arithmetic is what settled it rather than the
principle. A mythic is 2% of hatches; behind an action taken at one chance in fifty that is one pet
in twenty-five hundred **accepted self-updates**, which on any real deployment is an animal nobody
ever sees, and it made a twentieth of the catalogue decoration. A mythic per action makes the tier
reachable — roughly one a quarter across a mixed workload — and one action per mythic is what keeps
each of them worth having.

### Ceilings, and degrading downward

A tier a pool cannot fill hands the roll **down** one tier at a time, never up.

**No shipped pool has a hole in it any more**, so this is a guard rather than a mechanic: it is what
keeps a pool edited badly, or one the `nocturne` night gate has filtered empty, from dropping a hatch
on the floor rather than throwing inside the scan. A hole used to be how a ceiling was expressed, and
that is exactly what went wrong — it put the scarcest animals behind the scarcest action, where the
odds made them unreachable. The ceiling is `PET_RULES.rates` now, where it can be read as a number.

The direction stays the invariant it always was. Degrading upward would make the scarcest actions the
easiest source of the scarcest animals — the inversion this design removed.

### The first action ever

The **deployment's first qualifying action, of any kind**, drops unconditionally and picks from the
table with the common weights removed. This is the only place the roll is overridden, and it exists
because the first thing an operator ever settles in the harness is the single most memorable action
they will take in it, and rolling a 98% chance of nothing on it is a waste of the one moment the
feature is guaranteed an audience.

It fires **once per deployment**, not once per kind, and the distinction is the whole of why the
rule is worth stating. Per kind it fired seven times — and because stripping the commons leaves most
tables holding exactly one non-common species by day, each of those seven was a _deterministic
rare_: a guaranteed `quill` on the first plan and again on the first claim, a guaranteed `lander`
on the first landing. That inverted the tiers it was meant to decorate. The rare species became the
easiest in the catalogue to collect, `nib` and `tuft` became the hardest — reachable only through a
roll that excludes them the one time it is certain to fire — and an afternoon that touched each kind
once ended with seven pets and most of the rare tier.

The flag is therefore carried across the scan rather than re-read per action. `petActionKeys` is
captured once before the loop, so a flag derived from it and never advanced would call _every_
action in a first scan the deployment's first — the same seven-pet afternoon, arriving by a
different route.

It is seeded from `petRolledSince(start)` rather than from that key set, and the difference is the
whole of what [the vivarium's start](#the-vivariums-start) buys. The key set holds the backlog too: a
deployment that takes a build shipping pets has thousands of keys the moment its first scan finishes
and has still never _rolled_ anything, so a guarantee gated on "is the table empty" would already
have been spent — on an escalation answered last spring — before the operator saw the vivarium at
all.

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

There are four **egg** grids as well, one per tier, and three **crack** overlays drawn over them —
`c` splits the shell along the outline ink, `k` takes the pixel out. Three grids rather than a
fracture simulation, indexed by how many times the egg has rocked: the animation is a sequence of
states, so a run that is interrupted or replayed draws the same shell at the same count rather than
wherever a physics clock had got to. The overlay is drawn by `SpeciesSprite`, in the same loop and
the same ink as the shell under it — a second canvas that only knew about eggs is precisely the
two-views-of-one-bytes split that component was made to prevent.

### The rarity ladder

Each tier keeps everything the tier below has and adds one device it is not allowed:

| Tier       | Adds                                                       |
| ---------- | ---------------------------------------------------------- |
| `common`   | the lit body, and nothing else                             |
| `uncommon` | one appendage above the head, drawn in its own grid        |
| `rare`     | an angular silhouette, and four glints at its bounding box |
| `mythic`   | a glow past the outline, and a sparkle that moves          |

Rarity used to be carried by the egg and by however much marking a grid happened to have, and by
nothing else — so a common with a good silhouette out-dressed a rare with a dull one, which is
exactly what it looked like. The ladder is the fix, and writing it down is half of it: it constrains
the twenty-eighth species as much as the twenty-seven already drawn.

`dressSprite` in `web/src/pets/sprites.ts` is where the ladder lives, whole. One grid in, one dressed
grid out — always `SPRITE_PAD` cells larger on every side, at every tier, because a margin that
varied by rarity would make the drawn size vary by rarity too, and a rare would sit a pixel lower in
the enclosure than the common beside it for no reason a reader could name. `SpeciesSprite` therefore
takes its **scale from the undressed grid** and offsets the crack overlay by the same constant; sizing
from the dressed one would shrink every creature by a fifth to make room for a margin.

The four rares — `cairn`, `ingot`, `lander`, `quill` — are drawn angular, and nothing below them is.
That is deliberate and it is the load-bearing half of the rare rung: the shape says the tier at 24px
in the enclosure, where four glints are four pixels.

#### The rim light is a pass, not a redraw

Each body pixel scores its four neighbours: open to the top-left takes the highlight, open to the
bottom-right takes the shade. The hand-placed `h` dots are folded back into the body first, so a grid
is lit once rather than lit and blushed.

A pass rather than eighty-one redrawn grids is the whole reason the direction was affordable, and it
keeps working: a grid changed tomorrow is lit for free. It is memoised against the grid's identity,
which holds because every caller passes a module constant out of `spriteFor`.

#### Why the sparkle takes a phase and never a clock

`dressSprite(grid, rarity, seed, phase)` is pure. The sparkle's four points come from the seed and
their state comes from the number passed in, so a reload, a re-render, or two surfaces showing one
pet all draw the same star — the same property the crack overlay has by being indexed on rocks, for
the same reason, and the thing that would be lost by reading a clock inside the drawing.

An **unopened** mythic twinkles as well as a hatched one. The shell already says the tier — a mythic
egg is banded end to end for exactly that reason — so holding the sparkle back until it opens would
withhold nothing and cost the one moment it is most worth having.

The phase is advanced by `PetSprite`, off `beatMs` — the clock that already drives the idle bob. A
busy fleet twinkles faster and a paused one holds still, at no second timer, and `useTwinkle` is
never even started for the twenty species with nothing to twinkle. `prefers-reduced-motion: reduce`
holds the phase at 0, which leaves the glow and a spark or two lit: the tier's device stays, only its
motion goes.

A spark that would land on the animal walks outward until it finds somewhere free, rather than
drawing under the body. A spark drawn under the body is not subtle, it is absent — and four of them
vanishing on the broader creatures is no sparkle at all.

#### What the ladder does to the withheld state

An unfound species on the Pets page still draws its tier's devices: a rare still glints, a mythic
still glows. That follows the page's existing split — **what is withheld is identity, what is
published is price** — and a tier is price. The devices outside the outline are drawn in a fainter
grey than the silhouette, because one flat grey turns a glow into more animal rather than into light.

### Why a hatchling has no species

Every species in a rarity tier shares one hatchling grid, so four grids cover all twenty-seven. The
juvenile is the first form that says what you have.

This started as an art-bill saving — four grids instead of twenty-seven — and turned out to be the
better mechanic: a hatchling is a thing you are waiting to find out about, and the reveal is worth
more than the twenty-three sprites it saves.

### Why a seed as well as a species

The pet's `seed` is the action key it hatched from. `web/src/pets/palette.ts` derives a colour ramp
and a small marking overlay from it — ten inks, of which five are the animal and five are the light
and the rarity devices on it, all from the same two hues so nothing on a creature is a colour the
seed did not choose — so two `pip`s are recognisably the same animal and visibly not
the same pet.

That trick is doing the work of an art budget: the alternative to it is either forty hand-drawn
species or forty identical sprites, and both are worse than nine species that each have individuals.

### Why they beat

The idle bob quickens with the number of agents out, in a double beat — lub, dub, rest — and stops
entirely while dispatch is paused. A vivarium that moves with the fleet is a status you can read from
across the room without parsing anything, and that is the argument for putting creatures in the
chrome at all rather than only on a page you visit.

Derived from the running-agent count rather than from `heartbeatIntervalMs` directly, because the
pulse is not a period a heart could beat at — five minutes when that was the only interval, and even
now five minutes whenever the fleet is idle, which is a still image that redraws twice an hour. The period is clamped to a range a heart could plausibly beat at.

`prefers-reduced-motion: reduce` stops all of it, and holds a mythic's sparkle at phase 0.

## The vivarium

`web/src/console/Vivarium.tsx`, rendered as the **last child of `.cn-body`** — after the rail and
after the situation area. It draws through `web/src/components/PetSprite.tsx`, which is shared with
the panel and so styles itself through the token layer rather than a `cn-` class.

**Last in the document, because that is what decides where it lands in one column.** Below 1100px the
shell has no rail beside anything: it is one column scrolling as a single page, and document order is
the entire arrangement. The enclosure lived inside `.cn-rail` until it was noticed that this put it in
the middle of a narrow page — a strip of pets between the queue and the work, which every scroll to the
overview had to get past. Written last it is the end of the page instead: something the operator
arrives at after the work, and never something in the way of it.

**Scrolled to, not pinned.** The narrow arrangement could hold it across the bottom of the glass, and
that is a worse version of the bug it fixes — the enclosure is decoration, and decoration that is
always on screen is taking a strip of a phone away from the asks. It goes past the last card and
stays there. → [17](17-cockpit.md#the-console-at-width)

**Beside the rail, placement puts it back on the rail's floor.** Above 1100px `.cn-body` is two rows,
`minmax(0, 1fr) auto`: the rail takes the first, the vivarium the second, the situation area spans
both. The `1fr` is what pins it — the rail's track absorbs whatever height the queue leaves over, so
the enclosure is on the rail's floor at every queue length, where an `auto` margin on a flex child
used to do the same job. `minmax(0, …)` rather than `1fr` alone because a `1fr` track floors at its
content: a queue longer than the rail would push the enclosure off the bottom instead of scrolling
behind it, which is the thing `.cn-rail-list`'s own `min-height: 0` is also there for. It stays in
flow at both widths, so it is always in frame and never covers anything: absolute positioning would
reserve no space and leave the last ask row permanently half-hidden.
→ [17](17-cockpit.md#the-console-at-width)

**One button per creature, rather than one over the floor.** The floor was a single button while it
had a single destination; an egg gives it two — a shell opens its own ceremony, anything else opens
the panel — and one click cannot have two destinations. Nested buttons are the other way to spell
that and are not a thing HTML has, so each animal is its own control and the strip underneath carries
the way in for an empty enclosure. → [17](17-cockpit.md#links)

**The strip is the Pets destination, and it took the nav slot Pets had.** A nav slot is the most
expensive space in the cockpit, and that one was buying a second way to a subsystem already drawn at
full size in this corner, beside a strip that was _already_ a button. So the two clicks split by what
they are for: an **animal** is the collection — where you feed, rename, place and blend one — and the
**strip** is [the page](#the-pets-page), which is what the subsystem is.

It has to _read_ as a destination, which is the half that is easy to lose: a caption naming the
enclosure and a way into it look identical without a word and a mark. So the strip says **`Pets`** —
the nav's own label, at the nav's weight (`.cn-viv-name`), with the counts faint behind it — and
carries a `›` (`.cn-viv-chev`) and a hover that takes the word to the accent. It said `Vivarium · 4 of
4` before, which told an operator what they were looking at: the one thing this corner already says
for itself. → [17](17-cockpit.md#shape)

The ceremony itself is `web/src/components/HatchModal.tsx`, rendered from `App.tsx` beside the other
shared modals, and **which egg is open is a `Place`** (`?hatch=<pet id>`) rather than a `useState`:
the back button steps out of it and a reload lands on the creature it named. A reload mid-wobble is a
reveal rather than a second roll, because there is nothing left to decide by then.
`prefers-reduced-motion: reduce` skips the sequence and shows the hatchling.

Four pets stand in it, chosen by the operator — and the first four to hatch stand there without
being asked for, because an empty enclosure under a full queue is exactly what teaches somebody the
corner is decoration. Putting out a fifth is refused rather than silently swapping one out: evicting
whoever was there is the cockpit deciding something the operator did not. Clicking it opens the panel.

Four rather than all of them because the rail is a single narrow column and a vivarium that scrolled would
be a second queue in the one place on the screen reserved for the first. The bound holds at the
narrow width too, where the enclosure is as wide as the page: four is what the panel behind it is for,
and a floor that filled itself because there was room would make the strip at the foot of a phone
screen the tallest thing on it.

**Under the strip, the date the vivarium started counting from** — `counting since 14 Aug 2026`,
drawn from `PetState.startedAt` and outside the strip's button, because the strip has a destination and
this is a fact with nowhere to go. It is here because this corner is where "nothing has hatched" is read: an
enclosure still empty after a week of work looks identical to one on a harness whose entire history
sorts before [the vivarium's start](#the-vivariums-start), and the date is the only thing that tells
them apart. Nothing is drawn while `startedAt` is null — one boot, before the first scan settles it —
since a sentence about a boundary nothing has decided yet is worse than the silence.

## The panel

`ConsolePanel` gains `'pets'`, so the panel is a place — it survives a reload and the back button
steps out of it, which is what `Place` (`web/src/cockpit/place.ts`) exists to guarantee and what a
`useState` in `useCockpit` would silently not.

`web/src/components/PetsPanel.tsx` draws every pet as a card: sprite, name, rarity, the action it
hatched from with its timestamp, a fed meter, and controls to feed, rename and place it.

The origin line is the point of the panel. A grid of creatures is a toy; a grid of creatures each
labelled with the night you answered the thing that produced it is a record, and it is the only part
of this subsystem that gets better the longer a deployment runs.

### What the origin line says

`originLine` draws **the label as the sentence**: _Found when you answered “Should I rebase or
merge?”_ rather than _Found when you answered esc_Jdt9l826iQ_. One phrase per origin kind, each
naming what the operator did — answered, settled, accepted the plan, landed the stack for, launched,
triaged, and, for an `upgrade`, _updated itself to_ its short sha. The label is quoted where it is
something a person wrote and bare where it is a ref the harness minted, since quoting a ref reads as
a title it is not.

**A null [label](#the-label) draws the line the panel drew before there was one** — the phrase and
the raw `originRef`. That is the case a pruned or restored source row lands in, and a pet outlives
what it came from by design, so the fallback is a shorter sentence rather than a blank line, an
apology or a [flaw](#what-is-not-checked).

**The ref stays on the card, in mono, beside the timestamp** — it is what an operator quotes back at
a database, and it is the one thing about a pet that a label cannot be searched by. It is drawn only
where there _is_ a label; where there is not, the sentence is already the ref, and printing it twice
would say nothing.

**The sentence is clamped to two lines by `.pet-origin-said`, with the whole of it on the hover
title.** The server clamps a label to one line of ninety characters, which is still four lines in a
216px card, and a card that grew to fit its wordiest escalation would take its whole row of the grid
with it. Clamping in CSS rather than shortening in the component is deliberate: only the layout knows
how wide the card came out.

Neither the sentence nor the ref is a [`<Ref>`](17-cockpit.md#links). None of the seven is an issue
or a pull request that component can resolve — they are row ids in this harness's own tables — so the
card names them rather than pretending to a destination it has not got.

## The Pets page

`ConsoleTab` gains `'pets'`, so the catalogue is a **place** rather than a panel over whatever was in
front — a destination has to round-trip through the URL whatever draws the way in. It is the second pets
surface and the two answer different questions: the panel is **your collection**, reached by clicking an
animal; the page is **what exists**, reached from [the vivarium's strip](#the-vivarium).

`web/src/components/PetsPage.tsx` draws four things — the two constants and the **rate per action**,
the tier weights as a bar, every species banded by rarity, and the matrix of every action against
every tier it can roll. There is no way in at all whenever the snapshot ships no vivarium —
`pets.enabled` off, or `pets.visible` off — since the strip that carries it is the enclosure's own, and
`tabBody` refuses a stale `?tab=pets` URL for the same reason.

The rate is drawn per action rather than as one figure because that is what it is: since the drop
was priced against how often each kind comes up, a single number would make whichever button the
deployment presses most into the whole vivarium. The matrix's step-down column carries its `↓`
legend **only when some row actually steps down** — every pool is currently full, so none do, and a
standing legend for an arrow the table never draws sends a reader hunting for it.

The intro carries the **one line on the page that is about this deployment rather than about the
tables**: the date the vivarium started counting, and that anything done before it is on record and
pays nothing. Every rate below it is a claim about what an action is worth, so on a harness that took
pets long after it started working there is a visible history those rates did not pay for — which
reads as the feature being broken rather than as [the start](#the-vivariums-start) doing its job.
`PetState.startedAt` exists on the wire for this line and the vivarium's; it is null until the first
enabled scan stamps one, and both surfaces draw nothing rather than a placeholder.

### What it withholds

A species you have not hatched keeps its **rate, its cost and the actions that draw it**, and gives
up its **name, its forms and its colours** — the name is drawn `???` and every age is drawn as a flat
grey silhouette. The masking reaches the source matrix too: a table that spelled out `Ouroboros` in a
cell would undo the card grid above it.

The split is the whole design. A page that showed everything would spend the reveal the sprites are
built around — every tier shares one hatchling precisely so that finding out _what you got_ is worth
waiting for ([the sprites](#the-sprites)) — and a page that showed nothing would answer none of the
questions an operator actually has. **What is withheld is identity; what is published is price.**

### What counts as having seen one

Two questions, answered by `speciesSeen` in `web/src/pets/reveal.ts` and by nothing else: **which
species you have met**, and **which of its forms you have been shown**.

An **unopened egg counts for neither**. The animal inside it was decided the instant the scan reached
the action, but the shell has shown the operator none of it — so a page that read the species off a
row still in its shell would answer the question the ceremony exists to ask, and it would do it in a
list, silently, while the egg sat unclicked in the vivarium. A shell is a pet you own and a species
you have not met.

**The name is the juvenile's to give**, exactly as [`speciesKnown`](#what-the-shell-gives-away) has it
for a single pet: the hatchling is the tier's own form and says nothing about which animal is inside
it. That the two agree is not a coincidence to be maintained by care — the page derives `found` from
the same map, so a surface cannot come to disagree with the panel about whether an animal has been
identified.

**Each age is drawn once a pet of yours has reached it**, with every rung below it — a pet at adult
was a hatchling and a juvenile on the way, and greying the forms its owner watched it grow out of
would withhold a memory rather than a secret. So the adult of a species you own only as a juvenile
stays a silhouette: raising one is the second half of the collection, and a page that drew the grown
form of an animal nobody has grown makes the beats it costs pay for nothing.

The tier's shared hatchling used to be revealed by **any** sibling of its tier, on the reasoning that
one shared drawing is one sighting. It reads as generosity and is not: it lights a form on one card
of the band and greys it on the next, which is a per-species answer given from tier-wide evidence —
so a collection with a single common in it drew a hatchling on all nine of them. The ages are gated
on the species' own record now, and on `known` as well as `seen`, so an opened hatchling of a species
the operator is not yet allowed to name cannot light its card alone and give the name away by
elimination.

A blended pet still counts, in both answers. Having seen the animal is not undone by having dissolved
a spare of it later.

A silhouette rather than a blur, because blurred pixel art reads as a rendering fault rather than
as a state — and a silhouette stays recognisable enough to be worth going and finding. It is drawn
in one grey, a literal in `web/src/components/SpeciesSprite.tsx` rather than a theme token, for the
same reason `paletteFor`'s five are literals: a canvas takes a colour, not a custom property.

`SpeciesSprite` is where the canvas loop now lives, and `PetSprite` is a wrapper over it that adds
the bob and the hover name. The page draws forms **nobody owns** — three stages of a species that
may not be in the collection at all — so both callers name what to draw rather than passing a pet.

### The catalogue is a reading, never a second table

`src/pets/compendium.ts` builds `PET_CATALOGUE` once at import by walking the same roll the scan
runs: every action, every tier, every hour of the clock. **Nothing in it is a second copy of the
tables.** `adultAt` comes from `beatsToNextStage`, the same function `PetView` uses; `share` is the
pool walk rather than a hand-totalled percentage; the step-down rows come from `resolveTier` rather
than from a reading of which pools look empty.

That constraint is the reason the module exists at all, and the failure it prevents is silent: a
page carrying its own thresholds advertises a price the harness does not charge, and every card
renders perfectly. `test/petCatalogue.test.ts` asserts the properties that stop being true the
moment one of these figures is computed a second way — the shares sum to one, a roll never steps
_up_, and `petStage` agrees with the thresholds the page prints.

Two figures are shipped as facts rather than as flags, so that nothing outside
`src/pets/catalogue.ts` has to know which species is which. `hours` is the hours a species may be
drawn in — `null` for any hour — rather than a `nightOnly` boolean, so a second gated species needs
no wire change. `rarities` is the tier order, so a fifth tier renders rather than falling off a
hard-coded four.

`share` is the one figure that carries an assumption, and the page says so: it assumes an even mix
of `PET_ACTION_KINDS` — the seven live actions, which no deployment has — and weighs each of them by
its **own** `dropChance` —
counting them evenly would claim the catalogue is thirteen times more upgrade-flavoured than it is,
now that an upgrade is one action in five and a job one in sixty-six. The weights are read off
`PET_RULES.rates` rather than written down, so they follow the next time the prices move. The source matrix beside it is the exact
per-action answer. The first-ever drop is deliberately **not** folded in — `tiersFor`'s `firstEver`
arm describes a moment that happens once per deployment ([the first action ever](#the-first-action-ever)),
and folding it into a headline rate would describe that moment rather than the deployment.

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

### The vivarium's start

**An action stamped before the vivarium started is recorded and rolls nothing.** The start is one row
in `pet_vivarium`, stamped by `PetKeeper.scan` the first time it runs with pets enabled, and it is
the only lower bound anywhere in the subsystem — `collectActions` still reads every source in full,
because `at` is a different column per source and several of them move under the row, and cutting
there would lose the ability to record a pre-boundary action at all.

Without it, the first enabled boot of a build that ships pets treats a deployment's entire history as
this afternoon's work: `pet_actions` is empty, so every escalation, ask, plan, landing, job, claim
and upgrade in the database is fresh, is sorted oldest-first, and is rolled in one pass — with
[the first action ever](#the-first-action-ever) landing on the oldest row in the backlog rather than
on anything the operator did while the feature was on screen.

What the first stamp takes is the whole of the migration decision:

- **`pet_actions` empty → `now()`.** Nothing here has ever been rolled, so nothing is being cut off.
  The backlog is recorded inert and the deployment's first pet comes from what its operator does
  next.
- **`pet_actions` non-empty → `MIN(at)` over it.** Every already-rolled row is then at or after the
  start, which makes the filter a **provable no-op** for an existing collection: the same pity walk,
  the same `firstEver`, the same replay, the same pets. `now()` here instead would mark honestly
  earned actions pre-boundary and put an `unearned` badge on a real animal on the boot its owner took
  the build, which is the failure [authenticity](#authenticity) is written to avoid above all others.

The row's own absence is the migration gate, which is why the start is a table and not a column: it
is true on exactly one boot however the schema arrived, and it needs no `ColumnMigrations` entry and
no `ensureColumns` report to know that boot from the next
([14](14-persistence.md#when-a-null-means-something)). It is stamped by the **keeper**, not by the
`Store`'s constructor, so a deployment sitting with `pets.enabled` false for months does not burn its
start date on boots that could hatch nothing anyway.

A pre-boundary action is **recorded** — a `pet_actions` row with `pet_id` null — rather than passed
over. `petActionKeys` is the only thing that makes a re-scan free, so an unrecorded action stays
fresh forever and would pay the whole backlog out at once the day anything moved the boundary. Inert,
not pending.

**Three readers honour it, and they have to agree.** `PetKeeper.scan` skips the roll,
`petActionsSinceHatch(start)` leaves those rows out of the pity count, and `replayBarren(log, rules,
start)` skips them in the attestation replay and takes `firstEver` from the first row at or after the
start. A boundary the scan honoured and the replay did not would be worse than no boundary at all: it
would accuse existing collections, one pet at a time, with nothing red anywhere.

The `pet_resets` stamp is deliberately **not** reused as the start, though it exists, is already the
wallet's floor and would be re-stamped for free. It is the wrong value on exactly the deployments
this rule was written for — a clearance that ran _after_ their backlog was rolled puts every existing
pet's action before it — and a database that has never had a clearance has no row at all.

### The sources

`src/pets/scan.ts` holds one table of sources, each naming a store read and how to key a row:

| Kind         | Source                                                         | Label                          |
| ------------ | -------------------------------------------------------------- | ------------------------------ |
| `escalation` | escalations with an answer                                     | the question it asked          |
| `human-task` | `ask` tasks settled `done` — not declined, and not `close_out` | the ask's title                |
| `plan`       | plans that reached `active`                                    | the plan's title               |
| `landing`    | stack landings recorded                                        | the goal the chain belonged to |
| `job`        | jobs launched from the cockpit, which carry no `originRef`     | the job's title                |
| `claim`      | claims an operator ruled on — `ruled_at` stamped               | the claim itself               |
| `finding`    | **retired.** Nothing hatches one; pets already carrying it do  | the claim it made              |
| `upgrade`    | a self-update applied, keyed on the commit it accepted         | the short sha                  |

**`finding` is a retired kind, and that is why it is still in the union.** Ruling on a claim is what
triaging a finding was, under the name it has now that the three claim stores are one — but
`pets.origin_kind` carries the word on the row, and the seed the cockpit derives a creature's colours
and markings from is `<kind>:<ref>`. Renaming a member does not rename a category; it orphans every
pet already hatched from one. So the word stays, its rate and its species table are the `claim` ones
unchanged, and its label is found by putting the fold's own derivation back — the row that named a
finding is `fact_<that finding's id>` now. And the ledger is stamped once: `spendRuledClaims` records
every claim already ruled on as an action that paid nothing, because otherwise a deployment taking that
build pays out for a year of decisions in one afternoon — which looks exactly like the feature working.
→ [14](14-persistence.md#a-migration-that-must-run-once)

Three exclusions are deliberate. A **declined** human task is the operator saying the ask should not
have been made, and a **`close_out`** one is the harness's own, which the harness also settles — so
neither is a person doing work. A **requeued** job carries an `originRef`, which marks it as the
harness redoing work a crash lost rather than an operator starting something. And a **retrospective**
is written by an agent, not by a person, which is why it is absent from a list it would otherwise
obviously belong to.

**A retired kind is in `POOLS` and in `PET_RULES.rates`, and out of `PET_ACTION_KINDS`** — which is
what the catalogue walks. The two readings are different questions. The tables answer "what was this
pet drawn from", which a `finding` pet still asks every time its card is drawn; the catalogue answers
"what can I do to earn one", and a retired act is not one of those. Walked into the catalogue it is
published as a live source — a full four-tier row and its own rate line, labelled _Triaging a
finding_, an act that has not existed since the three claim stores were folded into one — and it also
normalises `share` over the claim pool **twice**, under two names, so every other species is
understated by about four per cent. Nothing is mis-rolled, the shares still sum to one, and there is
no figure on the page a reader could check any of it against: this page's only job is to publish the
price, and a page carrying a price the harness does not charge is the failure this section exists to
name.

Adding a source is an entry in that table and a row in the loot tables. Nothing else changes, and a
source nobody adds is invisible rather than broken — as is a source nobody can earn, for the same
reason and by the same filter.

#### The label

`origin_ref` is a row id by construction — `esc_Jdt9l826iQ` — so `PetView` carries an `originLabel`
beside it: the **Label** column above, resolved from the source row and clamped to one line of ninety
characters. Free text an operator or an agent typed reaches the wire clamped rather than the panel,
because a paragraph with newlines in it reflows a grid and nothing in `npm run check` draws a card.

Three things about where it is resolved, each of them the reason for the next.

**On the server, not in the browser.** Every source list already rides on `/api/state`, but they are
all capped — `listFindings(limit = 100)`, `listHumanTasks(limit = 100)`, `listJobs(limit = 100)`,
`listStackLandings(limit = 50)` — while pets are kept forever. A browser-side join would name this
week's pets and leave the oldest showing an id, which inverts the one thing the origin line is for.

**Per snapshot, not in a column.** A stored label is a copy that disagrees with the thing it names
the first time a job is renamed or an escalation reworded. `stage`, `beatsToNextStage`, `flaw` and the
wallet are all derived for the same reason; this is on that side of the line.

**By id, not by a walk.** `PetKeeper.originLabels` groups the vivarium's refs by kind and asks each
owning store module for exactly those ids — `escalationLabels`, `humanTaskLabels`, `planLabels`,
`landingLabels`, `jobLabels`, `factLabels`, six statements bounded by the collection rather than by
the deployment's history. `upgrade` reads nothing: its ref is a commit, and the label is that sha
shortened. Anything that resolved these by re-running `collectActions` would put the seven-table walk
this subsystem already refused back on every pulse.

`origin_kind` and `origin_ref` do not move for any of this. They are the seed, the input to the
re-roll in `src/pets/attest.ts` and part of the chain hash — the label sits beside them and is read by
nothing but the panel.

## Blending a duplicate

The catalogue is twenty-seven and the vivarium holds four, so duplicates are the common case rather
than the edge. Blending dissolves one back into beats at `blendYield × growth` — a mythic is worth four
commons, and the yield sits deliberately below what the same tier costs to reach juvenile, so
blending is a use for surplus rather than a currency press.

**It marks, it never deletes.** A blended pet keeps its row, its species, its seed and its origin
line, gains a `dissolvedAt` stamp, leaves the vivarium and stops being feedable or placeable. The
origin line — the night you answered the thing that produced it — is the one part of this subsystem
that gets better the longer a deployment runs, and a `DELETE` takes it with the animal.

**Only a duplicate goes.** `blend` refuses the last live pet of a species, which is what keeps the
row above in the "not" table honest: nothing is taken from you that you did not have twice.

The credit is **stored** in `pet_blends` rather than derived from the dissolved rows, and this is the
one place the subsystem stores a total on purpose. Its value depends on `blendYield`; deriving it
would rewrite history the day that key is tuned, and could take a balance already spent negative.

## Clearing the vivarium

A **clearance** releases the whole collection at once and starts the beats again from zero. It is the
only thing in the subsystem that deletes a pet, and everything about how it is shaped is aimed at
keeping it from being a thing that can happen twice or by accident.

**It is a named act of the build, not a control.** `VIVARIUM_RESET` in `src/pets/keeper.ts` is the
clearance this build carries; `PetKeeper.resetOnce` runs it if `pet_resets` holds no row under that
name, and the row it writes is what makes every later boot a no-op. There is no route, no button and
no config key — an operator cannot clear their vivarium, and neither can an agent.

**The id is never edited in place.** Changing that string is not a rename, it is a second clearance:
every deployment that takes the build loses its collection, silently, because a wipe that ran as
designed has nothing to report and `npm run check` has no opinion about a constant. A further
clearance is a further id, added deliberately, and the old one stays so the deployments that have
already had it are not given it twice.

**`pet_actions` survives it, and that is the load-bearing part.** The actions a released collection
hatched from are still marked as rolled, so the next scan writes nothing. Clearing it too would read
as the tidier wipe and would undo itself on the first pulse — the same creatures, out of the same
history, by the same hashes.

**The vivarium's start is re-stamped in the same transaction**, and that is what makes "starts again
from zero" true of the rolls and not only of the wallet. Every `pet_actions` row a clearance leaves
standing now falls _before_ the new start, so it is inert rather than merely spent: it lends the next
action no pity floor, and the deployment's one first-action guarantee comes back with it — the first
thing the operator settles after a clearance drops unconditionally, exactly as the first thing they
ever settled did. A clearance is a once-per-build act of the harness rather than something an
operator can ask for or farm, which is why handing the guarantee back is safe; keeping it spent
forever would make "from here on" mean "from here on, except the one moment the feature was built
around". The vivarium fills again from what the operator does **next**.

Purchases and blend credits go with the pets, in the same transaction, because a beat spent on a
creature that no longer exists is a balance drawn down against nothing.

**Off clears nothing.** With `pets.enabled` false the clearance is skipped rather than run quietly,
which keeps the one promise that setting has always made. A deployment that turns the vivarium on
later gets its clearance then.

It runs in `src/server/main.ts` at boot, before anything can hatch — not in `buildSystem`, for the
reason `loadDeploymentConfig` is not called there either: a suite that grew it would wipe the fixture
out from under whichever test built its system first.

## Routes

`src/server/routes/pets.ts`, in `ROUTE_MODULES`. Every handler is wrapped in `checked(...)` and
refuses by returning a 400, never by throwing ([16](16-http-api.md#request-validation)).

| Route                      | Does                                                             |
| -------------------------- | ---------------------------------------------------------------- |
| `POST /api/pets/:id/open`  | Cracks a shell. No body, and a repeat is a success.              |
| `POST /api/pets/:id/feed`  | Spends beats on one pet. Refuses more than the balance.          |
| `POST /api/pets/:id/name`  | Renames it. An empty name restores the species' display name.    |
| `POST /api/pets/:id/place` | Puts it in the vivarium or takes it out. Refuses a fifth.        |
| `POST /api/pets/:id/blend` | Dissolves a duplicate into beats. Refuses the last of a species. |

| `GET /api/pets/catalogue` | The catalogue: rules, tier order, every species, the step-down matrix. |

The **collection** has no read route. `PetState` rides on the state snapshot with everything else
the cockpit draws, so the vivarium updates on the same socket as the rail above it — and it is
**null** rather than empty when `pets.enabled` is off or `pets.visible` is, so the cockpit draws
nothing at all instead of an enclosure that reads as a deployment nobody has used.

The **catalogue** is the opposite case and so is fetched: it is the same bytes on every request of
a build, and a constant riding a snapshot that ships every heartbeat is paid for forever. It takes
no parameters and reads no state — what exists and what it costs are decided by tables this build
ships, which is the point of the surface. The demo backend serves an empty catalogue and the page
says why: what exists is decided in `src/pets/`, which the web bundle deliberately does not import,
and a hand-written demo copy of twenty species would be stale the first time one was added.

## Persistence

`src/store/pets.ts`, six tables. A new table needs no `ColumnMigrations` entry — but `pets` is no
longer new, so **`dissolved_at` has one**, in `PET_COLUMNS`. Without it the column is invisible on
every database from before blending existed, and invisible here means every historical pet reads as
alive again ([14](14-persistence.md#migrations)).

| Table           | Holds                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pets`          | One row per pet, egg or opened. `UNIQUE (origin_kind, origin_ref)` is what makes the scan idempotent. Also carries `opened_at`, `built_sha`, `built_clean` and `chain`. |
| `pet_actions`   | One row per operator action rolled, hatched or not, keyed `(kind, ref)`.                                                                                                |
| `pet_purchases` | One row per beat spent, with the pet it was spent on. The only source of `beatsSpent`.                                                                                  |
| `pet_blends`    | One row per duplicate blended, with what it credited. The only source of the blend half of `beatsEarned`.                                                               |
| `pet_resets`    | One row per clearance, keyed by its name. Its timestamp is the floor `beatsEarned` counts spend from.                                                                   |
| `pet_vivarium`  | One row, `id` pinned to 1: when this vivarium started counting. Stamped by the first enabled scan, re-stamped by a clearance.                                           |

`opened_at` is in `PET_COLUMNS` too, and it is the one column here whose migration is not finished by
the `ALTER TABLE`. **Null in it means _still an egg_** — so on every existing deployment the added
column would turn a vivarium raised over months into a crate of anonymous shells, silently and with
no way back but clicking through the lot. `ensureColumns` therefore reports the columns it actually
added, and `Store`'s constructor runs `openPetsFromBeforeEggs` only when `pets.opened_at` is among
them, stamping every historical pet with its own `hatched_at`: a pet from before the shell was
revealed the moment it dropped, and that is the honest time to give it. Run unconditionally on every
boot instead, the same backfill would open every egg the operator had deliberately left sitting —
the identical silence, pointed the other way. → [14](14-persistence.md#migrations)

`built_sha`, `built_clean` and `chain` are in `PET_COLUMNS` beside `dissolved_at`, for the same
reason. Each of them reads as a _weaker_ claim when absent rather than a false one, which is what lets
a database from before them keep every pet it holds.

**There is no scan cursor, and the boundary is not one.** `pet_actions` decides what has _already
been rolled_: an action whose key is in it is skipped rather than re-rolled, which is stronger than a
high-water mark and needs nothing kept in step. A source whose own timestamp moves under it — a plan
re-saved, a claim ruled on again — cannot pay out twice or consume a second slot of its kind's pity
counter. `pet_vivarium` answers a different question, once: _when did this vivarium start counting_.
Nothing advances it, so it is not a cursor and cannot fall behind one — see
[The vivarium's start](#the-vivariums-start).

`pets.fed` is a cached sum of that pet's purchases, kept because the vivarium reads it on every
snapshot and the panel reads it per card. The purchase and the increment are written in one
transaction, so there is no window in which a pet has been paid for and not grown.

## Configuration

| Key            | Default | Does                                                                         |
| -------------- | ------- | ---------------------------------------------------------------------------- |
| `pets.enabled` | `true`  | Off stops the scan and hides the vivarium. Nothing is lost.                  |
| `pets.visible` | `true`  | Off hides the vivarium and its tab, and stops nothing. The collection grows. |

**Two switches, and the difference between them is what the second one is for.** `enabled: false` is
the whole feature not running: no scan, no rolls, no vivarium, and — because off has never deleted
anything — a collection sitting exactly where it was. `visible: false` is the same cockpit and a
running vivarium behind it: the scan still runs on every cycle, actions still roll, and pets still
hatch into a page nobody is looking at. It is the setting for an operator who wants the harness
without the animals on their screen, and it is deliberately not `enabled` — turning the feature off
for a quarter and back on decides, months in advance, that a quarter of real work was worth nothing,
because an action stamped before the vivarium's start rolls nothing forever after. Hidden costs
nothing and hands the whole accrual back the moment it is turned on.

Both are gated in exactly one place each. `visible` is read by `PetKeeper.state()` and nowhere else,
so there is no path by which hiding the enclosure can reach the roll; everything that hatches, feeds,
blends or clears asks `enabled`. What `state()` returns when hidden is the same `null` that off
returns, and the cockpit is not told which it was: the tab is absent, the rail's enclosure is absent,
and a stale `?tab=pets` URL reads "Pets are hidden on this deployment." A second flavour of null
would be a second case every surface has to handle for a distinction none of them would draw
differently.

`pets.visible` is **live** — it has an arm in `configApply.ts`, which assigns onto the policy object
the keeper closed over, so the enclosure goes on the next heartbeat rather than the next restart.
`pets.enabled` is not: it gates the scan and the clearance, and those are decisions worth taking at a
boot. → [02](02-configuration.md#liveness)

**That is the whole of it, and the shortness is the point.** `beatsPerDollar`, `rates`,
`rarity` and `blendYield` were all keys here once. Each of them was a way of writing a pet into
existence without doing anything: `dropChance: 1` hatches on every action, `pity: 1` does the same by
another road, a `rarity` table zeroed everywhere but `mythic` turns the scarcest animal in the
catalogue into the only one, and a large enough `beatsPerDollar` raises a whole vivarium on a single
dollar. None of it reads as cheating from inside the cockpit — the pets arrive through the ordinary
scan, carry real origin lines, and look exactly like earned ones.

They live in `PET_RULES` (`src/pets/rules.ts`) now, frozen, identical on every deployment:

| Rate             | Value                                            | Does                                                                       |
| ---------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| `rates`          | one `{dropChance, pity}` per action kind         | What one action of that kind is worth. Tabled under [The roll](#the-roll). |
| `rarity`         | `{common 700, uncommon 200, rare 80, mythic 20}` | The one tier table stage 2 rolls.                                          |
| `beatsPerDollar` | `25`                                             | The conversion.                                                            |
| `blendYield`     | `500`                                            | Beats a blended duplicate hands back, per point of `growth`.               |

The defaults are set so a pet is an event rather than a receipt: one guaranteed drop to open the
vivarium, and a handful a week of ordinary use after it. At a fleet spending thirty dollars a day an
adult common is about ten days of feeding.

A kind's `dropChance` and its `pity` are two limits over one rate, and the **lower one wins** — which
is worth reading off the arithmetic rather than the table, because the table makes them look
independent. At twice the expected gap the roll misses its way to the ceiling rarely enough that the
roll keeps the decision; setting pity near the expected gap is what takes it away. An empty vivarium is the failure mode worth
watching for, and the answer to one is now a change in this table, in a release everybody gets,
rather than a dial one deployment turns and the rest do not.

`enabled` survives because off is the one direction that cannot mint anything, and `visible` because
it cannot reach the roll at all.

`PetKeeper` takes the rates as a third constructor argument, defaulted to `PET_RULES`. That is a
**test seam and nothing else** — `src/system.ts` passes two arguments, and `test/pets.test.ts`
asserts that `configFields.ts` exposes `pets.enabled` and `pets.visible` alone and that `PetPolicy`
holds no number.

## Authenticity

A pet is worth having because of what it cost. So the subsystem answers, for every pet on the shelf,
whether it is what it says it is — and says so on the card when it is not.

### What this can and cannot be

**Tamper-evident, not tamper-proof, and the difference is worth stating once.** The vivarium lives in
a SQLite file the operator owns, so nothing here stops somebody writing rows into it. No local check
can: the verifier and the forger are the same machine, run by the same person, so any secret the
harness could sign with is a secret that person can read. A design claiming otherwise would be
lying, and the only real fix — a remote signer holding the private half — would make a decorative
corner of the rail network-dependent and ship a record of what an operator does off their own box.
That is a bad trade for this feature and it is not made.

What is achievable is that a forgery has to agree with three tables, a hash chain and the build
stamp all at once, and that the one thing anybody would forge _for_ — a particular animal — is the
thing that cannot be chosen.

### Why the roll being a hash is what makes this possible

Stage 3 hashes the action's key under a `:species` salt and indexes the tier's members with it, so
the animal is a **property of the action's identity** — an origin key reaches exactly four species
out of twenty-seven, one per tier, and never the one you wanted. A forger has to grind for an origin ref that happens to give them the animal, and that
ref has to belong to something really settled. The same determinism that makes the scan idempotent
makes every pet recomputable, which is the whole of the check.

### The six checks

`src/pets/attest.ts`, run per pet against a ledger read once per snapshot — `pet_actions` by key, and
what `pet_purchases` paid for by pet. No walk of the source tables, so it costs two queries a
snapshot rather than a query a card.

| Flaw           | Catches                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `unrecorded`   | No rolled action claims it. A row appended to `pets` alone fails here, which is the cheap forgery.  |
| `misdated`     | It hatched at a different moment than the action it names was settled. The hour decides `nocturne`. |
| `impossible`   | Its species, or its seed, is not something that origin can produce.                                 |
| `overfed`      | It has grown by more beats than its purchases paid for.                                             |
| `broken-chain` | Its link, or one before it, does not recompute. Catches an edit and a middle insertion.             |
| `unearned`     | The shipped rules would have hatched nothing on that action. Raised only against this build's own.  |

The first flaw found is returned rather than all of them: the checks fall over each other, and a
misdated pet rolls a different hour and would report an impossible species too.

**`impossible` checks against every tier's candidate, not against the tier the roll landed on.**
Deliberately: the exact tier depends on the weight table, which this build ships and an older build
may have shipped differently. A pet from a deployment that once tuned `pets.rarity` is still an
honestly earned pet, and a check that called it a forgery would take something away from the one
operator who had done nothing wrong. Weight-independent is still narrow — four species out of
twenty-seven, one per tier — because stage 3 is the hash either way. Filling every ladder did widen
this from the two or three a holey pool reached; four in twenty-seven is still tighter than three in
twenty was, and the property that matters is untouched.

### What a flaw costs

**Shown, never deleted.** A flagged pet keeps its row, its species and its origin line, draws with an
amber note saying which check it failed, and loses three controls: it cannot be fed, put out or
blended. Nothing is taken away, because a pet that never verified was never earned in the first
place — the "not a thing you can lose" row above stays honest.

Blending is the refusal that matters. It is the only route from a creature back into beats, so an
unchecked one would let a hand-written row be laundered into food for the honest animals beside it.
Feeding and placing only spend beats on something that is not real, which costs the forger and
nobody else; they are refused for tidiness, not for defence.

`place` refuses only on the way **in**. A pet that stops verifying while it stands in the vivarium
can always be taken out again, and refusing that would strand it in the rail.

### The chain

Every pet carries `chain`: its identity — id, species, seed, origin, hatch time — SHA-256'd onto the
link of the row written before it. `pets.name`, `fed`, `placed` and `dissolved_at` are **not** in it,
because all four move in ordinary use and a chain over them would break on the first rename.

**What it buys, precisely.** A pet cannot be edited, or slipped into the middle of the collection,
without every link after it going wrong. What it does not buy is protection against an _append_: a
forger writing the newest row chains onto the newest link as easily as the harness does. That is a
real limit, and it is why the chain is one check of several rather than the check.

Recomputed in insertion order, never `hatched_at` — a scan settling a backlog writes several pets
whose hatch times run backwards against the order they were chained in.

**It is a run of links, and a row from before the column ends one.** `chain` is in `PET_COLUMNS`, so a
vivarium raised before the authenticity columns gains it by `ALTER TABLE` with every existing row
reading NULL. The link the _next_ pet writes is hashed onto whatever `lastChain()` hands back, and what
it hands back for a NULL newest row is `null` — the same answer it gives for an empty table. So the
replay has to break in the same place: a NULL-`chain` row **resets the running link and is skipped**,
rather than being hashed in and its result discarded. Skipping is what makes the two readings agree,
because `lastChain()` never saw those rows either.

Hashing them in instead is the mirror of the failure the tolerance was written for. `attestPet`
declines to judge a pre-chain pet, so the old collection looks fine — and then the first pet hatched
after the migration, and **every pet after it**, reads `broken-chain`: unfeedable, unplaceable,
unblendable, on the day the operator takes the build. What the migration promises is that a database
from before these columns keeps every pet it holds, and that promise is about the pets it goes on to
earn as much as the ones already in it. The break costs nothing the chain was buying: a pre-chain row
is unverifiable either way, and the run after it stays fully linked.

### The build stamp, and the replay

Taking the rates out of the config stops an operator dialling a vivarium into existence. It stops
nothing at all for one willing to edit `src/pets/rules.ts` and restart. Two columns and one replay
close that.

**Every pet records the build that rolled it** — `built_sha`, the install directory's HEAD, and
`built_clean`, whether that checkout carried uncommitted changes. The repo asked about is the
harness's own install, resolved from the module's own path exactly as
[21](21-self-update.md) does it, and **never `config.repoRoot`**: that is the codebase the fleet is
pointed at, it is dirty on a feature branch as a matter of course, and gating pets on it would switch
the vivarium off during normal operation. It reads through `execFileSync` once per process and
remembers the answer — the scan is synchronous and the install's HEAD cannot move under a running
build.

Three provenances ride on the wire. `official` and `unknown` draw nothing on the card; only
`modified` says so, because `unknown` is every pet from before the stamp and every deployment that is
not a git checkout, and drawing it would turn an honest collection into a wall of warnings.

**The replay** walks `pet_actions` in `rowid` order and asks, of each, whether the shipped constants
would have hatched anything. A pet against an action they would not have is `unearned`.

Two things about it are load-bearing:

- **It keeps one pity counter per kind, exactly as the scan does.** The counters are the only state
  the replay and `PetKeeper.scan` share, so counting globally on one side and per kind on the other
  makes them disagree about which actions pity forced — and the disagreement surfaces as `unearned`
  on an honest pet, not as anything red.
- **It reads the pity counter off the record, not off its own simulation.** A simulated counter that
  diverges once — one pet hatched under different rates, one restored backup — stays diverged, and
  every action after it is judged against a history that never happened. Taking the counter from the
  rows that actually hatched keeps each decision local and correct.
- **It accuses only a pet stamped by this same clean build.** Anything else was decided by constants
  this process does not hold. Judging it would mean telling an honest operator their collection is
  fake, on their machine, months later, over a rate somebody retuned in a release.

### What is not checked

**That the source row still exists.** Verifying an origin against the live escalations, plans and
claims would mean `collectActions`' seven-table walk on every snapshot, and it would turn a pruned
or restored source into an accusation. `pet_actions` is append-only and is taken as the evidence
instead.

The label lookup is not that check wearing a different hat, and must never become it. It asks six
tables for a handful of ids and its only possible answers are _a line of words_ or _nothing_: a ref
with no row yields `originLabel: null`, the card falls back to the ref it drew before, and the
attestation never sees it. **A missing source row is no label and never a flaw** — an operator who
pruned a claim or restored an older database has not forged anything.

## Sharp edges

- **A new operator action is added to `src/pets/scan.ts`'s source table, and nowhere else.** The
  temptation is to call the keeper from the route that settles it. That works, and it is also how the
  scan quietly stops being the thing that guarantees delivery — one source recorded at its call site
  and not in the table is a source that pays out only while that route is the one that settles it.
- **A rate is never a config key again.** Every number in `PET_RULES` is one an operator setting it
  could use to hatch a vivarium that looks exactly like an earned one, from inside the cockpit, with
  nothing anywhere able to tell. `test/pets.test.ts` asserts that `pets.enabled` and `pets.visible`
  are the only `pets.` paths in `configFields.ts` and that `PetPolicy` holds no number — the
  assertion is the fix, not the thing to loosen. A third key is a switch or it is a rate.
- **A check that could accuse a pet must decline on a database it cannot judge.** Three of the six
  already do: `broken-chain` skips a null link — **and the replay behind it skips that row too**, or
  the tolerance stops one row short of its own successors — `unearned` skips anything not stamped by
  this same clean build, and `impossible` checks every tier's candidate rather than the rolled one. All three
  exist for one reason — the worst failure this subsystem has is telling an honest operator their
  collection is fake, and it lands on somebody else's machine, months after the change that caused it,
  with nothing red anywhere.
- **A new check in `attest.ts` must be weight-independent, or it accuses honest pets.** The tier
  weights are a number this build ships; a database from a deployment that ran different ones is full
  of pets that were properly earned under them. A check that re-derives the exact tier calls every one
  of those a forgery, on a surface whose whole promise is that nothing is taken away — and it does it
  silently, on somebody else's machine, months later.
- **The roll is a hash, and must stay one.** `Math.random` anywhere in `src/pets/roll.ts` turns every
  re-read into a fresh chance at a pet, and the tables have no way to tell that from a first read.
  All three stages hash the same key under different salts, so they stay independent _and_
  reproducible.
- **Weighting stage 3 puts rarity back in two places.** The species pick is uniform within the tier
  on purpose. Adding weights there re-creates the drift Mark Two removed — the tier table would say
  one thing and the pools another, and the pools would quietly win.
- **A new species is a row in `SPECIES`, a member of some pool, and two sprite grids.** Miss the pool
  and it exists but can never be drawn; miss the grids and `Record<PetSpecies, …>` fails the web
  typecheck, which is the one of the three that is not silent.
- **Adding a member to a tier a pool already fills re-picks that tier for every past action.** Stage
  3 indexes the members by `hash32 % length`, so a second entry moves the answer for origins already
  hatched — and those pets then fail `impossible` on their own honest record. Filling an **empty**
  tier is safe for the same reason it is worth checking: it only ever adds to what
  `speciesCandidates` reaches. A pool edit is a question about the pets already out there, and the
  answer is not visible in a diff.
- **A rate is per kind, and every kind must be in `PET_RULES.rates`.** `Record<PetActionKind, …>`
  makes a missing kind a typecheck failure rather than a silent zero, which is the only reason it is
  safe to price them separately at all.
- **Nothing under `src/dispatcher/` may import `src/pets/`.** Asserted structurally in
  `test/pets.test.ts`, alongside the assertion that nothing under `src/mcp/` or `docs/prompt-templates/`
  ever names the vivarium to an agent.
