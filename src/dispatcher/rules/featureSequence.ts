import { issueOriginRef } from '../../issueOrigins.js';
import { dispatchVerdict } from '../dispatchCooldown.js';
import { featureSequenceOrigin } from '../../sequence/sequence.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `feature-sequence`)

export function featureSequence(s: StageContext): void {
  const { ctx } = s;
  for (const feature of s.sequenceableFeatures) {
    const stored = s.sequences.get(issueOriginRef('root', feature.feature.number));
    if (stored?.standingKey === feature.key) continue;
    const origin = featureSequenceOrigin(feature.feature.number);
    if (s.activeOrigins.has(origin)) continue;

    const verdict = dispatchVerdict(origin, s.now, ctx.recentDecisions, s.cooldown);
    if (verdict.kind === 'escalate' || verdict.kind === 'hold') continue;

    const resequence = stored !== undefined && stored.status === 'accepted';
    const title = resequence
      ? `Re-sequence feature #${feature.feature.number}`
      : `Sequence feature #${feature.feature.number}`;
    const reason = stored
      ? `Feature #${feature.feature.number} has gained or lost stories since its order was written.`
      : `Feature #${feature.feature.number} has ${feature.children.length} stories and no order.`;
    s.candidates.push({
      origin,
      rule: 'feature-sequence',
      title,
      kind: 'desk',
      branch: null,
      reason,
      held: verdict.kind === 'cooldown' ? 'cooldown' : undefined,
      action: {
        type: 'dispatch_desk_agent',
        title,
        prompt: s.templates.render(resequence ? 'feature-resequence' : 'feature-sequence', {
          number: feature.feature.number,
          title: feature.feature.title,
        }),
        originRef: origin,
        originTitle: feature.feature.title,
        rule: 'feature-sequence',
        reason,
      } satisfies RawAction,
    });
  }
}
