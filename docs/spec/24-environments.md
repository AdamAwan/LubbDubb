# 24 — Environments

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

An environment may also be asked a third question, on its own command and its own clock: whether it is
**well** right now. That half answers about the environment rather than about any commit, nothing in
the harness reads what it writes, and it is off unless an environment declares it.
→ [Is the environment well?](#is-the-environment-well)

An environment may also carry **meaning**: arriving there can be what opens the obligations a
delivered goal owes a person, and what puts a line on the ticket. Both are opt-in, per environment,
and a deployment that declares neither gets exactly what it got before — an observation, drawn on the
goal page. → [What an arrival means](#what-an-arrival-means)

A goal's work **arriving** is not the same as that work **behaving**, and this subsystem has no
opinion about the second: a goal reads `reached` whether the fix worked, did nothing, or made things
worse. That question is [29](29-post-deploy-watch.md), which opens its window on the arrival this one
records.

## What it is not

| Not                     | Because                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A deployment tool       | Nothing here deploys, promotes, approves or rolls back. It observes, and the only write it makes is to its own two tables.                                                                                                                                                                                  |
| A dispatch input        | `src/environments/` is a lens. Nothing under `src/dispatcher/` may import it, for the reason the work graph and `prAttentionStatus` may not — see [05](05-dispatcher.md). What a gate holds is a **bench row**, never a dispatch: no agent waits on an environment, and no rule reads what the desk writes. |
| A provider integration  | An environment is a **command**, not an API. GitHub Deployments and Azure Releases are two answers among many, and most teams use neither. → [The probe](#the-probe)                                                                                                                                        |
| A rollback detector     | A confirmed landing is never re-asked. An environment that goes back past a commit still reads as holding it. → [What it does not see](#what-it-does-not-see)                                                                                                                                               |
| An agent-visible signal | No prompt mentions environments, no MCP tool touches them, and no rule reads what the desk writes.                                                                                                                                                                                                          |

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

The goal is resolved by walking `parentRef` from the PR's node in the **work graph** up to its goal
root, falling back to the world's own `issueForPr`. The graph is the primary source because it is the
one that persists the edge: `closedPullRequests` forgets a merge after `closedPrWindowMs` and the
graph does not. That is also why the desk runs **immediately below `graph.record(world)`** in the
pulse — one line above it and every merge on the pulse it happened would read a graph one cycle
stale.

**The walk stops on a bare `issue:<n>`, never on the `issue:` prefix.** A plan's parts are nodes of
their own — `issue:35916:part:orc-bucket-config` — and a part's pull request hangs off the part, not
off the issue two levels up ([08](08-planning.md)); the graph fills `prParent` part-first on purpose,
because work lineage is what a parent means. A prefix test stops one node short, and every reader of
these tables then asks about a ref nothing was filed under: `goalReach` finds no landings for the
goal, `allGoalReach` drops it, and the goal gets **no environment row at all** — while `openedGoals`
never opens a gate the goal is held on, so a delivered goal's bench rows wait for good. Both are the
same silence in the same direction, on exactly the goals big enough to have been planned. Fixed in
#472, together with a one-time repair of the rows already written
([14](14-persistence.md#repairing-a-mis-attributed-goal-ref)).

A merged pull request whose provider reported no merge commit produces **no landing at all**, rather
than a row pointing at nothing.

## The probe

`src/environments/prober.ts`. One method: **where is this environment?**

Not "do you have this commit". That question costs a process spawn per landing per environment per
pulse, so the cost of the whole subsystem grew with every goal that had ever merged; this one is
asked once per environment however many goals are in flight, and the clone answers the rest.

The harness ships no opinion about how to answer, because the question has no generic form. An
environment is a git ref on one deployment, a pipeline's last successful `sourceVersion` on another,
and on a third several services at once. So the operator supplies a command, and
`CommandEnvironmentProber` runs it in a shell in `repoRoot` with `LUBBDUBB_ENVIRONMENT` set.

**Nothing about a commit is passed in.** There is no `LUBBDUBB_COMMIT` and no `{commit}` placeholder,
which removes a whole class of failure rather than defending against it: a token an operator's
command never learned about is the prompt-template mistake in another costume
([05](05-dispatcher.md#prompt-templates)), and a command that silently answers about whatever the
bare form means is a confident wrong answer rather than an error. A question with no parameter has no
parameter to drop.

**Exit 0 with at least one token is the only answer there is.** Anything else — a non-zero exit, a
signal, a timeout, or a command that printed nothing — is the probe failing to answer, and every
landing then reads `unknown`. That includes the silent success, which is worth naming: a pipeline
query with no successful run prints nothing and exits 0, exactly as a broken query does. Unanswered
is the direction that gets asked again rather than the one that reports the fleet as never shipped.

Output is split on whitespace, and **several tokens is several services**: a landing is in the
environment only when it is in _every_ commit named. The laggard governs, which is what lets one
`for` loop over three services be one environment rather than three.

A probe is killed after 30 seconds and the kill answers nothing: a probe that hung is a probe that
said nothing.

## Asking the clone

`GitObserver.contains(commits, heads)` (`src/git/gitObserver.ts`). Given what the environment named,
which of these landings does it hold?

Local, and batched. Two `git` invocations answer the whole pending set:

- `rev-list --ignore-missing --no-walk <shas>` — the objects this checkout **holds**. `--no-walk`
  prints the arguments themselves rather than their history, and `--ignore-missing` drops the ones
  never fetched instead of failing the call over one of them.
- `rev-list --ignore-missing <shas> --not <head>` — of those, the ones the head does **not** reach.
  The walk emits ancestors as well as the commits asked about, so the caller intersects; git drops
  `--no-walk` the moment a range is present, which is why this is a second call rather than one
  clever one. It returns instantly for a commit the head already has — the steady state — and pays
  only for how far ahead of the environment the branch has run.

The objects are as fresh as the plan reconciler's `git fetch`, floored by `planning.gitFetchIntervalMs`
([08](08-planning.md)). The seam itself stays read-only and fetch-free.

### The three verdicts

| The clone says                                                  | Verdict   |
| --------------------------------------------------------------- | --------- |
| the commit is reached from every head the probe named           | `reached` |
| the commit is held, and some head does not reach it             | `absent`  |
| the probe could not answer, or this checkout has no such object | `unknown` |

Folding the third case into "not there" is the failure the type is shaped around. An expired
credential, a missing binary, a commit nobody fetched and a genuine not-yet-deployed all fail the
same way, and only one of them is about deployment. Read as `absent` they are indistinguishable on
the glass, and the cockpit states in the operator's own words that the work has not shipped — for a
reason that has nothing to do with shipping.

What the `at` shape retired is the old contract's hardest clause. When the probe answered with an
exit code, `1` had to mean "not there" — and `cmd.exe` exits `1` for a command it cannot find, so on
Windows the code alone could not tell a typo'd probe from a commit that had not shipped, and the
tie-breaker was whether the command had complained on stderr. An environment naming its own commit
has nothing to say no _about_: either it answered or it did not, and whether a landing is in it is a
question for the clone. The platform-dependent clause simply has nothing to be about any more.

## Is the environment well?

`src/environments/health.ts`, `healthProber.ts`. A second command, `health`, and a second question:
not _where_ this environment is, but whether it is **up** right now.

Beside reach rather than folded into it, because the two have different right answers at the same
moment. A testUk holding every commit a goal owns while its search index is down is `reached`, and it
is `unhealthy`; folded, the loudest half of the pair is the one nobody can see. They are also on
different clocks — reach is asked only while some landing is unconfirmed, so an established fleet
spawns nothing, while health is worth asking on a fleet that has shipped nothing all week.

**Off unless an environment declares it.** An environment with no `health` is not asked, gets no row,
and draws nothing — the rule the whole subsystem is built to, for the reason the card is absent
entirely on a deployment with no environments at all.

### The output contract, which is all the schema the harness has

The command prints one JSON object and the harness reads four fields out of it:

```jsonc
{ "state": "Healthy" }

{ "state": "NotHealthy", "tier": "Orange", "reasons": ["Pipeline failing"] }

{ "state": "NotHealthy", "tier": "Red", "reasons": ["Pipeline failing", "Solr down"] }
```

The harness knows nothing about pipelines, Solr, pods or dashboards, exactly as it knows nothing
about Kusto ([29](29-post-deploy-watch.md)). It imposes a shape and reads nothing else.

- **`state`** is `Healthy`, `NotHealthy` or `Unknown`. The vocabulary is deliberately generous on the
  way in and closed on the way out: `Healthy`, `healthy` and `HEALTHY` are one word, `NotHealthy`,
  `not-healthy` and `unhealthy` are another, because this contract is a script somebody writes once
  from an example — but what comes out is one of three values the cockpit can draw and the store can
  key on.
- **`tier`** is `Red` or `Orange`, and says how bad an unhealthy one is. A **closed** set, because the
  tier is what decides how loudly the reading is drawn: a tier the cockpit cannot rank would be drawn
  at some tone nobody asked for, so an unrecognised one is refused and says so on the glass, where the
  person who wrote the script will read it. A **missing** tier is not refused — the state is the
  signal and the tier is the detail — and an untiered `NotHealthy` is drawn at the loudest tone there
  is, since an unstated severity is not a reason to draw an outage quietly. A `tier` on a **healthy**
  report is refused: the two halves disagree about the only thing the reading is for.
- **`reasons`** are the check's own sentences, drawn verbatim and never parsed. Bounded at twelve of
  200 characters, because a row is a reading and not a log.
- Anything else in the object is ignored.

**The state is three-valued for `EnvironmentReachStatus`'s reason**, and it is the sharp edge of this
half. A check that could not answer — the binary is missing, the credential expired, it timed out —
must be readable as neither of the other two. Read as `healthy`, an environment nobody is watching
reports that it is fine; read as `unhealthy`, a broken credential is a page in the night. So every
unreadable answer lands on `unknown` with an account of why: no output, output that is not JSON, a
state nobody declared, a `reasons` that is not a list.

**The report is read from stdout whatever the exit code**, and that is the one place this differs from
`at` and from `observe`. A health script that says `NotHealthy` and exits 1 is the shape half the
world already writes — `set -e`, a `curl -f`, a pipeline task's own convention — and refusing it would
turn every real outage into `unknown` on exactly the deployments whose script works. The exit code is
consulted only when stdout said nothing readable, and then it is the better account of the silence:
`exited 127: command not found` rather than "did not answer with JSON". A check that declared
`Unknown` itself keeps its own reasons, because it answered — what it answered was that it could not
tell.

A check is killed after 30 seconds and the kill answers nothing, as everywhere else here.

### What is stored, and for how long

One row per environment in `environment_health`, replaced on every reading: health is a **status**, not
a history, and a table growing a row per environment per interval would be a log nothing reads.

What survives the replace is `changed_at` — when the environment last became what it is now — because
"red" and "red since Tuesday" are different sentences and the second is the one an operator acts on.
It is moved by a change of **state or tier** and not by a change of **reasons**: a check whose list
shifts while an outage runs is the same outage, and a clock restarting under it every interval would
report a fresh one forever.

A reading is not re-asked inside `environmentHealthIntervalMs` (default 5 minutes), which is its own
key rather than `environmentProbeIntervalMs` because the costs differ in kind: a probe is asked only
while something is unconfirmed, and this is asked on every declaring environment whether or not
anything has shipped. That number _is_ the standing cost of the feature, and it is also how stale the
worst reading on the glass may be while somebody is looking at it.

**Nothing reads what this pass writes.** It opens no gate, holds no obligation, files no bench row and
reaches no prompt — a health reading is drawn, and that is all it does. That is why the pass's
position in the desk is a preference rather than an invariant, and why the desk says so in the file:
the orderings either side of it are real, and a later reordering of this one must not be read as
breaking one.

### Health in the cockpit

An **Environments** card on the overview, one row per environment that declares a check: the word, how
long it has been that word, when it was last read, and the check's own reasons behind the row's
marker. On the overview and not on a goal page, because health is a fact about the environment and not
about any goal — drawn per goal it would be the same sentence repeated on every card, and the one
place it is actually read, "is anything broken out there", has no goal selected.

It is the one card there that draws **nothing** when it is empty, which is the deliberate exception to
that page's rule that an empty card still draws: an environment surface on a deployment that
configured none is a row of question marks announcing a feature as broken. An environment that _is_
configured and has not answered yet draws its row and says so.

The tones are ones the cockpit already defines, so a theme switch needs no new token. `unknown` takes
the same amber as `orange` and is told apart by the word beside it, which is the honest pairing: a
check that could not answer is a thing to look at, and drawing it green or red would be claiming an
answer it did not give.

### Being told

The card is where the detail is read; it is not a way to be told. Two surfaces carry the reading further,
and both are **volume rather than meaning** — nothing below opens a gate, files a bench row or reaches a
prompt, which is still the whole of what health does.

**The `Env` gauge on the top bar** — the worst reading as a count and a word, muted while everything is
well, tinted when it is not, opening the overview where the card is. It is drawn only where some
environment declares a check, the card's own exception for the card's own reason. The ranking, the
wording and the tones are [17](17-cockpit.md#the-environments-gauge).

**An `environments` notification category**, beside Needs you, Errors and Agent finished
([17](17-cockpit.md#notifications)). It fires on a change of **state or tier** between two readings the
cockpit holds both of — which is `changed_at`'s own rule read forwards, and it is the rule that makes
this channel survivable: a check whose reason list shifts under one tier is the same episode still
running, and firing on it would be a notification every `environmentHealthIntervalMs` for as long as the
outage lasts. Three things follow from it, each of which is the feature failing quietly if it is dropped:

- **The all-clear is a notification too.** A channel that announces outages and never their end leaves
  somebody checking the cockpit to find out, which is what being notified was meant to replace. It
  carries how long the episode ran, measured between the two readings' `changedAt` rather than against
  the clock, so it says the same thing however late the cockpit noticed.
- **An `unknown` gets its own sentence** — _"liveEu did not answer"_, with the harness's account of why.
  Told as an outage, an expired credential is a page in the night about a credential, which is the
  failure the three-valued state exists to prevent; told as nothing, an environment nobody is watching
  reports that it is fine.
- **An environment the previous snapshot had no reading for announces nothing.** A first reading is not
  an event: a newly configured environment — or a snapshot that arrived without the list at all — would
  otherwise announce itself on the pulse the cockpit first saw it, healthy and unhealthy alike. It is
  `notifiableChanges`' seeding rule applied per environment.

The decision is pure and lives with the other three categories in `web/src/cockpit/notify.ts`;
`test/notify.test.ts` is where what fires is read.

### What health does not see

- **Whether the environment being ill is anything to do with the harness's work.** A red testUk and a
  goal that has just arrived in it are two readings on one page, and nothing here relates them. That
  question is [29](29-post-deploy-watch.md), which asks a goal's own declared checks.
- **A history.** The row is the current reading and `changed_at` is as far back as it goes; there is
  no chart of last week's outages, and the reason is the one above — this is a status.
- **An environment's health while nothing else is configured.** `environments` is still the off
  switch for the whole subsystem: `health` alone on an entry with no `at` is not a configuration the
  policy allows, because `at` is what an environment _is_ here.

## Configuring an environment

```jsonc
{
  "environments": [
    {
      "name": "testUk",
      "at": "az pipelines runs list --pipeline-ids 42 --status completed --result succeeded --top 1 --query '[0].sourceVersion' -o tsv",
      "health": "./scripts/health.sh",
      "arrival": { "opens": ["validate", "close_out"], "comment": true },
    },
    { "name": "liveUk", "at": "./scripts/deployed-sha.sh uk", "arrival": { "comment": true } },
    { "name": "liveEu", "at": "./scripts/deployed-sha.sh eu", "arrival": { "comment": true } },
    { "name": "liveUs", "at": "git rev-parse origin/production" },
  ],
  "environmentProbeIntervalMs": 300000,
  "environmentHealthIntervalMs": 300000,
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
- an **empty** `at` names no commit, which leaves every goal unanswered forever;
- a **`command`** key, which is the previous shape and asked a different question. Named rather than
  ignored: loading it silently is an environment that never answers anything;
- an empty **`health`**, which answers nothing — an environment whose health row reads `unknown`
  forever looks exactly like one whose credentials expired, and left out entirely is the honest way to
  say the question is not asked here;
- an `arrival` that **opens nothing and says nothing**, or one naming an obligation the harness does
  not file. An `"opens": []` reads as a gate and gates nothing, which is the shape most likely to be
  written by somebody who meant one and left it for later.

`name` is the display label _and_ the key every reading and arrival is stored against, so renaming an
environment discards what was known about it rather than migrating it. What re-learning it does is
probe the deployment's whole history back — every landing is due again under the new name, and every
verdict is written down again. What re-learning it does **not** do is announce any of it: the readings
are new, but the deploys they confirm are not, and that distinction is the announce guard's whole
subject (below).

Adding an environment to a deployment that has been running is the same event by a different route,
which is why it has the same answer.

`environmentProbeIntervalMs` (default 5 minutes) is how long an unconfirmed landing rests before its
environment is asked where it is again. It is also the precision of every "arrived at" the cockpit
shows, which is why it is not larger: an interval nobody would call fresh makes a timestamp nobody
should quote.

## What an arrival means

An **arrival** is one goal's _whole_ work confirmed in one environment, the first time it was —
`goal_arrivals`, one row per `(goal, environment)`.

That whole-work claim is also why a historical row written by an older reach denominator cannot be
corrected in place. If a live plan part remains owed, `dropPartialGoalArrivals()` discards the row on
boot and the desk re-derives the real arrival once every part is confirmed. →
[14](14-persistence.md#repairing-arrivals-from-the-old-reach-denominator)

A row rather than a fold, because an arrival is a **moment and reach is a status**. `goalReach` can
say a goal is in testUk on every pulse from now until the heat death; only a row can say it has just
got there, which is what keeps the ticket to one comment rather than one every five minutes, and what
lets the signal read as something that happened.

`arrival` on an environment declares what its arrival does. Both fields are optional and an `arrival`
declaring neither is refused.

### `opens`

The obligations a delivered goal owes a person are filed on the delivery today
([13](13-jobs-and-tickets.md), [20](20-validation.md)): a `validate` row for the checks, and a
`close_out` row for the ticket. `opens` moves that moment to the arrival.

```jsonc
{ "name": "testUk", "at": "…", "arrival": { "opens": ["validate", "close_out"] } }
```

The delivery is when a check becomes _meaningful_; it is not yet when one becomes **runnable**. A
check against a build nobody can open is a row asking for work that cannot be done, which is the
failure the bench exists to end — and a close asked for before anybody could look at the thing is a
decision made on nothing.

Three rules hold it together:

- **Delivery is still required.** A gate adds a condition; it does not replace one. A goal the
  assessor sent back files neither row, gate or no gate.
- **Any environment that opens it.** Declared on two environments, the gate is satisfied by whichever
  the goal reaches first — two acceptance environments are two entries, not a ranking.
- **Nothing declared, nothing changes.** With no environment naming a gate, `openedGoals` returns
  **null** rather than an empty set, and the desks behave exactly as they did. The distinction is
  load-bearing: an empty set would withhold every bench row on every deployment on earth, and would
  look identical to the feature working.

A gate holds only the **filing** of a row. Everything that settles one still runs, so a ticket closed
by hand while a goal is held still discharges a close-out filed before the gate was configured.

A second, later hold exists on the same two obligations and is **off**: `watch.holds`, which withholds
a row until the environment's post-deploy watch on that goal has settled rather than until the goal
arrives. It reads the same way — nullable, satisfied by whichever declaring environment gets there
first, cleared by an operator's release, holding the filing and never the settling — and it is off for
the reason this hold is kept off the Needs-you rail: a 48-hour hold on every delivered goal would put
every goal on the bench in a state nobody can act on. What a watch does by default is put what it is
reporting into the close-out's own detail.
→ [29](29-post-deploy-watch.md#it-holds-nothing-unless-asked)

### `comment`

`{ "comment": true }` puts one line on the goal's ticket when its whole work arrives — through
`ActionSink.upsertIssueComment`, mechanical bookkeeping in `setWorkItemState`'s sense and deliberately
not auto-send gated: nothing is deciding _whether_ the work arrived.

**One comment per arrival, not one living comment edited in place.** The appraisal's comment is a standing
state and is edited ([06](06-issue-pickup.md)); this is a thing that happened at a time. Four short
comments are the timeline a reader wants from "where did this get to", and an edited comment would
silently rewrite the record of the last environment each time.

Nothing else is written to the tracker. A label and a work-item state move were both considered and
are **not** implemented: a label is a second representation of a fact the harness already holds and
that the goal page already draws, and a state move is Azure-only, so a deployment reading it as "the
mark" would find GitHub silently doing nothing.

### Announcing an arrival

Every unannounced arrival goes through the announce pass, and every one comes out stamped —
`announced_at`, whether or not there was anything to say. That stamp is the whole of how an
environment that grows `arrival.comment` next month announces its _next_ arrival rather than every one
already in the table.

**An arrival is announced only if the harness watched it happen**: its confirming reading must be
within two probe intervals of now. Without that line the first pulse after this ships — or after an
operator adds `comment` to an environment that has been probing for a month — posts on every ticket
already in it. That is the backfill-on-boot failure a nullable column has
([14](14-persistence.md#when-a-null-means-something)), wearing a ticket thread, and it reads to the
team as the harness having lost its mind. Two intervals rather than one because a landing confirmed on
the previous pulse is still an arrival this harness saw, and a probe pass that ran long must not turn
that into silence.

**A fresh reading is not on its own enough, because a name can be fresher than what it is reading.**
Readings and arrivals are both keyed on the environment's name, so a name the harness has never used
before starts with no readings at all: every landing in the deployment's history is due, every probe
writes its verdict _now_, and every arrival is therefore "fresh" by the test above. That is the third
way into the harm the guard exists to prevent, alongside the two it already named — a rename, or an
environment added to a deployment with history, comments on every ticket it has ever shipped, 200 a
pulse until it has worked through them. Nothing errors, no verdict is wrong, and the harness's own
state is left correct; the failure lands entirely on other people's ticket threads, where each comment
is deliberately a new one rather than an edit and so cannot be taken back.

So a fresh reading is announced when **either** of two further things holds:

- the **name** was already asking before the announce window opened — this reading is one of a series
  rather than the first of them; or
- the **work** landed inside that window — there is no history for a new name to have mistaken this
  for.

Either alone is wrong in one direction, which is why it is both. The name test alone silences a
brand-new deployment's first genuine arrival, which is the feature's whole first impression. The
landing test alone silences a slow deploy — a release train, an environment somebody promotes to on
Thursdays — where the merge is days older than the arrival and the harness watched every pulse of the
wait.

The behaviour that falls out is the one switching `comment` on already had: a name with no history
catches the deployment's past up **silently**, stamping as it goes, and speaks for the next goal that
arrives after it.

The stamp goes down **after** the write, so a failed comment leaves the arrival for the next pulse
rather than marking it said.

### Lifting the hold

A gate needs an escape, because some goals are never going to reach an environment at all: a docs
change, a config change, work whose deployment nothing here can see. Without one they would sit
delivered with an empty bench for good, which is the harness _losing_ an obligation rather than
holding it.

`POST /api/issues/:number/environment-gate` writes an `environment_gate_releases` row, and it lifts
**every** gate on that goal at once — the case it exists for is work that does not ship, not work that
ships to three environments out of four. Cleared by deleting the row, so "not released" keeps exactly
one representation (`clearIssueConclusion`'s reason).

**The note is required**, unlike every other operator verdict's summary. The others record a
judgement about the work; this one records a decision to stop waiting for evidence, on a goal that
will then read as closed-out with nothing on the glass to say no environment ever confirmed it. The
row is the only account of why, and `GateReleaseBody` refuses a release without one.

## The bench asks for one thing at a time

The two obligations are **sequenced**, gate or no gate: the `close_out` row is not filed while the
goal's `validate` row is still open.

Filed together — which is what happened before — the bench says "run these checks" and "close this
ticket" in the same breath, and the second is an invitation to skip the first: whoever is looking has
the close in front of them and no reason to believe the order matters.

It is read off the **bench**, not off the verdict. A `flagged` verdict would hold the close for good
on a goal with one failing check, and the operator's way of saying "I am done with this" is the row —
marked done, or declined — not the checks. The close-out's detail still carries what validation is
outstanding ([20](20-validation.md)), so a row settled early is closed in front of the count rather
than past it.

This is why `ValidationReadyDesk` runs **above** `DeliveryCloseOutDesk` in the pulse. Below it, the
close-out would read a bench the validate row had not been filed onto yet and ask for the close on the
very pulse the delivery landed — the two rows arriving together, which is the thing the sequence
exists to stop.

**Clearing the delivery retracts the `close_out` row, and re-delivering brings it back**, on the
validate row's rule and through the same mechanism: the retraction wears the `DESK_SETTLED` marker
([13](13-jobs-and-tickets.md#the-seven-arms-that-file-one)) and the pass reopens the row it recognises.
Without the second half the retraction is permanent, and a missing `close_out` row is the one absence
that looks exactly like a goal that was never delivered — worse here than on the validate side, since
this is the row that says the goal is finished. An operator's own answer on the row still stands
forever.

## The desk

`src/environments/environmentDesk.ts`, run from the pulse beside the other bookkeeping and not in the
dispatcher — it staffs nothing, decides no dispatch, and no rule reads what it writes.

Six passes: attribute the merges nothing has attributed yet, ask each environment whether it is well
([above](#is-the-environment-well)), ask each environment where it is, record the goals that have just
arrived, say so on their tickets, and run the post-deploy watch's own window pass
([29](29-post-deploy-watch.md#the-window)).

The fifth is **held here rather than run beside this desk**, and its position is the invariant rather
than a preference: a watch window opens on an arrival the third pass records, so above that pass it
would read arrivals that have not been written yet and the whole feature would be one pulse late
forever, with nothing red. Making the order a line in this file is what stops a reordering elsewhere
being silent.

The attribution pass runs unconditionally; the other five return immediately with no environments
configured. That split is not tidiness: a merge SHA is only on offer while its pull request is inside
`closedPrWindowMs`, so a deployment that configures its first environment next month still wants this
month's landings on record when it does.

What is asked, and what is not:

- **A `reached` verdict is never re-asked.** That is what makes the steady state cost nothing: an
  established deployment's landings are almost all confirmed everywhere, and the only live questions
  are this week's.
- An `absent` or `unknown` older than `environmentProbeIntervalMs` is asked again.
- **An environment with nothing pending is not asked where it is at all**, so a fleet whose work is
  confirmed everywhere spawns nothing.
- At most **200 landings per environment per pulse**. The bound is on the git half now rather than on
  the probe: the spawn count is one per environment however many goals are in flight, and what is
  left to scale is the argument list the clone is handed. What the cap leaves out is asked on the next
  pulse, oldest landing first, so the queue drains in a fixed order and nothing starves.

A probe that could not answer writes `unknown` against **every** landing it was going to answer for,
rather than leaving them untouched: an environment that has gone dark is a thing the cockpit has to be
able to say, and silence there is indistinguishable from nobody having got round to it.

A pass that throws is recorded through `errors.record` and never fails the cycle.

## The lens

`src/environments/reach.ts`. `goalReach` folds a goal's landings and their readings into one row per
environment.

The fold itself is `rollUpReach`, and it is **exported rather than private** because the
[feature board](17-cockpit.md#the-feature-board) asks the same question one tier up: a Feature is to
its goals what a goal is to its landings, and `partial` is the interesting value in both places. One
implementation and not two, because the rule that matters — **`unknown` never folds to `absent`** — is
exactly the one a second copy would get wrong quietly. Nothing else about the feature board is this
subsystem's concern; it reads these rows and writes none.

`partial` is the reading the lens exists for. A goal is several pull requests, they land separately,
and a release cut between two of them puts half a feature in production. Folded to a boolean, that
reads as "shipped" — wrong in the expensive direction.

**The denominator is the goal's work, not its merges.** A plan is cut into parts up front and they
merge one at a time, so a fraction counting only what has landed is whole on the day the _first_ part
merges: the environment holding one of four parts read `reached`, the arrival was recorded, its
comment went out and its gates opened — on a quarter of the feature, with nothing red and nothing to
suggest the other three parts were ever coming. So `total` counts the parts the goal still owes a
merge as well, and each of them counts as **`absent`, never `unresolved`**: a part with no commit yet
is not a question the probe could have answered, and reading it as `unknown` would send an operator
looking at a probe that is working perfectly.

`partsOwed` decides what is still owed, and its three exclusions are each the difference between a
fraction that closes and one that never does:

- a **settled** part (merged or concluded) is done being owed — and a merged one is already in the
  count as its landing, so counting it twice would halve every planned goal's reading;
- a **retired** part was un-planned by an amendment and is not work any more; likewise every part of
  an **abandoned** plan, since the plan is the thing that claimed they were work;
- a part expected to produce anything **other than code** never merges anything. A report, a
  determination or a person's hand-check left in the denominator sits there for good: the goal reads
  `partial` in an environment holding every commit it has, its arrival is never recorded, its comment
  never posted and its gated `validate` and `close_out` rows never filed. That is a goal held off the
  bench for ever by a part with nothing to deploy, and it is silent — the card reads `3/4` and looks
  exactly like work waiting on a release. `expectedKind` null reads as `code`, as everywhere else.

It is a rule about the **denominator only**. The goal set is unchanged: a plan whose first part has
yet to merge is still dropped rather than drawn `0/4` on every environment from the day it was cut.

**`unknown` beats `absent`.** Nothing may report work as not-deployed on the strength of a probe that
could not answer, or a merge whose commit nobody caught. So:

| Counts                                                         | Status    |
| -------------------------------------------------------------- | --------- |
| nothing owed at all                                            | `absent`  |
| every landing confirmed, and nothing still owed a merge        | `reached` |
| some confirmed, some not                                       | `partial` |
| none confirmed, something unresolved                           | `unknown` |
| none confirmed, and everything owed is unmerged or answered no | `absent`  |

`total` counts the goal's landings **plus** its merges the sweep could not attribute
(`unattributedMerges`) **plus** the plan parts it still owes a merge (`partsOwed`). The middle term is
read from the work graph rather than the world for the reason above: a world-only count would report
every goal fully accounted for the moment its merges aged out of the closed window.

`at` is the _newest_ reading among a fully-reached goal's landings — the moment the whole goal was
there, not the moment the first part of it arrived. It is also what an arrival is stamped with, and
what the announce pass reads to tell an arrival it watched from one it merely discovered.

Each row also carries `opens`, the gates the operator declared on that environment. It rides on the
row rather than being looked up beside it so that nothing drawing the hold holds a second copy of the
configuration to disagree with this one.

`allGoalReach` folds every goal worth a row, and is the one place that set is decided — shared by the
cockpit's panel and by the desk that records arrivals, because two folds of "which goals have been
anywhere" would be two answers to the question a ticket comment is posted off.

## In the cockpit

`buildEnvironmentReach` in `src/server/stateSnapshot.ts` ships `CockpitState.environmentReach`: one
`GoalReachView` per goal that has landed something or has a merge nothing could attribute. The goal
set comes from the landings and the work graph, never from the world — a goal is at its most
interesting to this panel once its ticket has closed, which is precisely when the world stops listing
it.

The goal page draws an **Environments** card under the pull requests, one row per configured
environment, with the count on every row that is not whole: `0/3` and `2/3` are the difference
between work that has not started moving and work that is halfway there, and the word alone says
neither. Each row's sentence says **work**, not merges — the count includes a plan's unmerged parts,
so a row reading `some of this goal's merges are here` beside `1/4` would be a sentence disagreeing
with the number next to it. The tones are ones the cockpit already defines — `partial` takes the _attention_ tone rather
than a success one, because half a feature in production is the state most likely to want somebody.

Each row that opens something says so (`opens the validation checks and the close-out`), on the row
that would do the opening: an operator reading a held goal asks "waiting for what" exactly once, and
the answer is configuration they may not remember writing.

**A hold is drawn, because nothing else would draw it.** `GoalReachView.gateHold` is non-null only for
a goal that is delivered and gated right now, and the card states it in a sentence with the release
control beside it. Without that line a delivered goal with an empty bench is indistinguishable from a
finished one, and the harness would be waiting where nobody could see it. It is deliberately **not** a
Needs-you row: with a gate on the first environment, every delivered goal is held for as long as a
deploy takes, and a rail carrying all of them would bury the asks somebody can actually answer.

**So a held goal gets a row _because_ it is held**, and that is the second arm of the goal-set rule —
one `GoalReachView` per goal that has landed something, has a merge nothing could attribute, **or is
held right now, or released from one**. Without the third clause the rule and the sentence above contradict each other on
exactly the goals that matter: a goal delivered with nothing merged has landed nothing to fold, so it
ships no row, and both the hold sentence and the release control live inside a card an empty list
stops drawing. Those are the goals the escape hatch was written for — a docs change, a config change,
work that shipped from another repository — so the control was absent precisely where it was needed,
and the goal sat delivered with both obligations withheld, reading as finished. The row draws
`absent 0/0` on each configured environment, which is the honest fraction: nothing has landed, of
nothing. A **released** goal is kept for the same reason as a held one: the `Not waiting on an
environment` line and its note are drawn in that card too, so a release that dropped the row would
lift the gate and erase the only account of why. The arm widens **only** the cockpit's fold — `EnvironmentDesk` passes no `held` set, so
nothing about which arrivals are recorded or commented on moves — and it cannot bury anything, since a
hold is non-null only while a goal is delivered, unshortfalled and not yet gated through.

The goal row in the overview carries the **furthest environment** holding the goal whole — last
declared, not best, since the operator's list is the order the work travels in. `partial` and
`unknown` are not furthest anything: a chip reading `liveUs` for half a feature is the boolean rollup
the lens refuses to make, one layer up.

Arrivals also reach the **World signals** panel, merged into the feed at render time from
`CockpitState.environmentArrivals`. They are deliberately **not** `WorldEvent`s: those are derived by
diffing consecutive world snapshots, and a standing delivery verdict is expired by _any_ world event
on its issue ref ([03](03-world-model.md), `deliveryHold`) — so an arrival written as one would lift
the delivery park on the very goal it announced and hand the work straight back to the fleet to do
again.

The card is absent entirely when nothing is configured. A row of question marks on every deployment
that never set one up would be a feature announcing itself as broken.

## What it does not see

Stated so a later change does not discover them as bugs:

- **A merge that left the closed window unobserved.** The harness down for longer than
  `closedPrWindowMs` loses that landing permanently. It is lost rather than wrong: the merge is
  counted as unattributed and the goal reads `unknown`, never `absent`.
- **A rollback.** A confirmed landing is never re-asked, so an environment that goes back past a
  commit still reads as holding it. This is cheaper to revisit than it was — under `at` the answer is
  a local ancestry question rather than a spawn per landing — and is still not done.
- **A goal arriving twice.** A goal that grows another pull request, lands it and is confirmed again
  has one arrival row, so it collects no second comment. The reach row moves back through `partial`
  and on to `reached`, which is what the card draws; the arrival is the first time, and stays it.
- **Arrival time finer than the probe interval.** `at` is the timestamp of the first poll that said
  yes, not of the deploy.
- **Work that lands in another repository**, or a monorepo environment that deploys one
  subdirectory. The first has no commit in this clone to ask about; the second will answer "reached"
  for a commit that never touched the deployed path. Both are answerable — a per-environment repo
  root, a per-environment path filter — and neither is implemented. The second is also what makes the
  hold need a hand-lift: a docs-only goal never arrives anywhere a pipeline-shaped probe can see, and
  a path filter is what would let the harness work that out for itself.
- **An environment that deploys from a branch the integration branch does not reach.** A cherry-picked
  release branch has a different commit for the same change, and ancestry answers `absent` about it
  forever.

## Persistence

Five tables, described in [14](14-persistence.md), all owned by `EnvironmentStore`:

| Table                       | One row per               | Written                                                          |
| --------------------------- | ------------------------- | ---------------------------------------------------------------- |
| `goal_landings`             | merged pull request       | `OR IGNORE` — a merge is a settled fact                          |
| `environment_reach`         | `(sha, environment)`      | `OR REPLACE` — an observation of something that moves            |
| `goal_arrivals`             | `(goal_ref, environment)` | `OR IGNORE` — arriving twice is not two arrivals                 |
| `environment_gate_releases` | goal                      | `OR REPLACE`, deleted to clear                                   |
| `environment_health`        | environment               | replaced each reading, `changed_at` held across an unchanged one |

`goal_landings` is keyed on the pull request for `branch_reaps`' reason — a branch name is reusable,
and a goal can land more than once.

`goal_arrivals` is `OR IGNORE` rather than `OR REPLACE` for a second reason beyond the first: a
replace would clear `announced_at`, so a goal that grew another merge would collect a comment per
later landing.

All are bounded by the landings times the environments, and none is pruned.
