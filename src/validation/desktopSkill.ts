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
description: Answer a question about a goal LubbDubb has worked or is working — what was done, how, which pull requests, what is left, whether it has reached an environment — or run a validation check on this machine and report the reading back, get a goal's work running locally, or discuss and amend its delivery plan. Use when asked anything about a goal by number — e.g. "/lubbdubb ask 284", "/lubbdubb ask 284 is it on hallway yet?", "what happened on 284?", "why did 284 take four goes?" — to validate: "/lubbdubb 284:C" — to start it up: "/lubbdubb run 284" — or to talk a plan through: "/lubbdubb discuss 284".
---

# LubbDubb at your keyboard

Four jobs, told apart by the argument. \`ask 284 …\` is
[a question about a goal](#answer-a-question-about-a-goal), \`discuss 284\` is
[a conversation about a plan](#discuss-a-plan), \`run 284\` is
[getting it up on this machine](#run-it-locally), and anything else is
[a validation check](#run-a-validation-check).

A question asked in plain words — "what happened on 284", "did we ever ship the
export fix", "is 284 on hallway" — is the first of those whether or not the word
\`ask\` was typed.

<!-- Managed by LubbDubb: the desktop channel is unconditional, so this file is
     rewritten from scratch every time the harness starts. There is no setting
     that keeps a local version — edit it and the next start overwrites you. -->

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
export function installDesktopSkill(path: string, errors?: ErrorRecorder): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, DESKTOP_SKILL);
    return true;
  } catch (err) {
    errors?.record({
      source: 'agent',
      message: `Could not install the /lubbdubb skill at ${path}: ${(err as Error).message}`,
    });
    return false;
  }
}
