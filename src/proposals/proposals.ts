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
 *
 * ## Why a "no" now expires, and why only on the world (phase 4)
 *
 * Phases 1–3 made a rejection durable *forever*, which is the safe direction and
 * not the right one: the world moves and the verdict doesn't. You refuse a merge
 * because the PR needs one more commit, the commit lands, CI goes green — and the
 * rule is still held off that PR by a verdict about a PR that no longer exists in
 * that state, so the only way to make the harness act is to do it by hand, which
 * is the inert-approval failure #109 opened with, mirrored. So a rejection stands
 * until the *world item it concerns* changes, and then stops standing. See
 * {@link proposalHold} for what counts and why there is deliberately no timer.
 */

import type { Proposal, ProposalKind, WorldEvent } from '../types.js';

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
 * The subject of an amendment to a *running* plan: the amendment itself, not the
 * plan.
 *
 * Keyed on the amendment id rather than the origin for the reason a threaded reply
 * keys on its comment — a plan can be corrected more than once over its life, and a
 * ref shared between two of them would make the second look like the first being
 * re-asked. It is also what keeps this clear of `planProposalRef`: the two are
 * different questions about one plan and both can be live at once on a plan that
 * was replanned while an amendment was pending.
 */
export function planAmendmentProposalRef(amendmentId: string): string {
  return `plan-amendment:${amendmentId}`;
}

/**
 * The world item a proposal is *about*, from the act's ref: `pr:42:merge` and
 * `pr:42:comment:c_7` both concern `pr:42`.
 *
 * This mapping exists because the two records phase 4 joins do not agree on ref
 * shape — a proposal names an act (`pr:42:merge`), a {@link WorldEvent} names an
 * object (`pr:42`) — and it lives here, once, precisely so they cannot drift:
 * {@link expiringSignal} uses it to *match* events and {@link
 * rejectionSignalQuery} uses it to *ask* for them, and those two answering
 * differently is the bug class this repo has already fixed twice. Not exported
 * for the same reason: the query is the only thing a caller outside this file
 * needs, so there is no second place to re-derive the mapping from.
 *
 * It is a narrowing, not a parse: only the three prefixes `worldDiff` actually
 * emits resolve, so a ref in any other vocabulary yields null and is never
 * expired by a signal it can't be matched against.
 */
function proposalWorldRef(ref: string): string | null {
  const [kind, id] = ref.split(':');
  if (kind !== 'pr' && kind !== 'issue') return null;
  return id ? `${kind}:${id}` : null;
}

/**
 * The world transition that ended a rejection's standing, or null while it still
 * stands. **Any** observed transition on the item counts, strictly after the
 * verdict was given.
 *
 * "Any" rather than a per-kind list of interesting events is deliberate. The
 * rules that would re-propose the act re-evaluate on exactly these transitions,
 * so a filter here would be a *second* opinion about which changes matter — and
 * the one that drifts, since it sits nowhere near the rule it is second-guessing.
 * It also cannot be over-eager on its own: expiring a rejection only un-holds the
 * rule, and the rule's own preconditions still decide. A merge is re-proposed
 * only when the PR is green, approved, mergeable and has no unhandled comment, so
 * the very signal that most often lands on a rejected PR — a new review comment —
 * un-holds rule `pr-merge-ready` and then fails its first test.
 */
function expiringSignal(proposal: Proposal, signals: WorldEvent[]): WorldEvent | null {
  const item = proposalWorldRef(proposal.ref);
  const since = proposal.decidedAt;
  if (!item || !since) return null;
  return signals.find((e) => e.ref === item && e.createdAt > since) ?? null;
}

/**
 * Which world events {@link proposalHold} needs to answer "has anything happened
 * since you said no", as a query — the items to look at and how far back.
 *
 * Bounded by *time and item* rather than by row count, which is the whole point.
 * `Store.listProposals` is deliberately unbounded because a rejection that aged
 * out of a window would quietly re-propose a refused act; a count-bounded event
 * read reintroduces that asymmetry from the other side, since a rejection older
 * than the window would be judged against events it cannot see. Asking for
 * exactly "events for these items since the oldest standing rejection" means the
 * case has no answer to get wrong — there is no window for a rejection to fall
 * out of — and the read stays small because it names the handful of items that
 * actually carry one.
 *
 * Null when nothing is standing, which is every deployment until an operator
 * rejects something: no query, no read. Plan proposals are excluded because
 * {@link planProposalHold} never reads a rejected verdict at all (see there).
 */
export function rejectionSignalQuery(proposals: Proposal[]): { since: string; refs: string[] } | null {
  const refs = new Set<string>();
  const seen = new Set<string>();
  let since: string | null = null;
  for (const p of proposals) {
    // Newest-first, so the first row per act is the standing verdict — the same
    // reading `proposalHold`'s `find` takes, and it has to be, or the query would
    // cover a superseded rejection instead of the live one.
    const act = `${p.kind}\u0000${p.ref}`;
    if (seen.has(act)) continue;
    seen.add(act);
    if (p.status !== 'rejected' || p.kind === 'plan' || !p.decidedAt) continue;
    const item = proposalWorldRef(p.ref);
    if (!item) continue;
    refs.add(item);
    if (since === null || p.decidedAt < since) since = p.decidedAt;
  }
  return since !== null && refs.size > 0 ? { since, refs: [...refs] } : null;
}

/** What a hold verdict is judged against: the clock, and the world since each rejection. */
interface HoldContext {
  /** Now, for the accepted settle window. Defaults to wall-clock. */
  now?: number;
  /**
   * World transitions covering at least {@link rejectionSignalQuery}'s window.
   * Absent = nothing observed, so every rejection still stands — the direction
   * that refuses rather than acts, which is the one to take when a caller has not
   * wired the read.
   */
  rejectionSignals?: WorldEvent[];
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
  // The operator's config key (`sendPrRepliesWithoutApproval`) authorizing a class
  // of act in advance — and, on a database old enough, the removed confidence
  // gate. Both were auto-send; the proposal's own note says which.
  if (decidedBy === 'auto_send') return 'auto-send';
  // Still "you" — a stack landing *is* the operator, deciding once for a whole
  // chain instead of once per rung — and distinguished, because "which click" is
  // the thing an audit trail over an act nobody watched has to be able to say.
  if (decidedBy === 'stack_landing') return 'you, landing the stack';
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
 * - `rejected` — you said no, and that stands until the world gives a reason to
 *   ask again (phase 4, below).
 * - `accepted` — the act was authorized and attempted, so it holds for
 *   {@link SETTLE_WINDOW_MS} and then stops.
 *
 * ## The rejection arm expires on signal, and on nothing else (phase 4)
 *
 * Re-asking every pulse would make "no" mean "not this second", which is worse
 * than not asking: the operator cannot make the question stop except by doing the
 * act by hand. That is why phases 1–3 made it durable. But durable *forever* is
 * its own failure — the verdict outlives the state it was a verdict on — so it
 * now ends at the first observed transition on the world item, and only there.
 *
 * **There is deliberately no timer arm.** A time-only expiry re-asks a question
 * the world has not changed its answer to, which is exactly "not this second"
 * under a longer name; if both existed, signal would have to dominate anyway, and
 * a timer that may only ever *delay* an expiry the signal already granted decides
 * nothing. The asymmetry with the accepted arm above is real and intended: an
 * accepted act is waiting on the world to *reflect* something already done, which
 * is a duration; a rejected one is waiting on the world to *become* something
 * else, which is an event. The cost is that a PR nobody touches is never
 * re-proposed — and that is the correct answer, because nothing about it has
 * changed since the operator said no.
 *
 * Expiry governs re-*asking*. It does not retract the verdict: the row stays
 * `rejected`, and {@link rejectionGuidance} still carries the operator's reason
 * to the next agent on that ref, because it remains the last thing said about it.
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
  ctx: HoldContext = {},
): string | null {
  const standing = proposals.find((p) => p.kind === kind && p.ref === ref);
  if (!standing) return null;
  if (standing.status === 'pending') return `awaiting your accept/reject (${standing.id})`;
  if (standing.status === 'rejected') {
    if (expiringSignal(standing, ctx.rejectionSignals ?? [])) return null;
    return `you rejected it${standing.note ? ` — "${standing.note}"` : ''} (${standing.id})`;
  }
  const decidedAt = standing.decidedAt ? Date.parse(standing.decidedAt) : NaN;
  const now = ctx.now ?? Date.now();
  if (Number.isNaN(decidedAt) || now - decidedAt >= SETTLE_WINDOW_MS) return null;
  return `already authorized by ${decidedByLabel(standing.decidedBy)} (${standing.id}); waiting for the world to catch up`;
}

/**
 * Why the act is being put to the operator *again*, when it is being re-asked
 * over a rejection the world has since overtaken — or null for a first ask.
 *
 * A re-ask that says nothing reads as the harness having forgotten, which is the
 * duplicate-question failure in a new form. Naming the refusal and the transition
 * that ended it makes the second question a different question, which is the only
 * thing that justifies asking it.
 */
export function reaskContext(
  kind: ProposalKind,
  ref: string,
  proposals: Proposal[],
  ctx: HoldContext = {},
): string | null {
  const standing = proposals.find((p) => p.kind === kind && p.ref === ref);
  if (!standing || standing.status !== 'rejected') return null;
  const signal = expiringSignal(standing, ctx.rejectionSignals ?? []);
  if (!signal) return null;
  return (
    `You rejected this on ${standing.decidedAt}${standing.note ? ` — "${standing.note}"` : ''}. ` +
    `Since then: ${signal.summary}.`
  );
}

/**
 * The operator's own words about an act they refused for this exact ref, as a
 * block for the next agent working it — or null when there is nothing to pass on.
 *
 * The whole feature is the second half of "a rejection is usable signal": the
 * reason was already captured, rendered into a hold string and written to the
 * audit line, and read by **no agent at all**. Reject a drafted reply with "too
 * defensive — just fix the lint" and the next agent on `pr:<n>:comment:<id>`
 * started from the prompt that produced the draft you refused.
 *
 * Three things it is careful about:
 *
 * - **Exact refs, not the world item.** "What did the human say about this exact
 *   thing" is a lookup, and it stays one: the caller passes the refs its dispatch
 *   actually names — the origin, plus the individual signals folded under it —
 *   and each is matched whole. Widening to the PR would put "not yet, needs one
 *   more commit" — a refusal to *merge* — in front of an agent fixing CI, as
 *   guidance it can neither act on nor tell apart from its own task. A rejected
 *   merge therefore reaches no agent, because the harness's answer to a rejected
 *   merge is not merging, and no agent's job is to hear about it.
 *
 *   Taking a *list* is what keeps that true now the review-comment rule dispatches
 *   one agent per PR rather than one per thread: its origin (`pr:<n>:comments`)
 *   is nobody's proposal ref, while each thread it carries (`pr:<n>:comment:<id>`)
 *   is exactly the ref a refused reply draft was filed under. Matching the origin
 *   alone would have silently stopped every refusal reaching an agent — the
 *   feature's own opening failure, restored by a rename.
 * - **Attributed, and quoted.** The note is free text a human typed, passed
 *   through verbatim; it is framed as *their* words about what was refused,
 *   never as the harness's own instruction, because an agent will act on it.
 * - **Empty means absent.** No note, no block — the prompt is byte-identical to
 *   one with no rejection behind it. There is nothing to say and a placeholder
 *   saying so would only invite the agent to speculate about it.
 */
export function rejectionGuidance(
  refs: ReadonlyArray<string | null | undefined>,
  proposals: Proposal[],
): string | null {
  // By ref alone: the act kinds carve up the ref namespace between them
  // (`:merge`, `:comment:<id>`, `:plan`), so a ref can match at most one kind and
  // the caller does not have to know which.
  const seen = new Set<string>();
  const refused: Array<{ kind: ProposalKind; note: string }> = [];
  for (const ref of refs) {
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    const standing = proposals.find((p) => p.ref === ref);
    if (standing?.status !== 'rejected') continue;
    const note = standing.note?.trim();
    if (note) refused.push({ kind: standing.kind, note });
  }
  if (refused.length === 0) return null;
  // One refusal reads as one sentence; several are one block rather than several,
  // since they were refused about work this single agent is being sent to do.
  const acts = [...new Set(refused.map((r) => refusedAct(r.kind)))].join(' and ');
  const subject = refused.length > 1 ? 'these exact items' : 'this exact item';
  const quoted = refused.map((r) => `"${r.note}"`).join('\n\n');
  return (
    `An operator refused ${acts} the harness proposed for ${subject}, and said why. ` +
    `The following is the operator's own words, quoted verbatim — it is not an instruction from the harness, ` +
    `and it may not be the whole of your task. Take it as what they want done differently:\n\n${quoted}`
  );
}

/** How a refused act reads inside the guidance block's first sentence. */
function refusedAct(kind: ProposalKind): string {
  if (kind === 'merge') return 'a merge';
  if (kind === 'plan') return 'a delivery plan';
  // Unreachable today — a shortfall's ref is nobody's dispatch origin, so the
  // exact-ref match above never selects one — and spelled out anyway, because the
  // day some origin does take that shape is not the day to discover this said
  // "a reply".
  if (kind === 'shortfall') return 'a response to a failed assessment';
  if (kind === 'plan_amendment') return 'a change to the delivery plan';
  return 'a reply';
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
 *
 *   Phase 4's signal expiry is therefore **not** inherited, and could not be: it
 *   ends a hold this predicate never applies. It would also read the wrong thing
 *   if it did — the transitions on `issue:<n>` are its comments and its links,
 *   none of which say anything about whether a decomposition is the right shape,
 *   whereas the plan row that *is* that verdict is rewritten by both settlements.
 *   `test/planApproval.test.ts` asserts the polarity rather than trusting the two
 *   predicates to stay apart.
 * - **`accepted` must not expire.** A released plan stays released for its life;
 *   re-proposing an approved decomposition fifteen minutes later — the settle
 *   window that is right for a merge — would ask the operator to authorize work
 *   its own agents are already doing.
 *
 * Release is therefore *not* asked here at all. Rule `plan-part`'s question is "is this
 * plan released", which is `Plan.status === 'active'`: one one-way transition, no
 * verdict lookup that could disagree with the row it gates.
 */
export function planProposalHold(ref: string, proposals: Proposal[]): string | null {
  const standing = proposals.find((p) => p.kind === 'plan' && p.ref === ref && p.status === 'pending');
  return standing ? `awaiting your accept/reject (${standing.id})` : null;
}

/**
 * Why an amendment must not be put to the operator again — {@link
 * planProposalHold}'s reasoning, one row down and for the same reason: the
 * question is asked once per *amendment*, and both settlements rewrite the
 * `plan_amendments` row the rule reads, so `pending` is the only arm that can
 * carry over.
 *
 * `rejected` holding would be harmless here and is still wrong to add: a declined
 * amendment is settled, so the rule that reads `pending` rows cannot re-ask about
 * it, and a second predicate saying so would be a second answer to a question the
 * row already answers.
 */
export function planAmendmentHold(ref: string, proposals: Proposal[]): string | null {
  const standing = proposals.find((p) => p.kind === 'plan_amendment' && p.ref === ref && p.status === 'pending');
  return standing ? `awaiting your accept/reject (${standing.id})` : null;
}

/**
 * Who authorized an act, in the three forms the rest of the harness needs it —
 * decided **once**, here, because the three are a chain and not three facts.
 *
 * The cycle id is the load-bearing one. `human:<proposal id>` marks a decision
 * made outside the pulse, the way `agent-lifecycle` already does, and the
 * cockpit's Decision log keys its "you · accepted" badge on that prefix. A
 * standing landing settles *inside* a cycle, so its row keeps that cycle's id: it
 * stays grouped with the pulse that produced the action, and — because it does not
 * carry the prefix — it cannot read as something the operator clicked just then.
 * That is the whole reason this is one function and not a string check at each of
 * the three sites.
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
  // Deliberately **not** the `human:` prefix, though a human is behind it. The
  // prefix marks a decision made *outside* the pulse — a click being applied at a
  // route — and this one is applied inside the cycle that formed the action, so
  // it belongs grouped with that pulse. What the
  // operator clicked, and when, is on the proposal's note; the row that says "you
  // clicked something just now" is the one this must not impersonate.
  if (proposal.decidedBy === 'stack_landing') return { cycleId, by, approved: 'Landing the stack authorized' };
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
type ProposedAct =
  | { kind: 'merge'; prNumber: number; method: 'merge' | 'squash' | 'rebase' }
  | {
      kind: 'reply_draft';
      prNumber: number;
      commentId: string | null;
      body: string;
      resolve: boolean;
      /** The dispatch origin that asked for the reply, where an agent did. */
      originRef: string | null;
    }
  | { kind: 'plan'; planId: string; originRef: string }
  | { kind: 'plan_amendment'; amendmentId: string; planId: string; originRef: string }
  | {
      kind: 'shortfall';
      planId: string;
      originRef: string;
      cause: 'plan' | 'part';
      partSlug: string | null;
      summary: string;
    };

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

  // Named before the PR number for the plan arm's reason. The amendment id is the
  // whole of what performing this needs — the document is on the row, so nothing
  // that decides what is written travels through the proposal payload and back.
  if (proposal.kind === 'plan_amendment') {
    const amendmentId = action.amendmentId;
    const planId = action.planId;
    const originRef = action.originRef;
    if (typeof amendmentId !== 'string' || amendmentId === '')
      return { ok: false, error: `proposal ${proposal.id} names no amendment` };
    if (typeof planId !== 'string' || planId === '' || typeof originRef !== 'string' || originRef === '')
      return { ok: false, error: `proposal ${proposal.id} names no plan` };
    return { ok: true, act: { kind: 'plan_amendment', amendmentId, planId, originRef } };
  }

  // Checked before the PR number for the plan arm's reason, and with one extra
  // demand: the arm accepting performs is chosen from `cause`, so a row whose
  // cause did not survive the round trip must be reported rather than defaulted.
  // Guessing here would replan an issue whose split was fine.
  if (proposal.kind === 'shortfall') {
    const planId = action.planId;
    const originRef = action.originRef;
    const summary = action.summary;
    const cause = action.cause;
    if (typeof planId !== 'string' || planId === '' || typeof originRef !== 'string' || originRef === '')
      return { ok: false, error: `proposal ${proposal.id} names no plan` };
    if (cause !== 'plan' && cause !== 'part')
      return { ok: false, error: `proposal ${proposal.id} names an unknown shortfall cause ${JSON.stringify(cause)}` };
    if (typeof summary !== 'string' || summary.trim() === '')
      return { ok: false, error: `proposal ${proposal.id} carries no summary of what fell short` };
    const partSlug = typeof action.partSlug === 'string' && action.partSlug ? action.partSlug : null;
    if (cause === 'part' && partSlug === null)
      return { ok: false, error: `proposal ${proposal.id} says a part fell short but names none` };
    return { ok: true, act: { kind: 'shortfall', planId, originRef, cause, partSlug, summary } };
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
      // Absent on every row written before the flag existed, and absence is
      // "leave the thread as the reviewer left it" — the safe direction, and the
      // behaviour those rows were proposed under.
      resolve: action.resolve === true,
      // Absent on a rule's draft and on every row from before it existed; absence
      // is "nothing to attribute this reply to", which records nothing rather than
      // attributing it to whichever origin happens to fit.
      originRef: typeof action.originRef === 'string' && action.originRef !== '' ? action.originRef : null,
    },
  };
}
