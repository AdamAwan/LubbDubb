import type { Config } from './config.js';
import type { Store } from './store/store.js';
import type { IssueConclusion, IssueInstruction, Plan } from './types.js';

// → docs/spec/06-issue-pickup.md

export const MAX_INSTRUCTION = 4000;

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
