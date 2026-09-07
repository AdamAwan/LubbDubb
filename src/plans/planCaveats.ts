import type { Issue, Plan, PlanCaveat, PlanPart, Proposal, PullRequest } from '../types.js';
import { unclaimedIssuePrs, wedgeReasons } from './planWedge.js';

// → docs/spec/08-planning.md

export function planCaveats(
  plan: Pick<Plan, 'risks' | 'openQuestions'>,
  issue: Issue,
  parts: PlanPart[],
  openPrs: PullRequest[],
): PlanCaveat[] {
  const caveats: PlanCaveat[] = [];
  wedgeReasons(parts).forEach((reason, i) => {
    caveats.push({
      id: `blocked:${i}`,
      label: 'Parts are blocked and cannot be cut',
      detail: reason,
    });
  });
  for (const pr of unclaimedIssuePrs(issue, parts, openPrs)) {
    caveats.push({
      id: `unclaimed-pr:${pr.number}`,
      label: `PR #${pr.number} is open on this issue and unclaimed`,
      detail:
        `“${pr.title}” on ${pr.branch} belongs to no part of this plan. Approving does not close it, hand it to ` +
        `a part, or count it towards the plan.`,
    });
  }
  const unsure = plan.openQuestions?.trim();
  if (unsure)
    caveats.push({
      id: 'open-questions',
      label: 'Open questions — approving decides them the planner’s way',
      detail: unsure,
    });
  const risks = plan.risks?.trim();
  if (risks)
    caveats.push({
      id: 'risks',
      label: 'Risks the planner named',
      detail: risks,
    });
  return caveats;
}

export function caveatNotice(caveats: PlanCaveat[]): string {
  if (caveats.length === 0) return '';
  const lines = caveats.map((c) => `- ${c.label}${c.detail ? `\n\n  ${c.detail.replace(/\n/g, '\n  ')}` : ''}`);
  return (
    `\n\nBefore you decide:\n\n${lines.join('\n')}\n\n` +
    `Approving is held until each of these is acknowledged — tick them on the card, or send them with the accept. ` +
    `A tick can carry words: pick between the options one of these offers, or leave the question you still have. ` +
    `They are appended to the plan for whoever works it, and do not send the plan back for a replan. ` +
    `Rejecting, holding and closing the ticket are not gated: this is about releasing work, not about saying no.`
  );
}

export function unacknowledgedCaveats(caveats: PlanCaveat[], acknowledged: readonly string[]): PlanCaveat[] {
  const ticked = new Set(acknowledged);
  return caveats.filter((c) => !ticked.has(c.id));
}

export interface CaveatAnswerInput {
  id: string;
  answer: string;
}

export function answeredCaveats(
  caveats: PlanCaveat[],
  answers: readonly CaveatAnswerInput[],
): { caveatId: string; label: string; answer: string }[] {
  const raised = new Map(caveats.map((c) => [c.id, c]));
  const kept: { caveatId: string; label: string; answer: string }[] = [];
  for (const { id, answer } of answers) {
    const caveat = raised.get(id);
    const words = answer.trim();
    if (!caveat || words === '') continue;
    kept.push({ caveatId: caveat.id, label: caveat.label, answer: words });
  }
  return kept;
}

export function proposedCaveats(proposal: Proposal): PlanCaveat[] {
  const raw = (proposal.action as Record<string, unknown>).caveats;
  if (!Array.isArray(raw)) return [];
  const caveats: PlanCaveat[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, label, detail } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || id === '' || typeof label !== 'string' || label === '') continue;
    caveats.push({ id, label, detail: typeof detail === 'string' && detail ? detail : null });
  }
  return caveats;
}
