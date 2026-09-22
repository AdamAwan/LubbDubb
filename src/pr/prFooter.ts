// → docs/spec/07-pull-requests.md#the-footer

/**
 * The last line of every pull request the harness opens.
 *
 * A reviewer weighs an account by who wrote it, and the one thing a body cannot
 * leave them to guess is whether a person wrote it at all. It is the harness's
 * line, not the agent's, so it is written here and never asked for.
 */
export const AUTOMATION_NOTE = '🤖 Automated PR from LubbDubb';

/**
 * The mark above an operator's own description.
 *
 * `composeDescribedBody` puts it under their text, where the footer's own line
 * would otherwise be the only attribution on the page and would name the wrong
 * author for the half above it.
 */
export const HUMAN_NOTE = '🫀 Organic human description';

/**
 * The footer: the facts the harness owes a reviewer, under a rule, ending in the
 * automation note.
 *
 * Everything above it is whoever wrote the description — the agent's bullets or the
 * operator's prose — and the harness adds nothing to it. The issue reference is
 * never a closing keyword: whether a pull request closes its issue is the agent's
 * call, and a part whose siblings are still open must not shut the ticket.
 */
export function renderPrFooter(input: {
  issueNumber: number;
  issueTitle: string;
  position: number;
  total: number;
}): string {
  const reference =
    input.total > 1
      ? `Part ${input.position}/${input.total} of #${input.issueNumber} — ${input.issueTitle}`
      : `Relates to #${input.issueNumber} — ${input.issueTitle}`;
  return ['---', '', reference, AUTOMATION_NOTE].join('\n');
}
