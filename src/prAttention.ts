/**
 * Whose turn is it on this pull request? A verdict *beside* `prHealth`, not a
 * richer version of it — that one answers *can this merge*.
 * → `docs/spec/07-pull-requests.md`
 *
 * `PrComment.author` is never branched on: `handled` decides, whoever wrote it.
 *
 * Nothing in the dispatcher reads this — it is a lens over gates that already
 * fire on their own. `test/prAttention.test.ts` asserts that rather than
 * trusting the import graph.
 */

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

/**
 * Whose court the PR is in. Seven arms, and each names a *different party* rather
 * than a different flavour of stuck — that split is the whole verdict.
 */
type PrAttentionKind =
  | 'done' // merged or closed — off the board, nobody's turn
  | 'unwatched' // nobody opted it in: nobody's turn, by the absence of your tag
  | 'you' // your court — a verdict is owed, or an agent parked on you
  | 'harness' // the harness's court — staffed, or about to be
  | 'elsewhere' // outside the loop — a reviewer, a CI run, the PR below it
  | 'settled' // you answered; nothing is owed until the world moves
  | 'stalled'; // nobody's court, and *that* is the thing to look at

export interface PrAttention {
  status: PrAttentionKind;
  /** Human-readable, most actionable first. Never empty — every arm says why. */
  reasons: string[];
  /**
   * How long this pull request has been sitting on a reviewer (ISO instant it
   * started), on `waiting on review` and any court an assignment took over.
   * Does not by itself make the PR your court — `waiting on review` stays
   * `elsewhere` on a PR the operator merely opened.
   * → `docs/spec/07-pull-requests.md#how-long-it-has-been-waiting-on-a-reviewer`
   */
  reviewWaitingSince?: string;
  /**
   * Set when this pull request is your court because a person put it on you.
   * Its own field, not a leading reason, since the queue keys on it
   * (`buildNeedsYou`). Absent when an agent is also on it.
   */
  assignedToYou?: ViewerAssignment;
}

/** Everything the contextual arms need. Pure over this plus the PR. */
export interface PrAttentionContext {
  /**
   * Every open PR the world knows about, **unfiltered** — the dispatch world plus
   * `ctx.hiddenPrs`, same list `inheritedCiFailure`/`basePrOf` take: an unwatched
   * base still attributes, so a stacked PR waiting on it reads correctly.
   */
  openPrs: PullRequest[];
  /** The integration branch, for {@link isStackedPr}. */
  defaultBranch: string;
  /** The `${labelPrefix}-watch` tag. Empty = the gate is off, everything is watched. */
  watchLabel: string;
  /** Live and finished tasks; the branch's active one is what staffs a PR. */
  tasks: TaskSummary[];
  /** Acts put to a human, newest-first — the store's order, which `proposalHold` assumes. */
  proposals: Proposal[];
  /**
   * World transitions since the oldest standing rejection. Absent = nothing
   * observed, so every rejection still stands — fail-closed, like `proposalHold`.
   */
  rejectionSignals?: WorldEvent[];
  /** The recent audit window, for the attempt cap. */
  recentDecisions: Decision[];
  cooldown: CooldownPolicy;
  /** The per-check CI policy — same `config.ci` the dispatcher holds, so this
   * verdict names the court rule `pr-ci-failing` will act in. */
  ci: CiPolicy;
  /** "Now" — the world snapshot's `takenAt`, as everywhere else. */
  now: string;
  /**
   * PR number → when it started waiting on a reviewer. Absent costs an age,
   * never a verdict — every arm answers the same with or without it.
   */
  reviewWaits?: ReadonlyMap<number, string>;
  /**
   * The fleet review's policy and what it has already read. No policy means the
   * feature is off; an absent map with the policy on reads every PR unreviewed,
   * matching the rule.
   */
  review?: PrReviewPolicy;
  prReviews?: ReadonlyMap<number, PrReview>;
  /** Pull requests an external check reported already reviewed. Absent reads as none. */
  prReviewedElsewhere?: ReadonlySet<number>;
  /** How the triage routed each pull request; absent reads as the fail-open default. */
  prReviewRoutes?: ReadonlyMap<number, PrReviewRoute>;
}

/**
 * Fold every gate that decides what happens to a PR into one per-PR verdict about
 * *whose turn it is*. Checked in the order the world resolves them, so the first
 * arm that matches is the honest answer and the ones below it are moot.
 */
export function prAttentionStatus(pr: PullRequest, ctx: PrAttentionContext): PrAttention {
  const verdict = court(pr, ctx);
  const assigned = pr.viewerAssignment;
  if (assigned === undefined || verdict.status === 'done') return verdict;
  const note = assignmentReason(pr, assigned);
  // You have answered, so the assignment drops from *the court* to *a reason*:
  // `assignedToYou` stays unset, taking it off the rail.
  if (pr.viewerApproved === true) {
    return { ...verdict, reasons: [...verdict.reasons, `${note} — you have approved it`] };
  }
  // The three arms where nothing in the harness is coming — the assignment is
  // the whole answer to whose turn it is, and it leads.
  if (verdict.status === 'unwatched' || verdict.status === 'elsewhere' || verdict.status === 'stalled') {
    // Absent draws no age — a reviewer cannot be late for work that isn't ready.
    const since = verdict.reviewWaitingSince ?? ctx.reviewWaits?.get(pr.number);
    return {
      ...verdict,
      status: 'you',
      reasons: [note, ...verdict.reasons],
      assignedToYou: assigned,
      ...(since === undefined ? {} : { reviewWaitingSince: since }),
    };
  }
  // Every other arm already has the right court — the assignment rides along
  // as the last reason, with `assignedToYou` unset so the queue raises no row.
  return { ...verdict, reasons: [...verdict.reasons, note] };
}

/**
 * How an assignment reads on the row. Which *kind* of reviewer is deliberately
 * not in the sentence — that is `assignedToYou`. An author the provider did not
 * report drops out rather than being invented.
 */
function assignmentReason(pr: PullRequest, assignment: ViewerAssignment): string {
  const who = pr.author?.trim() ?? '';
  if (assignment === 'assignee') return who === '' ? 'assigned to you' : `${who} assigned this pull request to you`;
  return who === '' ? 'you have been marked as a reviewer' : `${who} marked you as a reviewer`;
}

/**
 * The court, before the assignment is folded in — every arm below is about a
 * rule, proposal or agent. Split out so {@link prAttentionStatus} decides where
 * an assignment overrides a court in one place rather than eight arms.
 */
function court(pr: PullRequest, ctx: PrAttentionContext): PrAttention {
  // Off the board. `prState` never invents `closed` — an abandoned PR has to
  // have been observed as one.
  const state = prState(pr);
  if (state !== 'open') {
    return { status: 'done', reasons: [state === 'merged' ? 'merged' : 'closed without merging'] };
  }

  // Unwatched is a status, not an absence, and comes first because
  // `Harness.runCycle` filters these out of the dispatch world entirely.
  if (!isPrWatched(pr, ctx.watchLabel)) {
    return { status: 'unwatched', reasons: [`not tagged "${ctx.watchLabel}" — the harness is leaving it alone`] };
  }

  // Somebody else opened it, so no rule will fire however it is tagged.
  // `elsewhere`, not its own status — an assignment turns it back to `you` above.
  if (isSomeoneElsesPr(pr)) {
    const who = pr.author?.trim();
    return {
      status: 'elsewhere',
      reasons: [`${who ? `${who} opened this` : 'somebody else opened this'} — the harness only works its own`],
    };
  }

  // A pending proposal is the one unambiguous "your court" — the id is quoted
  // so the two surfaces stay joinable as one fact.
  const pending = ctx.proposals.find((p) => p.status === 'pending' && p.ref.startsWith(`pr:${pr.number}:`));
  if (pending) {
    return { status: 'you', reasons: [`awaiting your accept/reject of ${actLabel(pending)} (${pending.id})`] };
  }

  // The branch's agent. A *waiting* one is parked on a human — your court.
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

  // What the CI policy makes of the failing checks, named once so this matches
  // the court rule `pr-ci-failing` will act in.
  const ci = ciReading(pr, ctx);

  // The concerns the PR rules build, in urgency order. Re-derived rather than
  // shared because the rules build prompt-bearing concerns and this needs only
  // labels; 07-pull-requests.md states the order once for both.
  const concerns = prConcerns(pr, ctx, ci);
  // A failure the policy holds is a *reason*, not an arm of its own, when there
  // is a concern under it.
  const heldNames = ci.heldByPolicy.join(', ');
  const held = ci.heldByPolicy.length > 0 ? [`${heldNames} failing — held by the CI policy`] : [];
  if (concerns.length > 0) {
    const top = concerns[0]!;
    const others = [...concerns.slice(1).map((c) => c.label), ...held];
    const verdict = dispatchVerdict(top.origin, ctx.now, ctx.recentDecisions, ctx.cooldown);
    if (verdict.kind === 'escalate' || verdict.kind === 'hold') {
      // The attempt cap: rule `cooldown-escalate` hands the concern to a human.
      return { status: 'you', reasons: [`${top.label} — the attempt cap is spent, escalated to a human`, ...others] };
    }
    if (verdict.kind === 'cooldown') {
      return { status: 'harness', reasons: [`${top.label} — on cooldown, retrying`, ...others] };
    }
    return { status: 'harness', reasons: [`${top.label} — an agent will be dispatched`, ...others] };
  }

  // Nothing else outstanding, so the held check is the whole story and the
  // unqualified sentence is true again.
  if (ci.heldByPolicy.length > 0) {
    return {
      status: 'you',
      reasons: [`${heldNames} failing — the CI policy holds it, so no agent will be sent`],
    };
  }

  // Merge-readiness, exactly as rule `pr-merge-ready` tests it. Reproduced
  // rather than imported; 05-dispatcher.md states the list.
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
    // Ask the gate, not the row — `proposalHold` is where a rejection stops
    // standing once the world moves.
    const ref = mergeProposalRef(pr.number);
    const held = proposalHold('merge', ref, ctx.proposals, {
      rejectionSignals: ctx.rejectionSignals,
      now: Date.parse(ctx.now),
    });
    const standing = ctx.proposals.find((p) => p.kind === 'merge' && p.ref === ref);
    if (held && standing?.status === 'rejected') {
      // Nobody's turn, by design — you answered and the harness is correctly quiet.
      return { status: 'settled', reasons: [held, 'nothing has happened to this PR since'] };
    }
    if (held) return { status: 'harness', reasons: [held] };
    return { status: 'harness', reasons: ['merge-ready — the merge gate runs next cycle'] };
  }

  // Nothing is owed to you and nothing is the harness's to do. Something outside
  // the loop is holding it, or nothing is — those two must not read the same,
  // which is why `stalled` is an arm.
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

  // Green, approved, unstaffed, unproposed and still not mergeable — nothing
  // will act and nobody has been asked. Name what is missing.
  const missing: string[] = [];
  if (ci.mutedOnly) {
    // Every failing check is muted, so neither CI rule fires — yet `ciStatus`
    // still reads failing, so nothing will ever move this PR.
    missing.push(`${ci.muted.join(', ')} failing but muted by policy — the merge gate still reads CI as failing`);
  } else if (pr.ciStatus !== 'passing') missing.push('CI has not reported');
  if (pr.mergeable !== true) missing.push('the provider reports no mergeable state');
  return {
    status: 'stalled',
    reasons: missing.length > 0 ? missing : ['no agent, no signal and nothing to authorize'],
  };
}

/** One thing about a PR that would, on its own, warrant a code agent. */
interface PrConcern {
  /**
   * The pipeline rule that would raise this concern — {@link concernUrgency}
   * ranks it off `DISPATCH_PIPELINE` rather than push order below (#562).
   */
  rule: StageRuleId;
  /**
   * The dispatch origin the PR rules use — the cooldown key. Must be a ref the
   * dispatcher actually writes decisions under, or it finds zero attempts forever.
   */
  origin: string;
  label: string;
}

/**
 * What the per-check CI policy makes of this PR — rule `pr-ci-failing`'s own
 * reading, made once, used by three arms: a dispatched check is the harness's,
 * an escalated one is yours, a muted one is nobody's while still holding the
 * merge test shut. An inherited failure reads as no failure at all, so a
 * stacked PR is never handed to you for its parent's red build.
 */
interface CiReading {
  /** Failing checks the policy hands to a human — rule `pr-ci-blocked`'s set. */
  heldByPolicy: string[];
  /** Failing checks the operator muted, when *every* failure is one. */
  muted: string[];
  /** True when the whole failure is muted, so nothing will act and nothing is owed. */
  mutedOnly: boolean;
  /** Whether rule `pr-ci-failing` would dispatch. */
  actionable: boolean;
  /**
   * Checks a `ci.checks` rule watches in a non-failing state and would dispatch
   * for — rule `pr-ci-gate`'s set. Read regardless of failure: a waiting gate can
   * sit on a PR that is *not* red.
   */
  watched: string[];
}

function ciReading(pr: PullRequest, ctx: PrAttentionContext): CiReading {
  const none: CiReading = { heldByPolicy: [], muted: [], mutedOnly: false, actionable: false, watched: [] };
  // An inherited failure is nobody's business here — the fix belongs to the PR
  // underneath, named by the `elsewhere` arm.
  if (inheritedCiFailure(pr, ctx.openPrs) !== null) return none;
  const watched = classifyWatchedChecks(pr.ciChecks, ctx.ci).watched.map((m) => m.name);
  // The same predicate rule `pr-ci-failing` rides — a lens saying nobody's turn
  // while an agent goes out is the drift this file exists to avoid.
  if (!ciNeedsAttention(pr)) return { ...none, watched };
  const verdict = classifyCiFailures(pr.ciChecks, ctx.ci, pr.ciChecksWithheld);
  if (verdict.actionable) return { ...none, watched, actionable: true };
  const muted = verdict.ignored.map((m) => m.name);
  return {
    heldByPolicy: ciNeedsHuman(verdict) ? verdict.escalate.map((m) => m.name) : [],
    muted,
    watched,
    // Guarded non-empty: a policy could classify a failure into no bucket.
    mutedOnly: !ciNeedsHuman(verdict) && muted.length > 0,
    actionable: false,
  };
}

/**
 * The concerns the five PR-concern rules would raise for this PR, most urgent
 * first. Same predicates and origins as the dispatcher; order comes from
 * {@link concernUrgency}. Labels are operator-facing only.
 */
function prConcerns(pr: PullRequest, ctx: PrAttentionContext, ci: CiReading): PrConcern[] {
  const concerns: PrConcern[] = [];
  // Rule `pr-review`'s own predicate — imported, not restated, so row and
  // dispatch cannot disagree.
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
  // One concern for the whole review, never one per thread — the per-thread
  // ref is notify de-dup's key, and nothing dispatches it.
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
  // Gated on the policy verdict, not `ciStatus` alone — inherited failures are
  // excluded inside `ciReading`.
  if (ci.actionable) {
    concerns.push({ rule: 'pr-ci-failing', origin: `pr:${pr.number}:ci`, label: 'CI is failing' });
  }
  // Own origin — quoting the CI origin would report the wrong attempt cap.
  if (ci.watched.length > 0) {
    concerns.push({
      rule: 'pr-ci-gate',
      origin: `pr:${pr.number}:ci-gate`,
      label: `${ci.watched.join(', ')} waiting on an action`,
    });
  }
  if (needsBaseUpdate(pr)) {
    const base = pr.baseBranch ?? ctx.defaultBranch;
    // Split like the rule's id — separately priced in `agentModels.byRule`.
    const behind = pr.mergeableState === 'behind';
    concerns.push({
      rule: behind ? 'pr-base-update' : 'pr-base-update-conflict',
      origin: `pr:${pr.number}:mergeable`,
      label: behind ? `behind ${base}` : `conflicts with ${base}`,
    });
  }
  // Asked for rather than reproduced — statement order drifts silently on reorder.
  return concerns.sort((a, b) => concernUrgency(a.rule) - concernUrgency(b.rule));
}

/** How a proposed act reads inside "awaiting your accept/reject of …". */
function actLabel(proposal: Proposal): string {
  if (proposal.kind === 'merge') return 'the merge';
  if (proposal.kind === 'plan') return 'the plan';
  return 'the drafted reply';
}

/** The policy, or the defaults — which have the review off, so an unwired caller reads as a build without it. */
function reviewPolicy(ctx: PrAttentionContext): PrReviewPolicy {
  return ctx.review ?? DEFAULT_PR_REVIEW;
}

/** What the fleet recorded about this pull request, or null — never "unknown means fine". */
const NO_REVIEWS: ReadonlyMap<number, PrReview> = new Map();
const NO_ROUTES: ReadonlyMap<number, PrReviewRoute> = new Map();
const NO_EXTERNALS: ReadonlySet<number> = new Set<number>();

/**
 * The same reading the two rules build, through the same helper, so a row and a
 * dispatch cannot disagree. Every absence reads as "no row", matching the dispatcher.
 */
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
