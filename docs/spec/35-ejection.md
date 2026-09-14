# 35 — Ejection

An operator is reading a running agent's transcript and can see it has gone the wrong way. The
harness's answers to that are the plan and the pull request: argue with the plan before the work
starts ([08](08-planning.md#the-link)), review the diff after it lands ([07](07-pull-requests.md)).
Both are the right answer and both are answers at a moment that has already passed. What is missing is
the one in the middle — **the agent is wrong, now, and I want the keys** — and its absence is what
sends people to Kill, which throws the work away and hands the same issue straight back to the fleet.

An ejection is that middle door. It stops the agent, gives the operator its worktree and its
conversation, and **holds the issue for them** until they say what happened to it.

It is deliberately a halfway house rather than a workflow. The front doors are better, and this
document says so in the shape of the feature: the ejection asks for a reason, it costs a visible slot,
it lands in the feed, and it is counted. A team ejecting three times a week is telling you their plan
review happens too late, and the harness should let them see that rather than make ejecting
comfortable.

## What it is not

| Not                        | Because                                                                                                                                                                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A kill                     | `agents.kill` settles the task and **releases** the origin: the fleet is free to staff the issue again on the next pulse, which is usually what the operator did not want. An ejection kills the same way and then holds what the kill let go. → [the transaction](#the-transaction)           |
| A steer                    | `POST /api/agents/:id/interrupt` plus `respond` corrects an agent that keeps its slot, its branch and its conversation. That is the cheaper intervention and stays the first one offered. Ejection is for when the operator wants the work, not a word with the agent. → [the fork](#the-fork) |
| A pause                    | Nothing resumes an ejection. There is no arm that puts the same agent back on the same task — the conversation is handed to a person, and what comes back is a branch, a job, or a pull request. → [settling](#settling-it)                                                                    |
| A crash                    | `RecoveryDesk` decides for work whose agent died unasked, and holds the whole pulse until an operator answers ([10](10-agent-runtimes.md#the-hold)). An ejection is intended, its answer is already known, and it holds nothing but its own origin.                                            |
| A validation claim         | The desktop channel's existing claim is a hold on **one check** that releases when the socket closes ([20](20-validation.md)). This one holds an **origin**, survives the session ending, and is released only by a settle or its expiry. → [the claim](#the-claim)                            |
| A second way to write code | The fleet is not competing with the operator for the branch. An ejection is exclusive by construction: while it stands, nothing the harness does can put an agent on that issue or in that directory.                                                                                          |

## The fork

The controls on a live agent are ordered by what they cost, and the order is the design:

| Control       | Keeps                           | Costs                                                  |
| ------------- | ------------------------------- | ------------------------------------------------------ |
| **Interrupt** | slot, branch, conversation      | nothing                                                |
| **Respond**   | slot, branch, conversation      | nothing                                                |
| **Eject**     | branch, conversation, the issue | the slot, for as long as the operator holds it         |
| **Kill**      | branch                          | the conversation, and the issue goes back to the fleet |

Interrupt and Respond are drawn first and drawn plainly. Eject sits after them and opens a dialog;
Kill keeps the quiet treatment it has. An operator who wants to say "not like that, like this" should
find the control that costs nothing before the one that costs a worktree.

## The claim

The record is one row, and it is the whole mechanism. `src/store/ejections.ts`, table
`ejections`, one row per live hold and kept after settling as the history the feed reads.

| Field                   | What it holds                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `origin_ref`            | The dispatch origin the ejected agent was working — `issue:412:execute`. What the hold is _on_.                                                                        |
| `branch`                | The branch its worktree has checked out. Held alongside the origin, because branch and origin are two separate dedup keys.                                             |
| `worktree_path`         | The pool slot the operator is being handed. What the deep link opens, and what `pool.held` keeps out of the pool.                                                                                     |
| `agent_id`, `task_id`   | The run that was ejected. The transcript, the spend and the files hang off these; the ejection itself stores none of them again.                                       |
| `session_id`            | The agent's `claude` session, so the resume command can be offered. Null on a runtime that keeps none, which makes it unofferable.                                     |
| `reason`                | The operator's line, required. Read by the desktop session on arrival and shown wherever the ejection is drawn.                                                        |
| `ejected_at`            | When the hold started. With the configured window, this is the expiry.                                                                                                 |
| `last_seen_at`          | The heartbeat. Null until first contact, which is **not** the same as zero. → [calling home](#calling-home)                                                            |
| `last_note`             | The most recent line the desktop session posted about what it is doing. Best-effort and often null.                                                                    |
| `settled_at`, `outcome` | Null while live; one of `handed_back`, `requeued`, `delivered`, `expired` once not. → [settling](#settling-it)                                                         |
| `settle_note`           | What the operator said happened while they had it. Required on `requeued`, where it is also the fresh agent's preamble; optional on the others and kept as the record. |

`origin_ref` is the identity, and at most one live row may exist for one origin — a partial `UNIQUE`
index on `(origin_ref) WHERE settled_at IS NULL` says so in the schema rather than in a predicate a
caller has to remember. Not because two would be ambiguous — because two would mean the harness let a
second agent onto an origin an operator was already holding, and the row is what proves it did not.

The table is new, so its columns ship in `CREATE TABLE`. They still get `ColumnMigrations` entries in
the owning module: a table being new **once** does not keep it exempt, and the columns added after the
first release are exactly the ones nobody remembers to declare
([14](14-persistence.md#migrations)). `last_seen_at` null meaning _never contacted_ rather than _long
ago_ is a null that means something, and any later backfill over it has to be gated on `ensureColumns`'
report ([14](14-persistence.md#when-a-null-means-something)).

## The transaction

`POST /api/agents/:id/eject` (`src/server/routes/ejections.ts`), body `{ reason }`, and the order
inside it is load-bearing at both ends.

1. **Kill through `session.kill()`.** Not a direct signal. The injected `ProcessReaper` takes the
   process _subtree_ first, because the agent's shells hold the worktree as their cwd and a reap after
   the child dies finds nothing — after which every dispatch onto that branch fails `EBUSY`, forever.
   → [10](10-agent-runtimes.md#reaping-the-process-subtree)
2. **Settle the task `interrupted`,** exactly as `kill` does today. This is the step that releases the
   origin, and it is why step 3 is not a separate request.
3. **Write the claim,** with no `await` between it and the kill. Between 2 and 3 the origin is unheld;
   a pulse that landed in that window would staff the issue again. `src/store/` writes are
   synchronous and the pulse is on the same event loop, so an unbroken synchronous run is what closes
   the window — and it is why `EjectionDesk.eject` does the kill itself rather than leaving the claim
   to a second request ([14](14-persistence.md#shape)).

The agent row is left `killed` and the task `interrupted`. Nothing invents a new agent status and
nothing invents a new task status — in particular the task is **not** left active. An active task with
no live agent is precisely the shape `crashRecovery` hunts for, and an undecided orphan holds the
entire pulse before the world fetch ([10](10-agent-runtimes.md#the-hold)). Leaving the task active
would build a fleet-wide stall into the feature to save one predicate.

### Holding the origin

`activeOrigins` gains a third source. It is the origins of every active task, plus the `originRef` of
every job standing in for one, **plus the `origin_ref` of every live ejection**
(`src/dispatcher/ruleDispatcher.ts`). One line, in the place that already folds in standing jobs for
the same reason: a rule that cannot see work in flight staffs it twice (#249).

Because it goes in there, every dispatch rule is suppressed at once, and no rule is edited. A rule
added later inherits the suppression without knowing this document exists — which is the property
worth having, since the alternative is a per-rule test that every future rule has to remember to pass.

The branch is held the same way, wherever `findActiveTaskByBranch` is the thing standing between two
agents and one directory: the executor's branch gate and its `update_pr_branch` arm, and `submitBrief`.
Each refuses by naming the ejection, because "branch busy" on a branch no task holds reads as a bug.

### Holding the slot

The worktree is **not** returned to the pool, and the hold is **not** a lease. Both halves are one
line in the composition root:

```ts
held: (branch) => store.tasks.findActiveTaskByBranch(branch) !== null || store.ejections.ejectionOnBranch(branch) !== null,
```

`WorktreeManager.holder` asks `pool.held` about a slot's occupant before anything else, so a branch an
ejection names is never `evictable`, never handed over, and never wiped.

**It has to be a row rather than a lease, and that is the sharpest edge in the feature.** Leases are an
in-memory `Map` on the manager, so they do not survive a restart. After one, a slot held only by a
lease looks free, reads as evictable, and a hand-over to another branch runs `git clean -ffdx` over it.
The survey refuses a slot carrying uncommitted **tracked** changes, so the operator's edits to existing
files would survive; their new files and their ignored files would not, and neither would the install
the next dispatch would have reused. A claim read from SQLite on every `ensure` has no boot step to
forget. → [09](09-execution.md#handing-a-slot-over)

A held slot must also not be one the cap was counting on, so the pool **grows** by the live ejections
rather than sharing its bound with them:

```ts
get size() {
  return defaultPoolSize(runtimeControl.cap) + store.liveEjections().length;
}
```

`defaultPoolSize` is `RuntimeControl.cap` plus a slack of two. Left alone, two ejections would swallow
the slack and a dispatch above the real number is refused for want of a directory and retried forever —
a full Up next queue over an idle fleet with nothing red ([09](09-execution.md#exhaustion)). Both are
read by reference on every `ensure`, so a cap raised at runtime and an ejection settled at runtime both
land at once.

## The handoff

### The link

The cockpit's control opens the operator's own Claude Code on the worktree:

```
claude://code/new?q=/lubbdubb%20eject%20412&folder=<worktree_path>
```

Built by `desktopDeepLink(folder, prompt)` (`web/src/cockpit/desktopLink.ts`), the same builder the
plan-discuss link uses, with **one deliberate difference**: `folder` is the _worktree_, not
`config.desktopFolder`. Discussing a plan wants the repository; taking over a run wants the branch,
checked out, with the agent's uncommitted work in front of you. A session opened at `repoRoot` would
be a Claude looking at `main` and reporting that none of the described work exists.

The host stays `code` rather than `claude.ai`, for the reason [08](08-planning.md#the-link) gives: only
that surface has the repository, the skill and the MCP registration. And the link only fires on the
machine the browser is on, which is the same limit every desktop control here has — so the command is
in the `title` too, for an operator who has to type it.

### What the session gets

The desktop MCP server is registered `--scope user` (`src/mcp/desktop.ts`), so its tools are live in
that session wherever it opens — including a worktree the operator has never opened before. Three tools
join `DESKTOP_TOOL_NAMES` (`src/mcp/names.ts`) and `src/mcp/desktopTools.ts`:

| Tool              | What it does                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ejection_read`   | The brief the agent was given, the operator's own reason, the agent's last `note_progress` line, the tail of its transcript, the commits and files on the branch, and the time remaining. |
| `ejection_note`   | One line about what the operator is doing now. Writes `last_note` and stamps `last_seen_at`. → [calling home](#calling-home)                                                              |
| `ejection_settle` | The three arms below, with a note. → [settling](#settling-it)                                                                                                                             |

The `/lubbdubb` skill (`src/validation/desktopSkill.ts`, rewritten into the operator's Claude Code on
every boot) grows an `eject <n>` arm beside its `discuss <n>` and `<n>:<letter>` ones. It says: read
the ejection, say plainly what the agent had done and where it went wrong, then **follow the
operator's lead**. It does not resume the agent's work on its own — an ejection is a person taking
over, and a session that carries on regardless has reproduced the thing they ejected.

### The conversation itself

A deep link cannot resume a conversation: `claude://code/new` starts a new session and `--resume` is a
CLI flag. So the two cases are offered as two different things, and neither pretends to be the other.

- **A fresh session, seeded** — the link above. What most ejections want: the context, in the worktree,
  one click.
- **That agent's own conversation** — `claude --resume <session_id>`, shown in the cockpit's detail for
  the ejection, to paste into a terminal in the worktree path. Offered only where `session_id` is
  non-null, since a runtime that keeps none cannot resume ([10](10-agent-runtimes.md#launch-arguments)).
  The launch cwd is load-bearing: `claude` resolves the transcript at
  `~/.claude/projects/<slugified-cwd>/<id>.jsonl`, so the command is only correct from the worktree —
  which is one more reason the slot must still be there.

## Calling home

A held slot that says only _held_ ages badly. By hour six nobody can tell whether the operator is deep
in the diff or has forgotten, and the cockpit's answer to that question must not be a guess dressed as
a fact. Three signals feed the line, in decreasing order of reliability:

1. **Any tool call on the claim.** `ejection_read` and `ejection_note` both stamp `last_seen_at` on
   the claim they name. The read on arrival already counts, so the line is warm from the first second
   and it needs nothing from the model.
2. **A posted line.** `ejection_note`, which the skill asks for at natural points — after a commit, on
   a change of direction. The same shape as `note_progress` on the fleet channel, and the same
   reliability: it happens when the model remembers. When it does the card shows the words instead of
   the timestamp; when it does not, signal 1 still holds the line up.
3. **The worktree itself** — file mtimes, `git status`, commits on the branch since `ejected_at`.
   The harness owns the directory and could read it, and it is the only signal that separates a
   session sitting open from work actually happening. **Not built.** Until it is, a claim whose
   session went quiet reads as quiet, which is the honest answer rather than a wrong one.

Three rules keep the reading honest:

- **Silence never releases a claim.** Only a settle or the expiry ends a hold. An operator reading a
  diff on a plane is not an abandoned ejection, and a harness that takes work back on quiet takes it
  back half-done — into a branch whose state nobody has described.
- **`never contacted` is its own state, not "last seen 0m".** The harness cannot know whether the deep
  link fired: wrong machine, a client that does not handle the scheme, a click and a distraction. A
  claim with no contact past `ejection.contactGraceMinutes` says so on its card, and offers the link
  and the resume command again. This is the likeliest real-world failure of the whole feature and it
  must not draw as a healthy fresh hold.
- **Nothing dispatches, releases or nudges on `last_seen_at` alone.** It exists so a person reading the
  fleet can tell a live hold from a stale one. The mechanism is the expiry, which is a clock, not an
  inference.

## Settling it

Ejecting is easy. The failure this feature actually has is people ejecting and never telling the
fleet — so hand-back is a first-class verb with three arms, reachable from the cockpit and from
`ejection_settle`, and **every arm releases the claim and the slot**.

| Arm           | The operator is saying              | What happens                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handed_back` | "never mind — the agent was right"  | The claim is released and nothing else is written. The rule that produced the work proposes it again on the next pulse, reading the branch as it now stands. Cheapest arm, and the one an operator who ejected on a misreading should find first.                                                                                                                                                                       |
| `requeued`    | "I fixed the direction, you finish" | Files a **job** carrying the work: the original prompt, a preamble naming what the operator changed and why, and the ejected origin on `Job.originRef`. The gates read that field while the job is queued and while its task is live, so the job cannot race a fresh rule dispatch — the same mechanism a crash requeue uses, for the same reason (#249). → [13](13-jobs-and-tickets.md#standing-in-for-another-origin) |
| `delivered`   | "it's a pull request now"           | The branch has a PR, so the work is back in the workflow the fleet already understands. Nothing stands in for anything: the pull-request rules are the next staffing decision ([07](07-pull-requests.md)).                                                                                                                                                                                                              |

The note is required on `requeued` — it is the preamble a fresh agent reads — and optional on the
other two.

### Expiry

A claim older than `ejection.expiryHours` (default 8) is expired by `EjectionDesk.sweepExpiries`, which
runs in the pulse beside the stall and usage-limit sweeps — by the cycle, not by a timer of its own: outcome `expired`, the slot returned, the origin eligible again. It is **announced** — the feed
carries it and the bench row goes with it — because an expiry is the harness taking work back from a
person, and doing that silently is how an operator returns to a branch that has moved under them.

Eight hours is a working day's outer edge. It is long because the failure of a hold that is too short
(the fleet re-staffing work someone is mid-way through) is worse than the failure of one that is too
long (a slot idle overnight, visible on the fleet view the whole time).

## In the cockpit

**The ejected slot is drawn in the Fleet view, as a peer of the running agents.** Not tucked into a
detail panel and not only on the goal page: the fleet view is where an operator looks to ask what the
harness is doing, and a slot that is spoken for is part of that answer. It carries the goal, the
branch, who holds it, the liveness line and the time remaining:

```
#412 rebuild the ingest queue
you · last seen 3m ago · reverting the store extraction · expires in 7h 12m
```

Its controls are the deep link and the three settle arms. Its tone is the operator's, not the fleet's —
the whole point of the row is that the thing in this slot is a person.

**The time remaining is read as a deadline, not as an age.** `relTime` clamps anything in the future
to `0s ago`, so the hold with seven hours left said the harness was about to take it back — on every
ejection, from the moment it was made. It draws `timeLeft` (`web/src/components/util.tsx`), which
words the span and says `any moment` once it is up; the stall park's own sentence on the same card
had the same bug and the same fix.

**It is the widest row the Fleet card draws, and the card is sized for it.** Its state word is
`taken off the fleet` and its action is two controls where every other row's is one, so both the
state and the action rails are widened on the Fleet card itself rather than on the tokens every card
shares ([17](17-cockpit.md#the-overview)).

It wears the desk run's **violet** — both are a person at a keyboard rather than a dispatch — and the
two are told apart by fill and stroke rather than by a fourth colour: the desk run's lamp is hollow and
its edge dashed because it takes no slot, the ejection's lamp is filled and its edge solid because it
takes one.

The ejection is in the activity feed at both ends, as a `no_op` decision carrying its reason and its
outcome ([18](18-observability.md)). The number is the interesting part: an occasional ejection is a
harness meeting somebody halfway, and a constant one is a plan-review problem wearing a different hat.

**Not built:** the bench row, and the per-goal and per-operator counts. The bench row would be the one
there that is `yours` while consuming a slot — the existing split is on who is stopped, and an ejection
has no parked agent and an obligation squarely the operator's
([17](17-cockpit.md#hue-is-the-kind-weight-is-the-group)). Until it is, the Fleet card is the whole of
where a held slot is said, which is the surface the operator asked for it on.

## Configuration

| Key                            | Type      | Default | What it does                                                                                                                                            |
| ------------------------------ | --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ejection.enabled`             | `boolean` | `true`  | Whether the control is offered. Off, the cockpit draws no Eject and the route refuses; a claim already live is still honoured, drawn and settleable.    |
| `ejection.expiryHours`         | `number`  | `8`     | How long a hold stands before the harness takes the work back and says so. `0` means no expiry, which is the operator accepting the wedge it can cause. |
| `ejection.contactGraceMinutes` | `number`  | `15`    | How long a claim with no contact at all reads as fresh before the card says `never contacted` and re-offers the link.                                   |

Declared in `src/config/configFields.ts` with the rest, defaulted in `src/ejection/policy.ts` rather than at a
use site, listed in `DEEP_MERGED_BLOCKS` so a save of one leaf does not drop the other two, and grouped
in `src/server/runningConfig.ts` so it is not invisible in the config form
([02](02-configuration.md#precedence)).

## What fails silently

Each of these fails without going red, which is the class this repository treats as load-bearing. Each
has a section above that exists to prevent it.

| If this is missed                          | What the deployment sees                                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The claim in `activeOrigins`               | The task settles `interrupted`, the origin frees, and the next pulse puts a second agent on the issue — onto a branch a human is editing. Two agents' worth of work, one of them thrown away.  |
| Holding the slot with a row, not a lease   | A restart makes the held slot look free. A hand-over wipes it with `git clean -ffdx`, taking the operator's untracked and ignored files with it. Their tracked edits survive; nothing says so. |
| Counting the slot against the cap          | The cockpit reports headroom that does not exist. Dispatches are refused for want of a directory and retried forever — a full Up next queue over an idle fleet.                                |
| An expiry, or a visible home for the claim | A hold nobody settles keeps the origin shut for good. The goal simply stops advancing, and no surface says why.                                                                                |
| Reaping the subtree before the signal      | The agent's shells keep the worktree as cwd. Every later dispatch onto that branch fails `EBUSY`, permanently, and the failure names a directory rather than an ejection.                      |

## Tests

At the `buildSystem` seam, with `FakeWorktreeManager` injected — a test that dispatches or ejects a
code agent without it cuts a real branch in the developer's own checkout
([19](19-development.md#why-a-test-must-not-dispatch-through-the-real-worktree-manager)). The ones that
carry the argument:

- An ejection while a rule would otherwise dispatch that origin, asserting **no** action is proposed
  for it on the following pulse — and that the same origin is proposed again the pulse after it settles.
- The same for the branch, through `findActiveTaskByBranch`.
- A restart with a live ejection, asserting the slot is not evictable afterwards and that a hand-over
  requested while it stands takes a different slot or grows the pool.
- Each of the three settle arms, and for `requeued` that the filed job stands in for the ejected origin
  so a fresh dispatch is skipped while it is queued.
- Expiry: the outcome is written, the slot returns, the origin becomes eligible, and the feed carries it.
- `last_seen_at` null reading as `never contacted` rather than as a stale timestamp, and a settle
  refused on a claim that is already settled.
