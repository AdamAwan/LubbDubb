# 32 — Local validation

`src/validation/local/`. The fleet driving the machine's **one** dev environment and saying whether a
goal's changes work: an operator presses a button, the harness brings the goal's code up
([23](23-local-runs.md)), and one agent writes a test plan for the change, waits for the environment,
drives the running application through the plan, and reports.

Everything else in the harness reads the work. This is the one thing that **runs** it.

## Invariants

- **`validationRunStale` is the one staleness predicate — asked by the rule, by `local_validation_report` and by the desk's sweep — and a moved commit, or one never recorded, is a different environment.** A report accepted against a checkout that has moved is a reading of code nobody asked about. → [§](#the-pin) · `test/localValidation.test.ts`
- **The rule never dispatches against an environment the pin no longer holds, and one agent per row is the store's `WHERE status = 'pending'` flip.** It fires on `starting` as well as `running`, and on nothing stopped, swapped, restarted or refreshed. → [§](#the-dispatch--rule-local-validation) · `test/localValidation.test.ts`
- **A failed local validation writes the row and never a shortfall or a delivery.** A shortfall clears the delivery that parks the goal, handing delivered work back to the fleet on the strength of an exploratory run. → [§](#when-it-fails) · `test/localValidation.test.ts`
- **One fix per reading, latched on `fix_task_id`, and none for a validation run from the integration branch.** A crashed fix is not retried behind the operator, and there is no goal branch to put one on. → [§](#when-it-fails) · `test/localValidation.test.ts`
- **A `failed` report with no findings is refused and pointed at `blocked`.** A fix agent cannot act on a verdict with nothing in it. → [§](#the-three-tools) · `test/localValidation.test.ts`
- **Which validation a report is about comes off the dispatch origin: `localValidationOriginParts` parses `:validate-local:` alone.** The fix agent is refused a reading by the parse, not by a sentence in a prompt. → [§](#the-three-tools) · `test/localValidation.test.ts`
- **A browser that will not start is `blocked`, never `failed`, and the prompt offers a configured browser as a claim to check.** A `failed` dispatches a fix for a defect that is not in the goal. → [§](#the-browser) · `test/localValidation.test.ts`
- **The swap and refresh consents are given before the runner is called, with the route's 409 as the backstop.** Once `start` is reached the previous environment is already coming down. → [§](#the-press) · `test/localValidation.test.ts`
- **`tasks.mcp_servers` has a real `TASK_COLUMNS` entry, and a launch's servers are read off the task row rather than re-derived at spawn.** Without it every resumed validation comes back without its browser. → [§](#persistence) · _no test_
- **The screenshot route refuses a name that is a path before the join, and re-confines the join after.** The directory comes from the stored row and the name from the request. → [§](#the-cockpit) · `test/localValidation.test.ts`

## What it is not

Stated first, because each boundary is a thing the harness already does and would otherwise be
re-litigated:

| Not                              | Because                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A validation check               | A check is a procedure somebody declared and a reading somebody took against the **delivered** goal ([20](20-validation.md)). This is an exploratory run against work still in flight, and it writes no reading on any check.                                                                                                                        |
| A test suite                     | `npm run check` runs on every branch, and had already passed on every goal this is ever pressed on.                                                                                                                                                                                                                                                  |
| A code review                    | `pr-review` reads the diff. This opens the thing and uses it.                                                                                                                                                                                                                                                                                        |
| A shortfall                      | A shortfall says the work is not finished and clears the goal's **delivery**. A failed validation says the finished work does not behave. → [when it fails](#when-it-fails)                                                                                                                                                                          |
| A gate                           | Nothing here holds a dispatch, a merge, a conclusion or a close. A `failed` reading schedules a fix and changes no verdict.                                                                                                                                                                                                                          |
| A run against a real environment | This drives the **machine's own** dev environment, exploratively, against work still in flight. Running the project's reviewed specs against an environment somebody deployed to, after the goal's work has arrived there, is [36](36-remote-validation.md) — and that one writes `spec` readings onto the goal's checks where this one writes none. |
| Automatic                        | There is no rule that fires this. A row exists because somebody pressed a button.                                                                                                                                                                                                                                                                    |

## The row

`local_validations`, one row per press, `src/store/localValidations.ts`. Kept after it ends —
`local_runs`' rule: a validation abandoned because somebody swapped the environment is the case an
operator actually hits, and its reason has to be readable afterwards.

`pending` → `dispatched` → `passed` | `failed` | `blocked` | `abandoned`.

- **`blocked`** is the third answer and the reason there are three, and it is the **one word every
  validation path takes** for the fact: an agent that could not reach or confirm the environment has
  learned nothing about the goal, and with only `passed` and `failed` available its options are a lie
  and silence. It dispatches no fix, because it carries no finding about the code. The catalogue path
  called the same verdict `handback` until this was settled, and answers that word with a refusal
  naming this one ([20](20-validation.md#validation_report)); what stayed `handback` there is the
  _record_ a check has gone back to a person, which is a different fact from a verdict.
- **`abandoned`** is the harness's answer rather than the agent's: the environment went away, the
  agent ended without reporting, or the operator called it off. The note says which.

**One column carries both the lifecycle and the verdict, and that is the shape the row wants.** A
local validation _is_ a run: it is opened by one press, ends exactly once, and never runs again, so
`pending`/`dispatched` and `passed`/`failed`/`blocked` are values of one state machine and no pair of
them can be true together. `remote_runs.status` is the same shape for the same reason
([36](36-remote-validation.md#a-runs-status-vocabulary)). What `validation_checks` separates is
separate because its unit of account differs: a check is a **catalogue row** that outlives any number
of readings, so its `state` is the current reading and its claim and hand-over columns are about the
attempt in flight. Splitting this column would buy no expressible state, and would cost a nullable
verdict column whose null means _not ended yet_ — a meaning-bearing null, so a migration with a
backfill ([14](14-persistence.md#when-a-null-means-something)) — plus every query, the wire type and
the cockpit's word and tone maps rewritten around it.

### The pin

`run_id` and `commit_sha` record **which environment the plan was written against**, and that pin is
the whole correctness of the feature.

`validationRunStale` (`src/validation/local/stale.ts`) is the one predicate, asked by the rule before
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

`localValidation.browser` is **one configuration block read by two dispatches**: this one, and a
remote validation sheet's own run ([36](36-remote-validation.md#the-browser-the-run-drives)). What a
browser is and how it is launched is the same question in both places, and a second key beside it
would be a second answer to it. What stays local is everything below about _this_ run — the one dev
environment, the window the operator is watching, and the profile; what the remote run substitutes is
its own artefact directory and a profile of its **own**, per environment, because a persistent profile
may be held by one browser at a time and the account that reaches an acceptance deployment is not the
one that reaches this machine.

There is no browser inside a headless `claude -p`: Claude in Chrome and computer use both require an
interactive session and refuse print mode. So the launch carries a **second MCP server**,
`localValidation.browser`, beside the harness's own — one `--mcp-config` document either way, with
the grant derived in `src/mcp/names.ts` like every other
([11](11-mcp-tools.md#launch-flags)).

It is **server-level** (`mcp__browser`), unlike the fleet's enumerated grants, and that difference is
the argument: our tool set is ours and a name with no module is a compile error, where an extra
server's tool set belongs to whoever wrote it. Enumerating theirs would be this repo keeping a copy
of somebody else's API — stale the first time they add a tool, and stale in the silent direction.

`{outputDir}` and `{profileDir}` are substituted into its `command` and arguments at dispatch, beside
`{node}` and `{playwrightMcp}` (below); any other `{name}` is left as written. The profile is one
directory for the deployment, not one per run: a login the operator completes once in a visible
window is one every later validation inherits, and a persistent profile may only be used by one
browser at a time — which is safe here, because there is one environment and therefore one
validation, and because the remote run's profile is its environment's own and never this one.

**The prompt offers it as a claim, not a fact.** Whether the server actually
connected is not something config can know: it is fetched and launched at the same
moment the agent is, so it can be missing because the machine is offline, because
the package is blocked, or because there is no browser installed for it to drive —
and the last of those does not surface until the first page. Nothing here reads the
init event's `mcp_servers` list, so the agent is told to check before planning
around it and told which answer a missing browser is: `blocked`, never `failed`. A
failure dispatches a fix agent, and a browser that would not start is not a defect
in the goal.

**`null` is a real configuration.** An API-only project validates through the API and the logs
perfectly well; the prompt says there is no browser and the agent reports `blocked` for any step that
needs a screen rather than describing one it did not see.

### The recording

The run is **recorded as a video**, because the operator judges it by watching it: a video of the
steps is evidence nobody has to reproduce to believe, where a summary is the agent's own account. The
default browser is launched with `--caps devtools`, which gives it `browser_start_video`,
`browser_video_show_actions`, `browser_video_chapter` and `browser_stop_video`. The briefing asks the
agent to start recording once the application is open, label every action on screen, open a chapter
before each step of its plan — named by the check's letter where it serves one — and stop the
recording before it reports, since a video that is never stopped is never written. Chapter cards are
burned into the video itself, so the cockpit needs no chapter list of its own.

**No `filename` is passed**, so the video lands in `{outputDir}` under the browser's own name — the one
directory the desk lists and the file route serves. **A missing video tool is not a finding and not
`blocked`**: an operator whose own `localValidation.browser` does not enable the capability gets an
unrecorded run, which is what they had before. The remote run drives the same server, so the tools are
on offer there too, and its briefing asks for one in the same words — `recordingInstructions`
(`src/validation/recording.ts`) is the one copy ([36](36-remote-validation.md#the-runs-recording)).

**The browser is bundled, and its ffmpeg revision is derived, never kept by hand.** `@playwright/mcp`
is an exact-pinned dependency in `package.json`, so `npm ci` installs it with the `playwright-core` it
wants and the lockfile holds the version. The default launches its entry point from `node_modules` with
the harness's own `node` (`{node}`, which is `process.execPath`) — no `npx`, no fetch at spawn, and no `@latest` possible.
Playwright writes video with its own ffmpeg build, installed per revision under the Playwright cache
(`ffmpeg-<revision>`), and every `@playwright/mcp` release can bundle a Playwright that wants a new one;
`bundledPlaywright()` (`src/validation/local/policy.ts`) reads that revision off the installed
`playwright-core`'s `browsers.json` — the copy `playwright` itself resolves, reached through
`@playwright/mcp`, because that is the one that records. So bumping the one dependency moves the server, its Playwright and the revision together, with nothing to keep in step.

**`npm ci` installs the matching ffmpeg.** The `postinstall` script (`scripts/installFfmpeg.ts`) runs the
bundled `playwright-core`'s `install ffmpeg`, which can only fetch its own revision. A failed download —
a proxy blocking the Playwright CDN — warns and lets the install succeed; `npm ci --ignore-scripts`
skips it. Both are caught by the boot preflight below, which stays as the backstop.

**`{playwrightMcp}` names the bundled server in an operator's own block.** It is substituted, beside
`{outputDir}` and `{profileDir}`, with the bundled entry point's absolute path, and `{node}` — substituted
in `command` as well as `args` — with the harness's own `node`; so a project that needs its own flags
writes `"command": "{node}", "args": ["{playwrightMcp}", "--timeout-navigation", "15000", …]`
and names no package version — the version is the harness's, and moves with it. A block that names a
package itself (`npx -y @playwright/mcp@…`) still works, but its ffmpeg is the operator's to keep.

**Without that ffmpeg the recorder fails quietly.** `browser_start_video` errors, but
`browser_stop_video` still answers with a `.webm` name and no file is written. So the agent is told a
start error means carry on, and that the stop answer's file name is no proof — and it is not asked to
explain a missing video, because the harness reads that for itself:

- **At boot, and again on a live change to `localValidation.browser`**, `ffmpegPreflight`
  (`src/validation/local/ffmpeg.ts`, through `browserPreflight` from `main.ts` and the live config arm)
  checks any block that uses the bundled server — `usesBundledServer`, `{playwrightMcp}` anywhere
  `substituteBrowserArgs` would fill it, the default among them; a block naming its own package names a
  revision this harness cannot know. Each finding is **one** recorded error (`boot`, or `runtime` for a
  live change):
  - **The bundled package cannot be read** (no `bin`), recorder or not: the error names `npm ci`.
    `bundledPlaywright()` never throws — it answers the failure as a message and keeps only a success, so
    dispatch picks up a repaired install without a restart (the recorded error stays until the next boot
    or browser change) — and `substituteBrowserArgs` then leaves `{playwrightMcp}` as written, so the browser fails to connect and
    the run reports `blocked`, where a throw at dispatch would abort the whole pass.
  - **A recorder is offered and the bundled Playwright names no ffmpeg build**: the browser still
    launches; only the recording is lost, and the error says so.
  - **A recorder is offered and `ffmpeg-<revision>` is missing** from the Playwright cache (a non-empty
    `PLAYWRIGHT_BROWSERS_PATH`, else the platform's default, with an empty `XDG_CACHE_HOME` or
    `LOCALAPPDATA` read as unset): the error names `node <playwright-core>/cli.js install ffmpeg`, with the full path of the
    `playwright-core` that `playwright` resolves, which need not be the top-level one. Under
    `PLAYWRIGHT_BROWSERS_PATH=0` Playwright installs inside its own package, which this harness does not
    locate, so it says nothing there rather than guess.

  A remote validation run drives the same block ([36](36-remote-validation.md#the-browser-the-run-drives)),
  so this check covers it too.

- **On each settled run**, a `recordingStatus` is written beside the report — `kept` where a video is
  there, `missing` where the agent was launched with the recorder (a server whose `--caps` include
  `devtools`) and none was written, `not_offered` otherwise (`recordingStatus`, `recorderOffered` in
  `src/validation/recording.ts`). The offer is read off the **task row's** `mcp_servers`, never the
  live `localValidation.browser`: an operator who edits the browser block mid-run must not change what
  that run is judged to have been offered. Here it is `local_validations.recording_status`;
  the remote run's is its own ([36](36-remote-validation.md#the-runs-recording)). Null is _not known_ —
  every row before the column, every row not yet reported, a run reported `blocked` with no video (it may
  never have got as far as recording; one that did record is `kept`), a directory that could not be
  read, and an agent whose task row is gone — so nothing is backfilled. The offer is the reporting
  task's own.
  **`missing` never changes an outcome**: a run with no video is still the pass, failure or block it
  reported. The cockpit draws "not recorded" under the report where it is `missing`.

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

`LocalValidationDesk` (`src/validation/local/desk.ts`) is the one owner of every row write and of the
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

| Key                           | Default                                                                   | What it is                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `localValidation.instruction` | `''`                                                                      | What a validating agent is told about reaching **this** environment: which URL is which, how to sign in, what to leave alone. |
| `localValidation.browser`     | `{node} {playwrightMcp} --output-dir … --user-data-dir … --caps devtools` | The MCP server that gives it a browser, or `null` for none. A remote validation run drives it too.                            |

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

The control is **Run it here**, on the **run strip** at the top of the goal's Validate pane, on the
`your machine` line beside every environment that could take a check
([17](17-cockpit.md#the-validate-pane)). It sat in a `Check the work` group in the goal header until
the pane was banded; the strip is where a run is started, and the panel below is where it is read.
Where there is nothing to press the line says which of the three reasons it is — nothing configured to
start the project, no branch of its own, or one already running — **in place of** the control rather
than beside it. Nothing is ever drawn disabled, [23](23-local-runs.md#the-cockpit)'s rule.

Beside the press, the strip says what the run is and is not: an exploratory run against work in
flight, which answers no check. That sentence belongs at the press because that is where the
expectation is formed — a run started from a pane headed by a check set is started by somebody who may
think it answers one — and the panel's own subtitle says it again where the report is read.

The chip sits beside the plan's validation verdict and inside neither: one is a checklist somebody
keeps, the other is a run somebody asked for. While one is in flight it replaces the control and says
which minute of it we are in — `waiting for a slot`, `writing the test plan`, `waiting for the
environment`, `running the plan`. Those words come off a `phase` **folded on the server**, because it
is a fold of three facts in three places and a cockpit that worked it out would be a second opinion
drawn beside the row it describes.

The card is `localValidation` in `GOAL_SECTIONS` — the fold id is the store's word; what a person
reads is **Runs on your machine**, on the Validate pane, below the check set and beside the other
runners ([17](17-cockpit.md#the-validate-pane)). Its own card rather than a band inside the check
set, which is the cheaper shape and the wrong one: that card is a checklist against the _delivered_
goal and folds until the work ships, and a report an operator asked for two minutes ago would be
hidden on exactly the unshipped goal they asked about. It opens when there is a row and folds when
there is not.

It draws the status and its lamp, the ref and short commit, doors to the validator and the fix agent,
Call it off while one is in flight, the summary, the findings with their severities and pages, the
recording as a player above the screenshots, the pages visited, and the plan under a fold. A `passed` run reads a step back, the way
a settled check does one card over.

**The screenshots and the recording are served like attachments** — `GET /local-validations/:id/files/:name`, outside
`/api`, on a per-file capability minted into the snapshot
([16](16-http-api.md)). An `<img src>` or `<video src>` carries no `Authorization` header, so a path the browser
assembled would 401 on every authenticated deployment while working perfectly on an open one. The
directory comes from the stored row and the name from the request, so the name is refused as a path
before it is joined and the join is re-confined afterwards.

What is listed is every image (`.png`, `.jpg`, `.gif`, `.webp`, `.avif`) and video (`.webm`, `.mp4`)
in the output directory, read by the desk into the row's `screenshots` column at report time. The
one table of which extension is which is `mediaKind` (`src/validation/media.ts`): the desk
lists by it, and the view tags each file with its `kind`, so the cockpit draws a `<video>` or an
`<img>` without an extension list of its own. The route streams the file and answers a byte range
([16](16-http-api.md#byte-ranges)), so a long recording seeks before it has loaded. A video is deleted
`recordingRetentionDays` after the run ended, and its name taken off the row; the screenshots stay
([14](14-persistence.md#recording-retention)).

The **local run panel** carries the same control as `Validate #N`, while the environment is running
and idle. The swap question cannot arise there — the run in front of it is the goal — so the only
question left is the stale one, and an in-flight validation draws its stage in the same line the
run's own turns use.

## Persistence

`local_validations`: `id`, `origin_ref`, `run_id`, `ref`, `commit_sha` (named for `local_runs`'
reason — `COMMIT` is a keyword), `status`, `requested_at`, `dispatched_at`, `ended_at`, `task_id`,
`fix_task_id`, `plan`, `summary`, `findings`, `visited`, `screenshots`, `note`, `recording_status`.
`findings`, `visited` and `screenshots` are JSON. `recording_status` came after the table, so it has its
`ALTER TABLE` in `LOCAL_VALIDATION_COLUMNS` — a table being new **once** does not keep it exempt
([14](14-persistence.md#migrations)); null is _not known_ and nothing is backfilled
([the recording](#the-recording)).

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
