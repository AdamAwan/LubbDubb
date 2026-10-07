import { openPrForIssue } from '../issuePickup.js';
import { resolveIssueConclusion } from '../../issueConclusion.js';
import { issueOrigin } from '../../plans/planning.js';
import type { Issue } from '../../types.js';
import type { StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rules `work-item-in-review` / `work-item-back-to-pickup`)

export function workItemRelease(s: StageContext, issue: Issue): ReturnType<typeof resolveIssueConclusion> | null {
  if (openPrForIssue(issue, s.openPrs)) return null;
  const origin = issueOrigin(issue.number);
  const plan = s.plansByOrigin.get(origin) ?? null;
  const conclusion = resolveIssueConclusion(
    s.conclusions.get(origin) ?? null,
    plan,
    plan ? (s.ctx.planParts ?? []).filter((p) => p.planId === plan.id) : [],
    s.shortfallsByOrigin.get(origin) ?? null,
  );
  if (conclusion.verdict !== 'more_work') return null;
  return conclusion.by === 'plan' && s.partsPlanFor(issue.number) !== null ? null : conclusion;
}
