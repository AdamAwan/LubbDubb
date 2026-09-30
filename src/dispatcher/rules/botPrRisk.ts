import { botPrRiskOrigin } from '../../botPrs/riskOrigin.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/37-bot-prs.md#the-risk-summary

export function botPrRisk(s: StageContext): void {
  const run = s.botPrRiskRun;
  if (run === null) return;
  const origin = botPrRiskOrigin(run.id);
  if (s.activeOrigins.has(origin)) return;
  const count = run.subjects.length;
  const title = `Read ${count === 1 ? 'one bot pull request' : `${String(count)} bot pull requests`} for risk`;
  const reason =
    `${run.trigger === 'operator' ? 'Somebody pressed Summarise' : 'botPrs.riskSchedule came round'}, and ` +
    `${count === 1 ? 'one dependency update has' : `${String(count)} dependency updates have`} not been read on their current head.`;
  s.candidates.push({
    origin,
    rule: 'bot-pr-risk',
    title,
    kind: 'desk',
    branch: null,
    reason,
    action: {
      type: 'dispatch_desk_agent',
      title,
      prompt: s.templates.render('bot-pr-risk', { count }) + run.briefing,
      botPrRiskRun: { id: run.id },
      originRef: origin,
      originTitle: title,
      originSummary: null,
      rule: 'bot-pr-risk',
      reason,
    } satisfies RawAction,
  });
}
