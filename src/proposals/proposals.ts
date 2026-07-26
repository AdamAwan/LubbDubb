/**
 * The pure half of the human-decision object (issue #109): how an act is named,
 * what a standing verdict means for proposing it again, and how the stored action
 * is read back. No store, no sink — so the gate and the payload reading are
 * testable on their own, and the desk is left with the transition and the effect.
 *
 * ## Why the record exists at all
 *
 * "Something proposes an act; a human accepts or rejects it; the accepted act
 * happens." Before this, the middle step was an `Escalation` whose whole verdict
 * was `response: string` — the harness could know a human *typed something* and
 * nothing more, so an approved merge was approved into thin air and the operator
 * went and merged it by hand. A typed verdict is what lets the accept be wired to
 * the effect, and it is the only thing here that had to be new.
 */

import type { Proposal, ProposalKind } from '../types.js';

/**
 * The subject of a merge proposal. Suffixed rather than a bare `pr:<n>` so it
 * reads as *the act* and not the PR: a PR can be the subject of a merge and of a
 * reply at once, and the gate has to hold them apart.
 */
export function mergeProposalRef(prNumber: number): string {
  return `pr:${prNumber}:merge`;
}

/**
 * The subject of a drafted reply. Threaded replies key on the comment they answer
 * — the same `pr:<n>:comment:<id>` the review-comment dispatch rule uses as its
 * origin — so two drafts on one PR are two proposals, not one that overwrites the
 * other. An untargeted reply has only the PR to name.
 */
export function replyProposalRef(prNumber: number, commentId: string | null): string {
  return commentId ? `pr:${prNumber}:comment:${commentId}` : `pr:${prNumber}:reply`;
}

/**
 * Why a fresh proposal for this act is held by one already made, or null when the
 * act is free to propose. **This is the gate**, and it is the whole reason the
 * verdict is typed: without it the next pulse re-proposes the same merge and the
 * inbox fills with duplicates of one question.
 *
 * It reads the *latest* proposal for the ref — `proposals` is expected in the
 * store's newest-first order — and holds on two of the three statuses:
 *
 * - `pending` — you haven't answered yet. Asking again is the duplicate.
 * - `rejected` — you said no. Re-asking every pulse would make "no" mean
 *   "not this second", which is worse than not asking: the operator cannot make
 *   the question stop except by doing the act by hand. A no is therefore durable
 *   here; phase 4 (#109) turns it into a cooldown that re-asks on new signal.
 * - `accepted` — the act ran, so there is nothing to hold. If it *failed* to run,
 *   re-proposing next pulse is exactly right, and this is what allows it.
 */
export function proposalHold(kind: ProposalKind, ref: string, proposals: Proposal[]): string | null {
  const standing = proposals.find((p) => p.kind === kind && p.ref === ref);
  if (!standing) return null;
  if (standing.status === 'pending') return `awaiting your accept/reject (${standing.id})`;
  if (standing.status === 'rejected')
    return `you rejected it${standing.note ? ` — "${standing.note}"` : ''} (${standing.id})`;
  return null;
}

/** The act a proposal carries, narrowed to what the sink needs to perform it. */
export type ProposedAct =
  | { kind: 'merge'; prNumber: number; method: 'merge' | 'squash' | 'rebase' }
  | { kind: 'reply_draft'; prNumber: number; commentId: string | null; body: string };

/**
 * Read the stored action back into something performable.
 *
 * The action was validated by zod when the dispatcher emitted it, but it has been
 * through JSON and SQLite since, and a row may predate a change to the action
 * vocabulary — so accepting re-checks the few fields the sink is about to be
 * handed rather than trusting the round trip. A malformed payload is reported,
 * never guessed at: half a merge request is not a merge request.
 */
export function readProposedAct(proposal: Proposal): { ok: true; act: ProposedAct } | { ok: false; error: string } {
  const action = proposal.action as Record<string, unknown>;
  const prNumber = action.prNumber;
  if (typeof prNumber !== 'number' || !Number.isInteger(prNumber))
    return { ok: false, error: `proposal ${proposal.id} names no PR number` };

  if (proposal.kind === 'merge') {
    const method = action.method;
    if (method !== 'merge' && method !== 'squash' && method !== 'rebase')
      return { ok: false, error: `proposal ${proposal.id} names an unknown merge method ${JSON.stringify(method)}` };
    return { ok: true, act: { kind: 'merge', prNumber, method } };
  }

  const body = action.draft;
  if (typeof body !== 'string' || body.trim() === '')
    return { ok: false, error: `proposal ${proposal.id} carries no draft to send` };
  const commentId = action.commentId;
  return {
    ok: true,
    act: {
      kind: 'reply_draft',
      prNumber,
      commentId: typeof commentId === 'string' ? commentId : null,
      body,
    },
  };
}
