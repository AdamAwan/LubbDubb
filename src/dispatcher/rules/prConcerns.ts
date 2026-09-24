import type { DispatchContext } from '../dispatcher.js';
import { isStackedPr } from '../../pr/prHealth.js';
import { baseFixingCi } from '../../ci/ciPolicy.js';
import type { Agent, PullRequest } from '../../types.js';
import { mergeProposalRef, proposalHold } from '../../proposals/proposals.js';
import { dispatchVerdict } from '../dispatchCooldown.js';
import { concernUrgency } from '../rules.js';
import { reviewReading, reviewSatisfied } from '../../review/prReview.js';
import { isActive, type RawAction, type StageContext } from './context.js';
import { signalsOf, type PrConcern } from './prConcerns/concern.js';
import { reviewConcern } from './prConcerns/review.js';
import { reviewCommentConcern } from './prConcerns/comments.js';
import { ciFailingConcern } from './prConcerns/ci.js';
import { ciGateConcern } from './prConcerns/ciGate.js';
import { baseUpdateConcern } from './prConcerns/baseUpdate.js';

// → docs/spec/05-dispatcher.md (the PR concern pass)

export function prConcerns(s: StageContext): void {
  const { ctx } = s;
  const prCandidates: Array<{ pr: PullRequest; top: PrConcern; urgent: boolean }> = [];
  for (const pr of ctx.world.pullRequests) {
    if (pr.merged) continue;
    if (s.readingBehindFleet(pr.number)) continue;

    const concerns: PrConcern[] = [];
    const reading = reviewReading(s, pr.number);
    const review = reviewConcern(pr, s, reading);
    if (review.concern) concerns.push(review.concern);
    const comment = reviewCommentConcern(pr, s);
    if (comment) concerns.push(comment);
    const inherited = baseFixingCi(pr, s.openPrs, s.ci) !== null;
    const ci = ciFailingConcern(pr, s, inherited);
    if (ci.concern) concerns.push(ci.concern);
    if (ci.escalation) s.raw.push(ci.escalation);
    const gate = ciGateConcern(pr, s, inherited);
    if (gate) concerns.push(gate);
    const baseUpdate = baseUpdateConcern(pr, s);
    if (baseUpdate) concerns.push(baseUpdate);

    if (concerns.length > 0) {
      const branch = resolveBranchAgent(ctx, pr.branch);
      if (branch.kind === 'running') {
        const fresh = concerns
          .filter((c) => !c.dispatch?.readOnly)
          .flatMap((c) =>
            signalsOf(c).filter(
              (sig) =>
                !s.activeOrigins.has(sig.ref) &&
                !s.dispatchedSignals.has(`${pr.branch}::${sig.ref}`) &&
                !s.notified.has(`${branch.agent.id}::${sig.ref}`),
            ),
          );
        if (fresh.length > 0) {
          s.raw.push({
            type: 'respond_to_agent',
            agentId: branch.agent.id,
            response:
              `An update on the branch you're working (PR #${pr.number}):\n` +
              fresh.map((sig) => `- ${sig.note}`).join('\n') +
              (fresh.length > 1
                ? '\n\nRead them together before changing anything — they may resolve or contradict one another.'
                : ''),
            originRefs: fresh.map((sig) => sig.ref),
            rule: null,
            admission: 'branch-notify',
            reason: `New PR signal(s) for a branch already staffed by agent ${branch.agent.id}.`,
          } satisfies RawAction);
        }
      }

      const top = concerns[0]!;
      const lease = resolveBranchAgent(ctx, top.dispatch?.branch ?? pr.branch);
      if (lease.kind === 'free' && (!review.reviewComing || top.rule === 'pr-review')) {
        prCandidates.push({ pr, top, urgent: concerns.some((c) => c.urgent === true) });
      }
    }

    const mergeReady =
      !isStackedPr(pr, s.defaultBranch) &&
      pr.ciStatus === 'passing' &&
      pr.approved === true &&
      pr.mergeable === true &&
      pr.mergeableState !== 'behind' &&
      pr.mergeableState !== 'blocked' &&
      pr.mergeableState !== 'dirty' &&
      pr.unresolvedComments.every((c) => c.handled) &&
      reviewSatisfied(pr, reading, s.review);
    const mergeHeld = proposalHold('merge', mergeProposalRef(pr.number), ctx.proposals ?? [], {
      rejectionSignals: ctx.rejectionSignals,
    });
    if (mergeReady && !mergeHeld) {
      s.raw.push({
        type: 'merge_pr',
        prNumber: pr.number,
        method: 'squash',
        rule: 'pr-merge-ready',
        reason: `PR #${pr.number} is green, approved and mergeable; merge it in.`,
      } satisfies RawAction);
    }
  }

  prCandidates.sort(
    (a, b) =>
      Number(b.urgent) - Number(a.urgent) ||
      concernUrgency(a.top.rule) - concernUrgency(b.top.rule) ||
      a.pr.number - b.pr.number,
  );
  for (const { pr, top } of prCandidates) {
    const escalate = (attempts: number): RawAction => ({
      type: 'escalate_to_human',
      escalationType: 'resolve_ambiguity',
      prompt: s.templates.render('pr-concern-escalation', {
        title: top.title,
        number: pr.number,
        attempts,
      }),
      context: { originRef: top.origin, prNumber: pr.number, taskTitle: top.title },
      rule: top.rule,
      admission: 'cooldown-escalate',
      reason: `Origin ${top.origin} hit the ${s.cooldown.maxAttempts}-attempt cap without clearing — escalating instead of looping.`,
    });
    if (top.act) {
      const verdict = dispatchVerdict(top.origin, s.now, ctx.recentDecisions, s.cooldown);
      if (verdict.kind === 'escalate') s.raw.push(escalate(verdict.attempts));
      else if (verdict.kind === 'dispatch') s.raw.push(top.act);
      continue;
    }
    s.consider(
      {
        origin: top.origin,
        rule: top.rule,
        title: top.title,
        kind: 'code',
        branch: top.dispatch?.branch ?? pr.branch,
        reason: top.dispatchReason,
        action: {
          type: 'dispatch_code_agent',
          ...(top.dispatch ?? { branch: pr.branch }),
          ...(top.profile === undefined ? {} : { profile: top.profile }),
          title: top.title,
          prompt: top.prompt,
          originRef: top.origin,
          originTitle: top.originTitle,
          originSummary: top.originSummary,
          signalRefs: signalsOf(top).map((sig) => sig.ref),
          ciChecks: top.ciChecks,
          rule: top.rule,
          reason: top.dispatchReason,
        } satisfies RawAction,
      },
      { escalate },
    );
  }
}

type BranchAgent = { kind: 'running'; agent: Agent } | { kind: 'busy' } | { kind: 'free' };

function resolveBranchAgent(ctx: DispatchContext, branch: string): BranchAgent {
  const task = ctx.tasks.find((t) => isActive(t) && t.branch === branch);
  if (!task) return { kind: 'free' };
  const agent = task.agentId ? ctx.agents.find((a) => a.id === task.agentId) : undefined;
  if (agent && agent.status === 'running') return { kind: 'running', agent };
  return { kind: 'busy' };
}
