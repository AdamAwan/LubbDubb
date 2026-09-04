# 33 — Usage metrics

Every reading the harness keeps is about the **fleet**: what it spent, whether it worked, what it
came back for. Nothing is about the **operator**. So the question that decides where the next month
of work goes — _which parts of this are people actually using, and which are ceremony nobody
completes_ — is currently answered by memory and by taste.

This is that question made durable. It is one more distance above the fleet, in the same direction
[28](28-cross-fleet-pool.md) went: a fleet is an engineer, so what one fleet's operator did is one
person's behaviour, and the pool is where several of them become a reading worth acting on.

**It measures the harness's asks, the operator's answers, and the acts a person starts unprompted —
and nothing else.** Not productivity, not throughput, not who is fast. The unit is always _something
was put to a person, or reached for by one; what happened_. That framing is load-bearing and is
defended in [What this is not](#what-this-is-not).

## What already answers part of it

Almost nothing here is new measurement, which is the same claim [28](28-cross-fleet-pool.md) makes
and is held to the same standard: moving what exists is cheap and correct, and inventing a second
opinion about something already measured is the failure this repo keeps writing paragraphs about.

- **`src/pets/scan.ts`** already enumerates every operator action the harness can see — escalations
  answered, `ask` tasks completed, plans approved, stack landings authorised, operator-launched jobs,
  upgrades accepted — with `collectActions` stating exactly why it is one sweep over the settled
  records rather than a call at each settling route: a record written where the act happens stops
  counting, silently, the day a second path settles the same thing. The vivarium is the consumer
  today. That list is the operator-action vocabulary, and this reading takes it whole rather than
  writing a second one.
- **`src/mcpInsights.ts`** already holds the doctrine this reading needs most, over a different
  actor: [a count of zero is not a finding](#a-quiet-surface-is-four-different-facts).
- **`src/store/mcpCalls.ts`** is the one table in the tree that exists only to be read by a fold, and
  its three properties are the template for [the one new table](#the-one-new-table).
- **`src/insightsWindow.ts`** is the window, already decided once. This reading picks no span of its
  own.

## The event registry

Everything measured here is one vocabulary, declared once in `src/usage/events.ts` and named from
both sides of the wire. It is **two dimensions and a matrix**, not a flat list of event names, for
the reason `src/remedies/remedies.ts` is `RemedyCause` × `RemedyGuard` rather than forty strings: two
closed axes can be asked questions a flat enum cannot. _How much of what this fleet does is
rejecting?_ and _what happens to plans?_ are one `group by` each, and on a flat list they are neither.

### The subject and the verb

A **subject** is a thing the product offers. A **verb** is what a person did to it, and the verbs are
shared across subjects on purpose — `plan.reject` and `validation.reject` being the same verb is what
makes the first question above answerable.

| Verb      | Means                                                           |
| --------- | --------------------------------------------------------------- |
| `view`    | The surface was reached                                         |
| `expand`  | A disclosure inside it was opened                               |
| `filter`  | The view was re-cut — a filter, an ordering, a switch of layout |
| `create`  | A new one was made                                              |
| `edit`    | Its content was changed by a person                             |
| `accept`  | Approved, passed, authorised — the affirmative settle           |
| `reject`  | Refused, failed, declined — the negative settle                 |
| `defer`   | Put off, still owed                                             |
| `waive`   | Declared not needed, no longer owed                             |
| `abandon` | Dropped: not owed, and not done                                 |
| `stop`    | A running thing was halted by a person                          |
| `undo`    | A previous settle was taken back                                |
| `send`    | Something left the harness towards a person or a tracker        |

Not every verb applies to every subject, and which do is declared — `VERBS_BY_SUBJECT`, exactly the
shape and exactly the purpose of `CAUSES_BY_KIND`. An empty cell is a statement that the product
offers no such control, and the day it does, the cell is where it is added.

| Subject       | Verbs it offers                                          |
| ------------- | -------------------------------------------------------- |
| `plan`        | `view` `expand` `edit` `accept` `reject` `abandon`       |
| `goal`        | `view` `expand` `edit` `accept` `abandon`                |
| `pr`          | `view` `accept` `send`                                   |
| `validation`  | `view` `expand` `accept` `reject` `defer` `waive` `undo` |
| `review-pack` | `view` `expand` `send`                                   |
| `escalation`  | `view` `accept` `reject` `send`                          |
| `human-task`  | `view` `accept` `reject`                                 |
| `ticket`      | `view` `filter` `create`                                 |
| `feature`     | `view` `expand`                                          |
| `agent`       | `view` `expand` `send` `stop`                            |
| `obstacle`    | `view` `expand` `accept` `waive`                         |
| `local-run`   | `view` `create` `stop`                                   |
| `job`         | `view` `create` `stop`                                   |
| `retro`       | `view`                                                   |
| `scratchpad`  | `view` `edit`                                            |
| `insights`    | `view` `filter`                                          |
| `pool`        | `view` `filter`                                          |
| `config`      | `view` `edit`                                            |
| `upgrade`     | `view` `accept` `reject`                                 |
| `pet`         | `view` `edit`                                            |

**A subject is a thing, never a screen.** `pr` is the pull request wherever it is worked, so a
control that moves to another surface keeps its row and the history stays one series. Keying on the
screen is how a redesign silently resets every number it touches.

**Five cells were removed when the call sites were wired**, and the removals are the empty cell being
used as intended rather than a narrowing of the vocabulary. The pull request page draws no
disclosure, the cockpit cannot edit a tracker item's own content, the feature board offers no filter,
a retro is drawn flat and a pet's card is always whole — so `pr.expand`, `ticket.edit`,
`feature.filter`, `retro.expand` and `pet.expand` had no control behind them. A `ui` cell with no call
site is a **permanent silent zero**, which is the "never named" failure
[`src/mcpInsights.ts`](../../src/mcpInsights.ts) exists to diagnose, one actor over. Each comes back
on the day its control does.

### Each event declares where it is seen

The registry's third field, and the one that keeps `src/pets/scan.ts`' objection structurally
unreachable rather than merely remembered:

- **`ui`** — nothing durable records it, so the call site is the only witness. Every `view`,
  `expand` and `filter` is one of these: a person opening the pull request page leaves no trace in
  any table, and if the click does not say so, nothing does.
- **`record`** — a table already holds it. Approving a plan, waiving a check, retiring a goal: the
  ledger sweeps the record, and **the call site does not log it at all**.

That split is the whole of `collectActions`' argument, applied per event instead of per module. A
settle logged where it happens counts only while that route is the one that settles it; swept from
the record, a second route is picked up for free. And an event logged **both** ways is counted twice
by two readings that disagree quietly — which is why the helper below cannot express it.

### The helper

`logUsage` and the batcher behind it are `web/src/cockpit/usage.ts`.

```ts
/** Record one thing a person did. Fire-and-forget: never awaited, never throws. */
function logUsage(event: UiUsageEvent, at?: PlaceKey): void;
```

Called as `logUsage('plan.view')`, `logUsage('validation.expand')`, `logUsage('pr.view')`.

**The place is held by the module, not passed at every call site**, and the `at` parameter is the
override rather than the ordinary form. A `logUsage('plan.expand')` inside a disclosure has no
business knowing which surface it was drawn on, and a call site that had to say would say the wrong
thing the day the control moved; the cockpit's place plumbing states it once per navigation instead
(`notePlace`).

**Every `view` is emitted from the place, never from a navigation control.** `placeReach` maps a
`Place` to its surface and the `view` event reaching it emits, and `useCockpit` fires that on every
move. That is `collectActions`' argument one layer up: a `view` written where a nav button happens to
live counts only while _that_ button is the way in, and the count silently halves the day a second
control opens the same page.

**The event is a string from a union, not a member of an object**, and that is forced rather than
preferred: `web/src/` may name only `src/wire.ts`, and `test/wireContract.test.ts` asserts that
module contributes **no runtime** — so a `Usage.plan.view` const object cannot cross the wire without
either breaking that rule or being hand-copied into the SPA, which is the drift `src/wire.ts` exists
to end. A string literal union is erased entirely, autocompletes identically at the call site, and a
typo is still a compile error. `UsageEvent` is `` `${Subject}.${Verb}` `` narrowed by the matrix, so
`plan.defer` — a cell the table above leaves empty — does not typecheck.

Four properties, none optional:

1. **The parameter list is the privacy boundary.** There is nowhere to put a ref, an id, a title or a
   note, so none can be recorded by a call site in a hurry. The `PlaceKey` is from the same closed
   vocabulary. This is the rule the digest depends on, enforced by a signature rather than by review.
2. **`UiUsageEvent` is the `ui`-sourced subset**, so passing a `record` event is a compile error and
   the double count above is unreachable.
3. **It returns `void` and cannot throw**, for `src/store/mcpCalls.ts`' second reason exactly: a
   telemetry write must never turn a working control into a broken one.
4. **It is called for its effect and batched**, never once per event over the wire.

### Adding one is one line

A new subject is a row in `VERBS_BY_SUBJECT` plus its label; a new verb on an existing subject is one
entry in that row. The copy registry is a `Record` over the union, so a value with no label does not
compile — the `CAUSE_COPY` discipline, and the reason the panel never restates a name the server
owns. The digest section and the folds are keyed off the registry, so neither is edited: a `ui` event
added on Monday appears in the aggregate on Tuesday, with its label, once a call site logs it. A
`record` event needs its sweep as well, [and the digest carries only the first
half](#it-carries-the-ui-half-of-the-registry-by-declaration).

## The three readings

### The operator ledger

`src/operatorInsights.ts` — `buildOperatorInsights`, a fold, no new table, sibling to
`src/spendInsights.ts` and `src/reliabilityInsights.ts` and derived for their reason exactly. It is
served by `GET /api/usage` (`src/server/routes/usage.ts`), which resolves the window once and passes
it down.

**Two halves, and they are two different questions.** An _ask_ is the harness stopping and waiting
for a person; an _act_ is a person reaching in when nothing asked them to. Folded together they
would produce one meaningless "operator activity" figure — the measure this document
[refuses to be](#what-this-is-not) — and they want opposite readings: an ask is judged by whether it
was answered and what waiting for it cost, an act by whether it happened at all, because an act
nobody ever performs is a control nobody needs.

**The asks**, one row each, over the window:

| Ask                | The record it is folded from                                                          |
| ------------------ | ------------------------------------------------------------------------------------- |
| Escalation         | `escalations` — `answeredAt` against `dismissed`                                      |
| Human task         | `human_tasks`, `kind = 'ask'` — `done` against `declined`                             |
| Plan approval      | `proposals`, `kind = 'plan'` — `createdAt` and `decidedAt`                            |
| Obstacle ownership | `obstacles` — [27](27-obstacles.md)                                                   |
| Validation bench   | `human_tasks`, `kind = 'validate'` — the close-out obligation, [20](20-validation.md) |
| Upgrade            | the upgrade intent — [21](21-self-update.md)                                          |

**Plan approval is folded from `proposals`, not from `plans`.** The `plans` table carries no stamp
for entering or leaving `awaiting_approval`, and `updatedAt` moves afterwards for reasons that are
the fleet's — so a wait measured from it would be measured from the wrong instant, in the one column
that exists to price a wait. The proposal _is_ the ask, and it is stamped on both ends.

**The upgrade row can only ever describe the intent that stands.** `upgrade_intent` is a single
mutable row with no history ([21](21-self-update.md)), so the row is at most one datum and a declined
upgrade leaves nothing behind. It stays a row because the alternative is a reading that silently
omits the one ask that parks the whole fleet.

**The acts**, over records that are equally already kept:

| Act                   | The record it is folded from                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Authorising a landing | the landing row, which exists only because somebody clicked                                                                     |
| Amending a plan       | the amendment proposal and its application (`src/plans/planAmendment.ts`)                                                       |
| Abandoning a plan     | `PlanStatus` reaching `abandoned`                                                                                               |
| Settling a check      | `ValidationCheckState`, with `ValidationCheckResultBy` saying whether a person or the fleet settled it — [20](20-validation.md) |
| Concluding a goal     | the issue conclusions, `by = 'operator'` — [14](14-persistence.md#issue-verdicts-and-the-exclusion-matrix)                      |
| Stopping an agent     | the run's `killed` / `interrupted` outcome, already counted by `src/reliabilityInsights.ts`                                     |

**Authorising a landing is an act and not an ask**, though it settles something: the row exists only
because somebody clicked, and nothing anywhere records that a landable stack was ever put in front of
them. An ask row with no recorded offer would report a settle rate against a denominator made of its
own answers.

**Three acts have no row, because nothing writes them down**, and inventing one would be a permanent
zero with nothing saying why:

- **Un-watching a goal** is the _removal_ of a label, which nothing writes back (`src/watchLabels.ts`)
  and which `WorldEventKind` has no member for — [06](06-issue-pickup.md).
- **Changing configuration** rewrites `lubbdubb.config.json` in place, with no row behind it —
  [02](02-configuration.md).
- **Sending a plan back** flips the plan's status and settles what hung off it, and records nowhere
  that a person did — [08](08-planning.md).

Each becomes a row on the day a record exists. Until then the registry carries their copy and marks
them `ui`, which is the honest half of the split.

and four figures per row: **asked** (or **available**), **answered** (or **done**), **declined**, and
**still open past the window**. Plus two the others exist to support:

- **Time to answer**, median. How long the harness waits on a person for this kind of thing.
- **Parked cost**, in dollars. What the fleet did _not_ do while it waited, priced against
  `usage_events` the way every other cost reading here is priced.

**Everything but the last count is measured _inside_ the window; the last is measured _against_ it.**
"Asked" is what was raised in the window, "answered" and "declined" are what settled in it, and
**still open past the window** is what is open now and was already open when the window began —
outstanding for longer than the whole span. That is the only way to say _too long_ with one control
serving six spans.

**`null` is never zero.** A row whose record cannot answer a column ships `null` for it, which is
`src/mcpInsights.ts`' doctrine applied one actor over: an obstacle's `updated_at` moves on every
sighting, so there is no instant to measure a wait to, and a landing records the click and never the
offer. A panel drawing a zero there would be manufacturing a finding out of a missing column.

#### How a wait is priced

The parked cost is a **product of two figures, and both ship**: the wait, clipped to the window, and
the fleet's own burn over that same window in dollars per hour — summed from `usage_events` and
divided by the elapsed span. An hour of waiting is worth what this fleet actually spends in an hour;
on a quiet week that is a small number for reasons that have nothing to do with the ask, and a reader
acting on the product is entitled to see which half moved.

The window is the one control ([18](18-observability.md#the-window)), so the numerator and the
denominator describe the same stretch by construction. `local_run_cost_deltas` is deliberately **not**
added in: a local run is the operator's own machine, and the question is what the _fleet_ would have
done.

**The parked cost is the row that makes this worth building.** "This panel is unused" is weak
evidence for removing anything — it is at least four different facts, below. "This ask parks the
fleet for six hours and is declined four times in five" is a decision, and it is not available from
any reading the harness keeps today.

**A decline is not a failure.** An operator declining an ask is the harness having asked for the
wrong thing, and the two columns stay separate for the reason `src/reliabilityInsights.ts` keeps
`killed` out of `completionRate`: folded together, a well-steered fleet and a broken one draw the
same shape.

### Surface reach

The one signal genuinely absent from the tree: nothing records what an operator **looked at**.

It is cheap here only because the cockpit's place is already the address bar
(`web/src/cockpit/place.ts`, [17](17-cockpit.md#the-address-bar)). A surface-reach row is a `Place`
transition — a value from a closed vocabulary the cockpit already owns — and never a URL, never a
title, never a ref. That is not a privacy nicety bolted on afterwards; it is what lets the aggregate
cross to the pool at all, and it is carried by the column's type rather than by a scrubbing pass.

Five columns and no more: the **subject** and the **verb** from
[the registry](#the-event-registry), the place key it was seen at, when, and whether the place was
reached by a link or by a direct address. A `view` row is a surface reached; every other verb is
something done there.

**The verb is a key and not a bit.** A bare "something was clicked" ranks a surface and answers
nothing about it: _did anyone amend a plan_ and _did anyone approve one_ are different questions with
different consequences, and on one boolean they are the same row.

**The fifth is what makes a quiet surface diagnosable.** `never-linked` is a verdict about the
harness's own navigation rather than about the operator, and it can only be told from
`linked-never-visited` if a visit records how it was arrived at.

**And the arrival evidence it is told from is read unwindowed.** `linkedSubjectsEverReached` asks
whether the cockpit has _ever_ carried anybody to a subject, over all time — the one read in
`src/store/surfaceReach.ts` that is not windowed, for `lastMcpCallByTool`'s reason. "No link to this
exists" is a claim about the product; scoped to the window it would flip to "a link exists and nobody
took it" on the window control alone, which is a verdict about the operator wearing the other one's
clothes.

A `go` inside the cockpit is `linked`; the first place of a session and every `popstate` are
`direct`. The back button is the browser's navigation rather than the product's, and counting it as a
link would report that the harness routes _to_ a surface it in fact only ever routes away from.

#### What reach cannot tell you, and the pairing that can

**Whether something was _read_ is not observable here, and no column is added to pretend otherwise.**
Dwell says a surface was open, not that anybody looked at it; scroll depth, which is the usual answer,
is refused outright — it is the [session recording](#what-this-is-not) this document will not become,
and it would still be measuring the pointer rather than the person.

What answers the question honestly is a **pairing**, and it needs both halves of this reading at once:
_an ask answered, against whether the surface the ask is about was ever reached before it was
answered_. "Two in five plan approvals happen without the plan ever being opened" is a finding about
whether plans are read that no dwell threshold can give, it is a partition rather than an estimate,
and it comes free from a fold across the ledger and the reach table.

The same pairing carries every ask on the list: a validation bench settled without the validation
section ever being opened, a stack landed without the pull request page being reached, a goal retired
without its record being read. **That pairing is the reading this whole tier exists for**, and a
surface ranking is what it produces on the way.

**The cockpit is the only writer, and it writes in batches.** One request per navigation, against a
harness the console already polls every couple of seconds, is a self-inflicted load with no reading
behind it. Transitions are coalesced in the client and flushed on a clock and on unload; a lost
flush costs a row and nothing else, which is the only reason coalescing is safe here. The unload flush
is a `pagehide` listener and a `keepalive` request — without the latter the last batch of every
session is lost, which is the batch that says what the operator was doing when they left.

**The batch is refused whole on a bad row, and `at` is not on the wire.** `POST /api/usage/events`
checks both keys against the registry _as a pair_ — `plan.defer` is two independently valid halves
and a combination that means nothing — because a server that quietly dropped a malformed row would
produce exactly the permanent silent zero this reading exists to make impossible. The refusal is a
returned value and a 400 ([16](16-http-api.md#request-validation)), and the client never sees it
because it never looks. The store stamps the batch as it lands, so a client clock cannot write the
future into a window fold and there is one fewer field for an identifier to hide in.

**A telemetry write must never be recorded as a fault, and never become one.** `logUsage` swallows its
own failures — the one place in the cockpit where a swallowed failure is correct, because the
alternative is a navigation that breaks over a metric. Everything behind the route is the harness's
own and routes through `errors.record` like anything else ([18](18-observability.md)); what is
deliberately _not_ an error is the operator's browser failing to deliver a row.

### The digest section

`usage` — a further section on the daily digest ([28](28-cross-fleet-pool.md#the-digest-arm)), keyed
by **subject and verb**, carrying **counts and never percentages**, on the same UTC day bucket, with
the same partial-day marking and the same ninety-day retention. It is `byUsage` on
`PoolDigestDocument`, folded by `byUsage` in `src/pool/digestArm.ts`, named in `digestSections`
(`src/store/pool.ts`) so the mirror stores it, and summed by `foldPoolDigest`
(`src/pool/aggregate.ts`).

**It carries no money, and that is not an omission.** What a person did has no dollar figure
anywhere in the harness, and deriving one here would be a new measurement invented for the pool
rather than a move of what exists — [the faults section](28-cross-fleet-pool.md#the-faults-section)'s
argument, one section over. `costUsd` is null on every row and the companion draws no cost column at
all.

**It sums across projects, and needs no project argument.** `byCheck` takes one because a check name
is a provider's own; both halves of this key are enums the harness owns, so the comparability
`byCheck` has to be narrowed into is a property of this section's data. The refusal is stated rather
than parameterised.

**The registry's two axes are the digest's key, and that is why it is two axes.** Both are closed
vocabularies the harness itself owns, so two fleets on two providers produce comparable rows by
construction and nobody has to agree on anything — the standing rule for every section, cleared here
without an exception. The place key stays local: it is the cockpit's own layout, which a redesign
moves, and a cross-fleet series keyed on it would break at a release rather than at a change of
behaviour.

**"How many people" is a count of fleets, and the aggregator gets it for nothing.** A fleet is an
engineer, so a fleet publishing a non-zero count for a key _is_ the evidence that that person did
that thing — and the number of fleets carrying a row for a key, against the number publishing at all
that day, is the reading. It needs no per-operator field, which is what
[the table](#the-one-new-table) refuses to have; it is the property that makes the refusal cost
nothing. **A count of events and a count of fleets are both shipped and are never confused**: one
operator amending forty plans and forty operators amending one each are the same event count and
opposite findings. `PoolRollupRow.count` is the first and `PoolRollupRow.fleets` the second, drawn
side by side against `PoolRollup.fleets.length` — the fleets publishing at all in the window — and
never summed together.

#### It carries the `ui` half of the registry, by declaration

The rows come from `surface_reach`, which is the one table in the tree that stamps **one act at a
time**. That is exactly [the `ui` half](#each-event-declares-where-it-is-seen) of the registry, and
the boundary is the registry's rather than a line drawn here: `EVENT_SOURCE` already declares which
events a call site witnesses and which a table holds.

A `record` event is **absent by declaration and never by omission**, which is the distinction that
matters. It is swept by [the operator ledger](#the-operator-ledger), which windows rather than
buckets by day, and whose row ids do not map onto `subject.verb` one-to-one — the validation _bench_
and one validation _check_ are both `validation` settled by a person, which is why `OperatorRowId`
exists in the first place. Publishing the ledger's rows here would need a second daily fold over the
same tables, and it would be partial: several acts the registry marks `record` are recorded without a
stamp for the act itself, so the section would ship a handful of honest keys beside a dozen permanent
silent zeros — the [never-named failure](#a-quiet-surface-is-four-different-facts) this whole reading
exists to make impossible, reintroduced at the last step.

**Nothing is withheld for policy, which is the rule that actually binds.** There is no per-section
opt-out and no field a fleet may drop: every fleet in the pool publishes the same key space, so a
zero is a real zero and a sum across nine fleets is a sum of nine. What is out of the key space is
out of it identically for everybody, and the registry says which and why. A `record` event joins on
the day its table can answer per day.

## A quiet surface is four different facts

The trap, stated in full at `src/mcpInsights.ts` for the tool channel and transferring to surfaces
without amendment. "Nobody opened the feature board this week" wants four different actions:

- **nobody could have reached it** — no link to it was drawn on any surface an operator visited;
- **it was reachable and nobody went** — the entry point is not landing, or the job never came up;
- **they went and it did nothing** — reached, never operated, which is the one case where the
  silence is the surface's own fault;
- **the console was dark** — nobody used the cockpit at all that week, and then no per-surface
  reading in that window means anything.

So this reading **does not ship counts for a panel to interpret.** It ships a verdict per surface
with the evidence behind it: `never-linked`, `linked-never-visited`, `visited-never-operated`,
`operated`, `console-dark`. A cockpit re-deriving that from three numbers would be a second opinion
drawn inches from the first — the objection `src/mcpInsights.ts` already makes, and the reason its
copy lives where it does.

`buildSurfaceReach` (`src/surfaceReachInsights.ts`) settles them on one ladder, and its order is the
whole of it. **`console-dark` outranks everything**, because a per-surface verdict drawn over a window
nobody was in is a finding manufactured out of an absent operator — a page of `never-linked` over the
week somebody was on holiday is four findings' worth of noise. Then `operated`, then
`visited-never-operated`, and the two silent verdicts last, told apart by the arrival evidence alone.
**Every subject gets a row**, so the reading is never a list of only what was used.

## The one new table

`src/store/surfaceReach.ts`, built to `src/store/mcpCalls.ts`' three properties, none of them
optional:

1. **Nothing gates on it.** No dispatch rule, desk or tool reads this store. The only reader is the
   fold. That is what makes recording safe to do on the path it observes.
2. **The write is called for its effect and its return is discarded.** A telemetry write that can
   turn a working navigation into a failed one is worse than no telemetry.
3. **Retention is stated and bounded** — ninety days, matching the digest's, dropped from the back.
   An unbounded table on a deployment that has been running for two years is a slow reading nobody
   sees coming.

Being a new table exempts it from `ColumnMigrations` **once**. A column added to it later needs an
additive `ALTER TABLE` like every other, and the rule that a table being new once does not keep it
exempt is stated at [14](14-persistence.md#migrations) and applies here in full.

**There is no identity column, and adding one is refused.** A fleet is an engineer
([28](28-cross-fleet-pool.md)), so the fleet id already carries whose behaviour a row describes, and
a second identifier inside the row would buy nothing while turning every row into something the
digest would then have to withhold. The digest cannot withhold: an optional field makes every
aggregate silently unreliable, which is why nothing in a digest may be withheld in the first place.
The constraint that keeps this shippable is that there is no per-operator field to leave out.

## Pool membership is the consent

**Joining the pool is the opt-in, and there is no second one.** A fleet that publishes a digest
publishes this section of it; a fleet that wants none of it does not join. A per-section opt-out is
refused for the reason the digest refuses every other one — a section some fleets withhold produces a
company-wide reading that is quietly a reading of the fleets that did not withhold it, drawn as if it
were everyone's, with nothing red.

What makes that a defensible position rather than a convenient one is
[what a row contains](#the-one-new-table): closed-vocabulary keys, counts, days. No titles, no refs,
no prose, no repository names, no operator identity. A digest row is already _a day, a key from an
enum the harness owns, and a number_, and this section does not widen that shape by a single field.

## What this is not

**Not a productivity measure.** Nothing here counts what a person got done, ranks fleets by activity,
or produces a number a manager could hold an engineer to. The asks are the harness's and the answers
are evidence about the **harness**: an ask that is always declined is a bad ask, and an ask nobody
answers within a day is a bad ask _with a price_.

**Not something a rule may read.** No dispatch rule, desk, ranking or prompt reads any of this. The
moment a rule gates on a usage count, the measurement changes the behaviour it measures and the
reading stops being about anything. This is the same fence [28](28-cross-fleet-pool.md) puts around
everything arriving from the pool, held for the same reason, and it is the one line here whose breach
would be visible in no panel at all.

**Not a session recorder.** No keystrokes, no scroll, no pointer, no free text, no screenshots, and
no per-goal or per-ticket rows. A place key and a dwell.

**Not a replacement for asking.** Three operators is a sample of three, and the reading says what
happened rather than why. It narrows where to ask; it does not answer.

## Where it sits

- **Routes** — `src/server/routes/usage.ts`, registered in `src/server/app.ts`'s `ROUTE_MODULES` and
  wrapped in `checked` ([16](16-http-api.md#request-validation)). It serves `GET /api/usage` today;
  the cockpit's batch write joins it as a `POST` on the same module with
  [surface reach](#surface-reach).
- **Panel** — `web/src/components/UsageTab.tsx`, a tab on the Insights page beside Economics,
  Reliability and MCP ([17](17-cockpit.md)), reading the same window control as its neighbours. It
  draws **no reference**: there is nothing on this payload to link to, and a `<Ref/>` here would be
  one drawn from a table that must never hold one.
- **Composition** — both folds are pure functions the route calls, like `buildSpendInsights` and
  `buildReliabilityInsights` beside them, so neither needs wiring of its own. The **store** for
  [surface reach](#surface-reach) is a `StoreContext` module that `Store` delegates to under the same
  names ([14](14-persistence.md#shape)), so `src/system.ts` reaches it through the `Store` it already
  builds — what `system.ts` gains is the boot-time retention sweep, beside `compactMcpCallArgs` and
  for its reason exactly.
- **The digest** — `byUsage` in `src/pool/digestArm.ts`, `digestSections` in `src/store/pool.ts`,
  `foldPoolDigest` and `poolUsageLabel` in `src/pool/aggregate.ts`, the companion's `SECTIONS` entry
  in `src/pool/markdown.ts`, and the table `web/src/components/PoolTab.tsx` draws. Nothing is wired
  into `src/system.ts`: `PoolDesk` derives the whole document on its clock and the section rides it.

## Build order

Four changes, each shippable, each answering something on its own:

0. **The registry.** _Built._ `src/usage/events.ts`: the matrix, the copy, and the `record`/`ui`
   split. No writer, no reader, no table — a vocabulary and nothing else. It went first because every
   stage below is keyed on it, and because that split is what stops stage 1 and stage 2 counting the
   same act twice. Nothing crosses `src/wire.ts` yet: the cockpit has no consumer until stage 2, and
   an export with no consumer is what `knip` is set to `error` about.
1. **The operator ledger.** _Built._ `src/operatorInsights.ts` and `GET /api/usage` — a fold over
   records that already exist: no table, no migration, no cockpit writer. It answers most of the
   original question, and it is the change that proves the framing before anything is stored for it.
2. **Surface reach.** _Built._ The table, the batching writer, the verdicts and the panel. The only
   stage that stores something new, and the only one carrying a migration.
3. **The digest section.** _Built._ Distribution, not measurement — the arm exists, and this is one
   more section through it. It moved no measurement and added no table: `byUsage` re-cuts
   `surface_reach` into UTC days and hands it to a transport that was already publishing five
   sections.
