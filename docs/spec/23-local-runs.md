# 23 — Local runs

`src/localRun/`. The machine's **one** dev environment: which goal's code is in it, the process holding
it up, and the two controls that change either. Always constructed; with
`localRun.instruction` unset every start refuses with that as its reason.

A validation check says "open the page and click the thing" ([20](20-validation.md)). Nothing in that
document said how to get the page up, and the planner who wrote the check is the one part of the
deployment that cannot know: it read the repository, not the operator's machine. So the check reached
the machine with the browser and the login and stalled on the one fact nobody had written down.

This is that fact, plus the thing that acts on it.

## What it is not

| Not                       | Because                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A deployment             | Nothing here reaches a server, a registry or an environment. It runs the project on the machine the harness is on.          |
| A fleet agent            | No task row, no dispatch, no cap. The dispatcher does not know it exists and no rule reads it.                              |
| A test run               | `npm run check` runs on every branch. This is a person looking at a screen.                                                 |
| A reading                | `running` means the session that brought it up did not fail. **Nothing polls the application.**                             |
| A queue                  | One environment, so one run. Starting a second thing is stopping the first, and there is no route that means anything else. |

## One at a time

There is one dev environment on the machine, which is the operator's own constraint rather than a
limit invented here — the same one the validation claim is built on
([20](20-validation.md#the-claim)). So:

- **`Store.beginLocalRun` ends whatever was live in the same transaction that writes the new row.**
  The mutual exclusion is the SQL, not a check the caller is trusted to make: a runner that read
  first and wrote second would compile, pass, and leave two servers on one port with the cockpit
  drawing one of them.
- **Starting is swapping.** `POST /api/local-run` with a different goal is the whole of "run that one
  instead", and there is no second route. Two names for one transition are two things to keep in step.
- **The row outlives the run.** A start that failed is the case an operator actually hits, and its
  reason has to be readable after the process is gone. `liveLocalRun()` is the live one;
  `currentLocalRun()` is the live one *or the last that ended*, which is what the panel draws.

## The instruction is config, not a prompt

`localRun.instruction` — free text, what the session bringing the environment up is told —
`localRun.stopInstruction`, what the session taking it back down is told, and `localRun.url`, where the
application lands. All three are **live fields**
([02](02-configuration.md#liveness)): an edit on the Config page applies to the next start with no
restart. They sit under **Features** there, beside the other policy objects, and `localRunRoot` under
**Paths** — which is a thing `GROUPS` in `src/server/runningConfig.ts` has to be told: a declared key
in no group is drawn nowhere, because the group loop never reaches it and the "Other" fallback skips
it precisely *because* it is declared. `test/configFields.test.ts` asserts every declared key is
claimed by a group, since the symptom is a field that validates, applies, and is invisible.

It began as a prompt id (`local-run`), on the argument that _how a project starts_ is the operator's
opinion and the prompt book is where this repo keeps those — the same argument that puts
`finding-ticket` and `docs-change` there. What moved it is the editing story. Prompt overrides are a
file drop that takes effect at the next boot, and are read-only in the cockpit **on purpose**
(`src/server/routes/state.ts`: a write route "would have to answer 'when does this take effect', and
the honest answer — at the next restart — is worse than not offering it"). This is the one
instruction an operator corrects *while* a start is failing in front of them, and bouncing the
harness to fix a typo in a command would take the fleet's agents down with it.

The id is **retired, not deleted** — `loadPromptTemplates` throws on a file naming no known id, so
removing it would turn a deployment that had overridden it into a harness that will not boot
([05](05-dispatcher.md#prompt-templates)).

Free text rather than a command, because the machine that can start this deployment is the one with
the operator's own tooling on it: `/dev-environment start` is a Claude Code command and not a shell
one, and a project whose start is three steps and a wait has nowhere to say so in a command string.

## The checkout

One directory, `localRunRoot` (default `.lubbdubb/local-run`), reached only through
`WorktreeManager.ensurePreview(ref)` — because that class is the only thing that hands out a
directory ([09](09-execution.md#the-checkout-a-local-run-uses)).

**Deliberately not a pool slot**, and each difference is load-bearing:

- **Outside `worktreeRoot`.** `slots()` counts every *registered* worktree under that root whatever
  the directory is called, so a preview checkout in there would count toward the pool's bound and be
  handed to an agent — wiped `git clean -ffdx` on the way.
- **Ignored files survive a change of ref.** That wipe is right for an agent's branch and wrong here:
  it would make every swap between goals pay a cold dependency install, which is the whole thing a
  kept checkout is for. `ensurePreview` cleans `-fd`, so `node_modules` and build output stand.
- **No lease.** The lease keeps two agents out of one directory; there is one local run, and the store
  row is what makes that true.

Three orderings inside it were wrong before the current one, and each failed differently: comparing
`git worktree list` paths to decide whether the checkout exists breaks where a short-name TEMP
resolves to a different string for the same directory (`worktree add` then says "already exists" about
a tree that was ready); `switch` before the tree is clean refuses outright when the last run left a
tracked file edited; and `reset --hard` on a checkout somehow standing on a branch would rewind *that
branch*, the damage `git switch -C` is banned for. So: existence check, `checkout --detach`,
`reset --hard <commit>`, `clean -fd`. An unresolvable ref throws before anything is touched.

## Which ref, and what else is on offer

`localRunChoices` (`src/localRun/ref.ts`, pure) answers it: the **default**, everything else the goal
could be run at, and how much of the plan has landed.

The default is the **tip of the stack** — the furthest-along part with a branch, `merged`, `retired`
and `concluded` skipped. Plan order *is* stacking order, since a part is cut from its predecessor's
branch, so the last unmerged one contains everything behind it.

Failing that, the goal's **own** branch, resolved by the same `openPrForIssue` the pickup verdict uses
— its conventional `issue/<n>` or whatever its linked pull request is on. A goal nobody decomposed has
its whole work on one pull request, and this feature could not see those goals *at all*: no parts meant
no candidate, so a goal with an open PR in front of the operator resolved to the integration branch,
started there, and said nothing about it. On the panel it was worse than silent — the row was filtered
out, because a goal that resolves to the integration branch is not offering a choice.

With neither, null: a goal whose parts have all merged **is** the integration branch, and so is one
nothing has started.

It was the **first** unmerged part until the picker was rewritten, on the argument that the furthest
back is the furthest anybody would want to look. That is the wrong end: what somebody asking to see a
goal means is the goal, and the first unmerged part of a three-part stack is a third of it. Nothing
said so — the environment came up on a real branch of the right goal, one section short, and the
panel named neither the branch nor the part.

The skipped statuses stay **on offer**, labelled: each can still carry a branch from before it got
there, so none of them is a sane *default*, and looking at what a merged part delivered is a
perfectly sane thing to ask for. Which makes the list the **allow-list** as well as the thing the
panel draws — `start(originRef, at)` checks an override against it, so the route is a way to run this
goal's own work and not a way to check out an arbitrary ref. One function for all three questions
(what runs, what may run, what to draw), because two implementations of "which one is the tip" would
be free to disagree about the branch an operator is looking at — and because the panel offering a
branch the runner would refuse is a dead control with nothing red about it.

## The process

`localRun.instruction` is handed to a **long-lived stream session** — the same `SessionFactory` the
fleet's agents come from, so `agentMode` and the test fakes apply here and this module never learns
that a real `claude` exists.

Through Claude Code rather than a bare shell command, so `/dev-environment start` stays the interface.
The consequence is the sharpest thing in this document: **a plain `claude -p` exits when its turn
ends**, which would take the dev server with it or orphan it. `StreamJsonSession` keeps the process
alive while stdin is open, and that is what holds the server's parent open. So:

- **The turn ending is the environment being up, not the run being over.** `done` and `waiting` both
  mean "it stopped talking and did not fail", and the status goes to `running`. Nothing is killed —
  a runner that treated `done` as terminal would kill the thing the run exists to hold.
- **Five rules are appended to the instruction, never interpolated into it** — the prompt templates'
  rule for their reason. Start it in the background and stay; do not stop it; do not commit (the
  checkout is detached at somebody else's commit); say where it landed; say each step before taking
  it. An operator writing down how their project starts has no way to know any of them, and an
  instruction that had to remember them would be one edit from dropping one.
- **A stop reaps the subtree _before_ it signals the child**, and after it has asked for the
  environment to come down (see below). Descendants resolve through the root pid, so reaping after the
  process dies finds nothing, leaving the port held and, on Windows, the checkout unremovable
  ([10](10-agent-runtimes.md#reaping-the-process-subtree)).
- **It is not an agent row and not against the cap.** A run holding one of `maxConcurrentAgents`
  would starve the fleet for as long as the environment is up. The cost is one short turn at startup;
  an idle stream session spends nothing while no turn is in flight.

## Stopping is a turn, not a signal

`localRun.stopInstruction`, and a `stopping` status while it runs.

**A dev environment is not a process tree.** Reaping the session's subtree is right and does what it
says — it takes the session and its own children — and it cannot touch a Docker container, which
belongs to the daemon, or anything a start handed to a service. No signal the harness can send reaches
those. So the reap was never going to be a stop, and the row said `stopped` anyway: an outcome nothing
had checked, with the containers running on behind it. A project that can be started at all tends to
have a command for stopping, for exactly this reason.

So a stop is the mirror of a start, in this order:

1. The row goes to **`stopping`**, which is a *live* status: a run being taken down still holds the
   environment, so nothing may begin beside it and the panel must not offer to.
2. The stop instruction is carried out **in a session** — the one that brought it up if it is still
   there, since it knows what it started and is already warm; otherwise a **fresh** one in the run's
   own checkout. That second arm is the case that hurt most: after a restart the containers are up and
   the harness holds nothing, so a swap would have started a second stack on the same ports. It is told
   outright that it did not start this, because a session left to infer it finds nothing of its own
   running and reasonably reports there is nothing to do.
3. **Bounded.** `STOP_TIMEOUT_MS` (two minutes, injectable for tests). A stop that never finishes would
   otherwise leave a harness that can never start anything again, since a swap waits for one.
4. **Then** the reap and the kill, always — whether the instruction worked, failed or timed out. The
   session and its own children are the harness's to clean up either way.
5. The row settles `stopped` with a note saying which of four things happened: what the session said it
   stopped, that the stop was not confirmed in time, that the session failed, or that **no stop
   instruction is configured** — in which case the session was killed and whatever it started may still
   be running. Blank is a supported state, not a broken one: plenty of projects are one process, where
   the reap is the whole story. The panel says which of the two a deployment is.

**One stop at a time.** The runner holds the promise, so a second click, a swap and the desktop tool
all wait on one teardown rather than racing two.

**A swap stops before it prepares the checkout**, and that order is load-bearing: the stop instruction
runs *in* the checkout — `docker compose down` reads the compose file that is in it — and
`ensurePreview` is a `reset --hard` and a `clean -fd` on the same directory. Preparing first pulls the
project out from under the session being asked to shut it down. The cost is that a checkout which
cannot be prepared now fails with the previous environment already gone, so that refusal says so.

**The stop turn is not the run coming up.** The bring-up's handlers are keyed on the run id, and the
stop's turn ends in a `done` like any other — which `up()` would read as "the environment is up".
Dropping the id as the stop begins is the one switch that keeps the two apart; without it a stop
writes `running` on its way out.

**A restart settles every live row.** A row saying `running` after a restart describes a process this
harness never spawned — the pid belongs to something dead, or to whatever has since been given that
number. `endStaleLocalRuns` runs at boot and records how many it settled. The run also goes down with
the harness rather than being interrupted like an agent's work: an agent's conversation is worth
restoring and a dev environment is not, and left running it would be an orphan holding a port and the
checkout with a row claiming it is live ([21](21-self-update.md#the-drain)).

Shutdown takes the **fast path** deliberately — `stopFast`, which reaps, kills and settles without a
turn. Ctrl-C and the upgrade handoff are the two paths that must not hang, and an upgrade is a restart.
The cost is a container that can outlive the harness; the note is what makes that a thing the panel
states on the next boot rather than a mystery.

## Saying what it is doing

A bring-up is minutes of work inside **one turn** — containers, builds, a seed, a dev server — and
until that turn ends the only two things the harness knows are that it started and what the session
has printed. Both used to arrive too late to be any use: nothing subscribed to the runner's `changed`
event, so the status, the log and everything derived from them moved no sooner than the next
heartbeat. A start that was working and a start that had hung looked identical for a whole pulse at a
time, and the panel's word for both of them was "Starting".

Three things close that, and the order they are in matters:

- **The session is asked to narrate.** A fifth appended rule: print one line beginning `phase:` before
  each step. `LocalRunner` keeps the newest such line, and `phaseOf` tolerates the bullet or the bold
  a model puts in front of it. What it will not do is **guess** — a line that does not say `phase` is
  output. A stage inferred from whatever the session last happened to print would be a caption the
  harness made up, unfalsifiable from the glass and wrong exactly when the run is going badly.
- **The phase is not durable, and is cleared twice.** It ships on `LocalRunView`, derived from the
  runner rather than the row, because it describes work in flight and only the process doing the work
  can vouch for it — so a restart correctly has none. It is dropped when the turn ends **and** when the
  run settles: an environment that is up, still captioned with the last step of its own start,
  re-creates the failure this section exists to end.
- **The hub coalesces.** `changed` fires per line of output, and every `dirty` costs every connected
  cockpit a whole snapshot, so 400ms of events become one refetch
  ([16](16-http-api.md#the-tail)).

**What none of this makes faster.** The panel now says what is happening; the clock is unchanged, and
deliberately so. The harness's own share of a start is a commit resolution, the checkout's
`reset`/`clean` and a process spawn — a few seconds against a bring-up of minutes, and measuring the
git half on a large repository put `status` and `clean` at about a second each. A fast path that
skipped the prepare when the checkout already stood at the right commit would have to ask `status`
whether the tree was clean, which costs what the `clean` it saves does, and skipping the `reset`
instead trades away the one guarantee that a tracked file the last run edited is put back. The lever
that is worth pulling is `localRun.instruction` itself — a stack that starts fewer things, named as a
command rather than as an interactive skill with a phase per turn — and it belongs to the operator.

## What it costs

A local run is a Claude Code session, and a long one: it holds the environment for as long as somebody
is looking at it, and its teardown is a second turn. That is money on the same account the fleet is
billed to, and for the feature's first three revisions no surface in the cockpit had heard of it.

The reading arrives for free. The stream runtime emits `usage` at every turn end — cumulative cost,
tokens and turns off the `result` event ([10](10-agent-runtimes.md)) — and the runner now listens:
`absorb` takes a session's usage the same way it takes its output. The PTY runtime has no such channel,
so **every local run of a `agentMode: 'pty'` deployment is unmeasured**, which is the null the columns
carry rather than a zero ([18](18-observability.md#usage-accounting)).

**The row accumulates; it is not folded.** Every other usage figure the harness holds is a session's
cumulative report written straight onto a row, because an `agents` row has exactly one session behind
it. A local run has **up to two** — the one that brought the environment up, and the one spawned to
take it down when that one is gone ([above](#stopping-is-a-turn-not-a-signal)). A fresh session's
cumulative total starts at zero, so a cumulative write would replace a run's $2.00 with the teardown's
$0.15, and a delta clamped at zero would report the teardown as free. Both under-report, and both do it
silently. So the runner holds each session's last report in that session's own closure, and
`Store.addLocalRunUsage` **adds** the difference.

The delta is also dated, in `local_run_cost_deltas` — for the reason `usage_events` exists at all: a
row says what a run came to and never when the money went, so a rolling window or a trend can only be
read off deltas ([18](18-observability.md#the-spend-breakdown)).

### Where it shows

- **On the panel**, beside the ref: what the run holding the environment has cost so far, climbing as
  it comes up. It is the one spend figure an operator sees while the money is still being spent, which
  is where the decision to keep it running is made. Absent, not `$0.00`, when nothing was measured.
- **On the goal**, folded into `Issue.spend` — a local run's origin *is* the goal, so it attributes by
  name with no lineage hop ([18](18-observability.md#per-goal-spend)). The count is
  `IssueSpend.localRuns`, kept apart from `agents` because the goal page prints that figure as
  "Agents" and a local run is not one.
- **In the spend breakdown**, as the `local` phase — its own row in the partition, so "what is
  previewing costing me" is answerable and the phases still sum to the total.
- **In the 5h/7d gauges and the pets' beats**, because `Store.sumUsageCostSince` adds both tables.
  One figure for what this deployment spent; the panel and the gauge an operator opened it from cannot
  disagree.

## Two triggers, one owner

| From                | How                                                                    |
| ------------------- | ---------------------------------------------------------------------- |
| The cockpit         | The **Local** reading in the top bar, opening the running-locally panel |
| The operator's Claude | `local_run` on the desktop channel ([11](11-mcp-tools.md))            |

Both reach the same runner, which is the point: the tool used to render an instruction and let the
session act on it, so there were two definitions of what running meant and a harness that could not
stop what it had told somebody to start.

`local_run` reports the state, and given a goal starts it. Its reply carries the caveat in as many
words — the harness does not poll the application — because a session reporting a check passed on the
strength of a status is the one outcome the validation channel exists to prevent.

## Routes

`src/server/routes/localRun.ts`, a module and a `ROUTE_MODULES` entry. Every handler wrapped in
`checked(schemas, handler)`; a refusal is a returned 400 carrying the reason, never a throw
([16](16-http-api.md#request-validation)).

| Route                       | Does                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| `POST /api/local-run`       | `{issue, ref?}` — start it on that goal, stopping whatever was running. |
| `POST /api/local-run/stop`  | No body and no id: there is one run, and stopping it is the request. Answers as soon as the teardown has begun. |
| `GET /api/local-run/output` | The session's last lines.                                             |

Stopping **answers before it has finished**, because it is a session's turn: the run goes to
`stopping` and the runner's own `changed` events carry the rest. Awaiting the turn in the handler would
hold a request open for up to two minutes.

`ref` runs an earlier part of the goal instead of the tip of its stack. The schema checks its
*shape*, and the runner checks that it is one of **that goal's** part branches — a question about the
plan, so it is asked where the plan is. A schema that took any string and a runner that trusted it
would make this route a way to check out anything in the repository.

The output has its own route rather than riding the state snapshot: the tail is up to two hundred
lines and the snapshot ships on every heartbeat and every `dirty` — which includes every file an agent
writes — so putting it there would pay for a log nobody has open. The same argument keeps the work
graph and the prompt book off the snapshot. **No route here runs a cycle**: a local run schedules no
work and changes no world.

## The cockpit

A **Local** reading in the top bar's `cn-reads` row, quiet when nothing is up, carrying the goal's
number when something is. A reading rather than a nav tab: it is a state of the operator's own machine,
not a surface work happens on. The number is the value because that is the question — "running" alone
leaves an operator opening the panel to find out whether it is the goal they are looking at.

The panel (`web/src/components/LocalRunPanel.tsx`) is `'localRun'` on `ConsolePanel`, so it is a
**place**: it survives a reload and the back button steps out of it
([17](17-cockpit.md#the-address-bar)). It draws one state and a picker, never a table of runs — a list
would imply two could be up. What is running, since when, the URL as a link *to try*, the session's
output, and Stop plus a goal picker whose button says it stops what is running now.

### The picker

Rows, not a `<select>`. What a row has to say does not fit in an option's label, and a choice you
cannot see was what this panel got wrong first: the ref was resolved server-side at start time, so
the first anybody learned of it was after the environment had come up on it.

**A row describes the ref it would check out, and nothing else.** A pull request is a fact about a
branch, not about a goal: work can sit on an integration branch that combines several parts and is
never opened as a PR, and a goal can carry three PRs none of which describes the branch about to be
started. So a ref with no pull request of its own **says so**, beside the count of what did land in
the integration branch — which is a different statement from silence, and from a number borrowed off a
sibling. That is why `LocalRunRefFacts` is derived per ref in `stateSnapshot.ts`: the cockpit could
match a branch to a PR itself, but deciding *which of a goal's PRs speaks for a ref* is the mistake
the type exists to make unrepeatable.

Each row carries the branch, the part's position, that ref's PR with the CI policy's own verdict, and
whether an agent is on the branch **now** — because then what a run shows is a moving target. There is
no per-check dot ladder: `CiLadder` is the one thing allowed to classify a check, it lives in the
console layer, and nothing under `web/src/components/` reaches into that layer. So the server ships
the classification it has already made and the row draws it in words.

Rows with more than one option get an expander for the parts behind the tip. **Freshness is agent
activity, never a commit date**: the snapshot is synchronous and git is not on that path, so the row
says "last agent activity" and means it.

Two more rules the layout obeys:

- **A ref never goes inside the row's button.** The row is clickable to select, so its `<Ref>`s sit in
  a group beside it — one click cannot have two destinations ([17](17-cockpit.md#links)).
- **Clicking selects; a labelled button starts.** `Start #402` names what it will do, and the ref sits
  beside it, because a mis-selection costs a warm environment and several minutes. The goal number
  alone does not say which branch.

By default the list shows only goals with a branch of their own. Everything else resolves to the
integration branch, which is one choice however many goals offer it; `show every goal` reveals them.

**The filter and the empty state are counted off one population**, and that is a fix rather than a
tidiness: the count was taken over the *targets* while the rows were taken over the join of the goals
on screen and their targets, so the two could disagree — and in the case that mattered they disagreed
the wrong way round. Nothing drawn, nothing hidden by the count's reckoning, so no checkbox, under a
message that said there was nothing to run. Both now read `holdingBack`, the difference between the
candidates and the rows, so the arm that says "tick it" is only ever drawn when it is there to tick.
The other arms tell the two remaining cases apart — no goals on screen at all, or goals with nowhere
to run — because "nothing to run" reads as a hidden filter to anybody who has just been offered
one. The selection, the
expander and the filter are local state and not `Place`: which row is highlighted is not *where you
are*, and the panel itself is the place.

Three details are about the minutes a start takes rather than the state it ends in:

- **The elapsed time is a clock, not "3m ago".** Rounded relative time sits on one value for ninety
  seconds, which on the one surface an operator is watching reads as a frozen screen. `stopping` gets
  no clock: the only timestamp on the row is when the *run* started, and "Stopping · 18:04" reads as a
  teardown that has been going for eighteen minutes.
- **The stage line, under the header**, while starting **or** stopping — both are a session's turn with
  somebody watching, and a teardown that says nothing for a minute is the same failure at the other end
  of the run. It is the phase, or, if the session never named one, its last line
  of output drawn in the mono face. The fallback is not dressed as a caption on purpose: an
  instruction can be overridden and a rule can be ignored, and a stray line of install output
  presented in the voice of a milestone invents the one thing this row is for. Drawn only while
  `starting`, for the reason the phase is cleared at the same moment.
- **The tail is polled while the run is live**, on a tick derived from the cockpit's own clock. It is
  off the snapshot, so nothing else would ever refetch it. The prop that fetches it is also a fresh
  closure per render and so polls incidentally — the explicit tick is there because a `useCallback`
  upstream is a reasonable thing for somebody to add and would silently freeze the log.

## Persistence

`local_runs`, one row per run, `src/store/localRuns.ts`. `id`, `origin_ref`, `ref`, `dir`, `pid`,
`status`, `url`, `note`, `started_at`, `ended_at`, and the six usage columns
(`cost_usd`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`,
`num_turns`) — all nullable, all declared in `LOCAL_RUN_COLUMNS`, because the table predates them.
`local_run_cost_deltas` holds the dated deltas beside it. Which statuses count as **live** is declared once,
in `LIVE`, and the SQL derives its `IN` clause from it — it used to be written out as
`('starting', 'running')` in three statements with `LIVE` read by nobody, and adding a status to three
of the four is silent in both directions: missed by `liveLocalRun` the store lets a second run begin
beside a live one, and missed by `endStaleLocalRuns` a row stays live across every restart for ever.
`describeRun` in `src/mcp/desktopTools.ts` had a fifth copy and now calls `localRunIsLive`.
A brand-new table needs no `ColumnMigrations`
entry — but a table being new *once* does not keep it exempt
([14](14-persistence.md#migrations)), which is exactly what the usage columns cost: this table was new
in #451 and had no entry, and the columns added in this change needed one. `url` is frozen as configured when the run started, so a later
config edit does not rewrite what a past run reported.

## Tests

`test/localRun.test.ts`: a stop runs the instruction and only then reaps; a stop with nothing configured
says what it could not do and names the field; a stop that never finishes is killed at the bound and
says it was not confirmed; a stop with no session left spawns one in the run's own checkout; a swap does
not touch the checkout until the stop has settled; a `stopping` row is live and a restart settles it;
the shutdown path runs no turn and records that it did not. Then: the default is the **tip** and the options are in plan order; a merged,
retired or concluded part is never the tip but stays on offer; an override runs an earlier part and one
that is not the goal's is refused with the goal named; the refusal names the field that fixes it; a start prepares the checkout,
writes the row and appends the rules; a merged goal runs from the integration branch; the turn ending
is the environment up and kills nothing; a failure keeps what the session last said; a stop reaps
before it signals, asserted as an **order** rather than as a pair; a second goal supersedes the first;
a restart settles what it cannot vouch for; the newest `phase:` line is the stage and the output
between two of them leaves it standing; what the session spends lands on the run and a cumulative second report is not
counted twice; a teardown by a **fresh** session adds to the run rather than replacing it; a run that
reported nothing stays unmeasured; a local run's money is in the rolling window, dated, and not among
the agents' own deltas; a database from before the usage columns reads them as null and can still be
written; the stage goes when the environment comes up and when the run
is stopped; `localRunRef`'s two arms; and — against a real repository — that a change of ref keeps
ignored files and drops everything else, and that an unresolvable ref leaves the checkout untouched.

`test/stateSnapshot.test.ts` covers the rows: a goal with two pull requests on two branches gets the
one **on the ref**, the tip is the later part, the merged part keeps its own PR in `options`, and a
goal nothing has started is `runnable: false` with a null PR. `test/console.test.ts` asserts the panel
names every ref it offers.

`test/hub.test.ts` covers the wiring from the other side: fifty `changed` events produce **one**
refetch, and none of them inside the window. That anything is subscribed at all is half of what it
asserts — nothing was, and nothing about it was red.

`test/validationDesktop.test.ts` covers the tool: what it reports, that starting a second goal stops
the first, and that a deployment with no instruction is refused with the field named.
