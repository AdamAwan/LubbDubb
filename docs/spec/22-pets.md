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

The one floor under it is a **clearance**: `beatsEarned` counts `usage_events` from the last one's
timestamp rather than from the beginning, which is what lets a cleared vivarium start at zero instead
of opening with every beat the deployment had ever earned. With no clearance recorded the floor is an
epoch before any timestamp the harness can hold, so the sum is every event there has ever been.

## The roll

Every qualifying operator action is rolled exactly once, in **three stages**, and every stage is a
**hash of the action's own identity**, never a random number:

```
hatches = hash32(`${kind}:${ref}`) % 10_000 < dropChance × 10_000   -- or forced, or the first ever
tier    = weighted pick from PET_RULES.rarity, using hash32(`${kind}:${ref}:tier`)
species = uniform pick from the kind's members of that tier, using hash32(`${kind}:${ref}:species`)
```

Every number in it comes from `PET_RULES` (`src/pets/rules.ts`) and none of them is a config key —
see [Authenticity](#authenticity) for why.

**Rarity is rolled once, globally.** It used to be an emergent accident of seven hand-tuned weight
tables — a triaged finding produced a rare 23% of the time and an answered escalation 5%, so no
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
at.** Changing `dropChance` re-rolls history for actions the scan has not reached yet, and does not
re-roll the ones it has.

### Pity

Actions since the last hatch are counted over `pet_actions`, and at `pets.pity` the next one is
forced whatever the hash says.

**Pity flips stage 1 and stops.** It never touches the tier: a pet you were given because you had
been unlucky is exactly as likely to be a mythic as one the roll granted. Paying out worse would
make a consolation a punishment; paying out better would make waiting the strategy.

Set to **twice the expected gap** (`2 / dropChance`) it is a ceiling rather than a schedule — you
can be unlucky, never more than twice-unlucky, and the roll still decides roughly six drops in
seven. Set near the expected gap it becomes the schedule instead: at `dropChance` 0.02 and pity 15
it supplied three pets in four, and lowering the drop chance moved nothing. Nothing stores the counter: a count is one query, and a stored total
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

Twenty species across four tiers. Each action kind declares its members **per tier**; the tier
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
| `speck`     | common   | a finding triaged                 |
| `patch`     | common   | the harness updating itself       |
| `warden`    | uncommon | an escalation answered            |
| `cinder`    | uncommon | a job launched, or a self-update  |
| `nocturne`  | uncommon | any action taken between 22 and 5 |
| `chit`      | uncommon | a human task settled              |
| `vellum`    | uncommon | a plan accepted                   |
| `drift`     | uncommon | a stack landing authorised        |
| `bramble`   | uncommon | a finding triaged                 |
| `lander`    | rare     | a landing, or a self-update       |
| `quill`     | rare     | an escalation or a plan           |
| `cairn`     | rare     | an escalation or a finding        |
| `ouroboros` | mythic   | the harness updating itself       |

**Every action carries three commons**: the two universals `pip` and `mote`, plus one signature of
its own. One common per pool put `pip` at 70% of hatches on five of the seven actions — a hundred
identical animals before anything else turned up, which is the boredom the extra six exist to fix.
No species now exceeds a fifth of hatches across a mixed workload, asserted in `test/pets.test.ts`.

### Ceilings, and degrading downward

A tier a pool cannot fill hands the roll **down** one tier at a time, never up. That is the only way
a ceiling is expressed: `human-task` and `job` hold no rare, so their rare and mythic rolls become
uncommon, and only `upgrade` holds a mythic at all. Degrading upward instead would make the scarcest
actions the easiest source of the scarcest animals — the inversion this design removed.

### The first action ever

The **deployment's first qualifying action, of any kind**, drops unconditionally and picks from the
table with the common weights removed. This is the only place the roll is overridden, and it exists
because the first thing an operator ever settles in the harness is the single most memorable action
they will take in it, and rolling a 98% chance of nothing on it is a waste of the one moment the
feature is guaranteed an audience.

It fires **once per deployment**, not once per kind, and the distinction is the whole of why the
rule is worth stating. Per kind it fired seven times — and because stripping the commons leaves most
tables holding exactly one non-common species by day, each of those seven was a _deterministic
rare_: a guaranteed `quill` on the first plan and again on the first finding, a guaranteed `lander`
on the first landing. That inverted the tiers it was meant to decorate. The rare species became the
easiest in the catalogue to collect, `nib` and `tuft` became the hardest — reachable only through a
roll that excludes them the one time it is certain to fire — and an afternoon that touched each kind
once ended with seven pets and most of the rare tier.

The flag is therefore carried across the scan rather than re-read per action. `petActionKeys` is
captured once before the loop, so a flag derived from it and never advanced would call _every_
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

| Kind         | Source                                                         |
| ------------ | -------------------------------------------------------------- |
| `escalation` | escalations with an answer                                     |
| `human-task` | `ask` tasks settled `done` — not declined, and not `close_out` |
| `plan`       | plans that reached `active`                                    |
| `landing`    | stack landings recorded                                        |
| `job`        | jobs launched from the cockpit, which carry no `originRef`     |
| `finding`    | findings triaged — promoted, filed or dismissed                |
| `upgrade`    | a self-update applied, keyed on the commit it accepted         |

Three exclusions are deliberate. A **declined** human task is the operator saying the ask should not
have been made, and a **`close_out`** one is the harness's own, which the harness also settles — so
neither is a person doing work. A **requeued** job carries an `originRef`, which marks it as the
harness redoing work a crash lost rather than an operator starting something. And a **retrospective**
is written by an agent, not by a person, which is why it is absent from a list it would otherwise
obviously belong to.

Adding a source is an entry in that table and a row in the loot tables. Nothing else changes, and a
source nobody adds is invisible rather than broken.

## Blending a duplicate

The catalogue is twenty and the vivarium holds four, so duplicates are the common case rather than
the edge. Blending dissolves one back into beats at `blendYield × growth` — a mythic is worth four
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

**`pet_actions` survives it, and that is the load-bearing part.** The table is the scan's watermark,
so the actions a released collection hatched from are still marked as rolled and the next scan writes
nothing. Clearing it too would read as the tidier wipe and would undo itself on the first pulse — the
same creatures, out of the same history, by the same hashes. The cost is the honest one: the actions
behind a cleared collection are spent, the deployment's one first-action guarantee stays spent with
them, and the vivarium fills again from what the operator does **next**.

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
| `POST /api/pets/:id/feed`  | Spends beats on one pet. Refuses more than the balance.          |
| `POST /api/pets/:id/name`  | Renames it. An empty name restores the species' display name.    |
| `POST /api/pets/:id/place` | Puts it in the vivarium or takes it out. Refuses a fifth.        |
| `POST /api/pets/:id/blend` | Dissolves a duplicate into beats. Refuses the last of a species. |

There is no read route. `PetState` rides on the state snapshot with everything else the cockpit
draws, so the vivarium updates on the same socket as the rail above it — and it is **null** rather
than empty when `pets.enabled` is off, so the cockpit draws nothing at all instead of an enclosure
that reads as a deployment nobody has used.

## Persistence

`src/store/pets.ts`, five tables. A new table needs no `ColumnMigrations` entry — but `pets` is no
longer new, so **`dissolved_at` has one**, in `PET_COLUMNS`. Without it the column is invisible on
every database from before blending existed, and invisible here means every historical pet reads as
alive again ([14](14-persistence.md#migrations)).

| Table           | Holds                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pets`          | One row per hatched pet. `UNIQUE (origin_kind, origin_ref)` is what makes the scan idempotent. Also carries `built_sha`, `built_clean` and `chain`. |
| `pet_actions`   | One row per operator action rolled, hatched or not, keyed `(kind, ref)`.                                                                            |
| `pet_purchases` | One row per beat spent, with the pet it was spent on. The only source of `beatsSpent`.                                                              |
| `pet_blends`    | One row per duplicate blended, with what it credited. The only source of the blend half of `beatsEarned`.                                           |
| `pet_resets`    | One row per clearance, keyed by its name. Its timestamp is the floor `beatsEarned` counts spend from.                                               |

`built_sha`, `built_clean` and `chain` are in `PET_COLUMNS` beside `dissolved_at`, for the same
reason. Each of them reads as a _weaker_ claim when absent rather than a false one, which is what lets
a database from before them keep every pet it holds.

**There is no scan cursor.** `pet_actions` is the watermark: an action whose key is already in it is
skipped rather than re-rolled, which is stronger than a timestamp high-water mark and needs nothing
kept in step. A source whose own timestamp moves under it — a plan re-saved, a finding re-triaged —
cannot pay out twice or consume a second slot of the pity counter.

`pets.fed` is a cached sum of that pet's purchases, kept because the vivarium reads it on every
snapshot and the panel reads it per card. The purchase and the increment are written in one
transaction, so there is no window in which a pet has been paid for and not grown.

## Configuration

| Key            | Default | Does                                                        |
| -------------- | ------- | ----------------------------------------------------------- |
| `pets.enabled` | `true`  | Off stops the scan and hides the vivarium. Nothing is lost. |

**That is the whole of it, and the shortness is the point.** `beatsPerDollar`, `dropChance`, `pity`,
`rarity` and `blendYield` were all keys here once. Each of them was a way of writing a pet into
existence without doing anything: `dropChance: 1` hatches on every action, `pity: 1` does the same by
another road, a `rarity` table zeroed everywhere but `mythic` turns the scarcest animal in the
catalogue into the only one, and a large enough `beatsPerDollar` raises a whole vivarium on a single
dollar. None of it reads as cheating from inside the cockpit — the pets arrive through the ordinary
scan, carry real origin lines, and look exactly like earned ones.

They live in `PET_RULES` (`src/pets/rules.ts`) now, frozen, identical on every deployment:

| Rate             | Value                                            | Does                                                         |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| `dropChance`     | `0.02`                                           | Per qualifying action, before pity.                          |
| `pity`           | `100`                                            | Actions without a hatch before one is forced.                |
| `rarity`         | `{common 700, uncommon 200, rare 80, mythic 20}` | The one tier table stage 2 rolls.                            |
| `beatsPerDollar` | `25`                                             | The conversion.                                              |
| `blendYield`     | `500`                                            | Beats a blended duplicate hands back, per point of `growth`. |

The defaults are set so a pet is an event rather than a receipt: one guaranteed drop to open the
vivarium, and roughly one per thirteen actions after it. At a fleet spending thirty dollars a day an
adult common is about ten days of feeding.

`dropChance` and `pity` are two limits over one rate, and the **lower one wins** — which is worth
reading off the arithmetic rather than the table, because the table makes them look independent. At
`0.02` the roll misses ninety-nine times running rarely enough that the roll keeps the decision;
setting pity near the expected gap is what takes it away. An empty vivarium is the failure mode worth
watching for, and the answer to one is now a change in this table, in a release everybody gets,
rather than a dial one deployment turns and the rest do not.

`enabled` survives because off is the one direction that cannot mint anything.

`PetKeeper` takes the rates as a third constructor argument, defaulted to `PET_RULES`. That is a
**test seam and nothing else** — `src/system.ts` passes two arguments, and `test/pets.test.ts`
asserts that `configFields.ts` exposes `pets.enabled` alone and that `PetPolicy` holds no number.

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
the animal is a **property of the action's identity** — an origin key reaches two or three species
out of twenty, and never the one you wanted. A forger has to grind for an origin ref that happens to give them the animal, and that
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
operator who had done nothing wrong. Weight-independent is still narrow — two or three species out of
twenty — because stage 3 is the hash either way.

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

- **It reads the pity counter off the record, not off its own simulation.** A simulated counter that
  diverges once — one pet hatched under different rates, one restored backup — stays diverged, and
  every action after it is judged against a history that never happened. Taking the counter from the
  rows that actually hatched keeps each decision local and correct.
- **It accuses only a pet stamped by this same clean build.** Anything else was decided by constants
  this process does not hold. Judging it would mean telling an honest operator their collection is
  fake, on their machine, months later, over a rate somebody retuned in a release.

### What is not checked

**That the source row still exists.** Verifying an origin against the live escalations, plans and
findings would mean `collectActions`' seven-table walk on every snapshot, and it would turn a pruned
or restored source into an accusation. `pet_actions` is append-only and is taken as the evidence
instead.

## Sharp edges

- **A new operator action is added to `src/pets/scan.ts`'s source table, and nowhere else.** The
  temptation is to call the keeper from the route that settles it. That works, and it is also how the
  scan quietly stops being the thing that guarantees delivery — one source recorded at its call site
  and not in the table is a source that pays out only while that route is the one that settles it.
- **A rate is never a config key again.** Every number in `PET_RULES` is one an operator setting it
  could use to hatch a vivarium that looks exactly like an earned one, from inside the cockpit, with
  nothing anywhere able to tell. `test/pets.test.ts` asserts that `pets.enabled` is the only `pets.`
  path in `configFields.ts` and that `PetPolicy` holds no number — the assertion is the fix, not the
  thing to loosen.
- **A check that could accuse a pet must decline on a database it cannot judge.** Three of the six
  already do: `broken-chain` skips a null link, `unearned` skips anything not stamped by this same
  clean build, and `impossible` checks every tier's candidate rather than the rolled one. All three
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
- **Nothing under `src/dispatcher/` may import `src/pets/`.** Asserted structurally in
  `test/pets.test.ts`, alongside the assertion that nothing under `src/mcp/` or `docs/prompt-templates/`
  ever names the vivarium to an agent.
