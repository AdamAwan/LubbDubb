---
name: clarify
description: Help rewrite a ticket the LubbDubb goal check could not start on, so the harness picks it up. Use for "/lubbdubb:clarify 284", "why won't it pick up 284?".
argument-hint: '<goal>'
---

## Clarify a ticket

LubbDubb reads every watched ticket before it dispatches anything for it, and
holds the ones an agent could not start on. The hold is a comment on the ticket
listing what is missing, and it ends **only when the ticket's own text changes** —
not on a reply, not on a timer. The person here wrote that ticket, or is the one
who has to fix it, and the comment sent them to you.

The bar it was held against is [what a ticket has to say](#what-a-ticket-has-to-say) (below),
and the rewrite is measured against the same one.

1. **Read what was found.** `goal_read` with the goal number. `appraisal` is
   the verdict: `summary` is why the check could not start, `missing` is the
   list of questions it left, and the scratchpad has the appraiser's note on
   where in the repository it went looking. Read the ticket's own text there too.
2. **Work through the list with them, one question at a time.** You have the
   repository open — use it. Where a question can be answered by reading the
   code, propose the answer and let them confirm rather than making them find
   it; where it is a product decision, ask and wait. Do not skip an item because
   it seems obvious to you: it was not obvious to the agent that refused it, and
   the next agent gets only the ticket.
3. **Draft the rewrite.** The whole ticket — title and body — with every answer
   folded into the description where it belongs, in the author's own words and
   the tracker's own formatting. Not a comment, not an addendum: the hold ends on
   the description changing, and the next agent reads the description.
4. **Get it onto the ticket.** If a CLI for the tracker is on this machine and
   signed in (`gh issue edit`, `az boards work-item update`), offer to write it
   and do so only when they say yes. Otherwise hand them the text to paste, and
   say that saving it is the whole of what restarts the goal. Either way, tell
   them what happens next: LubbDubb re-reads the ticket on its next pass, checks
   it again, and the comment updates itself.

**Do not do the work.** You were asked to make the ticket workable, not to work
it. Nothing here opens a branch or writes code against the goal.

**`goal_gate` with `appraisal: "workable"` is the override, not the fix.** It
tells the harness to start on the ticket as it stands. Offer it only when the
person has read the list and says the ticket is good enough — a wrong "workable"
costs an agent guessing at what they meant. Never reach for it because the list
was long.

### What a ticket has to say

Always: **the problem** (who has it, why it matters), **what success looks like**
(observable — someone could tell done from not done), and **its words defined**
where they could mean two things. And where the change implies it: a **design or
mockup** for anything with a UI, or an exact description of layout, states and
behaviour; an **example of the data** for anything with data going in or out — a
real-looking sample, not a type name; and **links to the specs or docs** it relates
to. Implementation hints and an out-of-scope list help and are never required.

This is the bar the goal check reads every watched ticket against before anything
is dispatched for it. It is not house style: a ticket under the bar is held, and
the next agent gets the ticket rather than this conversation.
