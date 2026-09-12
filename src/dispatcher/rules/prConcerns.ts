import type { DispatchContext } from '../dispatcher.js';
import { ciNeedsAttention, inheritedCiFailure, isStackedPr, needsBaseUpdate } from '../../pr/prHealth.js';
import type { Agent, Decision, PullRequest } from '../../types.js';
import { askedAlready } from '../admission.js';
import {
  ciFailureNote,
  ciNeedsHuman,
  ciWatchNote,
  classifyCiFailures,
  classifyWatchedChecks,
  type CiVerdict,
  type CiWatchVerdict,
} from '../../ci/ciPolicy.js';
import { mergeProposalRef, proposalHold } from '../../proposals/proposals.js';
import { dispatchVerdict } from '../dispatchCooldown.js';
import { concernUrgency, type DispatchRuleId } from '../rules.js';
import {
  prCommentSignalRef,
  prCommentsOrigin,
  reviewRecheckNote,
  reviewThreadNote,
  reviewThreadsNote,
  replyToolNote,
} from '../reviewThreads.js';
import { priorCiRemediesNote, priorReviewRemediesNote } from '../../remedies/priorRemedies.js';
import { remedyAskNote } from '../../remedies/remedies.js';
import {
  charterNote,
  modeCharterHeading,
  needsFleetReview,
  publishNote,
  resolvedReviewMode,
  reviewBranch,
  reviewOrigin,
  reviewSatisfied,
  reviewTriageOrigin,
  reviewReading,
  triageRuns,
} from '../../review/prReview.js';
import { readOnlyDispatch } from './readOnlyDispatch.js';
import { isActive, type RawAction, type StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (the PR concern pass)

export function prConcerns(s: StageContext): void {
  const { ctx } = s;
  const prCandidates: Array<{ pr: PullRequest; top: PrConcern; urgent: boolean }> = [];
  for (const pr of ctx.world.pullRequests) {
    if (pr.merged) continue;
    if (s.readingBehindFleet(pr.number)) continue;

    const concerns: PrConcern[] = [];
    const unhandled = pr.unresolvedComments.filter((c) => !c.handled);
    const reading = reviewReading(s, pr.number);
    const route = reading.route;
    const mode = resolvedReviewMode(route, s.review);
    const routing = route === null && triageRuns(s.review) && !triageSpent(s, pr.number);
    const reviewComing = needsFleetReview(pr, reading, s.review) && !reviewSpent(s, pr.number);
    if (reviewComing && !routing) {
      const origin = reviewOrigin(pr.number);
      const branch = reviewBranch(pr.number);
      concerns.push({
        rule: 'pr-review',
        origin,
        dispatch: readOnlyDispatch(branch, pr.branch),
        profile: (mode === null ? null : (s.review.modes[mode]?.profile ?? null)) ?? undefined,
        title: mode === null ? `Review PR #${pr.number}` : `Review PR #${pr.number} (${mode})`,
        prompt:
          s.templates.render('pr-review', {
            number: pr.number,
            title: pr.title,
            branch: pr.branch,
            base: pr.baseBranch ?? s.defaultBranch,
          }) +
          publishNote(s.review.publish) +
          charterNote(mode === null ? null : (s.reviewCharters.modes[mode] ?? null), modeCharterHeading(mode)),
        dispatchReason:
          `PR #${pr.number} has not been reviewed by the fleet and no agent is on it` +
          (mode === null ? '.' : ` (${mode}${route === null ? ', by default' : ''}).`),
        note: `PR #${pr.number} has not been reviewed yet — read the diff and report what you find.`,
        originTitle: pr.title,
        originSummary: `PR #${pr.number} on branch ${pr.branch} · awaiting the fleet's review`,
      });
    }
    if (unhandled.length > 0) {
      const authors = [...new Set(unhandled.map((c) => c.author))];
      const many = unhandled.length > 1;
      concerns.push({
        rule: 'pr-review-comment',
        origin: prCommentsOrigin(pr.number),
        title: many
          ? `Address ${unhandled.length} review comments on PR #${pr.number}`
          : `Address review comment on PR #${pr.number}`,
        prompt:
          s.templates.render('pr-review-comment', {
            number: pr.number,
            branch: pr.branch,
            author: authors.join(', '),
            comment: unhandled[0]!.body,
          }) +
          reviewThreadsNote(unhandled) +
          reviewRecheckNote(pr.number) +
          replyToolNote() +
          priorReviewRemediesNote(ctx.priorRemedies ?? []) +
          remedyAskNote('review'),
        dispatchReason: many
          ? `${unhandled.length} unhandled review comments from ${authors.join(', ')} on PR #${pr.number}.`
          : `Unhandled review comment from ${authors[0]} on PR #${pr.number}.`,
        note: `Unhandled review feedback on PR #${pr.number} from ${authors.join(', ')}.`,
        originTitle: pr.title,
        originSummary: many
          ? `${unhandled.length} review threads on PR #${pr.number} from ${authors.join(', ')}`
          : `Review comment from ${authors[0]}: ${unhandled[0]!.body}`,
        signals: unhandled.map((c) => ({
          ref: prCommentSignalRef(pr.number, c),
          note: reviewThreadNote(pr.number, c),
        })),
      });
    }
    const inheritedFailure = inheritedCiFailure(pr, s.openPrs);
    const ciVerdict = classifyCiFailures(pr.ciChecks, s.ci, pr.ciChecksWithheld);
    const ciFailing = ciNeedsAttention(pr) && inheritedFailure === null;
    if (ciFailing && ciVerdict.actionable) {
      const ciOrigin = `pr:${pr.number}:ci`;
      concerns.push({
        rule: 'pr-ci-failing',
        origin: ciOrigin,
        title: `Fix failing CI on PR #${pr.number}`,
        prompt:
          s.templates.render('pr-ci-fix', { number: pr.number, title: pr.title, branch: pr.branch }) +
          ciFailureNote(ciVerdict) +
          priorCiRemediesNote(
            ctx.priorRemedies ?? [],
            ciVerdict.dispatch.map((m) => m.name),
          ) +
          remedyAskNote('ci'),
        dispatchReason: ciDispatchReason(pr.number, ciVerdict),
        note: `CI is now failing on PR #${pr.number} — investigate and push a fix.${ciFailureNote(ciVerdict)}`,
        originTitle: pr.title,
        originSummary: `PR #${pr.number} on branch ${pr.branch} · CI ${pr.ciStatus}${pr.approved ? ' · approved' : ''}`,
        urgent: ciVerdict.urgent,
        ciChecks: ciVerdict.dispatch.map((m) => m.name),
      });
    } else if (ciFailing && ciNeedsHuman(ciVerdict)) {
      const ciOrigin = `pr:${pr.number}:ci`;
      if (!askedAlready(ciOrigin, ctx.openEscalations, ctx.recentDecisions)) {
        const names = ciVerdict.escalate.map((m) => m.name).join(', ');
        s.raw.push({
          type: 'escalate_to_human',
          escalationType: 'resolve_ambiguity',
          prompt:
            `CI is failing on PR #${pr.number} ("${pr.title}") only on checks you told the harness not to act ` +
            `on, so nothing has been dispatched — this needs someone who can reach whoever owns them.`,
          context: {
            originRef: ciOrigin,
            prNumber: pr.number,
            taskTitle: pr.title,
            detail: ciVerdict.escalate.map((m) => `- \`${m.name}\``).join('\n'),
            detailFrom: 'Failing, and configured to be left alone',
          },
          rule: 'pr-ci-blocked',
          reason: `PR #${pr.number} is red only on checks configured to escalate (${names}).`,
        } satisfies RawAction);
      }
    }
    const gateVerdict = classifyWatchedChecks(pr.ciChecks, s.ci);
    if (gateVerdict.watched.length > 0 && inheritedFailure === null) {
      const waiting = gateVerdict.watched.map((m) => m.name).join(', ');
      const gateOrigin = `pr:${pr.number}:ci-gate`;
      const requeues = gateRequeues(gateVerdict);
      const direct = requeues !== null && !directActUnperformed('requeue_ci_check', gateOrigin, ctx.recentDecisions);
      concerns.push({
        rule: 'pr-ci-gate',
        act:
          direct && requeues
            ? ({
                type: 'requeue_ci_check',
                prNumber: pr.number,
                checks: requeues,
                originRef: gateOrigin,
                rule: 'pr-ci-gate',
                reason: `The build policy on PR #${pr.number} is expired (${waiting}); queueing a run through the provider rather than spending an agent on it.`,
              } satisfies RawAction)
            : undefined,
        origin: gateOrigin,
        title: `Clear the waiting check on PR #${pr.number}`,
        prompt:
          s.templates.render('pr-ci-gate', { number: pr.number, title: pr.title, branch: pr.branch }) +
          ciWatchNote(gateVerdict),
        dispatchReason: gateDispatchReason(pr.number, gateVerdict),
        note: `A check on PR #${pr.number} is waiting on an action — ${waiting}.${ciWatchNote(gateVerdict)}`,
        originTitle: pr.title,
        originSummary: `PR #${pr.number} on branch ${pr.branch} · waiting on ${waiting}`,
        urgent: gateVerdict.urgent,
        ciChecks: gateVerdict.watched.map((m) => m.name),
      });
    }
    if (needsBaseUpdate(pr)) {
      const base = pr.baseBranch ?? s.defaultBranch;
      const behind = pr.mergeableState === 'behind';
      const mergeableOrigin = `pr:${pr.number}:mergeable`;
      const direct = behind && !directActUnperformed('update_pr_branch', mergeableOrigin, ctx.recentDecisions);
      concerns.push({
        rule: behind ? 'pr-base-update' : 'pr-base-update-conflict',
        origin: mergeableOrigin,
        act: direct
          ? ({
              type: 'update_pr_branch',
              prNumber: pr.number,
              base,
              branch: pr.branch,
              originRef: mergeableOrigin,
              rule: 'pr-base-update',
              reason: `PR #${pr.number} is behind ${base} with no conflicts; merging ${base} in through the provider rather than spending an agent on it.`,
            } satisfies RawAction)
          : undefined,
        title: behind ? `Update PR #${pr.number} with ${base}` : `Resolve merge conflicts on PR #${pr.number}`,
        prompt: s.templates.render(behind ? 'pr-base-update-behind' : 'pr-base-update-conflict', {
          number: pr.number,
          title: pr.title,
          branch: pr.branch,
          base,
        }),
        dispatchReason: behind
          ? `PR #${pr.number} is behind ${base}, the base could not be merged in directly, and no agent is on it.`
          : `PR #${pr.number} has merge conflicts with ${base} and no agent is on it.`,
        note: behind
          ? `PR #${pr.number} is now behind ${base} — merge ${base} in to bring it up to date, then push.`
          : `The base branch ${base} now conflicts with PR #${pr.number} — merge ${base} in, resolve the conflicts, and push.`,
        originTitle: pr.title,
        originSummary: `PR #${pr.number} on branch ${pr.branch} · ${behind ? `behind ${base}` : `conflicts with ${base}`}`,
      });
    }

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
      if (lease.kind === 'free' && (!reviewComing || top.rule === 'pr-review')) {
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
      escalate,
    );
  }
}

function directActUnperformed(
  type: 'update_pr_branch' | 'requeue_ci_check',
  origin: string,
  decisions: Decision[],
): boolean {
  return decisions.some(
    (d) =>
      d.action.type === type && d.action.originRef === origin && (d.outcome === 'skipped' || d.outcome === 'rejected'),
  );
}

function gateRequeues(verdict: CiWatchVerdict): Array<{ name: string; requeueRef: string }> | null {
  const requeues: Array<{ name: string; requeueRef: string }> = [];
  for (const m of verdict.watched) {
    if (!m.expired || m.rule?.guidance?.trim() || !m.requeueRef) return null;
    requeues.push({ name: m.name, requeueRef: m.requeueRef });
  }
  return requeues.length > 0 ? requeues : null;
}

interface PrConcern {
  rule: DispatchRuleId;
  origin: string;
  act?: RawAction;
  dispatch?: { branch: string; base: string; readOnly: true };
  profile?: string;
  title: string;
  prompt: string;
  dispatchReason: string;
  note: string;
  originTitle: string;
  originSummary: string;
  urgent?: boolean;
  signals?: PrSignal[];
  ciChecks?: string[];
}

interface PrSignal {
  ref: string;
  note: string;
}

function signalsOf(concern: PrConcern): PrSignal[] {
  return concern.signals ?? [{ ref: concern.origin, note: concern.note }];
}

function ciDispatchReason(prNumber: number, verdict: CiVerdict): string {
  const names = verdict.dispatch.map((m) => m.name);
  if (names.length === 0) return `PR #${prNumber} has failing CI and no agent is on it.`;
  return `PR #${prNumber} has failing CI (${names.join(', ')}) and no agent is on it.`;
}

function gateDispatchReason(prNumber: number, verdict: CiWatchVerdict): string {
  const names = verdict.watched.map((m) => m.name).join(', ');
  return `PR #${prNumber} has a check waiting on an action (${names}) and no agent is on it.`;
}

type BranchAgent = { kind: 'running'; agent: Agent } | { kind: 'busy' } | { kind: 'free' };

function resolveBranchAgent(ctx: DispatchContext, branch: string): BranchAgent {
  const task = ctx.tasks.find((t) => isActive(t) && t.branch === branch);
  if (!task) return { kind: 'free' };
  const agent = task.agentId ? ctx.agents.find((a) => a.id === task.agentId) : undefined;
  if (agent && agent.status === 'running') return { kind: 'running', agent };
  return { kind: 'busy' };
}

function triageSpent(s: StageContext, prNumber: number): boolean {
  const verdict = dispatchVerdict(reviewTriageOrigin(prNumber), s.now, s.ctx.recentDecisions, s.cooldown);
  return verdict.kind === 'escalate' || verdict.kind === 'hold';
}

function reviewSpent(s: StageContext, prNumber: number): boolean {
  return dispatchVerdict(reviewOrigin(prNumber), s.now, s.ctx.recentDecisions, s.cooldown).kind === 'hold';
}
