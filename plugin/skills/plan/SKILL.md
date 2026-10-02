---
name: plan
description: Discuss and amend the delivery plan LubbDubb wrote for a goal. Use for "/lubbdubb:plan 284", "talk me through the plan for 284", "change the plan for 284".
argument-hint: '<goal>'
---

## Discuss a plan

A plan is a planner agent's decomposition of a goal into separately reviewable
pull requests. It is either waiting in the operator's cockpit to be approved or
sent back, or already running with agents working its parts. They opened this
conversation from that sheet because they want to argue with it — with you, here,
where the repository is open and there is room to actually talk, rather than
through a one-line box.

1. **Read it.** `plan_read` with the goal number. It comes back with the
   diagnosis, the approach, the parts and their slugs, what the planner left out,
   and `openQuestions` — the thing it is least sure about, which is the agenda
   unless the operator has one of their own.
2. **Argue with it.** Check the diagnosis against the actual code. Say where you
   think the split is wrong, what a part is missing, what is going to be painful
   to review. **Do not agree with a plan you have not tested against the
   repository** — an agreeable second opinion is worth nothing to the person who
   has to approve it.
3. **Amend it.** Once you have both settled on a change, `plan_amend` once, with
   the **whole document**: every part you are keeping, under its existing slug.
   The slug is what the amendment merges on, so a part you re-declare under a new
   name is a different part and the old one is retired.
4. **Send them back.** Say what is now waiting for them in the cockpit. That is
   where this ends.

**Which amendment you just made depends on `status`**, and they are not the same
thing to say out loud. Read it off `plan_read` before you call anything:

- **`awaiting_approval`** — nothing is scheduled off this plan yet, so
  `plan_amend` replaces it outright and withdraws the card they were about to
  answer. Tell them the plan is amended and that they approve it on the plan sheet.
- **`active`** — the plan is already running and agents are working parts of it,
  so `plan_amend` records a **proposal** against it and nothing else. Pass
  `note` with why it must change; that is the whole of what they read beside the
  diff. Then tell them it is waiting for them — and say plainly that **the plan has
  not changed**: nothing was paused, nothing was stopped, every part that was
  scheduling still is, and it stays that way until they accept. There can be only
  one pending at a time, so a further change is folded into that one afterwards
  rather than proposed beside it.

**Do not do the work.** You were asked about the shape of the plan, not to
deliver it. Nothing here writes code, opens a branch or a pull request, and a
session that starts implementing has answered a question nobody asked.

If they decide the plan was right after all, amend nothing — say so and stop. A
plan left alone is still approvable exactly as it was.
