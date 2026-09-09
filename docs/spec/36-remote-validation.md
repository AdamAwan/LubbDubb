# 36 — Remote validation

> **Partly built.** What runs is the `validate` block on an environment and the refusals that keep it
> from meaning something it cannot ([Configuration](#configuration)); the `state` query kind with its
> three writers and the `state_declare` tool
> ([Queries](#queries-are-per-goal-harness-held-and-never-committed)); the `StateReader` seam and its
> scripted fake ([Seams](#seams-and-why-the-fake-comes-first)); the dry run that makes a query
> runnable, with approval written on `(query digest, environment)`
> ([A query is approved](#a-query-is-approved-by-a-person-before-it-is-ever-run)); the `coverage`
> field on a plan part with the bar note that governs it
> ([Browser coverage is a plan part](#browser-coverage-is-a-plan-part-and-it-holds-the-goal)); and —
> as of the sheet an arrival assembles — **the sheet itself** ([The sheet](#the-sheet)), the **desk**
> that assembles one off an arrival and runs its approved deterministic rows
> ([The desk](#the-desk)), the sheet tables and `goal_arrivals.sheeted_at`
> ([Persistence](#persistence)), the minimal bench line, and the **cockpit card** that draws a sheet
> ([The cockpit](#the-cockpit)); and — as of the press — **the press itself**
> ([The press](#the-press)), the **pin** that asks whether the goal's work is still in the deployed
> commit ([The pin](#the-pin-asks-whether-the-work-is-still-there)), the **lock** on
> `(environment, tenant)` enforced in SQL ([Uniqueness](#uniqueness-is-environment-tenant-enforced-in-sql)),
> the **run row** with the commits every reading through it straddled, and the **tenant** in its three
> shapes with its `reseed` command and the age drawn at the gate ([Tenants](#tenants)); and — as of
> the runner seam — the **`RemoteRunner` seam** with its scripted fake
> ([Seams](#seams-and-why-the-fake-comes-first)), the **pre-flight** that asks the deployed runner
> which selectors it offers before an operator consents to anything
> ([What runs at assembly](#when-a-sheet-is-assembled-and-what-runs-without-asking)), and
> `validation_checks.area`, the selector a `check` row is verified against
> ([Migrations](#migrations)).
>
> **Everything else is still a design**: no dispatch rule, no `remote_validation_report`, no fold of a
> report into readings and no `spec` reading. A run is still nobody's to carry out, so a `check` row
> is blocked or manual, and with no agent in this build a press runs the sheet's
> confirmed **deterministic** rows synchronously under the pin. A path is written in italics
> until the thing it names exists, and a section that is still a description rather than an account
> says so where it starts. The behaviour is settled — it is
> [#840](https://github.com/AdamAwan/LubbDubb/issues/840) revision 9 written into the tree — and the
> staged order it gets built in is [`docs/plans/36-remote-validation.md`](../plans/36-remote-validation.md),
> deleted by the change that finishes the last stage.

`src/remoteValidation/`. A goal's work has arrived in a real environment ([24](24-environments.md)).
This is the one page an operator opens to answer the question that arrival raises and nothing in the
harness answers today:

> **Does the product still work as expected, now that this change is in it?**

Not _did this commit behave correctly in isolation_ — the branch's own CI settled that before it
merged. The **sheet** is asked after the work is somewhere real, about the product as it now stands:
the journeys still work, nothing is screaming, the numbers are no worse, and the data the change
writes is shaped correctly. It assembles the goal's existing validation checks
([20](20-validation.md)) beside declared queries, puts them all against one environment, and settles
them in one place.

Three things the harness already has each answer a third of that question and none of them can be
read together: a validation check is a procedure a person carries out ([20](20-validation.md)); the
post-deploy watch reads declared telemetry over a window ([29](29-post-deploy-watch.md)); local
validation drives the machine's one dev environment against work still in flight
([32](32-local-validation.md)). What none of them can do is drive the browser suite the consuming
project already has, against the environment that project already deploys to, with the credentials
that project already holds.

The governing principle, and everything below follows from it:

> **The harness owns the sheet, the schedule and the contract. The project owns every command, path,
> name and credential.**

The harness never generates a tenant identifier, never constructs a test-runner invocation, never
holds a database connection, never sets a retry policy, never decides that a check has stopped
applying, and never assumes one environment has one name. Each of those is knowledge only the project
or the operator has, and each wrong guess fails **silently** rather than loudly — which is why the
principle is a rule rather than a preference.

## Off by default, and off in one place

**`environments` is an empty list by default, and `validate` is optional on an environment that
exists.** A deployment that edits no configuration gets no sheet, no row, no bench line, no cockpit
surface, no prompt note and no spawned command — and that is inherited rather than re-implemented:
`environments` is already the off switch for everything in [24](24-environments.md) and
[29](29-post-deploy-watch.md), and this hangs off the arrival that subsystem records.

There are four gates, and the point of naming them together is that a later change must not add a
fifth surface that misses one:

| Gate                                    | Off means                                                                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `environments`                       | No probe, no arrival, nothing to assemble a sheet from. The whole subsystem never runs.                                                                                             |
| An environment with no `validate` block | No sheet is assembled for its arrivals, and **the arrival is left unstamped** — see [the desk](#the-desk).                                                                          |
| No `validate.state` anywhere            | `state_declare` is not named to any agent and refuses a caller by name. → [The prompts](#the-prompts)                                                                               |
| No `validate.browser` anywhere          | The test-part bar is not appended, so a planner cannot declare a part nobody can build. → [Browser coverage is a plan part](#browser-coverage-is-a-plan-part-and-it-holds-the-goal) |

**Nothing here is drawn empty rather than absent.** A card of question marks on a deployment that
configured nothing is a feature announcing itself as broken, which is the rule the environments card
and the signals card are both already built to.

**One thing does happen on every deployment, and it is the only one**: the tables are created and the
columns are added on the boot that takes the build. All of them are inert, none is backfilled, and
a database that never sees a `validate` block never has a row written to any of them.
→ [Migrations](#migrations)

Turning it on is one block on one environment, and the honest first setting is an acceptance
environment with `permits: ["state"]` — read-only, cheap, and nothing driving a browser anywhere.

## What it is not

Stated first, because each boundary is a thing the harness already does and would otherwise be
re-litigated:

| Not                        | Because                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A new set of checks        | The `check` rows **are** the goal's validation checks ([20](20-validation.md)), assembled against one environment. Nothing here authors a second checklist beside the one an operator already keeps.                                                         |
| The critical-path suite    | The deployment pipeline runs that on every build, and this design assumes it. The sheet runs the areas **this goal** is about. → [Keeping the critical path lean](#keeping-the-critical-path-lean)                                                           |
| The post-deploy watch      | A watch is **windowed** — it accumulates telemetry over hours and asks _is this behaving_. A sheet row is **point-in-time**, taken at a press. Different clocks. → [Two lifetimes](#two-lifetimes)                                                           |
| Local validation           | That drives the machine's one dev environment against work **still in flight**, exploratively, and records no reading on any check ([32](32-local-validation.md)). This runs reviewed specs against a **delivered** goal in a place somebody else deployed.  |
| A deployment tool          | Nothing here deploys, promotes, approves or rolls back, and nothing writes to the environment. Every command it runs is the project's own, and every query is read-only.                                                                                     |
| An expiring document       | A sheet does not expire, and a second arrival re-runs the one that exists. A row records **what this goal meant to be true**, and intent does not rot. → [The sheet records intent](#the-sheet-records-intent-and-a-person-retires-it)                       |
| An obsolescence detector   | Nothing infers that a check has stopped applying. A person waives it, with a reason, through machinery that already exists ([20](20-validation.md#deferral-and-waiving)).                                                                                    |
| A gate                     | Nothing here holds a dispatch, a merge, a conclusion or a close. A failed row reaches `validation-failed` and changes no verdict. The one hold in the design is a **plan part's**, on an undelivered goal, and it is the plan's hold rather than this one's. |
| A dispatch input           | The desk that assembles a sheet is a lens over `src/environments/`, and nothing under `src/dispatcher/` may import either. The rule below reads the **store**. → [The lens boundary](#the-lens-boundary)                                                     |
| An agent's judgement       | An agent runs a command and says where the report landed. **Every** row outcome is folded by the harness out of that report. The tool has no field an agent could state an outcome in. → [The runner contract](#the-runner-contract)                         |
| Free-form SQL for an agent | A query is written once, read by a person, and accepted against **one environment** on the evidence of a dry run. Nothing runs an unapproved query, ever. → [A query is approved per environment](#a-query-is-approved-by-a-person-before-it-is-ever-run)    |

## The sheet

**One sheet per goal per environment**, assembled when the goal's whole work arrives there
([24](24-environments.md#what-an-arrival-means)). It is not a document authored beside the goal's
existing one: it is the goal's checks, with the declared query rows alongside them, so that _does it
work_, _is anything screaming_ and _is the data right_ are read in one place and settled together.

There are **three row kinds**. Until the browser half lands, a `check` row is **blocked or manual**:
where the environment permits `check` it is a person's to run and its result is recorded on the goal's
own validation row, and where it does not it is blocked saying so.

| Row kind             | Answers                                          | Run by                                                         |
| -------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| `check`              | Does the thing work?                             | A person, or specs already in the project's suite              |
| `signal` / `measure` | Is anything screaming? Is it slower than it was? | Declared query, the environment's `observe` command            |
| `state`              | Is the data the change writes shaped correctly?  | Declared query, the environment's `validate.state.run` command |

**`blocked` is an _outcome_, not a row kind.** Every kind can be blocked, and a kind is what an
environment `permits` — the two are orthogonal and nothing declares a permission to be blocked. It is
stated here because it has been misread twice: the outcomes below are what a row can _come back as_,
never what a row can _be_.

Rows keep their own downstream consequences. A failed `check` still reaches `validation-failed`
([20](20-validation.md#when-a-check-fails)); a regressed `measure` still holds nothing unless asked
([29](29-post-deploy-watch.md#it-holds-nothing-unless-asked)).

### What a row can come back as

| Outcome   | Means                                                                                                       | Writes on the check                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `passed`  | The run satisfied what was declared. A **retried pass is a pass**, and the row records that it was retried. | `passed`, `resultBy: 'spec'` — see [What a spec reading is worth](#what-a-spec-reading-is-worth) |
| `failed`  | The run did not satisfy what was declared.                                                                  | `failed`, `resultBy: 'spec'`                                                                     |
| `blocked` | **No reading was taken.** Nothing was learned about the goal.                                               | Nothing at all                                                                                   |

Seven things produce `blocked`, and the number of roads into it is the point:

- the row's query is **not approved for this environment**;
- the selector **matched zero tests**, or **matched more than it ran**;
- the environment does not `permit` that row kind;
- there is no private network, no credential or no tenant;
- the goal's work is **no longer in the deployed commit**, or the pin could not say;
- a **runner-level failure** skipped the tests a dependency was holding up;
- the environment **moved mid-run and the row failed**.

**`blocked` resolves per row, never per run**, and that is the sharpest edge in the document.
Reachability differs by row kind inside one environment: browser rows reach the app over public
ingress and `state` rows may need private network access. A machine without that access must still
produce every browser row and report the `state` rows `blocked`, publishing a useful sheet. `failed`
on an unreachable store is the most trust-destroying outcome available — it dispatches
`validation-failed` at code that is fine.

`waived` is deliberately not in that table. It is an **operator's disposition**, not something a run
produces, which is why no run may write it and why it appears on no outcome list here.

### The sheet records intent, and a person retires it

**A sheet does not expire, and a second arrival re-runs the one that exists.** A row is a statement of
_what this goal meant to be true_, and that intent does not rot because the world moved on — the goal
still either achieved it or did not.

What can happen is that the product moves so far the intent stops being meaningful. **The harness does
not try to detect this**, and the restraint is deliberate: it has no way to distinguish _this check no
longer applies_ from _this check is failing_, and a mechanism that guessed would resolve the ambiguity
in whichever direction was cheapest to implement, silently. Every candidate signal — a sheet that has
sat for months, a selector that finds nothing, a run against a much later commit — is equally
consistent with a genuine regression, which is the one thing the sheet exists to catch.

So a person says so, with machinery that already exists: **`waived`, with a required reason**
([20](20-validation.md#deferral-and-waiving)). It counts as clear at close-out and its reason is
listed there, so the goal finishes without the check being quietly dropped. Nothing new is introduced
and **no fourth verdict** is added.

That is safe rather than lossy because of the [test part](#browser-coverage-is-a-plan-part-and-it-holds-the-goal):
whatever moved the product past this check almost certainly amended or added the coverage that
describes the new behaviour, in its own change and its own review. The check being retired is a
superseded statement being retired after a better one landed.

**Waiving cannot be reached by deferral.** [20](20-validation.md#deferral-and-waiving) keeps the two
apart on purpose — deferral counts as _not clear_. Retiring a check is an act somebody signs.

## Two lifetimes

This is the rule everything else follows from, and it cuts cleanly down the middle of the design:

|                 | **Browser specs**                                | **Queries** (`state`, `signal`, `measure`)         |
| --------------- | ------------------------------------------------ | -------------------------------------------------- |
| What they are   | Code                                             | A question asked once                              |
| Where they live | The repository                                   | The harness, on the goal                           |
| How they arrive | **A plan part, reviewed and merged**             | Written by the working agent, approved by a person |
| Lifetime        | Permanent, versioned, **amended by later goals** | The goal's                                         |
| Ever in a PR    | Always                                           | **Never**                                          |

A query is never a file in the repository and never part of a pull request, for three reasons and not
one: committing it makes a question about a change nobody remembers permanent, and permanently
un-deletable in practice; it would need a reviewer holding the deployed store's schema in their head,
which a pull request's reviewer is not; and it is the wrong granularity — a query is one goal's
question, where a repository holds what is true across all of them.

**`state` rows belong to validation and not to the watch**, and that is the same rule read from the
other side. The watch is windowed; a `state` row is a point-in-time assertion about what is deployed
now. Folded together, one of them is on the wrong schedule, and the windowed one wins by default.

## Browser coverage is a plan part, and it holds the goal

When a goal's change needs coverage the suite does not have — **or invalidates coverage the suite
already has** — the planner declares a part for it: _add end-to-end coverage for checkout with a saved
card_, or _amend the checkout area to accept the new confirmation step_. It is built, reviewed and
merged like every other part ([08](08-planning.md)).

A part declares the area it covers in an optional `coverage` field on the plan document
(`src/plans/planDocument.ts`), stored on `plan_parts.coverage` (`src/store/plans.ts`) and carried back
on `PlanPart.coverage`. It is the string the sheet's selectors are resolved against —
`validation_checks.area` is the other side of it, and the pre-flight is what puts the two to a
runner. Everything else about
it is an ordinary part: it produces code, it has per-part `acceptance`, it merges, and
`partDeclarationNote` (`src/plans/parts.ts`) shows the building agent the area it was asked to cover.
→ [08](08-planning.md#the-seven-narrative-fields)

**Amending an existing spec is the normal case, not a conflict.** A goal that changes behaviour is
supposed to change the statement of that behaviour, in the same change, reviewed by the same reviewer.
That is what keeps the suite a description of the product rather than of its history — and it is what
makes retiring an older goal's check safe rather than lossy.

**A declared test part holds the goal, exactly as any other part does.** No special case, no soft
hold, no "delivered except for the test". If the plan says the goal is not done until the path is
covered, then it is not done until the path is covered: a goal that ships without the coverage its own
plan called for has quietly redefined itself, and the part would never be built afterwards.

That makes the **declaration** the decision, which is where it belongs:

- **Most goals do not get one.** The bar is strict and it is the same bar
  [20](20-validation.md#the-bar) states one layer over: automate when the failure would be **silent
  and consequential**, which is usually a common path. A refactor whose claim is that behaviour did
  not change declares no test part; so does a copy change, a config change, and most bug fixes.
  Nothing counts test parts and nothing rewards a longer list.
- **It is decided once, at plan time**, by whoever is deciding what the goal is made of — not per
  arrival, and not by the harness at a later moment when the cost is already sunk.
- **It is visible at plan approval and an operator can strike it** ([08](08-planning.md#the-approval-gate)).
  That is the pressure valve — a person deciding this goal does not need it — rather than a weaker
  hold every goal skips silently.

Everything else follows from it being an ordinary part: a test is code and **code gets reviewed**
before it can ever colour a row green; the part agent writes it as its own work, so there is no second
dispatch and no context paid for twice; and it merges before the goal is delivered, so by the time a
selector has to resolve, the spec is in the deployed build.

**A test part must not be declarable where it cannot be built.** A project with no browser suite —
concretely, an environment with no `validate.browser` block — would take a hold nobody can lift. So
the planner is told, in a note appended to the planning prompts, whether the deployment has one; where
it does not, the bar section is not appended at all and the check stays manual. That note is
`testPartNote` (`src/plans/planning.ts`), and its gate reads the narrow `validate.browser` shape
`EnvironmentConfig` (`src/environments/policy.ts`) now carries — the block's full parse and its
refusals are still to come. → [The prompts](#the-prompts)

**The field and the note ship together, and must never be split.** `PlanDocumentSchema` is zod and zod
**strips unknown keys**, so a note that reached planners before the field existed would have them
declaring a `coverage` that is silently dropped: no refusal, an ordinary part, the hold never taken,
nothing red.

**A replan does not retract a merged test part.** A merged spec is ordinary repository code and the
part that produced it is closed; a replan that wants it different declares a _new_ part to amend it,
which is the route any other goal takes to the same file ([08](08-planning.md#amending-a-running-plan)).

### Keeping the critical path lean

New specs must not accumulate into the deployment pipeline. One rule does almost all of the work:

> **The critical path is an allow-list, never a deny-list.**

The pipeline selects **only** what carries the critical tag, so a new spec is invisible to it until
somebody deliberately tags it, and _remember to exclude this_ — a treadmill nobody wins — never
arises. Promotion into the critical path is a separate, reviewed pull request with an argument
attached.

Two guards, because this is exactly the shape of failure that accrues silently. **An agent writing a
spec by copying a neighbouring one inherits its tags**, so a critical tag rides along and nobody
notices until the pipeline is two minutes slower; that is a rule stated in the test part's own prompt
note, and better still a committed manifest of critical test titles, so adding one produces a diff a
reviewer must accept. And a **wall-clock budget on the critical path**, asserted in the pipeline, so
bloat fails loudly on the change that caused it.

Both are project-side conventions rather than harness machinery, consistent with the governing
principle: **the harness passes the selector it is told and never reasons about tags.**

## Queries are per-goal, harness-held, and never committed

A `state`, `signal` or `measure` query is a question about one change at one moment. It is written
with the goal, stored on the goal, read at the sheet, and dies with it.

`signal` and `measure` queries are the goal's watch checks and are already declared — the sheet reads
them through `listGoalWatches` and declares nothing of its own. → [29](29-post-deploy-watch.md#who-writes-it-and-when)

`state` queries are new and have the same three writers, at the three moments each knows something the
others do not:

- **The planner, at plan time**, through an optional `state` block on the plan document beside
  `validation` and `watch` (`src/validation/stateDocument.ts`). It may seed one where the shape is
  obvious and often will not.
- **The working agent, at conclude time**, through `state_declare` — the writer that matters. The
  query depends on what was actually built: which table took the new column, which row the change
  writes. A planner reading the repository as it stood **before** the work cannot know that, and
  nothing downstream can recover it. Like `watch_declare` it merges on the slug, adds and amends, and
  **withdraws nothing**; a check that should go is the operator's to delete.
- **The operator, at any point**, from the goal's own page — and the operator is the only party that
  can make one runnable at all.

The planner is refused `state_declare` **by name**, `validation_amend`'s rule for its reason: it
already has a transport that declares the whole block, and two ways to say one thing that disagree
about what an omission means is the drift the split exists to prevent.

### A query is approved by a person before it is ever run

Agent-authored SQL against a real store is not something to run and report on unread, even read-only.
So a `state` row is **not runnable until an operator has read the query and accepted it**, and the
mechanism is the one the watch already has rather than a new one: the **dry run**
([29](29-post-deploy-watch.md#the-dry-run)). The query is executed, the operator sees the query text
_and what it actually returned_, and accepts or rejects on that evidence. A query that reads correctly
and returns nonsense is caught here, and only here.

**Built**, for `state` and — with the sheet that reads it — for a live watch check, whose second key is
written through `.../watch-queries/:queryId` and read by the desk exactly as a `state` row's is.

- **Approval keys on `(query digest, environment)`.** Digest alone leaks: the same text accepted
  against acceptance would arrive pre-approved against production, and _I have read this and it is
  safe here_ is a statement about a place as much as about a query. An unchanged query stays accepted
  for the environment it was accepted on; an edited one drops its old digest's approvals on **every**
  environment and is a new question again — an edit and an edit back must not resurface a consent
  nobody re-gave.
- **An unapproved query is `blocked`, never `failed`**, and the row says what it is waiting for.
- **Approval is a property of the query, not of the run.** Approve once per environment, run on every
  arrival.
- **`presence` gets the same treatment**, for the reason it exists: an unapproved presence query
  cannot distinguish a healthy release from a query naming a column that is not there.

The `signal` and `measure` rows carry the watch's own approval unchanged — an agent's `watch_declare`
proposal is not live until an operator accepts it, and `listGoalWatches` is live-only. What this
document adds for them is the second key: **a live watch check is still `blocked` on a sheet until its
digest has been accepted against _that_ environment.** The watch puts a query to one environment
because it is asking whether the query parses; the sheet puts it to a named place, and consent to a
place is not transferable.

## When a sheet is assembled, and what runs without asking

An arrival assembles a sheet and **never starts a browser run**. That gate is the only moment in a
goal's life when somebody looks at the list of checks with the delivered thing actually in front of
them, and it is where amendment, selection, waiving and consent to spend all naturally happen.

What runs at assembly, without asking:

- **Every approved `state`, `signal` and `measure` row.** They are read-only, consented and cheap, so
  the operator arrives at a sheet with those readings already on it. That is a better-informed press
  than an empty one, and it keeps the gate from becoming the bottleneck that makes people
  rubber-stamp it.
- **A pre-flight.** **Built**, in `src/remoteValidation/preflight.ts`, over the `RemoteRunner` seam.
  Ask the deployed runner, through `validate.browser.listSelectors`, which selectors it actually
  offers, and compare against what the sheet's `check` rows name in `validation_checks.area`. A
  selector is a compatibility surface between a harness-held check and a runner config in a
  repository that moves, and a mismatch is one of this design's own `blocked` causes — so it belongs
  **before** the consent, not afterwards as a blocked row that wasted the press. The listing is also
  the honest source of the **matched** count the [consistency check](#the-runner-contract) compares
  against, which is better than deriving it from the post-run report: derived the other way, a
  selector that matched nothing reads as a clean pass. It is written onto `remote_sheet_rows.matched`
  and read from nowhere else.

  Two rows the pre-flight leaves exactly as they are, and both matter. One another cause has already
  blocked keeps the reason it has — a kind this environment does not permit is not a mismatch. And a
  check that **names no area** is a person's, exactly as every check is today: the pre-flight asks a
  runner about areas, and a check declaring none was never a question for it. Where the listing
  itself could not answer — a non-zero exit, a kill, nothing printed — every `check` row that names
  an area is `blocked` with that reason and **nothing else on the sheet is touched**: `blocked`
  resolves per row and never per run, so the `state`, `signal` and `measure` readings that landed
  beside it stand.

Everything else waits for the press. The bench obligation is _this is ready to run — review it and go_,
and four things happen there:

- **Query approval** — the dry run, for anything not yet accepted here.
- **Amendment** — a check written at plan time against code that did not exist yet, reread against
  code that now does, through `validation_amend` ([20](20-validation.md#amendment)). A check whose
  selector the pre-flight could not find is exactly a check that needs rewording.
- **Selection and waiving** — a row that does not apply to this environment, or that the operator will
  do by hand, is deselected; a check the product has genuinely moved past is **waived with a reason**.
- **Consent to spend** — browser rows cost minutes and an agent. Starting them automatically spends on
  every arrival, including the ones nobody was going to read.

The tenant's age is drawn at the gate too, which is where an operator can act on it. → [Tenants](#tenants)

## The press

**Built.** `POST /api/issues/:number/remote-validation/:environment/run`, in
`src/server/routes/remoteValidation.ts`, over `RemoteRunDesk` (`src/remoteValidation/run.ts`).
In order: refuse **409** if a run is already live for this `(environment, tenant)`, naming it; refuse
**400** if nothing is selected; take the pin; open the run row; broadcast; **run a cycle**.

With no browser in this build, what a press runs is the sheet's confirmed **deterministic** rows —
the approved `state`, `signal` and `measure` ones — synchronously, through the **same**
`RemoteValidationDesk.readRow` the assembly used. A second reader would be free to disagree with the
assembly about what a row of that kind is. That is what makes the run row, the lock and the pin real
rather than scaffolding waiting for the browser half's agent.

**This route runs a cycle**, `validate-locally`'s reason: the run is work, and waiting for the next
heartbeat spends those minutes on nothing. No other route here does — nothing else schedules anything.

### The pin asks whether the work is still there

**Built.** Before a run opens, the harness asks the question the design actually cares about: **is this goal's
work still in the deployed commit?** Not _is the sha the one the sheet was assembled against_.

`GitObserver.contains(landingShas, [deployedSha])` answers it, three-valued
([24](24-environments.md#the-three-verdicts)), where `deployedSha` is what the environment's `at`
command says **now**:

| The clone says           | What happens                                                                  |
| ------------------------ | ----------------------------------------------------------------------------- |
| every landing is reached | The run opens.                                                                |
| some landing is not      | **Abandoned**, with the reason: this environment has gone back past the work. |
| the clone could not say  | **Abandoned**, with the reason. `unknown` is never folded into either.        |

An environment that has moved **forward** still contains this goal's work, so the reading stands. That
is the whole difference between this pin and [32](32-local-validation.md#the-pin)'s, and it is
deliberate: local validation drives a checkout the harness owns and a moved checkout is a different
subject, where a deployed environment is _supposed_ to move and a design that abandoned on sha
inequality would starve any project that deploys faster than it validates.

An abandoned press writes `blocked` on nothing and **no readings at all**: it is a run that never
started, and it says why in the sheet's own words.

### Uniqueness is `(environment, tenant)`, enforced in SQL

**Built.** `beginRemoteRun` (`src/store/remoteValidation.ts`) has `beginLocalRun`'s shape: the mutual
exclusion is a conditional insert **inside the transaction**, with a partial unique index on
`(environment, tenant) WHERE status = 'running'` behind it — never a check the caller is trusted to
make first.

Keying on the environment alone is the failure worth naming: two operators validating one environment
against two tenants would overwrite each other's readings — a silent wrong answer rather than a
visible clash. Keying on the tenant as well is what makes a second press against a second tenant a
second run rather than a race.

## The runner contract

A browser suite is not a flat directory of specs. It has a runner config with a dependency graph:
named projects, auth-setup projects others depend on, deliberately serialised pairs that avoid state
races, per-project stored credential state. Invoking a runner binary against a spec file directly
bypasses all of it and fails at the first authenticated call. So:

- **The environment declares a runner command in committed project config, and the harness invokes
  _that_.** It never constructs an invocation itself, and it never takes the command from anywhere but
  the project's own config.
- **Selectors and the environment profile ride as parameters, in env vars** — `LUBBDUBB_ENVIRONMENT`,
  `LUBBDUBB_PROFILE`, `LUBBDUBB_SELECTORS`, `LUBBDUBB_TENANT`, `LUBBDUBB_REPORT_DIR`. A command is
  never assembled from them.
- **A selector names an area, never a file path.** A path breaks the first time a later goal
  reorganises the specs inside it, and it breaks silently, as a selector matching nothing.
- **Specs are resolved from the environment's _current_ commit, at run time.** Not from a working
  tree, not from the default branch's tip, and not from a commit frozen when the sheet was assembled.
  The environment holds a particular build and the specs that describe that build are the ones in it —
  a spec is a living statement of what the product should do, and a frozen historical commit states
  what it used to be supposed to do.
- **All confirmed rows for one `(environment, tenant)` run in a single invocation.** Auth setup has a
  fixed per-invocation cost — an identity-provider round trip, often several — that dominates a small
  spec's runtime.
- **The project exposes a dedicated selector namespace**, so validation and the pipeline never trigger
  each other.

### The report is the only source of row outcomes

> **The runner's machine-readable report is the only source of row outcomes. The exit code is never
> read.**

One invocation carries many rows and one exit code, so inferring anything from that code is guaranteed
to be wrong for some row. From the report, and from nothing else:

- a row whose selector **matched zero tests** is `blocked` — a renamed area, a deleted spec, a wrong
  profile. Never `passed`. With generated specs gone this is the _ordinary_ failure rather than an
  exotic one, which is what makes the rule load-bearing rather than defensive.
- a row where **fewer tests ran than the selector matched** is `blocked`. This is the narrowing case:
  a focus marker, a skipped assertion, a filter — a run that exits zero having verified almost
  nothing. The check is **matched-versus-executed consistency**, never a count declared on the check,
  which would be a number to keep in step that rots the first time a spec is legitimately split.
- tests **skipped because a dependency failed** are `blocked`, not `failed` — that is what a failed
  auth-setup project looks like, and only the report distinguishes it.
- **a retried pass is a pass**, and the row records that it was retried. Retry policy belongs to the
  project's runner config, not to the harness. Repeated retries on one area are a signal about the
  spec, surfaced through [what a row records](#artefacts-and-making-worth-observable) rather than
  treated as a failure.

### The environment-moved asymmetry

The deployed sha is read from `at` at the start of the run and again at the end. If it changed:

> **A failure is `blocked`. A pass is still a pass.**

The asymmetry is the point. A run that started against one build and finished against another cannot
support a claim that the product is broken — the thing under test changed underneath it — but it can
perfectly well support the claim that a journey completed, because it did. Treating both the same
either discards good readings, starving any project that deploys faster than it validates, or reports
failures the code did not earn. **The row records which commits it straddled**, so the reading is
readable as what it is rather than as an unexplained block.

The obvious alternative — probe whether a deploy is queued and hold the run — is declined: it needs
deploy-schedule knowledge the harness does not have and cannot be told without a fourth command.

### The state command contract

**Built**, in `src/remoteValidation/stateReader.ts`. A `state` row is executed by a project-supplied
command, `validate.state.run`, that receives the approved query **out-of-band** — in a file, or in an env var, **never interpolated into a command
string** — and emits the harness's row contract on stdout.

The command form is not a workaround for a hard case. It is what makes the **easy** case work:
querying with the operator's own identity is often the cheapest path — no service principal to
provision, no secret to store, no connection string in config — and it is exactly the path a
harness-held DSN cannot take, because that credential may be an interactive or cached login rather
than a string. **A project-supplied command inherits the operator's logged-in identity for free.**
Where the credential really is just a connection string, that command is a five-line script, which is
cheaper than a second mechanism in the schema.

The contract is [29](29-post-deploy-watch.md#the-output-contract-which-is-all-the-schema-the-harness-has)'s,
unchanged and **shared rather than copied** — the same parser in `src/environments/watchResult.ts`
reads both, so the two executors cannot drift about what a row is:

- a JSON array of rows on stdout, exit 0;
- **rows, never counts** — the same aggregating-tail refusal, at ingestion, through the same
  `aggregatingTail`, because a query that aggregates defeats every guard the contract has;
- a `presence` query, whose zero is `unknown` and never clean;
- every row carries the id echo in `lubbdubbWatchId`, and a result that does not carry it back is not
  an answer;
- read-only access with a statement timeout, which is the project's to set in its own command.

Anything else — a non-zero exit, a timeout, no output, output that is not a list of rows — is the
observation failing, which is `blocked` here rather than `unknown`, because a sheet's vocabulary for
"no reading was taken" is `blocked` and a second word for one fact is a second thing to teach every
consumer.

## Tenants

**Built**, in `src/remoteValidation/tenants.ts` — `TenantKeeper`, `CommandTenantKeeper`, its scripted
fake in `src/remoteValidation/fakeTenantKeeper.ts`, and the pure `resolveTenant` the press, the gate
and the cockpit all read.

**The harness never generates or infers a tenant identifier.** Environments commonly run reapers that
hard-delete tenants matching a name pattern past a short age; a harness-invented name survives about
an hour, and its disappearance presents as mysterious mass failure. The rule costs nothing in the easy
case and is the whole ballgame in the hard one.

A project supplies one of three shapes, and the schema does not force the awkward one on a project
that has the easy one:

| Shape          | When                                                                                                                                                                                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant`       | A literal name — **the shape to prefer**. A stable name means a failed row points at something that still exists and can be opened.                                                                                                                                                                                                     |
| `tenantEnv`    | The name of an env var carrying a per-operator value. Config names the variable; the harness reads it into the spawn env and nowhere else — the **lock and every surface carry the variable's own name**, `$VALIDATION_TENANT`, never what it holds. A variable nobody set blocks the press, naming it.                                 |
| `ensureTenant` | An idempotent command, where tenancy is provisioned on demand. Possibly very slow, so it is an **operator-invoked setup step, never run per arrival**; a missing tenant produces a legible `blocked` naming the command. It **prints the tenant it provisioned**, and that name — the project's own — is what is stamped and locked on. |

An environment that supplies none of the three permits no row kind that needs one, and says so. A
deterministic row needs none, so such an environment presses on the **empty key** — the absence,
rather than a name the harness made up.

The two operator acts on a tenant are one route,
`POST /api/issues/:number/remote-validation/:environment/reseed`: where the environment provisions on
demand it runs `ensureTenant` first, and where it declares a `reseed` it runs that, stamping
`remote_tenants` with whatever the project's own command named. Neither ever runs per arrival.

### Persistent tenants drift, and drift looks exactly like a real failure

That is the cost of the literal-name model this document prefers. A standing validation customer
accumulates the residue of every previous run — uploads, mutations, actioned records. Suites already
fight intra-run collisions with serialisation and none of that helps across runs. Eventually a spec
assuming seeded fixture data fails for reasons unrelated to the deployment, and **a red row that is
not the code's fault is worse than no row**.

So the environment declares a **`reseed` command**, the harness records when the tenant was last
reseeded (`remote_tenants`), and **the tenant's age is shown at the gate** — which is exactly where an
operator can act on it: reseed first, then press.

**Staleness is a qualifier on the reading, never a fourth outcome.** A fourth state multiplies against
every row kind and every environment and needs teaching to every consumer of a reading, where _failed,
against a tenant 19 days old, beyond the declared 7-day window_ tells the reader everything without
touching the state machine. `stalenessNote` is the one place that sentence is written, appended to a
reading's own detail; the vocabulary stays `passed | failed | blocked`, asserted on the vocabulary
itself rather than on one row.

## One environment has several names

The name the deployment system uses for a place, the name telemetry carries for it, and the name the
browser suite's profile uses are three different strings, sometimes in ways that look like typos and
are not. The environment block already handles this implicitly for watch commands, by baking the right
alias into each command's arguments, and **that property is kept**: per-row-type aliasing stays
possible and there is no single canonical name.

The harness therefore never derives one name from another. Where a name is wrong, the failure mode is
a query returning zero rows rather than an error — which is why the guards that catch zero
(`presence`, matched-versus-executed) are the ones this design leans on.

## Each environment declares which row kinds it permits

Not all-or-nothing. Driving a browser through a live environment is a different risk conversation, not
a config flag — but **read-only `state` rows against live are a much easier yes**. So the environment
declares its permitted row kinds — `check`, `state`, `signal`, `measure` — and a row of a kind the
environment does not permit is `blocked`, saying so.

An acceptance environment only, at first: a deployment that declares `permits` on nothing gets no
sheets at all, which is the off switch.

## Artefacts, and making worth observable

CI suites already publish an HTML report — traces, screenshots, video retained on failure — to a
static host under a per-run path, and that report is the only reason a CI failure is actionable at
all. The environment declares an **artefact publish command**, `validate.browser.publishArtefacts`,
and each browser row carries the resulting **URL**.

A stdout tail is not enough, and the argument is the whole reason the command exists: the gap between
_a red row you click into and understand in thirty seconds_ and _a red row you reproduce by hand_ is
the gap between a sheet people use and a sheet people stop opening.

Recorded per browser row: **wall-clock**, **tests matched and executed**, and **retries**. Areas that
are slow, areas that never fail, and areas that only ever pass on a retry all become visible, which is
the other half of keeping a suite honest.

## The dispatch — rule `remote-validation`

A run is carried out by a dispatched agent, _src/dispatcher/rules/remoteValidation.ts_, a
`DISPATCH_PIPELINE` entry and a `STAGES` module like any other rule
([05](05-dispatcher.md#the-rule-book)). An inline `raw.push` of a `dispatch_*` action would bypass
both the headroom cut and the Up next queue.

**Why an agent at all**, when nothing here asks a model to judge anything: the run needs a checkout at
the environment's **current commit** with the suite's dependencies installed, which is worktree work;
it takes minutes, which a pulse must not block on; and only a dispatched task gives the run a lease, a
reaper, a transcript and a kill. What the agent does is invoke the declared command and say where the
report landed. **It states no outcome** — → [The report tool](#the-report-tool).

- A **code** agent — a run runs things — in a **read-only checkout**
  ([09](09-execution.md#the-read-only-checkout)) leased under `validate-remote/issue/<n>/<runId>`,
  origin `issue:<n>:validate-remote:<runId>`. The name is a lease key and no ref is minted.
- **Pinned to the deployed commit, never to a branch.** The specs that describe the deployed build are
  the ones in it, and a branch tip describes a product nobody is running.
- **Position: immediately below `validate-check`, above `validation-failed`.** `validate-check` is
  deliberately last of every rule that produces work, because validation's standing promise is that it
  blocks nothing, and this has exactly that standing-obligation character — so it belongs in that
  region rather than above the work the fleet is actually doing. Below `validate-check` rather than
  above it because a handed-over check is one an operator explicitly assigned to the fleet and is the
  older obligation. Above `validation-failed` because this rule **produces that rule's input**: the
  other way round reads as backwards and delays every diagnosis by a pulse.
  Not beside `local-validation`, which ranks second for a reason that does not hold here: that is a
  person at a screen with an environment burning on their own machine, and this is a press somebody
  walks away from.
- **No cooldown budget and no escalation.** A run row is one press rather than a standing signal: it
  is re-proposed each pulse until it dispatches, the operator calls it off, or the pin goes bad. One
  agent per run is the store's `WHERE status = 'pending'` on the dispatched flip, which is what makes
  it true across a restart.
- **Nothing is dispatched for a sheet nobody pressed.** The rule reads run rows, never sheets.
- **It carries an `enabled` predicate** on a `RuleConditions` flag — true only where some environment
  declares a `validate` block — beside `review` and `sequencer`. A rule with no run rows to read
  would already produce nothing, so this buys one thing and it is worth having: the rule book draws
  it as **inert** on a deployment that has not turned the feature on, rather than as a rule that
  looks live and never fires. An operator reading the book to find out why nothing happened is
  entitled to the difference.

**A new `issue:<n>:…` origin is classified in `src/issueOrigins.ts`**, and `validate-remote:` joins
`EVIDENCE_SUFFIX_PREFIXES` beside `validate:`, `validate-failure:` and `validate-local:`. A run is
evidence about delivered work, not work. Left out it reads as `unrecognised`: it stops expanding under
a goal's priority flag ([05](05-dispatcher.md#marking-a-goal-a-priority)) and its spend files under
"other" rather than the phase it belongs to ([18](18-observability.md)). Neither is red.

`POST /api/issues/:number/remote-validation/:environment/cancel` settles an open run `abandoned`. It
is required rather than a convenience, `validate-locally/cancel`'s reason: an operator who kills the
agent from its drawer otherwise leaves a `dispatched` run nobody will ever report against, and the
sheet's press stays absent for good.

### The lens boundary

`src/environments/` is a lens and nothing under `src/dispatcher/` may import it, asserted structurally
([05](05-dispatcher.md)). _src/remoteValidation/_ sits on the same side of that line as far as the
dispatcher is concerned: **the rule reads the run rows out of the store and imports nothing from
either directory.** Everything the agent must know reaches it as a rendered string on the prompt, the
arrangement [29](29-post-deploy-watch.md#who-writes-it-and-when) already makes for the watch's notes.

### The report tool

`remote_validation_report`, _src/mcp/tools/remoteValidationReport.ts_, named in `MCP_TOOL_NAMES` and
built in `buildTools`, classified `point-of-use` and named **only in the `remote-validation` prompt's
own tool section** ([11](11-mcp-tools.md#where-a-tool-is-named-to-the-agent)). An addendum entry would
advertise it to every planner and part agent in the fleet.

**It has no field an agent could state an outcome in.** It takes where the report landed, where the
artefacts were published, and nothing else:

| Field        | What                                                                          |
| ------------ | ----------------------------------------------------------------------------- |
| `reportPath` | Path to the runner's machine-readable report, inside the run's own directory. |
| `artefacts`  | The URL the publish command printed, if it ran.                               |
| `handback`   | A reason, **instead of** a report: the run could not be carried out at all.   |

The harness parses that file and folds every row's outcome out of it. That is what keeps
[the runner contract](#the-report-is-the-only-source-of-row-outcomes) true rather than aspirational: a
tool with a `result` field is a tool through which a model's opinion becomes a reading, and the model
in this loop has every reason to believe the goal works and no way to have watched a spec run.

A `handback` writes **no readings**, leaves every row exactly as it was, and carries the agent's reason
to the operator — `validation_report`'s third answer, for its reason: an agent that could not reach
the environment has learned nothing about the goal, and with only pass and fail available its options
are a lie and silence.

**The origin fence is the narrow kind.** `remoteValidationOriginParts` parses `:validate-remote:`
alone, so which run a report concerns is settled **before** the report rather than by it, and every
other caller — the agent that just built the thing most of all — is refused **by name**. The
`validation-failed` agent this run may go on to produce is refused structurally, by the parse, exactly
as it is refused `validation_report`.

`state_declare` is the second tool and is **built** — `src/mcp/tools/stateDeclare.ts`, in
`MCP_TOOL_NAMES` and `buildTools`, classified `point-of-use`. Its fence is the **wide** kind,
`validation_amend`'s: a query is a note about how a goal gets checked, and the agent best placed to
notice one is wrong is whoever is looking at the code — so the whole-issue agent, a part agent and the
assessor all qualify, the origin comes off the credential, and the planner is refused by name and
pointed at the document block. Where no environment declares a `validate.state.run`, it refuses **by
name** and says which configuration is missing, rather than storing a query nothing can ever run.

**Neither name is ever deleted once shipped.** A withdrawn tool name goes in `RETIRED_TOOL_NAMES`
(`src/mcp/names.ts`) and answers with a refusal pointing at what replaced it, because a name that is
simply gone comes back as an unknown method — a broken channel rather than an out-of-date prompt,
appearing in no reading at all ([11](11-mcp-tools.md#retired-tools)).

**The desktop channel gets neither tool.** That credential is long-lived and lives in a home
directory, and its guarantee is that there is no code path from a desktop connection to a fleet tool
at all ([20](20-validation.md#the-tools)). What a desktop session already has is `validation_report`
against a claimed check, which is the right door for a person's own run.

### The prompts

A new `PromptId`, **`remote-validation`**, in the registry in `src/dispatcher/promptTemplates.ts`, with
a copy of its body under _docs/prompt-templates/remote-validation.md_.

**Everything the agent must read is appended to the rendered prompt, never interpolated**
([05](05-dispatcher.md#prompt-templates)): the environment's name and its profile alias, the declared
runner command, the selectors for the confirmed rows, the tenant, the report and artefact directories,
the deployed commit, and the rules of the run — that the report is the only thing that decides
anything, that it must not edit the suite, and that a handback is a right answer. Templates are
operator-overridable and `loadPromptTemplates` rejects only _unknown_ placeholders, so an override
that never learned a new `{token}` silently drops it, on exactly the deployments that customised most.

**A `PromptId` is never deleted** — it is marked `retired: true`. Removing one turns every deployment
that overrode it into a harness that will not boot.

Two notes are appended to prompts that already exist, both rendered strings rather than imports:

- the **test-part bar** on `issue-plan` and `issue-replan`, appended only where some environment
  declares a `validate.browser` block, so a planner on a deployment with no suite is never told to
  declare a part nobody can build. **Built**: `testPartNote` (`src/plans/planning.ts`), computed once
  in `src/system.ts`, threaded through `RuleContext` and the `RuleDispatcher` constructor, and
  concatenated onto both renderings in `src/dispatcher/rules/issuePlan.ts` — never imported into
  `src/dispatcher/` from `src/environments/`;
- the **`state_declare` instruction** on the two prompts that dispatch work — **built**, as
  `stateDeclareNote` in `src/plans/planning.ts`, computed in `src/system.ts`, threaded through
  `RuleContext` and appended to the `issue-pickup` and `plan-part` renderings, so nothing under
  `src/dispatcher/` imports `src/remoteValidation/`. `watchDeclareNote`'s
  arrangement exactly ([29](29-post-deploy-watch.md#the-working-agent-at-conclude-time)) — but
  **appended only where some environment declares a `validate.state` executor**, which is where that
  arrangement is deliberately departed from. `watch_declare`'s note is unconditional and can afford
  to be, because a watch declared on a deployment with no `observe` draws no surface and costs a line
  of prompt. This one would cost the same line on every dispatch on every deployment, to collect
  queries **nothing can ever run**, and the collecting is the harm: a goal page listing questions
  about a deployed store on a fleet that has no deployed store to ask is a surface that reads as
  broken and was never turned on. So the tool is not named to any agent there, and a caller that
  reaches for it anyway is **refused by name**, told which configuration is missing — the harness's
  habit of a legible refusal over a silent store.

## What a spec reading is worth

`resultBy` gains a fourth value, **`spec`**, beside `operator`, `agent` and `desktop`. The column
exists and only gains a value it may hold, so it needs no migration — `rowToCheck` narrows it and a
value it does not recognise reads as attributed to nobody, which is the safe direction.

The four are four different facts and the whole feature exists to stop one being assumed from evidence
that supports another:

| `resultBy` | Means                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operator` | A person carried the steps out. Draws no marker — that is what a checklist means.                                                                                                     |
| `desktop`  | The operator's own Claude ran it at their keyboard, against the real environment.                                                                                                     |
| `agent`    | The fleet ran it unattended.                                                                                                                                                          |
| `spec`     | **A reviewed spec ran against a real environment and its report said so.** Stronger than `agent` — no model read anything — and different from `operator`, because nobody watched it. |

Two rules govern what a run may write on a check row, and the second is the one a second
implementation would get wrong quietly:

- **A run writes onto the check row only where the current reading is `unrun`, or was itself a
  `spec` reading.** A reading a person, an agent or a desktop session took is theirs; overwriting it
  with a spec's is the harness deciding it knows better than the person who watched the thing happen.
  Where the check is settled by somebody else, the row still runs and the reading still lands **on the
  sheet**, and the sheet says whose reading it is not replacing.
- **A `blocked` row writes nothing at all**, `handback`'s rule: no reading was taken.

This is the one place [20](20-validation.md#states)'s "a result is declared, never derived" is worth
restating rather than assuming. A spec reading **is** declared — by a report, about a run of the
delivered goal, in a place somebody deployed. What is still refused, here as everywhere, is a result
inferred from a green build, a merged pull request or an absence of errors.

## What a finding does, and what it must never do

- **A failed `check` row reaches `validation-failed`** ([20](20-validation.md#when-a-check-fails)) by
  writing the ordinary `failed` reading on the check. Nothing new routes it, and each reading keeps
  its own attempt budget.
- **A regressed `signal` or `measure` row holds nothing** unless the environment's `watch.holds` says
  so, which is off ([29](29-post-deploy-watch.md#it-holds-nothing-unless-asked)).
- **A failed row is never recorded as a shortfall.** A shortfall clears the goal's **delivery** row,
  and the delivery is what parks the goal: writing one un-parks it, settles the close-out obligation
  and declines the validation bench row — the reading deleting the rows it was reported into, with
  delivered work handed back to the fleet.
  → [14](14-persistence.md#issue-verdicts-and-the-exclusion-matrix)
- **The sheet writes no issue verdict at all.** The four kinds are conclusion, delivery, shortfall and
  appraisal, and a reading is none of them; what a sheet moves is `validationVerdict`, through the
  check rows, which is the one answer every surface already reads
  ([20](20-validation.md#the-flag)). If a later change ever wants a verdict of its own it goes through
  `IssueVerdictStore.recordVerdict` and a declared entry in `VERDICT_EXCLUSIONS`, **never** a
  hand-rolled `DELETE`.
- **No reading is ever a `WorldEvent`.** `deliveryHold` expires a standing delivery verdict on **any**
  world event matching the goal's issue ref, so a reading written as one would un-park the goal it
  just reported on and hand delivered work back to the fleet ([03](03-world-model.md)). Sheet readings
  have their own table and their own wire list, and the cockpit merges them at the feed's door — which
  is what arrivals and watch readings already do, for this exact reason. It is also what keeps a flaky
  row from ever holding a goal: **no reading creates or clears a hold.**
- **A sheet reading is never written into `watch_readings`.** Those are a window's evidence, on the
  window's clock; a point-in-time read folded in would move a settled verdict and would look exactly
  like the watch working.

## The desk

`RemoteValidationDesk` (`src/remoteValidation/desk.ts`) is the one owner of every sheet write. Four
passes: assemble the sheets for arrivals nothing has assembled yet, run the approved deterministic
rows and the pre-flight on a freshly assembled sheet, refresh what the bench row says, and sweep runs
that have gone away.

**All four are built.** What runs is the assembly, the pre-flight over the sheet's `check` rows, the
approved `state`, `signal` and `measure` rows on a sheet it has just assembled, and — through
`RemoteRunDesk` ([The press](#the-press)) rather than the pulse — the same rows again under a
press's pin. The pre-flight runs on the **assembly** pass only and inside its cap: it is a process
spawn per sheet, and a sheet already assembled is never re-listed. The sweep's
arm has no dispatched run to find until the browser half lands an agent, which is why an operator's
own `.../cancel` is the settle path this build has. The bench line is refreshed by `ValidationReadyDesk` reading the rows out of the store,
which is why the desk's position above it is load-bearing rather than tidy.

**It returns immediately where no environment declares a `validate` block**, which is the steady
state for every deployment that has not turned this on, and it stamps nothing on the way past —
`EnvironmentDesk`'s own arrangement for its five conditional passes. Stamping an arrival it did not
assemble would burn the freshness guard that makes turning the feature on next month safe, which is
the one way an early return could be got wrong quietly.

Its position in the pulse is an **invariant, not a preference**, and it is stated here so a reordering
elsewhere is not silent:

```
graph.record(world)
  → EnvironmentDesk           …arrivals are recorded in its fifth pass
  → RemoteValidationDesk      …assembles off those arrivals
  → ValidationReadyDesk       …the validate row's detail carries this pulse's sheet
  → DeliveryCloseOutDesk      …the bench asks for one thing at a time
```

Above `EnvironmentDesk` it would read arrivals that have not been written yet and the whole feature
would be one pulse late forever, with nothing red — [29](29-post-deploy-watch.md#the-window)'s window
pass, exactly. Below `ValidationReadyDesk` the bench row would state the last pulse's sheet, and the
sentence an operator reads at the moment they decide to press would be the one before the readings
landed. `DeliveryCloseOutDesk` stays below both
([24](24-environments.md#the-bench-asks-for-one-thing-at-a-time)).

**The `validate` bench row's own line about a sheet is minimal on purpose** — _a validation sheet is
assembled for `acceptance` — 4 rows, 1 waiting on an approval_ — because an operator has to be told a
sheet exists on the pulse sheets start existing, and what the sheet says is the sheet's own surface to
say. It is folded on the **server**, off the rows the card draws, in `sheetBenchLine`
(`src/remoteValidation/sheet.ts`).

**Only an arrival the harness watched gets a sheet.** The freshness guard from the announce and watch
passes applies unchanged and for its reason: the first pulse after this ships — or after an operator
adds a `validate` block to an environment that has been probing for a month — would otherwise assemble
a sheet for **every goal that ever arrived**, spawn a state command per approved query for each of
them, and put a bench row on work that shipped in March. So a sheet is assembled only for an arrival
confirmed within two probe intervals of now — `sheetableArrivals` in `src/environments/watchWindow.ts`,
beside the `openableArrivals` whose guard it is — and **every arrival is stamped either way** —
`goal_arrivals.sheeted_at`, beside `announced_at` and `watched_at`. The stamp is what makes the next
arrival the first one sheeted rather than the whole history arriving at once, and it is spent only
where the feature is on: an arrival on a deployment where no environment declares a `validate` block
is left unstamped, because stamping it would burn the one guard that makes turning the feature on next
month safe.

**A cap per pulse — five sheets**, oldest arrival first, deferring rather than dropping, so a backlog
drains in a fixed order and nothing starves. Deliberately smaller than the watch's twenty: what this
bounds is a process spawn per approved query **plus a selector listing** per sheet, where that one
bounds a query.

The sweep's arm is the one nothing else covers: a `dispatched` run whose task is no longer active. An
agent that crashed, was killed or spent its stall park leaves a run nobody will ever report against,
and the sheet's press absent for good.

A pass that throws is recorded through `errors.record` and never fails the cycle. **No swallowed
`catch`**: every caught failure is routed through `src/errorLog.ts`, whose event is named `logged`
rather than `error`.

## Configuration

**Built.** The whole of it is one optional block on an environment, plus one top-level key.

```jsonc
{
  "environments": [
    {
      "name": "acceptance",
      "at": "./scripts/deployed-sha.sh acceptance",
      "validate": {
        "permits": ["check", "state", "signal", "measure"],

        // one of: a literal name, an operator-config reference, or a command
        "tenant": "validation-customer-1",
        // "tenantEnv": "VALIDATION_TENANT",
        // "ensureTenant": "./scripts/ensure-validation-tenant.sh",

        "reseed": "./scripts/reseed-validation-tenant.sh",
        "tenantFreshnessMs": 604800000,

        "browser": {
          "runner": "npm run e2e -- --project=validation",
          "listSelectors": "npm run e2e -- --project=validation --list",
          "profile": "acc-uk", // the suite's own name for this place
          "publishArtefacts": "./scripts/publish-report.sh",
        },

        "state": { "run": "./scripts/validation-query.sh" },
      },
    },
  ],
  "remoteValidation": { "runTimeoutMs": 1800000 },
}
```

`environments` is already `fileOnly` in `CONFIG_FIELDS`, which is right for this too: every field here
is a shell command the harness runs, which is a thing to write deliberately in a file rather than
beside twenty other rows. **No agent can write it** — nothing in `src/mcp/` touches config.

**Every command is declared in committed project config. Env vars carry parameters only.** A command
sourced from per-machine config moves the mechanism out of the half the project owns and makes what a
validation run actually executes unreviewable. The parameters are the tenant, the selectors and the
profile, and each rides in the spawn env: **never into the prompt, never into the cockpit, never into
a project layer that gets committed.**

`remoteValidation` is the one **new top-level key**, and it exists because 30 seconds — the kill every
other command in the harness gets — is the wrong number for a browser suite. It carries
`runTimeoutMs`, default 30 minutes; every other command, `state.run` included, keeps the 30-second
kill. **It is claimed by the `Features` group in `src/server/runningConfig.ts`**: an unclaimed key
validates, applies, and is drawn nowhere.

`validateEnvironments` (`src/environments/policy.ts`) grows the refusals whose absence is otherwise
silent:

- a `validate` block whose `permits` is **empty**, which reads as a configuration and permits nothing;
- `permits` naming `check` with **no `browser` block**, or naming `state` with no `state.run` — a kind
  permitted with nothing able to run it is every row of that kind `blocked`, forever;
- a `browser` with a `runner` and **no `listSelectors`**, which leaves the pre-flight unable to answer
  and every selector unverifiable until after a press has been spent;
- **more than one** of `tenant`, `tenantEnv` and `ensureTenant`, which is two answers to one question;
- a `reseed` or a `tenantFreshnessMs` with **no tenant of any shape**, which is freshness about
  nothing;
- an **empty** command anywhere in the block, which is a command that answers nothing.

## Routes

`src/server/routes/remoteValidation.ts`, a module and a `ROUTE_MODULES` entry — `app.ts` stays wiring
only ([16](16-http-api.md#shape)). **All seven are built**, in that one module: a second module for
the press would put two representations of one surface in two places. Every handler is wrapped in `checked(schemas, handler)` and handed
`{params, body, req, reply}` already parsed; **a refusal is a returned value and a 400, never a
throw**.

| Route                                                                            | Does                                                                                                                                           |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/issues/:number/remote-validation/:environment/run`                    | **built.** Press go. The only route here that runs a cycle.                                                                                    |
| `POST /api/issues/:number/remote-validation/:environment/cancel`                 | **built.** Settle an open run `abandoned`.                                                                                                     |
| `POST /api/issues/:number/remote-validation/:environment/rows/:rowId`            | **built.** `{selected}` — deselect a row, or take it back.                                                                                     |
| `POST /api/issues/:number/remote-validation/:environment/queries/:queryId`       | **built.** `{accept}`. Runs the dry run in the same call, and writes the `(digest, environment)` approval.                                     |
| `POST /api/issues/:number/remote-validation/:environment/watch-queries/:queryId` | **built.** The same consent for a **live watch check**, which is how the second key on one is written.                                         |
| `POST /api/issues/:number/remote-validation/:environment/reseed`                 | **built.** Invoke the environment's `ensureTenant` where it provisions on demand and its `reseed` where it declares one, and stamp the tenant. |
| `PUT`/`DELETE /api/issues/:number/state-queries/:queryId`                        | **built.** The operator's own writer, `watch/checks/:checkId`'s shape exactly, and `authored: 'operator'`.                                     |

**Waiving is not here.** A check the product has moved past is waived through
`POST /api/issues/:number/validation/:checkId/waive` ([20](20-validation.md#routes)), which already
requires a reason and already counts as clear at close-out. A second waive route on the sheet would be
a second representation of one operator act, and the two would disagree the first time either grew a
rule.

## Persistence

→ [14](14-persistence.md). One new module, `src/store/remoteValidation.ts`, taking a `StoreContext`
and delegated to from `src/store/store.ts` under the same method names
([14](14-persistence.md#shape)). `src/store/` stays the only directory that touches SQLite and the
writes are synchronous, which is what keeps the harness logic race-free.

| Table                    | One row per                   | Written                                                                                                                                                                                                |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `remote_sheets`          | `(goal_ref, environment)`     | **built.** `OR IGNORE` — a second arrival re-runs the sheet that exists rather than opening a second one                                                                                               |
| `remote_sheet_rows`      | `(sheet, row_id)`             | **built.** `OR REPLACE` on assembly; `selected` and `blocked_reason` updated in place                                                                                                                  |
| `remote_runs`            | one press                     | **built.** conditional insert inside the transaction, unique on `(environment, tenant)` while live, with a partial unique index behind it                                                              |
| `remote_readings`        | `(run, row_id)`               | **built.** append-only; a later run supersedes rather than deletes. `run_id` is null for a reading taken at assembly, and `started_sha` / `ended_sha` carry the commits the run that took it straddled |
| `remote_state_queries`   | `(goal_ref, query_id)`        | **built.** `OR REPLACE` on the declaration; the merge key is the slug, and `authored` says whose it is                                                                                                 |
| `remote_query_approvals` | `(query_digest, environment)` | **built.** `OR REPLACE`; the dry run's reading kept beside it                                                                                                                                          |
| `remote_tenants`         | `(environment, tenant)`       | **built.** `OR REPLACE` — when it was last provisioned and last reseeded                                                                                                                               |

`remote_runs` keeps its rows after they end, `local_validations`' rule: a run abandoned because the
environment went back past the goal's work is the case an operator actually hits, and its reason has
to be readable afterwards.

**A reading is attributed to the commits it actually ran against** — `started_sha` and `ended_sha` on
the run, both on every reading through it — **and superseded rather than deleted** when the
environment moves. A reading with no commit beside it is a reading of a product nobody can name.

### Migrations

- **Every one of the seven tables declares a `ColumnMigrations` block, empty or not.** A table being
  new **once** does not keep it exempt, which is exactly what `local_runs`' usage columns and
  `validation_checks`' band cost ([14](14-persistence.md#migrations)). All seven are declared in
  `REMOTE_VALIDATION_COLUMNS` (`src/store/remoteValidation.ts`), and the entry is what the next column
  any of them takes is added to — which is what `remote_readings`' `started_sha` and `ended_sha`
  already are: a column on a table that was new **one release ago**, additive, guarded by
  `PRAGMA table_info`, and invisible without the entry on every database from before it existed.
- **`validation_checks.area`** is a column on an **existing** table and is **built**: declared in
  `VALIDATION_COLUMNS` (`src/store/validation.ts`), with its `ALTER TABLE` guarded by `PRAGMA
table_info` like every other entry there. `CREATE TABLE IF NOT EXISTS` never alters an existing
  table, so without the entry the column would be invisible on every database from before it existed
  — every check unautomatable, every sheet all-manual, and nothing red. **How an author declares an
  area is not built**; the column is, and a null area is a check a person carries out.
  `remote_sheet_rows.matched` is the same case one table over, declared in
  `REMOTE_VALIDATION_COLUMNS` — a column on a table that was new one release ago, which is exactly
  what that entry exists for.
- **`plan_parts.coverage`** is the same case one table over, and is **built**: declared in
  `PLAN_COLUMNS` (`src/store/plans.ts`), with its `ALTER TABLE` guarded by `PRAGMA table_info` like
  every other entry there.
- **`goal_arrivals.sheeted_at`** is the same case again, and is **built**: declared in
  `ENVIRONMENT_COLUMNS` (`src/store/environments.ts`) beside `watched_at`, with its `ALTER TABLE`
  guarded by `PRAGMA table_info` like every other entry there.
- **No backfill is needed, and each for a stated reason rather than by luck.**
  `validation_checks.area` null means _no area declared_, which is true of every row written before
  the column existed and stays true; `plan_parts.coverage` the same. `goal_arrivals.sheeted_at` null
  means _not considered yet_, and an arrival considered for the first time is assembled only if its
  confirming reading is fresh — so a database full of nulls is walked once, stamped, and assembles
  nothing for work that shipped in March. That is the freshness guard doing the backfill's job, and it
  is the one place a nullable column here could have reopened
  [14](14-persistence.md#when-a-null-means-something)'s trap.
- **No `runOnce` id is edited in place.** There is no `runOnce` in the tree right now; if this change
  brings one back, changing its id later declares a **second** pass that every database which ran the
  first runs again on the next boot.

## Seams, and why the fake comes first

**Every project-supplied command in this design is a live shell command against a real environment**:
`at`, `browser.runner`, `browser.listSelectors`, `browser.publishArtefacts`, `state.run`,
`ensureTenant`, `reseed`. There must be an **injectable seam with a scripted fake before any of it
lands**, or a test run provisions a tenant, drives a browser against somebody's acceptance
environment, or queries a deployed store — and passes while doing it. That is the `FakeUpstreamIssues`
lesson exactly ([15](15-integrations.md)): the failure is not that the test breaks, it is that it
succeeds.

| Seam                                                  | Implementations                                          | Covers                                        |
| ----------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------- |
| `EnvironmentProber` (existing)                        | `CommandEnvironmentProber` · `FakeEnvironmentProber`     | `at`, for the pin                             |
| `EnvironmentObserver` (existing)                      | `CommandEnvironmentObserver` · `FakeEnvironmentObserver` | `observe`, for `signal` and `measure` rows    |
| `RemoteRunner` (`src/remoteValidation/runner.ts`)     | `CommandRemoteRunner` · `FakeRemoteRunner` — **built**   | `runner`, `listSelectors`, `publishArtefacts` |
| `StateReader` (`src/remoteValidation/stateReader.ts`) | `CommandStateReader` · `FakeStateReader` — **built**     | `state.run`                                   |
| `TenantKeeper` (`src/remoteValidation/tenants.ts`)    | `CommandTenantKeeper` · `FakeTenantKeeper` — **built**   | `ensureTenant`, `reseed`                      |

Three rules hold them honest:

- **Tests build a whole `System`** via `buildSystem(config, opts)` with the fakes injected and
  `dbPath: ':memory:'` ([19](19-development.md)). The three new seams are new `opts` keys —
  `remoteRunner`, `stateReader`, `tenants` — beside `backend`, `streamSpawner`, `sink`, `gitObserver`,
  `worktrees` and `errorMirror`. All three are built, each defaulting to its command implementation. **A test that configures a `validate` block and injects no `tenants` is the same hazard
  `stateReader`'s absence is**, and a test that configures a `validate.browser` block and injects no
  `remoteRunner` drives a browser against somebody's acceptance environment; both are in `CLAUDE.md`
  for that reason.
  **`CommandStateReader` parses through the same `src/environments/watchResult.ts` the observer uses**
  — the id echo in `lubbdubbWatchId`, the rows-never-counts refusal and `presence`'s zero-means-unknown
  are one implementation. A second parser would pass `knip` (it is used) and pass its own tests, and
  then drift about all three, silently.
- **A test that configures an environment with a `validate` block and injects none of them is the
  hazard**, and it is in `CLAUDE.md` for that reason. The default
  implementations are the command ones; what saves an ordinary test is that a config with no
  `validate` block declares no command to run, which is a property to rely on deliberately rather than
  to discover.
- **A test that dispatches the run agent must inject `worktrees`.** `config.repoRoot` defaults to
  `process.cwd()`, so without `FakeWorktreeManager` the test leases a slot in your own checkout
  ([19](19-development.md#why-a-test-must-not-dispatch-through-the-real-worktree-manager)).

**Extending a seam means adding to the interface _and_ its scripted fake in the same change.** All
provider and command I/O is behind these; the tests touch no network and spawn no process.

## The cockpit

→ [17](17-cockpit.md). One card, one line on a card that exists, and one new piece of place.

**The card** is `remoteValidation` in `GOAL_SECTIONS`, between `localValidation` and `signals` — its
own full-width card rather than a band inside the Environments card, `LocalValidationSection`'s
argument for its reason: this card carries **controls and a press**, and a control buried two levels
inside a status card is a control nobody finds. Its order in the page is the order the questions are
asked in: did we build it (Validation), does it work here (this), did it do anything over time
(Signals), where has it got to (Environments).

**The card is absent entirely where no environment declares a `validate` block**, and absent on a
goal with no sheet — not an empty card, and not a row of question marks. That is the rule the
Environments card and the Signals card are both built to, and it is what keeps a deployment that has
not turned this on from reading as a deployment where it is broken.

It draws one block per environment that has a sheet: the tenant and its age against the declared
freshness window, the deployed commit, every row with its kind, its outcome and its reason, the
artefact link on a browser row, matched-versus-executed and retries and wall-clock, the selector
mismatches the pre-flight found, and the four controls the gate is made of — approve a query on its
dry run, deselect a row, reseed, press go. A row waived through the check's own control draws its
reason and does not run. **An `unknown` from a query and a `blocked` row say why in words**, and never
in the vocabulary of a clean one.

**The Environments card's row gains one folded line** — `sheet · 4 rows · 1 blocked` — folded on the
**server** off the same rows the card above draws. A cockpit that worked it out for itself would be a
second opinion drawn beside the reading it describes, which is the disagreement the strip's fold
exists to prevent.

Three conventions this card is held to, each of which fails silently if missed:

- **A colour written as a literal in a stylesheet is a colour no theme can reach.** Every tone here is
  a `--cn-*` custom property on one of the two `:root` blocks — ideally a `color-mix` of the core —
  and registered in `web/src/cockpit/tokens.ts`. Only `test/cockpitTheme.test.ts` reads the
  stylesheets. → [17](17-cockpit.md#tokens)
- **A reference is drawn with `<Ref to={ref}/>`**, never as text, and never inside a button: the goal,
  the run's agent and any pull request the sheet names get a way there, drawn beside the control
  rather than as it. → [17](17-cockpit.md#links)
- **Which environment's sheet am I looking at is a field on `Place`** (`web/src/cockpit/place.ts`),
  never a `useState` in `useCockpit`. The cockpit's place is the query string, and state held outside
  it breaks on the back button and on reload. → [17](17-cockpit.md#the-address-bar)

**Wire types.** `RemoteSheetView`, `RemoteSheetRowView` and `RemoteReadingView` in `src/wire.ts`,
shipped on `CockpitState.remoteSheets` and re-exported by `web/src/types.ts`. A wire type either **is**
a domain type from `src/types.ts` or `extends` it — never a re-declaration and never widened — and
`src/wire.ts` stays the only server module `web/src/` may name.

**A new component is threaded through `src/system.ts`**, which is the composition root.

**What the card draws today** is the block the sheet earns and no more. Above the rows sits the
**gate**: the tenant and its age against the declared freshness window, the commit the last run
pinned, a live run or an abandoned one's reason in words, and the four controls this build has —
accept a query against this environment on the evidence of what it returned, deselect a row or take
it back, reseed the tenant, and press go. Below it, every row with its kind, its outcome and, where
nothing was learned, **why in words**. The artefact link, matched-versus-executed and the selector
mismatches land with the browser half they are about. Every tone is an existing `--cn-*` property —
the gate introduces no colour of its own, and a deselected row is dimmed rather than hidden, because
a row an operator dropped is a decision they must be able to see and take back.

`RemoteSheetView`, `RemoteSheetRowView`, `RemoteReadingView`, `RemoteRunView` and `RemoteTenantView`
are in `src/wire.ts`, shipped on `CockpitState.remoteSheets`; the card is `remoteValidation` in
`GOAL_SECTIONS` between `localValidation` and `signals`; and which environment's sheet is
`Place.sheetEnvironment` (`web/src/cockpit/place.ts`), read off the `sheet` query parameter.

**`RemoteTenantView` carries the tenant's _name_ and never a `tenantEnv`'s value.** Where the shape is
`tenantEnv` the name is the variable's own — `$VALIDATION_TENANT` — because config names the variable
and the value it holds reaches the spawn env and nowhere else. A wire type that widened to the value
would put a per-operator identifier into every snapshot, on exactly the deployments careful enough to
keep it out of config.

## Tests

At the `buildSystem` seam with the three fakes injected, plus unit tests on the pure halves. The ones
that earn their place are the silences and the asymmetries.

The test-part half is built and its tests are in `test/planTestPart.test.ts`: `coverage` parses
through **both** transports and reaches `plan_parts.coverage`; a database written before the column
gains it on boot and **no backfill runs** over it; a declared test part holds the plan's roll-up like
any other and nothing under `src/plans/` or `src/dispatcher/` reads the field to decide settlement,
asserted structurally; and the note is asserted on the **exact prompt text in both directions** —
present on `issue-plan` and `issue-replan` where one environment declares a `validate.browser` block,
absent where none does, and still present in full under an operator override that declares no tokens
at all. Each of the bar's three phrases is asserted by name, so a later reword cannot drop one
silently.

The sheet half is built and its tests are in `test/remoteValidationSheet.test.ts` and
`test/remoteValidationOff.test.ts`: an arrival assembles one sheet of the goal's checks, watches and
`state` queries; a second arrival re-runs the sheet that exists; an unapproved query is `blocked` and
says what it waits for, asserted for a `state` query **and** for a live watch check; a query approved
against one environment is still `blocked` on another; a state row on a store nothing can reach is
`blocked` while every other row on the same sheet still reports; a row of an unpermitted kind is
`blocked`; **no reading is a `WorldEvent` and nothing is written into `watch_readings`**, asserted
against the world's own list; an arrival older than two probe intervals is stamped and assembles
nothing; an arrival on an environment with no `validate` block is left **unstamped**; the cap of five
defers rather than drops, asserted on a backlog of seven; a database written before
`goal_arrivals.sheeted_at` gains it on boot and **no backfill runs** over it; the desk's position in
the pulse; that nothing under `src/dispatcher/` imports `src/remoteValidation/` or
`src/environments/`; and the **off switch in both directions on one run** — no sheet, row, reading,
stamp, bench mention, cockpit card, prompt note or spawned command with no `validate` block anywhere,
and all of it with one environment declaring `permits: ["state"]` and a `state.run` — extended, rather
than duplicated, as each half lands: the press, the cancel and the tenant control are all inert on the
deployment that configured nothing, and reachable on the same run where one environment did.

The press half is built and its tests are in `test/remoteValidationPress.test.ts` and
`test/remoteValidationTenants.test.ts`: two concurrent presses against one `(environment, tenant)`
yield **one** run and two against two tenants yield **two**, asserted on the store's own conditional
insert rather than on a caller's check; a press while a run is live is refused **409 naming the
tenant** and a press with nothing selected **400**, and the run route is the only one in the module
that runs a cycle; the pin's **three arms separately** — every landing reached opens the run, a
landing the environment no longer holds abandons with a reason, and a clone that could not say
abandons with a reason that is **not** the rollback's; an environment that has moved **forward** still
runs where a rollback abandons, **asserted as a pair**, which is the whole difference from
[32](32-local-validation.md#the-pin)'s pin; an abandoned press writes `blocked` on nothing and no
readings at all, and leaves every row exactly as it was; a run is kept after it ends and an abandoned
one's reason is readable afterwards; a later run **supersedes rather than deletes**, and every reading
carries the run's `started_sha` and `ended_sha`; a press writes **no shortfall, no issue verdict, no
`WorldEvent` and nothing into `watch_readings`**, asserted against the world's own list again, because
the press is a second writer and the assembly's assertion does not cover it; the **outcome vocabulary
itself** stays `passed | failed | blocked` however old the tenant is; the three tenant shapes resolve,
a `tenantEnv` nobody set and an `ensureTenant` nobody ran both **block naming the configuration that
would provide one** rather than inventing a name, and a `tenantEnv`'s **value reaches neither a prompt,
the cockpit, nor a committed project layer**; the reseed runs the environment's own commands and stamps
`remote_tenants`, on the fake's own record of what it was asked for and with **no process spawned**;
and waiving is **not** a route here — the retire path is
`POST /api/issues/:number/validation/:checkId/waive`, its reason is required, a waived check counts as
clear at close-out and a **deferred** one does not.

The runner seam and the pre-flight are built and their tests are in
`test/remoteValidationRunner.test.ts`: the parameters of a run reach a spawn as **environment only**
and the command is the committed one verbatim, asserted value by value; `remoteValidation.runTimeoutMs`
is the kill for a **runner** invocation while the listing and the publish keep the ordinary
30-second one, asserted as a pair, and a kill **answers nothing** rather than answering emptily; the
exit code is never read for a run; all three methods drive the fake and **no process is spawned**,
asserted on the fake's own record; the **matched** count on a row comes from the listing; a check
whose area the listing does not offer is `blocked` **before** a press with nothing written on the
check — no reading, no `WorldEvent`, nothing in `watch_readings`; a listing that could not answer
blocks the check rows and leaves the sheet's other readings standing; a check naming no area is a
person's and no command is spawned about it; the pre-flight runs on the assembly pass only and
inside the cap of five, and a throw goes through `errors.record`; `buildSystem` takes `remoteRunner`
and defaults to the command implementation, and an environment with no `validate.browser` block
declares no command for it to run; and a database written before `validation_checks.area` gains it
on boot with **no backfill** over it.

The rest, when it is built:

- a selector matching **zero** tests is `blocked`, never `passed`; and one where fewer ran than matched
  is `blocked` too, with the matched count coming from the pre-flight listing;
- a run whose environment **moved**: a failed row reads `blocked` and a passed row still reads
  `passed`, and both record the commits they straddled — **asserted in both directions**, because a
  design that treated them alike is one edit away and only one of them is honest;
- an aggregating state query is refused **at ingestion**, through the shared `aggregatingTail`;
- a `spec` reading lands on an `unrun` check and on one whose last reading was a `spec`, and **does
  not** land on one an operator, an agent or a desktop session settled — asserted in both directions;
- a `blocked` row writes nothing on the check at all;
- the run agent is refused `validation_report`, and every other agent is refused
  `remote_validation_report` **by name**;
- the report tool accepts no outcome — asserted on the advertised schema, which is derived rather than
  written ([11](11-mcp-tools.md#the-advertised-schema-is-derived-never-written));
- the rule's position in `DISPATCH_PIPELINE`, its origin's classification as **evidence** in
  `src/issueOrigins.ts`, and that nothing under `src/dispatcher/` imports _src/remoteValidation/_ or
  `src/environments/` — asserted structurally with the existing lens assertions;
- every project-supplied command reaches its **fake** and no process is spawned, asserted by a fake
  that records what it was asked for.

## What it does not see

Stated so a later change does not discover them as bugs:

- **A regression outside what was declared.** The sheet runs the areas this goal is about and the
  queries somebody wrote down. It is a complement to the project's own pipeline and alerting, not a
  replacement.
- **Whether a check has stopped applying.** Deliberately. A person waives it.
- **Attribution when two goals arrive together.** A release train carries four goals at once; each has
  its own sheet, and a red row cannot say which of the four caused it.
- **A rollback that happens between two runs.** The pin is taken at the press, not continuously.
- **Whether the specs a selector matched are any good.** They were reviewed in a pull request, which
  is the whole of the guarantee and the reason the two lifetimes are split.
- **A `state` query that is correct and asks the wrong question.** The dry run catches one that
  resolves nothing; it cannot catch one that resolves the wrong thing confidently. That is what the
  operator's approval is for, and it is a human check by design.
