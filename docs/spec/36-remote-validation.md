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
> the runner seam — the three browser commands, every one of them now invoked by the run agent in its
> pinned checkout and **none of them by the harness**, so there is no runner seam left to inject
> ([Seams](#seams-and-why-the-fake-comes-first)); and — as of the dispatch — **rule `remote-validation`**
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
> releases the `(environment, tenant)` lock it was holding ([The desk](#the-desk)); and — as of the
> named expectations — **`validation_checks.expects`**, the concrete spec names a check wrote down for
> its area, with the listing arm that blocks a row whose runner no longer offers one of them
> ([An expected spec the runner does not offer](#an-expected-spec-the-runner-does-not-offer)); and —
> as of the run's own listing — **the listing step the run agent takes**, in the read-only checkout
> pinned to the deployed commit, which is what writes `matched`
> ([The listing the run takes](#the-listing-is-taken-by-the-run-and-not-by-the-harness)), the
> **`remote_validation_listing` tool** (`src/mcp/tools/remoteValidationListing.ts`) with the report
> tool's own narrow origin fence and no field naming a selector or a count
> ([The report tool](#the-report-tool)), **`RemoteListingDesk`**
> (`src/remoteValidation/listing.ts`) as the one reader of that file and the one writer of `matched`,
> the four listing arms writing a run's **`blocked` reading** rather than the row's `blockedReason`,
> the fold's refusal to read a report over a row the listing blocked, and **`remote_runs.listing_path`**
> ([Migrations](#migrations)); and — as of the retirement — **the assembly-time pre-flight is gone**,
> with `RemoteValidationDesk.preflight` and `recordRemotePreflight` deleted, so **assembly spawns no
> browser command at all** and a selector mismatch is found one press later, by the run
> ([What runs at assembly](#when-a-sheet-is-assembled-and-what-runs-without-asking)); and — as of the
> area being read off the step — **`validation_checks.area` and `.expects` are read by nothing**: both
> are named by a `suite` step and by nothing else, every reader calls `stepArea` or `stepExpects`, and
> the two columns keep their data and have no reader and no writer left
> ([How a check comes to have an area](#how-a-check-comes-to-have-an-area),
> [Migrations](#migrations)). With that, nothing pre-resolves an area at plan time: the **offering
> cache is gone** — `remote_selector_offerings` dropped, `refreshSelectorOfferings` and the
> `RemoteRunner` seam deleted with it ([The desk](#the-desk)) — and a check written before test plans
> falls to a person **legibly**, on a sentence the sheet row carries
> ([A row no press can read](#a-row-no-press-can-read)).
>
> The **test part** landed in another goal: `plan_parts.coverage`'s
> bar on `issue-plan` and `issue-replan`, and the critical path's allow-list rule
> ([Browser coverage is a plan part](#browser-coverage-is-a-plan-part-and-it-holds-the-goal),
> [Keeping the critical path lean](#keeping-the-critical-path-lean)). Nothing in this document is
> owed: every section is an account of what runs. How an author declares a check's **area** is now
> built as well: a part's `coverage` is prose and is checked against no listing, and a check's area is
> named by a `suite` step of its test plan, picked from the runner's own offering by the validation
> planner ([How a check comes to have an area](#how-a-check-comes-to-have-an-area)). The pipeline-side guards
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

### A declined row is not on the sheet

**Built.** A check the operator declined at the accept gate ([20](20-validation.md#declining-a-single-row))
is settled: they read that row, said no to it, and accepted the rest of the set. `sheetRows` skips it,
so it is never assembled, never selected, never confirmed, never pressed, never counted by the three
`runnable*` halves and never reported on.

Assembling it would undo the decline by the one surface that never saw it. A sheet is a list of what
is still to run, and a struck row on it is pressed like any other: dispatched for, driven in a
browser on somebody's acceptance environment — the exact spend the decline exists to refuse — and
then written back onto the goal's own check as a reading, over the operator's. The decline would
survive as a note nothing acted on.

It is skipped rather than blocked, because `blocked` is a row a reading could not be taken for and
this is a row nobody asked for a reading of. The goal's own record still carries it, with the
operator's reason, drawn distinctly on the goal page.

### What a row can come back as

| Outcome    | Means                                                                                                       | Writes on the check                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `passed`   | The run satisfied what was declared. A **retried pass is a pass**, and the row records that it was retried. | `passed`, `resultBy: 'spec'` — see [What a spec reading is worth](#what-a-spec-reading-is-worth)                                                                                |
| `failed`   | The run did not satisfy what was declared.                                                                  | `failed`, `resultBy: 'spec'`                                                                                                                                                    |
| `blocked`  | **No reading was taken.** Nothing was learned about the goal.                                               | Nothing at all                                                                                                                                                                  |
| `captured` | A `screenshot` step handed a **screen** back. Nothing was asserted and nothing is green.                    | `captured` plus the image, `resultBy` the assertion's instrument or `agent` where nothing asserted — see [A screen from the sheet's own run](#a-screen-from-the-sheets-own-run) |

Eleven things produce `blocked`, and the number of roads into it is the point:

- the row's query is **not approved for this environment**;
- the selector **matched zero tests**, or **matched more than it ran**;
- the runner offers **no spec the check named** as one it expects its area to run;
- the check's area holds the **selector delimiter**, so it could never be passed as one selector;
- the environment does not `permit` that row kind;
- there is no private network, no credential or no tenant;
- the goal's work is **no longer in the deployed commit**, or the pin could not say;
- a **runner-level failure** skipped the tests a dependency was holding up;
- the environment **moved mid-run and the row failed**;
- a check whose plan asks for a **screen** came back without one;
- the report named a screen that is **not a file name** — a path, or a URL.

**`blocked` resolves per row, never per run**, and that is the sharpest edge in the document.
Reachability differs by row kind inside one environment: browser rows reach the app over public
ingress and `state` rows may need private network access. A machine without that access must still
produce every browser row and report the `state` rows `blocked`, publishing a useful sheet. `failed`
on an unreachable store is the most trust-destroying outcome available — it dispatches
`validation-failed` at code that is fine.

`captured` is the one outcome that asks for something rather than reporting something: a person's
eyes. It never coexists with `failed` on one row — a red the product earned outranks a screen nobody
has looked at yet, and the image rides the failure as evidence for it.

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
on `PlanPart.coverage`. It is **prose** — _checkout with a saved card_, not `Checkout Tests` and not
`tests/checkout.spec.ts` — and no selector is resolved from it: what the run's own listing puts to a
runner is the area a `suite` step of a test plan written later names, against the merged
code ([How a check comes to have an area](#how-a-check-comes-to-have-an-area)). Everything else about
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
  replaced. The honest answer there is no test part: it belongs to the snapshot suite, or to a
  validation check whose `screenshot` step the fleet captures and a person judges
  ([20](20-validation.md#who-carries-a-step)) — _not an area_ is a statement about the permanent
  suite, and never a nomination of somebody to go and look.
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

**A `suite` step names it, and nothing else does. Built.** `stepArea` (`src/validation/steps.ts`)
reads the first `suite` step that names one, `checkAmendment` writes it, and the inheritance below is
gone — along with the boot repair that recomputed it and the two-areas refusal that existed only
because of it. The two landed **together**, deliberately: withdrawing the inheritance before a step
could name an area would have left every check with a null one, which is this document's own quietest
failure.

The area already written on a deployment's existing checks stays where it is — nothing clears the
column — so a goal mid-flight keeps its browser half. It is recomputed from the steps the next time
the check is authored or amended, which is the change taking effect rather than a row going quiet.

A check's `area` is set by a validation planner
writing a `suite` step that names one ([20](20-validation.md#the-test-plan)); it is no longer
inherited from the `coverage` of a test part the check happens to `cover`. Inheritance made a check
automatable by accident — a `covers` entry is a bibliography, and it was deciding what ran. A goal
whose coverage part built an area the validation planner then chose not to run is now an ordinary
outcome rather than an unreachable state.

Everything below still holds for the string itself: where it comes from, why it is compared exactly,
and where a mismatch is caught. The author changed, and with them the moment the string is chosen; the
contract did not.

`plan_parts.coverage` and a check's area read as the two ends of one string, and for a while nothing
joined them: a column was built, nothing wrote it, and **every check on every deployment had a null
area**. That is the quietest failure this document holds. `areasOf` drops a check with no area, so
`runnableSelectors` answers empty, `remoteRunBriefs` reports `confirmed: 0`, the rule dispatches
nothing and a press finds no browser half at all — on a deployment that configured
`permits: ["check"]` and a full `validate.browser` block and got manual rows with no indication why.
It reads as a misconfiguration and is not one, which is why the row now says so in words
([A row no press can read](#a-row-no-press-can-read)).

**The area is on the step, and there is no column.** `validation_checks.area` and `.expects` are read
by nothing and written by nothing: every reader — the run's listing read, the briefing, the sheet, the
report fold, the cockpit's proof band — calls `stepArea` or `stepExpects`
(`src/validation/steps.ts`) on the check's own steps. One fact, one home. The columns keep the data
they were given and are still declared in `VALIDATION_COLUMNS`, because dropping a column while it is
still declared adds it straight back on the next boot and dropping it from both rebuilds the table on
every boot for ever; retiring them is its own change ([Migrations](#migrations)). Deleting the fields
from `ValidationCheck` rather than deprecating them is what found every reader: a reader left on the
column would consult a string no author has touched since, which is the withdrawn `covers`
inheritance coming back through a side door.

The join is two things, and **which of them the exact string is picked at** is the whole of the design.

**A `suite` step carries it, and the planner names it as the suite names it.** The listing is read
against the string **exactly**, so an area described in prose — _amend the checkout area to accept the
new confirmation step_, against a runner offering `Checkout Tests` — can never match, and reconciling
the two fuzzily would be the harness guessing which area an author meant, which is what this design
refuses everywhere else. So both the schema description
(`validationStepsSchema`, `src/validation/checkDocument.ts`) and the note the planner is handed
(`validationPlanNote`, `src/validation/authoring.ts`) ask for the area **as the suite names it in the
repository the planner is standing in**, and say where the name is resolved: against the deployed
commit's own listing, when the run happens, with a name that does not resolve blocking the row and
both lists drawn side by side. That is the same sentence in both places, which is
[20](20-validation.md#the-test-plan)'s rule about a field the schema and the note both describe.

**Nothing pre-resolves it, and no list is offered to pick from.** The planner used to be shown a cached
listing and told to copy from it. The listing was taken in the _harness's_ clone at whatever commit it
stood on, which is a guess about a commit the environment is not running — answered properly one press
later, by the run's own listing in a checkout pinned to the deployed commit
([The listing the run takes](#the-listing-is-taken-by-the-run-and-not-by-the-harness)). So the cache
is gone and the note offers no areas. What is lost is a refusal at plan submission the run's listing
makes anyway; what is gained is that nothing in the tree pre-resolves a string against a listing
nobody will run against.

`stepArea` reads the first such step wherever an area is wanted, and nothing copies it: an author that
moves the step, or drops it, moves the area with it rather than leaving a selector the runner no longer
offers.

**A part's `coverage` is prose, and nothing is checked against a listing.** It is the one string in
this chain written before the code exists, which makes an exact pick a guess taken at the worst
possible moment: the planner is describing coverage the part has not built yet, and the only listing
anybody can hand it is what the deployed suite offers **today**. Refusing a `coverage` that listing
does not hold refuses precisely the case the bar exists for — _add end-to-end coverage for checkout
with a saved card_, an area that is new by definition — so a genuinely new area could not be declared
at all and the planner's obedient move was to declare no test part, which is the bar failing closed on
the goals it was written for. So the decision waits for the diff: `testPartNote`
(`src/plans/planning.ts`) asks for the area **in words** rather than as a file path, `coverage` names
whatever the part is for, and the validation planner picks the instrument later, against merged code,
off a listing that by then holds what the part added.

**The two being different strings is the design rather than a loss.** `coverage` says what a part is
_for_ and is read by a person and handed to the validation planner as input
([20](20-validation.md#a-permanent-test-influences-and-never-dictates)); `area` is what a runner is
handed. A `coverage` no check's area ever echoes is a part whose spec the validation planner chose not
to run, which is [an ordinary outcome](#a-check-is-verified-against-one-area-and-a-covered-area-needs-no-check)
and not a row gone quiet.

**It was inherited from `covers`, and that is withdrawn.** A covered part's `coverage` used to become
the check's `area`, recomputed on every ingest and again from SQL at boot (`joinCheckAreas`). Both are
gone. The inheritance made a check automatable **by accident**: `covers` is a bibliography — it says
what a check exercises — and it was deciding what ran. A goal whose coverage part built an area the
validation planner then chose not to run is now an ordinary outcome rather than an unreachable state.

The boot repair went with it for a sharper reason than tidiness. It was idempotent only while nothing
else wrote the column; the step is the area now, so the same pass would have overwritten what an author
named on every boot — the join quietly undoing them, with nothing red. That is why nothing recomputes a
derived value at boot anywhere in this subsystem.

#### The cached offering is a convenience and the pre-flight is the authority

**Both are gone, and the heading is history.** There was a cache — `remote_selector_offerings`,
refreshed per browser environment on a thirty-minute clock by `RemoteValidationDesk.refreshSelectorOfferings`
— and an assembly-time pre-flight that read it. The pre-flight went first: it took its listing in the
harness's own clone, at whatever commit the operator's checkout stood on, which is a second and worse
answer to a question the run now answers in a checkout pinned to the deployed commit. The cache
outlived it only as the list a planner picked an exact string from, and it dies with that pick: nothing
pre-resolves an area at plan time now, so a listing kept where no row is read against it is a spawn,
a table and a clock in service of nothing.

What that leaves is one reading rather than two, and it is the better-founded one: the run's listing,
taken where the run is, about the commit the environment is running
([The listing the run takes](#the-listing-is-taken-by-the-run-and-not-by-the-harness)). The cost was
stated when the pre-flight went and has not changed: a renamed or deleted area is found **one press
later**, at the cost of a lease, a checkout and an agent turn — accepted in exchange for an answer
true of the deployed commit rather than of somebody's working copy.

**Three edits retire the table, or the retirement is silent.** `remote_selector_offerings` is named in
the retired-tables list `Store` passes `dropRetiredTables`, its `CREATE TABLE IF NOT EXISTS` is gone
from `src/store/schema.ts`, and its `REMOTE_VALIDATION_COLUMNS` entry is gone with it. `rebuildTables`
re-runs the whole schema immediately after the drop, so a `CREATE` left standing would drop and
recreate the table empty on every boot, invisibly. Dropping it is safe where dropping a _column_ is
not: the table holds no verdict and no reading, only what a runner last said, and nothing reads it.

#### A check is verified against one area, and a covered area needs no check

Two shapes are ordinary rather than exceptional, and the join answers each.

**A check may cover several parts, and it no longer matters.** While the area was inherited, a check
covering two parts declaring different areas was **refused where it was authored** — `twoAreaRefusal`
— because a check is matched against one selector when the run's listing is read, and read under one, and taking the
first silently would report a pass for coverage nothing exercised. That refusal went with the
inheritance: the ambiguity it guarded cannot arise once a step names the area, because the author is
naming it rather than being assigned it. Where a plan writes two `suite` steps, the **first** is the
check's area — an order the author chose, not a coin the harness tossed — and the second is a step in
the same journey.

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

A watch check carries its own time bound written against `{since}`
([29](29-post-deploy-watch.md#every-query-carries-since)), and a sheet substitutes **the goal's arrival
on that environment** — the same instant the window's own readings are bounded to, so the sheet and the
watch ask the same question of the same period rather than two questions that disagree by a clock. A
`state` query carries no such token and is asked as it was written: it is one reading of the shape of
data at a moment somebody chose, not a question about a period ([two lifetimes](#two-lifetimes)).

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
- **Accepting a goal's check set does not approve its queries.** The check set has a gate of its own now
  ([20](20-validation.md#the-check-set-is-proposed-before-it-is-work)), and folding this consent into it
  would key a per-environment statement to a per-goal press: the same query would arrive pre-approved
  against production because somebody accepted a plan. So the check-set ask **names** the checks carrying
  a `state` step and says out loud that they are not covered — leaving them off it is the other half of
  the same failure, where an operator accepts a set and meets a `blocked` row they believed they had
  cleared.
- **`presence` gets the same treatment**, for the reason it exists: an unapproved presence query
  cannot distinguish a healthy release from a query naming a column that is not there.

The `signal` and `measure` rows carry the watch's own approval unchanged — an agent's `watch_declare`
proposal is not live until an operator accepts it, and `listGoalWatches` is live-only. What this
document adds for them is the second key: **a live watch check is still `blocked` on a sheet until its
digest has been accepted against _that_ environment.** The watch puts a query to one environment
because it is asking whether the query parses; the sheet puts it to a named place, and consent to a
place is not transferable.

## When a sheet is assembled, and what runs without asking

**Assembly waits for the check set. Built.** The set is authored after the assessor writes
`delivered` ([20](20-validation.md#when-the-check-set-is-written)), and a deployment quick enough to
arrive first would assemble a sheet carrying only the watch-derived rows — a bench that offers
nothing to run, reads as a misconfiguration, and is not one. It is this document's own null-`area`
failure in a new place, and it takes the same remedy: an explicit gate rather than a race that has
not been lost yet.

The gate is an `authored` predicate on `sheetableArrivals` — `checkSetReleased`, which is
`validation_plans.released_at`, or live checks no gate of the operator's ever stood in front of (a set a
plan document ingested, or a record holding only a hint). **The accept is part of the gate**: an authored
set is a proposal until the operator answers it, and a sheet assembled off one would offer rows nobody
agreed to run ([20](20-validation.md#the-check-set-is-proposed-before-it-is-work)). Its **position among
the cuts is load-bearing**. Authoring routinely takes longer than the two probe intervals the freshness guard
allows, so an arrival deferred for the planner and then aged out by that guard would be stamped
without a sheet and lose it for good. So the staleness cut runs **first**: the arrivals that would
flood in on the pulse an operator adds a `validate` block are stamped and not assembled before
authoring is consulted at all, and the backfill guard is intact. Only an arrival that entered fresh
waits on the planner, and it waits as long as the planner takes — deferred unstamped, the cap's own
arrangement, and re-considered every pulse until the set exists and has been accepted.

An arrival assembles a sheet and **never starts a browser run**. That gate is the only moment in a
goal's life when somebody looks at the list of checks with the delivered thing actually in front of
them, and it is where amendment, selection, waiving and consent to spend all naturally happen.

What runs at assembly, without asking:

- **Every approved `state`, `signal` and `measure` row.** They are read-only, consented and cheap, so
  the operator arrives at a sheet with those readings already on it. That is a better-informed press
  than an empty one, and it keeps the gate from becoming the bottleneck that makes people
  rubber-stamp it.
- **Nothing that asks a runner anything.** Assembly spawns **no browser command at all**. It reads
  the checks, the watches and the approved queries out of the store, writes the sheet's rows, and
  takes the deterministic readings above; `remote_sheet_rows.matched` and every row's
  `blockedReason` are left exactly as the fold that wrote them left them.

  **There used to be a pre-flight here, and it is retired.** It asked the deployed runner, through
  `validate.browser.listSelectors`, which selectors it offered, and blocked a `check` row whose area
  the answer did not hold. The listing it took was taken in **the harness's own clone**, at whatever
  commit the operator's checkout happened to stand on — so the denominator an operator pressed on
  described the operator's machine rather than the deployed build, which is the one thing `matched`
  must never describe ([The runner contract](#the-runner-contract)). The run agent now takes that
  listing itself, in a checkout pinned to the deployed commit, and that is the only listing a row is
  read against ([The listing the run takes](#the-listing-is-taken-by-the-run-and-not-by-the-harness)).
  A second writer of one column was tolerable only while the two were ordered and the later won;
  with the earlier one gone there is one writer, which is the shape this document prefers everywhere.

  **A mismatch is therefore discovered one press later than it used to be, and that is the accepted
  cost.** A renamed area, a deleted spec or a wrong profile no longer blocks at the gate: assembly
  withholds nothing, so the operator consents, the rule leases a worktree, cuts a read-only checkout
  at the deployed sha and spends an agent turn before anybody is told. What is bought for it is that
  the answer is **true of the commit the environment is running** instead of true of somebody's
  checkout — and a wrong answer at the gate was never cheap either: it blocked a pressable row on a
  mismatch that existed only on the operator's machine, which costs an amendment nobody needed.

  What keeps the cost to a checkout rather than a full suite run is that the listing is a **step of
  its own**, taken before the runner is invoked and answered by a tool that hands back only the
  selectors that survived. The rows a listing blocked are simply not in that answer, so the agent
  never invokes them: the spend is a lease, a checkout and a listing command — seconds of suite time
  — and not the minutes a browser run costs. That ordering is the whole reason this is affordable,
  and moving the listing after the invocation would turn the deferral into a real bill.

Everything else waits for the press. The bench obligation is _this is ready to run — review it and go_,
and four things happen there:

- **Query approval** — the dry run, for anything not yet accepted here.
- **Amendment** — a check written at plan time against code that did not exist yet, reread against
  code that now does, through `validation_amend` ([20](20-validation.md#amendment)). A check whose
  selector a run's listing could not find is exactly a check that needs rewording.
- **Selection and waiving** — a row that does not apply to this environment, or that the operator will
  do by hand, is deselected; a check the product has genuinely moved past is **waived with a reason**.
- **Consent to spend** — browser rows cost minutes and an agent. Starting them automatically spends on
  every arrival, including the ones nobody was going to read.

The tenant's age is drawn at the gate too, which is where an operator can act on it. → [Tenants](#tenants)

### An expected spec the runner does not offer

**A check may write down the concrete spec names it expects its area to run, and one the runner does
not offer blocks the row.** They ride on the `suite` step exactly as the area does and live nowhere
else — `stepExpects` (`src/validation/steps.ts`) reads the first `suite` step that names any, and every
reader calls it. One home, for the reason the area has one
([How a check comes to have an area](#how-a-check-comes-to-have-an-area)): these are strings a
listing is read against **character for character**, and a second author for one of them is a silent
undo.
`resolveSteps` normalises the field the same way — a `suite` step's names, null on every other kind.

**Naming them up front is the only thing that can see a spec that has been deleted.** A check selects
an area; the runner runs whatever that area holds **today**; the row goes green on what remains. A
spec deleted or renamed since the check was written therefore disappears in silence, and the row
reports a pass for coverage that no longer exists — which is this document's own worst outcome, a
green row standing for nothing.

**The counts cannot reach this, and that is why the field exists.** `matched` is the denominator the
run's own listing gives _today_ ([The listing the run takes](#the-listing-is-taken-by-the-run-and-not-by-the-harness)),
so a deleted spec lowers the executed side and the listed side **together** and the consistency
check's `executed < matched` ([The runner contract](#the-runner-contract)) never fires. Every number
on the row moves with the deletion. Only a name somebody wrote down can be missed. It is also why a
loose expectation would be decoration: _the checkout journey_ misses nothing, where four named specs
miss one. The planner is told to name them rather than describe them — in the test-plan note
(`TEST_PLAN_NOTE`, `src/validation/authoring.ts`) and in the tool schema's own description of the
field, which is the same string in both places for the reason every step field is
([20](20-validation.md#the-test-plan)).

**Null is _no expectation was named_, and never _expected nothing_.** It is true of every check whose
author named none, and the difference the listing read
takes is computed **only** where there is an expectation to take it against. Fold the two readings together
and every check on every deployment blocks on an empty expectation — a whole bench of rows refusing to
run, naming nothing missing, with nothing red. An empty list is the same fact said a second way and
normalises to null in `stepExpects`, so no route to a reader can produce one. Nothing is backfilled and
there is no `runOnce` ([Migrations](#migrations)).

**It blocks rather than reporting on the remainder**, and the reason is the `empty` arm's reason one
step on: a pass on what is left is a pass for coverage that is gone, exactly as a selector matching
zero tests is not a clean pass. The reason names the missing specs and what the runner does offer, so
the operator meets the two lists side by side and can tell a renamed spec from a deleted one without
leaving the sheet. Amendment is the remedy, at the bench, where a check whose selector a listing could
not find is already sent ([20](20-validation.md#amendment)).

**`matched` is unchanged by any of it.** It still comes from the area's own offer and from nowhere
else — a blocked row carries the count the listing gave, because the count is a reading of the
listing and not a verdict on the check.

### A row no press can read

A check written before test plans existed carries prose and no steps. It names no area, no one-off
script and no screen, so **a press reads nothing on its row and dispatches for nobody** — and the
shape that leaves is the quietest failure this document holds. The row stays `selected`, the gate
offers to run it, `owed` counts zero, the press settles the run `ended` on the spot, and the row reads
as one that was never run: a sheet that looks like it ran and did not.

**It is a sentence on the row and never a `blockedReason`.** A block is a cause no press can overcome,
and this one is overcome by amending the check or by writing the configuration block the row names. A
block would also catch every honest prose check — which is most checks on most deployments — so every
goal's sheet would report "N blocked" and read as a misconfiguration it is not.

`remote_sheet_rows.idle_reason` carries it, folded in `sheetRows` (`src/remoteValidation/sheet.ts`) at
assembly, beside the row it describes. It is folded on the **server** for the reason the Environments
card's line is: a cockpit working out for itself which rows a press would touch is a second opinion
drawn beside the reading. Three arms, each naming what would carry the check:

- **No steps at all** — the row says the check declares no test plan, so nothing names an instrument
  to run it with, and names the three that would: a `suite` step's area, a `browser` step's one-off
  script, a `screenshot` step's screen. It is a person's to carry out, which is what it always was.
- **Every step a person's** — the row carries the **first step's own `why`**, which `stepFault` already
  wrote and which names the configuration block that would have made it the fleet's. Nothing here forms
  a second opinion about that: who carries a step is read off the configuration
  ([20](20-validation.md#who-carries-a-step)) and this repeats the answer rather than recomputing it.
- **A plan naming nothing a run here can carry** — steps the fleet holds, but no area, no script and no
  screen, or an environment declaring no `validate.browser.runner`. The row says so, and names the
  environment.

**The gate's count reads it, so "Run N rows" is honest.** The cockpit counts the rows a press will
actually read or dispatch for — selected, unblocked, and carrying no `idle_reason` — rather than the
selection. Counting the selection offers to run rows the press would touch in no way at all, which is
the same wrong reading one surface out.

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
exactly the behaviour the deterministic half had before the agent existed. The two arms read the same
four predicates the brief does — `runnableSelectors`, `runnableScripts`, `runnableScreens` and
`runnableDrives` — for the reason [the dispatch](#the-dispatch--rule-remote-validation) states.

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
  exist. Nothing upstream can rule the character out: an area is a string somebody typed — a `coverage`
  is free text by design, a `suite` step's area is whatever its author wrote, and a runner that offers
  `Reports, exports` is an ordinary thing to have. A check whose
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

### The listing is taken by the run, and not by the harness

**Built**, as `RemoteListingDesk` (`src/remoteValidation/listing.ts`) behind the
`remote_validation_listing` tool.

> **The denominator a row is read against describes the commit the environment is running, or it
> describes nothing.**

`matched` is one half of matched-versus-executed, which is the guard the rest of this contract leans
on. Taken in the harness's own clone it counts whatever branch an operator happens to be standing on,
while `executed` comes off a run against the deployed build — two commits, one subtraction, and a row
that blocks naming a renamed area against a runner offering precisely the right ones. So the listing
is taken where the run is: **the run agent invokes `validate.browser.listSelectors` itself**, in the
read-only checkout pinned to the deployed commit
([The dispatch](#the-dispatch--rule-remote-validation)), with the same environment set the runner is
handed, and before it invokes anything.

**It hands back a path, and the harness parses the file.** The agent writes what the listing command
printed into the run's own `listing` directory and calls `remote_validation_listing` with that path,
which is recorded on `remote_runs.listing_path`. It names no selector and states no count — the tool
has no field for either — so what reaches `matched` is the runner's own output, read through
`parseSelectorListing`. **A path says where a file is, not what is in it**, which is the whole of why a denominator may come
through an agent at all: it is `reportPath`'s own argument, unchanged, one column over. A tool with a
`selectors` field would be a tool through which a model's recollection of the suite becomes the
number its own run is graded against.

**The listing may be prefixed, and it may not be guessed at.** A suite's own config prints ahead of
its report — a dotenv banner is the ordinary case — so `parseSelectorListing` _seeks_ the JSON array in
the output rather than requiring it at byte 0, and seeks it at each `[` rather than at the first brace,
because a banner holds a brace of its own. What it will not do is read prose as areas: a line-form
listing holding a line that is not a name — a brace, a `//`, or more than 120 characters — is
**refused**, `offers: null`, exactly as a kill is. A banner read as one name per line offers areas no
check can match, and every row then blocks naming a renamed area against a runner that offered
precisely the right ones — an empty listing read as an answer and a garbage one have the same shape.

**The tool answers with the selectors that survived, and those are the ones the run invokes.** It
blocks a row on **four counts, in this order**, through `preflightRows` (`src/remoteValidation/preflight.ts`,
which kept its name from the pre-flight it outlived): the listing **could not be taken** at all; the
listing holds **no offer** for the area the check names; the offer it holds is **empty**, which is a
selector that matched zero tests and must not read as a clean pass; and the check named **specs the
listing does not offer**
([An expected spec the runner does not offer](#an-expected-spec-the-runner-does-not-offer)). The
fourth is last because the three before it are about the area itself, and a name inside an area is only
worth asking after about an area that exists and holds something. Two rows it leaves exactly as they
are: one another cause has already blocked keeps the reason it has — a kind this environment does not
permit is not a mismatch — and a check that **names no area** is a person's, which was never a question
for a runner. A row any arm blocked is simply not in the answer, and `LUBBDUBB_SELECTORS` is the answer
comma-joined.

**A listing arm writes a `blocked` _reading_, and never the row's `blockedReason`.** This is the
distinction the whole step turns on. A `blockedReason` is a cause **no press can overcome** — an
unpermitted kind, an unapproved query, an area holding the list's own delimiter — and a row carrying
one is out of every later invocation until somebody amends it. Every reason a listing finds is
amendable by definition: a reworded area, a restored spec, a suite reorganised back. Written from
inside a run as a `blockedReason`, a mismatch this afternoon's merge already fixed would be
permanently unpressable, with nothing red, on exactly the deployments whose suite moves most. A run's
`blocked` is a reading — of this run, at this moment — which the next press is entitled to take
again, and it is the same word the report's own arms write for the same reason
([A row that learned nothing](#the-report-is-the-only-source-of-row-outcomes)). **Nothing writes a
row's own `blockedReason` from a listing at all now.** The assembly pre-flight did, and could, because
it read before anybody consented; with it retired every cause left on that column is one no press can
overcome, and every listing verdict is a reading.

**The fold never reads a report over a row this run's listing blocked.** `RemoteReadingDesk.settle`
drops those rows before it folds anything and counts each one blocked. It is the one place in this
design an agent's own choice could reach a verdict: the agent picks what it invokes and may invoke an
area the listing did not survive, and the fold reads a report row against `area` alone — so that row
would come back **green over the block the harness had already written**, which is a pass for
coverage the listing says is not there. Ordering the two readings by recency would settle it the
wrong way round exactly when it matters, because the report is always the later of them.

**A listing nobody could take blocks the check rows and leaves the run open.** `blocked` with a
reason, instead of a path, is the same third answer the report tool has and carries the agent's words
to the operator. Every `check` row the listing would have answered for blocks with it; the run itself
stays live, because a run may still owe a one-off script or a screen and a listing has nothing to say
about either ([A screen from the sheet's own run](#a-screen-from-the-sheets-own-run)). The run is
still settled by `remote_validation_report`, once, at the end.

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
- a row carrying a **`capture`** hands a screen back rather than asserting: it is `captured`, and a
  check that asked for one and got none is `blocked`.
  → [A screen from the sheet's own run](#a-screen-from-the-sheets-own-run)
- **a retried pass is a pass**, and the row records that it was retried. Retry policy belongs to the
  project's runner config, not to the harness. Repeated retries on one area are a signal about the
  spec, surfaced through [what a row records](#artefacts-and-making-worth-observable) rather than
  treated as a failure.

**The shape of the report is the harness's, and the project's own reporter emits it** —
`validate.state.run`'s arrangement one subsystem over, and for the governing principle's reason. It
is a JSON list of the tests that ran, or an object carrying one under `tests`; each entry names its
`selector` — the area, compared against the one the check's `suite` step names and nothing else — and its `status`,
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
`blocked` too, because a row whose selector matched nothing is never a pass — and **absent** now
means _the listing has not been taken for this row yet_, which blocks through the same arm it always
did. That the column's null changed meaning without changing what it does is why it needs no
backfill ([Migrations](#migrations)).

**A row that learned nothing writes a `blocked` _reading_, not a `blockedReason` on the sheet row.**
The two are different facts and folding them would cost the sheet its next press: a row's own
`blockedReason` is a cause a press cannot overcome — an unpermitted kind, an unapproved query, an
area holding the list's own delimiter — where a run's `blocked` is a reading, of this run, at this
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

**Built.** A `check` row runs a **reviewed spec** in the project's own browser suite, selected by
area. That is the right instrument for a journey the product will keep having, and the wrong one for
the thing most goals actually need checking: data arranged into one particular situation, a column
option selected in one particular table, a state that exists to demonstrate this change and will never
be interesting again. A suite cannot hold every scenario and should not try — a suite that does stops
being a description of the product.

So there is a second kind of browser work, and the distinction is the one this document already
draws between a spec and a query:

|              | **Suite spec**                                         | **One-off script**                       |
| ------------ | ------------------------------------------------------ | ---------------------------------------- |
| Lifetime     | Permanent, versioned, amended by later goals           | The goal's, plus a grace period          |
| Reviewed     | Yes, as ordinary repository code                       | No                                       |
| Ever in a PR | Always                                                 | **Never**                                |
| Selected by  | the `suite` step's area, against the run's own listing | Written for this check, run as it stands |
| Written by   | A part agent, as a `coverage` plan part                | The validation planner                   |

A one-off script is the browser-shaped member of the **query** column
([Two lifetimes](#two-lifetimes)), and it inherits that column's answers: it is not repository
code, it is not reviewed by a pull request's reviewer, and it does not outlive the question it was
written to answer.

**It acts, where a query only reads, and that is the one genuinely new capability.** Arranging data
into a particular situation means writing to the environment. So a one-off script runs **inside the
run's tenant**, under exactly the machinery the suite run already uses — `ensureTenant`, `reseed`, the
lock, the reap window ([Tenants](#tenants)) — and an environment with no tenant is an environment
where a script that writes is a `blocked` row, not a script that runs somewhere it should not.

Two places carry that refusal and both name the line the operator has not written, never "no
tenant": `stepFault` gives the step back to a person, and `sheetRows`' `actingTenantFault` blocks
the row — which covers **every** `browser` step and not only one carrying a script, because an agent
at a browser navigates, uploads and clicks and so acts the same way
([a check the agent drives itself](#a-check-the-agent-drives-itself)). It runs from the **sheet's run** and not from the `validate-check` dispatch, which has no
tenant, no lock and no reap window — `checkBriefing` prints the source there and says so in as many
words, because an agent that read a script it was not to run and ran it is the failure the
machinery exists to prevent.

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

The clock runs from the goal's **delivery** — `issue_deliveries.decided_at`, which is what parks the
goal and the one moment the harness records as _this goal is over_. Dating it from anything the
check itself carries would restart the window every time somebody recorded a reading on the row.

`RemoteValidationDesk.sweepScripts` is a fourth pass, below the run sweep, **inside the same early
return** and in its own `try`, for that pass's reasons exactly. It names what it removed **where the
source was**: `scriptSweptAt` on the step (`sweptScripts`). A `browser` step reading _there was a
script here and it is gone_ is not the same row as one a person always drove, and a sweep that
simply nulled the field would quietly rewrite how a green row was earned. It writes the steps column
and nothing else — removing a source says nothing about whether the check passed, and a writer that
cleared the reading, the hand-back and the amendment band beside it would take a goal's whole
validation history out with a housekeeping pass.

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
sharp edge of this half: it lives on `remote_sheet_rows`, written by the run's own listing
([The listing the run takes](#the-listing-is-taken-by-the-run-and-not-by-the-harness)).
Both numbers are in one object by the time the fold runs and the wrong one is a character away — and
taking it off the report is exactly the shape that makes a selector matching **zero** read as a
clean pass.

### Handing a screen back to look at

**Built.** A `screenshot` step ([20](20-validation.md#the-test-plan)) captures the screen and
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

The state is **`captured`**, a value on `validation_checks.state` and so no `ALTER TABLE` — the same
case as `result_by` gaining `agent`, `desktop` and `spec`. What makes it safe to add is the
direction `checkStateOf` narrows in: anything it does not recognise reads `unrun`, so a row written
before the state existed lands on _nobody has got to it_ rather than on _there is an image here
waiting for you_. It is counted apart from `unrun` on `ValidationVerdict` for the same reason — the
two ask different things of the person reading them.

Both report channels carry it: `result: 'captured'` plus a `capture`, on `ReportSchema`
(`src/validation/report.ts`) and so on the fleet's `validation_report` and the operator's desktop
one together. The capture is **required** with `captured` and **refused** with anything else — an
image beside a pass reads as the evidence for it, and nobody looked. A person's later reading keeps
the image they judged; only a reset, which means _nothing to attribute_, clears it.

**A capture is not an artefact URL, and the difference is retention.** The publish command's report
is the run's, swept on the runner's own schedule; a screenshot a person still has to look at outlives
the run that took it and is held with the goal's validation directory
([12](12-artifacts-and-files.md)). A capture that expired before anybody opened it would leave a row
asking for a judgement about an image that is gone.

So `validation_checks.capture` holds a **file name** and never a path or a URL — the resource name's
own rule, and for the resource name's reason: a name cannot escape the directory it is resolved
against, so nothing downstream has to prove that it did not. It is a new column on an existing table
and has its `ALTER TABLE` in `VALIDATION_COLUMNS`; null means _no capture_, true of every row from
before it, so nothing is backfilled.

`GET /validation-captures/:originRef/:checkId` serves it, capability-signed like a local run's
screenshot. **The file name is never a parameter**: it is read off the check's own row, so the only
thing a caller can name is a check — the goal's validation directory also holds its resources, and a
route that took a name would serve any of them. The signed URL reaches the cockpit as
`ValidationCheckView.captureUrl`.

### A screen from the sheet's own run

**Built.** The `validate-check` dispatch is not the channel that can take the picture, and its own
prompt says so: _the fleet has no interactive login, no browser and no account on whatever
environment this deployment tests against, and a check that needs one is a check for a person._ The
sheet's run is where the browser, the login, the provisioned tenant and the deployed build are — so
that is where a `screenshot` step is carried, and the hand-back on the step-by-step channel is the
narrower of the two rather than the whole of it.

A capture rides the **report row**, and nothing about the tool changes: `remote_validation_report`
still takes a report path and artefacts, the agent still states no outcome, and _the report decides
every row_ holds exactly as written. The row carries a `capture` beside its `selector` and `status`.

**Keyed on the check's own id, as a one-off script's row is.** An `area` may be named by two checks —
[the join answers that](#a-check-is-verified-against-one-area-and-a-covered-area-needs-no-check) — and
a capture landing on both would offer one image, taken once, as the thing two different people have
to look at. `validation_checks.capture` is one name per check because a capture is evidence about one
journey.

**A `screenshot` step is not a third instrument.** `spec` and `script` are attributions of what an
assertion is _worth_, and a screenshot asserts nothing, so it attributes nothing: a check that only
hands a screen back is recorded `agent` — the fleet took the picture — and a check that _also_
asserts keeps the assertion's own word. Reading the capture as an instrument would fold the two the
design keeps apart, by the far door.

Three rules decide what such a row comes back as, and each is one this design already holds:

- **A red the product earned is never withheld.** A row whose assertion failed stays `failed`, and
  the screen rides it as evidence for the failure.
- **A screen that never arrived is `blocked`, even where the assertion passed.** Handing the screen
  back is the whole of what the step is for, so a `passed` there would be green about something else.
- **Otherwise the row is `captured`** — never `passed`. `RemoteRowOutcome` gains that value beside
  `passed`, `failed` and `blocked`; it is a value on an existing column, written only by new code, so
  no database from before it holds one and nothing is migrated. It is counted apart from both on the
  Environments card's fold line: a captured row is neither a red somebody must act on nor a row
  nothing was learned from.

**The harness moves the file, and both properties of a capture survive it.** The agent writes the
image into the run's **artefact** directory — which is what that directory is for — and names it in
the report **by file name**, never a path and never a URL. `RemoteReadingDesk` copies it out into the
goal's validation directory under a name the harness composes from the check and the run, because
that directory also holds the goal's resources and two checks that both handed back `screen.png` must
not be one file. So the report never decides a directory, the row still holds a name, and the capture
outlives the run whose artefacts are swept on the project's own schedule.

**A screen is the third thing a run owes an agent.** `runnableScreens` joins `runnableSelectors` and
`runnableScripts` at the press: a check that only hands a screen back names no selector _and_ carries
no script, so a press counting the two instruments would settle the run with the whole point of that
check still owed — leaving it `unrun` for ever with nothing red.

**Anything a run owes its agent is counted here, and a fourth thing is a fourth entry.**
`runnableDrives` is the fourth ([a check the agent drives itself](#a-check-the-agent-drives-itself)),
and the shape is the point rather than the number: a check carrying only the newest of them names
nothing the older ones count, the press ends the run on the spot, the check stays `unrun` for ever and
the sheet reads as a run that answered.

## The dispatch — rule `remote-validation`

**Built.** A run is carried out by a dispatched agent, `src/dispatcher/rules/remoteValidation.ts`, a
`DISPATCH_PIPELINE` entry and a `STAGES` module like any other rule
([05](05-dispatcher.md#the-rule-book)). An inline `raw.push` of a `dispatch_*` action would bypass
both the headroom cut and the Up next queue.

**Why an agent at all**, when nothing here asks a model to judge anything: the run needs a checkout at
the environment's **current commit** with the suite's dependencies installed, which is worktree work;
it takes minutes, which a pulse must not block on; and only a dispatched task gives the run a lease, a
reaper, a transcript and a kill. What the agent does is take the project's own selector listing in
that checkout, say where it landed, invoke the declared command with the selectors it was answered
with, and say where the report landed. **It states no outcome and no count** —
→ [The report tool](#the-report-tool), [The listing the run takes](#the-listing-is-taken-by-the-run-and-not-by-the-harness).
The listing is the one thing the pinned checkout is worth more than the harness's own clone for
beyond running the suite, and it is why the denominator moved here.

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
  nothing is dispatched for a run with no confirmed `check` row an instrument can carry, which is a run
  the press already finished. `runnableSelectors`, `runnableScripts`, `runnableScreens` and
  `runnableDrives` (`src/remoteValidation/briefing.ts`) are the one place that rule is written, read by
  the press and by the brief: a second copy would either strand a run waiting for an agent nothing will
  dispatch, or settle one with the agent's half still owed.
- **It carries an `enabled` predicate** on a `RuleConditions` flag — true only where some environment
  declares a `validate` block — beside `review` and `sequencer`. A rule with no run rows to read
  would already produce nothing, so this buys one thing and it is worth having: the rule book draws
  it as **inert** on a deployment that has not turned the feature on, rather than as a rule that
  looks live and never fires. An operator reading the book to find out why nothing happened is
  entitled to the difference.

**A new `issue:<n>:…` origin is declared, with its role, in `src/issueOrigins.ts`**, and
`validate-remote:<run>` is declared **evidence** beside `validate:`, `validate-failure:` and
`validate-local:` ([05](05-dispatcher.md#the-issue-origin-vocabulary)). A run is
evidence about delivered work, not work. Left out it reads as `unrecognised`: it stops expanding under
a goal's priority flag ([05](05-dispatcher.md#marking-a-goal-a-priority)) and its spend files under
"other" rather than the phase it belongs to ([18](18-observability.md)). Neither is red.

`POST /api/issues/:number/remote-validation/:environment/cancel` settles an open run `abandoned`. It
is required rather than a convenience, `validate-locally/cancel`'s reason: it is how a run is called
off **before** its agent has gone anywhere — a `pending` one the operator no longer wants, or a
`dispatched` one whose agent is still working. The desk's sweep is the other half and covers only the
case the operator cannot: an agent that has already gone ([The sweep](#the-sweep)).

### Where a sheet-kept capture is looked at

**Built.** A run writes onto the goal's check row only where the current reading is `unrun` or was one
this instrument itself took ([the overwrite rule](#a-screen-from-the-sheets-own-run)), and that rule is
not weakened by anything here. Where the check is settled by somebody else the run keeps its reading on
the **sheet** instead — and it used to keep the screen there too, reachable by nobody: the only URL
anything could build came off `validation_checks.capture`, so the check row rendered no image, the
capture route answered 404 and the sheet row rendered prose. The file was on disk under the goal's
validation directory, and the only way to see it was to go and find it on the harness host.

That defeats the reason a capture outlives its run at all. The whole point is that a person still has
to look at it, so a capture nobody can reach is a row asking for a judgement about an image that might
as well be gone.

So **the reading carries the capture's file name itself**. `remote_readings.capture` holds a name and
never a path or a URL — `validation_checks.capture`'s rule, for its reason — and it is written on
**every** row that handed a screen back, whether or not the run went on to write the check. It is a new
column on an existing table, additive in `REMOTE_VALIDATION_COLUMNS`, and null means _no screen_, which
is true of every row from before it and stays true, so nothing is backfilled.

`GET /validation-captures/run/:runId/:rowId` serves it, capability-signed exactly as the check's route
is and keyed on the **run and the row** rather than on the check. Two properties carry over unchanged:
the file name is not a parameter — it is read off the reading, and so is the goal whose directory it
resolves against — and the route reads no check row and writes nothing anywhere. This is about where an
image is shown, never about whose reading it is. The signed URL reaches the cockpit as
`RemoteReadingView.captureUrl`, null on a row that handed no screen back and on a reading no run took,
which can hand none back.

The sheet row draws it the way the check row does: an inline thumbnail on the row, clicking through to
full size ([17](17-cockpit.md#a-sheet-row-draws-its-own-capture)).

### Posting the screen to the ticket

**Built.** A capture is kept precisely because somebody still has to look at it, and the cockpit is not
where everybody is. `RemoteValidationDesk` posts each captured screen to the goal's ticket once, in the
pass below assembly, and three things about it are rules this codebase already holds:

- **It is never a `WorldEvent`,** an arrival's rule and for an arrival's reason: `deliveryHold` expires
  a standing delivery verdict on **any** world event matching the goal's issue ref, so a posting
  written as one would un-park the goal it just reported on and hand delivered work back to the fleet
  ([24](24-environments.md#in-the-cockpit)). It has its own table, `remote_capture_posts`, and nothing
  else reads it.
- **The record is written after the comment has gone up, never before.** A posting the tracker refused
  and the store recorded is a screen nobody will ever be told about; the failure goes through
  `errors.record` and the next pulse is the retry. The record **is** the idempotence — nothing about a
  tracker comment can be read back to find out whether it went — and it is keyed `(run, row)`, because
  a capture posted twice on a re-read is worse than one never posted.
- **It writes on no check row**, and the comment says plainly that nothing in it judges the screen. A
  `captured` row is waiting on a person; a comment that read as a result would be a result derived
  rather than declared ([20](20-validation.md#states)).

**The image where the provider can hold it, a link where it cannot.** These are not two designs and a
compromise between them; they are one design and a provider capability that is genuinely uneven
([15](15-integrations.md#uploading-an-image-to-a-ticket)).

- **Azure DevOps holds the image.** The desk uploads the bytes through `IssueImageSink`, and the
  comment embeds the URL the tracker gave back for its own copy. The screen is _in_ the discussion,
  stored with the work item, kept as long as the work item is and gated by the same project access.
  Nobody has to reach the harness at all, which is the whole point of posting to a ticket.
- **GitHub cannot**, and the spec says so rather than leaving it to be discovered: there is no public
  API for attaching an image to an issue comment, and committing operator screenshots into the
  product's own repository to manufacture a URL is not a side effect a validation screenshot is
  entitled to. There the comment carries the prose and a link.

**A failed upload must never cost the comment.** The posting is the only thing that tells anybody a
screen is waiting, so an upload that throws is recorded through `errors.record` and falls back to the
link — never rethrown, which would leave the row unposted and retry the same failing upload every pulse
for ever. A worse answer, not no answer. The same holds for a provider that simply has no such API:
`canAttachIssueImage()` answering false is a fact, not an incident, and nothing is recorded.

**Where there is no upload, the prose is what the comment really carries**: which check the screen
belongs to, which environment took it, which run, and what the file is called. Two limits on the link
are stated here rather than papered over, because both are real:

- **The harness does not know its own address.** The only URL it can name for itself is a loopback, and
  a loopback in a ticket is a dead end dressed as a link. `remoteValidation.captureLinkBase` is where an
  operator declares the address the harness is reachable at from wherever their tickets are read; null
  — the default — posts the comment with no link at all rather than a broken one.
- **A posted link stops verifying at the next restart.** The artifact key is minted per boot
  (`src/server/app.ts`), so the capability cannot outlive the process that signed it. The ticket's link
  is minted through its own signer at the capture's own retention horizon rather than the snapshot's
  five minutes — `remoteCaptureLinkSignerFor`, thirty days — because a five-minute token is a dead link
  by the time anybody reads a ticket. A reader who finds it expired still has the prose, which is enough
  to know the screen exists and ask for it. Making the link durable means making the artifact key
  stable across restarts, which changes the posture of all four signed routes and is its own change.

The URL is a bearer capability for one image, which is why its subject is this one `(run, row)` and
nothing wider — and why it is **not minted at all** where the image itself went up: a reader looking at
the screen has no use for a token that expires.

### The browser the run drives

**Built.** The run's agent is launched with a **second MCP server** beside the harness's own, exactly
as a local validation's is: `localValidation.browser`, one `--mcp-config` document either way, with the
grant derived in `src/mcp/names.ts` and **server-level** (`mcp__browser`) because that tool set belongs
to whoever wrote the server ([11](11-mcp-tools.md#launch-flags), [32](32-local-validation.md#the-browser)).
There is no browser inside a headless `claude -p`, and without one the agent can invoke the project's
runner and nothing else.

It is **one configuration block read by two dispatches**, not a second key. What a browser is and how
it is launched is the same question in both places, and an operator who has configured one has said
what they mean; a `remoteValidation.browser` beside it would be a second answer to that question, and
the deployment where the two disagree is the one nobody notices.

What differs is the directories, and both are substituted at dispatch by `substituteBrowserArgs`:

| Token          | Here                                                               | Why                                                                                        |
| -------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `{outputDir}`  | the run's own `artefacts` directory                                | a screen the browser takes is already where the report names it, by file name alone        |
| `{profileDir}` | `remoteValidationProfileDir` — one per **environment**, persistent | a sign-in somebody completed once is one every later run against that environment inherits |

**The profile is per environment and never the local validation's.** A persistent profile may be held
by one browser at a time, so a remote run sharing the local one would refuse to start whenever a local
validation was up — `blocked` rows on a sheet somebody pressed, with nothing red; and the account that
reaches an acceptance deployment is not the one that reaches somebody's dev machine, so the two would
fight over the same cookies besides.

**It is folded in `src/remoteValidation/briefing.ts`, beside the run directory it needs, and reaches
the rule on `RemoteRunBrief.browser` already substituted.** The rule imports nothing from
`src/remoteValidation/` ([the lens boundary](#the-lens-boundary)), so what it does with it is one line:
put it on the action, from where the executor persists it on the task row (`tasks.mcp_servers`) and
`AgentManager.spawn` opens it. Recorded on the row rather than re-derived at spawn for `model`'s
reason: `AgentManager.resume` rebuilds a launch from the row, and an agent re-attached without the
server it was launched with holds a conversation full of tool calls it can no longer make.

**It acts, so it needs a tenant**, which is why a `browser` step is a person's on an environment that
names none ([Tenants](#tenants)) — and the value of a `tenantEnv` never appears in the brief: what a
prompt and a surface carry is the variable's own name.

**The prompt offers it as a claim, not a fact**, and names the answer a browser that will not start
gets: **`blocked`, never `failed`**. Whether the server connected is not something configuration can
know — it is fetched and launched at the same moment the agent is, so it can be missing because the
machine is offline, because the package is blocked, or because no browser is installed for it to
drive, and the last of those does not surface until the first page. `failed` dispatches
`validation-failed` to fix a defect and there is no defect here, so the brief says so in as many
words.

**`null` is a real configuration.** The project's own runner brings its own browser — that is a
separate program — so a run still invokes what the environment declares; what the agent cannot do is
open a page itself, and the brief says so rather than leaving it to describe a screen it never saw.

### A check the agent drives itself

**Built.** A `browser` step the fleet carries, on a check that names **no** `suite` area and carries
**no** one-off script, is the run agent's own to carry out at the browser above. It is the fourth thing
a run can be pressed for, and `runnableDrives` (`src/remoteValidation/briefing.ts`) is the one place
that rule is written — read by the brief and by the press, which is what
[the three halves of one question](#a-screen-from-the-sheets-own-run) means with a fourth entry in it:
a press counting only selectors, scripts and screens ends such a run on the spot, the check stays
`unrun` for ever, and the sheet reads as a run that answered.

The precedence is the report fold's, exactly, and `stepDriven` (`src/validation/steps.ts`) holds it
once: an area is a `spec` reading and a script is a `script` one, and a check declaring either is that
instrument's rather than this one's. Two copies of that predicate would count one thing at the press
and write another at the report.

It reports **under the check's own id**, in the same file and the same shape as every other row — the
one-off script's arrangement, and for the same reason: the report file is the only thing the harness
reads, so a step an agent carried out and wrote up in its reply alone reported nothing, and the row
blocks rather than passing. A row that reported nothing under its id is `blocked` and never a pass: an
agent that never reached the page and one that carried every step out look identical from here.

Where the deployment declares no `validate.browser` block, or no environment names a tenant, such a
step never reaches any of this: `resolveSteps` already gives it back to a person **naming the
declaration that would have carried it** ([20](20-validation.md#who-carries-a-step)), the row is idle
or blocked with that sentence in front of the operator, and nothing here forms a second opinion about
it.

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

| Status       | Means                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------- |
| `pending`    | The press opened it and no agent has claimed it. **Live.**                                         |
| `dispatched` | The conditional flip claimed it for exactly one task. **Live.**                                    |
| `ended`      | Settled with a report recorded against it.                                                         |
| `abandoned`  | Settled with none, and never will be: the pin refused it, an operator called it off, or `blocked`. |

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

**A run's agent has two tools, and neither of them is a place an opinion fits.** One takes the path
to the listing the run took, before anything is invoked; one takes the path to the report, once, at
the end. They are the same design made twice — a narrow origin fence, and no field carrying a
verdict, a selector or a count — and `RULE_TOOLS['remote-validation']` carries both
([11](11-mcp-tools.md#which-tools-an-agent-is-advertised)), because a tool granted and advertised to
nobody is named by a prompt and callable by no agent's own list.

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
| `blocked`    | A reason, **instead of** a report: the run could not be carried out at all.   |

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

The field was called `handback` until the three validation paths were given one word for the fact, and
the old name is **refused by name** rather than ignored as an unrecognised key: the handler answers a
call carrying it with a message naming `blocked`, `RETIRED_TOOL_NAMES`' rule one layer down
([11](11-mcp-tools.md#retired-tools)). `.strict()` would already reject it, but as _unrecognized key_ —
which reads to an agent as a tool it does not understand rather than as a word that moved.

A `blocked` answer writes **no readings**, leaves every row exactly as it was, and carries the agent's
reason to the operator — `validation_report`'s third answer, and the same word for it, for its reason: an agent that could not reach
the environment has learned nothing about the goal, and with only pass and fail available its options
are a lie and silence.

**The origin fence is the narrow kind.** `remoteValidationOriginParts`
(`src/remoteValidation/origin.ts`) parses `:validate-remote:` alone, so which run a report concerns is
settled **before** the report rather than by it, and every other caller — the agent that just built
the thing most of all — is refused **by name**. The `validation-failed` agent this run may go on to
produce is refused structurally, by the parse, exactly as it is refused `validation_report`.

**`remote_validation_listing` is the second, and it is the report tool's own argument made about the
denominator.** `src/mcp/tools/remoteValidationListing.ts`, in `MCP_TOOL_NAMES` and `buildTools`,
classified `point-of-use` and named only in the `remote-validation` prompt's own briefing. It takes
`listingPath` — where the listing command's output landed, inside the run's own directory — or
`blocked`, a reason instead of a listing, and **nothing else**:

| Field         | What                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------- |
| `listingPath` | Path to what `validate.browser.listSelectors` printed, inside the run's own directory.   |
| `blocked`     | A reason, **instead of** a listing: the runner could not be asked what it offers at all. |

**It has no field naming a selector and no count**, for the reason the report tool has no field
naming an outcome: a count an agent stated is the number its own run is then graded against. What it
_answers_ with is the selectors that survived, which is a value coming back rather than a claim going
in. The call records the path on the run row, writes `matched` for every confirmed `check` row and a
`blocked` reading for each one the listing did not survive, and **leaves the run live** — a listing
settles nothing, which is the other half of what makes it safe to take early.

The fold is not in the tool module, `remoteReadings`' reason: it reaches the handler as
`deps.remoteListings` — `RemoteListingDesk`, injected from `src/system.ts` — so **the tool stays an
origin fence and a parse call**. The fence is the same narrow `remoteValidationOriginParts`: which
run a listing belongs to is settled **before** the listing rather than by it, and every other caller
is refused by name. A denominator for a run an agent was not sent on is not a denominator.

`state_declare` is this document's other tool, on nobody's run, and is **built** —
`src/mcp/tools/stateDeclare.ts`, in `MCP_TOOL_NAMES` and `buildTools`, classified `point-of-use`. Its fence is the **wide** kind,
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
listing and runner commands, the selectors for the confirmed rows, the tenant, the listing, report
and artefact directories, the deployed commit, and the rules of the run — that the listing is taken
first and answered with a path, that the report is the only thing that decides anything, that it must
not edit the suite, and that `blocked` is a right answer on either call. **The listing half is
appended only where the environment declares a `listSelectors` command**, and where it does not the
brief hands the confirmed rows' own selectors over as it always did. `validateEnvironments` refuses a
`browser` block that declares a `runner` without one ([Configuration](#configuration)), so that arm
is not a supported shape so much as the brief refusing to render a command nobody declared — and an
agent told to take a listing from a command that does not exist has one blocked call and no run.
Templates are operator-overridable and `loadPromptTemplates` rejects only _unknown_ placeholders, so an override
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
  desktop channel**, as `testPart`, computed there from `deps.environments` alone — what the bar asks
  for is prose, so the environments are the whole of what it needs. `plan_amend` accepts `coverage`
  because it spreads the same shape, so a discussion that was never handed the bar has the capability
  and not the invitation, and the one correction a person at their keyboard cannot make is the one
  that declares the coverage a goal turned out to need
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
| `agent`    | The fleet ran it unattended — the `validate-check` dispatch, or a sheet run driving the browser itself.                                                                               |
| `spec`     | **A reviewed spec ran against a real environment and its report said so.** Stronger than `agent` — no model read anything — and different from `operator`, because nobody watched it. |

Two rules govern what a run may write on a check row, and the second is the one a second
implementation would get wrong quietly:

- **A run writes onto the check row only where the current reading is `unrun`, or was one this
  instrument itself took.** A reading a person, an agent or a desktop session took is theirs;
  overwriting it with a spec's is the harness deciding it knows better than the person who watched the
  thing happen. The predicate is the instrument's **own** attribution and not "a machine took it": a
  script does not overwrite a spec's reading, a spec does not overwrite an agent's, and a driven row
  does not overwrite a spec's. Where the check is settled by somebody else, the row still runs and the
  reading still lands **on the sheet**, and the sheet says whose reading it is not replacing.
- **A `blocked` row writes nothing at all**, a `blocked` run's rule one level up: no reading was taken.

This is the one place [20](20-validation.md#states)'s "a result is declared, never derived" is worth
restating rather than assuming. A spec reading **is** declared — by a report, about a run of the
delivered goal, in a place somebody deployed. What is still refused, here as everywhere, is a result
inferred from a green build, a merged pull request or an absence of errors.

### The reading an agent produced

**Built.** A row the run's own agent drove records **`agent`** — the fleet, unattended — and never
`spec`. `foldRowOutcome` takes the instrument three-valued and `RemoteReadingDesk` picks it off the
check's steps; a screenshot-only row lands on the same word, which is the truth in both cases and makes
the two one hand for the overwrite rule above.

It is worth what `script` is worth and for the same reason: nothing reviewed it. What separates them is
that a script is a program somebody can read afterwards and this is an agent's afternoon — so the
transcript is the evidence, and the cockpit draws the way to it beside the reading.
`RemoteReadingView` carries `taskId` and `agentId`, walked on the server off the chain the store already
holds: a reading names its run, a run names the task it was dispatched as, and the task names the
agent. The cockpit is handed the agent's own id, because that is what opens a transcript and a surface
that had to walk two stores to draw the link would be a second copy of the join. Both are null on a
reading no run took — the press's deterministic rows — and on a run that never got an agent.

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
passes: assemble the sheets for arrivals nothing has assembled yet, run the approved deterministic rows
on a freshly assembled sheet, refresh what the bench row says, and sweep runs that have gone away.

**The desk spawns no browser command, on any path.** It had a fifth pass — the offering refresh, which
asked each browser runner what it offers on a thirty-minute clock so a planner could be shown the list
— and that pass is gone with the pick it existed for. Nothing in the harness invokes
`listSelectors`, `runner` or `publishArtefacts` now: all three are the run agent's, in its pinned
checkout. → [The cached offering](#the-cached-offering-is-a-convenience-and-the-pre-flight-is-the-authority)

**All four are built.** What runs is the assembly, the approved `state`,
`signal` and `measure` rows on a sheet it has just assembled, and — through `RemoteRunDesk`
([The press](#the-press)) rather than the pulse — the same rows again under a press's pin. **The
assembly pass spawns nothing**, and neither does any other pass: the listing a row is read against is the run's own, taken in its
pinned checkout ([The listing the run takes](#the-listing-is-taken-by-the-run-and-not-by-the-harness)),
and a sheet already assembled is never reassembled. Assembly keeps its cap of five per pass — it is
now a bound on sheet writes rather than on spawns, and the backlog drains in a fixed order. The bench line is refreshed by
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
  shortfall, no issue verdict, no `WorldEvent` and nothing in `watch_readings` — a `blocked` run's rule
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
  "remoteValidation": {
    "runTimeoutMs": 1800000,
    "tenantTimeoutMs": 3600000,
    "scriptGraceMs": 2592000000,
    "captureLinkBase": "https://lubbdubb.internal.example",
  },
}
```

`environments` is already `fileOnly` in `CONFIG_FIELDS`, which is right for this too: every field here
is a shell command the harness runs, which is a thing to write deliberately in a file rather than
beside twenty other rows. **No agent can write it** — nothing in `src/mcp/` touches config.

**The browser the run's agent drives is `localValidation.browser`, and there is no key here for it.**
One block, two dispatches ([the browser the run drives](#the-browser-the-run-drives)); it is **live**,
so an operator who configures one does not restart the harness to use it, and the brief reads it off
the running config each pulse. → [02](02-configuration.md), [32](32-local-validation.md#the-browser)

**Every command is declared in committed project config. Env vars carry parameters only.** A command
sourced from per-machine config moves the mechanism out of the half the project owns and makes what a
validation run actually executes unreviewable. The parameters are the tenant, the selectors and the
profile, and each rides in the spawn env: **never into the prompt, never into the cockpit, never into
a project layer that gets committed.**

`remoteValidation` is the one **new top-level key**, and it exists because 30 seconds — the kill every
other command in the harness gets — is the wrong number for a browser suite. It carries
`runTimeoutMs`, default 30 minutes, which was the kill for a **runner** invocation and now has **no
consumer**: the harness spawns no browser command, so there is nothing for it to kill — the suite runs
under the run agent's own stall park. It is left declared rather than withdrawn here, because removing
an operator-facing key is a change to the configuration surface and belongs in one of its own; it is
the one loose end this increment leaves. And `tenantTimeoutMs`,
default one hour, the kill for `ensureTenant` and `reseed`. Every other command, `state.run` included,
keeps the 30-second kill. And `captureLinkBase`, default **null** — the address this harness is
reachable at from wherever its tickets are read, used for the one link the harness posts somewhere it
cannot reach ([Posting the screen to the ticket](#posting-the-screen-to-the-ticket)). It is a key
rather than something derived because the harness does not know its own address: the only URL it can
name for itself is a loopback, and null posts the comment with no link rather than a broken one. The tenant commands get their own key rather than sharing the runner's
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
- a `browser` with a `runner` and **no `listSelectors`**, which leaves the run's own listing step with
  no command to take, so `matched` stays null and the rows block through the arm that null has always
  blocked through — the refusal names that step rather than the pre-flight it used to name
  ([The listing the run takes](#the-listing-is-taken-by-the-run-and-not-by-the-harness));
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
| `remote_runs`            | one press                     | **built.** conditional insert inside the transaction, unique on `(environment, tenant)` while live, with a partial unique index behind it; `task_id`, `report_path`, `listing_path` and `artefacts` written by the dispatch flip, the listing and the report                                                |
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

- **Every one of the eight tables declares a `ColumnMigrations` block, empty or not.** A table being
  new **once** does not keep it exempt, which is exactly what `local_runs`' usage columns and
  `validation_checks`' band cost ([14](14-persistence.md#migrations)). All eight are declared in
  `REMOTE_VALIDATION_COLUMNS` (`src/store/remoteValidation.ts`), and the entry is what the next column
  any of them takes is added to — which is what `remote_readings`' `started_sha` and `ended_sha`
  already are: a column on a table that was new **one release ago**, additive, guarded by
  `PRAGMA table_info`, and invisible without the entry on every database from before it existed. So
  are `remote_runs`' `task_id`, `report_path`, `listing_path` and `artefacts`, and
  `remote_readings`' `executed`, `retries`, `duration_ms` and `artefacts` — the same case a third
  time, on a table two releases old now, which is exactly what a table being new **once** does not
  exempt it from. None of them needs a backfill: a null on any of the four means _this reading was
  not taken through a report_, which is true of every reading written before the fold existed and
  stays true. `remote_runs.listing_path` is the newest of them and says the same kind of thing: null
  is _no listing was reported on this run_, true of every run written before the column and true
  afterwards of a run whose agent gave `blocked` instead of a path
  ([The listing the run takes](#the-listing-is-taken-by-the-run-and-not-by-the-harness)). There is
  nothing to compute it from and nothing it would be right to invent. A run's **status** is not one
  of them: it is a column _value_, and the vocabulary widening needed no migration
  ([the vocabulary](#a-runs-status-vocabulary)) — what it did need was the partial unique index
  dropped by name and re-declared, because `IF NOT EXISTS` never re-predicates one that is there.
- **`validation_checks.area` and `.expects` are columns nothing reads and nothing writes**, and they
  **stay declared** in `VALIDATION_COLUMNS` (`src/store/validation.ts`) exactly as they were. Both
  facts live on a `suite` step now
  ([How a check comes to have an area](#how-a-check-comes-to-have-an-area)), so the columns hold only
  what builds before that wrote on them. They are not dropped here, and the order of the boot passes
  is why: `rebuildTables` runs **before** `ensureColumns`, so a column dropped from the schema while
  still declared in `VALIDATION_COLUMNS` is added straight back on the next boot, and one dropped from
  both rebuilds the table on every boot for ever — losing whatever the copy list forgets. Retiring
  them is a separate change with its own review. **Nothing repairs them and nothing is backfilled**: a
  boot pass that recomputed a derived column would overwrite what a `suite` step named, on every boot,
  with nothing red.
  `remote_sheet_rows.matched` is the same case one table over, declared in
  `REMOTE_VALIDATION_COLUMNS` — a column on a table that was new one release ago, which is exactly
  what that entry exists for. **Its null changed meaning and still needs no backfill**, which is the
  one reading of [14](14-persistence.md#when-a-null-means-something)'s trap this document has to make
  explicitly. It used to mean _the pre-flight had nothing to ask about here_; it now means _the
  listing has not been taken for this row yet_, because the run's own listing is what writes it. No
  row is rewritten, because the two nulls fail in the **same direction**: `foldRowOutcome`'s
  `matched === null` arm already blocks, and a row nothing has listed for is exactly a row there is
  nothing to read a report against
  ([The runner contract](#the-report-is-the-only-source-of-row-outcomes)). A null whose new meaning
  failed the other way would need one.
- **A step's `expects` keeps its reading rule**, and it is not the area's rule repeated: no area named
  takes the row out of the runner's hands, where no expectation named must never be read as _expected
  nothing_. The second reading blocks every check whose author named none, so the difference against
  the listing is taken **only** where a step holds one, and an empty list normalises to null at both
  ends rather than being stored as an expectation of nothing
  ([An expected spec the runner does not offer](#an-expected-spec-the-runner-does-not-offer)).
- **`remote_readings.capture`** is the same case again, and the newest of them: a column on an
  existing table, additive, declared in `REMOTE_VALIDATION_COLUMNS` and guarded by `PRAGMA
table_info`. Null is _this row handed no screen back_, which is what every reading written before the
  column already was, so nothing is backfilled and its null does not change meaning
  ([Where a sheet-kept capture is looked at](#where-a-sheet-kept-capture-is-looked-at)).
  **`remote_capture_posts` is a new table**, and it declares an empty `ColumnMigrations` block like the
  seven before it — a table being new **once** is exactly what does not keep it exempt from the next
  column it takes.
- **`remote_sheet_rows.idle_reason`** is a column on an **existing** table and is **built**: declared
  in `REMOTE_VALIDATION_COLUMNS` beside `matched`, additive, guarded by `PRAGMA table_info`. Null is
  _a press reads this row_, which is what every row written before the column already was, so nothing
  is backfilled — and nothing recomputes it at boot either: it is folded where the sheet is assembled,
  by `sheetRows`, and a second author for that sentence is the same trap one subsystem over
  ([A row no press can read](#a-row-no-press-can-read)).
- **`remote_selector_offerings` is dropped**, in the three edits the retirement needs: the
  retired-tables list, the `CREATE TABLE IF NOT EXISTS`, and the `REMOTE_VALIDATION_COLUMNS` entry
  ([The cached offering](#the-cached-offering-is-a-convenience-and-the-pre-flight-is-the-authority)).
  It held no verdict and no reading, only what a runner last said, and nothing reads it now.
- **`plan_parts.coverage`** is the same case one table over, and is **built**: declared in
  `PLAN_COLUMNS` (`src/store/plans.ts`), with its `ALTER TABLE` guarded by `PRAGMA table_info` like
  every other entry there.
- **`goal_arrivals.sheeted_at`** is the same case again, and is **built**: declared in
  `ENVIRONMENT_COLUMNS` (`src/store/environments.ts`) beside `watched_at`, with its `ALTER TABLE`
  guarded by `PRAGMA table_info` like every other entry there.
- **No backfill is needed, and each for a stated reason rather than by luck.** A check with no steps
  names no area and no expectation, which is exactly what it always meant, and `plan_parts.coverage`
  null the same. Nothing is repaired at boot, and that is the point: a pass that recomputed a derived
  value would overwrite what a `suite` step named, on every boot, with nothing red
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

| Seam                                                  | Implementations                                          | Covers                                     |
| ----------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------ |
| `EnvironmentProber` (existing)                        | `CommandEnvironmentProber` · `FakeEnvironmentProber`     | `at`, for the pin                          |
| `EnvironmentObserver` (existing)                      | `CommandEnvironmentObserver` · `FakeEnvironmentObserver` | `observe`, for `signal` and `measure` rows |
| `StateReader` (`src/remoteValidation/stateReader.ts`) | `CommandStateReader` · `FakeStateReader` — **built**     | `state.run`                                |
| `TenantKeeper` (`src/remoteValidation/tenants.ts`)    | `CommandTenantKeeper` · `FakeTenantKeeper` — **built**   | `ensureTenant`, `reseed`                   |

**The harness spawns none of the three browser commands, and there is no seam for them.** `runner`,
`publishArtefacts` and `listSelectors` are all invoked by the run agent in its own shell, from its
pinned checkout; the harness parses the file the agent points it at and spawns nothing to get it
([The listing the run takes](#the-listing-is-taken-by-the-run-and-not-by-the-harness)). So
`RemoteRunner`, `CommandRemoteRunner` and `FakeRemoteRunner` are deleted with the offering refresh that
was their last production caller, and `buildSystem` takes no `remoteRunner`. `parseSelectorListing`
and `selectorFault` stay in `src/remoteValidation/runner.ts` — the run's listing is read through the
first and an area is guarded by the second — and so does `SELECTOR_DELIMITER`, which the briefing joins
the selectors on and `selectorFault` refuses an area for holding. A test no longer needs a runner fake;
it still needs `FakeStateReader` and `FakeTenantKeeper`, which are about commands the harness **does**
spawn, and the `CLAUDE.md` entry naming a browser fake is withdrawn because it names something that no
longer exists.

Three rules hold them honest:

- **Tests build a whole `System`** via `buildSystem(config, opts)` with the fakes injected and
  `dbPath: ':memory:'` ([19](19-development.md)). The two remaining seams are `opts` keys —
  `stateReader`, `tenants` — beside `backend`, `streamSpawner`, `sink`, `gitObserver`,
  `worktrees` and `errorMirror`. Both are built, each defaulting to its command implementation. **A
  test that configures a `validate` block and injects no `tenants` is the same hazard `stateReader`'s
  absence is**, and both are in `CLAUDE.md` for that reason. There was a third, `remoteRunner`, and the
  `CLAUDE.md` entry that named it is **withdrawn in the same change** the seam is: a sharp edge that is
  no longer real is the stale-documentation failure that file opens by warning about.
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

**The card** is `remoteValidation` in `GOAL_SECTIONS` — its own full-width card rather than a band
inside the Environments card, `LocalValidationSection`'s argument for its reason: this card carries
**controls and a press**, and a control buried two levels inside a status card is a control nobody
finds.

**It is drawn behind the Validate pane, beneath the check set and the local run**
([17](17-cockpit.md#the-panes)). The three are one obligation seen at three distances rather than
three sets of tests: a `check` row on a sheet carries a check's `sourceId`, and the run's outcome is
written back onto that check as `resultBy: 'spec'`. A pane that held the set and a pane that held the
sheet would be one list drawn twice, with an operator asked which copy to believe. The order on the
pane is the order the questions are asked in: what must be true (the set), what a person or a local
run answered by hand (the local plan), and what the environment's own run answered (this). The tab is
qualified by whichever environment declares `arrival.opens: 'validate'` — which is the same
environment this sheet is put to.

**The card is absent entirely where no environment declares a `validate` block**, and absent on a
goal with no sheet — not an empty card, and not a row of question marks. That is the rule the
Environments card and the Signals card are both built to, and it is what keeps a deployment that has
not turned this on from reading as a deployment where it is broken.

It draws one block per environment that has a sheet: the tenant and its age against the declared
freshness window, the deployed commit, every row with its kind, its outcome and its reason, the
artefact link on a browser row, **the screen a row handed back**, matched-versus-executed and retries
and wall-clock, the selector
mismatches the run's own listing found, and the four controls the gate is made of — approve a query on its
dry run, deselect a row, reseed, press go. A row waived through the check's own control draws its
reason and does not run. **An `unknown` from a query and a `blocked` row say why in words**, and never
in the vocabulary of a clean one.

**The Environments card's row gains one folded line** — `check plan · 4 checks · 1 failed · 1 blocked`,
each clause drawn only where it is non-zero — folded on the **server** off the same rows the card
above draws. A cockpit that worked it out for itself would be a second opinion drawn beside the
reading it describes, which is the disagreement the fold exists to prevent. The line says _check
plan_ and _checks_ because that is the cockpit's one word for each
([17](17-cockpit.md#one-noun-per-thing)); what the store calls them is unchanged. **Built**, as
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
  than a harness reference, drawn in a `cn-refs` group beside the row and never as a control. The way
  into the agent that ran a row is not a reference either: a transcript is opened by selecting the
  agent, which is `actions.select`, drawn the way a plan part's door is drawn. A
  later surface that does name a goal or a pull request draws it with `<Ref/>`.
  → [17](17-cockpit.md#links)
- **Which environment's sheet am I looking at is a field on `Place`** (`web/src/cockpit/place.ts`),
  never a `useState` in `useCockpit`. The cockpit's place is the query string, and state held outside
  it breaks on the back button and on reload. → [17](17-cockpit.md#the-address-bar)

**A sheet row draws its own capture.** A `captured` row asks for exactly one thing — somebody's eyes —
and until the reading carried the file name, a run that declined to overwrite a check somebody else had
settled left the image reachable nowhere but the harness's own disk. The row draws it the way the check
row does: an inline thumbnail, clicking through to full size, off
`RemoteReadingView.captureUrl` — which the **server** mints, keyed on the run and the row rather than on
the check. A cockpit that assembled the path itself would be a second opinion about where a goal's
validation directory is. → [Where a sheet-kept capture is looked at](#where-a-sheet-kept-capture-is-looked-at),
[17](17-cockpit.md#a-sheet-row-draws-its-own-capture)

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
an operator finds out the sheet holds a finding the goal's check does not, and including the row's
`idleReason` where a press will read nothing on it at all
([A row no press can read](#a-row-no-press-can-read)). The press control's count is the rows a press
will **actually** read or dispatch for, not the rows selected. Under each browser row
sits what the run cost and what it produced: **executed of matched**, retries where there were any,
wall-clock, a link to the runner's own report, and the way into the **agent that ran it**. That last
one is there for the reading an agent produced most of all: a row a reviewed suite answered is backed
by code in the repository, and a row the fleet drove at a browser is backed by nothing but what the
agent did, so the record of what it did is the evidence
([the reading an agent produced](#the-reading-an-agent-produced)). It is drawn beside the report link
and at the same weight — the row's own title is what the reader came for.

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

The authoring gate on assembly is asserted in `test/validationAuthoring.test.ts`, in the order the
cuts run: a fresh arrival whose goal has no check set is deferred and left unstamped, the same
arrival assembles once the set is authored, and an arrival older than the freshness guard is stamped
without a sheet whether or not anything has been authored — which is the arm that keeps the backfill
guard intact.

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

What the harness does **not** spawn is asserted in `test/remoteValidationRunner.test.ts`, which is now
about the parser, the delimiter and the silence: `parseSelectorListing` reads a listing as areas, never
reads an empty print as an offering of nothing, seeks a JSON array behind a banner and **refuses** prose
rather than guessing at it; an area holding the list's own delimiter blocks its row at assembly, which
is a `blockedReason` and not a listing verdict; seven sheets assemble over two passes, five to a pass,
with **no `matched` and no `blockedReason`** written on any of them and the rows left pressable; and a
database carrying `remote_selector_offerings` **loses it on the boot that takes the build**, with a
second boot a no-op rather than a second drop — the three-edit retirement asserted where it can fail
silently. The parameters of a run are asserted where they are now written, in the briefing
(`test/remoteValidationDispatch.test.ts`): they ride in the environment and the command names none of
them. The four arms a listing blocks on are asserted where they live, against the **run's** listing
(`test/remoteValidationListing.test.ts`) and against `preflightRows` directly
(`test/validationExpects.test.ts`), which also asserts the shape this increment has to get right: a
row carrying the old `area` and `expects` columns and **no steps** declares no area, is asked nothing
of a listing, and has neither column rewritten nor cleared on the boot that read it.

`test/planCoverageArea.test.ts` covers the join: the test-part bar asks for the coverage **in words**
and names no listing to copy from, asserted in both directions so a reword cannot quietly put a pick
back; a `coverage` naming anything at all is accepted through both plan transports, which is the arm
a genuinely new area could not get through before; a `suite` step names the area and reading the check back gives it, while
a `covers` entry gives nothing; an area on any other step kind is refused where it is authored, as is
a `suite` step naming none; the first `suite` step wins, so a check is still verified against one
selector; and with the area named the sheet's check row confirms, carries **no** denominator from
assembly and yields a selector for the run to carry — the whole of what the browser half was missing.
It also covers the retirement of the pick: the desk run twice keeps **no** offering and the table is
gone from the database, and the note handed to the planner names the step kinds the deployment can
carry and **no area to copy**, asserted in both directions so a reword cannot put a pick back.
The row a press cannot read is covered in `test/remoteValidationSheet.test.ts`: a check with an `area`
in the old column and **no steps** carries the sentence and **no `blockedReason`**, and the sentence
names the three step kinds that would carry it; a check whose plan names a `suite` area carries no
sentence at all, exactly as before; a check whose every step is a person's carries the first step's own
`why`, naming the `validate.browser` block; and the pressable count — selected, unblocked, no sentence —
is **zero** for the first of them, which is what keeps "Run N rows" honest.
`test/validationSteps.test.ts` covers the assignment, the segment boundary and the plan.

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
`artefacts` and `blocked` with an extra key rejected, and the name absent from
`MCP_PROTOCOL_ADDENDUM` and `DESKTOP_TOOL_NAMES`; a report recording both locations on the run row and
settling it, readably afterwards; a **`blocked`** answer settling it with the agent's reason, writing no
readings and leaving every sheet row and every check exactly as it was; the field's own withdrawn name,
`handback`, refused with a message naming `blocked` rather than as an unrecognised key; and a withdrawn
tool name answered from `RETIRED_TOOL_NAMES` rather than as an unknown method.

The browser half is asserted in the same file, `test/localValidation.test.ts`'s shape mirrored: the
server rides the dispatch with **this run's** artefact directory and **this environment's** profile
substituted and no token left standing; the profile is per environment and is **not** the local
validation's, which is a browser that would refuse to start whenever a local validation was up; the
`mcp__browser` grant is **appended** to the fleet's rather than replacing them, in one `--mcp-config`;
the prompt offers the browser as a claim to check and says `blocked` and **not `failed`** where it will
not start; with `localValidation.browser` null the dispatch carries **no** server and the prompt says
there is no browser rather than leaving the agent to find out. And the driven check: one whose plan is a
`browser` step the fleet carries is **counted at the press** — `runnableDrives` answering where
`runnableSelectors` and `runnableScripts` answer nothing, which is what keeps the run from settling with
it owed — and briefed under its own heading with the word its reading is worth; the same check on an
environment with **no tenant** is `blocked` **naming the three declarations** and never an invented
name; and with no `validate.browser` block anywhere `resolveSteps` gives the step back to a person
naming the block, where nothing counts it at all.

The reading half is built and its tests are in `test/remoteValidationReadings.test.ts` and
`test/remoteValidationCockpit.test.ts`, with `test/remoteValidationOff.test.ts` extended a fourth
time: **the exit code is never read**, asserted twice — a non-zero invocation over a report full of
passes yields passes, and a clean one over a report full of failures yields failures, neither of which
the harness could read a code from in any case now that the invocation is the agent's; a selector the report names **no** test under is `blocked`, never `passed`;
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

The reading an agent produced is asserted in the same two files: a driven row records **`agent` and not
`spec`**; one that reported nothing under its own id is `blocked` rather than a quiet pass; an agent's
reading and a spec's do not overwrite each other **in either direction**, while a second driven run
replaces its own instrument's reading, which is the one case it may; and on the wire the reading carries
the `taskId` and the `agentId` that open the transcript, **null** on a reading no run took rather than
an id borrowed from another run.

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
