---
name: fleet
description: Check on the LubbDubb fleet itself and steer it — what it is doing, whether anything is stuck, why nothing is running, pausing it, changing the cap, re-ordering the queue, answering an agent's question, deciding a proposal. Use for anything about the harness as a whole rather than one goal — "/lubbdubb:fleet", "is anything stuck?", "what is LubbDubb doing?", "pause the fleet", "answer that question".
---

## Watch and steer the fleet

The operator is asking about the harness rather than about one goal: what it is
doing, whether anything is stuck, and sometimes to change it.

1. **Read it.** `fleet_status` — one call, and it carries the cap, whether
   dispatch is paused, how much headroom there actually is, every live agent with
   its own account of what it is doing, the Up next queue with a reason against
   every held row, the account's rate-limit windows, and the recent failures.
2. **Then look closer only where the answer is not there.** `attention_read`
   for what is waiting on a person; `agent_read <id>` for one agent's transcript
   tail when the question is why that one is stuck.
3. **Say what is actually true.** A held row names its own reason and that reason
   is the answer: "capped", "cooldown", "unapproved" and "ignored" are four
   different problems, and only one of them is fixed by raising the cap.

### Reading it honestly

- **`headroom` is the number, not `cap`.** A paused fleet with four free slots
  dispatches nothing.
- **`accountUsage: null` is not room to spare.** It means nothing has reported a
  window since this harness started. Say that, rather than that there is capacity.
- **A transcript comes back as a tail.** `totalChars` says how much you are not
  reading. Ask for more with `chars` rather than judging a run on its last page.

### Steering it

Twelve verbs. The first five do less than they sound like:

- **`fleet_control`** — `cap`, `paused`, `pulse`. Lowering the cap or
  pausing **never stops a running agent**; it stops the next dispatch. Both are in
  memory and are gone at the next restart, which is worth saying out loud rather
  than letting the operator think they have changed a setting.
- **`queue_control`** — `order` pins origins to the front, and it **replaces
  every standing pin** rather than adding one. It only re-orders: a row held by a
  cap, a cooldown, an unapproved plan or a missing watch tag is still held.
  `cancelJob` drops a brief that has not run yet. `origin` with `profile`
  prices one queued row — which model its next dispatch runs on, and nothing about
  when it runs.
- **`escalation_answer`** — settles one row from `attention_read`. Free text
  (or `answers`, one per question) for a question, `permission` for a blocked
  tool call. **Two kinds are not yours**: a proposal and a crashed agent's question
  are decisions with consequences you cannot see, and each row says so in its
  `settledBy`. Say what is waiting and let the operator take them in the cockpit.
- **`human_task_settle`** — the `humanTasks` rows, which are **work, not
  questions**, and are never answered with `escalation_answer` (their ids are not
  escalation ids, and it refuses them). `done` only once the thing has actually
  been done — the operator is the one who does it, so ask rather than assume — and
  `declined` takes a required note, which is what a replan reads. Declining a
  task backing a plan part leaves that part blocked rather than concluded.
- **`goal_control`** — `watched` is the tracker tag that opts work in or out
  (and cascades to everything under a container); `priority` is the harness's own
  mark and only re-orders its queue; `profile` writes the model tag on the ticket,
  which is also **the answer the appraiser's profile question is waiting for** — the
  reply says whether it released a goal that was held on it. None of them starts or
  stops an agent.
- **`goal_placement`** — `parent` and `areaPath`, the two questions about
  where a goal belongs on the board. Send a field with no value to answer "it wants
  no such thing", which settles the question and writes nothing. Neither affects
  what the harness dispatches.

The other seven actually do something:

- **`goal_gate`** — the escape hatches, for a goal the harness is **holding**.
  `appraisal` overrides an appraiser's verdict (`workable` works an
  `unclear` goal anyway, `clear` has it appraised afresh); `overrule` says a
  standing shortfall is wrong and records why, which **delivers the goal**;
  `environmentGate` says a delivered goal is not waiting on a deployment, which
  opens its validation and close-out rows and needs a `note`. The hold names
  itself in the queue reason — read it first.
- **`goal_instruct`** — say what you actually want, in your own words. It stands
  in front of every agent dispatched on the goal until one concludes it, and writing
  it **restarts the goal**: a delivery is retracted and a finished plan goes back to
  a planner. `withdraw` stops the words standing but does not undo either of
  those.

- **`job_create`** — put work in. A `code` brief where a tracker is configured is
  **filed as a ticket** and goes through planning like any other issue; it does not
  start coding. Say that when you report back, or the operator will think it has.
- **`agent_control`** — `respond`, `interrupt`, `complete`, `kill`,
  `extend_stall`, `resume` on one live agent. `kill` loses whatever it had not
  written down; read it with `agent_read` first.
- **`recovery_decide`** — `restore` / `requeue` / `remove` a run a crash
  orphaned. These hold the harness back from queueing new work, so clearing one is
  usually the answer to "why is nothing starting".
- **`proposal_decide`** — see below. This is the one to be careful with.

### Deciding a proposed act

The harness proposes acts and waits for a person. **`accept` performs the act**,
and it is one door for five different things:

| Kind             | Accepting it                                                           |
| ---------------- | ---------------------------------------------------------------------- |
| `plan`           | releases the decomposition — the fleet starts working it, and spending |
| `plan_amendment` | replaces a running plan's document                                     |
| `shortfall`      | sends the goal back to a planner, or adds a follow-up part             |
| `reply_draft`    | **posts a comment** to the tracker or pull request                     |
| `merge`          | **merges the pull request**                                            |

The last two cannot be taken back.

1. **`proposal_read` first, every time.** It says which kind this is and what
   accepting would do, in words you can read straight out. The id does not say.
2. **Get a yes to the act, not to "the proposal".** "Shall I merge #412?" is the
   question. "Shall I approve this?" is not.
3. **Caveats are not a formality.** A plan that raises them is refused until you
   pass their ids. They are the planner saying what it is least sure about — put
   them to the operator in their own words first. Acknowledging one nobody read is
   exactly what the gate exists to stop.
4. **A plan has two more verdicts**, for when the _ticket_ is the problem rather
   than the plan: `close_ticket` (your note is posted on it as the reason) and
   `hold_ticket` (the watch tag comes off, the ticket stays open). `reject` is
   different — it sends the goal back to a planner, which means agreeing the work
   is still worth doing.

### What not to do

- **Do not answer the question by changing something.** "Why is nothing running"
  is answered by reading, and the answer is very often a pause or a hold the
  operator set on purpose. Propose the change and let them say yes.
- **Do not raise the cap to clear a backlog** without looking at
  `accountUsage` first. The fleet running out of allowance mid-goal costs more
  than the wait did.
- **Do not describe steering as doing.** Pinning a row means it goes first _when
  something dispatches_. Filing a brief means the harness will consider it. Neither
  is "I've started that".
- **You cannot do the work itself.** Nothing here concludes a goal, writes a plan
  or opens a pull request — that is the fleet's, and this session did none of it.
- **Do not answer an escalation you do not understand.** The answer is typed
  straight into a running agent and it acts on it. If the question needs the
  operator, say so and leave it open.
