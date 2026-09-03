# 23 — Local runs

`src/localRun/`. The machine's **one** dev environment: which goal's code is in it, the process holding
it up, and the controls that change either: start, stop, a message to the session holding it, and a
refresh of the code under it. Always constructed; with
`localRun.instruction` unset every start refuses with that as its reason.

A validation check says "open the page and click the thing" ([20](20-validation.md)). Nothing in that
document said how to get the page up, and the planner who wrote the check is the one part of the
deployment that cannot know: it read the repository, not the operator's machine. So the check reached
the machine with the browser and the login and stalled on the one fact nobody had written down.

This is that fact, plus the thing that acts on it.

## What it is not

| Not            | Because                                                                                                                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A deployment   | Nothing here reaches a server, a registry or an environment. It runs the project on the machine the harness is on.                                                                                                                |
| A fleet agent  | No task row, no dispatch, no cap. Rule `local-validation` reads the live row to know whether an environment it was pinned to is still up ([32](32-local-validation.md)), and nothing else in the pipeline knows local runs exist. |
| A test run     | `npm run check` runs on every branch. This is a person looking at a screen.                                                                                                                                                       |
| A health check | `running` means the session that brought it up did not fail. The watch probes the declared **port** and compares the checkout to its branch ([below](#watching-the-environment)); **nothing exercises the application.**          |
| A queue        | One environment, so one run. Starting a second thing is stopping the first, and there is no route that means anything else.                                                                                                       |

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
  `currentLocalRun()` is the live one _or the last that ended_, which is what the panel draws.

## The instruction is config, not a prompt

`localRun.instruction` — free text, what the session bringing the environment up is told —
`localRun.stopInstruction`, what the session taking it back down is told, `localRun.resumeInstruction`,
what a session bringing an interrupted one **back** is told, `localRun.resumeWindowMs`, how long after
an interruption that is still worth doing, `localRun.refreshInstruction`, what the session is told once
the checkout under a running environment has been moved to the tip of its branch, and `localRun.url`,
where the application lands. All six are **live fields**
([02](02-configuration.md#liveness)): an edit on the Config page applies to the next start with no
restart. They sit under **Features** there, beside the other policy objects, and `localRunRoot` under
**Paths** — which is a thing `GROUPS` in `src/server/runningConfig.ts` has to be told: a declared key
in no group is drawn nowhere, because the group loop never reaches it and the "Other" fallback skips
it precisely _because_ it is declared. `test/configFields.test.ts` asserts every declared key is
claimed by a group, since the symptom is a field that validates, applies, and is invisible.

It began as a prompt id (`local-run`), on the argument that _how a project starts_ is the operator's
opinion and the prompt book is where this repo keeps those — the same argument that puts
`finding-ticket` and `docs-change` there. What moved it is the editing story. Prompt overrides are a
file drop that takes effect at the next boot, and are read-only in the cockpit **on purpose**
(`src/server/routes/state.ts`: a write route "would have to answer 'when does this take effect', and
the honest answer — at the next restart — is worse than not offering it"). This is the one
instruction an operator corrects _while_ a start is failing in front of them, and bouncing the
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

- **Outside `worktreeRoot`.** `slots()` counts every _registered_ worktree under that root whatever
  the directory is called, so a preview checkout in there would count toward the pool's bound and be
  handed to an agent — wiped `git clean -ffdx` on the way. **`loadConfig` refuses the overlapping pair
  rather than leaving the default value to hold this up** ([02](02-configuration.md)), in either
  direction and including the two roots being the same path.
- **Ignored files survive a change of ref.** That wipe is right for an agent's branch and wrong here:
  it would make every swap between goals pay a cold dependency install, which is the whole thing a
  kept checkout is for. `ensurePreview` cleans `-fd`, so `node_modules` and build output stand.
- **No lease.** The lease keeps two agents out of one directory; there is one local run, and the store
  row is what makes that true.

Three orderings inside it were wrong before the current one, and each failed differently: comparing
`git worktree list` paths to decide whether the checkout exists breaks where a short-name TEMP
resolves to a different string for the same directory (`worktree add` then says "already exists" about
a tree that was ready); `switch` before the tree is clean refuses outright when the last run left a
tracked file edited; and `reset --hard` on a checkout somehow standing on a branch would rewind _that
branch_, the damage `git switch -C` is banned for. So: existence check, `checkout --detach`,
`reset --hard <commit>`, `clean -fd`. An unresolvable ref throws before anything is touched.

## Which ref, and what else is on offer

`localRunChoices` (`src/localRun/ref.ts`, pure) answers it: the **default**, everything else the goal
could be run at, and how much of the plan has landed.

The default is the **tip of the stack** — the furthest-along part with a branch, `merged`, `retired`
and `concluded` skipped. Plan order _is_ stacking order, since a part is cut from its predecessor's
branch, so the last unmerged one contains everything behind it.

Failing that, the goal's **own** branch, resolved by the same `openPrForIssue` the pickup verdict uses
— its conventional `issue/<n>` or whatever its linked pull request is on. A goal nobody decomposed has
its whole work on one pull request, and this feature could not see those goals _at all_: no parts meant
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
there, so none of them is a sane _default_, and looking at what a merged part delivered is a
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

- **The turn ending is the environment being up, not the run being over.** `done`, `waiting` and
  `stalled` all mean "it stopped talking and did not fail", and the status goes to `running`.
  **`stalled` is the one that actually fires**: the session carries no protocol prompt, so it never
  prints a sentinel, and the stream runtime announces a sentinel-free turn end as `stalled` rather than
  `waiting` ([10](10-agent-runtimes.md)). For three revisions nothing here listened for it, and on a
  `stream` deployment the row sat in `starting` for the life of the environment while every stop waited
  out its bound. `limited` — the account running out mid-turn — ends the turn too, with an error recorded
  beside the `running` it writes. `TURN_ENDED` in `runner.ts` is the one list, read by both places that
  wait for a turn. Nothing is killed — a runner that treated `done` as terminal would kill the thing the
  run exists to hold.
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

1. The row goes to **`stopping`**, which is a _live_ status: a run being taken down still holds the
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
runs _in_ the checkout — `docker compose down` reads the compose file that is in it — and
`ensurePreview` is a `reset --hard` and a `clean -fd` on the same directory. Preparing first pulls the
project out from under the session being asked to shut it down. The cost is that a checkout which
cannot be prepared now fails with the previous environment already gone, so that refusal says so.

**The stop turn is not the run coming up.** The bring-up's handlers are keyed on the run id, and the
stop's turn ends in a `done` like any other — which `up()` would read as "the environment is up".
Dropping the id as the stop begins is the one switch that keeps the two apart; without it a stop
writes `running` on its way out.

Shutdown takes the **fast path** deliberately — `stopFast`, which reaps and kills without a turn.
Ctrl-C and the upgrade handoff are the two paths that must not hang, and an upgrade is a restart. The
cost is a container that can outlive the harness, which is the whole subject of the next section.

## Coming back after a restart

A row saying `running` at boot is not a run. The pid in it belongs to a dead parent, or worse to
whatever has since been given that number, so nothing may go on trusting it — and for three revisions
what followed from that was a sweep: every live row settled, with a note saying the stop instruction had
not run.

The sweep was right about the row and wrong about the machine. `stopFast` reaps the session's subtree,
which takes the dev server with it — and cannot touch a Docker container, which belongs to the daemon,
or anything the start handed to a service. So what a restart actually leaves is **half an environment**:
the containers up, the server gone, and a row in front of it saying `stopped`. An operator who closes
the harness, or clicks Apply on a config change, is several minutes and a Start click from having their
environment back, every time, for a reason that had nothing to do with them.

`LocalRunner.resumeInterrupted` is the other half of the question the agents' recovery hold answers:

- **It is a third instruction, not a re-run of the first.** A start is handed a machine with nothing of
  this project up on it. A resume is handed one where the last session was reaped mid-flight, and the
  honest thing to do with what survived is to **attach** to it rather than bring a second stack up beside
  it. Only the project knows which of its pieces survive a reap, so `localRun.resumeInstruction` is the
  operator's sentence to write too — a `continue` beside their `start` and `stop`. Blank
  means the old behaviour exactly: the row settles, saying that nothing was configured to bring it back
  and naming the field that would.
- **`stopFast` leaves the row live when the deployment can bring it back**, and settles it when it
  cannot. That is the only record that there is an environment to come back to: the note the settle used
  to write was a sentence for a person, and nothing can act on prose. It also drops the run id before it
  kills, because the wired `exit` handler settles a run whose session dies while it is meant to be up —
  right everywhere except here, where the session dying _is_ the shutdown, and a `failed` written on the
  way out is a row the next boot would refuse.
- **It is only worth doing while the interruption is recent**, which is `localRun.resumeWindowMs` —
  two hours by default. Everything above argues for a resume from a _restart_: the operator is a
  minute from wanting their environment back, and the containers the reap could not touch are still
  up. A harness that was off overnight has neither — the machine has very likely been rebooted,
  there is nothing left to attach to, and what the boot does is spend a session bringing up an
  environment nobody asked for and nobody is watching. The row says live in both cases, which is why
  the age has to be **recorded rather than inferred**: `stopFast` stamps `local_runs.interrupted_at`
  as it leaves, `resumeInterrupted` judges the row on it, and a resume clears it again on the way
  back up so the next interruption is not dated to the last one. `started_at` is no substitute — a
  run brought up on Monday and still in use this afternoon is not stale. `0` turns the bound off,
  which is the behaviour before there was one. → [#682](https://github.com/AdamAwan/LubbDubb/issues/682)
- **A shutdown stamp alone would refuse exactly the crashes a resume is for.** `stopFast` runs on a
  Ctrl-C and on the upgrade handoff, and on none of `taskkill /F`, Task Manager's End task, a power
  cut, or — before this — a console window closed on Windows. Those take the process without running
  a line, so the row is live and `interrupted_at` is null, and a null read as _unknown_ settles the
  one case an operator most wants back: they killed the harness two minutes ago. So the pulse dates
  it too. `LocalRunner.noteAlive`, called once a beat from `Harness.runCycle`, stamps
  `local_runs.last_seen_at` — and the resume judges `interruptedAt ?? lastSeenAt`, so a clean
  shutdown gives the exact instant and a kill falls back to the last beat, accurate to one heartbeat,
  which is all a two-hour window needs. Three things make it safe:
  - **Only while `runId` is set**, which is this process's claim on the row — dropped by a stop, and
    never held for a row a boot declined to bring back. Stamping "whatever is live" instead would
    date the row a boot had just refused, and the boot after that would bring back an environment
    two harnesses ago, freshly dated.
  - **Above the pulse's recovery hold**, because the stamp says the harness is alive and that is true
    of a held pulse too. Below it, a harness held on a recovery decision for three hours and then
    killed would leave a run dated three hours back and never come back.
  - **Both stamps null is still unknown, and still refused.** Every row a running build writes is
    dated by one or the other, so that shape belongs to a hand-edited database — and the safe
    direction there is unchanged.
  - **The stamp is the runner's clock, passed in**, exactly as `markLocalRunInterrupted`'s is.
    `staleness` measures the column against `deps.now`, so a stamp taken from the store's own clock
    made the age the difference between two clocks — identical in production, and whatever the wall
    clock happened to say anywhere one of them is injected.
    `SIGHUP` and `SIGBREAK` are handled in `main.ts` beside `SIGINT` for the same reason: closing the
    console window was taking Node's default path, which reaps no agent and dates nothing.
- **A `stopping` row is settled, not resumed**, however the deployment is configured. A teardown in
  flight is an operator who asked for this environment to go away; bringing it back answers the
  opposite of the last thing they said.
- **Nothing is prepared.** `ensurePreview` is a `reset --hard` and a `clean -fd`, and running it here
  would pull the project out from under containers that are still up — the swap's stop-before-prepare
  hazard pointed the other way. The checkout already stands at the run's own commit, since
  `ensurePreview` is the only thing that ever touches `localRunRoot`. A checkout that has _gone_ is
  checked for rather than discovered through the spawn: a bad `cwd` surfaces as an async spawn error
  rather than a throw, so a resume would report success and then not have happened.
- **It is the same run continued, not a second one.** The row's id and its `started_at` stand, so the
  panel's clock keeps running from the original start and the money accumulates onto one run — the
  resume session's usage lands the way a teardown session's does. The tail and the stage are dropped,
  because they belonged to the session that printed them.
- **Called from `main.ts`, below the shutdown handlers**, and not from `buildSystem`: it can spawn a
  session, and everything that can is below that line
  ([21](21-self-update.md#where-the-shutdown-handlers-are-registered)). The cost is that the row reads
  live for the length of a boot, which is the truth of it — it is about to be.

The turn ending means the environment is up again, exactly as it does on a start: the bring-up's
handlers are wired, not a stop's.

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

### Which turn is in flight

`LocalRunner.turn()` — `start`, `stop`, `refresh`, `message` or null — ships as `LocalRunView.turn`. The
row's status says the first two; it cannot say the other two, which happen on top of a `running` row.
Set where each turn is sent and cleared where any turn ends — the same `up()` a bring-up ends through,
whose `running` is idempotent — on settle, and on the fast stop. The panel draws the stage line for
exactly as long as it is non-null, captioned with the turn, and the runner refuses to begin a second turn
while one is in flight: a stream session would queue the message behind the running turn, and the panel
would caption the wrong one.

## Watching the environment

`LocalRunWatch` (`src/localRun/watch.ts`): the first thing about the run that is **observed** rather than
presumed. Everything else the panel draws is what the session said or what the row records. Two
readings, both on `LocalRunView`, both **three-valued** — a null is "could not say", and is never folded
into an empty list or a zero, which would draw a reading nothing took.

- **Ports.** `localRun.url` parsed for a host and a port (the scheme's default where none is written),
  and a TCP connect with a one-second timeout: `declared.answering` is that the port is held, and nothing
  more — not that the application behind it works. Beside it, every TCP port **this run's own processes**
  are listening on, through a `PortLister` (`src/localRun/ports.ts`): PowerShell's
  `Get-NetTCPConnection` and `Win32_Process` on Windows, `ss -ltnp` and `ps` on POSIX with `lsof`
  behind `ss`, joined by `owners`. **Windows hands its two tables back base64-encoded**, because the
  raw ones did not survive the trip: `ConvertTo-Json` escapes every C0 character a command line can
  carry, and an operator still hit `Bad control character in string literal ... at position 77337` on a
  table PowerShell had serialised correctly. What a console does to a 150KB line depends on the code
  page, the host and the redirection, none of which is the harness's to pin down — so the payload is
  plain ASCII and there is no byte left for anything in between to mistranslate. Containers never
  appear — a mapped port belongs to the daemon, not
  to anything the session started. `listening: null` is the lister not being able to say. The real
  lister follows the reaper's rule and is wired only beside a real transport: it reads the host's
  process table, and a fake transport mints pids that belong to other people's processes.

  **Which processes are the run's is decided by the checkout, not by the process tree**, and that is
  the whole correctness of the reading. It was the tree first, and against a real dev environment it
  reported nothing at all: the instruction launches each service in its own shell, that shell exits,
  and Windows does not reparent an orphan — so every one of the NXG stack's six services recorded a
  parent pid that no longer existed, and a walk from the session's pid reached none of them. A command
  line naming `LocalRun.dir` survives that, and is the discriminator the operator's own runbook already
  uses to tell one worktree's stack from another's. It is the sharper reading twice over: two checkouts
  of one project on a laptop hold different ports and each is attributed to its own run, and a run whose
  session this harness no longer holds — what a restart leaves — still reports its ports. The subtree
  stays as a backstop for a process whose argv does not happen to name the path; it costs one field of
  a table already being read. The match is case- and separator-insensitive, and requires a separator
  after the directory, so a run in `…/local-run` never claims the ports of one in `…/local-run-2`.

- **Freshness.** The run records the commit the checkout stands at (`commit_sha`, written by the start
  and rewritten by a refresh — `ensurePreview` reports it, and `previewCommit` resolves it without
  touching the tree). `behindTip` is `GitObserver.divergence(ref, commit).ahead`: the commits the branch
  has that the checkout does not, which is an agent having pushed since the start. `base` is the branch
  this ref was cut from — a part's from `partBase`, the goal's own branch's from its pull request, none
  for the integration branch — and how many of its commits the ref lacks. Every count is null where the
  clone cannot say, the review pack's rule ([31](31-review-packs.md)). Before comparing, the watch
  fetches, floored by `planning.gitFetchIntervalMs` and only when the observer is real — and it is then
  the only thing keeping `origin/*` fresh on a deployment with no active plan, since the reconciler
  fetches only while it has plans to reconcile.

Three things about how it runs:

- **Its own timer, not the pulse.** The cycle is thirty seconds busy and five minutes idle, and an
  operator watching a bring-up wants to see the port come up in seconds; the local run is also, by
  design, nothing the dispatcher knows about. Ports every ten seconds, git every minute, and a reading
  straight after the runner announces a new run or a new status — a bring-up that has just ended is
  exactly when somebody is looking. Armed from `main.ts` beside `resumeInterrupted` and stopped in
  `shutdown`, never in `buildSystem`: every test builds a `System`, and an armed interval would hold
  `node --test` open while the real lister ran PowerShell on a developer's machine.
- **Its own class, not the runner's.** The runner holds the process and must never block on git or a
  socket; this blocks on both, on purpose, off to one side.
- **`changed` only when a reading changes**, `checkedAt` excepted. It rides the hub's local-run
  coalescer ([16](16-http-api.md#the-hub)), so a port coming up in the same 400ms as a phase line is
  one refetch — and a steady environment read every ten seconds costs no snapshot at all.

The snapshot ships the readings only while the run is live. The watch clears them itself, but a view
that trusted that would draw a stale port beside a stopped run for the width of one tick.

## Talking to the environment

`LocalRunner.send(text)`, `POST /api/local-run/message`, and `message` on the desktop `local_run` tool
— the fleet's `AgentManager.respond` ([10](10-agent-runtimes.md)) for the one session that is not an
agent. For the things a running environment needs told that are not a restart: run the migrations,
restart one service, pick something up.

Refused with the reason returned, never thrown: while nothing is live; while the run is being stopped;
while it is still coming up — a stream session queues the message behind the bring-up turn, so `running`
would arrive only when the message turn ended and the panel would say "starting" for a turn it never
saw; while another turn is in flight, for the same reason; and when nothing holds the session, which is
a restart that could not bring the run back — the row is live, the environment may well be up, and there
is nobody to type to. `holdsSession` ships on the view so the panel offers the box only when there is
somebody.

**Echoed into the tail.** The stream runtime renders only what comes back, so without the echo a
message leaves no trace on the one surface the operator is watching; the PTY runtime records both halves
itself and says so with `recordsSentMessages`. One `takeIn` path for what a session prints and what is
typed into it, so the echo rolls off the top with everything else.

## Refreshing the code under a running environment

`LocalRunner.refresh()` and `POST /api/local-run/refresh` — the half of staleness the harness can act on,
and a click, **never automatic**: `ensurePreview` is a `reset --hard` and a `clean -fd` under a running
server, and an operator halfway through looking at a page is owed the choice.

In order: refuse unless the run is `running` with no turn in flight; `previewCommit(ref)`, which resolves
and touches nothing — a refresh at the tip refuses here, and had to find that out somewhere other than
`ensurePreview`, which would already have reset and cleaned the tree to move it nowhere;
`ensurePreview(ref)`, with everything git ignores left standing so dependencies survive; the row's
`commit_sha` rewritten; then the session is handed `localRun.refreshInstruction` — the operator's
sentence, blank allowed, since a hot-reloading dev server needs nothing said — with the harness's own
account of what moved appended: which ref, from which commit to which, restart or rebuild what needs it,
keep it up, do not commit, `phase:` lines. Those facts are the harness's words after the operator's
verbatim text, which is not the interpolation the template rule bans: nothing here is overridable.

A tree that will not move — a file held open on Windows — leaves the recorded commit alone and says the
tree may be part-reset, because it may be. With nothing holding the session the checkout still moves and
the note says nobody was told. A run stopped or swapped under the two awaits is noticed before anything
is written or sent.

Behind its **base** is the other half of staleness, and it is fleet work: the fix is merging the base in,
which `pr-base-update` already dispatches off the provider's `mergeableState` where the ref has a pull
request ([05](05-dispatcher.md)). The panel says it; nothing here acts on it.

## What it costs

A local run is a Claude Code session, and a long one: it holds the environment for as long as somebody
is looking at it, and its teardown is a second turn. That is money on the same account the fleet is
billed to, and for the feature's first three revisions no surface in the cockpit had heard of it.

The reading arrives for free. The stream runtime emits `usage` at every turn end — cumulative cost,
tokens and turns off the `result` event ([10](10-agent-runtimes.md)) — and the runner now listens:
`absorb` takes a session's usage the same way it takes its output. The PTY runtime has no such channel,
so **every local run of a `agentMode: 'raw'` deployment is unmeasured**, which is the null the columns
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
- **On the goal**, folded into `Issue.spend` — a local run's origin _is_ the goal, so it attributes by
  name with no lineage hop ([18](18-observability.md#per-goal-spend)). The count is
  `IssueSpend.localRuns`, kept apart from `agents` because the goal page prints that figure as
  "Agents" and a local run is not one.
- **In the spend breakdown**, as the `local` phase — its own row in the partition, so "what is
  previewing costing me" is answerable and the phases still sum to the total.
- **In the 5h/7d gauges and the pets' beats**, because `Store.sumUsageCostSince` adds both tables.
  One figure for what this deployment spent; the panel and the gauge an operator opened it from cannot
  disagree.

## Three triggers, one owner

| From                  | How                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| The cockpit           | The **Local** reading in the top bar, opening the running-locally panel                              |
| The operator's Claude | `local_run` on the desktop channel ([11](11-mcp-tools.md))                                           |
| Validate locally      | A goal's own control, which starts a run and then puts an agent on it ([32](32-local-validation.md)) |

Both reach the same runner, which is the point: the tool used to render an instruction and let the
session act on it, so there were two definitions of what running meant and a harness that could not
stop what it had told somebody to start.

`local_run` reports the state, given a goal starts it, and given a `message` types it into the session
holding the environment. Its reply carries the readings and the caveat in as many words — the port may
be probed, but the application is not exercised — because a session reporting a check passed on the
strength of a status, or of a port answering, is the one outcome the validation channel exists to
prevent.

## Routes

`src/server/routes/localRun.ts`, a module and a `ROUTE_MODULES` entry. Every handler wrapped in
`checked(schemas, handler)`; a refusal is a returned 400 carrying the reason, never a throw
([16](16-http-api.md#request-validation)).

| Route                         | Does                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/local-run`         | `{issue, ref?}` — start it on that goal, stopping whatever was running.                                                       |
| `POST /api/local-run/stop`    | No body and no id: there is one run, and stopping it is the request. Answers as soon as the teardown has begun.               |
| `POST /api/local-run/message` | `{text}` — type into the session holding the environment. A 400 with the reason when there is nobody to tell.                 |
| `POST /api/local-run/refresh` | No body: move the checkout to the tip of the run's ref and tell the session what moved. Awaited — seconds of git, not a turn. |
| `GET /api/local-run/output`   | The session's last lines.                                                                                                     |

Stopping **answers before it has finished**, because it is a session's turn: the run goes to
`stopping` and the runner's own `changed` events carry the rest. Awaiting the turn in the handler would
hold a request open for up to two minutes.

`ref` runs an earlier part of the goal instead of the tip of its stack. The schema checks its
_shape_, and the runner checks that it is one of **that goal's** part branches — a question about the
plan, so it is asked where the plan is. A schema that took any string and a runner that trusted it
would make this route a way to check out anything in the repository.

The output has its own route rather than riding the state snapshot: the tail is up to two hundred
lines and the snapshot ships on every heartbeat and every `dirty` — which includes every file an agent
writes — so putting it there would pay for a log nobody has open. The same argument keeps the work
graph and the prompt book off the snapshot. **No route here runs a cycle**: a local run schedules no
work and changes no world.

## The cockpit

A **Local** reading in the top bar's `cn-reads` row, quiet when nothing is up, carrying the goal's
number when something is — and amber when the environment is behind the tip of its own branch, because
the panel is where you find out and the reading is where you would not think to look. A reading rather
than a nav tab: it is a state of the operator's own machine, not a surface work happens on. The number
is the value because that is the question — "running" alone leaves an operator opening the panel to
find out whether it is the goal they are looking at.

The card also carries **Validate #N** while the environment is running and idle — the same control
the goal page offers, on the environment it is about ([32](32-local-validation.md#the-cockpit)). The
swap question cannot arise there, since the run in front of it _is_ the goal, so the only question
left is the stale one; a validation in flight draws its stage in the same line the run's own turns
use.

The panel (`web/src/components/LocalRunPanel.tsx`) is `'localRun'` on `ConsolePanel`, so it is a
**place**: it survives a reload and the back button steps out of it
([17](17-cockpit.md#the-address-bar)). It is a **card and two folds**, never a table of runs — a list
would imply two could be up.

The card is the environment, and the only thing that moves while somebody is watching: a status dot
and word with a mono clock (green up, amber a turn in flight, red a start that failed, muted otherwise),
the goal and its title, the ref and the short commit, the branch's own reading (below), the stage line
for as long as a turn is in flight — captioned `starting`, `stopping`, `refreshing` or `replying` — the
note, then the readings as **tiles**: the URL with whether its port answered, the ports the session's
own processes hold, how far the checkout is behind its tip and its base (amber when behind, with the
Refresh above answering it), and what the run has cost. Each tile words its nulls — "not checked",
"could not read", "could not compare" — and never draws a zero for one. Under the tiles, the reply box,
offered only while an idle session is held.

**Controls say what they are.** Stop is `ConfirmButton`, the danger button with the two-click arm,
because a mis-click costs a warm environment and several minutes; it is not drawn while stopping, since
the status line already says so. Refresh is primary and drawn only while there is something to pick up.
Start appears once a row is picked, primary, with the ref beside it. Nothing on the panel is ever
disabled: a control that would be is absent, and the stage line says why.

The output and the picker are `<details>` folds under the card. The output is open while a turn is in
flight or the run has settled — the cases with something to read — and folded under a steady
environment, its summary carrying the last line; the picker is open when nothing is running and folded
under "Run a different goal", with "stops what is running now" beside it, when something is. `<details>`
rather than conditional rendering, so the browser draws the fold and the markup carries the content
whichever way it stands — controlled from the summary's click rather than `onToggle`, which fires for a
programmatic open too and would read a turn opening the output as the operator asking it to stay open — which is also what keeps `test/console.test.ts`'s assertions on the
rows true with the picker folded, since `renderToStaticMarkup` runs no effects. The output is the
session's own words in the fleet's transcript pane, see below.

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
match a branch to a PR itself, but deciding _which of a goal's PRs speaks for a ref_ is the mistake
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
tidiness: the count was taken over the _targets_ while the rows were taken over the join of the goals
on screen and their targets, so the two could disagree — and in the case that mattered they disagreed
the wrong way round. Nothing drawn, nothing hidden by the count's reckoning, so no checkbox, under a
message that said there was nothing to run. Both now read `holdingBack`, the difference between the
candidates and the rows, so the arm that says "tick it" is only ever drawn when it is there to tick.
The other arms tell the two remaining cases apart — no goals on screen at all, or goals with nowhere
to run — because "nothing to run" reads as a hidden filter to anybody who has just been offered
one. The selection, the expander, the filter and the two folds are local state and not `Place`: which
row is highlighted and which fold is open are not _where you are_, and the panel itself is the place.

Three details are about the minutes a start takes rather than the state it ends in:

- **The elapsed time is a clock, not "3m ago".** Rounded relative time sits on one value for ninety
  seconds, which on the one surface an operator is watching reads as a frozen screen. `stopping` gets
  no clock: the only timestamp on the row is when the _run_ started, and "Stopping · 18:04" reads as a
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
- **The tail is drawn in `TranscriptPane`, the same pane the fleet's transcripts use**
  ([17](17-cockpit.md#the-agent-drawer)). A local run is a session and `absorb` takes its `output`
  event, so what this holds is `renderBlocks` output — the identical bytes the drawer renders, ANSI
  colour and `⚙` / `↳` markers and all. It went into a `<pre>` first, which put the escape sequences on
  the glass as literal text and every tool call at full length, on the one surface there is to read when
  a bring-up did not work. The pane translates the colour and folds each call to a line, so the
  session's account of what it did is the spine and the output of any one step is a click away. The
  wrapper carries `compact`, which caps it at the panel's height rather than letting it fill the way it
  does in a drawer.

  The tail rolls at two hundred lines, so once it is full every poll drops lines off its top and the
  pane reseeds rather than appending — correct, since those lines are gone, at the cost of blocks
  coming back collapsed while a bring-up is still printing.

## Persistence

`local_runs`, one row per run, `src/store/localRuns.ts`. `id`, `origin_ref`, `ref`, `dir`, `pid`,
`status`, `url`, `note`, `started_at`, `ended_at`, `commit_sha` — where the checkout stands, written by
the start and rewritten by a refresh, named so because `COMMIT` is a keyword, null on a row from before
it and needing no backfill since nothing refuses on it — and the six usage columns
(`cost_usd`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`,
`num_turns`) — all nullable, all declared in `LOCAL_RUN_COLUMNS`, because the table predates them.
`local_run_cost_deltas` holds the dated deltas beside it. Which statuses count as **live** is declared once,
in `LIVE`, and the SQL derives its `IN` clause from it — it used to be written out as
`('starting', 'running')` in separate statements with `LIVE` read by nobody, and missing a status is
silent in both directions: missed by `liveLocalRun` the store lets a second run begin beside a live
one, and missed by `beginLocalRun`'s supersede a stopped row is left claiming to be up for ever.
`describeRun` in `src/mcp/desktopTools.ts` had a fifth copy and now calls `localRunIsLive`.
A brand-new table needs no `ColumnMigrations`
entry — but a table being new _once_ does not keep it exempt
([14](14-persistence.md#migrations)), which is exactly what the usage columns cost: this table was new
in #451 and had no entry, and the columns added in this change needed one. `interrupted_at` and
`last_seen_at` are declared there too, and the first needs a **backfill** beside the `ALTER TABLE`:
with both null the resume reads the age as unknown and refuses, so the columns alone would cost the
operator taking this build the environment they had up at the time
([14](14-persistence.md#when-a-null-means-something)). `url` is frozen as configured when the run started, so a later
config edit does not rewrite what a past run reported.

## Tests

`test/localRun.test.ts`: a stop runs the instruction and only then reaps; a stop with nothing configured
says what it could not do and names the field; a stop that never finishes is killed at the bound and
says it was not confirmed; a stop with no session left spawns one in the run's own checkout; a swap does
not touch the checkout until the stop has settled; a `stopping` row is live and a restart settles it;
the shutdown path runs no turn and records that it did not; a restart with nothing configured to bring a
run back settles it and names the field that would; a restart with an instruction brings it back in the
run's own checkout, prepares nothing, continues the same row and reads the turn ending as the
environment up; a `stopping` row is settled even by a deployment that can resume; a run whose checkout
has gone is not brought back; a run interrupted longer ago than the window is not brought back and
the note says how long ago, what may still be up and which field sets it, while one interrupted
inside the window comes back and has its stamp cleared; a force close — no shutdown, one beat of the
pulse — is dated by `last_seen_at` and comes back ten minutes later but not five hours later, with a
note that says "last holding it" rather than "interrupted"; a boot never dates a run it declined to
bring back; a row with **neither** stamp is unknown rather than recent and is not brought back; a
zero window is no bound at all; the boot that adds the stamp dates the row it is upgrading over, so
taking this build does not cost an operator the environment they had up; a pulse at the `buildSystem`
seam re-dates a backdated row; the stamp sits above the recovery hold, asserted structurally because
the two orderings are indistinguishable on any pulse that is not held; and nothing live is nothing to
do. Then: the default is the **tip** and the options are in plan order; a merged,
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

`test/validationDesktop.test.ts` covers the tool: what it reports — now with the commit, the turn,
whether a session is held and the readings — that starting a second goal stops the first, that a
deployment with no instruction is refused with the field named, and that a `message` is relayed or
refused with the runner's own reason, and never combined with `issue`.

Added with the watch, the message and the refresh, in `test/localRun.test.ts`: a turn that ends with no
sentinel is the environment up; a stop whose session stalls still settles, reap before kill; the turn
reads `start`, null, `stop`, null across a run; a start records the commit; an old database reads it as
null and can write it; against a real repository `ensurePreview` reports the commit it stands at and
`previewCommit` resolves without touching the tree; a message is echoed, handed to the session and is a
turn until it ends; a message is refused while starting, while busy, while stopping and when nothing
holds the environment; a session that records what is sent is not echoed twice; a refresh moves the
checkout, records the commit and tells the session what moved, resolving before it touches; a refresh
at the tip refuses without touching the checkout; a refresh is refused while starting, while a turn is
in flight and during a stop; a checkout that will not move leaves the recorded commit alone; and a
refresh with nothing holding the environment moves the checkout and says so.

`test/localRunWatch.test.ts` covers the readings: nothing live is nothing read; the declared URL is
probed and the tree listed; every null means what it says (no port in the URL is the scheme's, no URL
and a bad URL are `declared: null` with nothing recorded, no pid and an unset lister are
`listening: null`, an unfetched ref and a row without a commit are null counts, the integration branch
has no base, and git throwing is recorded once); git runs on its own cadence and ports on every tick;
the fetch runs once per interval and a failure is recorded once; a change of run clears the readings and
asks again at once; a settled run takes its readings with it; identical readings are not announced; the
runner announcing a new run or status nudges a reading; and the pure parts — the parent-pid walk with a
cycle, the `ss` and `lsof` parsers, and `probePort` against a loopback server. `test/hub.test.ts`
asserts the watch's `changed` rides the local run's coalescer; `test/stateSnapshot.test.ts` that the
readings ship on a live run and not on a settled one; `test/console.test.ts` that the panel draws the
ports and the behind-tip count, offers Refresh only while behind, and offers the message box only while
an idle session is held.
