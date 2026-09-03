import type { Config } from './config.js';
import type { Store } from './store/store.js';
import type { IssueConclusion, IssueInstruction, Plan } from './types.js';

/**
 * The operator saying, mid-run, what they actually want — and that reaching every
 * agent dispatched on the goal afterwards.
 *
 * ## The gap this closes
 *
 * The cockpit's "Work left" button wrote a bare `more_work` verdict with a fixed
 * note (`Set by the operator from the cockpit.`), and that verdict's only effect
 * is to bounce the item back to pickup. So an operator who had just looked at the
 * delivered thing and knew exactly what was wrong with it — _change the button to
 * primary_, _the permission is wrong_, _the loading icon is broken_ — had one
 * click that carried none of it, and the next agent re-read the same ticket that
 * had already produced the thing they were unhappy with. The two ways out were
 * both bad: edit the ticket by hand (the harness's own record of the goal then
 * disagrees with what any agent was told), or raise a bug (a whole second work
 * item for a sentence's worth of change).
 *
 * ## Shape
 *
 * An instruction is **input, not a verdict**. It accumulates rather than
 * overwriting ({@link IssueInstruction}), it is appended to the dispatch prompt
 * rather than filled into a template placeholder — `loadPromptTemplates` rejects
 * only _unknown_ placeholders, so an operator override that never learned about a
 * new `{instructions}` token would silently drop the operator's own words on
 * exactly the deployments that customised most — and it is quoted and attributed
 * for `outstandingWorkNote`'s reason inverted: this one _is_ an instruction, and
 * saying so is what stops an agent reading it as testimony to be weighed.
 *
 * ## Why the agent updates the ticket
 *
 * A goal that lives only in prompts is a goal nobody can read. The ticket is the
 * record every later agent, every assessor and every human starts from, so an
 * instruction that changes what the goal asks for has to reach it — and the agent
 * is the only party that can tell "this changes the goal" from "this is a note
 * about how to do work the goal already asks for". So the harness supplies the
 * one thing an agent cannot infer (which tracker, and the command), states the
 * judgement, and leaves the judgement to the agent. That is
 * {@link file://./bugFiling.ts}'s arrangement exactly, for its reasons.
 */

/** Long enough for a paragraph with a repro; short of pasting a transcript in. */
export const MAX_INSTRUCTION = 4000;

/**
 * How to read and amend this goal's ticket, in the words the agent needs — or
 * null when there is no tracker to amend (the `fake` provider, an unconfigured
 * one), where the note says so rather than naming a command that would fail.
 *
 * Read-then-write, both halves. An agent handed only the write command has to
 * guess the current body, and the one failure worth engineering against here is
 * an amendment that silently replaces the goal instead of adding to it.
 */
export function ticketAmendCommands(config: Config, issueNumber: number): string | null {
  const provider = config.integrations.issues;
  if (provider === 'github' && config.github) {
    const slug = `${config.github.owner}/${config.github.repo}`;
    return (
      `Read what it says now, then write the amended body from a file — never from an inline ` +
      `string, which mangles the markdown:\n\n` +
      `  gh issue view ${issueNumber} -R ${slug} --json body -q .body > /tmp/issue-${issueNumber}.md\n` +
      `  # edit /tmp/issue-${issueNumber}.md\n` +
      `  gh issue edit ${issueNumber} -R ${slug} --body-file /tmp/issue-${issueNumber}.md`
    );
  }
  if (provider === 'azure' && config.azureDevOps) {
    const { organization, project } = config.azureDevOps;
    const org = `https://dev.azure.com/${organization}`;
    return (
      `Read what it says now, then write the amended description back — in project "${project}", ` +
      `organization "${organization}":\n\n` +
      `  az boards work-item show --org ${org} --id ${issueNumber} --query "fields.\\"System.Description\\""\n` +
      `  az boards work-item update --org ${org} --id ${issueNumber} --description "<the amended description>"\n\n` +
      `The description is HTML, so keep the markup that is already in it.`
    );
  }
  return null;
}

/**
 * The block appended to a dispatch on a goal that carries standing instructions,
 * or the empty string when it carries none — in which case the prompt is
 * byte-identical to one composed before this existed, which is the rule every
 * appended block here follows.
 *
 * Pure, and it derives nothing: the operator's words are quoted verbatim, the
 * order is the order they were written in, and the harness adds only the framing
 * that says how to read them.
 */
export function operatorInstructionsNote(instructions: IssueInstruction[], amend: string | null): string {
  if (instructions.length === 0) return '';
  const quoted = instructions
    .map((i) => `> ${i.text.replace(/\n/g, '\n> ')}\n>\n> — the operator, ${i.createdAt}`)
    .join('\n\n');
  const ticket = amend
    ? `**Update the ticket when an instruction changes what the goal asks for**, so the ticket stays ` +
      `the record of it: the next agent, the assessor and every human after the run read the ticket ` +
      `and cannot see this prompt. Add to it or correct it — do not rewrite what is still true — and ` +
      `leave it alone for an instruction that only says *how* to do work it already asks for. ` +
      `${amend}`
    : `This deployment has no issue tracker to update, so say what the goal now asks for in your ` +
      `conclude_work note instead — that note is the only record anything after you will read.`;
  return [
    '---',
    '',
    '## What the operator has asked for on this goal',
    '',
    `${instructions.length === 1 ? 'The operator has' : `The operator has, ${instructions.length} times,`} ` +
      'written on this goal since the last agent concluded it. In their words, oldest first:',
    '',
    quoted,
    '',
    'These are **instructions**, not a report to be weighed: they are what the goal asks for now, and ' +
      'where they disagree with the ticket, the plan or an earlier agent’s note, they win. Do them as ' +
      'part of this dispatch — they are not a separate task and nothing else is scheduled for them.',
    '',
    ticket,
    '',
    'They stand until an agent concludes this goal, and calling conclude_work settles all of them at ' +
      'once. So say in that note what you did with each one: one you decided against, or could not do, ' +
      'is one nobody will ever be told about otherwise.',
  ].join('\n');
}

/**
 * What writing an instruction does to the goal, in one place.
 *
 * Two surfaces reach it — the cockpit's `POST /api/issues/:number/instruction` and
 * the desktop channel's `goal_instruct` — and it is three writes rather than one,
 * which is the whole reason it is not left to each of them. An instruction that
 * only appended a row would be read by the *next* agent dispatched on the goal,
 * and a delivered goal has no next agent: the words would sit in the record with
 * nothing scheduled to read them, which looks exactly like an operator being
 * listened to.
 *
 * So the restart is part of writing one:
 *
 * - the **row**, which is what reaches the prompt ({@link operatorInstructionsNote});
 * - an operator `more_work` **conclusion**, which retracts a delivery through the
 *   exclusion matrix and returns the item to pickup;
 * - and a **settled plan** sent back to a planner. Only a settled one — a plan
 *   still `planning`, `awaiting_approval` or `active` already has a next dispatch
 *   or a decision the operator owes, and rewinding it would throw away the
 *   decomposition they are in the middle of.
 *
 * → `docs/spec/13-jobs-and-tickets.md`, `docs/spec/11-mcp-tools.md`
 */
export function writeGoalInstruction(
  store: GoalInstructionStore,
  originRef: string,
  text: string,
): { instruction: IssueInstruction; conclusion: IssueConclusion; replanned: Plan | null } {
  const instruction = store.addIssueInstruction({ originRef, text });
  const conclusion = store.recordIssueConclusion({
    originRef,
    verdict: 'more_work',
    note: 'The operator wrote an instruction for this goal — it is in front of the next agent.',
    by: 'operator',
  });
  const plan = store.getPlanByOrigin(originRef);
  const replanned = plan?.status === 'complete' ? store.setPlanStatus(plan.id, 'planning') : null;
  return { instruction, conclusion, replanned };
}

/**
 * Take one back — the escape hatch {@link writeGoalInstruction} has to have, and
 * the only way an instruction stops standing other than an agent concluding the
 * goal.
 *
 * Withdrawing the **last** one clears the operator's `more_work` with it, and only
 * ever that one: the two rows were written together, so leaving the verdict behind
 * would keep bouncing the item back to pickup for words nobody is going to read.
 * An agent's own declaration is left exactly where it was found — it is about the
 * work, not about the instruction.
 *
 * What a withdrawal does **not** undo is the rest of the restart: a delivery the
 * write retracted stays retracted, and a plan it sent back to a planner stays in
 * `planning`. Neither is recoverable by guessing — a cleared verdict has no row to
 * resurrect, and a plan re-marked `complete` from here would claim a roll-up that
 * nothing re-derived.
 */
export function withdrawGoalInstruction(
  store: GoalInstructionStore,
  originRef: string,
  id: string,
): { ok: false } | { ok: true; standing: number } {
  if (!store.withdrawInstruction(id)) return { ok: false };
  const standing = store.listStandingInstructions(originRef);
  const conclusion = store.getIssueConclusion(originRef);
  if (standing.length === 0 && conclusion?.by === 'operator' && conclusion.verdict === 'more_work')
    store.clearIssueConclusion(originRef);
  return { ok: true, standing: standing.length };
}

/** What the two acts above touch, and nothing else. */
type GoalInstructionStore = Pick<
  Store,
  | 'addIssueInstruction'
  | 'recordIssueConclusion'
  | 'getPlanByOrigin'
  | 'setPlanStatus'
  | 'withdrawInstruction'
  | 'listStandingInstructions'
  | 'getIssueConclusion'
  | 'clearIssueConclusion'
>;
