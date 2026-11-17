import { openPrForIssue } from '../issuePickup.js';
import { resolveIssueConclusion } from '../../issueConclusion.js';
import { issueOrigin } from '../../plans/planning.js';
import { partSettled, planInFlight } from '../../plans/parts.js';
import type { Issue, PlanPart } from '../../types.js';
import type { StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rules `work-item-in-review` / `work-item-back-to-pickup`)

export function workItemRelease(s: StageContext, issue: Issue): ReturnType<typeof resolveIssueConclusion> | null {
  if (openPrForIssue(issue, s.openPrs)) return null;
  const origin = issueOrigin(issue.number);
  const plan = s.plansByOrigin.get(origin) ?? null;
  if (plan && planInFlight(plan)) return null;
  const parts = plan ? (s.ctx.planParts ?? []).filter((p) => p.planId === plan.id) : [];
  const conclusion = resolveIssueConclusion(
    s.conclusions.get(origin) ?? null,
    plan,
    parts,
    s.shortfallsByOrigin.get(origin) ?? null,
  );
  if (conclusion.verdict !== 'more_work') return null;
  if (plan?.status === 'complete' && conclusion.at !== null && conclusion.at < finishedAt(parts)) return null;
  return conclusion;
}

function finishedAt(parts: readonly PlanPart[]): string {
  return parts.filter(partSettled).reduce((latest, p) => (p.updatedAt > latest ? p.updatedAt : latest), '');
}
