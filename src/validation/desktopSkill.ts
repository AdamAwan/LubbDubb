import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ErrorRecorder } from '../errorLog.js';

/**
 * The `/lubbdubb` skill, installed into the operator's Claude Code when the
 * desktop channel starts.
 *
 * **The skill is the interface, not a convenience.** Without it the operator
 * types the same six sentences at their Claude every time they want a check run —
 * which is the friction the whole channel exists to remove, and the reason the
 * bench-and-priority design was rejected: *"realistically I'm going to look at
 * the goal, see it needs something validating, then want my Claude to do it."*
 * With it, that is `/lubbdubb 284:C`.
 *
 * Kept as a string here rather than as a file asset for the prompt templates'
 * reason: the build emits `.ts` and nothing copies a stray `.md` into `dist`, so
 * an asset would work in development and be missing in a deployment — the exact
 * shape of silent failure this repo's conventions exist to avoid. There is no
 * second copy under `docs/` either: one of the two would be the stale one.
 *
 * It is deliberately short. Everything about *how* to run a check comes back from
 * `validation_read` and `validation_claim`, which read the live plan; a skill that
 * restated any of it would be a second copy of the procedure, drifting.
 *
 * It carries the plan discussion for the same reason it carries the checks: the
 * cockpit deep-links `/lubbdubb discuss <n>` into this session, and the whole
 * point of Discuss being a link rather than a text box is that the operator lands
 * somewhere that already knows what to do. What the plan *says* still comes back
 * from `plan_read`.
 *
 * `ask <n>` is the fourth job and the only one that settles nothing. It exists
 * because the question an operator has about a goal — what was done, how, which
 * pull request, is it on hallway yet — is answerable from rows the harness already
 * holds, and was previously answerable only by reading the cockpit and the
 * repository and joining them by hand. `goal_read` is the whole of it; this file
 * says what to do with the answer, and its longest section is about the one way a
 * session with the repository open gets this wrong: reconstructing a plausible
 * history from the code, which the operator cannot tell from the real one.
 *
 * `run <n>` is the third of those links, and the division is sharper still: the
 * **harness** starts the application, in a checkout it keeps for the purpose, so
 * this file says only how to ask and what the answer means. *How* this deployment
 * starts is `localRun.instruction`, which the session the harness spawns is handed
 * directly — a session reading it here would be a second copy of an operator's
 * config, and one that could not be stopped from the cockpit.
 */
export const DESKTOP_SKILL = `---
name: lubbdubb
description: Answer a question about a goal LubbDubb has worked or is working — what was done, how, which pull requests, what is left, whether it has reached an environment — or check on the fleet itself and steer it, run a validation check on this machine and report the reading back, get a goal's work running locally, or discuss and amend its delivery plan. Use when asked anything about a goal by number — e.g. "/lubbdubb ask 284", "what happened on 284?" — anything about the harness as a whole — "/lubbdubb fleet", "is anything stuck?", "what is LubbDubb doing?", "pause the fleet", "answer that question" — to validate: "/lubbdubb 284:C" — to start it up: "/lubbdubb run 284" — or to talk a plan through: "/lubbdubb discuss 284".
---

# LubbDubb at your keyboard

Five jobs, told apart by the argument. \`fleet\` — or anything about the harness
rather than about one goal — is [watching and steering it](#watch-and-steer-the-fleet).
\`ask 284 …\` is [a question about a goal](#answer-a-question-about-a-goal),
\`discuss 284\` is [a conversation about a plan](#discuss-a-plan), \`run 284\` is
[getting it up on this machine](#run-it-locally), and anything else is
[a validation check](#run-a-validation-check).

A question asked in plain words — "what happened on 284", "did we ever ship the
export fix", "is 284 on hallway" — is the goal one whether or not the word
\`ask\` was typed. One with **no goal number in it** — "is anything stuck", "what
is it working on", "why is nothing running" — is the fleet one.

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

## Run it locally

The operator wants to see this goal's work running on this machine. **You do not
start it — the harness does.** It keeps one checkout for this, brings the
application up in it, and holds the process; your job is to ask, then say what
happened.

1. **Ask for it.** \`local_run\` with the goal number. The harness stops whatever
   was running, points its checkout at that goal's code, and starts the
   application. Called with no goal it starts nothing and just reports the state.
   Called with a \`message\` it types that into the session holding the running
   environment — the way to get a migration run or a service restarted without
   starting over.
2. **Say what came back.** Whether it is running, on what URL, and — if it is not
   — what the reply says went wrong. The output tail comes back with it, and that
   is where the reason for a failed start actually is.
3. **Then offer the checks.** \`validation_read\` the goal and say what is
   outstanding. **Claim nothing yet.** They opened this to look at the thing, and
   claiming a check locks it away from the fleet while they do. Wait for them to
   pick one, then carry on at
   [run a validation check](#run-a-validation-check).

**Only one goal runs locally at a time**, because there is one dev environment on
this machine. So asking for a second one is asking to stop the first, and it is
worth saying that out loud before you do it if they did not.

**\`running\` is not a reading.** It means the session the harness spawned finished
without failing — nothing has opened that port. Open the URL and look before you
say anything about whether the goal works.

**Do not start it yourself, and do not check a branch out here.** This session is
in the clone the harness cuts its agents' worktrees from: a branch checked out
here is one it can no longer hand to an agent, and a server you start yourself is
one nothing can stop from the cockpit.

## Run a validation check

A validation check is a procedure somebody has to actually carry out before a
goal can be called done — open the page, click the thing, look at what happened.
It exists precisely because the build was green and the pull request merged and
neither of those is the same as the goal working.

This machine can reach environments the harness's own fleet cannot. That is why
the check came here.

### The argument

\`284:C\` is goal 284, check C. \`284\` on its own means "show me what 284 needs".
A bare description ("validate the login fix") means find the goal first and ask
which check if more than one is outstanding.

### What to do

1. **Read it.** \`validation_read\` with the issue, and the check letter if you
   were given one. It comes back with the procedure, what the check expects to
   see, any fixtures it needs and where they live, and whether an earlier attempt
   gave it back and why. Read the whole thing before starting.
2. **Claim it.** \`validation_claim\` with the issue and check. This stops the
   fleet dispatching an agent for the same check while you work, and stops a
   second session on this machine taking a different one — there is one working
   copy, and only one check can be claimed at a time. If something else holds a
   claim, the refusal names it; say so and stop rather than working around it.
3. **Run it.** Follow the procedure as written, on this machine. Drive the
   browser, use the login, do the steps. If it needs the application up, \`local_run\`
   with this goal's number brings it up — the harness owns that, so do not start
   anything yourself and do not guess at a start command.
4. **Report it.** \`validation_report\` once, with what you saw.

### The three answers

- **passed** — you followed the procedure and saw what it expects.
- **failed** — you followed it and did not. A real finding about the goal, and
  worth being specific about: the note is what somebody reads instead of running
  the check again.
- **handback** — you could not run it. No login, no environment, the page is
  gone, the fixture was never provided. This records no reading and gives the
  check back with your reason. **It is the right answer, not a failure**: an
  agent that could not reach the environment has learned nothing about the goal,
  and \`failed\` would flag it for a reason that has nothing to do with the code.

### What not to do

- **Do not report \`passed\` from evidence you did not gather.** A green build, a
  merged PR and code that reads correctly are none of them this check. A pass
  nobody ran is the single outcome this whole feature exists to prevent.
- **Do not change code to make a check pass.** You are taking a reading, not
  doing the work. If the check fails, that is the answer — report it.
- **Do not report more than once**, and do not report on a check you did not
  claim. Which check you are reporting on is decided by what you claimed.
- **If the check describes something that no longer exists** — a screen that
  moved, a command that was renamed — say so in the report rather than guessing
  at what it meant. Correcting the wording is a job for an agent working the
  goal, not for the session taking the reading.
`;

/**
 * The skill as it is written to disk: the body above, plus — when the harness can
 * see its own checkout — a note saying where that checkout is.
 *
 * **Appended, never interpolated.** The body is one fixed document, and a path
 * spliced into it would be a second thing to keep in step every time either moves;
 * the same argument the prompt templates are built on. A deployment running from a
 * tarball resolves no root and gets the body unchanged, which is the honest answer
 * — a section naming a directory that is not there is worse than no section.
 *
 * It exists because of what the cockpit's *Question?* control actually
 * collects. The deep link opens the session on `repoRoot`, the repository the
 * fleet **works on**, and most questions are about that work. But a fair share are
 * not — "why has nothing picked this up", "is this a bug in LubbDubb" — and the
 * two repositories are different directories on this machine except while LubbDubb
 * is dogfooding itself. Without this note the session answers a question about the
 * harness from the harness's *output*, which is the shape of confident wrong answer
 * the `ask` section already warns about.
 * → `docs/spec/26-setup.md`
 */
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

/**
 * Install (or refresh) the skill. Best-effort by contract, like everything else
 * on this channel: a failure is recorded and the harness carries on, because the
 * tools still work when the operator asks for them in their own words.
 *
 * Always overwrites. The alternative — trying to tell an operator's edits from a
 * stale copy — has no honest implementation, and a skill that silently stopped
 * being refreshed would describe a channel that had since changed. There is no
 * setting that turns the writing off; the file says so in its own body, and
 * `validation.desktopSkillPath` is the only way to put it somewhere else.
 */
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
