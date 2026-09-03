# 32 — Local validation

`src/localValidation/`. The fleet driving the machine's **one** dev environment and saying whether a
goal's changes work: an operator presses a button, the harness brings the goal's code up
([23](23-local-runs.md)), and one agent writes a test plan for the change, waits for the environment,
drives the running application through the plan, and reports.

Everything else in the harness reads the work. This is the one thing that **runs** it.

## What it is not

Stated first, because each boundary is a thing the harness already does and would otherwise be
re-litigated:

| Not                | Because                                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A validation check | A check is a procedure somebody declared and a reading somebody took against the **delivered** goal ([20](20-validation.md)). This is an exploratory run against work still in flight, and it writes no reading on any check. |
| A test suite       | `npm run check` runs on every branch, and had already passed on every goal this is ever pressed on.                                                                                                                           |
| A code review      | `pr-review` reads the diff. This opens the thing and uses it.                                                                                                                                                                 |
| A shortfall        | A shortfall says the work is not finished and clears the goal's **delivery**. A failed validation says the finished work does not behave. → [when it fails](#when-it-fails)                                                   |
| A gate             | Nothing here holds a dispatch, a merge, a conclusion or a close. A `failed` reading schedules a fix and changes no verdict.                                                                                                   |
| Automatic          | There is no rule that fires this. A row exists because somebody pressed a button.                                                                                                                                             |

## The row

`local_validations`, one row per press, `src/store/localValidations.ts`. Kept after it ends —
`local_runs`' rule: a validation abandoned because somebody swapped the environment is the case an
operator actually hits, and its reason has to be readable afterwards.

`pending` → `dispatched` → `passed` | `failed` | `blocked` | `abandoned`.

- **`blocked`** is the third answer and the reason there are three, `validation_report`'s hand-back
  argument exactly: an agent that could not reach or confirm the environment has learned nothing
  about the goal, and with only `passed` and `failed` available its options are a lie and silence.
  It dispatches no fix, because it carries no finding about the code.
- **`abandoned`** is the harness's answer rather than the agent's: the environment went away, the
  agent ended without reporting, or the operator called it off. The note says which.

### The pin

`run_id` and `commit_sha` record **which environment the plan was written against**, and that pin is
the whole correctness of the feature.

`validationRunStale` (`src/localValidation/stale.ts`) is the one predicate, asked by the rule before
it dispatches, by `local_validation_report` before it records, and by the desk's sweep before it
abandons. Three copies would be free to disagree, and the disagreement that matters is quiet: a
report accepted against a checkout that has moved is a reading of code nobody asked about, filed
under the goal as though somebody had run the plan.

Four things count as a different environment, and each of them is one:

| Reading                | What happened                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| Nothing live           | The run was stopped, or it failed.                                                        |
| A different run id     | A swap, or a restart of the same goal — a different environment either way.               |
| **A different commit** | A refresh moved the checkout under a running server. The id stands and the code does not. |
| `stopping`             | A teardown in flight is an environment on its way out.                                    |

The third is the arm a plain "is anything live" check would miss, and the one that produces the most
confident wrong answer. A row or a run from before the commit was recorded reads as **unknown and is
refused**, because a validation is the one reading that must not be about a checkout it cannot
identify.

## The press

`POST /api/issues/:number/validate-locally`, `{swap?, refresh?}`. In order: refuse if a row is
already open on this goal; refuse **409** if a different goal's run is live and `swap` is not set,
naming what is running; start (or swap, which is the same call —
[23](23-local-runs.md#one-at-a-time)); refresh first where the operator asked and the checkout would
actually move; record the row against the run that is now up; broadcast; run a cycle.

**Two consents, and both can only be given before the runner is called.** By the time `start` is
reached the previous environment is already coming down, and a refresh is a `reset --hard` under a
running server. So the cockpit asks, the modal is the asking, and the route's 409 is the backstop for
the race between the draw and the click.

**This route runs a cycle**, unlike every route in [23](23-local-runs.md). A validation is work: the
rule below dispatches into the _beginning_ of the bring-up, and waiting for the next heartbeat would
spend those minutes on nothing.

`POST …/validate-locally/cancel` settles an open row `abandoned`. It is required rather than a
convenience: an operator who kills the validator from its drawer otherwise leaves a `dispatched` row
nobody will ever report against, and the control on the goal stays absent for good.

## The dispatch — rule `local-validation`

`src/dispatcher/rules/localValidation.ts`, a `DISPATCH_PIPELINE` entry and a `STAGES` module like any
other rule ([05](05-dispatcher.md#the-rule-book)).

- A **code** agent — a validation runs things — in a **read-only checkout**
  ([09](09-execution.md#the-read-only-checkout)) leased under `validate-local/issue/<n>/<id>`, origin
  `issue:<n>:validate-local:<id>`. The name is a lease key and no ref is minted.
- **Pinned to the commit, not the branch.** The branch moves — an agent may push to it while this is
  running — and a plan written against a different tree from the one being driven is the quiet form
  of the failure the pin exists to prevent.
- **It fires while the environment is still `starting`.** A bring-up is minutes inside one turn, and
  the most useful thing an agent can do in that window is read the diff and write the plan. Waiting
  for `running` would spend the wait on nothing.
- **Directly behind `manual-job`, where `validate-check` is last.** That rule is a standing
  obligation and must never take the last slot from real work; this is a person at a screen waiting
  for something they asked for, with an environment already burning on their machine.
- **No cooldown budget and no escalation.** A row is one press rather than a standing signal: it is
  re-proposed each pulse until it dispatches, the operator calls it off, or the environment goes
  away. One agent per row is the store's `WHERE status = 'pending'` on the dispatched flip, which is
  what makes it true across a restart.

Everything the agent cannot act without is **appended** to the rendered `local-validation` prompt,
never interpolated ([05](05-dispatcher.md#prompt-templates)): the goal, the plan, the goal's
validation checks as **input**, the environment's URL, directory and commit, the operator's
`localValidation.instruction` verbatim, whether it has a browser, and the rules of the run. Ports and
the session's output tail are deliberately **not** appended — they are live, and a copy frozen at
dispatch would be minutes stale. `local_run_read` answers those.

### The browser

There is no browser inside a headless `claude -p`: Claude in Chrome and computer use both require an
interactive session and refuse print mode. So the launch carries a **second MCP server**,
`localValidation.browser`, beside the harness's own — one `--mcp-config` document either way, with
the grant derived in `src/mcp/names.ts` like every other
([11](11-mcp-tools.md#launch-flags)).

It is **server-level** (`mcp__browser`), unlike the fleet's enumerated grants, and that difference is
the argument: our tool set is ours and a name with no module is a compile error, where an extra
server's tool set belongs to whoever wrote it. Enumerating theirs would be this repo keeping a copy
of somebody else's API — stale the first time they add a tool, and stale in the silent direction.

`{outputDir}` and `{profileDir}` are substituted into its arguments at dispatch. The profile is one
directory for the deployment, not one per run: a login the operator completes once in a visible
window is one every later validation inherits, and a persistent profile may only be used by one
browser at a time — which is safe here, because there is one environment and therefore one
validation.

**`null` is a real configuration.** An API-only project validates through the API and the logs
perfectly well; the prompt says there is no browser and the agent reports `blocked` for any step that
needs a screen rather than describing one it did not see.

The servers are recorded on the **task row** (`tasks.mcp_servers`) rather than re-derived at spawn,
`model`'s reason: `AgentManager.resume` rebuilds a launch from the row, and an agent re-attached
without the server it was launched with comes back holding a conversation full of tool calls it can
no longer make.

## The three tools

One module each under `src/mcp/tools/`, named in `MCP_TOOL_NAMES`, all classified `point-of-use` and
named only in the `local-validation` prompt's own tool section
([11](11-mcp-tools.md#where-a-tool-is-named-to-the-agent)). An addendum entry would advertise them to
every planner and part agent in the fleet, and a `local_run_read` reached for by an agent on somebody
else's branch is a reading of a machine running code that is not theirs.

| Tool                      | Does                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `local_validation_plan`   | Record the test plan. Once, up front — it lands on the goal's page while the environment is still coming up.        |
| `local_run_read`          | What the environment is doing now: status, URL, ports, freshness, the session's tail, and the caveat. Reports only. |
| `local_validation_report` | `passed`, `failed` or `blocked`, with a summary and — for a failure — the findings. Ends the run.                   |

`local_run_read` is `describeLocalRun` (`src/localRun/describe.ts`), the **same function** the
desktop channel's `local_run` answers with ([11](11-mcp-tools.md#the-desktop-channel)). Two names,
because the tools are not the same tool — the desktop one can start the environment and this may only
look at it — but one answer, because the caveat is the point and a second copy of it is a second
thing to get wrong.

**A failure with nothing found is refused**, and that is the schema's one judgement rather than a
field check: a `failed` report dispatches an agent to fix what it lists, and it cannot act on a
verdict with nothing in it. An agent that ran the plan and could not say what was wrong is describing
a run it could not complete, which is what `blocked` is for — and the refusal says so.

**Which validation a report is about is settled before the report rather than by it**, `validation_report`'s
rule. It comes off the dispatch origin, and `localValidationOriginParts` parses `:validate-local:`
alone — so the fix agent below is refused a reading **structurally**, by the parse rather than by a
sentence in a prompt.

Screenshots are read off the row's own directory at report time rather than taken from the agent's
list: a name it invented draws a broken image, and a file it saved and forgot to mention is one the
operator would never see.

## When it fails

Rule `local-validation-fix` (`src/dispatcher/rules/localValidationFix.ts`) puts one **writable** code
agent on the branch that was validated, origin `issue:<n>:validate-local-fix:<id>`, briefed with the
findings and the plan that produced them.

**It is deliberately not wired through a shortfall**, which is the obvious shape and the one that
must not be built: `VERDICT_EXCLUSIONS` has a shortfall clear the goal's **delivery**
([14](14-persistence.md#issue-verdicts-and-the-exclusion-matrix)), and the delivery is what parks a
goal. Recording a failed validation that way would un-park a delivered goal and hand its work back to
the fleet on the strength of an exploratory run against a branch — the same overreach
[20](20-validation.md#when-a-check-fails) refuses one layer over, arriving by a different route.

- **On the branch, not a new one.** That is where the change being validated lives. The executor's
  branch gate defers it while a part agent holds that branch, which is right: two agents on one
  branch is exactly what that gate exists for, and a fix that waits a pulse is the correct outcome.
- **One dispatch per reading**, latched on `fix_task_id`. A fix that crashed is not retried behind
  the operator: pressing the button again is the same decision they made the first time.
- **It opens no pull request.** A push reaches the branch's own PR where there is one, and opening
  one belongs to the work the branch is part of. The branch's own rules — `pr-ci-failing`,
  `pr-review-comment` — pick the push up.
- **A validation that ran from the integration branch gets no fix**, because there is no branch of
  the goal's to put one on. The findings stand on the page for a person.
- **A finding may be wrong**, and the prompt says so: it is one agent's reading of a running
  application, taken without being able to ask anybody what was intended. Changing working code to
  satisfy a mistaken finding is the one outcome here worse than doing nothing.

## The desk

`LocalValidationDesk` (`src/localValidation/desk.ts`) is the one owner of every row write and of the
staleness question every writer has to ask. Four things end a row and three of them are not in the
caller's hands, so collecting them is what lets the sweep and the report ask one predicate — and the
store's `WHERE status IN ('pending','dispatched')` guards settle the race between them, so the first
writer is the only writer.

`sweep()` runs **once a pulse above the dispatch** — so the rule never proposes an agent for a row
this beat is about to abandon — **and on every `changed` from the runner**, so a stop or a swap
settles the row at the moment it happens rather than a heartbeat later. The operator who just swapped
the environment is looking at the page.

Its second arm is the one nothing else covers: a `dispatched` row whose task is no longer active. An
agent that crashed, was killed or spent its stall park leaves a row nobody will ever report against.

## Configuration

Two live keys, deep-merged, project-layerable ([02](02-configuration.md)):

| Key                           | Default                                                          | What it is                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `localValidation.instruction` | `''`                                                             | What a validating agent is told about reaching **this** environment: which URL is which, how to sign in, what to leave alone. |
| `localValidation.browser`     | `npx -y @playwright/mcp@latest --output-dir … --user-data-dir …` | The MCP server that gives it a browser, or `null` for none.                                                                   |

**The split with the prompt is the whole design.** The `local-validation` template says how to build
a test plan and how to run one, which is the same job on every deployment; the instruction says how
to reach _your_ environment, which is the same job nowhere. Put the URLs and the sign-in quirk in the
prompt and every deployment overriding the template inherits somebody else's; put the method in
config and an operator is maintaining a prompt in a text box.

`localRun.instruction` is its sibling one step earlier: that one says how the environment is
_started_, this one how it is _used_.

**Never a secret.** It is config, it is readable in the cockpit, and a project layer commits it to
the repository. A password here is a password in git; the environments worth validating against are
the ones with a throwaway local login.

Live for the reason `localRun`'s fields are: the instruction is what an operator corrects between one
validation and the next, and a run that came back `blocked` because it could not sign in should be
answerable by editing a text box and pressing the button again.

## The cockpit

**A control, a chip and a card**, all on the goal page ([17](17-cockpit.md)).

The control is **Validate locally**, in its own `Check the work` group between _Steer the work_ and
_Leave this page_ — the only control there whose effect is on the operator's own machine. The whole
group is absent when there is nothing to press, and the card says which of the three reasons it is:
nothing configured to start the project, no branch of its own, or one already running. Nothing is
ever drawn disabled, [23](23-local-runs.md#the-cockpit)'s rule.

The chip sits beside the plan's validation verdict and inside neither: one is a checklist somebody
keeps, the other is a run somebody asked for. While one is in flight it replaces the control and says
which minute of it we are in — `waiting for a slot`, `writing the test plan`, `waiting for the
environment`, `running the plan`. Those words come off a `phase` **folded on the server**, because it
is a fold of three facts in three places and a cockpit that worked it out would be a second opinion
drawn beside the row it describes.

The card is `localValidation` in `GOAL_SECTIONS`, under Validation and above Signals — its own card
rather than a band inside that one, which is the cheaper shape and the wrong one: that card is a
checklist against the _delivered_ goal and folds until the work ships, and a report an operator asked
for two minutes ago would be hidden on exactly the unshipped goal they asked about. It opens when
there is a row and folds when there is not.

It draws the status and its lamp, the ref and short commit, doors to the validator and the fix agent,
Call it off while one is in flight, the summary, the findings with their severities and pages, the
screenshots, the pages visited, and the plan under a fold. A `passed` run reads a step back, the way
a settled check does one card over.

**The screenshots are served like attachments** — `GET /local-validations/:id/files/:name`, outside
`/api`, on a per-file capability minted into the snapshot
([16](16-http-api.md)). An `<img src>` carries no `Authorization` header, so a path the browser
assembled would 401 on every authenticated deployment while working perfectly on an open one. The
directory comes from the stored row and the name from the request, so the name is refused as a path
before it is joined and the join is re-confined afterwards.

The **local run panel** carries the same control as `Validate #N`, while the environment is running
and idle. The swap question cannot arise there — the run in front of it is the goal — so the only
question left is the stale one, and an in-flight validation draws its stage in the same line the
run's own turns use.

## Persistence

`local_validations`: `id`, `origin_ref`, `run_id`, `ref`, `commit_sha` (named for `local_runs`'
reason — `COMMIT` is a keyword), `status`, `requested_at`, `dispatched_at`, `ended_at`, `task_id`,
`fix_task_id`, `plan`, `summary`, `findings`, `visited`, `screenshots`, `note`. The last three are
JSON. A brand-new table still declares an empty `ColumnMigrations`, because a table being new **once**
does not keep it exempt ([14](14-persistence.md#migrations)) — which is exactly what `local_runs`'
usage columns cost.

`tasks.mcp_servers` is a column on an **existing** table and therefore has a real `TASK_COLUMNS`
entry. Without it every database from before this change would read it as absent and every resumed
validation would come back without its browser.

## Tests

`test/localValidation.test.ts`: the pin in all five of its arms, and that unknown is refused rather
than assumed equal; a failure with no findings refused and pointed at `blocked`; the two origins told
apart, with the fix's refused by the validation's parser; the browser's directories substituted; the
extra grant appended to the fleet's rather than replacing them, one `--mcp-config`, no
`--strict-mcp-config`; the rule firing on `starting` and on `running` and on neither of a stopped,
swapped, restarted or refreshed environment; one agent per row; the checkout read-only and pinned to
the commit; the instruction, the URL and the three tool names appended; the no-browser prompt saying
so; the fix writable on the validated branch, once per reading, and never on the integration branch;
a report against the same run recorded and one against a moved environment refused while `blocked` is
still accepted; a failed reading writing the row and neither a shortfall nor a delivery; every other
agent refused by name; the caveat riding `local_run_read`; the desk abandoning on a stopped
environment and on a dead agent; the route's two 409s with their whole sentences, the 400 naming
`localRun.instruction`, and cancel settling a row and then 404ing; and a screenshot served from the
row's own directory with a traversal refused.

`test/localValidationView.test.ts` covers the cockpit's pure half: every status has a word and a
tone, each phase its words, the offer's three arms with the sentence each names, and the two
questions raised exactly when they cannot be answered afterwards. `test/console.test.ts` draws it:
the control offered and absent in each arm, the chip's phases, the card's findings, links and plan
fold, a passed run reading settled, and the panel's button only while the environment is idle.
`test/goalPage.test.ts` covers the fold default; `test/cockpitAuth.test.ts` that the screenshot route
refuses a request carrying no capability.
