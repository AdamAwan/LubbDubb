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
 */
export const DESKTOP_SKILL = `---
name: lubbdubb
description: Run a LubbDubb validation check on this machine and report the reading back, or discuss a goal's delivery plan with the operator and amend it. Use when asked to validate, check or verify a goal — e.g. "/lubbdubb 284:C", "/lubbdubb 284", "run check C on 284" — or to talk a plan through: "/lubbdubb discuss 284".
---

# LubbDubb at your keyboard

Two jobs, told apart by the argument. \`discuss 284\` is
[a conversation about a plan](#discuss-a-plan); anything else is
[a validation check](#run-a-validation-check).

<!-- Managed by LubbDubb: the desktop channel is unconditional, so this file is
     rewritten from scratch every time the harness starts. There is no setting
     that keeps a local version — edit it and the next start overwrites you. -->

## Discuss a plan

A plan is a planner agent's decomposition of a goal into separately reviewable
pull requests, and it is sitting in the operator's cockpit waiting to be approved
or sent back. They opened this conversation from that sheet because they want to
argue with it before they decide — with you, here, where the repository is open
and there is room to actually talk, rather than through a one-line box.

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
4. **Send them back.** Say the plan is amended and that they approve it in the
   cockpit. That is where this ends.

**Do not do the work.** You were asked about the shape of the plan, not to
deliver it. Nothing here writes code, opens a branch or a pull request, and a
session that starts implementing has answered a question nobody asked.

If they decide the plan was right after all, amend nothing — say so and stop. A
plan left alone is still approvable exactly as it was.

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
   browser, use the login, do the steps.
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
