# Operating LubbDubb

For a developer who is happy to use AI and now has to run a fleet of it. This is not a tour of the
buttons — [17 — The cockpit](spec/17-cockpit.md) is that. It is the change of job.

> **To skim rather than read**, open [`docs/operating.html`](operating.html) in a browser: the same
> guide, segmented — the five moves, the six asks and the day as tables and cards. This file is the
> full text, and the two are changed together.

You have probably already used an agent the way most people do: open it, describe a change, watch it
work, take the diff. That is a **tool**. LubbDubb is not a faster version of it. The harness holds
the loop — it watches your tracker, your pull requests and your CI on a heartbeat, decides what to do
next, and puts agents on it — and hands you back the handful of decisions that are actually yours.

The whole shift is one sentence:

> **You stop producing the change and start owning the verdicts.**

Everything below is what that means in practice.

## What moves off your desk, and what does not

| You used to                                  | Now                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| Pick the next ticket                          | The dispatcher ranks every candidate; you re-order **Up next** if wrong |
| Cut the branch, open the PR                   | An agent does, per part, in its own worktree                            |
| Chase red CI                                  | Each failing check is classified and worked, or held if it isn't ours   |
| Write the change                              | An agent writes it; you read the plan and the delivered result          |
| Decide what "done" means                      | **Still you.** Nothing else                                             |
| Decide whether the goal was even clear        | **Still you**, when the assay says it isn't                             |
| Decide whether this may leave the building    | **Still you.** No comment, merge or ticket goes out unauthorized        |

The pattern is that **the harness owns the loop and you own the judgement**. Where a step needs a
call — is this goal clear, is this plan right, is this failure ours, may this go out — it is a human
decision or a configured rule, never a branch buried in the code.

## The unit of work is a goal, not a branch

This is the first habit to break. You do not think in branches any more; the harness cuts them and
reaps them. You think in **goals**, and a goal is a ticket.

Two ways to start one, converging on the same path:

- **Write the ticket** in GitHub or Azure DevOps, tag it watched, and it enters the funnel on the next
  pulse.
- **Type it into Launch** in the cockpit. With a tracker configured, a code blueprint is _filed as a
  watched ticket_ and enters the same funnel — it is not coded straight off your prompt. That is
  deliberate: work started from a sentence you typed is then as recoverable, reviewable and reportable
  as work started from the tracker.

A **desk** job is the exception — a question, a report, a sweep. It runs as asked, with no ticket and
no branch, and its deliverable is prose.

From there, one path:

```
ticket → enough information? → plan → you accept the plan → work → goal achieved? → report
```

Three of those are gates that something has to _decide_, not steps that always pass. Two of the three
are yours.

## Your five moves

Everything you do in a day is one of these.

### 1. State a goal well enough to be worked

The first gate is an agent reading your ticket against the repository and answering one question:
**is there a goal here to work from?** An `unclear` verdict stops the goal, says what is missing on
the ticket, and waits.

That gate is doing you a favour, and the way to work with it is to write tickets for a reader who has
the code but not your last three weeks:

- **Say what should be true when it is done**, not what to type. "Retry the intake fetch on 5xx with
  backoff, give up after 3" beats "fix the intake bug".
- **Name the thing.** File, route, screen, symptom. The agent can search; it cannot guess which of
  four panels you meant.
- **Paste the evidence** — the error, the failing input, the screenshot. Attachments follow the issue
  through to the agent working it, and images paste straight into the Launch composer.
- **Don't write the diff.** A ticket that dictates the implementation gets you a worse one than the
  agent would have found, and hides the fact that you had not decided the outcome.

When you _know_ the assay is being precious and the goal is fine, the Backlog tab's intake group has
**Override → workable** beside the quoted refusal. Use it and move on; it is one click, and the
override exists because you are allowed to be the one who knows.

### 2. Answer what is in "Needs you"

The left rail is the whole of your inbox. Six kinds, two groups, and the colour rule is exact:
**red means an agent is parked on a question only you can answer**; amber means the obligation is
yours and nothing in the fleet is waiting.

| Kind                   | What it is                                                     | How you answer                              |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| **Escalation**         | A parked agent asking you something                             | Type the answer; it unparks                 |
| **Plan proposal**      | A decomposition into parts, before any of it is built           | Accept, or reject with a reason             |
| **Outbound proposal**  | Something an agent wants to send into the world                 | Accept or reject                            |
| **Permission request** | An agent hit a command outside the allow-list                   | Allow or refuse                             |
| **Bench task**         | Work only a person can do — flip a setting, look at a screen    | Do it, then mark done (or decline, w/ note) |
| **Close-out**          | A delivered goal whose ticket is still open                     | Close it; it settles itself when you do     |

Two things worth internalising:

- **A rejection is not a dead end and not a mute button.** It stands until the world gives a reason to
  ask again — a push, a CI result, an approval, a comment — and _the reason you typed is handed to the
  next agent that works that item_. So write the reason as if the next agent is going to read it,
  because it is.
- **Answering happens on the goal's page**, with the ticket, the plan, the sibling parts and what is
  waiting on this ask all around it. An escalation read without its goal is a sentence with no
  subject; resist answering from the row alone when the page is one click away.

The plan proposal is the highest-leverage thirty seconds in your day. It is the last cheap moment to
change the shape of the work. Read the parts and their dependency chain, not the prose. Ask: is this
the right decomposition, is anything missing, is a part doing two things. Rejecting costs the fleet
one replan; accepting a bad shape costs you every PR that comes out of it.

### 3. Steer mid-run, sparingly

Click any agent to open its drawer: live transcript, its reasoning, its tool calls folded out of the
way, and **you can type into it**. That is the escape hatch for "you're going the wrong way" without
killing the run.

Use it when the agent is heading somewhere wrong. Do not use it to code by proxy, one instruction at
a time — if you are doing that, the ticket was underspecified and you should say so, kill the run,
and fix the goal. Steering every agent is the single most common way people fail to get value out of
this: it converts a fleet back into one pair of hands.

### 4. Judge what was delivered

The last gate — **goal achieved?** — is asked of what actually landed, not of the agent's confidence
in itself. A `no` goes back to _planning_, not to coding, because what is missing may be a different
decomposition.

Your part is the header controls on the goal page:

- **Mark done** when the goal is met.
- **Work left** when it is not — a third control rather than the other end of the toggle, because it
  is what puts the goal back in front of the harness once no PR is open.
- **Raise a bug** when you ran the thing and it does not do what you expect. That is the one fact
  about a goal no agent on it can derive, because none of them ran it. Your words become the new
  goal.

Note what the harness will not do: **it never closes your ticket.** A delivered goal whose item is
still open files a close-out on your bench, which settles itself the moment the tracker stops listing
the item open.

### 5. Conclude, or let it end

A run lives until it is ended. `Mark done`, `Work left`, or `End the run` on a retained one. A fleet
whose goals never conclude fills the rail with obligations nobody has retired, and that is the state
in which people stop reading the rail — which is the only real failure mode of this whole
arrangement.

## A day, concretely

**Open the cockpit.** If the recovery banner is up, deal with it first — a previous run left agents
orphaned, and while it stands **no cycle runs at all**, so everything else on screen is stale for one
reason. Restore, requeue or remove each one.

**Drain the rail, blocking first.** Red rows are holding agents that are costing you a slot and a
worktree while they wait. The rail sorts most-holding first for exactly that reason, and it never
re-sorts under you.

**Glance at four readings in the top bar**, in this order:

- **Faults** — recorded failures. Amber, blocks nothing, but a rising count means something is
  quietly not working.
- **Output** — the one reading against _time_, and the only way to tell a fleet that is producing from
  one that is merely busy. The number to watch is **dispatches per merge**: effort over output. A
  rising first line over a flat second one is a fleet spinning, and the fix is almost always upstream —
  goals too vague, plans too coarse, a check nobody classified.
- **Yield** — how runs ended, the CI red rate, and the median time back to green.
- **Spend** — where the money went, by phase and by goal.

**Check Up next.** It is the dispatcher's ranked plan with a cut-line at your current headroom, each
row carrying its reason verbatim. If the order is wrong, drag it; the override persists. If the
_reasons_ are wrong, that is a configuration conversation, not a drag.

**Triage the Backlog** periodically — nothing in it blocks an agent, which is what makes it a tab
rather than a rail. Watched, blocked at intake, unwatched, ignored. The unwatched count in the nav is
the one number that tells you whether opening it is worth it.

**Read Findings** when the count is non-zero. These are claims agents filed about things _outside_
their own task: a duplicate, a blocker they cannot touch, an unrelated bug. Nothing in the dispatcher
reads them — they queue nothing by design, because one agent's hunch spending another agent's slot is
a capability escalation, not a convenience. Three buttons: **promote** (work it now), **file** (defer
it into the tracker), **dismiss** (we looked at this).

## Where the fleet's throughput actually comes from

Two dials, and neither is the model.

**Concurrency.** `maxConcurrentAgents` is the cap, adjustable live from the top bar. More agents is
more parallel work and more asks arriving at you; the ceiling is not the machine, it is how fast you
answer the rail. If the rail is always full, lower the cap — parked agents holding slots are worse
than idle ones.

**How much you had to answer.** A goal that goes ticket → plan → parts → merge with two clicks from
you is the whole point. A goal that took nine escalations was a goal that was not stated. Over a
week, the escalations you get are a fairly precise readout of what your tickets are missing, and the
repeats table in **Yield** shows the expensive kind of repetition — a goal whose row shows one number
that quietly went round four times.

## Recurrence: work that should just happen

`New schedule` puts a prompt on a cron expression, read in the harness's own timezone. Monday
dependency sweeps, nightly reviews of the open PRs, a weekly report. A firing writes an ordinary
queued job — same cap, same pause flag, same queue as one you launched by hand — so a recurrence adds
a way for work to _arrive_ and no way for it to get around anything.

Missed windows fire **once**, not once per slot, and a schedule never has two of its own jobs in
flight. A laptop that was off for a week queues one job when it comes back.

## The two things that are deliberately not negotiable

Both exist to make this arrangement safe to leave running, and both are worth understanding before
you try to work around them:

- **Every act that reaches the outside world is authorized** — by you, or by an explicit auto-send
  decision you opted a specific action into (off by default). There is no arm where an agent posts,
  merges or files unasked.
- **An agent declares that it finished; nothing infers it.** Silence never reads as success. The
  failure this chooses is the cheap, visible one: work sitting still with a marker on it, rather than
  work quietly assumed complete.

## Habits that transfer, and habits that don't

**Transfer:**

- Reviewing a diff properly. You still do this — but on PRs an agent has already self-reviewed, so
  spend your attention on the design, not the typos.
- Knowing your codebase. Every judgement above is better for it.
- Writing a good issue. It is now the highest-leverage thing you do all day.

**Don't:**

- **Watching work happen.** Following one transcript to the end feels like productivity and is the
  most expensive way to spend an hour here. Open a drawer to steer or to diagnose, then close it.
- **Doing it yourself because it's faster.** Sometimes true, and fine — but do it as a ticket the
  harness knows about, or the run's record has a hole in it and the close-out sweep will ask you about
  work you already did.
- **Batching your rail.** Asks are cheap to answer and expensive to leave: each blocking one is an
  agent holding a slot. The rail is not email.
- **Treating a plan rejection as a failure.** It is the mechanism working. The cost of a replan is one
  agent; the cost of an accepted bad plan is every PR under it.

## Your first week

1. **Day one — watch it turn.** Run against the example config's mock agent, or point it at a real
   repo with a small watched label set. Use `Scan` to force a pulse and read the **Decision log**: what
   was decided, and which rule produced it. Nothing in the harness is unexplainable, including an idle
   cycle.
2. **Days two and three — one goal end to end.** Pick a real ticket you would have done yourself. Let
   it run. Answer everything. Compare the result against what you would have written, and note where
   the ticket, not the agent, was the limiting factor.
3. **Day four — turn the cap up.** Two or three agents. This is where operating starts feeling
   different from using: you will notice you are now reading rather than typing.
4. **Day five — tune what you saw.** The CI policy tab, so a check nobody here can fix _holds_ instead
   of sending an agent at a wall. The prompt book, if the house style of your reports or tickets is
   wrong. Watch labels, if the wrong things are being picked up.

## Where to read next

| For                                            | Read                                                       |
| ---------------------------------------------- | ---------------------------------------------------------- |
| The workflow in full, and where yours slots in | [workflow.md](workflow.md)                                 |
| Every surface in the cockpit                   | [17 — The cockpit](spec/17-cockpit.md)                     |
| What gets picked up, and why one didn't        | [06 — Issue pickup and labels](spec/06-issue-pickup.md)    |
| Plans, parts and approval                      | [08 — The planning funnel](spec/08-planning.md)            |
| Jobs, findings, schedules and human tasks      | [13 — Jobs, findings, human tasks](spec/13-jobs-and-findings.md) |
| Spend, yield and the fault log                 | [18 — Observability](spec/18-observability.md)             |
| Every config key and its default               | [02 — Configuration](spec/02-configuration.md)             |
