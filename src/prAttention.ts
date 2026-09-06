import { ciNeedsHuman, classifyCiFailures, classifyWatchedChecks, type CiPolicy } from './ci/ciPolicy.js';
import { dispatchVerdict, type CooldownPolicy } from './dispatcher/dispatchCooldown.js';
import { prCommentsOrigin } from './dispatcher/reviewThreads.js';
import { concernUrgency, type StageRuleId } from './dispatcher/rules.js';
import {
  basePrOf,
  ciNeedsAttention,
  inheritedCiFailure,
  isPrWatched,
  isStackedPr,
  needsBaseUpdate,
  prState,
} from './prHealth.js';
import { isSomeoneElsesPr } from './prOwnership.js';
import { mergeProposalRef, proposalHold } from './proposals/proposals.js';
import { DEFAULT_PR_REVIEW, type PrReviewPolicy } from './review/policy.js';
import {
  needsFleetReview,
  resolvedReviewMode,
  reviewOrigin,
  reviewPendingLabel,
  reviewReading,
  reviewSatisfied,
  reviewTriageOrigin,
  triageRuns,
  triagePendingLabel,
  type PrReviewReading,
} from './review/prReview.js';
import { isActiveTask } from './tasks.js';
import type {
  Decision,
  PrReview,
  PrReviewRoute,
  Proposal,
  PullRequest,
  TaskSummary,
  ViewerAssignment,
  WorldEvent,
} from './types.js';

// → docs/spec/07-pull-requests.md

type PrAttentionKind = 'done' | 'unwatched' | 'you' | 'harness' | 'elsewhere' | 'settled' | 'stalled';

export interface PrAttention {
  status: PrAttentionKind;
  reasons: string[];
  reviewWaitingSince?: string;
  assignedToYou?: ViewerAssignment;
}

export interface PrAttentionContext {
  openPrs: PullRequest[];
  defaultBranch: string;
  watchLabel: string;
  tasks: TaskSummary[];
  proposals: Proposal[];
  rejectionSignals?: WorldEvent[];
  recentDecisions: Decision[];
  cooldown: CooldownPolicy;
  ci: CiPolicy;
  now: string;
  reviewWaits?: ReadonlyMap<number, string>;
  review?: PrReviewPolicy;
  prReviews?: ReadonlyMap<number, PrReview>;
  prReviewedElsewhere?: ReadonlySet<number>;
  prReviewRoutes?: ReadonlyMap<number, PrReviewRoute>;
}

export function prAttentionStatus(pr: PullRequest, ctx: PrAttentionContext): PrAttention {
  const verdict = court(pr, ctx);
  const assigned = pr.viewerAssignment;
  if (assigned === undefined || verdict.status === 'done') return verdict;
  const note = assignmentReason(pr, assigned);
  if (pr.viewerApproved === true) {
    return { ...verdict, reasons: [...verdict.reasons, `${note} — you have approved it`] };
  }
  if (verdict.status === 'unwatched' || verdict.status === 'elsewhere' || verdict.status === 'stalled') {
    const since = verdict.reviewWaitingSince ?? ctx.reviewWaits?.get(pr.number);
    return {
      ...verdict,
      status: 'you',
      reasons: [note, ...verdict.reasons],
      assignedToYou: assigned,
      ...(since === undefined ? {} : { reviewWaitingSince: since }),
    };
  }
  return { ...verdict, reasons: [...verdict.reasons, note] };
}

function assignmentReason(pr: PullRequest, assignment: ViewerAssignment): string {
  const who = pr.author?.trim() ?? '';
  if (assignment === 'assignee') return who === '' ? 'assigned to you' : `${who} assigned this pull request to you`;
  return who === '' ? 'you have been marked as a reviewer' : `${who} marked you as a reviewer`;
}

function court(pr: PullRequest, ctx: PrAttentionContext): PrAttention {
  const state = prState(pr);
  if (state !== 'open') {
    return { status: 'done', reasons: [state === 'merged' ? 'merged' : 'closed without merging'] };
  }

  if (!isPrWatched(pr, ctx.watchLabel)) {
    return { status: 'unwatched', reasons: [`not tagged "${ctx.watchLabel}" — the harness is leaving it alone`] };
  }

  if (isSomeoneElsesPr(pr)) {
    const who = pr.author?.trim();
    return {
      status: 'elsewhere',
      reasons: [`${who ? `${who} opened this` : 'somebody else opened this'} — the harness only works its own`],
    };
  }

  const pending = ctx.proposals.find((p) => p.status === 'pending' && p.ref.startsWith(`pr:${pr.number}:`));
  if (pending) {
    return { status: 'you', reasons: [`awaiting your accept/reject of ${actLabel(pending)} (${pending.id})`] };
  }

  const staffed = ctx.tasks.find((t) => isActiveTask(t) && t.branch === pr.branch);
  if (staffed?.status === 'waiting') {
    return { status: 'you', reasons: ['an agent on this branch is waiting on you'] };
  }
  if (staffed) {
    return {
      status: 'harness',
      reasons: [
        staffed.status === 'running' ? 'an agent is working this branch' : 'an agent is queued for this branch',
      ],
    };
  }

  const ci = ciReading(pr, ctx);

  const concerns = prConcerns(pr, ctx, ci);
  const heldNames = ci.heldByPolicy.join(', ');
  const held = ci.heldByPolicy.length > 0 ? [`${heldNames} failing — held by the CI policy`] : [];
  if (concerns.length > 0) {
    const top = concerns[0]!;
    const others = [...concerns.slice(1).map((c) => c.label), ...held];
    const verdict = dispatchVerdict(top.origin, ctx.now, ctx.recentDecisions, ctx.cooldown);
    if (verdict.kind === 'escalate' || verdict.kind === 'hold') {
      return { status: 'you', reasons: [`${top.label} — the attempt cap is spent, escalated to a human`, ...others] };
    }
    if (verdict.kind === 'cooldown') {
      return { status: 'harness', reasons: [`${top.label} — on cooldown, retrying`, ...others] };
    }
    return { status: 'harness', reasons: [`${top.label} — an agent will be dispatched`, ...others] };
  }

  if (ci.heldByPolicy.length > 0) {
    return {
      status: 'you',
      reasons: [`${heldNames} failing — the CI policy holds it, so no agent will be sent`],
    };
  }

  const mergeReady =
    !isStackedPr(pr, ctx.defaultBranch) &&
    pr.ciStatus === 'passing' &&
    pr.approved === true &&
    pr.mergeable === true &&
    pr.mergeableState !== 'behind' &&
    pr.mergeableState !== 'blocked' &&
    pr.mergeableState !== 'dirty' &&
    pr.unresolvedComments.every((c) => c.handled) &&
    reviewSatisfied(pr, reading(pr, ctx), reviewPolicy(ctx));

  if (mergeReady) {
    const ref = mergeProposalRef(pr.number);
    const held = proposalHold('merge', ref, ctx.proposals, {
      rejectionSignals: ctx.rejectionSignals,
      now: Date.parse(ctx.now),
    });
    const standing = ctx.proposals.find((p) => p.kind === 'merge' && p.ref === ref);
    if (held && standing?.status === 'rejected') {
      return { status: 'settled', reasons: [held, 'nothing has happened to this PR since'] };
    }
    if (held) return { status: 'harness', reasons: [held] };
    return { status: 'harness', reasons: ['merge-ready — the merge gate runs next cycle'] };
  }

  if (isStackedPr(pr, ctx.defaultBranch)) {
    const base = basePrOf(pr, ctx.openPrs);
    const inherited = inheritedCiFailure(pr, ctx.openPrs);
    if (inherited) return { status: 'elsewhere', reasons: [`CI failing on base PR #${inherited.number}`] };
    return {
      status: 'elsewhere',
      reasons: [base ? `stacked on PR #${base.number}, which has to merge first` : `stacked on ${pr.baseBranch}`],
    };
  }
  if (pr.ciStatus === 'pending') return { status: 'elsewhere', reasons: ['CI is still running'] };
  if (pr.approved !== true) {
    const since = ctx.reviewWaits?.get(pr.number);
    return { status: 'elsewhere', reasons: ['waiting on review'], ...(since ? { reviewWaitingSince: since } : {}) };
  }
  if (pr.mergeableState === 'blocked') {
    return { status: 'elsewhere', reasons: ['merge blocked (required checks/reviews)'] };
  }

  const missing: string[] = [];
  if (ci.mutedOnly) {
    missing.push(`${ci.muted.join(', ')} failing but muted by policy — the merge gate still reads CI as failing`);
  } else if (pr.ciStatus !== 'passing') missing.push('CI has not reported');
  if (pr.mergeable !== true) missing.push('the provider reports no mergeable state');
  return {
    status: 'stalled',
    reasons: missing.length > 0 ? missing : ['no agent, no signal and nothing to authorize'],
  };
}

interface PrConcern {
  rule: StageRuleId;
  origin: string;
  label: string;
}

interface CiReading {
  heldByPolicy: string[];
  muted: string[];
  mutedOnly: boolean;
  actionable: boolean;
  watched: string[];
}

function ciReading(pr: PullRequest, ctx: PrAttentionContext): CiReading {
  const none: CiReading = { heldByPolicy: [], muted: [], mutedOnly: false, actionable: false, watched: [] };
  if (inheritedCiFailure(pr, ctx.openPrs) !== null) return none;
  const watched = classifyWatchedChecks(pr.ciChecks, ctx.ci).watched.map((m) => m.name);
  if (!ciNeedsAttention(pr)) return { ...none, watched };
  const verdict = classifyCiFailures(pr.ciChecks, ctx.ci, pr.ciChecksWithheld);
  if (verdict.actionable) return { ...none, watched, actionable: true };
  const muted = verdict.ignored.map((m) => m.name);
  return {
    heldByPolicy: ciNeedsHuman(verdict) ? verdict.escalate.map((m) => m.name) : [],
    muted,
    watched,
    mutedOnly: !ciNeedsHuman(verdict) && muted.length > 0,
    actionable: false,
  };
}

function prConcerns(pr: PullRequest, ctx: PrAttentionContext, ci: CiReading): PrConcern[] {
  const concerns: PrConcern[] = [];
  if (needsFleetReview(pr, reading(pr, ctx), reviewPolicy(ctx))) {
    const route = reading(pr, ctx).route;
    if (route === null && triageRuns(reviewPolicy(ctx))) {
      concerns.push({ rule: 'pr-review-triage', origin: reviewTriageOrigin(pr.number), label: triagePendingLabel() });
    } else {
      concerns.push({
        rule: 'pr-review',
        origin: reviewOrigin(pr.number),
        label: reviewPendingLabel(resolvedReviewMode(route, reviewPolicy(ctx))),
      });
    }
  }
  const unhandled = pr.unresolvedComments.filter((c) => !c.handled);
  if (unhandled.length > 0) {
    const authors = [...new Set(unhandled.map((c) => c.author))];
    concerns.push({
      rule: 'pr-review-comment',
      origin: prCommentsOrigin(pr.number),
      label:
        unhandled.length > 1
          ? `${unhandled.length} unresolved comments from ${authors.join(', ')}`
          : `unresolved comment from ${authors[0]}`,
    });
  }
  if (ci.actionable) {
    concerns.push({ rule: 'pr-ci-failing', origin: `pr:${pr.number}:ci`, label: 'CI is failing' });
  }
  if (ci.watched.length > 0) {
    concerns.push({
      rule: 'pr-ci-gate',
      origin: `pr:${pr.number}:ci-gate`,
      label: `${ci.watched.join(', ')} waiting on an action`,
    });
  }
  if (needsBaseUpdate(pr)) {
    const base = pr.baseBranch ?? ctx.defaultBranch;
    const behind = pr.mergeableState === 'behind';
    concerns.push({
      rule: behind ? 'pr-base-update' : 'pr-base-update-conflict',
      origin: `pr:${pr.number}:mergeable`,
      label: behind ? `behind ${base}` : `conflicts with ${base}`,
    });
  }
  return concerns.sort((a, b) => concernUrgency(a.rule) - concernUrgency(b.rule));
}

function actLabel(proposal: Proposal): string {
  if (proposal.kind === 'merge') return 'the merge';
  if (proposal.kind === 'plan') return 'the plan';
  return 'the drafted reply';
}

function reviewPolicy(ctx: PrAttentionContext): PrReviewPolicy {
  return ctx.review ?? DEFAULT_PR_REVIEW;
}

const NO_REVIEWS: ReadonlyMap<number, PrReview> = new Map();
const NO_ROUTES: ReadonlyMap<number, PrReviewRoute> = new Map();
const NO_EXTERNALS: ReadonlySet<number> = new Set<number>();

function reading(pr: PullRequest, ctx: PrAttentionContext): PrReviewReading {
  return reviewReading(
    {
      prReviews: ctx.prReviews ?? NO_REVIEWS,
      prReviewRoutes: ctx.prReviewRoutes ?? NO_ROUTES,
      prReviewedElsewhere: ctx.prReviewedElsewhere ?? NO_EXTERNALS,
    },
    pr.number,
  );
}
