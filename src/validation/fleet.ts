import type { ValidationCheck, ValidationStep } from '../types.js';
import { segmentBoundary } from './steps.js';

// → docs/spec/20-validation.md

export function validateOrigin(issueNumber: number, checkId: string): string {
  return `issue:${issueNumber}:validate:${checkId}`;
}

export function validateOriginParts(originRef: string | null): { issueNumber: number; checkId: string } | null {
  const match = /^issue:(\d+):validate:(.+)$/.exec(originRef ?? '');
  if (!match) return null;
  return { issueNumber: Number(match[1]), checkId: match[2] as string };
}

export function validateBranch(issueNumber: number, checkId: string): string {
  return `validate/issue/${issueNumber}/${checkId}`;
}

export function checkBriefing(check: ValidationCheck): string {
  const lines = [
    `\n\n---\n\n## Check ${check.letter} — ${check.title}\n`,
    `Its id is \`${check.id}\`. That id, not the letter, is what you report against.\n`,
    `### Do\n\n${check.do}\n`,
    `### Expect\n\n${check.expect}\n`,
  ];
  if (check.candidateWhy !== null) {
    lines.push(`The planner thought an agent could run this because: ${check.candidateWhy}\n`);
  }
  const steps = stepPlan(check);
  if (steps !== null) lines.push(steps);
  if (check.uses.length > 0) {
    lines.push(`### It needs\n\n${check.uses.map((name) => `- **${name}**`).join('\n')}\n`);
  }
  if (check.handbackNote !== null) {
    lines.push(`### An agent gave this back before\n\n> ${check.handbackNote}\n`);
  }
  return lines.join('\n');
}

/**
 * The test plan, and where this dispatch stops. A check with **no** steps draws nothing and is the
 * prose check it always was.
 *
 * The boundary is the load-bearing half. An inline person's step segments the check — no agent holds
 * a session across a person's day — so the dispatch runs as far as it and hands back with what it
 * has, exactly as a hand-over does. Left undrawn, an agent reads a plan it cannot finish and either
 * sits in front of the step or reports a failure that is really a wait.
 * → docs/spec/20-validation.md#an-inline-person-and-a-deferred-one-are-not-the-same-step
 */
function stepPlan(check: ValidationCheck): string | null {
  const steps = check.steps;
  if (steps.length === 0) return null;
  const boundary = segmentBoundary(steps);
  const lines = [
    '### The test plan\n',
    'In order. Take each step where it sits — a reading taken early answers a different question.\n',
  ];
  steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${stepLine(step, boundary !== null && index >= boundary)}`);
  });
  lines.push('');
  if (boundary === null) {
    lines.push('Every step here is yours. Run them all, then record what you saw.\n');
  } else {
    lines.push(
      `**Stop after step ${boundary}.** Step ${boundary + 1} is a person's and it is *inline*: the run waits on ` +
        'them, and no agent holds a session across somebody’s day. Hand the check back with what you have and ' +
        'say which step you reached — that returns it to the operator, and it is the right outcome here rather ' +
        'than a failure.\n',
    );
  }
  return lines.join('\n');
}

function stepLine(step: ValidationStep, past: boolean): string {
  const area = step.area === null ? '' : ` \`${step.area}\``;
  const who =
    step.actor === 'fleet'
      ? past
        ? ' — **not this run**, it is past the hand-back'
        : ''
      : ` — **a person's**${step.when === 'deferred' ? ', deferred: they look afterwards' : ', and inline'}` +
        (step.why === null ? '' : ` (${step.why})`);
  return `**${step.kind}**${area} — ${step.do}${who}`;
}

export function validationFailureOrigin(issueNumber: number, checkId: string): string {
  return `issue:${issueNumber}:validate-failure:${checkId}`;
}

export function validationFailureBranch(issueNumber: number, checkId: string): string {
  return `validate-failure/issue/${issueNumber}/${checkId}`;
}

export function failureBriefing(check: ValidationCheck): string {
  const who = check.resultBy === 'agent' ? 'An agent' : check.resultBy === 'operator' ? 'A person' : 'Somebody';
  const note = check.resultNote ?? '(no account was recorded — the row says only that it failed)';
  return (
    checkBriefing(check) +
    `\n### What was reported\n\n${who} ran it and recorded **failed**:\n\n> ${note.replace(/\n/g, '\n> ')}\n`
  );
}
