# 20 — Validation

`src/validation/`. **Always on** — there is no switch. It spends no agent and gates nothing, so there
was never much to weigh in turning it off, and the cost of the switch was a branch at every call site
that read it plus a `validationEnabled` threaded through four layers to say "yes". A config file
still setting `validation.enabled` is warned about and ignored
([02](02-configuration.md#retired-keys)).

A plan says what is wrong, what will be done, and what makes each part done. It does not say **how
anyone checks the goal was met**. `verification` — one optional narrative field, "how anyone will
know the whole thing worked" ([08](08-planning.md)) — is read once while deciding whether to approve,
and nothing ever runs it. This is that field's executable form: an ordered set of **checks**, each a
**test plan** — a sequence of steps, each step assigned to a person or to the fleet — that ends in a
reading somebody records.

**The check set is written after the work is delivered, not at plan time.** The plan carries an
**intent hint** and nothing executable; the check set is authored by a validation planner dispatched
once the assessor says `delivered`. → [When the check set is written](#when-the-check-set-is-written)

## What it is not

Stated first, because each boundary is a thing the harness already does and would otherwise be
re-litigated:

| Not                  | Because                                                                                                                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A test suite         | `npm run check` runs on every branch. This is the layer above: checks needing a running harness, a real environment, a browser, or a person.                                                                                                                                             |
| Acceptance criteria  | Those are per **part**, ticked by a reviewer reading a diff ([08](08-planning.md)). A check is executed against the delivered goal.                                                                                                                                                      |
| CI                   | Nothing here gates a merge, and **no result is ever inferred from a build**.                                                                                                                                                                                                             |
| A credential store   | `validationRoot` holds fixtures and reference material. Which account a check needs is a line in its `do`; the account stays where it is.                                                                                                                                                |
| A blocker            | Nothing a check says holds a dispatch, a merge, a conclusion or a close. It changes what closing a goal _looks like_, and nothing else.                                                                                                                                                  |
| A run somewhere real | A check is a procedure and a reading. Assembling checks against an environment the work has **arrived** in, running the project's own specs against them and reading the result is [36](36-remote-validation.md), which writes its readings onto these rows and authors none of its own. |

## The bar

**A check is something that can only be found out by running the delivered goal.** Whatever the diff,
the test suite, the type checker or a green build settles is settled already — on every branch, before
anybody opens the sheet — so "the unit tests pass", "CI is green" or "the new module is wired into the
composition root" sends a person out to redo work that is done. Per-part `acceptance` is where a claim
a reviewer ticks off from the diff belongs ([08](08-planning.md)); a check is executed against the
goal.

The cost is not the wasted trip. The sheet is read as the list of things somebody still has to do, so
filler crowds out the one check that genuinely had to be carried out by hand, and an operator who
finds the first three trivial does not read the fourth. That is the same silence the rest of this
document is built against: the rows render, the counts are right, and the goal closes on a reading
nobody took.

What clears the bar is what a running system, a real environment or a person's eyes answers and
nothing else does:

- the built thing driven end to end somewhere real, and watched;
- the state it left behind — database rows, what a migration did to a database that existed _before_
  the change, files on disk, refs in a repository, a queued job;
- the logs, the error records and the metrics, for what is in them and what is not;
- a screen: what renders against real data, what survives a reload, where the back button goes;
- conditions no test stages — a restart mid-run, two at once, a slow or missing dependency, a real
  credential, real volume;
- the judgement call, where the answer is somebody's reading of the wording or of whether a number is
  believable beside the source it came from.

**Declaring no checks is a legitimate answer**, and the right one for a goal with nothing to run: a
refactor whose whole claim is that behaviour did not change has nothing left once the suite is green.
Its per-goal reading is null — nothing was declared — which is a third fact and not a synonym for
clear ([The flag](#the-flag)). Nothing counts checks and nothing rewards a longer list.

### One run is one check

Those six are ways of looking, not six checks. Everything a **single run of the delivered goal**
settles belongs to the one check that performs it — the screen it drew, the rows it wrote, the line in
the log, the file it left behind — and `expect` carries the list. "The new page renders" and "the row
is written" are one check, because the setup is the expensive part of both: split, it is written twice
and **performed** twice, to look at one run from two angles. A second check earns its place only when
the second look needs a genuinely different run: another environment, a fresh database, a restart, a
second person.

This is the same cost the bar is about, arriving by a different route. A check that fails the bar
wastes a trip; a journey cut into six checks wastes five setups and reads, on the sheet, as six
obligations — and the sheet is read as the list of what somebody still has to do. So most goals get
one check, two is ordinary, and three wants a reason.

### A precondition is not an ask

**What a check needs in order to be runnable is stated in its `do`, in the words that let the reader
go and get it** — "you need read access to the staging database (connection string in the team
vault)". It is read by the person running the check, at the moment they need it.

The alternative is what a resource declared `provided: false` does: it files a `human_tasks` row
([Resources](#resources)), which is a different person, a different queue and a different day. That is
right for a **file** somebody has to produce and hand over, and wrong for everything else — a login,
an environment, an account, a flag someone has to turn on. Filed as asks, a delivered goal opens by
asking four people for four things before anybody has looked at it, and none of those rows can be
settled by putting anything in the goal's validation directory, which is what the ask tells its reader
to do.

**Nothing enforces any of the three.** They are stated where the writing happens — the `issue-plan`
and `issue-replan` prompts, and the `validation_amend` tool's description — and not in
`ValidationSchema`, because a schema that recognised a test-suite check by its words would refuse the
legitimate one that runs a suite _inside a fixture repository_ — the shape of the example in
[The document block](#the-document-block). A grouping rule is less parseable still: no schema can see
that two checks share a setup. The bar is about what is worth writing, and worth is not a thing zod can
parse. The one half the harness does enforce is the one it can name: an `access` resource files no ask,
whatever `provided` says.

## When the check set is written

**Built**, apart from `steps` — the authoring move landed with today's check shape, and
[the test plan](#the-test-plan) is the layer above it.

**Not at plan time.** A planner writes against code that does not exist yet, so every check it writes
is a guess about a screen, a command or a table that the second part may move. That guess used to be
the design's central problem, and [Amendment](#amendment) is the apparatus built to survive it:
rewordings, withdrawn readings, the band, a line on the close-out and a note on the ticket. All of it
exists because the check set arrived too early to be right.

So it arrives late instead. **The check set is authored once, by a validation planner dispatched after
the assessor writes `delivered`**, against merged code, with every part settled and every pull request
closed. What the planner contributes is a **hint**: prose saying what it thinks needs checking and
why, carried on the plan document, read by an operator at the approval gate and handed to the
validation planner as input. It is not executable, it declares no checks, and nothing runs it.

|            | **The hint** (plan time)                | **The check set** (after `delivered`)      |
| ---------- | --------------------------------------- | ------------------------------------------ |
| Written by | The planner, in the plan document       | The validation planner, its own dispatch   |
| Against    | Code that does not exist yet            | Merged code                                |
| Shape      | Prose intent                            | Test plans — ordered, assigned, executable |
| Read by    | An operator deciding whether to approve | The validation planner, then the bench     |
| Binds      | Nothing                                 | The sheet                                  |

The machinery is five pieces and each one is named here so a later change cannot quietly drop one:
rule `validation-plan` (`src/dispatcher/rules/validationPlan.ts`, a `DISPATCH_PIPELINE` entry
registered in `STAGES`), the origin `issue:<n>:validate-plan` classified in `src/issueOrigins.ts`,
the `validation-plan` prompt, the `validation_plan` tool, and the `validation_plans` row that records
the answer. The rule dispatches a **code** agent into a read-only checkout of the default branch —
the delivered state is what a check is written against — and it is gated on three things: the goal is
parked as delivered, it has a plan, and its check set has not been authored. It ranks directly above
`validate-check`, on that rule's own argument one step earlier: it produces the input every other
validation rule reads, and validation blocks nothing, so it sits below every rule that makes product
work.

**A goal already carrying checks is left alone, whoever wrote them.** A plan document from before
this change ingested a set an operator may be halfway through, and a validation planner speaks for
the whole set — dispatching one over those rows would supersede work in progress. So the rule's gate
is _authored **or** already has live checks_, and only the first is a stamp.

**Why after `delivered` and not at the last merged pull request.** "No open PR" is the assessor's own
trigger, and the assessor may answer `more_work` — which sends the goal back round, lands more pull
requests, and moves the code the check set was just written against. `delivered` is the first moment
nothing further is coming. → [06](06-issue-pickup.md)

**Sheet assembly waits for it.** An arrival assembles a sheet from the check set
([36](36-remote-validation.md)), and a deployment fast enough to arrive before the validation planner
has finished would assemble one with no `check` rows on it — an operator meeting a bench that offers
only the watch-derived rows, which reads as a misconfiguration and is not one. It is the same shape as
a null `area`, one subsystem over, and the same remedy: the gate is explicit rather than a race
nobody lost yet. `sheetableArrivals` defers such an arrival unstamped, and **cuts the staleness guard
first** — which is the half the implementation forced. Authoring routinely takes longer than the two
probe intervals that guard allows, so an arrival held for the planner and then aged out would lose
its sheet for good; cutting staleness first means the arrivals that would flood in on the pulse an
operator turns this on are stamped and not assembled before authoring is consulted at all, and only
an arrival that entered fresh waits — for as long as the planner takes.
→ [36](36-remote-validation.md#when-a-sheet-is-assembled-and-what-runs-without-asking)

**The hint is an input, and departures are stated.** A validation planner that does not read the hint
makes it theatre, and the operator who read it at the approval gate learned nothing. So it is appended
to the validation-planning prompt, and the planner says where it went a different way and why. An
operator who approved a goal on the strength of an intent is entitled to see what became of it.

**Declaring no checks stays a legitimate answer, and now it carries a reason.** A goal whose permanent
suite coverage already settles the question gets an empty check set — which is correct, and
indistinguishable from a validation planner that did nothing. The per-goal reading is null, "a third
fact and not a synonym for clear" ([The flag](#the-flag)), and the validation planner's note is what
tells the difference: _considered; area `Checkout Tests` now asserts the confirmation step and nothing
else needs a run_. Null with no account of itself is the failure this document keeps meeting.

Both are refusals rather than conventions: `validation_plan` requires `note` on every call, and
requires `emptyReason` on a call declaring no checks. A refused call authors nothing — the stamp is
not written, so the sheet keeps waiting rather than assembling off a set nobody wrote.

### Saying nothing was worth running

**Built.** A required `emptyReason` an operator cannot read is a refusal that bought nothing, and for
three slices that is what it was: the record was written, read by the dispatch rule and by sheet
assembly, and reached no surface at all. The only place an operator meets a goal with no checks said
_No validation plan. Nothing checks that this goal actually works_ — which is one of the three
things an empty section can mean, asserted over the other two.

So `ValidationPlanRecord` is on the wire (`CockpitState.validationPlans`) and the empty section draws
what the record actually says:

- **`emptyReason` set** — the planner read the delivered goal and declared no checks, in its own
  words. That is a verdict, and the section says so.
- **Not authored yet** — the set is written after delivery, so before then there is nothing to run
  and nothing is wrong. The plan's **hint** is drawn here, because it is the only thing anybody has
  said about validating this goal yet and it is exactly what an operator is looking for.
- **Authored, and still nothing** — the old sentence, which is now true where it is drawn: no
  account of the absence exists, and closing the goal is a judgement call.

Beside a set that **does** exist, the same record's `note` is drawn above the rows. Without it the
hint is theatre in the other direction: an operator read the intent at the approval gate, and the set
in front of them was written days later against code that hint could not see.

**What a `coverage` part built is not drawn beside an empty set, and that is settled.** The bench
could name the area a permanent test part added and put it beside the absence — the fact is in the
harness, and it was the last open question on this design. It stays with the planner's sentence, for
the reason `sheetFoldLine` is folded on the server
([36](36-remote-validation.md#the-cockpit)): the planner **read** that part, weighed it against
the delivered code and wrote what it concluded, and an area drawn beside that sentence is a second
opinion about the same fact, assembled by a surface that read neither. Where the two agree it is
noise; where they disagree — a part that built an area the planner judged irrelevant — the surface is
contradicting the only reader that looked. The empty state is one sentence with a reason under it,
and the reason is the agent's.

### A permanent test influences and never dictates

A goal may build or amend a spec in the project's own browser suite. That is buildable work: a
`coverage` plan part, declared at plan time because post-merge is too late to build anything, reviewed
and merged like any other part, holding the goal exactly as any other part does
([36](36-remote-validation.md#browser-coverage-is-a-plan-part-and-it-holds-the-goal)).

**It is a separate mechanism, and the validation planner is told about it rather than bound by it.**
What the part produced — the area it covers, what it now asserts — is handed over as input. From there
the validation planner may decide the permanent test settles the question and declare nothing; may
declare a check whose one step runs that area; or may run it and look at more besides, taking
screenshots and reading the database after it.

**A coverage part must never emit a check of its own.** The temptation is obvious — the part knows its
area, the check wants one — and it reinstates precisely what this design removes: a row on the sheet
that no one chose, coloured by a run nobody asked for. A permanent test earns its keep by running in
the deployment pipeline on every change, not by appearing on one goal's bench.

## The check

One row per check, keyed on `(goal, id)` — the goal's `origin_ref` (`issue:<n>`), `src/store/validation.ts`.

**Keyed on the goal, not the plan**, which is what this document has said validation _is_ since the
first line of it. A plan is 1:1 with a goal, which is what let `plan_id` stand in for the goal for two
changes; it was the wrong key wearing the right key's clothes, and it got more expensive to change
with every check row recorded against it. A check outlives any one plan of the work, and nothing about
it is a property of the decomposition. Databases written under the old key are rebuilt onto the new
one at boot, `id` and `letter` untouched
([14](14-persistence.md#rebuilding-a-table-whose-key-changed)).

| Field            | What it is                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | Author-chosen kebab-case slug. **The merge key** — an amendment merges on it, so it must survive.                                                                                                                                                 |
| `letter`         | `A`, `B`, `C`… — the human-typeable handle. Assigned at ingestion. See below.                                                                                                                                                                     |
| `title`          | One line, the headline.                                                                                                                                                                                                                           |
| `do`             | The procedure, markdown. Prose form, still accepted and still what a human-only check usually carries.                                                                                                                                            |
| `steps`          | The procedure in executable form: an ordered list, each step assigned. Optional — a check has `do`, or `steps`, or both. → [The test plan](#the-test-plan)                                                                                        |
| `expect`         | What a pass looks like. Where `steps` carries per-step expectations, this is what the run as a whole has to satisfy.                                                                                                                              |
| `uses`           | Resource **names**, not paths.                                                                                                                                                                                                                    |
| `covers`         | Part slugs this check exercises. Optional, any number.                                                                                                                                                                                            |
| `area`           | The suite area a remote run selects this check by, set by a `suite` step naming one. Null is a check no suite area runs — which is now the ordinary case rather than a failure. → [36](36-remote-validation.md#how-a-check-comes-to-have-an-area) |
| `fleetCandidate` | The planner's nomination that an agent could run this, with `candidateWhy`. **Dispatches nothing.**                                                                                                                                               |
| `actor`          | `human` or `fleet` — who is expected to run it. **The operator's decision and only theirs.**                                                                                                                                                      |
| `handbackNote`   | Why the fleet gave it back. Null until it does, and cleared by the next reading.                                                                                                                                                                  |
| `state`          | Below.                                                                                                                                                                                                                                            |

### States

`unrun` → `passed` | `failed`, plus `waived`, `deferred` and `captured`, and one way back to `unrun`
from any of them.

| State      | What it means                                                                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unrun`    | Nobody has got to it. It is also what a row from before any later state was added reads as — `checkStateOf` narrows anything unrecognised here.                                                                                    |
| `passed`   | Somebody ran the procedure and saw what it expects.                                                                                                                                                                                |
| `failed`   | Somebody ran it and did not. Rule `validation-failed` is the consumer.                                                                                                                                                             |
| `waived`   | An operator decided it does not need running.                                                                                                                                                                                      |
| `deferred` | It is waiting on something named, with `deferUntil` where the deferral said when.                                                                                                                                                  |
| `captured` | A `screenshot` step took the picture and it is on the row, waiting to be looked at. It asserts nothing, and a person's reading is what makes it passed or failed. Written by either channel that can take one — the goal's own validation sheet, and the `validate-check` dispatch where the fleet can reach the screen. → [36](36-remote-validation.md#a-screen-from-the-sheets-own-run) |

**`captured` is a value on the existing column and needs no `ALTER TABLE`**, exactly as `result_by`
gained `agent`, `desktop` and `spec`. It is counted apart from `unrun` on `ValidationVerdict`: the
two ask different things of whoever reads them — _nobody has started_ against _the only thing left
is your eyes_.

Every transition carries a **required note**, and the note is the check's one current reading:
`recordValidationResult` writes the whole set together and clears what the last reading left behind,
so a check cannot render "passed — the test environment is rebuilt on Thursday". A result is
recorded on the row rather than appended to a table for `note_progress`'s reason — the audit trail
already exists in the record beside it, and exactly one current reading is what anything asks for.

**One exception:** a `passed` result posted by an operator through `POST .../result` may carry no
note. A person clicking through their own checklist is watching the check happen, so a note would
only repeat what the checklist already says; a `failed` result still requires one, since it is the
only account anyone has of what went wrong. A noteless pass still writes `resultBy: 'operator'` —
that attribution is passed explicitly by the route rather than derived from whether a note was
given, so it is not confused with a `reset`, the one transition that means "nothing to attribute" and
is the only caller that still writes `note: null` on purpose.

**A result is declared, never derived** — by whoever declares it. A dispatched agent is held to the
same rule and told so in as many words, because it is the caller most able to break it: it can see a
green build and a merged PR, and neither is the check. Nothing infers a pass from a green build, a merged pull
request or an absence of errors — the refusal `conclude_part` makes about `code`, for the same
reason: a positive terminal inferred from incidental evidence is a check nobody ran, recorded as one
that passed.

### The letter is assigned, never positional

Letters are handed out at ingestion in declaration order (`nextCheckLetter`), **stored**, and never
reused or reassigned. A check added by an amendment takes the next free letter; a check an amendment
drops keeps its row, so its letter stays taken.

Deriving the letter from position instead compiles, passes and silently misaddresses: a check named
in a note yesterday would be a different check today. It is the same failure the slug-as-merge-key
rule exists to prevent, one layer up, and the same reason `acceptanceCriteria` keys on a criterion's
text rather than its index ([08](08-planning.md)).

## The test plan

**Built.** A check's `steps` are one journey through the delivered goal, in order, and each step
says who carries it out. Their shapes are `ValidationStepSchema` (`src/validation/checkDocument.ts`),
resolved by `src/validation/steps.ts` and stored on `validation_checks.steps`. A `browser` step may
carry a **one-off script**, which is the only step field that is a body of code and the only one that
acts ([36](36-remote-validation.md#the-one-off-script)); a `screenshot` step reaches the `captured`
state and asserts nothing ([36](36-remote-validation.md#handing-a-screen-back-to-look-at)). The
ordering is the point: a database or log reading whose subject is _what
the browser steps just did_ is meaningless taken before them, and prose in a `do` cannot express that
to anything but a reader.

| Step kind    | What it does                                                                         |
| ------------ | ------------------------------------------------------------------------------------ |
| `browser`    | Drives the application — navigate, upload, click, wait.                              |
| `suite`      | Runs a named area of the project's own browser suite. Sets the check's `area`.       |
| `screenshot` | Captures the screen and attaches it to the row. Asserts nothing; reaches `captured`. |
| `state`      | Reads the deployed store through the environment's `state.run`.                      |
| `signal`     | Reads logs and error records.                                                        |
| `measure`    | Reads a metric.                                                                      |
| `manual`     | A person does something the fleet cannot.                                            |

Everything one journey settles belongs to one check, on the rule
[One run is one check](#one-run-is-one-check) states: the setup is the expensive part, and a journey
cut into six checks reads on the sheet as six obligations. So the ordered step list is what replaced
the argument about whether "the screen renders" and "the row is written" are one check or two — they
are two steps of one.

**This is why `state`, `signal` and `measure` readings can be sequenced at all.** Taken as sheet rows
they are read at assembly and again synchronously at the press, both before the agent's browser half
runs ([36](36-remote-validation.md#the-press)) — which is correct for a row asking whether anything is
screaming, and wrong for one asking whether the order the browser steps just placed exists. As a step
it is read where it sits. Rows that belong to no check — the goal's watch-derived `signal` and
`measure` rows — keep the assembly behaviour they have.

### An inline person and a deferred one are not the same step

A step assigned to a person comes in two shapes, and only one of them can sit in the middle of an
otherwise automated run:

- **Deferred.** _Take a screenshot for the operator to view._ The run completes; the person looks
  afterwards. It costs the sequence nothing.
- **Inline.** _Somebody approves the payment in the finance system, then continue._ The run stops
  there. No agent can hold a browser session across a person's day, so the check is really two runs
  with a wait between them.

**Built.** `segmentBoundary` (`src/validation/steps.ts`) is the first step that is a person's _and_
inline; `checkBriefing` draws the plan and names the step to stop after, and rule `validate-check`
declines a check whose **first** step is a person's rather than sending an agent to sit in front of
somebody's day. A deferred step is not a boundary and never becomes one.

They read identically in a step list and they are not the same thing. A validation planner that
writes an inline human step into a run it has otherwise assigned to the fleet has written a check
that can never execute — dispatched, held, and blocking nothing, which is the quietest way for a
check to be lost. So a step's assignment carries **when**, not only **who**: an inline person's step
**segments** the check, and a check with a segment boundary is dispatched only as far as the boundary
and then hands back with what it has, exactly as [a hand-over](#the-hand-over) already does.

### Who carries a step

The rule at [Who runs a check](#who-runs-a-check) said `actor` is the operator's decision and only
theirs, because a planner reading a repository cannot know whether the deployment has a browser, a
login or an account — and a wrong guess is a check sitting dispatched against a login the fleet does
not have.

**Built.** `stepCapabilities` folds what every configured environment declares, once, and `resolveSteps`
answers each step off it: `browser`, `suite` and `screenshot` need a `validate.browser` block, `state`
needs `validate.state.run`, `signal` and `measure` need `watch.observe`, and `manual` is a person's by
definition. A `browser` step needs a **tenant** as well, because unlike the others it acts, and the
harness never generates or infers a tenant identifier
([36](36-remote-validation.md#tenants)). A step the fleet cannot carry comes back to a person **naming
the block that would have carried it**, never as "unsupported" — an operator meeting a check every step
of which came back to them is entitled to read which line they have not written.

Nothing declared at all is the fail-open arm and it fails **towards the person**: every step is theirs.
That is the only safe direction here, because the two mistakes are not symmetrical — a step wrongly
given to a person sits on the sheet where somebody sees it, and a step wrongly given to a fleet that
cannot carry it is dispatched, held, and blocking nothing.

**Reading it off the configuration is not a guess.** By the time the validation planner runs, what the
deployment can drive is declared: an environment's `validate.browser` block, its `state.run`, its
`observe` command, its tenant. A step whose kind the environment does not permit is a step the fleet
cannot carry, and that is a fact rather than a nomination. So the validation planner assigns steps
from the configuration, and the two things that stay the operator's are unchanged: **the hand-over**
— nothing is dispatched until they press — and the ability to take any step back by hand.

`fleetCandidate` keeps its meaning for a check with no `steps`, where there is still nothing but a
planner's suggestion to go on. `fleetCanStart` answers **null** there for that reason, which is a
different fact from "the fleet cannot start this" and must not be folded into it: null is the
operator's press deciding, false is a plan that can never execute.

## The document block

`src/validation/checkDocument.ts`. Additive and **optional** on the plan document, for the reason
every post-v1 field is: an older plan, and an operator override that never learned it, must keep
validating. Read on both verdicts — a goal delivered as one pull request needs validating exactly as
much as a decomposed one.

**What the plan document carries is the hint**, and the example below is the check set the validation
planner writes from it, through its own transport. The two shapes are kept apart deliberately: a plan
document that could declare an executable check set would be a second author for the thing
[Amendment](#amendment) exists to keep single. A plan document from before this change, carrying a
full `checks` array, is ingested exactly as it always was — the rows are real and an operator may be
halfway through them, and re-reading them as a hint would delete a check set somebody is using.

**An omitted array is not an empty one, and the block had to learn the difference.** `checks` and
`resources` were `.default([])`, which makes a hint-only block indistinguishable after parsing from
`"checks": []` — and that reading supersedes every check on the goal. They are optional now, and
`declaresCheckSet` is what `ingestPlanDocument` asks before it writes anything at all. Withdrawing
every check is still `"checks": []`, said out loud.

The hint lands on `validation_plans.hint`, beside the authoring the validation planner writes later
([Persistence](#persistence)). It is deliberately not a column on `plans`: the two halves are one
record about the goal's validation, they are written by different agents at different times, and the
plan row is 1:1 with a plan where this is 1:1 with a goal, which is what validation is keyed on
everywhere else.

```json
{
  "validation": {
    "hint": "Worth checking end to end: a file uploaded through the new importer should show on the batch page with its row count, and the importer's audit rows should exist. The parser is covered by unit tests; what nothing covers is the upload path against a real store."
  }
}
```

### The check set

**Built**, without `steps`. The validation planner declares the whole set through its own transport,
`validation_plan` (`src/mcp/tools/validationPlan.ts`), on the same `ValidationCheckSchema` and
`ValidationResourceSchema` the plan document reaches — a second copy of those shapes would drift the
first time either learned a field. It speaks for the **whole** set, on `ingestValidation`'s terms:
omission is withdrawal, and a check may carry [`steps`](#the-test-plan):

```json
{
  "validation": {
    "resources": [
      { "name": "fixture-repo.tar.gz", "kind": "fixture", "note": "seeded repo, one PR by another author" }
    ],
    "checks": [
      {
        "id": "reap-merged-branch",
        "title": "A squash-merged part branch is reaped, everywhere it shows",
        "do": "Needs git and a checkout — no login and no browser. Unpack the fixture repo, point a local harness at it, merge the seeded PR, and let one pulse run.",
        "expect": "No issue/284/reap ref locally or on the remote; the part reads merged on the goal page; one \"reaped\" line in the log and no error record.",
        "uses": ["fixture-repo.tar.gz"],
        "covers": ["reap-writer", "reap-desk"],
        "steps": [
          { "kind": "manual", "do": "Unpack the fixture repo and point a local harness at it", "when": "deferred" },
          { "kind": "state", "do": "Read the part back off the goal page — it should say merged" },
          { "kind": "signal", "do": "One \"reaped\" line in the log, and no error record" }
        ],
        "fleetCandidate": true,
        "why": "reads the repo and runs git; needs no login and no browser"
      }
    ]
  }
}
```

One run, and `expect` lists everything that run has to satisfy — the ref, the screen and the log, which
were three checks before the rule in [One run is one check](#one-run-is-one-check). What the check needs
in order to be runnable opens `do`, rather than being declared as an `access` resource that would file an
ask against it.

`ValidationSchema` is reached by **both** transports exactly as `PlanDocumentSchema` is — the
`plan.json` drain and the `plan_submit` tool must accept and reject the same documents.

- `id` matches `^[a-z0-9][a-z0-9-]*$` and is unique within the document.
- `title`, `do` and `expect` are non-empty. A check that cannot say what a pass looks like is not a
  check.
- `uses` names declared resources and `covers` names live part slugs; an unknown entry is **dropped**
  at ingestion, not refused — a check's prose is worth more than its bibliography, the `MAX_EVIDENCE`
  trade-off, and refusing would sink the whole plan document with it.
- `why` is kept only with the nomination it explains. A reason standing beside
  `fleetCandidate: false` reads as a nomination the sheet is failing to draw.
- `resources[].name` is unique and is **a file name**: a separator or a `..` is refused rather than
  sanitised, because this is the string joined onto the goal's directory. A quiet `basename` would
  silently rename the thing the check asks for.
- A check is parsed **strictly**, where the rest of the plan document is tolerant. `actor` is the
  reason: whether an agent can run a check is a property of the deployment, and a field this schema
  quietly dropped would let a planner believe it had assigned work.

### Who runs a check

**Where a check carries `steps`, assignment is per step and read off the configuration** —
[Who carries a step](#who-carries-a-step). What follows is the rule for a check that carries only
prose, and the argument the step rule had to answer.

**A person, unless a person says otherwise.** `actor` is `human` on every check that has ever been
written, and exactly one thing sets it to `fleet`: an operator pressing a button. The planner cannot,
an amendment cannot, and an agent cannot.

The reason is not caution about agents, it is what the planner can know. The fleet runs in `stream`
mode: no terminal, no browser, no interactive login, and no account on whatever environment this
deployment tests against. A planner reading the repository can know none of that, and a wrong guess
is a check sitting dispatched against a login the fleet does not have. So `fleetCandidate` stays a
**nomination** — it draws a chip, carries `candidateWhy` as its argument, and dispatches nothing —
and the deciding stays with the person who has the information.

The hand-over is what that person does with the nomination, and it is offered on **every** unrun
check rather than only on a nominated one: an operator who knows their own deployment does not need
the planner's permission to use it.

There is a **fourth**, and it is not a runner at all in the sense the other three are: a **reviewed
spec** in the project's own browser suite, selected by the check's `area` and run against an
environment the goal's work has arrived in ([36](36-remote-validation.md)). No model reads anything —
the suite's machine-readable report is the only source of the outcome — so what it writes is a
`spec` reading, which is a fourth thing again and says so wherever it is drawn. It is not an `actor`
either: nothing dispatches it, an operator presses go, and a check with no `area` is untouched by it.

There is a **third** runner, and it is the answer to the same problem from the other side: the
operator's own Claude Code, on the operator's own machine, which has the browser and the login the
fleet does not. See [the desktop channel](#the-desktop-channel). It is not an `actor` — nobody
dispatches it and it runs whatever it is pointed at — so what it writes on the row is a **claim**
while it runs and a `desktop` attribution on the reading afterwards.

### `covers`, and what one optional field buys

Validation is **goal-level**, not per part — a check usually spans parts, and the question it answers
is whether the goal works. `covers` does not change that; it only lets a check say which parts it
exercises, which is what lets a reader see which parts nothing checks. An absent check looks exactly
like a check that passed until someone counts.

## Saying so on the bench

A goal parked as delivered is the one moment a check becomes runnable, and that moment used to
announce itself nowhere an operator was already looking. The sheet drew the chip and the close-out
obligation carried the count, and both are read by somebody who had already decided to go and look —
so the realistic failure was never a check that failed, it was the set nobody knew had arrived. That
is the reading `unrun` exists to weigh like a failure, one layer out: a verdict nobody was asked for
is not a verdict.

`ValidationReadyDesk` (`src/validation/ready.ts`, `readyDesk.ts`) files a `validate` human task on
every delivered goal with a check a **person** still has to run, once a pulse, beside the resource
asks and against the same gate ([13](13-jobs-and-tickets.md#the-other-step-after-the-launch-the-validation)).
It states what is outstanding through the same `outstandingChecks` the close-out reads, refreshed
every pulse, so the bench row and the obligation beneath it cannot disagree about what a goal owes.

Where a goal has arrived somewhere with a `validate` block configured, the row's detail also carries
one line per environment saying that environment's **sheet** is assembled, how many rows it has, and
how many are waiting on a query approval — folded on the server off the sheet's own rows, refreshed on
the same pulse and for the same reason the counts are. It is deliberately that short: an operator has
to be told a sheet exists on the pulse sheets start existing, and what the sheet says is the sheet's
own surface to say. What the browser half adds to the line — the selectors the pre-flight could not
find, the tenant's age — lands with the pre-flight. The press is a person's act, so the row is filed
for one even where every remaining check is automatable, and **no second bench kind is added**: a
sheet waiting to be run is this row's business. → [36](36-remote-validation.md#the-desk)

**It blocks nothing**, which is the table at the top of this document holding: the row gates no
dispatch, no merge, no conclusion and no close, and no rule reads it. What changes is that running
the checks is an obligation with a place to sit rather than a thing somebody remembers.

What can hold the row is an **environment gate**, where a deployment configured one: with
`arrival.opens` naming `validate`, the row waits until the goal's work has reached the environment
that opens it. The delivery is when a check becomes _meaningful_; with a gate it is not yet when one
becomes **runnable**, and a check against a build nobody can open is the row-asking-for-impossible-work
this desk exists to end, one step earlier. Nothing gates it on a deployment that configured no
environment, which is the default — and the gate holds the file arm only, so results recorded against
an already-filed row still settle it. → [24](24-environments.md#what-an-arrival-means)

A second hold reads the same way and is **off**: `watch.holds: ["validate"]` on an environment waits
until its post-deploy watch on that goal has settled rather than until the goal arrives. Nullable,
satisfied by whichever declaring environment settles first, cleared by an operator's release, and
holding the file arm only. → [29](29-post-deploy-watch.md#it-holds-nothing-unless-asked)

The close-out is the step **after** this one: the `close_out` row is not filed while this one is open.
→ [24](24-environments.md#the-bench-asks-for-one-thing-at-a-time)

A check handed to the fleet is **not** on it — rule `validate-check` is about to dispatch that one —
and a hand-back puts it straight back, carrying the agent's reason. The row settles itself the moment
nothing is left for a person, on the close-out's asymmetry: these are rows the harness reads every
pulse, so asking the operator to tick off a second copy of what they have just recorded is asking
them to tell it something it can see.

**Clearing the delivery retracts the row, and re-delivering brings it back.** The second half is what
makes the first honest, and it does not happen by itself: `recordHumanTask` dedups on the title
regardless of status and `validateTitle` is stable, so a re-file would fold onto the declined row and
leave it declined. The desk therefore settles its retraction with the `DESK_SETTLED` marker
([13](13-jobs-and-tickets.md#the-seven-arms-that-file-one)) and **reopens** the row it recognises when
the goal is delivered again. Without that, delivered → shortfall → replan → delivered — which is what
`issue-assess` and `issue-shortfall` do for a living — leaves the goal's one announcement surface gone
permanently, while the chip, the sheet and the checks all still read `unrun` correctly. An operator's
own `done` or `declined` is untouched by this and stands forever.

## Resources

`validationRoot`, default `.lubbdubb/validation`, one directory per goal (`<root>/issue-284/`,
`validationResourcePath`). `uses` names a resource; the path is resolved at read time and shipped to
the cockpit with a present/missing fact beside it, so a missing fixture is a stated fact rather than
a check that fails for a reason nobody can see.

**Names, not paths.** The path an agent sees, the path the cockpit serves and the path an operator
opens are three different strings, and a stored absolute path is wrong for two of them the moment the
root moves.

The storage rule is `attachmentRoot`'s, argument for argument ([02](02-configuration.md)), because it
is the same problem:

- **Outside every worktree**, so a fixture can never be committed onto a branch and outlives the
  worktree reap that removes the agent that used it.
- **Canonical rather than copied per dispatch**, so the planner, each agent and the operator read one
  file.
- **A config key**, so a deployment wanting a tmpfs or a per-tenant path can say so.

Every launched agent is granted read access to the whole root via `permissions.additionalDirectories`
for the life of the launch, because a grant that came and went with a policy flag would make an
agent's readable set depend on config it cannot see. That is a real widening, and it is the same one
attachments already make.

**A resource is a file**, which is what makes the rest of this section coherent: a name resolved under
a directory, present or missing, servable to the cockpit and readable by an agent. A resource declared
`"provided": false` is the planner saying it needs a file it cannot produce — a reference screenshot,
a dump of real data, a sample from a colleague. A `human_tasks` row asks for it
([13](13-jobs-and-tickets.md)), so a missing fixture is an ask rather than a check that mysteriously
never runs.

**`kind: 'access'` is the exception, and files nothing.** It names a login or an environment, which is
a precondition and belongs in the check's `do` ([A precondition is not an ask](#a-precondition-is-not-an-ask));
`fileResourceAsks` skips it whatever `provided` says. The ask it used to file told its reader to "put
it where the harness keeps validation resources for this goal" about an account — a row nobody could
settle by handing anything over, and one the operator could not get rid of. The word stays **parseable**
rather than being dropped from the enum, on the rule every post-v1 field follows: an older plan, and an
operator override that never learned the new wording, must keep validating rather than having the whole
document refused over one chip. The cockpit draws it as a plain chip too — `present` is a file fact, and
warning "missing" about a file that was never going to exist is a warning that means nothing on every
draw for the life of the goal.

**The ask is filed against the delivery, not against the plan.** `ValidationAskDesk`
(`src/validation/askDesk.ts`) files it once a pulse for every goal parked as delivered, beside the
close-out sweep and gated on the same fact. A resource exists to make a check runnable, and a check is
executed against the delivered goal — `validate-check` will not dispatch one before then and the
cockpit offers nothing either. Filed at **ingestion**, as it was until #371, the ask landed the moment
a planner submitted: on a plan still `awaiting_approval`, weeks before there was anything to validate,
asking a person for a fixture against work that might never be built. That is a row an operator cannot
act on and cannot get rid of, sitting in the queue beside the ones they can — and the ask is not more
useful for being older. It is the same argument `closeOutDetail`'s placement makes from the other end:
an obligation is worth what the moment it is put in front of somebody is worth.

`recordHumanTask` refreshes on a repeat rather than inserting and the task id is carried across by
name, which is what makes a per-pulse sweep free: a pulse over a goal it has already asked about
writes nothing new, and a replan re-declaring the same resource does not file it twice.

**And the plan withdraws it**, `withdrawResourceAsks` in `src/validation/ask.ts`, called by both
writers before the resources are rewritten — the ask is reached through the row that is about to be
replaced. A resource the new declaration dropped, or now says is `provided` after all, has its ask
settled `declined`, the settlement a retired part's ask already gets and for its reason: the ingest
writer replaces the resource list wholesale, so an ask nothing withdraws points at something no plan
asks for, with nothing left that could ever settle it and no honest answer available to the operator.
Only an **open** ask is withdrawn — an answered row is the operator's record of what they did, and
overwriting their resolution with the harness's is the one thing a withdrawal must not do. The two
writers compute what is still needed for themselves rather than sharing one answer, because they
disagree about what an omission means: a document speaks for the whole resource list, an amendment
only for what it names, so the only thing that withdraws an ask through `validation_amend` is the
amendment saying `provided: true` out loud.

## Amendment

**Most of what this section defends against is gone.** It was built when the check set was written at
planning time, by the one agent that had not done the work yet: a check written against the code a
planner expected to exist, describing by the second part a screen that moved or a command that was
renamed. Authoring the set after `delivered`
([When the check set is written](#when-the-check-set-is-written)) removes that whole class, and with
it the churn of an amendment on every part.

What remains is the narrower case, and it is real enough to keep every mechanism below. A check set
written against merged code can still be wrong about the **deployed** one; the bench gate exists
partly to reread checks with the delivered thing in front of you
([36](36-remote-validation.md)); a failed check gets diagnosed and the diagnosis sometimes says the
check was mistaken. A check set that cannot change is still worse than none: a stale check that fails
reads as a broken goal.

Two writers fold a change onto the rows, and the difference between them is load-bearing:

|            | `ingestValidation` (a plan document)     | `amendValidation` (`validation_amend`) |
| ---------- | ---------------------------------------- | -------------------------------------- |
| Speaks for | The **whole** check set                  | Only the checks it names               |
| Omission   | A withdrawal                             | Nothing at all                         |
| Written by | The validation planner, its own dispatch | Any agent working the goal             |
| Withdrawal | By silence                               | Said out loud, with a reason           |

Collapsing them would mean an agent sending a correct two-check correction silently supersedes the
other six — a validation plan an agent can delete by being terse. That is why `validation_amend` is a
separate tool rather than a second way into `plan_submit`, the same split `note_progress` makes
against `conclude_work`: a narrow, frequent, additive act kept apart from the one that speaks for
everything.

Both writers merge on the check id, on the same terms `upsertPlanParts` folds the parts:

| Operation      | Effect                                                                                           | Why                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add**        | Lands `unrun`, next free letter.                                                                 | More validation is never the dangerous direction.                                                                                                                                  |
| **Re-declare** | Merged onto the row. A result survives.                                                          | The check is the same check, and an amendment that fixed a mistyped reference has not changed what running it involves.                                                            |
| **Reword**     | The result is **withdrawn** and the check returns to `unrun`.                                    | `acceptanceCriteria`'s rule exactly: an amendment that changes what a pass means has withdrawn the thing that was confirmed. Rewording is also how a check quietly becomes easier. |
| **Drop**       | **Superseded, not deleted** — the row stays, greyed, outside the verdict, with the reason on it. | The same settlement an amended plan gives a part it dropped, and what keeps the letter taken. An agent that cannot pass a check must not be able to make it disappear.             |

A rewording is judged on `title`, `do` and `expect` alone. `uses`, `covers` and `fleetCandidate` are
references and a suggestion, and a result is not about them.

**An omitted `validation` block leaves the checks exactly as they are**, and that is the only honest
reading: an operator override that never learned the block produces plans without one, and treating
that as "the planner withdrew every check" would supersede a validation plan somebody is halfway
through. Withdrawing every check is `"validation": {"checks": []}`, said explicitly.

### `validation_amend`

`src/validation/amend.ts` (pure) and `src/mcp/tools/validationAmend.ts`. Takes a required `note`,
`checks` to add or amend, `withdraw` entries each with their own reason, and `resources` merged by
name. `checks` and `resources` are parsed by **the plan document's own schemas**
(`ValidationCheckSchema`, `ValidationResourceSchema`), so the two transports refuse the same things —
including `actor`, which both refuse rather than drop. A second copy of those shapes would have
drifted the first time either learned a field.

Three refusals are the tool's own:

- **No note, no amendment.** `conclude_work`'s rule: the note is the whole of what an operator sees
  when a check they read yesterday says something else today.
- **An amendment that changes nothing** is refused rather than accepted quietly — the caller believes
  it corrected something and would go on believing it.
- **An id both declared and withdrawn** is refused rather than resolved. Both readings are
  defensible and the caller means one of them; the store's withdrawal arm relies on this, and may
  then assume a declared id is never also a withdrawn one.

The origin fence is deliberately **wider than the others**. `conclusionOrigin` and
`partConclusionOrigin` refuse every caller but one because a conclusion is a verdict only one party
is entitled to cast. A check is not a verdict — it is a note about how the goal gets checked, and the
agent best placed to notice one is wrong is whoever is looking at the code. So the whole-issue agent,
a part agent and the assessor all qualify. The fence that matters is unchanged and structural: the
origin comes off the credential, so an agent working goal A cannot amend goal B by asking.

**The validation planner is the one refusal, and by name**: it already has a transport that declares
the entire check set, and two ways to say one thing that disagree about what an omission means is the
drift the split exists to prevent. The refusal moved with the authoring — `validationAmendIssue`
refused the `:plan` origin when the planner wrote checks, and refuses the validation planner's own
origin now that it does. An ordinary planner has no check-writing transport to be held to, so it is
not a caller this tool has to think about.

One shape is refused for a reason that is not the caller's fault, and says so plainly: a goal with
**no plan** — `covers` names live part slugs, which is a property of the plan, and a goal whose
planner has not written one has no check set to amend either.

### The band

An amendment leaves the check carrying `amendedAt`, the amender's `amendNote`, and — when it
reworded rather than added — a `revision` holding what the check used to say and the reading that was
withdrawn with it. That is the executable form of "you are told when the plan changes", and it is
the half that makes correctability safe: a check quietly rewritten under an operator who already ran
it is worse than one that cannot change at all, because they would go on believing they had checked
something the plan no longer asks for.

| Case                             | `amendedAt`            | `revision`                            |
| -------------------------------- | ---------------------- | ------------------------------------- |
| A plan's **first** check set     | unset                  | null                                  |
| Added by an amendment            | set                    | null                                  |
| Reworded, check was `unrun`      | set                    | `state: null`                         |
| Reworded over a recorded reading | set                    | the wording and the withdrawn reading |
| Re-declared word for word        | carried, never cleared | carried                               |

A plan's opening declaration bands nothing: every check in it is new, and banding all of them would
fire the one signal that means "this is not the check you read" on a plan nobody has read yet. A
re-declaration with identical wording carries the previous band forward rather than clearing it —
an operator who has not yet seen the last amendment must not have it wiped by the next replan that
happens to restate the same words.

**The band clears when the operator records a reading against the new wording**, in
`recordValidationResult`, and by nothing else. That is the only acknowledgement worth having: a
dismiss button would clear it for somebody who had merely seen it. A reset counts, because it is
still an operator act on the check as it now reads.

Because the amendment reaches people who are not at the cockpit, it is stated in two more places:
`outstandingChecks` appends what the change cost to the close-out line, and the ticket comment marks
the check `_(amended after it was passed — needs running again)_`. Both only when a reading was
actually withdrawn — an amendment to a check nobody ran took nothing away. Without them a check
somebody passed and an amendment then rewrote renders as a plain `unrun`, indistinguishable from one
they never got to, which is the single most misleading line either could carry.

## The hand-over

The operator hands one check to the fleet; the harness runs it and reports back, or gives it up and
says why. `POST …/handover` writes `actor`, rule `validate-check` dispatches, `validation_report`
answers.

### `validate-check`

`src/dispatcher/rules/validateCheck.ts`, a `DISPATCH_PIPELINE` entry and a `STAGES` module like any
other rule ([05](05-dispatcher.md#the-rule-book)). A **code** agent — a check runs things — in a
**read-only checkout** of `defaultBranch` ([09](09-execution.md#the-read-only-checkout)), leased under
`validate/issue/<n>/<checkId>`, origin `issue:<n>:validate:<checkId>`. The namespace is
`assess/issue/<n>`'s: git stores refs as files, so nothing bare is ever cut, and the check id is on
both the name and the origin so two handed-over checks get two worktrees. Since #396 that name is a
lease key and no ref is minted — the agent is told this is not a place to build on, and a branch cut
for it would have outlived every check ever run.

Five conditions, and each is somebody's decision rather than the harness's:

- The issue passes the watch gate.
- **The goal is parked as delivered.** A check is executed against the delivered goal; run mid-flight
  it reports a failure about something that does not exist yet — a finding about the calendar rather
  than about the code. A **retained run** counts, `issue-retro`'s reason exactly: this is a rule that
  runs after the work is over, which is when a delivering PR has already closed the ticket.
- `actor` is `fleet`.
- `state` is `unrun`. A settled check carries somebody's answer, and re-running one behind the person
  who settled it would overwrite their reading with an agent's.
- **No live claim.** A desktop session takes a check before it runs it; dispatching underneath one
  would put two things in the same environment against the same procedure, with the second reading
  overwriting the first and neither knowing the other existed. Read through `claimIsLive`, never off
  `claimed_by`, so a claim whose session died means the same thing here as it does to a person trying
  to take one — otherwise a killed session blocks a check from the fleet forever.

**One origin per check, not one per goal.** The origin is what the cooldown and the three-attempt cap
are keyed on, so a shared one would let a check that can never be run spend the attempts of the four
beside it — `pr-ci-gate`'s split against `pr-ci`, argument for argument.

**It is last of every rule that produces work**, below one-shot pickup — only `validation-failed`,
which is a second opinion on work somebody has already done, and the two Feature desks
(`feature-summary`, `feature-sequence`), which produce no work at all, sit below it. That is
load-bearing rather than tidy. Validation's standing promise is that it blocks nothing; a rule that
could take the final slot from a blocked part or a red build would make the one feature that gates
nothing the reason something else did not run. Ranked there, a handed-over check gets the headroom
nothing else wanted and queues as `waiting` when there is none.

**It fails open and silent**, `issue-retro`'s rule and more cheaply: a crashed or capped agent leaves
the check exactly as it was, `unrun` and still flagged, with no escalation. The flag is already the
ask — a second inbox item would put the same question to the same person twice.

### `validation_report`

`src/validation/report.ts` (pure) and `src/mcp/tools/validationReport.ts`. Takes a `result` and a
required `note`. **The check is not an argument**: it is on the origin, one check per dispatch, so
which check a report concerns is decided by what the agent was sent to do.

A `passed` or `failed` report is refused when the check's `amendedAt` is after the dispatch began. The
desktop channel compares it with the claim's `claimedAt`; the fleet compares it with the task's
dispatch timestamp. The refusal clears the desktop session's held check, quotes the amendment note,
and tells the caller to re-read and claim the current wording. A `blocked` report is still accepted: it
is an account of not reaching the environment, not a reading against either version of the procedure.

The origin fence is the **narrow** kind, and deliberately unlike `validation_amend`'s. An amendment
is a note about how a goal gets tested and the agent best placed to write one is whoever is looking
at the code; a result is a reading, cast about a procedure somebody was asked to carry out, and it is
the one thing on the row an operator will later act on without repeating the work. So only the agent
dispatched for that check may report, and every other caller is refused **by name** and pointed at
`validation_amend`. The refusal matters most for the caller it is most tempting for — the agent that
just built the thing, which has every reason to believe the goal works and no way to have run a check
nobody sent it to run.

| `result`   | Writes                                              | Because                                                    |
| ---------- | --------------------------------------------------- | ---------------------------------------------------------- |
| `passed`   | The reading, `resultBy: 'agent'`                    | Attributed, and drawn wherever the reading is — see below. |
| `failed`   | The reading, `resultBy: 'agent'`                    | A real finding about the goal, and worth having.           |
| `blocked`  | `actor` back to `human`, the reason, **no reading** | The third answer, and the reason there are three.          |

**The verdict is `blocked`; the record it writes is a hand-back.** Two facts wear one word easily here
and they are not one. `blocked` is what an agent *says* — it could not carry this check out — and it is
the same word the local ([32](32-local-validation.md)) and remote ([36](36-remote-validation.md)) paths
take for the same fact. The hand-back is what the harness *writes*: `handback_note` on the row and
`actor` back to `human`, through `recordValidationHandback`. That is a check returning to a person's
queue rather than a verdict, so it keeps its name — and the column keeps it for a second reason, that a
renamed column is invisible on every database from before the rename ([14](14-persistence.md#migrations)).

The verdict was itself called `handback` until the three paths were given one word for it, and the old
word is **refused by name** rather than quietly accepted: `validateReport` answers a `result` of
`handback` with a refusal that names `blocked`, `RETIRED_TOOL_NAMES`' rule one layer down
([11](11-mcp-tools.md#retired-tools)). The templates that carry the word are operator-overridable, so
the deployments that customised most are exactly the ones still saying it, and a bare enum rejection
listing four words leaves an agent guessing at which of them it wanted. Accepting both was the other
option and was rejected: an alias nothing ever retires is two vocabularies for one fact, which is what
this change removed.

**Why there is a third answer.** An agent that could not reach the environment has learned nothing
about the goal. With only `passed` and `failed` available its options are a lie and silence, and both
are worse than the truth: `failed` flags the goal for a reason that has nothing to do with the code,
and silence leaves an `unrun` check with no account of itself. A hand-back leaves the state exactly
as it was and carries the agent's reason to the operator, where it is usually the one sentence saying
what a person can do that an agent could not. The next dispatch is handed that reason too, so a
re-hand-over does not rediscover the same wall and spend an attempt saying so.

**`resultBy` is drawn wherever the reading is** — the cockpit row, and `_(recorded by an agent)_` on
the ticket comment. All five are drawn apart, `spec` and `script` most of all: a reviewed spec is
repository code a pull request's reviewer read and a one-off script is a throwaway nobody read, and
an operator counting green rows must never be told they are the same evidence. "An agent says this passed" and "I ran it and it passed" are different facts, and
the whole feature exists to stop the second being assumed from evidence that only supports the first.
The ticket says it only for the agent: a validation checklist already means a person checked it, and
the exception is what a reader deciding how much a tick is worth is entitled to know.

### What withdraws a hand-over

**Exactly what withdraws the result**, and that is one rule rather than two. A reworded check loses
its reading _and_ its `actor`; one re-declared word for word keeps both. Both were decisions an
operator made about wording that no longer exists — a check reworded to say "log into the test
environment" and still assigned to the fleet would be run by an agent nobody handed it to — and the
amendment band is already in front of the operator saying what changed, which is where the decision
to hand it over again belongs.

A hand-back is cleared by the next reading, on the band's terms and for the band's reason: it says
why the last dispatch came to nothing, and somebody who has since recorded a reading has moved past
it. Handing the check over again does **not** clear it — the next dispatch is briefed with it, and
clearing it here would be destroying the only copy of the thing that stops the re-hand-over
rediscovering the same wall. What stops the old reason being drawn beside a check now in flight is
the reader: `whoOwesIt` answers on the `actor` first, so a check with the fleet renders
`(handed to the fleet)` whatever the row still carries.

Off the cockpit, `outstandingChecks` says which of the two a check is in — `(handed to the fleet)` or
`(handed back — …)`. Without them both render as a bare `unrun`, which is the same word for "nobody
has got to it", "an agent is about to" and "an agent tried and could not". The note is not prefixed
with who gave it up, because `handbackReason` has already opened it with "An agent" or "A desktop
session" — and the `by` on that sentence exists precisely because the two mean different things to
the person reading the row.

## When a check fails

A `failed` reading used to be a dead end. It wrote its note, flipped the goal's verdict to `flagged`,
put a row on the bench and waited for a person — the one verdict in the harness that says the
delivered thing does not work, and the only one that scheduled nothing. Every other negative verdict
has a consumer: an assessment that says the goal was not reached reaches `issue-shortfall`, a red
build reaches `pr-ci-failing`. Somebody ran the procedure, watched it fail, wrote down what they saw,
and the fleet did not look.

Rule `validation-failed` ([05](05-dispatcher.md#validation-failed--looking-into-a-failed-check)) is
what looks. One **read-only** code agent on the default branch — where the delivered work is —
briefed with the procedure, what a pass looks like, and the reading with its note and who took it.

**It is deliberately not wired through a shortfall**, which is the obvious shape and the one that
must not be built: `VERDICT_EXCLUSIONS` has a shortfall clear the goal's **delivery**
([14](14-persistence.md#issue-verdicts-and-the-exclusion-matrix)), and the delivery is what parks the
goal. Recording a failed check as one would un-park it, settle its close-out obligation and decline
the validation bench row as "the goal went back into production" — the reading deleting the rows it
was reported into, and delivered work handed back to the fleet. The two verdicts answer different
questions: a shortfall says the work is not finished, and a failed check says the finished work does
not do what somebody checked it for.

**The diagnosis is the deliverable, and it fixes nothing.** What a failed check needs first is an
account of why, and the three endings an agent can honestly reach already have doors: `escalate` for
a real defect, which is a decision about delivered work and a person's to take; `validation_amend`
for a check that describes something that no longer exists; `raise` for what the next agent should
not have to work out again. Nothing here opens a pull request, files a ticket or schedules work —
validation's standing promise is that it blocks nothing, and a rule that answered a failed check by
putting a change into the world on its own authority would be the same overreach in the other
direction.

**It cannot record a reading, and that is structural.** `validation_report` resolves which check it
is reporting on from the dispatch origin, and `issue:<n>:validate-failure:<checkId>` is not a shape
it parses — so an agent that could not reproduce the failure and concludes the check "actually
passes" is refused by the tool rather than by a sentence in a prompt. The reading belongs to whoever
took it: they ran the procedure and this agent did not.

**Each reading gets its own attempt budget.** A failed check stands until somebody records something
else against it, so a cooldown window over the check's whole life would give it one budget for ever:
a goal that failed, was fixed, was re-run and failed again would meet a spent attempt cap and get no
second look, exactly where a repeat failure is worth most. The window is narrowed to decisions after
`resultAt` — `plannerVerdict`'s adjustment, against the same failure ([08](08-planning.md)).

## The desktop channel

A check that needs a browser, a login and a real environment is a check the fleet cannot run — and
`blocked` is the honest answer to it, not a fix. The fix is that the operator's **own** Claude Code
can run it, on the machine that has all three, and report the reading onto the same row.

So the harness listens on a second MCP socket (`src/mcp/desktop.ts`,
[11](11-mcp-tools.md#the-desktop-channel)) that the operator registers in Claude Code **once**.

**Unconditional**, and it was not always. It used to be off by default, because unlike everything
else in this document it has a footprint outside the harness: every start binds the stable socket,
writes a `0600` credential at `validation.desktopCredentialPath` and rewrites the skill at
`validation.desktopSkillPath`, all in the operator's home directory. What settled it the other way is
that nothing downstream of the socket ever read the switch — the cockpit offers **Copy desktop
prompt** on every unrun check, the dispatcher honours a desktop claim whatever the config said. So a
deployment that took the defaults was handed a `/lubbdubb 284:C` that reached nothing, with no error,
no marker and no boot line to say why. A channel advertised unconditionally and delivered
conditionally is a dead end you find by walking into it; the footprint is the price of the offer
being real. The switch is retired, warn-and-drop, in [02](02-configuration.md#retired-keys).

Two consequences worth stating plainly. A hand-edited `SKILL.md` is overwritten on the next start,
and there is now no setting that stops that — the file says so in its own body. And the second
harness on a machine is now a case every developer with two checkouts hits: the stable socket is
exclusive, so the one that boots second refuses it, records the conflict and prints an
`unavailable` boot line rather than stealing a running harness's registration. Point it at a
different `validation.desktopSocketPath` (and credential path) to run both.

### The tools

`validation_read` a goal's plan, `validation_claim` the one check you are going to run,
`validation_report` what you saw — plus `plan_read` and `plan_amend` for a discussion
([08](08-planning.md)), and `local_run` for [getting the application up](#getting-the-application-up).
Six and no more, and narrowed by construction rather than by a
filter over the fleet's set — this credential is long-lived and lives in a home directory, so the
guarantee has to be that there is no code path from a desktop connection to `conclude_work` at all,
not that a list is currently short.

`validation_report` exists in both channels and is two tools sharing one schema, one set of store
writes, one hand-back wording and one refusal of a result against wording amended since the run began.
What differs is where the check comes from: the fleet's from the origin it was dispatched on, the
desktop's from what the session claimed. Both are the same rule — **which check a report is about is
settled before the report rather than by it.**

### The claim

**One check at a time, across the whole harness.** Not one lock per check, and that is the operator's
own constraint rather than a limit invented here: there is one working copy, and two things reaching
for it is the failure. A per-check lock would happily let two sessions take two checks and fight over
the same checkout, which is exactly what was ruled out when a priority-and-bench design was rejected.
A second claim is refused by name, pointing at the check that holds it.

A claim is released three ways, and needs all three:

- **The report lands.** The reading is in, so the run is over — including a hand-back.
- **The session's socket closes.** Closing the terminal is how a desktop run normally ends. The
  release is per **connection**, not per credential: two terminals share one token, and a claim that
  belonged to the credential would let the second release the first one's check.
- **It expires**, after `validation.desktopClaimMinutes`. The case neither of the others can cover is
  a harness killed between the claim and the release, and without an expiry that leaves a check
  blocked from the fleet forever with no way back short of editing the database.

An **amendment that rewords a claimed check releases the claim**, by exactly the predicate that drops
the result and the hand-over. Somebody is running that check right now against wording that no longer
exists, and the amber band is now in front of the operator saying so. A result from that run is refused
by `validation_report` rather than clearing the band: the caller must read and claim the new wording
before reporting `passed` or `failed`. A `blocked` report remains valid, because it records only that the
environment could not be reached and no reading was taken.

### What a desktop reading is worth

`result_by` is `desktop`, which is neither of the other three and says so wherever the reading is
drawn. `operator` means a person carried the steps out — what a validation checklist already means,
which is why it is the one that draws no marker. `agent` means the fleet ran it unattended. `desktop`
means the operator's own Claude ran it at their keyboard: stronger than the fleet's, because it
reached the real environment, and weaker than a person's, because no person did the steps. A reader
deciding whether to re-run a check before closing a goal is deciding on exactly that difference.

**`spec` is the fourth**, and it is stronger than `agent` for the reason `desktop` is: a reviewed
spec ran against a real environment and a report said what happened, with no model between the run
and the reading. It is still not `operator`, because nobody watched. A `spec` reading may only be
written over `unrun` or over another `spec` reading — a reading a person, an agent or a desktop
session took is theirs, and overwriting it is the harness deciding it knows better than whoever
watched the thing happen. → [36](36-remote-validation.md#what-a-spec-reading-is-worth)

### The skill

`/lubbdubb 284:C`, `/lubbdubb discuss 284`, `/lubbdubb run 284`, `/lubbdubb ask 284 …`,
`/lubbdubb fleet`, `/lubbdubb order 500`, `/lubbdubb clarify 284` — seven jobs told apart by the
argument, one file. The fifth is about the harness rather than about a goal and is
[owned by 11](11-mcp-tools.md#watching-and-steering-the-fleet); its section here is only that a
question with no goal number in it is that job. The seventh is where the ticket comment a refused
goal carries sends its author ([06](06-issue-pickup.md#the-comment-on-the-ticket)): the skill reads
the verdict and its `missing` list through `goal_read`, states the story rubric in the skill's own
words, works through the list with the author against the open repository, drafts the whole rewrite
— title and body, because the hold ends on the description changing and the next agent reads the
description — and gets it onto the ticket through the tracker's CLI where one is signed in, or hands
it over to paste. It says plainly that a reply does not restart the goal, and it treats `goal_gate`'s
`workable` as the override rather than the fix. The fourth settles nothing:
[`goal_read`](11-mcp-tools.md#answering-a-question-about-a-goal) hands back the harness's record of a
goal and the skill says what to do with it. Its longest section is about the one way a session with
the repository open gets a question about a run wrong — reconstructing a plausible history from the
code, which is the one answer an operator cannot tell from the real one — and about `unknown` on an
environment not being `absent`. Installed to `validation.desktopSkillPath` when the channel starts, from
`DESKTOP_SKILL` in `src/validation/desktopSkill.ts` — a string in a `.ts` module rather than a `.md`
asset, the prompt templates' reason: the build emits `.ts` and nothing copies a stray `.md` into
`dist`, so an asset works in development and is missing in a deployment. There is no second copy
under `docs/` for the same reason: one of them would be the stale one.

The skill is the interface, not a convenience. Without it the operator types the same six sentences
at their Claude every time — which is the friction the whole channel exists to remove, and the reason
the bench design was rejected. It says what the three answers mean, that `blocked` is a right
answer, and the two things a session with the repository open is most able to do wrong: report
`passed` from evidence it did not gather, and change code to make a check pass. The `ask` section
carries the same shape of warning for the same reason — a question is answerable wrongly and
confidently — plus the one line that keeps the read a read: change nothing, and offer `discuss` if
the answer turns out to be that the plan is wrong. Everything about
_how_ to run a given check comes back from the tools, which read the live plan; a skill that restated
any of it would be a second copy of the procedure, drifting.

**One section is appended rather than written into the body**: where LubbDubb's _own_ checkout is,
when `installRoot()` resolves one (`desktopSkillDocument`, handed the root by `src/server/main.ts`).
The session this skill is written for opens on `repoRoot` — the repository the fleet **works on** —
and the cockpit's [Claude Code hand-off](17-cockpit.md#the-top-bar-and-the-panels) collects plenty of questions
that are about the harness instead: why nothing picked a goal up, why a rule did not fire. Answered
from the harness's output those get the shape of confident wrong answer the `ask` section already
warns about. The note says to read the record first and the source second, and to change nothing in
that checkout — it is the running harness, and the fleet cuts its worktrees from it. Appended and not
spliced in, the prompt templates' rule: a path interpolated into the body is a second thing to keep
in step. A deployment running from a tarball resolves no root and gets the body unchanged, because a
section naming a directory that is not there is worse than no section.

It is always overwritten, and says so in its own body — telling an operator's edits from a stale copy
has no honest implementation, and a skill that silently stopped being refreshed would describe a
channel that had since changed. There is no key to stop it: the skill is the channel's interface, so
a channel running without it is the channel failing at the job it was turned on for.

### Starting a run from the cockpit

Every other runner of a check is started from the check's own row: a reading is recorded there, and
the hand-over puts an agent on it. A desktop session is not, and cannot be — the claim is taken from
the operator's own Claude Code over a socket a browser has no reach into, so the cockpit has no way
to begin one. Left at that, the third runner is the only one with no trace on the surface that
manages the other two, and an operator reads a validation plan that offers a hand-over to the fleet
and says nothing about the machine in front of them.

So an unrun check draws **Open in Claude Code ↗** beside the fleet hand-over: an `<a>` carrying
`claude://code/new?q=/lubbdubb <issue>:<letter>&folder=<config.desktopFolder>`, built by
`DesktopLink` (`web/src/components/DesktopLink.tsx`) over `checkPrompt`
(`web/src/cockpit/desktopLink.ts`). It records nothing, claims nothing and reaches no
socket of the cockpit's own; it opens that client on the goal's checkout with the command already in
the box, and the run begins when the operator sends it. It copied the string to the clipboard before,
which left them holding a line to paste somewhere they still had to go and find.

Three properties, all asserted in `test/validationDesktopPrompt.test.ts`:

- **The address is the goal's number and the check's stored letter**, which is the pair the skill
  resolves a check by. Derived from a row's position it would render correctly and address a
  different check after the next amendment — the failure [the letter](#the-letter-is-assigned-never-positional)
  exists to prevent, one layer up.
- **The link carries the folder.** Without it the session opens wherever that client was last, which
  is a Claude with no sight of the goal it was sent to check.
- **The command is in the control's title as well as in the link.** A deep link reaches only the
  machine the browser is on, and a client that is not installed answers nothing at all — so a command
  living only in the `href` leaves an operator with a control that did nothing and nothing to type
  instead.

It is offered on every unrun check rather than only a nominated one, the hand-over's rule for the
hand-over's reason: `fleetCandidate` is an argument about the fleet and says nothing about the
machine the operator is sitting at.

### Getting the application up

A check that says "open the page and click the thing" is unrunnable until somebody knows how to get
the page up, and nothing in this document told them. The procedure is written by a planner reading the
repository, which is the one thing in the deployment that cannot know the answer — so the check
arrived at the machine with the browser and the login and stalled on the one fact nobody had written
down.

The fleet can now be sent to drive it — [32 — Local validation](32-local-validation.md), an
operator pressing a button on a goal still in flight. It is **not a check and records no reading on
one**: a check is a procedure somebody declared and a reading somebody took against the _delivered_
goal, and its agent has no reachable code path to `validation_report` at all. What it does have is a
test plan of its own, written against the diff, and the goal's checks are handed to it as input.

That is [23 — Local runs](23-local-runs.md), and it is a subsystem rather than a paragraph here
because the harness **owns the environment**: one dev environment on the machine, one goal's code in
it at a time, started and stopped from the cockpit or from a session, with a record of which. What
this document needs from it is two sentences.

`local_run` on the desktop channel reports what is running and, given a goal, starts it — so a session
carrying out a check asks for the application rather than starting one itself, and the thing it asks
is the same thing the cockpit's own control asks. And **`running` is not a reading**: it means the
session that brought the environment up did not fail, not that anything answered on the port. The
tool's reply says so in as many words, because a check reported `passed` on the strength of a status
is precisely the outcome this whole channel exists to prevent.

## Deferral and waiving

Two operator acts with opposite effects on the flag, kept apart because collapsing them would make
one of them dishonest. "The test environment is rebuilt on Thursday" is not "I am not going to check
this".

|              | `deferred`                                      | `waived`                    |
| ------------ | ----------------------------------------------- | --------------------------- |
| Means        | Not yet, and here is what I am waiting for      | Deliberately not doing this |
| Reason       | Required, with an optional `until`              | Required                    |
| At close-out | **Counts as not clear**, listed with its reason | Counts as clear             |

**Deferral cannot be used to reach a clear goal.** That is the whole guard: it takes a check out of
today's work and does not take it out of the count. Otherwise it becomes the quiet exit that `unrun`
is loud about.

**Waiving is also how a check the product has moved past is retired**, and it is the only way
([36](36-remote-validation.md#the-sheet-records-intent-and-a-person-retires-it)). Nothing infers that
a check has stopped applying, because nothing can tell that from a check that is failing — and the
guess would be made in whichever direction was cheapest to implement, silently. So the retirement is
an act somebody signs, with a reason, listed at close-out. That it cannot be reached by deferral is
the same guard read forwards: the two are kept apart precisely so the cheap word cannot do the
expensive word's job.

## The flag

`validationVerdict(checks)` (`src/validation/verdict.ts`, pure) answers `clear` — every live check
`passed` or `waived` — or `flagged`, with counts. It is the one answer: the plan sheet, the goal row,
the close-out obligation and the ticket comment all read it, so none of them can have an opinion of
its own about what "clear" means.

**`unrun` is weighted like `failed`, and that is the point.** A failed check is loud already. With
every check the operator's, the realistic failure is the set nobody got to — so the verdict counts
silence as a finding rather than as an absence. It is the same refusal `undeclared` makes: a verdict
nobody cast is not a verdict.

A plan with no checks is `clear` with a total of zero, and the per-goal reading shipped to the cockpit
is **null** rather than clear. Those are three different facts and the chip draws only two of them:
nothing was declared, so nothing is outstanding, and a goal nobody wrote a plan for has no chip at
all.

### Where it lands

Flagged blocks nothing. `conclude_work` is untouched, no dispatch is held, no merge is gated. It
changes five readings:

- **The close-out obligation** (`closeOutDetail`) states the counts and lists what is outstanding
  with its reasons. That is the moment: the row that says "close this ticket" is where an operator is
  about to close a goal and move on, and `recordHumanTask` refreshes the detail every pulse, so it
  states what is outstanding now rather than when it was filed.
- **`POST /api/human-tasks/:id/done` on a `close_out` task refuses without a note**, and the note goes
  on the row. Only that kind, only while open, only when flagged — asking a note of somebody ticking
  off "plug the cable in" is the friction that gets the whole flag ignored. The harness's own
  settlement, when it observes the ticket closed, is unaffected: that is not an operator deciding to
  move on, and a guard in the store would either stop the sweep or make its resolution the excuse.
  **`POST /api/human-tasks/:id/close-ticket` refuses on the same condition**, because the flag is
  about the goal rather than about which verb settles the row — a button that closed the item in
  silence would be the way around the rule.
  → [13](13-jobs-and-tickets.md#the-step-after-the-launch-the-close-out)
- **`POST /api/issues/:number/dismiss-run` refuses without a note**, kept on the run as
  `dismissNote`. The sharper of the two, because this is the button that ends the harness's run at a
  goal and it is one-way.
- **All three controls ask for the sentence before they post**, which is what makes the two refusals above
  something other than a control that does nothing. Neither used to: Done sent no note and had
  nowhere to type one, End the run sent none either, and the 400 reached a `catch` that dropped it
  and an unhandled rejection — so a rule stated as "it costs a sentence" arrived as a button that
  swallowed clicks. The bench's Done reads `Done…` and opens the same box Decline uses — and so does Close the
  ticket…, one box for all three; End the run
  opens `EndRunModal` — on **every** goal now, because ending a run also kills the goal's agents and
  cancels its queued work ([16](16-http-api.md#post-apiissuesnumberdismiss-run)), so it confirms
  whether or not a plan is flagged. What the flag still decides is what happens _inside_ that modal:
  the note is required and the confirm disabled until it is filled. Both mirror the route in its
  **condition only** — `close_out` on a goal whose
  `validation` is `flagged` — and never in its counts, which stay the server's fold; and the route
  stays the authority, so a plan flagged between the draw and the click refuses there and the refusal
  is drawn where it lands. → [17](17-cockpit.md#saying-the-sentence-a-refusal-asks-for)
- **The bench row** that says the goal is ready to be validated lists the same outstanding checks,
  from the moment of the delivery rather than at the point of closing —
  [above](#saying-so-on-the-bench).
- **The plan's status comment** carries the checklist, open rather than folded — a reader of the
  ticket next month is trying to find out whether it was checked, and that reader is not on the
  operator's machine.

The discipline the two notes borrow is `/api/human-tasks/:id/decline`'s, for its reason: there must
be no way out that costs nothing to say.

## Routes

`src/server/routes/validation.ts`, a module and a `ROUTE_MODULES` entry — `app.ts` stays wiring only
([16](16-http-api.md)). Every handler is wrapped in `checked(schemas, handler)`; a refusal is a
returned value, never a throw.

| Route                                                   | Does                                                                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `POST /api/issues/:number/validation/:checkId/result`   | `{result: passed｜failed, note?}`. `note` required only when `result` is `failed`. |
| `POST /api/issues/:number/validation/:checkId/defer`    | `{reason, until?}`.                                                                |
| `POST /api/issues/:number/validation/:checkId/waive`    | `{reason}`.                                                                        |
| `POST /api/issues/:number/validation/:checkId/reset`    | Back to `unrun`; the undo for all three.                                           |
| `POST /api/issues/:number/validation/:checkId/handover` | `{to: fleet｜human}` — the only writer of `actor`.                                 |

The required account is called `note` on `result` and `reason` on `defer` and `waive`, and each
route's 400 says the name **its own** body takes. The 400 body joins the schema's messages and drops
their field paths ([16](16-http-api.md#request-validation)), so the message is the caller's only
statement of which field is wrong — and zod strips the unknown key, so a refusal naming the wrong one
asks for a field that is then discarded, refused again, forever.

Handing a **settled** check to the fleet is refused with a 400 pointing at `reset`, rather than
accepted and silently doing nothing: the rule only ever runs an `unrun` check, so it would otherwise
look like it took and then never move — and refusing also protects the reading, since an agent
re-running a check behind the person who settled it would overwrite their answer. Taking one back is
always allowed; it stops something from happening.

`:number` is the goal and `:checkId` is the check's id, never its letter — the letter is what a person types, the id is what
the store is keyed on. A check whose plan has superseded it answers **409**, not 404: the commonest
cause is not a typo but an amendment landing between the sheet being drawn and the click.

**No route here runs a cycle.** Nothing schedules work, so a pulse per checkbox would be the cost of
saying nothing.

## Persistence

`src/store/validation.ts`, the only module touching these tables, taking a `StoreContext` and
delegated to under the same method names ([14](14-persistence.md#shape)).

- **`validation_checks`** — `origin_ref`, `id`, `letter`, `seq`, `title`, `check_do`, `check_expect`,
  `uses`, `covers`, `fleet_candidate`, `candidate_why`, `actor`, `handback_note`, `claimed_by`,
  `claimed_at`, `state`, `result_note`, `result_by`,
  `result_at`, `defer_until`, `superseded_reason`, `created_at`, `updated_at`. `check_do` rather than
  `do` because DO is a SQLite keyword; `check_expect` follows it so the pair reads as a pair.
  `revision` is JSON — the wording an amendment replaced and the reading it withdrew, kept as one
  record because it is read as one.
- **`validation_resources`** — `origin_ref`, `name`, `kind`, `note`, `provided`, `human_task_id`.
- **`validation_plans`** — `origin_ref`, `hint`, `note`, `empty_reason`, `authored_at`, `updated_at`.
  The goal's validation plan in both halves: the plan document writes `hint`, the validation planner
  writes the rest. `authored_at` null is _the check set has not been written yet_, which is what
  sheet assembly and rule `validation-plan` both read — never a check count, because an empty set is
  an answer. A fresh table, declared with an **empty `ColumnMigrations` anyway**: a table being new
  once does not keep it exempt, and `validation_checks` collected exactly that debt one change later.

Both tables shipped as fresh `CREATE TABLE`s and both declared an **empty `ColumnMigrations`
anyway**, on the argument that a table being new once does not keep it exempt. The band collected
that debt one change later: `revision`, `amended_at` and `amend_note` have real entries, and without
them every database from before `validation_amend` would have read `undefined` for all three and
silently drawn no band at all ([14](14-persistence.md#migrations)). `actor` and `handback_note`
arrived the change after that and fail the same way, more quietly still: a column whose absence
reads as `human` is one whose absence is invisible, and the hand-over control would simply never
take. `claimed_by` and `claimed_at` arrived with the desktop channel and are quieter still: their
absence reads as "nothing is claimed", which is true of every database that predates them and stays
true forever afterwards — the claim would never be written, so the fleet would keep dispatching
checks a person was in the middle of running, on precisely the deployments that upgraded rather than
started fresh. `issue_runs` gained `dismiss_note` the same way.

A row carrying one half of a claim without the other reads as claimed by nobody, which is the safe
direction here for `actor`'s reason inverted: an unreadable claim becoming live would block the fleet
from a check forever.

`result_by` needed no migration when it gained `agent`, nor again when it gained `desktop`, nor a
third time for `spec` — the column existed and only gained values it may hold. `area` is a different
case and has a real entry: it is a column on an **existing** table, so without one it is invisible on
every database from before it existed, every check reads as unautomatable and every remote sheet is
all-manual, with nothing red. Its null means _no area declared_, which is true of every older row and
stays true, so it needs no backfill ([14](14-persistence.md#when-a-null-means-something)). `steps` is the same case one change later, and its null is the same kind of fact: a check written
before test plans existed genuinely had none, so null reads as `[]` and stays that way. `parseSteps`
answers `[]` for anything it cannot read back, which is the reading rule this column shares with
`revision` — a half-written test plan the fleet acts on would be worse than none.

`rowToCheck`
narrows it, `checkStateOf`'s sharp edge: a reading attributed to something this does not recognise
reads as attributed to nobody, and `actor` narrows the same way, to `human`, because an unreadable
column becoming a hand-over would dispatch an agent nobody asked for.

## The cockpit

**The plan defines the checks; the goal manages them.** Those are two jobs, and they are drawn on two
surfaces.

The **goal page** carries the `ValidationSection`
(`web/src/components/ValidationSection.tsx`) — a full-width card above the plan, and the only place a
reading is recorded. That is where a check is keyed anyway: a verdict hangs off the goal, not off the
plan that proposed it, and running one is work against the delivered goal, done days after the plan
was approved and usually by somebody with no reason to open it. A control reachable only from inside
the document that proposed it is a control nobody finds. Each row draws its letter in the gutter where
a part's sequence number sits, because it is the same kind of handle, and collapses to its head — with
the amendment band, the hand-back band and the result note staying visible on a closed row, because
those are what a reader must not scroll past. → [17](17-cockpit.md#validation-on-the-goal)

A **settled** head — passed or waived — is drawn a step back from one still to run, so the card reads
as the work that is left rather than as the whole list. Scoped to the head, lifted when the row is
opened, and lighter than the treatment a withdrawn check gets: withdrawn and done are not the same
news. → [17](17-cockpit.md#validation-on-the-goal)

Both surfaces draw the **empty** case off the goal's `ValidationPlanRecord` rather than off the
absence of rows, and they draw it identically — the digest and the section describe one check set,
and the failure worth designing against is the two describing one goal differently.
→ [Saying nothing was worth running](#saying-nothing-was-worth-running)

The **plan sheet** keeps a read-only `ValidationDigest` between the parts and the caveats, with a rail
entry carrying the settled count — the reading order is answer, then work, then how anyone knows it
worked. A plan under review has to show what it proposes to check; it just offers no verb, and points
at the goal instead. → [17](17-cockpit.md#the-validation-digest)

Three markers say who, and each exists because its absence would be read as something else: **with
the fleet** on a handed-over check, **running at ‹label›** while a desktop session holds a **live**
claim (the timestamp on the hover; an expired claim is not shipped at all, so the chip and the fleet
list's keyboard entry go together), and beside a reading, who took it. A reading by a person draws
nothing, because that is what a checklist already means; every other `resultBy` draws its own words,
and the two machine ones are **never one word**: _recorded by the project's own browser suite_ is
reviewed repository code, and _recorded by a one-off script — unreviewed_ is a throwaway written for
this check alone.

An open row draws the **test plan**: each step in order, its kind, who carries it and — where it is a
person's — why, off `ValidationStep.why`, which names the block that would have made it the fleet's.
A one-off script's **source** is drawn there beside the step that carries it, because it is small
and goal-scoped and reading it is cheaper than trusting it; where the grace sweep has taken it, the
step says so rather than reading as a `browser` step a person always drove.
→ [36](36-remote-validation.md#the-one-off-script)

A **capture** is drawn inline, on the closed row beside the reading, and links out to the full image.
A `captured` check asks for exactly one thing — somebody's eyes — and a state chip that only said the
word would make an operator go and find the image before they could answer it. It carries its own
hue, `--cn-captured` and the `captured` tone: not amber, which would say _nobody has started_, and
not green, which would say it passed. The four reading buttons are offered on a `captured` row as
they are on an `unrun` one, because a person's reading is the only thing that settles it.
→ [36](36-remote-validation.md#handing-a-screen-back-to-look-at)

Every control writes an operator's reading and derives nothing: there is no "mark all", and no state
is inferred from a merged part or a green build. Superseded checks are drawn folded, as the record of
what a plan withdrew — a surface that filtered them would leave a reader unable to tell a check that
was dropped from one that was never written. They stay on the **sheet**: what an amendment dropped is
a fact about that plan, while the goal's card lists what is still to be checked.

The goal page also carries the verdict as a chip beside the appraisal and the conclusion, inside neither —
and that chip is a button, because the checks are now on the same page and a verdict you can act on
should not be the one reading that goes nowhere.

## Tests

`test/validationScriptCapture.test.ts` (the two readings: that a one-off script rides a `browser`
step and nothing else, that its source reaches the check briefing marked as not that dispatch's to
run, that a script check with no tenant blocks naming the command or variable that would provide one,
that its reading is attributed `script` and that a script and a spec never overwrite each other, that
a script reporting nothing under its own id is blocked rather than passed, that a run whose only
confirmed check carries a script still owes an agent and briefs it with the source, that the grace
sweep removes a script past its window and stamps where it was while leaving a fresh goal alone, and
that a `captured` report attaches the screen without going green while a row from before the state
reads `unrun`, and — on the sheet's own run — that a `screenshot` check's screen is kept with the goal
rather than the run, that a check which came back without one is `blocked` and never passed, that a
capture named as a path or a URL is refused and nothing is moved on the strength of it, that a screen
beside a suite assertion keeps the `spec` attribution while a red is never withheld for it, and that
a run whose only confirmed check hands a screen back still owes an agent), `test/validationAuthoring.test.ts` (the authoring move: that a legacy plan document's full check set
still ingests and is not an authoring, that a hint-only block withdraws nothing where an explicit
`[]` withdraws everything, when the rule dispatches and the three gates that stop it, that the
dispatch goes through the candidate list rather than an inline `raw.push`, that the hint, the
coverage part and the environments reach the agent, the origin's classification and its spend phase,
the tool's two refusals and what a refused call does not stamp, that `validation_amend` is refused at
the planner's own origin, that sheet assembly waits — with the staleness guard cut first — and that
the record reaches the cockpit before and after authoring, which is what makes a required
`emptyReason` worth requiring),
`test/validation.test.ts` (the schema's refusals, letters, what an amendment may do to a check
somebody has run, and the resource ask: that it waits for the delivery, that a replan which stops
needing the resource withdraws it, and that a withdrawal never overwrites the operator's own answer), `test/validationFlag.test.ts` (the verdict, the close-out obligation, the two
notes, and that a flagged goal still blocks nothing), `test/validationNote.test.ts` (the cockpit's
half of those two notes: that both controls ask for the sentence on a flagged goal and neither does
on a clear one, that the note reaches each route as the route reads it, and that a refusal arrives at
the caller in the server's own words), `test/validationAmend.test.ts` (the
tool: who may amend, that an amendment withdraws nothing by omission, what a rewording costs, and
the band), `test/validationFleet.test.ts` (the hand-over: the rule's gates and its position in
the pipeline, who may report, what a hand-back does not write, and what withdraws a hand-over),
`test/validationFailed.test.ts` (the diagnosis: that only a `failed`
check gets one, that it is read-only on the default branch in its own namespace, that the dispatch
clears no verdict — the goal stays delivered and parked — that each reading gets its own attempt
budget, and that the agent it sends is refused a reading), `test/validationReady.test.ts` (the bench row: what files it, that a check with the fleet does not and
a hand-back does, that a settled row is never written over, and that the results settle it), and
`test/validationDesktop.test.ts` (the desktop channel: that no fleet tool is reachable from it, the
credential's mode, that a second harness cannot take the stable socket, one claim at a time, the
three ways a claim is released, that a reading is attributed to `desktop`, and `local_run` — the
rendered instruction, an operator's override reaching the session, the caution surviving that
override, and an answer for a goal with no plan where `validation_read` refuses).

The verdict tests assert **both** directions, `planApproval.test.ts`'s discipline: a verdict that
counts `deferred` as clear and one that does not are one edit apart, and only one of them is honest.
The amendment tests do the same with the rewording rule, which has the same shape: a check whose
wording changed loses the result, and one re-declared word for word keeps it. The hand-over tests
assert three pairs on the same principle — a nominated check that nobody handed over dispatches
nothing while a handed-over check that nobody nominated dispatches; a hand-back writes no reading
where a result writes one; a rewording withdraws the hand-over where a word-for-word re-declaration
keeps it.
