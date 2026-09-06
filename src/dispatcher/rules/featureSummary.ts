import { dispatchVerdict } from '../dispatchCooldown.js';
import { featureSummaryOrigin } from '../../summaries/featureSummary.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `feature-summary`)

export function featureSummary(s: StageContext): void {
  const { ctx } = s;
  const written = new Map((ctx.featureSummaryKeys ?? []).map((k) => [k.originRef, k.standingKey]));
  for (const feature of ctx.featureStandings ?? []) {
    const origin = featureSummaryOrigin(feature.number);
    if (written.get(`issue:${feature.number}`) === feature.key) continue;
    if (s.activeOrigins.has(origin)) continue;

    const verdict = dispatchVerdict(origin, s.now, ctx.recentDecisions, s.cooldown);
    if (verdict.kind === 'escalate' || verdict.kind === 'hold') continue;

    const title = `Summarise feature #${feature.number}`;
    const reason = `Work under feature #${feature.number} has moved since it was last summarised.`;
    s.candidates.push({
      origin,
      rule: 'feature-summary',
      title,
      kind: 'desk',
      branch: null,
      reason,
      held: verdict.kind === 'cooldown' ? 'cooldown' : undefined,
      action: {
        type: 'dispatch_desk_agent',
        title,
        prompt: s.templates.render('feature-summary', { number: feature.number, title: feature.title }),
        originRef: origin,
        originTitle: feature.title,
        rule: 'feature-summary',
        reason,
      } satisfies RawAction,
    });
  }
}
