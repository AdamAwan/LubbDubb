# 36 — Remote validation

> **Built.** What runs is the `validate` block on an environment and the refusals that keep it
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
> ([Migrations](#migrations)); and — as of the dispatch — **rule `remote-validation`**
> (`src/dispatcher/rules/remoteValidation.ts`) with its origin, its lease and its read-only checkout
> pinned to the deployed commit ([The dispatch](#the-dispatch--rule-remote-validation)), the
> **`remote-validation` prompt** with everything the agent must read appended to it
> ([The prompts](#the-prompts)), and the **`remote_validation_report` tool**
> (`src/mcp/tools/remoteValidationReport.ts`) with its narrow origin fence
> (`src/remoteValidation/origin.ts`) and no field an agent could state an outcome in
> ([The report tool](#the-report-tool)); and — as of the readings — **the fold of a report into row
> outcomes** (`src/remoteValidation/report.ts`, `src/remoteValidation/readings.ts`) with the exit
> code read nowhere ([The report is the only source of row outcomes](#the-report-is-the-only-source-of-row-outcomes)),
> the **environment-moved asymmetry** ([The asymmetry](#the-environment-moved-asymmetry)), the
> **`spec` reading** and the two rules governing what it may be written over
> ([What a spec reading is worth](#what-a-spec-reading-is-worth)), what a browser row **records**
> ([Artefacts](#artefacts-and-making-worth-observable)), and the **reading-shaped half of the
> cockpit** with the Environments card's folded line ([The cockpit](#the-cockpit)); and — as of the
> sweep — **the sweep's arm**, which settles a `dispatched` run whose task is no longer active and
> releases the `(environment, tenant)` lock it was holding ([The desk](#the-desk)).
>
> The **test part** landed in another goal: `plan_parts.coverage`'s
> bar on `issue-plan` and `issue-replan`, and the critical path's allow-list rule
> ([Browser coverage is a plan part](#browser-coverage-is-a-plan-part-and-it-holds-the-goal),
> [Keeping the critical path lean](#keeping-the-critical-path-lean)). Nothing in this document is
> owed: every section is an account of what runs. How an author declares a check's **area** is now
> built as well: the planner is handed the runner's own offering and picks from it, a `coverage` it
> does not offer is refused at submission, and a check inherits the area of a test part it covers
> ([How a check comes to have an area](#how-a-check-comes-to-have-an-area)). The pipeline-side guards
> on the critical path remain project conventions by design
> ([Keeping the critical path lean](#keeping-the-critical-path-lean)). The behaviour is
> [#840](https://github.com/AdamAwan/LubbDubb/issues/840) revision 9 written into the tree.

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

There are five gates, and the point of naming them together is that a later change must not add a
sixth surface that misses one:

| Gate                                    | Off means                                                                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `environments`                       | No probe, no arrival, nothing to assemble a sheet from. The whole subsystem never runs.                                                                                             |
| An environment with no `validate` block | No sheet is assembled for its arrivals, and **the arrival is left unstamped** — see [the desk](#the-desk).                                                                          |
| No `validate.state` anywhere            | `state_declare` is not named to any agent and refuses a caller by name. → [The prompts](#the-prompts)                                                                               |
| No `validate.browser` anywhere          | The test-part bar is not appended, so a planner cannot declare a part nobody can build. → [Browser coverage is a plan part](#browser-coverage-is-a-plan-part-and-it-holds-the-goal) |
| No `validate` block anywhere            | Rule `remote-validation` is drawn **inert** in the rule book rather than live-and-never-firing, on a `RuleConditions` flag. → [The dispatch](#the-dispatch--rule-remote-validation) |

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

There are **three row kinds**. A `check` row naming an **area** is the suite's — the selector a
dispatched agent runs and the harness folds a reading out of — and one naming none is a person's to
run, with its result recorded on the goal's own validation row. Where the environment does not
`permit` `check` it is blocked saying so.

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

Eight things produce `blocked`, and the number of roads into it is the point:

- the row's query is **not approved for this environment**;
- the selector **matched zero tests**, or **matched more than it ran**;
- the check's area holds the **selector delimiter**, so it could never be passed as one selector;
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

**A coverage part informs the validation planner and binds nothing.** What the part built — its area,
what that area now asserts — is handed over as input when the check set is written
([20](20-validation.md#a-permanent-test-influences-and-never-dictates)). From there the validation
planner may find the permanent test settles the question and declare nothing, declare a check whose
one step runs that area, or run it and look at more besides. What it may never be is automatic: a
coverage part that emitted a check of its own would put a row on the sheet that nobody chose.

**A declared test part holds the goal, exactly as any other part does.** No special case, no soft
hold, no "delivered except for the test". If the plan says the goal is not done until the path is
covered, then it is not done until the path is covered: a goal that ships without the coverage its own
plan called for has quietly redefined itself, and the part would never be built afterwards.

That makes the **declaration** the decision, which is where it belongs:

- **A check about how something _looks_ is not an area, and the bar says so.** A legibility check at
  a particular width, a single component's rendering, a truncation judgement: there is no journey to
  select and no area in the suite that could honestly claim it. A planner handed eight areas and told
  to pick the one that fits has an obvious wrong move — pick the nearest — and it produces a green row
  that verified something the check does not talk about, which is worse than the manual row it
  replaced. The honest answer there is no test part: the check stays a person's, or the snapshot
  suite's.
- **Most goals do not get one.** The bar is strict and it is the same bar
  [20](20-validation.md#the-bar) states one layer over: automate when the failure would be **silent
  and consequential**, which is usually a common path. A refactor whose claim is that behaviour did
  not change declares no test part; so does a copy change, a config change, and most bug fixes.
  Nothing counts test parts and nothing rewards a longer list.
- **It is decided once, at plan time**, by whoever is deciding what the goal is made of — not per
  arrival, and not by the harness at a later moment when the cost is already sunk.
- **It is visible at plan approval and an operator can strike it** ([08](08-planning.md#the-approval-gate)),
  which is what the plan sheet's proof band draws it for ([17](17-cockpit.md#the-proof-band)).
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

### How a check comes to have an area

**A `suite` step names it, and nothing else does.** A check's `area` is set by a validation planner
writing a step that runs a named area ([20](20-validation.md#the-test-plan)); it is no longer
inherited from the `coverage` of a test part the check happens to `cover`. Inheritance made a check
automatable by accident — a `covers` entry is a bibliography, and it was deciding what ran. A goal
whose coverage part built an area the validation planner then chose not to run is now an ordinary
outcome rather than an unreachable state.

Everything below still holds for the string itself: where it comes from, why it is compared exactly,
and where a mismatch is refused. The author changed; the contract did not.

`plan_parts.coverage` and `validation_checks.area` were the two ends of one string, and for a while
nothing joined them: the column was built, nothing wrote it, and **every check on every deployment
had a null area**. That is the quietest failure this document holds. `areasOf` drops a check with no
area, so `runnableSelectors` answers empty, `remoteRunBriefs` reports `confirmed: 0`, the rule
dispatches nothing and a press finds no browser half at all — on a deployment that configured
`permits: ["check"]` and a full `validate.browser` block and got manual rows with no indication why.
It reads as a misconfiguration and is not one.

The join is three things, and the first two are what make the third trustworthy.

**The planner is handed the runner's own offering and picks from it.** The two ends have to agree on
what the string is, and the pre-flight compares it **exactly** — so a planner told to name the area
"in words rather than as a file path" writes _amend the checkout area to accept the new confirmation
step_ and the runner offers `Checkout Tests`, which can never match. Prose and exact matching cannot
both be right, and reconciling them fuzzily at the pre-flight would be the harness guessing which area
a planner meant, which is what this design refuses everywhere else. So `testPartNote`
(`src/plans/planning.ts`) is given what each browser environment's runner last said it offers and
names it: `coverage` is a **pick from a list**, copied exactly. Where nothing has been listed the note
asks for the prose form and **nothing is withheld** — a deployment whose runner has never answered
still plans.

**A `coverage` the suite does not offer is refused where it is authored.** `validatePlanDocument`
(`src/plans/planDocument.ts`) takes the offered set and refuses a part naming anything else, naming
what is offered instead. Discovered at the pre-flight it is a `blocked` row a press too late — after
an operator has consented to the spend; refused at submission it is the same verdict taken while the
planner is still there to fix it. It has to be a real validation rather than a described convention,
because `PlanDocumentSchema` is zod and zod strips unknown keys. It **fails open on an empty
offering**: no listing yet, a runner that could not answer, no browser block at all are one arm, and
a hold on an offering nobody has is a fleet that cannot submit a plan with nothing red.

**A check inherits the area of a test part it covers.** `covers` already names part slugs; a covered
part's `coverage` is the check's `area`, computed in `checkAmendment` (`src/validation/checkDocument.ts`)
and recomputed on every ingest and every amendment, and again from SQL at boot for every check that
already exists (`joinCheckAreas`, `src/store/store.ts`) — which is what a deployment already
holding a hundred checks needs, since without it every one of them waits on a replan that is never
coming. That pass is a **repair rather than a migration**: an area is never authored on a check, so
recomputing one can only agree with what the ingest wrote or supply what a database from before the
join never had, and it needs no `runOnce` id. A check that would inherit two areas is left null there,
not given the first — going forward that shape is refused where it is authored, and at boot there is
no author to refuse to — so a part that stops being a test part, or whose
coverage changes, takes the check's area with it rather than leaving a selector the runner no longer
offers. **An area is never authored on a check.** Adding an `area` field to `validation_amend` would
have been smaller and is worse in a specific way: it moves area authoring outside the plan, which is
exactly where this design put the hold that makes coverage deliberate and reviewable.

#### The cached offering is a convenience and the pre-flight is the authority

A planner picks from a listing taken on one commit; the run happens against another. So the cache
never decides anything at a press: `RemoteValidationDesk.refreshSelectorOfferings` asks each browser
environment's runner what it offers on its own clock — every 30 minutes, paced to the suite's rate of
change rather than the pulse's, because the planner needs the offering **before** anything has
arrived and the pre-flight's own listing only runs when something does — and the pre-flight asks the
deployed runner again at assembly. Its answer is what a row blocks on. A stale cache costs a refusal
at submission that the pre-flight would have made anyway; the reverse — trusting the cache at the
press — would be the harness reporting on a listing nobody took.

The offering lives in `remote_selector_offerings`, replaced whole per environment, and **only an
answered listing is written**: a listing that could not say leaves the last one standing with its own
`listed_at` saying how old it is. Emptying it instead would tell a planner this deployment has no
areas at all, and — through the refusal above — refuse every `coverage` anybody names. The desk writes
it on **its own clock**, not the store's, because the refresh throttle reads `listed_at` back against
the clock it was written from and two clocks make an interval that never elapses or always does.

#### A check is verified against one area, and a covered area needs no check

Two shapes are ordinary rather than exceptional, and the join answers each.

**A check may cover several parts.** Where more than one of them declares an area, the check is
**refused where it is authored** — `twoAreaRefusal`, on the same pass as the coverage refusal and
again at `validation_amend`. A check is matched against one selector at the pre-flight and its report
is read under one, so a check spanning two areas would report a pass for coverage nothing exercised.
Taking the first area silently is precisely the failure this subsystem exists to prevent, and the
author splits the check or drops a `covers` entry.

**A part may cover an area no check names.** That is simply not on the sheet, and nothing is wrong
with it: the sheet is the goal's checks, a test part is held by the plan like any other part, and a
covered area with no check is a spec that runs in the pipeline rather than a row somebody presses.

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

What a goal declared is drawn on the plan sheet as well, read-only, beside the watch it sits next to
in the document ([17](17-cockpit.md#the-state-digest)) — and counted on the sheet's proof band
([17](17-cockpit.md#the-proof-band)), which is where a plan's four kinds of proof are read together.

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

**Assembly waits for the check set.** The set is authored after the assessor writes `delivered`
([20](20-validation.md#when-the-check-set-is-written)), and a deployment quick enough to arrive first
would assemble a sheet carrying only the watch-derived rows — a bench that offers nothing to run,
reads as a misconfiguration, and is not one. It is this document's own null-`area` failure in a new
place, and it takes the same remedy: an explicit gate rather than a race that has not been lost yet.

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

  **The listing is read from the operator's own checkout, and that skew is accepted.** The run itself
  happens in a checkout pinned to the deployed commit; `listSelectors` runs with `cwd` at `repoRoot`,
  which is whatever branch the harness's own checkout is on. Usually they are the same commit. Where
  they differ — an operator sitting on a branch that reorganised the suite — `matched` comes from one
  commit and `executed` from another, and the row fails toward `blocked` with a reason naming the
  wrong cause. Pinning the pre-flight too means a checkout per sheet assembly, which is a great deal
  of machinery for a rare skew whose failure is safe; it is declined deliberately rather than
  overlooked, and this paragraph is the account of it.

  **The listing may be prefixed, and it may not be guessed at.** A suite's own config prints ahead of
  its report — a dotenv banner is the ordinary case — so `parseSelectorListing` _seeks_ the JSON array
  in the output rather than requiring it at byte 0, and seeks it at each `[` rather than at the first
  brace, because a banner holds a brace of its own. What it will not do is read prose as areas: a
  line-form listing holding a line that is not a name — a brace, a `//`, or more than 120 characters —
  is **refused**, `offers: null`, exactly as a kill is. A banner read as one name per line offers
  areas no check can match, and every row then blocks naming a renamed area against a runner that
  offered precisely the right ones — this arm's own stated danger one step out, since a garbage
  listing read as an answer has the same shape as an empty one.

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
**400** if nothing is selected; take the pin; open the run row `pending`; broadcast; **run a cycle**.

What a press runs itself is the sheet's confirmed **deterministic** rows — the approved `state`,
`signal` and `measure` ones — synchronously, through the **same** `RemoteValidationDesk.readRow` the
assembly used. A second reader would be free to disagree with the assembly about what a row of that
kind is. They stay the press's own rather than the agent's for their own reason and not for want of
one: they are read-only, consented and cheap, where the agent exists for the browser half — minutes,
a worktree and an install.

**The run it opens is the one the rule dispatches for.** Where a confirmed `check` row names an area
and the environment declares a `runner`, the press leaves the row `pending` and the cycle it runs is
what puts the agent on it. Where none does — no browser block, no area, every `check` row blocked —
there is nothing for an agent to carry out, so the press settles the run `ended` on the spot, which is
exactly the behaviour the deterministic half had before the agent existed. The two arms read one
predicate, `runnableSelectors`, for the reason
[the dispatch](#the-dispatch--rule-remote-validation) states.

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
`(environment, tenant) WHERE status IN ('pending', 'dispatched')` behind it — both live statuses,
[for their reason](#a-runs-status-vocabulary) — never a check the caller is trusted to make first.

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
- **A selector never holds the delimiter its own list is joined on.** `LUBBDUBB_SELECTORS` is
  comma-joined, so an area holding one is silently split by the project into two selectors that do not
  exist. A planner picking from the runner's own offering can only reproduce a comma the runner itself
  named, but the guard stays: a `coverage` authored before anything was listed is free text, and
  `Reports, exports` is an ordinary thing to type. A check whose
  area holds a comma is `blocked` at assembly, naming the delimiter, by `selectorFault` in
  `src/remoteValidation/runner.ts` — where the joining lives — read from `sheetRows`, which is the
  one cause of `blocked` a press could never overcome that the sheet can see without asking anybody
  anything. Refusing where the area is read is the cheap fix; encoding the list as JSON in the
  variable is the other one, and it changes the contract for every project already reading it.
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

**Built**, in `src/remoteValidation/report.ts` — the parse and the fold, pure — and
`src/remoteValidation/readings.ts` — `RemoteReadingDesk`, which reads the file, folds a row at a time
and writes what it says.

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
  auth-setup project looks like, and only the report distinguishes it. Which means it is only
  distinguishable if the report **holds those tests**: a runner mapping its own output one-to-one
  commonly omits the tests it never ran rather than reporting them skipped, and a report that omits
  them says, to the fold, that the area holds no test at all — which is what a renamed area says. So
  the contract asks for them explicitly, below, and where they are missing the zero-match arm names a
  failure under another selector rather than a renamed area, because that is the only evidence of a
  dependency the harness has. The harness cannot know a suite's dependency graph and does not try to.
- **a retried pass is a pass**, and the row records that it was retried. Retry policy belongs to the
  project's runner config, not to the harness. Repeated retries on one area are a signal about the
  spec, surfaced through [what a row records](#artefacts-and-making-worth-observable) rather than
  treated as a failure.

**The shape of the report is the harness's, and the project's own reporter emits it** —
`validate.state.run`'s arrangement one subsystem over, and for the governing principle's reason. It
is a JSON list of the tests that ran, or an object carrying one under `tests`; each entry names its
`selector` — the area, compared against `validation_checks.area` and nothing else — and its `status`,
and may carry `retries`, `durationMs` and a `note`.

**Every requested selector appears in it, including the ones nothing ran under.** A selector whose
tests never ran because a dependency failed must appear as a `skipped` row whose `note` names the
dependency. That note is the only place the difference between a failed auth setup and a deleted spec
is written down, and a project that does the obvious thing — map the runner's own report one-to-one,
dropping the projects it never reached — gets the right outcome with the wrong reason, which is the
half an operator acts on. It is in the run's briefing for that reason.

**Rows, never counts**, the state contract's own
refusal: a report that declares totals defeats matched-versus-executed, which is the guard, because
the declared count is the thing being checked. A status word the parse does not recognise folds to
`skipped` rather than to `passed` — an unread word must never be the one that colours a row green.
The shape is appended to the run's prompt in `briefing`, so the agent knows which file to point at.

**The order the arms are tried in is load-bearing**, and it is `foldRowOutcome`'s own doc comment:
a report nobody could read blocks every row through it; a selector the report names **no test**
under is `blocked`; a test that genuinely **failed** is a failure whatever else the row did — a
narrowed run is not a reason to withhold a red the deployed product actually earned; and only then
the narrowing case, `blocked` and never `failed`. A row whose `matched` is zero or absent is
`blocked` too, because a row whose selector matched nothing is never a pass.

**A row that learned nothing writes a `blocked` _reading_, not a `blockedReason` on the sheet row.**
The two are different facts and folding them would cost the sheet its next press: a row's own
`blockedReason` is a cause a press cannot overcome — an unpermitted kind, an unapproved query, a
selector the pre-flight could not find — where a run's `blocked` is a reading, of this run, at this
moment, which the next press is entitled to take again. Both draw the same word and say why in the
same words; only one of them keeps the row out of the next invocation.

### The environment-moved asymmetry

**Built**, as `RemoteReadingDesk`'s own arm. The deployed sha is read from `at` at the start of the
run — that reading is already on the row as `started_sha`, taken with the pin — and again at the end,
when the report is folded. If it changed:

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

Both commands are killed at `remoteValidation.tenantTimeoutMs`, default **one hour**, and not at the
30 seconds every other command in the harness gets — see [Configuration](#configuration). A
provisioning or reseeding job runs for tens of minutes, so the ordinary kill ends it every time, and
the workaround it invites is worse than the bug: launching the real work detached and returning
immediately stamps the tenant as reseeded when the rebuild _started_, which makes the age drawn at
the gate a lie in exactly the window the freshness reading exists for.

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

## The one-off script

**Not built.** A `check` row runs a **reviewed spec** in the project's own browser suite, selected by
area. That is the right instrument for a journey the product will keep having, and the wrong one for
the thing most goals actually need checking: data arranged into one particular situation, a column
option selected in one particular table, a state that exists to demonstrate this change and will never
be interesting again. A suite cannot hold every scenario and should not try — a suite that does stops
being a description of the product.

So there is a second kind of browser work, and the distinction is the one this document already
draws between a spec and a query:

|              | **Suite spec**                               | **One-off script**                       |
| ------------ | -------------------------------------------- | ---------------------------------------- |
| Lifetime     | Permanent, versioned, amended by later goals | The goal's, plus a grace period          |
| Reviewed     | Yes, as ordinary repository code             | No                                       |
| Ever in a PR | Always                                       | **Never**                                |
| Selected by  | `area`, against the runner's offering        | Written for this check, run as it stands |
| Written by   | A part agent, as a `coverage` plan part      | The validation planner                   |

A one-off script is the browser-shaped member of the **query** column
([Two lifetimes](#two-lifetimes)), and it inherits that column's answers: it is not repository
code, it is not reviewed by a pull request's reviewer, and it does not outlive the question it was
written to answer.

**It acts, where a query only reads, and that is the one genuinely new capability.** Arranging data
into a particular situation means writing to the environment. So a one-off script runs **inside the
run's tenant**, under exactly the machinery the suite run already uses — `ensureTenant`, `reseed`, the
lock, the reap window ([Tenants](#tenants)) — and an environment with no tenant is an environment
where a script that writes is a `blocked` row, not a script that runs somewhere it should not.

**Its green is worth less than a suite spec's green, and the sheet must say so.** Nothing reviewed it.
A reading it produces is attributed `script`, never `spec`, and the two are never folded — an operator
counting green rows is otherwise told a throwaway and a reviewed spec are the same evidence. The
script's source is drawn on the row beside its reading: it is small and goal-scoped, which is exactly
what a suite spec is not, so it is the rare case where reading the test is cheaper than trusting it.

**It may assert, and go green on its own.** The alternative — capture only, every script coming back
for a person to judge — buys nothing here: the deployment pipeline's own critical-path suite is what
guards against regression, and a check's job is to answer whether _this goal_ works. A script that can
only gather evidence puts a person back in the loop on every goal, which is the thing this design set
out to remove.

**It is deleted with the goal, after a grace period**, and the deletion is declared rather than
incidental. A one-off that survives its goal is an unreviewed test that no one maintains and no one
can attribute, failing mysteriously against a product that moved on — a second suite grown by
accident. The window is `remoteValidation.scriptGraceMs`, defaulting to 30 days past goal close, and
the sweep names what it removed.

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

**Built.** `executed`, `retries`, `duration_ms` and `artefacts` are columns on `remote_readings`,
written by the fold and drawn on the sheet card. **`matched` is not among them**, and that is the
sharp edge of this half: it lives on `remote_sheet_rows`, written by the pre-flight's own listing.
Both numbers are in one object by the time the fold runs and the wrong one is a character away — and
taking it off the report is exactly the shape that makes a selector matching **zero** read as a
clean pass.

### Handing a screen back to look at

**Not built.** A `screenshot` step ([20](20-validation.md#the-test-plan)) captures the screen and
attaches it to the row. It asserts nothing, and that is its whole point: the checks a browser cannot
honestly judge — whether a column reads legibly at that width, whether a truncation is acceptable,
whether a number is believable beside the source it came from — are judgements, and a suite that
claims them produces a green row that verified something else.

What it removes is not the person; it is the **journey**. Today a visual check makes an operator log
in, arrange the data, navigate to the screen and only then use the one faculty a machine does not
have. The capture moves everything before the looking onto the fleet.

So the row does not go green on its own, and it does not sit `unrun` either. It reaches a state that
says **captured, waiting to be looked at**, carrying the image — and it becomes `passed` or `failed`
only when a person records a reading, which is
[a result is declared, never derived](20-validation.md#states) applied exactly as written. A capture
that coloured its own row would be the failure this design refuses everywhere else, arrived at by the
one route that looks helpful.

**A capture is not an artefact URL, and the difference is retention.** The publish command's report
is the run's, swept on the runner's own schedule; a screenshot a person still has to look at outlives
the run that took it and is held with the goal's validation directory
([12](12-artifacts-and-files.md)). A capture that expired before anybody opened it would leave a row
asking for a judgement about an image that is gone.

## The dispatch — rule `remote-validation`

**Built.** A run is carried out by a dispatched agent, `src/dispatcher/rules/remoteValidation.ts`, a
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
  agent per run is the store's `WHERE status = 'pending'` on the dispatched flip
  ([the vocabulary](#a-runs-status-vocabulary)), which is what makes it true across a restart. The
  flip is `Store.claimRemoteRun`, applied by the action executor beside `markLocalValidationDispatched`
  and nowhere else — a conditional `UPDATE` inside the transaction, never a check the rule is trusted
  to make first.
- **Nothing is dispatched for a sheet nobody pressed.** The rule reads run rows, never sheets — and
  nothing is dispatched for a run with no confirmed `check` row naming an area, which is a run the
  press already finished. `runnableSelectors` (`src/remoteValidation/briefing.ts`) is the one place
  that rule is written, read by the press and by the brief: a second copy would either strand a run
  waiting for an agent nothing will dispatch, or settle one with the agent's half still owed.
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
is required rather than a convenience, `validate-locally/cancel`'s reason: it is how a run is called
off **before** its agent has gone anywhere — a `pending` one the operator no longer wants, or a
`dispatched` one whose agent is still working. The desk's sweep is the other half and covers only the
case the operator cannot: an agent that has already gone ([The sweep](#the-sweep)).

### The lens boundary

`src/environments/` is a lens and nothing under `src/dispatcher/` may import it, asserted structurally
([05](05-dispatcher.md)). `src/remoteValidation/` sits on the same side of that line as far as the
dispatcher is concerned: **the rule reads the run rows out of the store and imports nothing from
either directory.** Everything the agent must know reaches it as a rendered string on the prompt, the
arrangement [29](29-post-deploy-watch.md#who-writes-it-and-when) already makes for the watch's notes.

**Built**, as `RemoteRunBrief`: one per live run, carrying the origin, the lease key, the deployed
commit, how many rows are confirmed and the whole appended briefing as a string. `remoteRunBriefs`
(`src/remoteValidation/briefing.ts`) folds them, `src/system.ts` threads the folding through the
harness, and they arrive on `DispatchContext.remoteRuns` — `testPartNote`'s arrangement exactly. What
the rule sees is a run row and a string.

### A run's status vocabulary

`RemoteRunStatus` is **`pending | dispatched | ended | abandoned`**, and it is a column value, so it
needs no migration — `toRemoteRun` narrows it and folds anything it does not recognise to
`abandoned`, which is the safe direction: a run this build cannot name is a run nothing will ever
report against.

| Status       | Means                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `pending`    | The press opened it and no agent has claimed it. **Live.**                                          |
| `dispatched` | The conditional flip claimed it for exactly one task. **Live.**                                     |
| `ended`      | Settled with a report recorded against it.                                                          |
| `abandoned`  | Settled with none, and never will be: the pin refused it, an operator called it off, or a handback. |

The pair is what the design needs and one status could not carry. `pending` is a run the rule may
claim and `dispatched` is one it may not, which is the whole of one-agent-per-run across a restart —
and **both are live**, so the `(environment, tenant)` lock holds over both: the partial unique index
is `WHERE status IN ('pending', 'dispatched')`, and a second press against one tenant while an agent
is out is the 409 it always was. Every reader was moved with the vocabulary, and each was a way for
the change to go quiet: `liveRemoteRun` and `endRemoteRun`'s guard read the pair rather than one name,
the index was **dropped by name and re-declared** — `CREATE UNIQUE INDEX IF NOT EXISTS` never
re-predicates an index that already exists, so a database from before this would have kept enforcing
the old `WHERE status = 'running'` and let two runs open — and the cockpit's gate draws a `pending`
run as waiting for an agent rather than as no run at all.

### The report tool

**Built.** `remote_validation_report`, `src/mcp/tools/remoteValidationReport.ts`, named in
`MCP_TOOL_NAMES` and built in `buildTools`, classified `point-of-use` and named **only in the
`remote-validation` prompt's own tool section**
([11](11-mcp-tools.md#where-a-tool-is-named-to-the-agent)). An addendum entry would advertise it to
every planner and part agent in the fleet.

**It has no field an agent could state an outcome in.** It takes where the report landed, where the
artefacts were published, and nothing else:

| Field        | What                                                                          |
| ------------ | ----------------------------------------------------------------------------- |
| `reportPath` | Path to the runner's machine-readable report, inside the run's own directory. |
| `artefacts`  | The URL the publish command printed, if it ran.                               |
| `handback`   | A reason, **instead of** a report: the run could not be carried out at all.   |

The call **records where the report and the artefacts landed on the run row, folds the report into a
reading per confirmed row, and settles the run** — `remote_runs.report_path` and
`remote_runs.artefacts`, with the status going to `ended`. The fold is not in the tool module: it
needs the environment's config and its `at` command, which a tool module has no business holding, so
it reaches the handler as `deps.remoteReadings` — `RemoteReadingDesk`, injected from `src/system.ts`
exactly as `deps.state` and `deps.localValidations` are. **The tool stays an origin fence and a parse
call**, which is what keeps it a place a model's opinion cannot get into.

That split is what keeps [the runner contract](#the-report-is-the-only-source-of-row-outcomes) true
rather than aspirational: a tool with a `result` field is a tool through which a model's opinion
becomes a reading, and the model in this loop has every reason to believe the goal works and no way to
have watched a spec run. The three fields are asserted on the **derived** `inputSchema` rather than on
the handler ([11](11-mcp-tools.md#the-advertised-schema-is-derived-never-written)), because what an
agent can say is what it was advertised, and an extra key is rejected rather than ignored.

A `handback` writes **no readings**, leaves every row exactly as it was, and carries the agent's reason
to the operator — `validation_report`'s third answer, for its reason: an agent that could not reach
the environment has learned nothing about the goal, and with only pass and fail available its options
are a lie and silence.

**The origin fence is the narrow kind.** `remoteValidationOriginParts`
(`src/remoteValidation/origin.ts`) parses `:validate-remote:` alone, so which run a report concerns is
settled **before** the report rather than by it, and every other caller — the agent that just built
the thing most of all — is refused **by name**. The `validation-failed` agent this run may go on to
produce is refused structurally, by the parse, exactly as it is refused `validation_report`.

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

**Built.** A new `PromptId`, **`remote-validation`**, in the registry in
`src/dispatcher/promptTemplates.ts`, with a copy of its body under
[`docs/prompt-templates/remote-validation.md`](../prompt-templates/remote-validation.md).

**Everything the agent must read is appended to the rendered prompt, never interpolated**
([05](05-dispatcher.md#prompt-templates)): the environment's name and its profile alias, the declared
runner command, the selectors for the confirmed rows, the tenant, the report and artefact directories,
the deployed commit, and the rules of the run — that the report is the only thing that decides
anything, that it must not edit the suite, and that a handback is a right answer. Templates are
operator-overridable and `loadPromptTemplates` rejects only _unknown_ placeholders, so an override
that never learned a new `{token}` silently drops it, on exactly the deployments that customised most.
The appending is `briefing` in `src/remoteValidation/briefing.ts`, computed with the brief and never
imported into `src/dispatcher/`. A `tenantEnv`'s **value** never reaches it: what the briefing carries
is `resolveTenant(...).standing.tenant`, which for that shape is the **variable's own name**.

**A `PromptId` is never deleted** — it is marked `retired: true`. Removing one turns every deployment
that overrode it into a harness that will not boot.

Two notes are appended to prompts that already exist, both rendered strings rather than imports:

- the **test-part bar** on `issue-plan` and `issue-replan`, appended only where some environment
  declares a `validate.browser` block, so a planner on a deployment with no suite is never told to
  declare a part nobody can build. **Built**: `testPartNote` (`src/plans/planning.ts`), computed once
  in `src/system.ts`, threaded through `RuleContext` and the `RuleDispatcher` constructor, and
  concatenated onto both renderings in `src/dispatcher/rules/issuePlan.ts` — never imported into
  `src/dispatcher/` from `src/environments/`. **The same string is returned by `plan_read` on the
  desktop channel**, as `testPart`, computed there from `deps.environments` and the offering cache:
  `plan_amend` accepts `coverage` because it spreads the same shape, so a discussion that was never
  handed the bar has the capability and not the invitation, and the one correction a person at their
  keyboard cannot make is the one that makes a check row runnable
  ([08](08-planning.md#discussing-a-plan));
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

**Built.** `resultBy` gains a fourth value, **`spec`**, beside `operator`, `agent` and `desktop`. The
column exists and only gains a value it may hold, so it needs no migration — `rowToCheck`
(`src/store/validation.ts`) narrows it and a value it does not recognise reads as attributed to
nobody, which is the safe direction.

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

`RemoteValidationDesk` (`src/remoteValidation/desk.ts`) is the one owner of every sheet write. Five
passes: refresh what each browser runner says it offers, assemble the sheets for arrivals nothing has
assembled yet, run the approved deterministic rows and the pre-flight on a freshly assembled sheet,
refresh what the bench row says, and sweep runs that have gone away.

**The offering refresh runs first and is about the environment rather than any goal**, which is why it
is not folded into the pre-flight: a planner needs to know which areas exist **before** there is
anything to arrive, and the pre-flight's listing only runs when something does. It is throttled to
thirty minutes per environment, so on a deployment already listing for its sheets it costs at most one
extra spawn an hour. → [The cached offering](#the-cached-offering-is-a-convenience-and-the-pre-flight-is-the-authority)

**All five are built.** What runs is the offering refresh, the assembly, the pre-flight over the sheet's `check` rows, the
approved `state`, `signal` and `measure` rows on a sheet it has just assembled, and — through
`RemoteRunDesk` ([The press](#the-press)) rather than the pulse — the same rows again under a
press's pin. The pre-flight runs on the **assembly** pass only and inside its cap: it is a process
spawn per sheet, and a sheet already assembled is never re-listed. The bench line is refreshed by
`ValidationReadyDesk` reading the rows out of the store, which is why the desk's position above it is
load-bearing rather than tidy. An operator's own `.../cancel` remains a settle path beside the sweep —
it is how a run is called off before its agent has gone anywhere — and it stopped being the _only_
one when the sweep landed.

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

### The sweep

The fourth pass is the one nothing else covers: a `dispatched` run whose task is no longer active. An
agent that crashed, was killed or spent its stall park leaves a run nobody will ever report against,
the `(environment, tenant)` lock held over it and the sheet's press absent for good — with nothing
red. It is settled `abandoned`, with a reason an operator can read afterwards, which is what
`remote_runs` keeps its rows for ([Persistence](#persistence)). It is
[32](32-local-validation.md#the-desk)'s second arm one subsystem over, and it asks the same predicate:
`isActiveTask` over the task row the flip named, so a turn boundary or a park is not a gone agent
([10](10-agent-runtimes.md), [13](13-jobs-and-tickets.md)).

It runs **below** the three passes above and **inside the same early return**, so a deployment where
no environment declares a `validate` block sweeps nothing and — the point of putting it inside rather
than before — stamps nothing either. The arrival-choosing pass returns where it
throws, which would otherwise take the sweep with it, so the two are separate `try`s: a pass that
throws goes through `errors.record` and never fails the cycle or the pass beside it.

**Three things it must not do, each quiet if got wrong:**

- **`pending` is never swept.** A `pending` run has no task: it is one the rule has not claimed yet,
  re-proposed each pulse until it dispatches, the operator calls it off, or the pin goes bad
  ([The dispatch](#the-dispatch--rule-remote-validation)). Sweeping wider than `dispatched` costs a
  real reading.
- **A run it cannot say about is left standing.** A `dispatched` run naming no task — a build that
  died between the flip's two columns — or one naming a task this build cannot resolve is a run the
  sweep **cannot say** about, and `unknown` is folded into neither arm, as it is folded into neither
  anywhere else in this document ([The pin](#the-pin-asks-whether-the-work-is-still-there),
  [24](24-environments.md#the-three-verdicts)). The bias is to leave a run alone: settling one whose
  agent is still working loses the reading it was about to report **and** frees the
  `(environment, tenant)` lock underneath it, so a second press opens a run against a tenant somebody
  is already driving — a silent wrong answer rather than the visible 409 a held lock gives.
- **A settled run writes nothing about the goal.** No reading, no `spec` result on a check, no
  shortfall, no issue verdict, no `WorldEvent` and nothing in `watch_readings` — `handback`'s rule
  exactly ([What a finding does](#what-a-finding-does-and-what-it-must-never-do)), because a run
  nobody reported against learned nothing. `deliveryHold` expires a standing delivery verdict on
  **any** world event matching the goal's issue ref, so a sweep written as one would un-park the goal
  it just gave up on and hand delivered work back to the fleet.

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
  "remoteValidation": { "runTimeoutMs": 1800000, "tenantTimeoutMs": 3600000 },
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
`runTimeoutMs`, default 30 minutes, the kill for a **runner** invocation; and `tenantTimeoutMs`,
default one hour, the kill for `ensureTenant` and `reseed`. Every other command, `state.run` included,
keeps the 30-second kill. The tenant commands get their own key rather than sharing the runner's
because the two are unrelated lengths — a suite's runtime against a provisioning job's — and they get
one at all because this document's own account of `ensureTenant` is "possibly very slow": provisioning
or reseeding a tenant is a job of tens of minutes, so the ordinary kill would end both commands on
**every** invocation, and the failure presents as a tenant command that will not answer. **It is claimed by the `Features` group in `src/server/runningConfig.ts`**: an unclaimed key
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

| Table                    | One row per                   | Written                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `remote_sheets`          | `(goal_ref, environment)`     | **built.** `OR IGNORE` — a second arrival re-runs the sheet that exists rather than opening a second one                                                                                                                                                                                                    |
| `remote_sheet_rows`      | `(sheet, row_id)`             | **built.** `OR REPLACE` on assembly; `selected` and `blocked_reason` updated in place                                                                                                                                                                                                                       |
| `remote_runs`            | one press                     | **built.** conditional insert inside the transaction, unique on `(environment, tenant)` while live, with a partial unique index behind it; `task_id`, `report_path` and `artefacts` written by the dispatch flip and the report                                                                             |
| `remote_readings`        | `(run, row_id)`               | **built.** append-only; a later run supersedes rather than deletes. `run_id` is null for a reading taken at assembly, `started_sha` / `ended_sha` carry the commits the run that took it straddled, and `executed`, `retries`, `duration_ms` and `artefacts` carry what the report said about a browser row |
| `remote_state_queries`   | `(goal_ref, query_id)`        | **built.** `OR REPLACE` on the declaration; the merge key is the slug, and `authored` says whose it is                                                                                                                                                                                                      |
| `remote_query_approvals` | `(query_digest, environment)` | **built.** `OR REPLACE`; the dry run's reading kept beside it                                                                                                                                                                                                                                               |
| `remote_tenants`         | `(environment, tenant)`       | **built.** `OR REPLACE` — when it was last provisioned and last reseeded                                                                                                                                                                                                                                    |

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
  `PRAGMA table_info`, and invisible without the entry on every database from before it existed. So
  are `remote_runs`' `task_id`, `report_path` and `artefacts`, and `remote_readings`' `executed`,
  `retries`, `duration_ms` and `artefacts` — the same case a third time, on a table two releases
  old now, which is exactly what a table being new **once** does not exempt it from. None of them
  needs a backfill: a null on any of the four means _this reading was not taken through a report_,
  which is true of every reading written before the fold existed and stays true. A run's **status** is not one of them:
  it is a column _value_, and the vocabulary widening needed no migration
  ([the vocabulary](#a-runs-status-vocabulary)) — what it did need was the partial unique index
  dropped by name and re-declared, because `IF NOT EXISTS` never re-predicates one that is there.
- **`validation_checks.area`** is a column on an **existing** table and is **built**: declared in
  `VALIDATION_COLUMNS` (`src/store/validation.ts`), with its `ALTER TABLE` guarded by `PRAGMA
table_info` like every other entry there. `CREATE TABLE IF NOT EXISTS` never alters an existing
  table, so without the entry the column would be invisible on every database from before it existed
  — every check unautomatable, every sheet all-manual, and nothing red. What **writes** it is the
  join from `plan_parts.coverage` ([How a check comes to have an area](#how-a-check-comes-to-have-an-area));
  a null area is a check a person carries out.
  `remote_sheet_rows.matched` is the same case one table over, declared in
  `REMOTE_VALIDATION_COLUMNS` — a column on a table that was new one release ago, which is exactly
  what that entry exists for.
- **`remote_selector_offerings`** is a **new table**, so `CREATE TABLE IF NOT EXISTS` is the whole of
  it and its `REMOTE_VALIDATION_COLUMNS` entry is empty — the entry exists because the table being new
  **once** does not keep it exempt, and the next column on it needs one. It holds no verdict and no
  reading: an empty one is a deployment whose runner has not answered yet, which fails open
  everywhere it is read.
- **`plan_parts.coverage`** is the same case one table over, and is **built**: declared in
  `PLAN_COLUMNS` (`src/store/plans.ts`), with its `ALTER TABLE` guarded by `PRAGMA table_info` like
  every other entry there.
- **`goal_arrivals.sheeted_at`** is the same case again, and is **built**: declared in
  `ENVIRONMENT_COLUMNS` (`src/store/environments.ts`) beside `watched_at`, with its `ALTER TABLE`
  guarded by `PRAGMA table_info` like every other entry there.
- **No backfill is needed, and each for a stated reason rather than by luck.**
  `validation_checks.area` null means _no area declared_, which is true of every row written before
  the column existed and stays true; `plan_parts.coverage` the same. What the area **join** does at
  boot is not a backfill and takes no `runOnce` id: it recomputes a derived column nothing else
  writes, so it is idempotent by construction and runs on every boot deliberately
  ([How a check comes to have an area](#how-a-check-comes-to-have-an-area)). `goal_arrivals.sheeted_at` null
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
  ([19](19-development.md#why-a-test-must-not-dispatch-through-the-real-worktree-manager)) — which is
  `CLAUDE.md`'s standing rule for **any** test that dispatches a code agent, and this is one.

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

**The Environments card's row gains one folded line** — `sheet · 4 rows · 1 failed · 1 blocked`,
each clause drawn only where it is non-zero — folded on the **server** off the same rows the card
above draws. A cockpit that worked it out for itself would be a second opinion drawn beside the
reading it describes, which is the disagreement the strip's fold exists to prevent. **Built**, as
`sheetFoldLine` (`src/remoteValidation/sheet.ts`) beside `sheetBenchLine`, read in
`buildEnvironmentReach` off the very `RemoteSheetView`s `buildRemoteSheets` handed the sheet card,
and shipped on `GoalEnvironmentReachView.sheet`. A row is **blocked** in the fold whichever road it
took there — a cause the sheet settled before any press, or a run that came back having learned
nothing.

Three conventions this card is held to, each of which fails silently if missed:

- **A colour written as a literal in a stylesheet is a colour no theme can reach.** Every tone here is
  a `--cn-*` custom property on one of the two `:root` blocks — ideally a `color-mix` of the core —
  and registered in `web/src/cockpit/tokens.ts`. Only `test/cockpitTheme.test.ts` reads the
  stylesheets. → [17](17-cockpit.md#tokens)
- **A reference is drawn with `<Ref to={ref}/>`**, never as text, and never inside a button. As built
  the card names no goal and no pull request of its own — it is drawn on the goal's own page — so it
  draws no `<Ref/>`; its one outward door is the **artefact URL**, which is an external link rather
  than a harness reference, drawn in a `cn-refs` group beside the row and never as a control. A
  later surface that does name a goal or a pull request draws it with `<Ref/>`.
  → [17](17-cockpit.md#links)
- **Which environment's sheet am I looking at is a field on `Place`** (`web/src/cockpit/place.ts`),
  never a `useState` in `useCockpit`. The cockpit's place is the query string, and state held outside
  it breaks on the back button and on reload. → [17](17-cockpit.md#the-address-bar)

**Wire types.** `RemoteSheetView`, `RemoteSheetRowView` and `RemoteReadingView` in `src/wire.ts`,
shipped on `CockpitState.remoteSheets` and re-exported by `web/src/types.ts`. A wire type either **is**
a domain type from `src/types.ts` or `extends` it — never a re-declaration and never widened — and
`src/wire.ts` stays the only server module `web/src/` may name.

**A new component is threaded through `src/system.ts`**, which is the composition root.

**What the card draws** is the block the sheet earns and no more. Above the rows sits the
**gate**: the tenant and its age against the declared freshness window, the commit the last run
pinned, a live run or an abandoned one's reason in words, and the four controls — accept a query
against this environment on the evidence of what it returned, deselect a row or take it back, reseed
the tenant, and press go. Below it, every row with its kind, its outcome and, where nothing was
learned, **why in words** — including whose reading a run's own did **not** replace, which is where
an operator finds out the sheet holds a finding the goal's check does not. Under each browser row
sits what the run cost and what it produced: **executed of matched**, retries where there were any,
wall-clock, and a link to the runner's own report.

**Every tone on this card is one that already exists.** `passed`, `failed`, `blocked` and unread are
the four the signals card already draws, the gate introduced no colour of its own and neither does
the reading half, and what a row nothing was learned from says is why **in words** rather than a
fifth tint. A colour written as a literal in a stylesheet is a colour no theme can reach, so a later
tint here is a `--cn-*` property on **both** `:root` blocks and an entry in
`web/src/cockpit/tokens.ts`. A deselected row is dimmed rather than hidden, because a row an operator
dropped is a decision they must be able to see and take back.

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
person's and the pre-flight spawns nothing about it; the pre-flight runs on the assembly pass only and
inside the cap of five, and a throw goes through `errors.record`; `buildSystem` takes `remoteRunner`
and defaults to the command implementation, and an environment with no `validate.browser` block
declares no command for it to run; and a database written before `validation_checks.area` gains it
on boot with **no backfill** over it.

`test/planCoverageArea.test.ts` covers the join: the note enumerates what the runner offers and asks
for prose only where nothing has been listed; an environment with no browser block offers nothing to
the planner; a `coverage` the suite does not offer is refused at submission, naming what is offered;
an empty offering fails open through both plan transports; a check inheriting two areas is refused
rather than run against the first; a check covering a test part inherits its area and one covering no
test part has none; a replan dropping the coverage takes the area with it; a database with the column
null has it supplied on the next boot; and with the area written the sheet's check row confirms, is
counted by the pre-flight and yields a selector for the run to carry — the whole of what the browser
half was missing. The offering cache is covered there too: one spawn with no goal in sight, throttled
after it, and a listing that could not say leaving the last answer standing.

The dispatch, the origin, the prompt and the report tool are built and their tests are in
`test/remoteValidationDispatch.test.ts`, with `test/remoteValidationOff.test.ts` extended a third
time: the rule's **position in `DISPATCH_PIPELINE` asserted by index** with both neighbours named,
immediately below `validate-check` and above `validation-failed`; an open run dispatching one code
agent at `issue:<n>:validate-remote:<runId>`, leased at `validate-remote/issue/<n>/<runId>`,
**read-only and pinned to the deployed sha**, with `FakeWorktreeManager` injected; a **capped** run
queued as `waiting` rather than vanishing, which is what routing through the candidate list buys; an
assembled sheet nobody pressed dispatching nothing; the rule drawn **inert** where no environment
declares a `validate` block rather than live-and-never-firing; **one agent per run across a restart**,
asserted on the store's own conditional flip over a rebuilt store on the same database, with a second
claim changing no row; no cooldown budget and no escalation, asserted over a decision history past any
attempt cap; `issueOriginRole` answering **`evidence` and not `unrecognised`** for the origin; the
origin fence refusing the whole-issue, part, `validate:`, `validate-failure:` and `validate-local:`
origins **by name** and the run's own agent refused `validation_report`; every appended token — the
runner and publish commands, the profile alias, the selectors, the tenant, the deployed commit, the
report and artefact directories and the rules of the run — asserted **under an operator override that
declares no tokens at all**; a `tenantEnv`'s value reaching neither the prompt nor the brief while its
variable's name does; the report tool's **derived `inputSchema`** carrying exactly `reportPath`,
`artefacts` and `handback` with an extra key rejected, and the name absent from
`MCP_PROTOCOL_ADDENDUM` and `DESKTOP_TOOL_NAMES`; a report recording both locations on the run row and
settling it, readably afterwards; a **handback** settling it with the agent's reason, writing no
readings and leaving every sheet row and every check exactly as it was; and a withdrawn name answered
from `RETIRED_TOOL_NAMES` rather than as an unknown method.

The reading half is built and its tests are in `test/remoteValidationReadings.test.ts` and
`test/remoteValidationCockpit.test.ts`, with `test/remoteValidationOff.test.ts` extended a fourth
time: **the exit code is never read**, asserted twice against `FakeRemoteRunner`'s own record — a
non-zero invocation over a report full of passes yields passes, and a clean one over a report full of
failures yields failures; a selector the report names **no** test under is `blocked`, never `passed`;
one where fewer ran than matched is `blocked`, with the **matched** count coming off
`remote_sheet_rows` and the executed count off the report, asserted as a pair on a report that reads
as a clean pass if the two are confused; tests skipped because a dependency failed are `blocked` and
never `failed`, with the runner's own note carried into the reason; a retried pass is a `passed` that
records its retries, its wall-clock and its artefact URL; a run whose environment **moved** —
a failed row reads `blocked` and a passed row still reads `passed`, **asserted in both directions**,
because a design that treated them alike is one edit away and only one of them is honest, and both
record the commits they straddled; a later run **supersedes rather than deletes** and every reading
carries the run's `started_sha` and `ended_sha`; a `spec` reading lands on an `unrun` check and again
on one whose last reading was a `spec`, and **does not** land on one an `operator`, an `agent` or a
`desktop` session settled — asserted in all four directions, with the sheet saying whose reading it
is not replacing and the row still running; a `blocked` row writes nothing on the check at all, and
a check naming **no area** takes no reading and settles the run anyway; a `failed` row reaches rule
`validation-failed` through the ordinary reading and nothing new routes it; a failed row is **no
shortfall, no issue verdict, no `WorldEvent` and nothing in `watch_readings`** — asserted against the
world's own list, with the goal still delivered and parked, the close-out still open and the
`validate` bench row not declined; a database carrying an **unknown `result_by`** reads as attributed
to nobody rather than throwing; settling a run **spawns no process**, asserted on the fake's own
record; and on the wire the reading's `executed`, `retries`, `durationMs` and `artefacts` reach the
sheet card while the Environments card's line is folded on the **server** off the same rows,
asserted against `sheetFoldLine` itself rather than in a component.

The query half is built and its tests are in `test/remoteValidationQueries.test.ts`, among them that
an aggregating state query is refused **at ingestion**, through the shared `aggregatingTail`
(`src/validation/watchQueryShape.ts`) the watch document's own ingestion reads — one tail matcher
rather than two, because a query that aggregates defeats every guard the contract has.

The sweep is built and its tests are in `test/remoteValidationDispatch.test.ts`, with
`test/remoteValidationOff.test.ts` extended a fifth time: a `dispatched` run whose task has ended is
settled `abandoned`, its reason readable afterwards and the `(environment, tenant)` lock released so a
second press opens a **new** run — asserted as a **pair** with a `dispatched` run whose task is still
active, which is untouched and whose lock still holds, because that pair is the only thing holding the
bias towards leaving a run alone; a `pending` run is untouched however long it has sat and is still
proposed by rule `remote-validation`; a `dispatched` run the sweep **cannot say** about — one naming no
task, and one naming a task this build cannot resolve, both written onto the columns because neither is
reachable through the store's own flip — is left standing with its lock held, asserted in that
direction; the sweep writes **no reading, no check result, no shortfall, no issue verdict, no
`WorldEvent` and nothing into `watch_readings`**, asserted against the world's own list, because the
sweep is a third writer and neither the assembly's assertion nor the press's covers it; and it is inert
on the deployment that configured nothing, stamping **no arrival** on the way past, with a planted run
left `dispatched` there and swept on the same run where one environment declares a `validate` block.

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
