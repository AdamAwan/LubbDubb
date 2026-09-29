import { issueOriginRef } from '../../issueOrigins.js';
import { featureSummaryOrigin, standingMoves, summaryHeld } from '../../featureSummaries/featureSummary.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `feature-summary`)

const MOVES_IN_REASON = 6;

export function featureSummary(s: StageContext): void {
  const { ctx } = s;
  const written = new Map((ctx.featureSummaryKeys ?? []).map((k) => [k.originRef, k]));
  for (const feature of ctx.featureStandings ?? []) {
    const origin = featureSummaryOrigin(feature.number);
    const onFile = written.get(issueOriginRef('root', feature.number));
    if (onFile?.standingKey === feature.key) continue;
    if (onFile && summaryHeld(onFile, feature.key)) continue;
    if (s.activeOrigins.has(origin)) continue;

    const title = `Summarise feature #${feature.number}`;
    const reason = movedReason(feature.number, onFile?.standingLines ?? null, feature.lines);
    s.consider({
      origin,
      rule: 'feature-summary',
      title,
      kind: 'desk',
      branch: null,
      reason,
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

function movedReason(number: number, before: string[] | null, after: string[]): string {
  const head = `Work under feature #${number} has moved since it was last summarised.`;
  const moves = standingMoves(before, after, { gone: 'was ', came: 'now ' });
  if (moves.length === 0) return head;
  const shown = moves.slice(0, MOVES_IN_REASON);
  const more = moves.length > shown.length ? `; and ${moves.length - shown.length} more` : '';
  return `${head} ${shown.join('; ')}${more}`;
}
