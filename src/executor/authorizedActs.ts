import type { Store } from '../store/store.js';
import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { StackLandingDesk } from '../stacks/landingDesk.js';
import type { ActionSink } from '../sink/actionSink.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { readProposedAct } from '../proposals/proposals.js';
import { applyDeclines, declineDetail, resolveDeclines } from '../validation/planDecline.js';
import { actOnShortfall, releasePlan } from '../plans/planApproval.js';
import { applyPlanAmendment } from '../plans/planAmendment.js';
import { reviewOrigin } from '../review/prReview.js';
import type { CheckDecline, DecisionOutcome, Proposal } from '../types.js';

// → docs/spec/09-execution.md

type ProposedAct = Extract<ReturnType<typeof readProposedAct>, { ok: true }>['act'];

interface SendDeps {
  store: Store;
  sink: ActionSink;
  errors: ErrorRecorder;
  landings: StackLandingDesk;
  escalations: EscalationInbox;
}

export function settleAuthorized(
  store: Store,
  act: Exclude<ProposedAct, { kind: 'merge' | 'reply_draft' }>,
  proposal: Proposal,
  by: string,
  declined: readonly CheckDecline[],
): { outcome: DecisionOutcome; detail: string } {
  const verdict = (outcome: DecisionOutcome, detail: string): { outcome: DecisionOutcome; detail: string } => ({
    outcome,
    detail,
  });
  if (act.kind === 'plan') {
    const settled = releasePlan(store, act.planId, act.originRef);
    return settled.ok
      ? verdict('executed', `Approved the plan: ${settled.detail} — authorized by ${by} (${proposal.id}).`)
      : verdict('skipped', `Nothing to release for ${act.originRef}: ${settled.detail} (${proposal.id}).`);
  }
  if (act.kind === 'validation_plan') {
    const released = store.validation.releaseValidationPlan(act.originRef);
    if (released?.releasedAt == null)
      return verdict('skipped', `Nothing to release for ${act.originRef}: no check set is authored (${proposal.id}).`);
    // Struck after the release and not instead of it: the press releases the set and settles the
    // rows the operator said no to, which is one verdict on one set rather than two.
    const resolution = resolveDeclines(store.validation.listValidationChecks(act.originRef), declined);
    const struck = applyDeclines(store, act.originRef, resolution.resolved);
    return verdict(
      'executed',
      `Released the validation check set for ${act.originRef} — authorized by ${by} (${proposal.id})` +
        `${declineDetail(struck, resolution.unknown)}.`,
    );
  }
  if (act.kind === 'plan_amendment') {
    const settled = applyPlanAmendment(store, act.amendmentId);
    return settled.ok
      ? verdict(
          'executed',
          `Approved the change to the plan: ${settled.detail} — authorized by ${by} (${proposal.id}).`,
        )
      : verdict('skipped', `Nothing to amend for ${act.originRef}: ${settled.detail} (${proposal.id}).`);
  }
  const settled = actOnShortfall(store, act);
  if (settled.ok) store.verdicts.clearShortfall(act.originRef);
  return settled.ok
    ? verdict(
        'executed',
        `Acted on the assessment of ${act.originRef}: ${settled.detail} — authorized by ${by} (${proposal.id}).`,
      )
    : verdict('skipped', `Nothing to act on for ${act.originRef}: ${settled.detail} (${proposal.id}).`);
}

export async function sendAuthorized(
  deps: SendDeps,
  act: Extract<ProposedAct, { kind: 'merge' | 'reply_draft' }>,
  proposal: Proposal,
  { by, approved }: { by: string; approved: string },
): Promise<{ outcome: DecisionOutcome; detail: string }> {
  const because = proposal.note ? ` (${proposal.note})` : '';
  try {
    if (act.kind === 'merge') {
      const res = await deps.sink.mergePr({ prNumber: act.prNumber, method: act.method });
      return {
        outcome: 'executed',
        detail: `Merged PR #${act.prNumber} via ${act.method} — authorized by ${by}${because} (${proposal.id}).${res.ref ? ` ref=${res.ref}` : ''}`,
      };
    }
    const res = await deps.sink.postPrReply({
      prNumber: act.prNumber,
      commentId: act.commentId,
      body: act.body,
    });
    if (act.commentId !== null) {
      deps.store.threadReopens.setPrThreadReopened(act.prNumber, act.commentId, false);
      recordReplySent(deps, act.prNumber, act.commentId, res.commentRef);
    }
    recordReviewPublished(deps, act, res.threadRef);
    const resolution = await resolveAnswered(deps, act);
    return {
      outcome: 'executed',
      detail: `Sent the reply on PR #${act.prNumber} — authorized by ${by}${because} (${proposal.id}).${res.ref ? ` ref=${res.ref}` : ''}${resolution}`,
    };
  } catch (err) {
    return escalateFailedSend(deps, act, approved, (err as Error).message);
  }
}

function escalateFailedSend(
  deps: SendDeps,
  act: Extract<ProposedAct, { kind: 'merge' | 'reply_draft' }>,
  approved: string,
  message: string,
): { outcome: DecisionOutcome; detail: string } {
  if (act.kind === 'merge') deps.landings.stopForFailedMerge(act.prNumber, message);
  const esc =
    act.kind === 'merge'
      ? deps.escalations.create({
          type: 'approve_change',
          prompt: `${approved} merging PR #${act.prNumber}, but the merge failed (${message}); merge it manually or wait for the harness to re-propose it.`,
          context: { prNumber: act.prNumber, method: act.method, autoMergeFailed: true },
        })
      : deps.escalations.create({
          type: 'review_reply',
          prompt: `${approved} this reply, but sending it failed (${message}); send it manually.\n\nDraft reply for PR #${act.prNumber}:\n\n${act.body}`,
          context: { prNumber: act.prNumber, commentId: act.commentId, draft: act.body },
        });
  return {
    outcome: 'rejected',
    detail: `Authorized ${act.kind === 'merge' ? `merge of PR #${act.prNumber}` : `reply on PR #${act.prNumber}`} failed (${message}); escalated so it isn't dropped: ${esc.id}.`,
  };
}

function recordReplySent(deps: SendDeps, prNumber: number, threadId: string, commentRef: string | undefined): void {
  if (commentRef !== undefined && commentRef !== '') {
    deps.store.prReplies.recordPrReplySent(prNumber, threadId, commentRef);
    return;
  }
  deps.errors.record({
    source: 'provider',
    message: `The reply on PR #${prNumber} went out, but the provider returned no comment id for it.`,
    detail:
      `Thread ${threadId} will keep reading as unanswered work and the fleet will answer it again, because ` +
      `attribution is a record of what was sent and there is nothing to record. Identity is deliberately not ` +
      `used as a fallback: the harness posts under the operator's own credential, so it cannot tell its own ` +
      `reply from theirs.`,
  });
}

function recordReviewPublished(
  deps: SendDeps,
  act: { kind: 'reply_draft'; prNumber: number; commentId: string | null; originRef: string | null },
  threadRef: string | undefined,
): void {
  if (act.commentId !== null || threadRef === undefined || threadRef === '') return;
  if (act.originRef !== reviewOrigin(act.prNumber)) return;
  deps.store.prReviews.recordPrReviewPublished(act.prNumber, threadRef);
}

async function resolveAnswered(
  deps: SendDeps,
  act: {
    prNumber: number;
    commentId: string | null;
    resolve: boolean;
  },
): Promise<string> {
  if (!act.resolve || act.commentId === null) return '';
  if (!deps.sink.canResolvePrThread()) return ' The thread was left open: this provider cannot resolve one.';
  try {
    const res = await deps.sink.resolvePrThread({ prNumber: act.prNumber, commentId: act.commentId });
    return res.ok
      ? ` Resolved thread ${act.commentId}.`
      : ` PR #${act.prNumber} carries no thread ${act.commentId}; left it as it was.`;
  } catch (err) {
    const message = (err as Error).message;
    deps.errors.record({
      source: 'provider',
      message: `Sent the reply on PR #${act.prNumber} but could not resolve thread ${act.commentId}: ${message}`,
      detail: 'The thread stays open, so rule pr-review-comment dispatches for it again.',
    });
    return ` The reply went out; resolving thread ${act.commentId} failed (${message}), so it is still open.`;
  }
}
