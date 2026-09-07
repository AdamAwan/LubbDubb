import { dispatchVerdict } from '../dispatchCooldown.js';
import { issueWatchGateReason } from '../issuePickup.js';
import type { Plan, PlanAtom, PlanPart } from '../../types.js';
import {
  bySlug,
  liveParts,
  partBase,
  partBranch,
  partDepth,
  partIsHuman,
  partOrigin,
  partDeclarationNote,
  partOutcomeNote,
  planIssueNumber,
  siblingContext,
} from '../../plans/parts.js';
import { budgetNote } from '../../prSplit.js';
import type { Candidate, RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `plan-part`)

interface PartCandidate {
  depth: number;
  issueNumber: number;
  seq: number;
  candidate: Candidate;
}

export function planPart(s: StageContext): void {
  const { ctx } = s;
  const partCandidates: PartCandidate[] = [];
  for (const plan of ctx.plans ?? []) {
    const unapproved = plan.status === 'awaiting_approval';
    if (plan.status !== 'active' && !unapproved) continue;
    const issueNumber = planIssueNumber(plan.originRef);
    if (issueNumber === null) continue;
    const issue = s.liveIssue(issueNumber);
    if (!issue || issue.state !== 'open') continue;
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;

    const parts = liveParts((ctx.planParts ?? []).filter((p) => p.planId === plan.id));
    const atoms = (ctx.planAtoms ?? []).filter((a) => a.planId === plan.id);
    const index = bySlug(parts);
    const inFlight = parts.filter((p) => s.activeOrigins.has(partOrigin(issueNumber, p.slug))).length;
    let room = s.planning.maxConcurrentPartsPerIssue - inFlight;
    const ready = parts
      .filter((p) => !partIsHuman(p))
      .filter((p) => p.status === 'ready' && !s.activeOrigins.has(partOrigin(issueNumber, p.slug)))
      .map((part) => ({ part, depth: partDepth(part, index) }))
      .sort((a, b) => a.depth - b.depth || a.part.seq - b.part.seq);
    for (const { part, depth } of ready) {
      const origin = partOrigin(issueNumber, part.slug);
      if (unapproved) {
        partCandidates.push({
          depth,
          issueNumber,
          seq: part.seq,
          candidate: partCandidate(s, plan, issue, part, parts, atoms, index, issueNumber, 'unapproved'),
        });
        continue;
      }
      const verdict = dispatchVerdict(origin, s.now, ctx.recentDecisions, s.cooldown);
      if (verdict.kind === 'hold') continue;
      if (verdict.kind === 'escalate') {
        s.raw.push({
          type: 'escalate_to_human',
          escalationType: 'resolve_ambiguity',
          prompt: s.templates.render('plan-part-escalation', {
            number: issueNumber,
            part: part.title,
            attempts: verdict.attempts,
          }),
          context: { originRef: origin, taskTitle: part.title },
          rule: 'plan-part',
          admission: 'cooldown-escalate',
          reason: `Origin ${origin} hit the ${s.cooldown.maxAttempts}-attempt cap without producing a PR — escalating instead of looping.`,
        } satisfies RawAction);
        continue;
      }
      const cooling = verdict.kind === 'cooldown';
      const capped = !cooling && room <= 0;
      if (!cooling && !capped) room -= 1;
      const held = cooling ? 'cooldown' : capped ? 'capped' : undefined;
      partCandidates.push({
        depth,
        issueNumber,
        seq: part.seq,
        candidate: partCandidate(s, plan, issue, part, parts, atoms, index, issueNumber, held),
      });
    }
  }
  partCandidates.sort((a, b) => a.depth - b.depth || a.issueNumber - b.issueNumber || a.seq - b.seq);
  for (const c of partCandidates) s.candidates.push(c.candidate);
}

function partCandidate(
  s: StageContext,
  plan: Plan,
  issue: { number: number; title: string },
  part: PlanPart,
  parts: PlanPart[],
  atoms: PlanAtom[],
  index: Map<string, PlanPart>,
  issueNumber: number,
  held: 'cooldown' | 'capped' | 'unapproved' | undefined,
): Candidate {
  const origin = partOrigin(issueNumber, part.slug);
  const branch = part.branch ?? partBranch(issueNumber, part.slug);
  const base = partBase(part, index, issueNumber, s.defaultBranch);
  const { done, remaining } = siblingContext(parts, part, s.prRefStyle);
  const title = `Issue #${issueNumber} part: ${part.title}`;
  const stacks =
    base === s.defaultBranch
      ? `Part "${part.slug}" of issue #${issueNumber} is ready and has no agent.`
      : `Part "${part.slug}" of issue #${issueNumber} is ready and stacks on ${base}.`;
  const reason =
    held === 'capped'
      ? `${stacks} Held: issue #${issueNumber} is already at its ${s.planning.maxConcurrentPartsPerIssue}-part concurrency cap.`
      : held === 'unapproved'
        ? `${stacks} Held: the plan for issue #${issueNumber} is awaiting your approval — nothing is scheduled until you accept it.`
        : stacks;
  return {
    origin,
    rule: 'plan-part',
    title,
    kind: 'code',
    branch,
    reason,
    held,
    action: {
      type: 'dispatch_code_agent',
      branch,
      base,
      partId: part.id,
      title,
      prompt:
        s.templates.render('plan-part', {
          number: issueNumber,
          title: issue.title,
          part: part.title,
          scope: part.scope,
          branch,
          base,
          plan: plan.reason ?? 'the planner gave no reason',
          done,
          remaining,
        }) +
        partDeclarationNote(part, atoms) +
        budgetNote(s.planning.fileBudget) +
        partOutcomeNote(part) +
        s.watchDeclareNote,
      originRef: origin,
      originTitle: `${issue.title} — ${part.title}`,
      originSummary: part.scope,
      rule: 'plan-part',
      reason,
    } satisfies RawAction,
  };
}
