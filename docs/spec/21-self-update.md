# 21 — Self-update

`src/selfUpdate/`, `scripts/serve.ts`. **On by default** (`selfUpdate.enabled`,
[02](02-configuration.md#selfupdate)). The harness watching **its own build**, and applying an update
to it without losing the work in flight.

Everything else in this specification is about the codebase the fleet is pointed at. This is the one
subsystem about the process the fleet runs inside.

## The repo it watches is not `repoRoot`

`repoRoot` is the repository the harness operates on — where worktrees are cut, where agents commit.
The directory LubbDubb is _installed_ in is a different thing, and the two coincide only when the
harness is dogfooding itself. Running the app from its own directory against another repo is a
supported deployment and is resolved for explicitly at load ([02](02-configuration.md#paths)), so an
operator working on some other codebase still wants to hear that LubbDubb moved.

So the root here is resolved by walking up from the running module's own path to the first `.git`,
and from nothing an operator can configure. `.git` is tested as a **path**, not a directory: a
checkout that is itself a git worktree has a `.git` file, which is how this repo's own agents run.

`selfUpdate.remote` and `selfUpdate.branch` are configurable, because a fork tracks somewhere else.
There is deliberately no key that points the watch at an arbitrary directory.

## The reading

`readBuildStanding` in `src/selfUpdate/buildStanding.ts`. One `BuildStanding`, all of it "as of
`checkedAt`":

| Field              | What it is                                                                  |
| ------------------ | --------------------------------------------------------------------------- |
| `head` / `branch`  | The install directory's HEAD, and the branch it is on (null when detached). |
| `upstream`         | The remote's tip for `selfUpdate.branch`, as `ls-remote` reports it.        |
| `behind` / `ahead` | Commits each side carries that the other does not.                          |
| `commits`          | What is waiting, newest first, capped at ten.                               |
| `dirty`            | Uncommitted changes to **tracked** files in the install directory.          |
| `unavailable`      | Why no reading could be taken, in the operator's words, or null.            |

**A failed reading is a value, not a throw.** A tarball install, an air-gapped machine and a checkout
with no `origin` are each a legitimate deployment; every one of them reads as `unknown` on the gauge
and none of them writes to the fault log. Only the reader itself breaking is a fault
([18](18-observability.md#the-error-log)).

### What it costs

Two shapes, and which one runs is the whole of the network policy:

- `ls-remote` runs every check. One round trip, no objects transferred, and it answers the only
  question asked most of the time — has the tip moved.
- A real `fetch` runs only when the tip _has_ moved **and** this clone does not already hold the
  object. So the steady state of an up-to-date deployment checking hourly is a single ref
  advertisement, and the expensive path costs what it costs once per upstream commit.

`selfUpdate.checkIntervalMs` (default one hour) is a floor on **network traffic**, not on how fresh
the served answer is: the standing is held in memory and served from there between checks, so opening
the panel costs nothing and always has something to show.

### Why this is not on `GitObserver`

[09](09-execution.md#worktrees) documents that seam as read-only and **fetch-free**, so its callers
own how often the remote is touched. This asks a different question about a different repository and
owns its own network policy, so it is a separate reader rather than a method there.

## Whether an update can be taken

`upgradability`, pure, in `src/selfUpdate/upgradePlan.ts`. Four refusals, each carrying its reason in
words — "why is the button off" is the whole of what an operator asks a screen that will not upgrade:

| Refusal        | Why                                                                               |
| -------------- | --------------------------------------------------------------------------------- |
| `unavailable`  | No reading was taken, so there is nothing to know.                                |
| `behind === 0` | The build is current.                                                             |
| `dirty`        | A pull over uncommitted changes to tracked files is not safe.                     |
| `ahead > 0`    | The update is not a fast-forward, and the supervisor applies it with `--ff-only`. |

`dirty` is read with `status --porcelain --untracked-files=no`, and the flag is load-bearing. The
supervisor applies an update with `pull --ff-only`, which an untracked file does not stand in the way
of — so counting one would take the upgrade button away, permanently and with no way back, over a
note an operator left in the install directory or a path a newer build writes that this checkout's
older `.gitignore` never learned. That falls hardest on the deployment furthest behind, which is the
one collecting stray files and the one that most needs the button. (It also kept the _reading_ off a
checkout with enough untracked files to overrun the pipe, which surfaced as "could not read the
install directory".) An untracked file the incoming commits would overwrite still refuses — but it
refuses in the supervisor, which leaves the old build in place and starts it again.

`ahead > 0` is a **refusal rather than a warning** deliberately. Offering a button that will fail in a
process the operator is no longer watching is worse than not offering it.

Note what is not here: whether anything is running. That is a question about _when_ to apply, not
whether, and it is the whole of what the drain answers.

## The intent

One row, `upgrade_intent`, id 1 ([14](14-persistence.md)). Four states:

| State      | What is true                                                                              |
| ---------- | ----------------------------------------------------------------------------------------- |
| `idle`     | No upgrade in progress. The resting state, and what a finished one returns to.            |
| `draining` | Dispatch is paused and the fleet is being allowed to finish. **No agent is interrupted.** |
| `ready`    | The drain finished: nothing is live, and the handoff is safe.                             |
| `applying` | The handoff was asked for and this process is going down for it.                          |

**It is persisted where `RuntimeControl` beside it is not**, and the reason is `applying`: that state
exists to be read by the process _after_ the one that wrote it. It is the message from the harness
that just went down to the one coming up, saying the agents it interrupted were interrupted
deliberately. Held in memory it would be gone at exactly the moment it is needed, and the whole
upgrade would land in the manual recovery panel — the friction the marker removes.

`pausedByDrain` records whether the _drain_ is what paused dispatch. It is load-bearing on cancel: a
fleet the operator had already paused themselves must stay paused, and a blanket un-pause would
silently start dispatching for them.

## The transitions

`applyUpgradeAction`, pure, so the route and the desk share one account of what is legal rather than
each checking a subset. Three actions, and every refusal is a 409 with the reason
([16](16-http-api.md#the-harnesss-own-build)).

- **drain** — legal from `idle` on an upgradable build. Pauses dispatch and waits. A drain with an
  empty fleet goes straight to `ready`: a state that exists only to be left is not a state.
- **cancel** — legal from `draining` and `ready`. Restores the pause flag if the drain set it. Refused
  from `applying`, which is already going down.
- **apply** — moves to `applying` and hands off. **Refused while agents are live** unless
  `interrupt` is set. Interrupting is not lossy — the shutdown leaves every agent resumable and the
  next boot restores them — but it _is_ a decision, and one taken silently is one the operator finds
  out about from the fleet coming back different.

A drain does not become a handoff on its own. An operator who asked the fleet to wind down authorized
the wind-down; taking the process out from under them the moment the last agent finishes, possibly
hours later, is a second decision and stays theirs. `UpdateDesk.run` moves `draining` to `ready` on
the pulse that finds the fleet clear, and stops there — unless the operator has authorized both
halves in advance, which is the whole of `autoUpdate` below.

## Taking it unasked

`selfUpdate.autoUpdate`, **off** by default, `autoUpgradeStep` in `upgradePlan.ts`. One key rather
than two, because the two halves are not separately useful: a drain nobody applies is a fleet that
paused itself and stopped, which is worse than never draining at all. On, the desk asks for the same
two transitions the operator's two clicks ask for, in the same order, through the same `request`.

Nothing about _when_ is relaxed. The drain still waits — no agent is interrupted for an update that
arrived mid-run — and every refusal in `upgradability` still refuses: a dirty install, a build ahead
of its upstream and an unavailable reading are all "not this pulse", said in words on the panel
exactly as they are to a hand on the button.

Two things it will not do:

- **Nothing at all without a supervisor.** The handoff is an exit, and an exit with nothing in front
  of it to relaunch is the fleet going down and staying down — unattended, on a machine nobody is
  looking at. The manual path degrades to a printed command here; this one degrades to doing
  nothing, which is the same answer.
- **Never `interrupt`, except on the deadline.** The override exists because it is a decision, and
  `autoUpdate` authorizes the ordinary path, not the forced one.

The step runs as a **bounded loop of three**, not one transition per pulse, because a drain that
finds an empty fleet is `ready` the moment it is asked for and an unattended upgrade sitting in a
state whose whole meaning is "go now" until the next heartbeat is the mistake `applyUpgradeAction`
already declines to make for the operator. Three is the length of the longest legal run — drain,
ready, apply — so it terminates on the shape of the machine.

### The drain deadline

`selfUpdate.drainDeadlineMs`, default two hours; zero waits forever, which is the old behaviour.

An automatic drain is not free while it waits. Dispatch is paused for as long as the longest agent
runs, so one agent on a slow task holds the whole fleet — and it holds it _quietly_: the gauge says
`draining`, nothing is red, and the operator who turned this on to stop thinking about updates is
the one least likely to look. That is a worse interruption than the one the drain exists to avoid,
because it has no end.

Past the deadline the drain stops waiting and applies with `interrupt`. That is safe in the way the
manual override is safe and no further: every agent it stops is reaped, recorded `interrupted`, and
restored by `settleUpgrade` on the way back up — under the same intent row that stopped it. The
deadline is measured from the intent's `requestedAt`; a stamp that cannot be parsed reads as "no
deadline" rather than "expired", because a deadline armed off an unreadable timestamp would
interrupt the fleet immediately.

## The pause the upgrade must not lose

`UpdateDesk.restorePause`, called from `main.ts` beside `settleUpgrade`.

`RuntimeControl` is deliberately not persisted, so every boot seeds `paused` from
`config.startPaused` ([02](02-configuration.md)). That is the right answer for a **cold** boot and
the wrong one for this restart, which is not a boot at all: it is one process handing the fleet to
the next, and the pause state it hands over is a live decision an operator made, not a default.

Left to the configured value it goes both ways, and both are silent:

- An operator who had paused the fleet themselves, then upgraded, gets it back **dispatching** — the
  fleet starts working while they are still reading the release notes.
- A deployment that starts paused by policy parks a fleet that was running a second ago, and the
  operator finds out from the queue not moving.

`pausedByDrain` is already the fact needed — it records whether the _drain_ is what paused dispatch,
so its negation is what the operator had — and it is on the one row written to outlive the process.
So the boot reads it: under `applying`, and only under it, `paused` is seeded from the intent rather
than from the config. Any other state means this restart was not the upgrade's and the configured
default is exactly right, the same fence `settleUpgrade` stands behind.

This is what makes `pausedByDrain` load-bearing in **both** directions, where before it was only
read on cancel. It is why `apply` straight from `idle` computes it from `alreadyPaused` rather than
inheriting the resting `false`: on that path there was no drain to inherit an answer from, and the
default would tell the next boot the operator had parked a fleet they had not.

## Applying it

The server does not upgrade itself, and cannot. Applying means `git pull` and an install, and `npm ci`
deletes and rebuilds `node_modules` — including `better-sqlite3` and `node-pty`, which the running
process has open, and which on Windows it cannot even attempt. It also means releasing the port, the
SQLite handle and the MCP socket before the replacement claims them.

So the split is:

1. The cockpit's Apply records `applying` — **durably, before anything else**, or a shutdown winning
   the race leaves the next boot with interrupted agents and no record that anyone meant it.
2. The desk calls the handoff, which `src/server/main.ts` defers past the HTTP reply so the cockpit
   that asked learns the answer from the response rather than from a dropped socket.
3. Shutdown runs as it does for any signal: the harness stops, `interruptAll` reaps each agent's
   process subtree and records the rows `interrupted`, and the process exits **75**
   (`UPGRADE_EXIT_CODE`, `src/selfUpdate/handoff.ts`).
4. `scripts/serve.ts` sees that code, runs `git pull --ff-only`, installs dependencies **only if the
   pull moved `package-lock.json`**, rebuilds the cockpit bundle, and relaunches.

The cockpit rebuild is **unconditional**, unlike the install beside it. The server needs no build
step — tsx runs it from source — but the SPA does, `web/dist` is gitignored, and the server serves
whatever is there on an `existsSync` check with no version stamp and no comparison against `web/src`
([19](19-development.md#scripts)). An upgrade that skipped it would leave the operator on the
_previous_ cockpit with nothing anywhere saying so, which is the one failure this feature must not
introduce: the reason they upgraded is usually something they expect to see. Gating it on `web/`
having changed would be a second opinion about what Vite reads, and being wrong about it is silent.

### The install is `npm ci`, and `npm install` when that fails

`npm ci` deletes `node_modules` **before** it installs, which makes its failure the one step here
that is not the recoverable direction: it can leave the checkout with no `tsx` to relaunch through,
which is a harness that will not start rather than one on the previous build. Windows makes that the
likely case rather than the exotic one — an `esbuild.exe` from the cockpit build still held by a
lingering service process or a virus scanner fails the `unlink` `EPERM`, halfway through the delete.

So a failed `ci` falls back to `npm install`, which reconciles the tree in place: it replaces only
what the lockfile says is wrong, so it both heals a half-deleted `node_modules` and has far less to
touch that something else might be holding. `ci` stays the first choice — it is the one that
guarantees the tree is exactly the lockfile — but a reconciled tree is the only outcome here that
beats no tree at all.

If both fail the supervisor **refuses to relaunch**, and says so. `tsx` is the loader on the
relaunch's command line, so an empty `node_modules` fails `ERR_MODULE_NOT_FOUND` before a line of the
server runs: the operator gets a resolver stack trace where the reason is twenty lines above, and the
supervisor exits on it looking like the server crashed. The refusal is checked on `node_modules/tsx`
and names what to run.

On Windows the `npm` steps are spawned **through a shell**. `npm` there is `npm.cmd`, a batch file,
and since Node's CVE-2024-27980 fix `spawn` refuses to run one without `shell: true` — it fails
`EINVAL` before the command starts. Without it every upgrade on Windows fails both `npm` steps
instantly and comes back `source-moved` on the previous cockpit, which is exactly the failure above.
Only `npm` gets the shell (`git` is a real executable), and every argument under it is a literal in
`scripts/serve.ts`, never operator input.

75 is `EX_TEMPFAIL`, as close as the conventional codes come to "nothing is wrong, run me again", and
well clear of the range a crashing Node process picks from. The code is its own module because two
copies of it would fail silently in the worst way: a server that exits for an upgrade the supervisor
reads as a crash comes back on the **old** build with its agents restored, which looks exactly like a
successful upgrade until you wonder why the fix is not in.

### The supervisor is not a process manager

`scripts/serve.ts` relaunches on that one code and **passes every other ending straight out**,
signal included. It does not restart on a crash, deliberately: a server that fell over for an
unrelated reason coming back with its agents auto-restored is a loop nobody is watching. So
`npm run serve` under systemd, NSSM or a terminal behaves exactly as `npm run start:server` does,
except that the cockpit can replace it.

A failed `pull` starts the **previous** build again and says so. That is the recoverable direction:
the fleet comes back on the code it went down on.

Past the pull there is no previous build to come back to — the checkout is already on the new commit —
so the two halves are reported apart. A failed cockpit build reruns the install and tries the build once
more, because on a machine that was serving a minute ago the overwhelmingly likely reason is
`node_modules` not matching the tree that was just pulled, and that is exactly the install the
lockfile gate decided to skip. If it still fails the relaunch happens anyway, saying in as many words
that the server is coming back on the new code behind the **previous** cockpit and what to run — the
stale bundle is only survivable while something says it is there. The one exception is an install
that left no `node_modules` to run through at all, which is [refused](#the-install-is-npm-ci-and-npm-install-when-that-fails)
rather than relaunched into.

Every failure names its reason. A command that never started — npm off the `PATH`, a fork the kernel
refused, the OOM killer — reports a null status _and_ a null signal, with the cause only on `error`;
read off status alone it prints as `failed (null)`, which tells the operator an upgrade failed and
gives them nothing to act on.

### An unsupervised deployment

`npm run start:server` has nothing in front of it. `scripts/serve.ts` announces itself with
`LUBBDUBB_SUPERVISOR=1`, and absent it the panel prints the commands instead of offering the button —
the feature degrades to a notification, which is what it was before the button existed. It is not
hidden silently; the line above the commands says what to run to get the button back.

## Coming back up

`RecoveryDesk.settleUpgrade`, called from `main.ts` after `detect` and before the boot cycle. Under
`applying`, and only under it, each orphan that is **`interrupted` and restorable** is restored
without anyone being asked. Everything else falls to the ordinary recovery panel and still holds the
pulse ([10](10-agent-runtimes.md#auto-restore-after-an-upgrade)).

Two fences, both load-bearing:

- **Only under `applying`.** Any other state means this restart was not the upgrade's, and an
  operator who killed the server midway through one is asking a different question.
- **Only `interrupted`.** A `crashed` row never got the chance to write an ending, so something else
  killed that agent between the handoff and the restart. That is a genuine crash inside the upgrade
  window, its work is in an unknown state, and it lands in the panel like any other.

The verdict was decided **before** the shutdown, not here: an operator who pressed apply with agents
running was told in the refusal they overrode that those agents come back. This is the second half of
a decision already taken, not the harness deciding on its own — which is the thing
[10](10-agent-runtimes.md) exists to have stopped doing.

The intent is cleared once this has run, so a second restart restores nothing.

## The local run goes down with the harness, and can be told to come back

The shutdown path stops the machine's dev environment rather than interrupting it: the session holding
it is going down with this process, so a row claiming that session is live would be a claim about
nothing. → [23](23-local-runs.md#the-process)

**It takes the fast path, not the project's own stop.** Stopping a local run is a session's turn now —
the project's `stop` command, because a dev environment is not a process tree and no signal reaches a
container ([23](23-local-runs.md#stopping-is-a-turn-not-a-signal)). Waiting for a turn here would hang
the two paths that must not hang: a Ctrl-C, and this one, which is a restart. So `stopFast` reaps the
session's subtree and kills it without one.

**What happens to the row depends on whether the deployment can bring the run back.** The reap takes
the dev server and cannot touch a container, so a restart leaves half an environment either way. With a
`localRun.resumeInstruction` the row is deliberately **left live** — it is the only record that there
is something to come back to, dated with when the harness went — and the next boot's
`resumeInterrupted` attaches a session to what survived, so long as that was recent enough to be
worth it (`localRun.resumeWindowMs`; an upgrade is seconds, so it always is). `SIGHUP` and `SIGBREAK`
reach this same `shutdown` beside `SIGINT` and `SIGTERM`: closing the console window on Windows
raises the first, and unhandled it took Node's default path — no agent reaped, no run dated, on the
way out an operator takes as often as Ctrl-C. A `taskkill /F` still reaches nothing, which is what
the local run's pulse stamp is for. Without one it is settled with a note saying the stop instruction did not run, which is what
turns a container that outlived the harness into something the panel states rather than a mystery an
operator finds in `docker ps`. → [23](23-local-runs.md#coming-back-after-a-restart)

An upgrade takes the same path — it exits through the same `shutdown`, with `UPGRADE_EXIT_CODE` — so
the environment goes down for an upgrade too, and comes back on the new build if the deployment says
how. This is the asymmetry with an agent narrowing rather than going: an agent's _conversation_ is
restored, and a dev environment is now _rebuilt_ from an instruction, which is a different thing done
for the same reason.

## Where the shutdown handlers are registered

In `main.ts`, **before anything that can start an agent** — before `settleUpgrade`'s restores and
before the boot cycle's dispatches. They used to be installed at the very end, which left a window
covering exactly those two things in which a Ctrl-C took Node's default path: no handler, so the
agents were not interrupted, not reaped and not recorded. Real orphans, holding their worktrees open,
with rows still claiming to be live.

## The gauge

One reading in the top bar, `Build` ([17](17-cockpit.md#the-build-gauge)). It is in a fixed place at
every state, including the one it spends nearly all its life in — `current`, muted, saying nothing.

That is the design. A notification that appears only when there is news is one an operator has to
notice; a gauge in a fixed spot is one they can glance at, and the mute is what keeps it from
competing with the readings beside it the rest of the time.

It is deliberately **not** the crash-recovery banner's treatment. That is a stop sign, and it is loud
because the harness is running no cycles while it is up. An update being available stops nothing, so
borrowing the banner would say something untrue — and after the second time, be scrolled past.
