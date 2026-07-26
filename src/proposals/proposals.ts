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
 *
 * ## Why the machine's verdict is the same record (phase 2)
 *
 * The auto-send gate answered "may this act go out?" from a confidence threshold
 * and an allow-list — the same question a human answers by clicking approve,
 * reached a second way, sharing no representation with the first. So an
 * auto-merged PR left an audit row whose only trace of who authorized it was the
 * prose "(confidence 0.90 ≥ 0.85 threshold)", while a human-approved one was
 * attributable and queryable. Auto-send is now a `decidedBy`, not a parallel
 * system: the harness accepts *its own* proposal when it is confident, so both
 * verdicts settle one kind of row and run through one effect.
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
 * The subject of a plan proposal: the decomposition of one issue. Deliberately
 * the same string as the planning agent's origin (`issue:12:plan`) — it names the
 * same thing, the plan for that issue, and re-using the harness's existing
 * vocabulary is what keeps a ref an operator sees in one surface readable in the
 * others. Proposals key on `(kind, ref)`, so sharing the string with a dispatch
 * origin collides with nothing.
 */
export function planProposalRef(planOriginRef: string): string {
  return `${planOriginRef}:plan`;
}

/**
 * How long an accepted act holds its own ref before it may be proposed again.
 *
 * Deliberately the same span as the dispatcher's `DEFAULT_COOLDOWN`, because it
 * is the same statement — "this was already attempted recently" — and a second
 * unrelated number would only invite the two to drift apart.
 */
const SETTLE_WINDOW_MS = 15 * 60_000;

/** How a decider reads to an operator. Chosen once, so every surface says it the same way. */
function decidedByLabel(decidedBy: Proposal['decidedBy']): string {
  if (decidedBy === 'human') return 'you';
  if (decidedBy === 'auto_send') return 'auto-send';
  return 'an unrecorded decider';
}

/**
 * Why a fresh proposal for this act is held by one already made, or null when the
 * act is free to propose. **This is the gate**, and it is the whole reason the
 * verdict is typed: without it the next pulse re-proposes the same merge and the
 * inbox fills with duplicates of one question.
 *
 * It reads the *latest* proposal for the ref — `proposals` is expected in the
 * store's newest-first order — and holds on all three statuses, for three
 * different lengths of time:
 *
 * - `pending` — nobody has answered yet. Asking again is the duplicate. Durable.
 * - `rejected` — you said no. Re-asking every pulse would make "no" mean
 *   "not this second", which is worse than not asking: the operator cannot make
 *   the question stop except by doing the act by hand. A no is therefore durable
 *   here; phase 4 (#109) turns it into a cooldown that re-asks on new signal.
 * - `accepted` — the act was authorized and attempted, so it holds for
 *   {@link SETTLE_WINDOW_MS} and then stops.
 *
 * That last window is phase 2's doing, and it is the one behaviour change the
 * fold costs. Accepted used to hold *nothing*, which was right when only a human
 * could accept: an accept was a click, so the only thing an un-held ref could
 * cause was a re-proposal of an act whose send had failed — exactly what should
 * happen. Auto-send accepts on the pulse, and a merge that succeeded is still
 * an open PR in the world snapshot until the next fetch, so an un-held ref would
 * write a fresh accepted row *every pulse* until the world caught up. Unbounded
 * rows in a list the gate itself re-reads each pulse is not a cost worth paying
 * for the failure path, so the failure path is served by a bounded window
 * instead: a failed accept is still re-proposed, just not within the window the
 * world needs to reflect a successful one. The operator is not left waiting on
 * it either way — a failed act escalates at the moment it fails.
 */
export function proposalHold(
  kind: ProposalKind,
  ref: string,
  proposals: Proposal[],
  now: number = Date.now(),
): string | null {
  const standing = proposals.find((p) => p.kind === kind && p.ref === ref);
  if (!standing) return null;
  if (standing.status === 'pending') return `awaiting your accept/reject (${standing.id})`;
  if (standing.status === 'rejected')
    return `you rejected it${standing.note ? ` — "${standing.note}"` : ''} (${standing.id})`;
  const decidedAt = standing.decidedAt ? Date.parse(standing.decidedAt) : NaN;
  if (Number.isNaN(decidedAt) || now - decidedAt >= SETTLE_WINDOW_MS) return null;
  return `already authorized by ${decidedByLabel(standing.decidedBy)} (${standing.id}); waiting for the world to catch up`;
}

/**
 * Why a plan's decomposition must not be put to the operator again, or null when
 * it may be. The plan sibling of {@link proposalHold}, and **not** that function,
 * for a reason worth stating rather than discovering:
 *
 * `proposalHold` holds on all three statuses because a merge or a reply is
 * proposed off *world state that persists* — a green PR is still green next
 * pulse, so without a durable "no" the same question refills the inbox every
 * cycle, and without a settle window an act that just went out is re-proposed
 * before the world reflects it. A plan proposal has neither problem: it is made
 * once per **verdict**, and the verdict is a row (`Plan.status`) that accepting
 * and rejecting both rewrite. So the only arm that carries over is `pending`.
 *
 * The other two would be actively wrong here, in opposite directions:
 *
 * - **`rejected` must not hold.** A rejection already moved the plan out of
 *   `awaiting_approval`, so the ask cannot repeat spontaneously — which is what
 *   durability protects against. The only way back is a replan the operator asked
 *   for, and refusing to re-ask *that* would leave the amended plan unapprovable
 *   for good: a "no" to one decomposition silently vetoing every future one.
 * - **`accepted` must not expire.** A released plan stays released for its life;
 *   re-proposing an approved decomposition fifteen minutes later — the settle
 *   window that is right for a merge — would ask the operator to authorize work
 *   its own agents are already doing.
 *
 * Release is therefore *not* asked here at all. Rule 4a's question is "is this
 * plan released", which is `Plan.status === 'active'`: one one-way transition, no
 * verdict lookup that could disagree with the row it gates.
 */
export function planProposalHold(ref: string, proposals: Proposal[]): string | null {
  const standing = proposals.find((p) => p.kind === 'plan' && p.ref === ref && p.status === 'pending');
  return standing ? `awaiting your accept/reject (${standing.id})` : null;
}

/**
 * Who authorized an act, in the three forms the rest of the harness needs it —
 * decided **once**, here, because the three are a chain and not three facts.
 *
 * The cycle id is the load-bearing one. `human:<proposal id>` marks a decision
 * made outside the pulse, the way `agent-lifecycle` already does, and the
 * cockpit's Decision log keys its "you · accepted" badge on that prefix. Auto-send
 * happens *inside* a cycle, so its row keeps that cycle's id: it stays grouped
 * with the pulse that produced the action, and — because it does not carry the
 * prefix — it cannot read as something the operator clicked. That is the whole
 * reason this is one function and not a string check at each of the three sites.
 *
 * `pulseCycleId` is therefore required in substance and optional in form: a human
 * verdict has no pulse to belong to. A decider that somehow reached here
 * unrecorded gets neither the human prefix nor a claim about who acted.
 */
export function authorityOf(proposal: Proposal, pulseCycleId: string | null): Authority {
  const by = decidedByLabel(proposal.decidedBy);
  if (proposal.decidedBy === 'human') return { cycleId: `human:${proposal.id}`, by, approved: 'You approved' };
  const cycleId = pulseCycleId ?? `${proposal.decidedBy ?? 'undecided'}:${proposal.id}`;
  if (proposal.decidedBy === 'auto_send') return { cycleId, by, approved: 'Auto-send authorized' };
  return { cycleId, by, approved: `${by} authorized` };
}

/** The authority behind an act, as the audit log and the escalation prompts render it. */
interface Authority {
  /** The cycle the resulting decision row is grouped under. */
  cycleId: string;
  /** Reads as "…authorized by {by}". */
  by: string;
  /** Sentence-initial: "{approved} merging PR #7, but the merge failed…". */
  approved: string;
}

/**
 * The act a proposal carries, narrowed to what performing it needs.
 *
 * Two of the three are outbound and name a PR. `plan` names neither: accepting it
 * releases a rule — the parts of an approved decomposition become dispatchable —
 * and publishes nothing at all. It is read back here anyway, and performed
 * through the same `ActionExecutor.runAuthorized`, because what matters about
 * that function is not that it talks to the sink but that it is the one
 * place an accepted proposal turns into its effect *and its audit row*. A second
 * route for the one kind with no outbound act would buy nothing and cost the
 * property.
 */
export type ProposedAct =
  | { kind: 'merge'; prNumber: number; method: 'merge' | 'squash' | 'rebase' }
  | { kind: 'reply_draft'; prNumber: number; commentId: string | null; body: string }
  | { kind: 'plan'; planId: string; originRef: string };

/**
 * Read the stored action back into something performable.
 *
 * The action was validated by zod when the dispatcher emitted it, but it has been
 * through JSON and SQLite since, and a row may predate a change to the action
 * vocabulary — so accepting re-checks the few fields the effect is about to be
 * handed rather than trusting the round trip. A malformed payload is reported,
 * never guessed at: half a merge request is not a merge request.
 */
export function readProposedAct(proposal: Proposal): { ok: true; act: ProposedAct } | { ok: false; error: string } {
  const action = proposal.action as Record<string, unknown>;

  // Checked before the PR number, because a plan proposal has none — and reading
  // "names no PR number" off an approved decomposition is exactly the failure a
  // shared-shape reader invites.
  if (proposal.kind === 'plan') {
    const planId = action.planId;
    const originRef = action.originRef;
    if (typeof planId !== 'string' || planId === '' || typeof originRef !== 'string' || originRef === '')
      return { ok: false, error: `proposal ${proposal.id} names no plan` };
    return { ok: true, act: { kind: 'plan', planId, originRef } };
  }

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
