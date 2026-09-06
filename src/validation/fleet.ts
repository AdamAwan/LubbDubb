import type { ValidationCheck } from '../types.js';

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
  if (check.uses.length > 0) {
    lines.push(`### It needs\n\n${check.uses.map((name) => `- **${name}**`).join('\n')}\n`);
  }
  if (check.handbackNote !== null) {
    lines.push(`### An agent gave this back before\n\n> ${check.handbackNote}\n`);
  }
  return lines.join('\n');
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
