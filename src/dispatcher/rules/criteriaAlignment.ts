import { issueOriginRef } from '../../issueOrigins.js';
import { ticketCriteria } from '../../criteria/ticketCriteria.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/08-planning.md#the-alignment-check

export function criteriaAlignment(s: StageContext): void {
  const read = new Set((s.ctx.criteriaAlignments ?? []).map((a) => `${a.originRef}#${a.version}`));
  for (const { issue } of s.eligibleIssues) {
    if (!s.sittingHolds(issue.number)) continue;
    const criteria = s.criteriaFor(issue.number);
    if (criteria === null) continue;
    if (read.has(`${criteria.originRef}#${criteria.version}`)) continue;
    const ticket = ticketCriteria(issue.body);
    if (ticket === null) continue;
    const origin = issueOriginRef('criteriaAlignment', issue.number);
    if (s.activeOrigins.has(origin)) continue;

    const title = `Check your criteria for issue #${issue.number} against the ticket`;
    const reason =
      `Issue #${issue.number} carries acceptance criteria of its own and yours (version ${criteria.version}) ` +
      'have not been compared with them.';
    const since = Date.parse(criteria.authoredAt);
    s.consider(
      {
        origin,
        rule: 'criteria-alignment',
        title,
        kind: 'desk',
        branch: null,
        reason,
        action: {
          type: 'dispatch_desk_agent',
          title,
          prompt: s.templates.render('criteria-alignment', {
            number: issue.number,
            title: issue.title,
            ticket,
            criteria: criteria.text,
            version: criteria.version,
          }),
          originRef: origin,
          originTitle: issue.title,
          originSummary: ticket,
          rule: 'criteria-alignment',
          reason,
        } satisfies RawAction,
      },
      { decisions: s.ctx.recentDecisions.filter((d) => Date.parse(d.createdAt) > since) },
    );
  }
}
