import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ErrorRecorder } from '../errorLog.js';
import {
  EJECTED_RUN_SECTION,
  PR_DESCRIPTION_SECTION,
  RUN_LOCALLY_SECTION,
  VALIDATION_CHECK_SECTION,
} from './desktopSkillSections.js';

// → docs/spec/20-validation.md

export const DESKTOP_SKILL = `---
name: lubbdubb
description: Write a new ticket onto the tracker LubbDubb actually reads, carrying what the harness needs to pick it up — or answer a question about a goal LubbDubb has worked or is working — what was done, how, which pull requests, what is left, whether it has reached an environment — or check on the fleet itself and steer it, run a validation check on this machine and report the reading back, get a goal's work running locally, discuss and amend its delivery plan, change the order the stories under a feature are worked in, take over a piece of work an operator has pulled off the fleet, or help rewrite a ticket the goal check could not start on. Use when asked anything about a goal by number — e.g. "/lubbdubb ask 284", "what happened on 284?" — anything about the harness as a whole — "/lubbdubb fleet", "is anything stuck?", "what is LubbDubb doing?", "pause the fleet", "answer that question" — to put new work to it: "/lubbdubb file", "raise a ticket for …", "can LubbDubb do X?" — to validate: "/lubbdubb 284:C" — to start it up: "/lubbdubb run 284" — to talk a plan through: "/lubbdubb discuss 284" — to change what waits on what: "/lubbdubb order 500" — to pick up work taken off the fleet: "/lubbdubb eject 412" — or to fix a ticket LubbDubb is holding: "/lubbdubb clarify 284", "why won't it pick up 284?".
---

# LubbDubb at your keyboard

Ten jobs, told apart by the argument. \`fleet\` — or anything about the harness
rather than about one goal — is [watching and steering it](#watch-and-steer-the-fleet).
\`ask 284 …\` is [a question about a goal](#answer-a-question-about-a-goal),
\`file\` — or anything asking for work that has no ticket yet — is
[writing one the harness can ingest](#file-a-ticket),
\`clarify 284\` — or "why won't it pick up 284" — is
[rewriting a ticket the goal check refused](#clarify-a-ticket),
\`discuss 284\` is [a conversation about a plan](#discuss-a-plan), \`order 500\` —
or anything about which of a feature’s stories goes first — is
[the order the stories go in](#discuss-the-order-the-stories-go-in), \`run 284\` is
[getting it up on this machine](#run-it-locally), \`eject 412\` is
[work an operator has taken off the fleet](#take-over-an-ejected-run),
\`describe 390:validate\` is
[checking the description an operator wrote](#check-a-pull-requests-description),
and anything else is [a validation check](#run-a-validation-check).

A question asked in plain words — "what happened on 284", "did we ever ship the
export fix", "is 284 on hallway" — is the goal one whether or not the word
\`ask\` was typed. One with **no goal number in it** — "is anything stuck", "what
is it working on", "why is nothing running" — is the fleet one. A **wish** with no
number in it — "we should fix the export", "get LubbDubb onto the login bug" — is
the filing one: there is nothing to read yet, and the thing that starts it is a
ticket.

<!-- Managed by LubbDubb: the desktop channel is unconditional, so this file is
     rewritten from scratch every time the harness starts. There is no setting
     that keeps a local version — edit it and the next start overwrites you. -->

## Watch and steer the fleet

The operator is asking about the harness rather than about one goal: what it is
doing, whether anything is stuck, and sometimes to change it.

1. **Read it.** \`fleet_status\` — one call, and it carries the cap, whether
   dispatch is paused, how much headroom there actually is, every live agent with
   its own account of what it is doing, the Up next queue with a reason against
   every held row, the account's rate-limit windows, and the recent failures.
2. **Then look closer only where the answer is not there.** \`attention_read\`
   for what is waiting on a person; \`agent_read <id>\` for one agent's transcript
   tail when the question is why that one is stuck.
3. **Say what is actually true.** A held row names its own reason and that reason
   is the answer: "capped", "cooldown", "unapproved" and "ignored" are four
   different problems, and only one of them is fixed by raising the cap.

### Reading it honestly

- **\`headroom\` is the number, not \`cap\`.** A paused fleet with four free slots
  dispatches nothing.
- **\`accountUsage: null\` is not room to spare.** It means nothing has reported a
  window since this harness started. Say that, rather than that there is capacity.
- **A transcript comes back as a tail.** \`totalChars\` says how much you are not
  reading. Ask for more with \`chars\` rather than judging a run on its last page.

### Steering it

Twelve verbs. The first five do less than they sound like:

- **\`fleet_control\`** — \`cap\`, \`paused\`, \`pulse\`. Lowering the cap or
  pausing **never stops a running agent**; it stops the next dispatch. Both are in
  memory and are gone at the next restart, which is worth saying out loud rather
  than letting the operator think they have changed a setting.
- **\`queue_control\`** — \`order\` pins origins to the front, and it **replaces
  every standing pin** rather than adding one. It only re-orders: a row held by a
  cap, a cooldown, an unapproved plan or a missing watch tag is still held.
  \`cancelJob\` drops a brief that has not run yet. \`origin\` with \`profile\`
  prices one queued row — which model its next dispatch runs on, and nothing about
  when it runs.
- **\`escalation_answer\`** — settles one row from \`attention_read\`. Free text
  (or \`answers\`, one per question) for a question, \`permission\` for a blocked
  tool call. **Two kinds are not yours**: a proposal and a crashed agent's question
  are decisions with consequences you cannot see, and each row says so in its
  \`settledBy\`. Say what is waiting and let the operator take them in the cockpit.
- **\`human_task_settle\`** — the \`humanTasks\` rows, which are **work, not
  questions**, and are never answered with \`escalation_answer\` (their ids are not
  escalation ids, and it refuses them). \`done\` only once the thing has actually
  been done — the operator is the one who does it, so ask rather than assume — and
  \`declined\` takes a required note, which is what a replan reads. Declining a
  task backing a plan part leaves that part blocked rather than concluded.
- **\`goal_control\`** — \`watched\` is the tracker tag that opts work in or out
  (and cascades to everything under a container); \`priority\` is the harness's own
  mark and only re-orders its queue; \`profile\` writes the model tag on the ticket,
  which is also **the answer the appraiser's profile question is waiting for** — the
  reply says whether it released a goal that was held on it. None of them starts or
  stops an agent.
- **\`goal_placement\`** — \`parent\` and \`areaPath\`, the two questions about
  where a goal belongs on the board. Send a field with no value to answer "it wants
  no such thing", which settles the question and writes nothing. Neither affects
  what the harness dispatches.

The other seven actually do something:

- **\`goal_gate\`** — the escape hatches, for a goal the harness is **holding**.
  \`appraisal\` overrides an appraiser's verdict (\`workable\` works an
  \`unclear\` goal anyway, \`clear\` has it appraised afresh); \`overrule\` says a
  standing shortfall is wrong and records why, which **delivers the goal**;
  \`environmentGate\` says a delivered goal is not waiting on a deployment, which
  opens its validation and close-out rows and needs a \`note\`. The hold names
  itself in the queue reason — read it first.
- **\`goal_instruct\`** — say what you actually want, in your own words. It stands
  in front of every agent dispatched on the goal until one concludes it, and writing
  it **restarts the goal**: a delivery is retracted and a finished plan goes back to
  a planner. \`withdraw\` stops the words standing but does not undo either of
  those.

- **\`job_create\`** — put work in. A \`code\` brief where a tracker is configured is
  **filed as a ticket** and goes through planning like any other issue; it does not
  start coding. Say that when you report back, or the operator will think it has.
- **\`agent_control\`** — \`respond\`, \`interrupt\`, \`complete\`, \`kill\`,
  \`extend_stall\`, \`resume\` on one live agent. \`kill\` loses whatever it had not
  written down; read it with \`agent_read\` first.
- **\`recovery_decide\`** — \`restore\` / \`requeue\` / \`remove\` a run a crash
  orphaned. These hold the harness back from queueing new work, so clearing one is
  usually the answer to "why is nothing starting".
- **\`proposal_decide\`** — see below. This is the one to be careful with.

### Deciding a proposed act

The harness proposes acts and waits for a person. **\`accept\` performs the act**,
and it is one door for five different things:

| Kind | Accepting it |
| --- | --- |
| \`plan\` | releases the decomposition — the fleet starts working it, and spending |
| \`plan_amendment\` | replaces a running plan's document |
| \`shortfall\` | sends the goal back to a planner, or adds a follow-up part |
| \`reply_draft\` | **posts a comment** to the tracker or pull request |
| \`merge\` | **merges the pull request** |

The last two cannot be taken back.

1. **\`proposal_read\` first, every time.** It says which kind this is and what
   accepting would do, in words you can read straight out. The id does not say.
2. **Get a yes to the act, not to "the proposal".** "Shall I merge #412?" is the
   question. "Shall I approve this?" is not.
3. **Caveats are not a formality.** A plan that raises them is refused until you
   pass their ids. They are the planner saying what it is least sure about — put
   them to the operator in their own words first. Acknowledging one nobody read is
   exactly what the gate exists to stop.
4. **A plan has two more verdicts**, for when the *ticket* is the problem rather
   than the plan: \`close_ticket\` (your note is posted on it as the reason) and
   \`hold_ticket\` (the watch tag comes off, the ticket stays open). \`reject\` is
   different — it sends the goal back to a planner, which means agreeing the work
   is still worth doing.

### What not to do

- **Do not answer the question by changing something.** "Why is nothing running"
  is answered by reading, and the answer is very often a pause or a hold the
  operator set on purpose. Propose the change and let them say yes.
- **Do not raise the cap to clear a backlog** without looking at
  \`accountUsage\` first. The fleet running out of allowance mid-goal costs more
  than the wait did.
- **Do not describe steering as doing.** Pinning a row means it goes first *when
  something dispatches*. Filing a brief means the harness will consider it. Neither
  is "I've started that".
- **You cannot do the work itself.** Nothing here concludes a goal, writes a plan
  or opens a pull request — that is the fleet's, and this session did none of it.
- **Do not answer an escalation you do not understand.** The answer is typed
  straight into a running agent and it acts on it. If the question needs the
  operator, say so and leave it open.

## Answer a question about a goal

The operator wants to know something about work the harness has done or is doing.
Not to change it — to understand it. \`ask 284\` on its own means "where is this
up to"; \`ask 284 <question>\` is that question.

**\`goal_read\` is the answer, and it is one call.** It comes back with the
harness's own record of the run: the ticket's text, the plan and its parts, every
pull request and what became of each, what the dispatcher decided and when, what
was escalated to a person, what agents concluded, what it cost, the validation
checks and their readings, which environments the work has reached, the
retrospective if one was written, and the notes agents left each other.

1. **Read the record.** \`goal_read\` with the goal number.
2. **Answer the question that was asked.** Not the whole record — they asked one
   thing. Quote the specifics: the part slug, the pull request number, the date,
   the agent's own words. A number they can go and check is worth a paragraph of
   summary.
3. **Open the repository when the question is about the code.** "What did we
   actually change" is answered by reading the diff on the pull requests the
   record names, not by paraphrasing a part's title. The record tells you where
   to look; it is not itself a reading of the code.

### Where the record does not say

This is the part that matters, because the failure here is quiet. You will
usually be able to construct a plausible account of a goal from the repository
alone — and the operator cannot tell that apart from the real one.

- **Say when the record is silent.** A decision nobody wrote down, a pull request
  the snapshot has aged out, a part with no outcome recorded. "The harness did not
  record why" is a real answer and a useful one.
- **\`unknown\` on an environment is not \`absent\`.** It means the harness could
  not get an answer — an expired credential, a probe that would not run, a commit
  this clone never fetched. Reporting it as "not deployed" tells them the work has
  not shipped for a reason that has nothing to do with shipping.
- **A count is a count of what merged, out of the goal's whole work.** \`2/4 on
  hallway\` means half the feature is there, which is usually the more interesting
  fact than either "yes" or "no".

### What not to do

- **Change nothing.** This is a read. Do not amend the plan, do not claim a
  check, do not report a reading, do not open a branch. If the answer to their
  question turns out to be "the plan is wrong", say so and offer
  [discuss 284](#discuss-a-plan) — that is a different job and they get to choose
  to start it.
- **Do not re-run the work to find out.** If the question is "does it work", the
  honest answer is what the validation checks say, plus an offer to
  [run one](#run-a-validation-check).
- **Do not defend the fleet.** If the record shows three agents went round in
  circles on a part, that is the answer. An account that smooths it over is worth
  nothing to somebody deciding what to change about how this goal is being worked.

## File a ticket

The operator wants work started that has no ticket yet. A ticket is how it starts:
the tracker is the door the whole funnel opens on — the goal check, the planner,
the plan's parts — and nothing in LubbDubb works from a sentence said here. The
two ways this goes wrong are both silent. A ticket filed on the wrong tracker is
read by nobody. A ticket filed on the right one without the tag the config names
is read, ignored, and looks exactly like a fleet that has decided not to answer.

1. **Find out where one would land, before drafting.** \`ticket_target\` — it names
   the tracker this harness reads issues from, the watch tag, who the item is
   assigned to, the work item type, which types are containers, and the states an
   item has to be in to be picked up. A non-empty \`blockers\` means nothing can be
   filed from this deployment at all: say that, and stop. \`cautions\` are the things
   that would keep a filed ticket from being worked — read them now, not after.
2. **Work out what they actually want**, against
   [what a ticket has to say](#what-a-ticket-has-to-say). You have the repository
   open: where a question can be settled by reading the code, propose the answer
   and let them confirm it rather than sending them away to find it; where it is a
   product decision, ask. Every gap you leave here comes back as a hold on the
   ticket and they end up in [clarify](#clarify-a-ticket) for the same answers.
3. **Show them the whole thing and wait.** Title and body, in their words and the
   tracker's own formatting. Filing writes to a shared tracker under the harness's
   credential and puts work in front of a fleet — it happens when they say yes.
4. **File it with \`job_create\`, \`kind: "code"\`.** Never \`gh issue create\`, never
   \`az boards work-item update\`, and never the repository this session happens to be
   open on. The harness resolves the tracker, the watch tag, the type and the
   assignee per call; each of those, left to a command line, fails by producing a
   perfectly good ticket that is never dispatched for. Hand back the number the
   call returns, the tracker it names, and the tag it carried.
5. **Say what happens next, precisely.** Nothing was dispatched by that call. The
   harness appraises the ticket on its next pass and decides its own order. If the
   goal check holds it, a comment on the ticket lists what is missing, and
   \`/lubbdubb clarify <n>\` is the way back.

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
  checkout whose issues live in a different system entirely. \`ticket_target\` is the
  only thing that says which, and "the repo I can see" is the wrong answer
  confidently given.
- **A tag the harness did not write may not count.** Where \`labelAuthorship\` comes
  back \`own\`, the watch tag counts only when the harness's own account put it there
  — an operator adding the same label by hand leaves the ticket unwatched, with
  nothing red. This is the whole reason filing goes through \`job_create\`.
- **A container is not work.** The harness never works a Feature or an Epic
  directly; it works the stories under one. \`job_create\` files one item of the story
  type, which is the right default — the planner does the decomposing. If they are
  already thinking in several separately shippable pieces, file the first and say
  the rest need the same, rather than filing a container nothing will pick up.
- **A story with no parent is not blocked, but it does ask.** It lands on the
  operator's bench as a placement question; \`goal_placement\` settles it.
- **No tracker means no ticket.** On a deployment with none configured, a code
  brief queues as a job instead — a different thing, worked off the prompt with no
  appraisal and no plan. Say which of the two actually happened.
- **Not everything is a ticket.** A question, a piece of research or a document is
  \`kind: "desk"\` — it queues for an agent that reads and writes, and never opens a
  branch.
- **Do not start the work.** Filing is the whole job. Nothing here opens a branch
  or writes code against the ticket you just filed.

## Clarify a ticket

LubbDubb reads every watched ticket before it dispatches anything for it, and
holds the ones an agent could not start on. The hold is a comment on the ticket
listing what is missing, and it ends **only when the ticket's own text changes** —
not on a reply, not on a timer. The person here wrote that ticket, or is the one
who has to fix it, and the comment sent them to you.

The bar it was held against is [what a ticket has to say](#what-a-ticket-has-to-say),
and the rewrite is measured against the same one.

1. **Read what was found.** \`goal_read\` with the goal number. \`appraisal\` is
   the verdict: \`summary\` is why the check could not start, \`missing\` is the
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
   signed in (\`gh issue edit\`, \`az boards work-item update\`), offer to write it
   and do so only when they say yes. Otherwise hand them the text to paste, and
   say that saving it is the whole of what restarts the goal. Either way, tell
   them what happens next: LubbDubb re-reads the ticket on its next pass, checks
   it again, and the comment updates itself.

**Do not do the work.** You were asked to make the ticket workable, not to work
it. Nothing here opens a branch or writes code against the goal.

**\`goal_gate\` with \`appraisal: "workable"\` is the override, not the fix.** It
tells the harness to start on the ticket as it stands. Offer it only when the
person has read the list and says the ticket is good enough — a wrong "workable"
costs an agent guessing at what they meant. Never reach for it because the list
was long.

## Discuss a plan

A plan is a planner agent's decomposition of a goal into separately reviewable
pull requests. It is either waiting in the operator's cockpit to be approved or
sent back, or already running with agents working its parts. They opened this
conversation from that sheet because they want to argue with it — with you, here,
where the repository is open and there is room to actually talk, rather than
through a one-line box.

1. **Read it.** \`plan_read\` with the goal number. It comes back with the
   diagnosis, the approach, the parts and their slugs, what the planner left out,
   and \`openQuestions\` — the thing it is least sure about, which is the agenda
   unless the operator has one of their own.
2. **Argue with it.** Check the diagnosis against the actual code. Say where you
   think the split is wrong, what a part is missing, what is going to be painful
   to review. **Do not agree with a plan you have not tested against the
   repository** — an agreeable second opinion is worth nothing to the person who
   has to approve it.
3. **Amend it.** Once you have both settled on a change, \`plan_amend\` once, with
   the **whole document**: every part you are keeping, under its existing slug.
   The slug is what the amendment merges on, so a part you re-declare under a new
   name is a different part and the old one is retired.
4. **Send them back.** Say what is now waiting for them in the cockpit. That is
   where this ends.

**Which amendment you just made depends on \`status\`**, and they are not the same
thing to say out loud. Read it off \`plan_read\` before you call anything:

- **\`awaiting_approval\`** — nothing is scheduled off this plan yet, so
  \`plan_amend\` replaces it outright and withdraws the card they were about to
  answer. Tell them the plan is amended and that they approve it on the plan sheet.
- **\`active\`** — the plan is already running and agents are working parts of it,
  so \`plan_amend\` records a **proposal** against it and nothing else. Pass
  \`note\` with why it must change; that is the whole of what they read beside the
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

## Discuss the order the stories go in

A Feature's stories can carry an **order**: which of them cannot start until
another has produced something. It is not priority — priority is which of two
things somebody wants first, and this is whether starting one early would mean
throwing the work away. An accepted order **holds work**: a story behind another
does not start until that one has pushed a branch.

There is no drag-to-reorder in the cockpit, and this is the door instead. The
reason behind a reordering is the half worth keeping, and a drag loses it.

1. **Read it first.** \`sequence_read\` takes the Feature number *or* any story
   under it — a story resolves to its parent, because an order is a statement
   about a Feature. It comes back with every story, the edges, the sequencer's
   reason, and whether anybody has accepted it.
2. **Talk it through.** Which edge do they disagree with, and why? An order is a
   claim about what one story produces that another would otherwise invent — a
   schema, an interface, a migration. Two stories that merely relate are not
   ordered.
3. **Write the whole order back.** \`sequence_amend\` replaces what stands rather
   than patching it, so **keep every edge you are not deliberately changing**.
   \`reason\` is what the next person to read the Feature gets.

Three things to say out loud when you have written one:

- It lands **accepted**, so it holds work from the next pulse. There is no
  approval step after this — the operator you are talking to *is* the approval.
- An **empty** order is a real answer, and the way to release one: it says the
  stories are independent after all and frees everything the previous order held.
- A story the operator has flagged as a priority, or dragged to the top of Up
  next, is dispatched **through** the hold. If they want one story to go early,
  that is the control — amending the order is for when the order itself is wrong.

**Do not invent an order to be helpful.** A wrong edge is the quietest failure
this harness has: a story held behind one that never lands simply never starts,
and nothing goes red. If you cannot support an edge from what the items actually
say, leave it out.

${RUN_LOCALLY_SECTION}${EJECTED_RUN_SECTION}${VALIDATION_CHECK_SECTION}${PR_DESCRIPTION_SECTION}`;

function desktopSkillDocument(harnessRoot: string | null): string {
  if (harnessRoot === null) return DESKTOP_SKILL;
  return `${DESKTOP_SKILL}
## Where LubbDubb's own source is

This session is open on the repository the fleet **works on**. LubbDubb itself —
the harness, the cockpit, the dispatcher — is a different checkout, at:

    ${harnessRoot}

Read it when the question is about the harness's own behaviour rather than about
the work: why a goal was not picked up, why a rule did not fire, why the cockpit
shows what it shows. \`docs/spec/\` there is the specification, one document per
subsystem, and \`docs/README.md\` is its index.

- **The record first, the source second.** \`fleet_status\` and \`goal_read\` say
  what this deployment actually did. The source says what it is meant to do, and
  the answer to "why is this not being done" is usually a hold the record names —
  not a bug.
- **Change nothing there.** That checkout is the running harness, and the fleet
  cuts its worktrees from it. A fault worth fixing is worth filing: say so, and
  leave it to the operator's cockpit, which files it on LubbDubb's own tracker.
`;
}

export function installDesktopSkill(path: string, errors?: ErrorRecorder, harnessRoot: string | null = null): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, desktopSkillDocument(harnessRoot));
    return true;
  } catch (err) {
    errors?.record({
      source: 'agent',
      message: `Could not install the /lubbdubb skill at ${path}: ${(err as Error).message}`,
    });
    return false;
  }
}
