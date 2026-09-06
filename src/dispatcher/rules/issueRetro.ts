import { dispatchVerdict } from '../dispatchCooldown.js';
import { issueWatchGateReason } from '../issuePickup.js';
import { retroOrigin } from '../../retro/retro.js';
import { issueOrigin } from '../../plans/planning.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `issue-retro`)

export function issueRetro(s: StageContext): void {
  const { ctx } = s;
  const written = new Set(ctx.retrospectiveOrigins ?? []);
  for (const issue of ctx.world.issues) {
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;
    const root = issueOrigin(issue.number);
    if (written.has(root)) continue;
    if (!s.deliveryParked(issue)) continue;
    if ([...s.activeOrigins].some((o) => o === root || o.startsWith(`${root}:`))) continue;

    const origin = retroOrigin(issue.number);
    const verdict = dispatchVerdict(origin, s.now, ctx.recentDecisions, s.cooldown);
    if (verdict.kind === 'escalate' || verdict.kind === 'hold') continue;

    const title = `Write up issue #${issue.number}`;
    const reason = `Issue #${issue.number} is delivered and has no retrospective; write the run up.`;
    s.candidates.push({
      origin,
      rule: 'issue-retro',
      title,
      kind: 'desk',
      branch: null,
      reason,
      held: verdict.kind === 'cooldown' ? 'cooldown' : undefined,
      action: {
        type: 'dispatch_desk_agent',
        title,
        prompt: s.templates.render('issue-retro', {
          number: issue.number,
          title: issue.title,
          body: issue.body,
        }),
        originRef: origin,
        originTitle: issue.title,
        originSummary: issue.body,
        rule: 'issue-retro',
        reason,
      } satisfies RawAction,
    });
  }
}
