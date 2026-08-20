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

`localRun.instruction` — free text, what the session bringing the environment up is told — and
`localRun.url`, where the application lands. Both are **live fields**
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

Which ref: `localRunRef` (`src/localRun/ref.ts`, pure) takes the **first unmerged part with a branch,
in plan order**, or null for the integration branch. A goal whose parts have merged *is* the
integration branch, and a stack's later part is built on its earlier one — so the first unmerged part
is the furthest back anybody would want to look. `merged`, `retired` and `concluded` parts are
skipped: each can still carry a branch from before it got there, which is exactly the stale checkout
this avoids.

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
- **Four rules are appended to the instruction, never interpolated into it** — the prompt templates'
  rule for their reason. Start it in the background and stay; do not stop it; do not commit (the
  checkout is detached at somebody else's commit); say where it landed. An operator writing down how
  their project starts has no way to know any of them, and an instruction that had to remember them
  would be one edit from dropping one.
- **A stop reaps the subtree _before_ it signals the child.** The dev server is a descendant, and
  descendants resolve through the root pid — so reaping after the process dies finds nothing, leaving
  the port held and, on Windows, the checkout unremovable
  ([10](10-agent-runtimes.md#reaping-the-process-subtree)).
- **It is not an agent row and not against the cap.** A run holding one of `maxConcurrentAgents`
  would starve the fleet for as long as the environment is up. The cost is one short turn at startup;
  an idle stream session spends nothing while no turn is in flight.

**A restart settles every live row.** A row saying `running` after a restart describes a process this
harness never spawned — the pid belongs to something dead, or to whatever has since been given that
number. `endStaleLocalRuns` runs at boot and records how many it settled. The run also goes down with
the harness rather than being interrupted like an agent's work: an agent's conversation is worth
restoring and a dev environment is not, and left running it would be an orphan holding a port and the
checkout with a row claiming it is live ([21](21-self-update.md#the-drain)).

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
| `POST /api/local-run`       | `{issue}` — start it on that goal, stopping whatever was running.      |
| `POST /api/local-run/stop`  | No body and no id: there is one run, and stopping it is the request.   |
| `GET /api/local-run/output` | The session's last lines.                                             |

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

## Persistence

`local_runs`, one row per run, `src/store/localRuns.ts`. `id`, `origin_ref`, `ref`, `dir`, `pid`,
`status`, `url`, `note`, `started_at`, `ended_at`. A brand-new table needs no `ColumnMigrations`
entry — but a table being new *once* does not keep it exempt
([14](14-persistence.md#migrations)). `url` is frozen as configured when the run started, so a later
config edit does not rewrite what a past run reported.

## Tests

`test/localRun.test.ts`: the refusal names the field that fixes it; a start prepares the checkout,
writes the row and appends the rules; a merged goal runs from the integration branch; the turn ending
is the environment up and kills nothing; a failure keeps what the session last said; a stop reaps
before it signals, asserted as an **order** rather than as a pair; a second goal supersedes the first;
a restart settles what it cannot vouch for; `localRunRef`'s two arms; and — against a real repository
— that a change of ref keeps ignored files and drops everything else, and that an unresolvable ref
leaves the checkout untouched.

`test/validationDesktop.test.ts` covers the tool: what it reports, that starting a second goal stops
the first, and that a deployment with no instruction is refused with the field named.
