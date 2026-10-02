---
name: file
description: Write a new ticket onto the tracker LubbDubb actually reads, carrying what the harness needs to pick it up. Use to put new work to LubbDubb — "/lubbdubb:file", "raise a ticket for …", "can LubbDubb do X?", "get LubbDubb onto the login bug".
argument-hint: '[what you want]'
---

## File a ticket

The operator wants work started that has no ticket yet. A ticket is how it starts:
the tracker is the door the whole funnel opens on — the goal check, the planner,
the plan's parts — and nothing in LubbDubb works from a sentence said here. The
two ways this goes wrong are both silent. A ticket filed on the wrong tracker is
read by nobody. A ticket filed on the right one without the tag the config names
is read, ignored, and looks exactly like a fleet that has decided not to answer.

1. **Find out where one would land, before drafting.** `ticket_target` — it names
   the tracker this harness reads issues from, the watch tag, who the item is
   assigned to, the work item type it defaults to and the others it knows
   (`filingTypes`), which types are containers, and the states an
   item has to be in to be picked up. A non-empty `blockers` means nothing can be
   filed from this deployment at all: say that, and stop. `cautions` are the things
   that would keep a filed ticket from being worked — read them now, not after.
2. **Work out what they actually want**, against
   [what a ticket has to say](#what-a-ticket-has-to-say). You have the repository
   open: where a question can be settled by reading the code, propose the answer
   and let them confirm it rather than sending them away to find it; where it is a
   product decision, ask. Every gap you leave here comes back as a hold on the
   ticket and they end up in `/lubbdubb:clarify` for the same answers.
3. **Show them the whole thing and wait.** Title, type and body, in their words and the
   tracker's own formatting. Filing writes to a shared tracker under the harness's
   credential and puts work in front of a fleet — it happens when they say yes.
4. **File it with `job_create`, `kind: "code"`.** Never `gh issue create`, never
   `az boards work-item update`, and never the repository this session happens to be
   open on. The harness resolves the tracker, the watch tag, the type and the
   assignee per call; each of those, left to a command line, fails by producing a
   perfectly good ticket that is never dispatched for. On Azure DevOps, pass
   `type` when it is not a story — a bug, a feature, tech debt, whatever the
   project calls it, spelled exactly as the project spells it; left off, it is filed
   as `storyType`. Hand back the number the
   call returns, the tracker it names, and the tag it carried.
5. **Say what happens next, precisely.** Nothing was dispatched by that call. The
   harness appraises the ticket on its next pass and decides its own order. If the
   goal check holds it, a comment on the ticket lists what is missing, and
   `/lubbdubb:clarify <n>` is the way back.

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

### Where this goes wrong

- **The repository open here is not necessarily the tracker.** A fleet can work a
  checkout whose issues live in a different system entirely. `ticket_target` is the
  only thing that says which, and "the repo I can see" is the wrong answer
  confidently given.
- **A tag the harness did not write may not count.** Where `labelAuthorship` comes
  back `own`, the watch tag counts only when the harness's own account put it there
  — an operator adding the same label by hand leaves the ticket unwatched, with
  nothing red. This is the whole reason filing goes through `job_create`.
- **A container is not work.** The harness never works a Feature or an Epic
  directly; it works the stories under one. `job_create` files one item of the story
  type, which is the right default — the planner does the decomposing. If they are
  already thinking in several separately shippable pieces, file the first and say
  the rest need the same, rather than filing a container nothing will pick up.
- **A story with no parent is not blocked, but it does ask.** It lands on the
  operator's bench as a placement question; `goal_placement` settles it.
- **No tracker means no ticket.** On a deployment with none configured, a code
  brief queues as a job instead — a different thing, worked off the prompt with no
  appraisal and no plan. Say which of the two actually happened.
- **Not everything is a ticket.** A question, a piece of research or a document is
  `kind: "desk"` — it queues for an agent that reads and writes, and never opens a
  branch.
- **Do not start the work.** Filing is the whole job. Nothing here opens a branch
  or writes code against the ticket you just filed.
