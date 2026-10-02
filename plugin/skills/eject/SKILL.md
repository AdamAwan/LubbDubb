---
name: eject
description: Take over a piece of work an operator has pulled off the LubbDubb fleet (an ejected run), in its own worktree. Use for "/lubbdubb:eject 412".
argument-hint: '<goal>'
---

## Take over an ejected run

An operator was watching an agent, decided it was going the wrong way, and
**ejected** it: the agent was stopped, and its goal and its worktree are held for
them rather than handed straight back to the fleet. This session is open in that
worktree, on that branch, with the agent's uncommitted work in front of you. The
hold expires — it is not indefinite — and until it is settled nothing else in the
harness will touch this goal or this directory.

1. **Read it first.** `ejection_read` with the goal number. It comes back with
   the operator's own reason for stopping it, the brief the agent was given, its
   last reported progress, the tail of its transcript, and how long the hold has
   left. The reason is the brief: they stopped it for something specific, and
   guessing at what is the one way to repeat it.
2. **Say what you found, then wait.** Tell them what the agent had actually done
   — read the diff on the branch, not just the transcript — and where you think it
   went wrong against their reason. Then **follow their lead**. You were not
   dispatched; a session that reads the brief and carries on delivering has
   reproduced the thing they ejected.
3. **Say what you are doing, as you go.** `ejection_note` with one line, after a
   commit or on a change of direction. It draws on the held slot in the fleet view,
   which is how everybody else tells a hold somebody is working from one somebody
   forgot.
4. **Give it back.** `ejection_settle`, once you are both done. This is the part
   that actually matters and the part that gets forgotten.

### The three ways back

Ask which one it is. The answer is the operator's:

|               | They are saying                     | What it does                                                                                                                 |
| ------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `handed_back` | "never mind, the agent was right"   | Releases the hold and writes nothing else. The rule proposes the work again next pulse, reading the branch as it now stands. |
| `requeued`    | "I fixed the direction, you finish" | Queues a job carrying your `note` — required, and it is the preamble the fresh agent reads.                                  |
| `delivered`   | "it's a pull request now"           | Releases the hold; the pull-request rules take the next decision.                                                            |

### What not to do

- **Do not settle it on your own judgement.** Which of the three it is is a
  decision about the work, and the operator is the one holding it.
- **Do not leave it held.** A hold nobody settles keeps the goal shut until it
  expires, and an expiry is the harness taking the work back from underneath
  somebody — into a branch whose state nobody described. If the conversation is
  ending, ask which arm before it does.
- **Do not switch this checkout to another branch.** It is a worktree the harness
  is holding out of its own pool. Leaving it on something else is how the operator
  comes back to a directory that is not what they ejected.
- **`claude --resume` is the other door**, not a replacement for this one. It
  reopens the ejected agent's own conversation, and `ejection_read` gives you the
  command where the runtime kept one. Either way the hold is still the hold, and
  it still has to be settled.
