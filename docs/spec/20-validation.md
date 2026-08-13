# 20 — Validation

`src/validation/`. On by default (`validation.enabled: true`); off leaves the surface out entirely —
no checks are ingested, the plan sheet draws no section, no goal is ever flagged, and behaviour is
exactly what it is without validation.

A plan says what is wrong, what will be done, and what makes each part done. It does not say **how
anyone checks the goal was met**. `verification` — one optional narrative field, "how anyone will
know the whole thing worked" ([08](08-planning.md)) — is read once while deciding whether to approve,
and nothing ever runs it. This is that field's executable form: an ordered set of **checks**, each
with a procedure, an expectation and the resources it needs, that a person runs and marks off.

## What it is not

Stated first, because each boundary is a thing the harness already does and would otherwise be
re-litigated:

| Not                 | Because                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A test suite        | `npm run check` runs on every branch. This is the layer above: checks needing a running harness, a real environment, a browser, or a person. |
| Acceptance criteria | Those are per **part**, ticked by a reviewer reading a diff ([08](08-planning.md)). A check is executed against the delivered goal.          |
| CI                  | Nothing here gates a merge, and **no result is ever inferred from a build**.                                                                 |
| A credential store  | `validationRoot` holds fixtures and reference material. Which account a check needs is a note; the account stays where it is.                |
| A blocker           | Nothing a check says holds a dispatch, a merge, a conclusion or a close. It changes what closing a goal _looks like_, and nothing else.      |

## The check

One row per check, keyed on `(plan, id)` — `src/store/validation.ts`.

| Field            | What it is                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `id`             | Author-chosen kebab-case slug. **The merge key** — an amendment merges on it, so it must survive.   |
| `letter`         | `A`, `B`, `C`… — the human-typeable handle. Assigned at ingestion. See below.                       |
| `title`          | One line, the headline.                                                                             |
| `do`             | The procedure, markdown.                                                                            |
| `expect`         | What a pass looks like.                                                                             |
| `uses`           | Resource **names**, not paths.                                                                      |
| `covers`         | Part slugs this check exercises. Optional, any number.                                              |
| `fleetCandidate` | The planner's nomination that an agent could run this, with `candidateWhy`. **Dispatches nothing.** |
| `state`          | Below.                                                                                              |

### States

`unrun` → `passed` | `failed`, plus `waived` and `deferred`, and one way back to `unrun` from any of
them.

Every transition carries a **required note**, and the note is the check's one current reading:
`recordValidationResult` writes the whole set together and clears what the last reading left behind,
so a check cannot render "passed — the test environment is rebuilt on Thursday". A result is
recorded on the row rather than appended to a table for `note_progress`'s reason — the audit trail
already exists in the record beside it, and exactly one current reading is what anything asks for.

**A result is declared, never derived.** Nothing infers a pass from a green build, a merged pull
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

## The document block

`src/validation/checkDocument.ts`. Additive and **optional** on the plan document, for the reason
every post-v1 field is: an older plan, and an operator override that never learned it, must keep
validating. Read on both verdicts — a goal delivered as one pull request needs validating exactly as
much as a decomposed one.

```json
{
  "validation": {
    "resources": [
      { "name": "fixture-repo.tar.gz", "kind": "fixture", "note": "seeded repo, one PR by another author" },
      { "name": "test-env login", "kind": "access", "provided": false }
    ],
    "checks": [
      {
        "id": "merged-branch-gone",
        "title": "A squash-merged part branch is gone on both sides",
        "do": "Run the harness against the fixture repo, merge the seeded PR…",
        "expect": "No issue/284/reap ref, locally or on the remote.",
        "uses": ["fixture-repo.tar.gz"],
        "covers": ["reap-writer"],
        "fleetCandidate": true,
        "why": "reads the repo and runs git; needs no login and no browser"
      }
    ]
  }
}
```

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

**Nobody but a person, today.** Every check is the operator's, and the planner cannot say otherwise.
`fleetCandidate` is a nomination — it draws a chip and dispatches nothing.

The reason is not caution about agents, it is what the planner can know. The fleet runs in `stream`
mode: no terminal, no browser, no interactive login, and no account on whatever environment this
deployment tests against. A planner reading the repository can know none of that, and a wrong guess
is a check sitting dispatched against a login the fleet does not have. So the nomination is
information for the person deciding, and the deciding stays with them.

### `covers`, and what one optional field buys

Validation is **goal-level**, not per part — a check usually spans parts, and the question it answers
is whether the goal works. `covers` does not change that; it only lets a check say which parts it
exercises, which is what lets a reader see which parts nothing checks. An absent check looks exactly
like a check that passed until someone counts.

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
for the life of the launch — whether or not `validation.enabled`, because a grant that came and went
with a policy flag would make an agent's readable set depend on config it cannot see. That is a real
widening, and it is the same one attachments already make.

A resource declared `"provided": false` is the planner saying it needs something it cannot produce: a
reference screenshot, an account, a sample file from a colleague. Ingestion files a `human_tasks` row
asking for it ([13](13-jobs-and-findings.md)), so a missing resource is an ask rather than a check
that mysteriously never runs. `recordHumanTask` refreshes on a repeat and the task id is carried
across by name, so a replan re-declaring the same resource does not file it twice.

## Amendment

A validation plan written at planning time is written by the one agent that has **not done the work
yet**. A planner reading the repository writes a check against the code it expects to exist, and by
the second part that check may describe a screen that moved, a command that was renamed, or a
behaviour the plan decided against. A check set that cannot change is therefore worse than none: a
stale check that fails reads as a broken goal.

Two writers fold a change onto the rows, and the difference between them is load-bearing:

|          | `ingestValidation` (a plan document)        | `amendValidation` (`validation_amend`)      |
| -------- | -------------------------------------------- | --------------------------------------------- |
| Speaks for | The **whole** check set                    | Only the checks it names                      |
| Omission | A withdrawal                                 | Nothing at all                                |
| Written by | The planner, through `plan_submit` or `plan.json` | Any agent working the goal              |
| Withdrawal | By silence                                 | Said out loud, with a reason                  |

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

**The planner is the one refusal, and by name**: it already has a transport that declares the entire
block, and two ways to say one thing that disagree about what an omission means is the drift the
split exists to prevent.

Two shapes are refused for reasons that are not the caller's fault, and say so plainly:
`validation.enabled` off, and a goal with **no plan** — the checks hang off the plan row, so a
deployment running without the planning funnel has nowhere to put one.

### The band

An amendment leaves the check carrying `amendedAt`, the amender's `amendNote`, and — when it
reworded rather than added — a `revision` holding what the check used to say and the reading that was
withdrawn with it. That is the executable form of "you are told when the plan changes", and it is
the half that makes correctability safe: a check quietly rewritten under an operator who already ran
it is worse than one that cannot change at all, because they would go on believing they had checked
something the plan no longer asks for.

| Case                             | `amendedAt` | `revision` |
| -------------------------------- | ----------- | ---------- |
| A plan's **first** check set     | unset       | null       |
| Added by an amendment            | set         | null       |
| Reworded, check was `unrun`      | set         | `state: null` |
| Reworded over a recorded reading | set         | the wording and the withdrawn reading |
| Re-declared word for word        | carried, never cleared | carried |

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
changes four readings:

- **The close-out obligation** (`closeOutDetail`) states the counts and lists what is outstanding
  with its reasons. That is the moment: the row that says "close this ticket" is where an operator is
  about to close a goal and move on, and `recordHumanTask` refreshes the detail every pulse, so it
  states what is outstanding now rather than when it was filed.
- **`POST /api/human-tasks/:id/done` on a `close_out` task refuses without a note**, and the note goes
  on the row. Only that kind, only while open, only when flagged — asking a note of somebody ticking
  off "plug the cable in" is the friction that gets the whole flag ignored. The harness's own
  settlement, when it observes the ticket closed, is unaffected: that is not an operator deciding to
  move on, and a guard in the store would either stop the sweep or make its resolution the excuse.
- **`POST /api/issues/:number/dismiss-run` refuses without a note**, kept on the run as
  `dismissNote`. The sharper of the two, because this is the button that ends the harness's run at a
  goal and it is one-way.
- **The plan's status comment** carries the checklist, open rather than folded — a reader of the
  ticket next month is trying to find out whether it was checked, and that reader is not on the
  operator's machine.

The discipline the two notes borrow is `/api/human-tasks/:id/decline`'s, for its reason: there must
be no way out that costs nothing to say.

## Routes

`src/server/routes/validation.ts`, a module and a `ROUTE_MODULES` entry — `app.ts` stays wiring only
([16](16-http-api.md)). Every handler is wrapped in `checked(schemas, handler)`; a refusal is a
returned value, never a throw.

| Route                                            | Does                                     |
| ------------------------------------------------ | ---------------------------------------- |
| `POST /api/plans/:id/validation/:checkId/result` | `{result: passed｜failed, note}`.        |
| `POST /api/plans/:id/validation/:checkId/defer`  | `{reason, until?}`.                      |
| `POST /api/plans/:id/validation/:checkId/waive`  | `{reason}`.                              |
| `POST /api/plans/:id/validation/:checkId/reset`  | Back to `unrun`; the undo for all three. |

`:checkId` is the check's id, never its letter — the letter is what a person types, the id is what
the store is keyed on. A check whose plan has superseded it answers **409**, not 404: the commonest
cause is not a typo but an amendment landing between the sheet being drawn and the click.

**No route here runs a cycle.** Nothing schedules work, so a pulse per checkbox would be the cost of
saying nothing.

## Persistence

`src/store/validation.ts`, the only module touching these tables, taking a `StoreContext` and
delegated to under the same method names ([14](14-persistence.md#shape)).

- **`validation_checks`** — `plan_id`, `id`, `letter`, `seq`, `title`, `check_do`, `check_expect`,
  `uses`, `covers`, `fleet_candidate`, `candidate_why`, `state`, `result_note`, `result_by`,
  `result_at`, `defer_until`, `superseded_reason`, `created_at`, `updated_at`. `check_do` rather than
  `do` because DO is a SQLite keyword; `check_expect` follows it so the pair reads as a pair.
  `revision` is JSON — the wording an amendment replaced and the reading it withdrew, kept as one
  record because it is read as one.
- **`validation_resources`** — `plan_id`, `name`, `kind`, `note`, `provided`, `human_task_id`.

Both tables shipped as fresh `CREATE TABLE`s and both declared an **empty `ColumnMigrations`
anyway**, on the argument that a table being new once does not keep it exempt. The band collected
that debt one change later: `revision`, `amended_at` and `amend_note` have real entries, and without
them every database from before `validation_amend` would have read `undefined` for all three and
silently drawn no band at all ([14](14-persistence.md#migrations)). `issue_runs` gained
`dismiss_note` the same way.

## The cockpit

The plan sheet gains a **Validation** section (`web/src/components/ValidationSection.tsx`) between the
parts and the caveats, with a rail entry carrying the settled count — the reading order is answer,
then work, then how anyone knows it worked. Each row draws its letter in the gutter where a part's
sequence number sits, because it is the same kind of handle.

Every control writes an operator's reading and derives nothing: there is no "mark all", and no state
is inferred from a merged part or a green build. Superseded checks are drawn folded, as the record of
what a plan withdrew — a section that filtered them would leave a reader unable to tell a check that
was dropped from one that was never written. The goal page carries the verdict as a chip beside the
assay and the conclusion, inside neither.

## Tests

`test/validation.test.ts` (the schema's refusals, letters, and what an amendment may do to a check
somebody has run), `test/validationFlag.test.ts` (the verdict, the close-out obligation, the two
notes, and that a flagged goal still blocks nothing), and `test/validationAmend.test.ts` (the
tool: who may amend, that an amendment withdraws nothing by omission, what a rewording costs, and
the band).

The verdict tests assert **both** directions, `planApproval.test.ts`'s discipline: a verdict that
counts `deferred` as clear and one that does not are one edit apart, and only one of them is honest.
The amendment tests do the same with the rewording rule, which has the same shape: a check whose
wording changed loses the result, and one re-declared word for word keeps it.
