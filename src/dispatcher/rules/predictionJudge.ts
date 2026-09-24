import { issueOriginRef, parseIssueOrigin } from '../../issueOrigins.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/14-persistence.md#the-prediction-judge

export function predictionJudge(s: StageContext): void {
  for (const goal of s.ctx.judgeOwed ?? []) {
    const parsed = parseIssueOrigin(goal);
    if (parsed === null || parsed.family !== 'root') continue;
    const origin = issueOriginRef('predictionJudge', parsed.issueNumber);
    if (s.activeOrigins.has(origin)) continue;
    const issue = s.ctx.world.issues.find((i) => i.number === parsed.issueNumber) ?? null;
    const issueTitle = issue?.title ?? `Issue #${parsed.issueNumber}`;
    const title = `Second reading of issue #${parsed.issueNumber}'s prediction`;
    const reason = `The operator has marked their prediction for issue #${parsed.issueNumber}; take the judge's reading.`;
    s.consider({
      origin,
      rule: 'prediction-judge',
      title,
      kind: 'desk',
      branch: null,
      reason,
      action: {
        type: 'dispatch_desk_agent',
        title,
        prompt: s.templates.render('prediction-judge', { number: parsed.issueNumber, title: issueTitle }),
        originRef: origin,
        originTitle: issueTitle,
        originSummary: null,
        rule: 'prediction-judge',
        reason,
      } satisfies RawAction,
    });
  }
}
