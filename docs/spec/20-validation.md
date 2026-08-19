# 20 — Validation

`src/validation/`. **Always on** — there is no switch. It spends no agent and gates nothing, so there
was never much to weigh in turning it off, and the cost of the switch was a branch at every call site
that read it plus a `validationEnabled` threaded through four layers to say "yes". A config file
still setting `validation.enabled` is warned about and ignored
([02](02-configuration.md#retired-keys)).

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

**Nothing enforces this.** It is stated where the writing happens — the `issue-plan` and
`issue-replan` prompts, and the `validation_amend` tool's description — and not in `ValidationSchema`,
because a schema that recognised a test-suite check by its words would refuse the legitimate one that
runs a suite _inside a fixture repository_ — the shape of the example in
[The document block](#the-document-block). The bar is about what is worth writing, and worth is not a
thing zod can parse.

## The check

One row per check, keyed on `(goal, id)` — the goal's `origin_ref` (`issue:<n>`), `src/store/validation.ts`.

**Keyed on the goal, not the plan**, which is what this document has said validation _is_ since the
first line of it. A plan is 1:1 with a goal, which is what let `plan_id` stand in for the goal for two
changes; it was the wrong key wearing the right key's clothes, and it got more expensive to change
with every check row recorded against it. A check outlives any one plan of the work, and nothing about
it is a property of the decomposition. Databases written under the old key are rebuilt onto the new
one at boot, `id` and `letter` untouched
([14](14-persistence.md#rebuilding-a-table-whose-key-changed)).

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
| `actor`          | `human` or `fleet` — who is expected to run it. **The operator's decision and only theirs.**        |
| `handbackNote`   | Why the fleet gave it back. Null until it does, and cleared by the next reading.                    |
| `state`          | Below.                                                                                              |

### States

`unrun` → `passed` | `failed`, plus `waived` and `deferred`, and one way back to `unrun` from any of
them.

Every transition carries a **required note**, and the note is the check's one current reading:
`recordValidationResult` writes the whole set together and clears what the last reading left behind,
so a check cannot render "passed — the test environment is rebuilt on Thursday". A result is
recorded on the row rather than appended to a table for `note_progress`'s reason — the audit trail
already exists in the record beside it, and exactly one current reading is what anything asks for.

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
asks and against the same gate ([13](13-jobs-and-findings.md#the-other-step-after-the-launch-the-validation)).
It states what is outstanding through the same `outstandingChecks` the close-out reads, refreshed
every pulse, so the bench row and the obligation beneath it cannot disagree about what a goal owes.

**It blocks nothing**, which is the table at the top of this document holding: the row gates no
dispatch, no merge, no conclusion and no close, and no rule reads it. What changes is that running
the checks is an obligation with a place to sit rather than a thing somebody remembers.

A check handed to the fleet is **not** on it — rule `validate-check` is about to dispatch that one —
and a hand-back puts it straight back, carrying the agent's reason. The row settles itself the moment
nothing is left for a person, on the close-out's asymmetry: these are rows the harness reads every
pulse, so asking the operator to tick off a second copy of what they have just recorded is asking
them to tell it something it can see.

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

A resource declared `"provided": false` is the planner saying it needs something it cannot produce: a
reference screenshot, an account, a sample file from a colleague. A `human_tasks` row asks for it
([13](13-jobs-and-findings.md)), so a missing resource is an ask rather than a check that mysteriously
never runs.

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

A validation plan written at planning time is written by the one agent that has **not done the work
yet**. A planner reading the repository writes a check against the code it expects to exist, and by
the second part that check may describe a screen that moved, a command that was renamed, or a
behaviour the plan decided against. A check set that cannot change is therefore worse than none: a
stale check that fails reads as a broken goal.

Two writers fold a change onto the rows, and the difference between them is load-bearing:

|            | `ingestValidation` (a plan document)              | `amendValidation` (`validation_amend`) |
| ---------- | ------------------------------------------------- | -------------------------------------- |
| Speaks for | The **whole** check set                           | Only the checks it names               |
| Omission   | A withdrawal                                      | Nothing at all                         |
| Written by | The planner, through `plan_submit` or `plan.json` | Any agent working the goal             |
| Withdrawal | By silence                                        | Said out loud, with a reason           |

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

**It is last of every rule**, below one-shot pickup, and that is load-bearing rather than tidy.
Validation's standing promise is that it blocks nothing; a rule that could take the final slot from a
blocked part or a red build would make the one feature that gates nothing the reason something else
did not run. Ranked last, a handed-over check gets the headroom nothing else wanted and queues as
`waiting` when there is none.

**It fails open and silent**, `issue-retro`'s rule and more cheaply: a crashed or capped agent leaves
the check exactly as it was, `unrun` and still flagged, with no escalation. The flag is already the
ask — a second inbox item would put the same question to the same person twice.

### `validation_report`

`src/validation/report.ts` (pure) and `src/mcp/tools/validationReport.ts`. Takes a `result` and a
required `note`. **The check is not an argument**: it is on the origin, one check per dispatch, so
which check a report concerns is decided by what the agent was sent to do.

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
| `handback` | `actor` back to `human`, the reason, **no reading** | The third answer, and the reason there are three.          |

**Why there is a third answer.** An agent that could not reach the environment has learned nothing
about the goal. With only `passed` and `failed` available its options are a lie and silence, and both
are worse than the truth: `failed` flags the goal for a reason that has nothing to do with the code,
and silence leaves an `unrun` check with no account of itself. A hand-back leaves the state exactly
as it was and carries the agent's reason to the operator, where it is usually the one sentence saying
what a person can do that an agent could not. The next dispatch is handed that reason too, so a
re-hand-over does not rediscover the same wall and spend an attempt saying so.

**`resultBy` is drawn wherever the reading is** — the cockpit row, and `_(recorded by an agent)_` on
the ticket comment. "An agent says this passed" and "I ran it and it passed" are different facts, and
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
it. Handing the check over again clears it too, since leaving the old reason beside a check now in
flight would describe the wrong attempt.

Off the cockpit, `outstandingChecks` says which of the two a check is in — `(handed to the fleet)` or
`(the fleet handed this back — …)`. Without them both render as a bare `unrun`, which is the same
word for "nobody has got to it", "an agent is about to" and "an agent tried and could not".

## The desktop channel

A check that needs a browser, a login and a real environment is a check the fleet cannot run — and
`handback` is the honest answer to it, not a fix. The fix is that the operator's **own** Claude Code
can run it, on the machine that has all three, and report the reading onto the same row.

So the harness listens on a second MCP socket (`src/mcp/desktop.ts`,
[11](11-mcp-tools.md#the-desktop-channel)) that the operator registers in Claude Code **once**. Off
by default (`validation.desktop`), because unlike everything else in this document it has a footprint
outside the harness: a credential in a home directory, a skill installed into their Claude Code, and
a socket at a fixed path.

### The three tools

`validation_read` a goal's plan, `validation_claim` the one check you are going to run,
`validation_report` what you saw. Three and no more, and narrowed by construction rather than by a
filter over the fleet's set — this credential is long-lived and lives in a home directory, so the
guarantee has to be that there is no code path from a desktop connection to `conclude_work` at all,
not that a list is currently short.

`validation_report` exists in both channels and is two tools sharing one schema, one set of store
writes and one hand-back wording. What differs is where the check comes from: the fleet's from the
origin it was dispatched on, the desktop's from what the session claimed. Both are the same rule —
**which check a report is about is settled before the report rather than by it.**

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
exists, and the amber band is now in front of the operator saying so.

### What a desktop reading is worth

`result_by` is `desktop`, which is neither of the other two and says so wherever the reading is
drawn. `operator` means a person carried the steps out — what a validation checklist already means,
which is why it is the one that draws no marker. `agent` means the fleet ran it unattended. `desktop`
means the operator's own Claude ran it at their keyboard: stronger than the fleet's, because it
reached the real environment, and weaker than a person's, because no person did the steps. A reader
deciding whether to re-run a check before closing a goal is deciding on exactly that difference.

### The skill

`/lubbdubb 284:C`. Installed to `validation.desktopSkillPath` when the channel starts, from
`DESKTOP_SKILL` in `src/validation/desktopSkill.ts` — a string in a `.ts` module rather than a `.md`
asset, the prompt templates' reason: the build emits `.ts` and nothing copies a stray `.md` into
`dist`, so an asset works in development and is missing in a deployment. There is no second copy
under `docs/` for the same reason: one of them would be the stale one.

The skill is the interface, not a convenience. Without it the operator types the same six sentences
at their Claude every time — which is the friction the whole channel exists to remove, and the reason
the bench design was rejected. It says what the three answers mean, that `handback` is a right
answer, and the two things a session with the repository open is most able to do wrong: report
`passed` from evidence it did not gather, and change code to make a check pass. Everything about
_how_ to run a given check comes back from the tools, which read the live plan; a skill that restated
any of it would be a second copy of the procedure, drifting.

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

So an unrun check draws **Copy desktop prompt** beside the fleet hand-over, which copies
`/lubbdubb <issue>:<letter>` — `desktopPrompt` in `web/src/components/ValidationSection.tsx`. It
records nothing, claims nothing and reaches no socket; it is one string on a clipboard, and the run
begins when that string is pasted. Two properties, both asserted in
`test/validationDesktopPrompt.test.ts`:

- **The address is the goal's number and the check's stored letter**, which is the pair the skill
  resolves a check by. Derived from a row's position it would render correctly and address a
  different check after the next amendment — the failure [the letter](#the-letter-is-assigned-never-positional)
  exists to prevent, one layer up.
- **The command is in the button's title as well as on the clipboard.** A clipboard write can be
  refused, and a command living only in a click handler leaves an operator with a button that did
  nothing and nothing to type instead.

It is offered on every unrun check rather than only a nominated one, the hand-over's rule for the
hand-over's reason: `fleetCandidate` is an argument about the fleet and says nothing about the
machine the operator is sitting at.

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
- **`POST /api/issues/:number/dismiss-run` refuses without a note**, kept on the run as
  `dismissNote`. The sharper of the two, because this is the button that ends the harness's run at a
  goal and it is one-way.
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

| Route                                                   | Does                                               |
| ------------------------------------------------------- | -------------------------------------------------- |
| `POST /api/issues/:number/validation/:checkId/result`   | `{result: passed｜failed, note}`.                  |
| `POST /api/issues/:number/validation/:checkId/defer`    | `{reason, until?}`.                                |
| `POST /api/issues/:number/validation/:checkId/waive`    | `{reason}`.                                        |
| `POST /api/issues/:number/validation/:checkId/reset`    | Back to `unrun`; the undo for all three.           |
| `POST /api/issues/:number/validation/:checkId/handover` | `{to: fleet｜human}` — the only writer of `actor`. |

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

`result_by` needed no migration when it gained `agent`, nor again when it gained `desktop` — the
column existed and only gained values it may hold. `rowToCheck`
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

The **plan sheet** keeps a read-only `ValidationDigest` between the parts and the caveats, with a rail
entry carrying the settled count — the reading order is answer, then work, then how anyone knows it
worked. A plan under review has to show what it proposes to check; it just offers no verb, and points
at the goal instead. → [17](17-cockpit.md#the-validation-digest)

Three markers say who, and each exists because its absence would be read as something else: **with
the fleet** on a handed-over check, **running at ‹label›** while a desktop session holds a **live**
claim (the timestamp on the hover; an expired claim is not shipped at all, so the chip and the fleet
list's keyboard entry go together), and beside a reading, **recorded by an agent** or **recorded from
a desktop session**. A reading by a person draws nothing, because that is what a checklist already
means.

Every control writes an operator's reading and derives nothing: there is no "mark all", and no state
is inferred from a merged part or a green build. Superseded checks are drawn folded, as the record of
what a plan withdrew — a surface that filtered them would leave a reader unable to tell a check that
was dropped from one that was never written. They stay on the **sheet**: what an amendment dropped is
a fact about that plan, while the goal's card lists what is still to be checked.

The goal page also carries the verdict as a chip beside the assay and the conclusion, inside neither —
and that chip is a button, because the checks are now on the same page and a verdict you can act on
should not be the one reading that goes nowhere.

## Tests

`test/validation.test.ts` (the schema's refusals, letters, what an amendment may do to a check
somebody has run, and the resource ask: that it waits for the delivery, that a replan which stops
needing the resource withdraws it, and that a withdrawal never overwrites the operator's own answer), `test/validationFlag.test.ts` (the verdict, the close-out obligation, the two
notes, and that a flagged goal still blocks nothing), `test/validationAmend.test.ts` (the
tool: who may amend, that an amendment withdraws nothing by omission, what a rewording costs, and
the band), `test/validationFleet.test.ts` (the hand-over: the rule's gates and its position in
the pipeline, who may report, what a hand-back does not write, and what withdraws a hand-over),
`test/validationReady.test.ts` (the bench row: what files it, that a check with the fleet does not and
a hand-back does, that a settled row is never written over, and that the results settle it), and
`test/validationDesktop.test.ts` (the desktop channel: that no fleet tool is reachable from it, the
credential's mode, that a second harness cannot take the stable socket, one claim at a time, the
three ways a claim is released, and that a reading is attributed to `desktop`).

The verdict tests assert **both** directions, `planApproval.test.ts`'s discipline: a verdict that
counts `deferred` as clear and one that does not are one edit apart, and only one of them is honest.
The amendment tests do the same with the rewording rule, which has the same shape: a check whose
wording changed loses the result, and one re-declared word for word keeps it. The hand-over tests
assert three pairs on the same principle — a nominated check that nobody handed over dispatches
nothing while a handed-over check that nobody nominated dispatches; a hand-back writes no reading
where a result writes one; a rewording withdraws the hand-over where a word-for-word re-declaration
keeps it.
