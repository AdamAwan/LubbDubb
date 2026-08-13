import type { ValidationCheck } from '../types.js';

/**
 * The fleet's half of a validation plan: the origin one handed-over check is
 * dispatched on, the branch it is run from, and the prompt appendix that tells
 * an agent what it is actually being asked to do.
 *
 * Pure, and shared by the rule that dispatches (`src/dispatcher/rules/validateCheck.ts`)
 * and the tool that reports (`src/mcp/tools/validationReport.ts`) — the two ends
 * of one hand-over, and the pair most able to drift, since one *writes* the
 * origin string the other *parses*.
 */

/**
 * `issue:<n>:validate:<checkId>` — one origin per check, never one per goal.
 *
 * Per check because the origin is what the cooldown and the three-attempt cap
 * are keyed on: a shared `issue:<n>:validate` would spend one budget across
 * every check on the goal, so a check an agent could never manage would exhaust
 * the attempts of the four beside it without one of them having been tried. It
 * is the split `pr-ci-gate` makes against `pr-ci`, for the same reason and with
 * the same consequence if it is not made.
 */
export function validateOrigin(issueNumber: number, checkId: string): string {
  return `issue:${issueNumber}:validate:${checkId}`;
}

/**
 * The issue and check a validate origin names, or null for a ref that is not
 * one.
 *
 * The check id is taken as the whole remainder rather than up to the next
 * colon: the id's own grammar (`^[a-z0-9][a-z0-9-]*$`) has no colon in it, so
 * there is nothing to split on, and reading only as far as one would silently
 * truncate rather than refuse if the grammar ever widened.
 */
export function validateOriginParts(originRef: string | null): { issueNumber: number; checkId: string } | null {
  const match = /^issue:(\d+):validate:(.+)$/.exec(originRef ?? '');
  if (!match) return null;
  return { issueNumber: Number(match[1]), checkId: match[2] as string };
}

/**
 * `validate/issue/<n>/<checkId>` — its own namespace, `assess/issue/<n>`'s
 * reason: git stores refs as files, so `refs/heads/issue/12` and
 * `refs/heads/issue/12/…` cannot coexist.
 *
 * The check id is on the branch too, so two checks handed over on one goal get
 * two worktrees instead of fighting over one. Nothing bare is ever cut — there
 * is no `validate/issue/12` for `validate/issue/12/some-check` to collide with.
 */
export function validateBranch(issueNumber: number, checkId: string): string {
  return `validate/issue/${issueNumber}/${checkId}`;
}

/**
 * What the agent is being asked to do, **appended** to the rendered prompt
 * rather than interpolated into it.
 *
 * `loadPromptTemplates` rejects only *unknown* placeholders, so an operator
 * override that predates a token silently drops it — and this is the half the
 * agent cannot act without: without the procedure it has been sent to run a
 * check it cannot read. Appending has no fallback to get wrong.
 */
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
    // Names, never paths — the resource table's own rule, and the reason this
    // needs no read of it: the names are on the check, and the prompt has
    // already said which directory to look for them in.
    lines.push(`### It needs\n\n${check.uses.map((name) => `- **${name}**`).join('\n')}\n`);
  }
  if (check.handbackNote !== null) {
    // The last attempt's own words, in front of the next one. Without it an
    // agent re-dispatched after a hand-back rediscovers the same wall, hands the
    // check back again, and spends an attempt saying what was already on the row.
    lines.push(`### An agent gave this back before\n\n> ${check.handbackNote}\n`);
  }
  return lines.join('\n');
}
