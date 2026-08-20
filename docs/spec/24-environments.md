# 23 — Environments

`src/environments/`. **Off by default**: `environments` is an empty list, no probe runs, and the
cockpit draws no environment surface at all. → [Configuring an environment](#configuring-an-environment)

A goal's work merging is not the same as a goal's work arriving. Between the merge and the thing
running somewhere there is a release train, a deploy pipeline, an approval gate and a rollback
button, and the harness sees none of them. This is the subsystem that closes that gap: it records
the commit each of a goal's pull requests **landed as**, and then asks the operator's own command
whether each of those commits has got to each environment.

Two halves, and they are deliberately independent. The first runs on every deployment whether or not
any environment is configured, because what it captures expires. The second runs only when there is
something to ask.

## What it is not

| Not                     | Because                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A deployment tool       | Nothing here deploys, promotes, approves or rolls back. It observes, and the only write it makes is to its own two tables.                                                |
| A dispatch input        | `src/environments/` is a lens. Nothing under `src/dispatcher/` may import it, for the reason the work graph and `prAttentionStatus` may not — see [05](05-dispatcher.md). |
| A provider integration  | An environment is a **command**, not an API. GitHub Deployments and Azure Releases are two answers among many, and most teams use neither. → [The probe](#the-probe)      |
| A rollback detector     | A confirmed landing is never re-asked. An environment that goes back past a commit still reads as holding it. → [What it does not see](#what-it-does-not-see)             |
| An agent-visible signal | No prompt mentions environments, no MCP tool touches them, and no rule reads what the desk writes.                                                                        |

## Recording a landing

`src/environments/landings.ts`. A `GoalLanding` is one row: a pull request number, the goal it was
work for (`issue:<n>`), and the commit the merge produced on the base branch.

**The SHA is a provider fact and cannot be recovered afterwards.** `merge_pr` squashes, and a
squash-merged branch has no ancestry link to its base — so the branch tip answers "is this in
production" with a permanent no, whatever the truth is. What a downstream check has to be handed is
the commit the merge _created_, which only the provider reports: `merge_commit_sha` on GitHub,
`lastMergeCommit.commitId` on Azure. Both arrive on `PullRequest.mergeCommitSha`, populated by
`mapClosedPull` in each provider's `sourceControl.ts` and by the fake in
`src/integrations/fake/fakeGitHub.ts`.

`unrecordedLandings` is a **sweep, not a hook on the merge**. Attributing on the pulse that saw the
transition is the shape that loses landings silently: the harness restarts across it, or a person
merges in the web UI between two pulses, and that commit is never recorded — which the cockpit then
draws identically to work that never shipped. Asking "which merged pull requests have no landing"
instead means any pulse inside `closedPrWindowMs` records it, and the first pulse after this feature
ships back-fills every merge already in the window.

The goal is resolved by walking `parentRef` from the PR's node in the **work graph** up to its
`issue:` root, falling back to the world's own `issueForPr`. The graph is the primary source because
it is the one that persists the edge: `closedPullRequests` forgets a merge after `closedPrWindowMs`
and the graph does not. That is also why the desk runs **immediately below `graph.record(world)`** in
the pulse — one line above it and every merge on the pulse it happened would read a graph one cycle
stale.

A merged pull request whose provider reported no merge commit produces **no landing at all**, rather
than a row pointing at nothing.

## The probe

`src/environments/prober.ts`. One method: does this environment have this commit?

The harness ships no opinion about how to answer, because the question has no generic form. An
environment is a git ref on one deployment, an HTTP endpoint reporting its own build on another, and
on a third a question about several services at once that no single SHA describes. So the operator
supplies a command, and `CommandEnvironmentProber` runs it in a shell in `repoRoot`.

**The commit is passed in the environment, never interpolated into the command.** `LUBBDUBB_COMMIT`
holds the SHA and `LUBBDUBB_ENVIRONMENT` the environment's name. A `{commit}` placeholder would be
the prompt-template mistake in another costume ([05](05-dispatcher.md#prompt-templates)): an
operator's command that never learned about the token would silently probe nothing and answer about
whatever the bare command means. Passing it in the environment has no fallback to get wrong.

### The three verdicts

The exit code is the contract, and it has three answers rather than two:

| Result                                                                  | Verdict   |
| ----------------------------------------------------------------------- | --------- |
| exit `0`                                                                | `reached` |
| exit `1`, and nothing on stderr                                         | `absent`  |
| anything else, a signal, a timeout, or a `1` that came with a complaint | `unknown` |

Folding the third case into "not there" is the failure the type is shaped around. An expired
credential, a missing binary and a genuine not-yet-deployed all exit non-zero, and only one of them
is about deployment. Read as `absent` they are indistinguishable on the glass, and the cockpit states
in the operator's own words that the work has not shipped — for a reason that has nothing to do with
shipping.

**The stderr clause is why `1` alone is not enough.** `cmd.exe` exits `1` for a command it cannot
find, which is the same code `git merge-base --is-ancestor` uses for a clean no. On Windows the exit
code by itself therefore cannot tell a typo'd probe from a commit that has not shipped. What
separates them is that the failure explains itself and the answer does not. The cost is that a probe
which legitimately answers "no" while warning about something reads as `unknown` and is asked again
— the safe direction, and fixed by redirecting the warning.

A probe is killed after 30 seconds and the kill reads as `unknown`: a probe that hung is a probe that
said nothing.

## Configuring an environment

```json
{
  "environments": [
    { "name": "staging", "command": "git merge-base --is-ancestor $LUBBDUBB_COMMIT origin/staging" },
    { "name": "prod", "command": "./scripts/in-prod.sh" }
  ],
  "environmentProbeIntervalMs": 300000
}
```

`environments` is `fileOnly` in `CONFIG_FIELDS`, for `whitelistedApprovals`' reason: each entry is a
shell command the harness runs on a schedule, which is a thing to write deliberately in a file rather
than to fill in beside twenty other rows. No agent can write it — nothing in `src/mcp/` touches
config.

`validateEnvironments` (`src/environments/policy.ts`) refuses a list that cannot mean what it says,
because each failure is otherwise silent in the same direction:

- a **nameless** entry stores its readings under `""`;
- a **duplicate** name has two commands writing over one key;
- an **empty** command exits 0 in every shell there is, which reports every goal as being in that
  environment, confidently and forever.

`name` is the display label _and_ the key every reading is stored against, so renaming an environment
discards what was known about it rather than migrating it.

`environmentProbeIntervalMs` (default 5 minutes) is how long an unconfirmed landing rests before it
is asked about again. It is also the precision of every "arrived at" the cockpit shows, which is why
it is not larger: an interval nobody would call fresh makes a timestamp nobody should quote.

## The desk

`src/environments/environmentDesk.ts`, run from the pulse beside the other bookkeeping and not in the
dispatcher — it staffs nothing, decides no dispatch, and no rule reads what it writes.

The attribution pass runs unconditionally. The probe pass returns immediately with no environments
configured. That split is not tidiness: a merge SHA is only on offer while its pull request is inside
`closedPrWindowMs`, so a deployment that configures its first environment next month still wants this
month's landings on record when it does.

What is asked, and what is not:

- **A `reached` verdict is never re-asked.** That is what makes the steady state cost nothing: an
  established deployment's landings are almost all confirmed everywhere, and the only live questions
  are this week's.
- An `absent` or `unknown` older than `environmentProbeIntervalMs` is asked again.
- At most **20 probes per pulse**, oldest landing first. Each probe is a process spawn, and an
  unbounded pass would fork hundreds of shells on the heartbeat the first time an environment went
  dark. What the cap leaves out is asked on the next pulse in the same order, so nothing starves.

A probe that throws is recorded through `errors.record` and never fails the cycle. In practice little
reaches there — the prober already turns a command that could not answer into an `unknown` reading.

## The lens

`src/environments/reach.ts`. `goalReach` folds a goal's landings and their readings into one row per
environment.

`partial` is the reading the lens exists for. A goal is several pull requests, they land separately,
and a release cut between two of them puts half a feature in production. Folded to a boolean, that
reads as "shipped" — wrong in the expensive direction.

**`unknown` beats `absent`.** Nothing may report work as not-deployed on the strength of a probe that
could not answer, or a merge whose commit nobody caught. So:

| Counts                                              | Status    |
| --------------------------------------------------- | --------- |
| no merges at all                                    | `absent`  |
| every landing confirmed                             | `reached` |
| some confirmed, some not                            | `partial` |
| none confirmed, something unresolved                | `unknown` |
| none confirmed, every landing asked and answered no | `absent`  |

`total` counts the goal's landings **plus** its merges the sweep could not attribute
(`unattributedMerges`), which is read from the work graph rather than the world for the reason above:
a world-only count would report every goal fully accounted for the moment its merges aged out of the
closed window.

`at` is the _newest_ reading among a fully-reached goal's landings — the moment the whole goal was
there, not the moment the first part of it arrived.

## In the cockpit

`buildEnvironmentReach` in `src/server/stateSnapshot.ts` ships `CockpitState.environmentReach`: one
`GoalReachView` per goal that has landed something or has a merge nothing could attribute. The goal
set comes from the landings and the work graph, never from the world — a goal is at its most
interesting to this panel once its ticket has closed, which is precisely when the world stops listing
it.

The goal page draws an **Environments** card under the pull requests, one row per configured
environment, with the count on every row that is not whole: `0/3` and `2/3` are the difference
between work that has not started moving and work that is halfway there, and the word alone says
neither. The tones are ones the cockpit already defines — `partial` takes the _attention_ tone rather
than a success one, because half a feature in production is the state most likely to want somebody.

The card is absent entirely when nothing is configured. A row of question marks on every deployment
that never set one up would be a feature announcing itself as broken.

## What it does not see

Stated so a later change does not discover them as bugs:

- **A merge that left the closed window unobserved.** The harness down for longer than
  `closedPrWindowMs` loses that landing permanently. It is lost rather than wrong: the merge is
  counted as unattributed and the goal reads `unknown`, never `absent`.
- **A rollback.** A confirmed landing is never re-asked, so an environment that goes back past a
  commit still reads as holding it. Re-probing every landing in every environment forever is the
  alternative, and the trade is deliberate.
- **Arrival time finer than the probe interval.** `at` is the timestamp of the first poll that said
  yes, not of the deploy.
- **Work that lands in another repository**, or a monorepo environment that deploys one
  subdirectory. The first has no commit in this clone to ask about; the second will answer "reached"
  for a commit that never touched the deployed path. Both are answerable — a per-environment repo
  root, a per-environment path filter — and neither is implemented.

## Persistence

Two tables, described in [14](14-persistence.md): `goal_landings` (one row per merged pull request,
keyed on the PR number for `branch_reaps`' reason — a branch name is reusable) and
`environment_reach` (one row per `(sha, environment)`). A landing is written `OR IGNORE`, since the
merge is a settled fact and a second sighting inside the closed window is the same fact arriving
again; a reading is written `OR REPLACE`, since it is an observation of something that moves.

Both are bounded by the number of landings times the number of environments, and neither is pruned.
