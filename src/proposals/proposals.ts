/**
 * The pure half of the human-decision object: how an act is named, what a standing verdict
 * means for proposing it again, and how the stored action is read back. A verdict is
 * **typed**, which is what lets an accept be wired to the effect rather than ending as free
 * text nothing performs.
 */

import type { Proposal, ProposalKind, WorldEvent } from '../types.js';

/** The subject of a merge proposal. */
export function mergeProposalRef(prNumber: number): string {
  return `pr:${prNumber}:merge`;
}

/** The subject of a drafted reply. */
export function replyProposalRef(prNumber: number, commentId: string | null): string {
  return commentId ? `pr:${prNumber}:comment:${commentId}` : `pr:${prNumber}:reply`;
}

/** The subject of a plan proposal: the decomposition of one issue. */
export function planProposalRef(planOriginRef: string): string {
  return `${planOriginRef}:plan`;
}

/** The subject of an amendment to a *running* plan: the amendment itself, not the plan. */
export function planAmendmentProposalRef(amendmentId: string): string {
  return `plan-amendment:${amendmentId}`;
}

/**
 * The world item a proposal is *about*, from the act's ref: `pr:42:merge` and
 * `pr:42:comment:c_7` both concern `pr:42`. A narrowing, not a parse: a ref in another
 * vocabulary yields null and is never expired.
 */
function proposalWorldRef(ref: string): string | null {
  const [kind, id] = ref.split(':');
  if (kind !== 'pr' && kind !== 'issue') return null;
  return id ? `${kind}:${id}` : null;
}

/** The world transition that ended a rejection's standing, or null while it still stands. */
function expiringSignal(proposal: Proposal, signals: WorldEvent[]): WorldEvent | null {
  const item = proposalWorldRef(proposal.ref);
  const since = proposal.decidedAt;
  if (!item || !since) return null;
  return signals.find((e) => e.ref === item && e.createdAt > since) ?? null;
}

/**
 * Which world events {@link proposalHold} needs to answer "has anything happened since you
 * said no", as a query — the items to look at and how far back. Null when nothing is
 * standing, so there is no read at all.
 */
export function rejectionSignalQuery(proposals: Proposal[]): { since: string; refs: string[] } | null {
  const refs = new Set<string>();
  const seen = new Set<string>();
  let since: string | null = null;
  for (const p of proposals) {
    // Newest-first, so the first row per act is the standing verdict — the same reading
    // `proposalHold`'s `find` takes, or the query would cover a superseded rejection.
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
  /** Now, for the accepted settle window. */
  now?: number;
  /**
   * World transitions covering at least {@link rejectionSignalQuery}'s window. Absent means
   * nothing observed, so every rejection still stands — the direction that refuses.
   */
  rejectionSignals?: WorldEvent[];
}

/** How long an accepted act holds its own ref before it may be proposed again. */
const SETTLE_WINDOW_MS = 15 * 60_000;

/** How a decider reads to an operator. */
function decidedByLabel(decidedBy: Proposal['decidedBy']): string {
  if (decidedBy === 'human') return 'you';
  // The config key authorizing a class of act in advance, and on an old enough database the
  // removed confidence gate. The proposal's own note says which.
  if (decidedBy === 'auto_send') return 'auto-send';
  // Still "you" — a landing is the operator deciding once for a whole chain — but
  // distinguished, because an audit trail has to be able to say which click.
  if (decidedBy === 'stack_landing') return 'you, landing the stack';
  return 'an unrecorded decider';
}

/**
 * Why a fresh proposal for this act is held by one already made, or null when the act is
 * free to propose. **This is the gate**: without it the next pulse re-proposes the same act
 * and the inbox fills with duplicates. The rejection arm expires on signal and on nothing
 * else — there is deliberately no timer.
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
 * Why the act is being put to the operator *again*, over a rejection the world has since
 * overtaken — or null for a first ask.
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
 * The operator's own words about an act they refused for this exact ref, as a block for the
 * next agent working it — or null when there is nothing to pass on. - **Empty means
 * absent**: no note, no block, and no placeholder to speculate about.
 */
export function rejectionGuidance(
  refs: ReadonlyArray<string | null | undefined>,
  proposals: Proposal[],
): string | null {
  // By ref alone: the act kinds carve up the ref namespace, so a ref matches at most one
  // kind and the caller need not know which.
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
  // Several refusals are one block: they were all about work this one agent is sent to do.
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
  // Unreachable today (a shortfall's ref is nobody's dispatch origin) and spelled out
  // anyway, so the day one takes that shape this does not say "a reply".
  if (kind === 'shortfall') return 'a response to a failed assessment';
  if (kind === 'plan_amendment') return 'a change to the delivery plan';
  return 'a reply';
}

/**
 * Why a plan's decomposition must not be put to the operator again, or null when it may be.
 * Deliberately not {@link proposalHold}: `rejected` must not hold (it would let one "no" veto
 * every future decomposition) and `accepted` must not expire (a released plan stays released).
 */
export function planProposalHold(ref: string, proposals: Proposal[]): string | null {
  const standing = proposals.find((p) => p.kind === 'plan' && p.ref === ref && p.status === 'pending');
  return standing ? `awaiting your accept/reject (${standing.id})` : null;
}

/**
 * Why an amendment must not be put to the operator again — {@link planProposalHold}'s
 * reasoning one row down: the question is asked once per amendment, and both settlements
 * rewrite the `plan_amendments` row the rule reads, so `pending` is the only arm that
 * carries over.
 */
export function planAmendmentHold(ref: string, proposals: Proposal[]): string | null {
  const standing = proposals.find((p) => p.kind === 'plan_amendment' && p.ref === ref && p.status === 'pending');
  return standing ? `awaiting your accept/reject (${standing.id})` : null;
}

/**
 * Who authorized an act, in the three forms the rest of the harness needs it — decided
 * once, here, because the three are a chain.
 */
export function authorityOf(proposal: Proposal, pulseCycleId: string | null): Authority {
  const by = decidedByLabel(proposal.decidedBy);
  if (proposal.decidedBy === 'human') return { cycleId: `human:${proposal.id}`, by, approved: 'You approved' };
  const cycleId = pulseCycleId ?? `${proposal.decidedBy ?? 'undecided'}:${proposal.id}`;
  if (proposal.decidedBy === 'auto_send') return { cycleId, by, approved: 'Auto-send authorized' };
  // Deliberately not the `human:` prefix though a human is behind it: the prefix marks a
  // decision applied outside the pulse, and this one is applied inside the cycle that formed
  // the action. What was clicked, and when, is on the proposal's note.
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

/** The act a proposal carries, narrowed to what performing it needs. */
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
 * Read the stored action back into something performable. A malformed payload is reported,
 * never guessed at.
 */
export function readProposedAct(proposal: Proposal): { ok: true; act: ProposedAct } | { ok: false; error: string } {
  const action = proposal.action as Record<string, unknown>;

  // Before the PR number, because a plan proposal has none.
  if (proposal.kind === 'plan') {
    const planId = action.planId;
    const originRef = action.originRef;
    if (typeof planId !== 'string' || planId === '' || typeof originRef !== 'string' || originRef === '')
      return { ok: false, error: `proposal ${proposal.id} names no plan` };
    return { ok: true, act: { kind: 'plan', planId, originRef } };
  }

  // Before the PR number, for the plan arm's reason. The amendment id is all performing this
  // needs: the document is on the row, never in the payload.
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

  // Before the PR number, for the plan arm's reason, plus one demand: the arm is chosen from
  // `cause`, so a cause that did not survive the round trip is reported, never defaulted —
  // guessing would replan an issue whose split was fine.
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
      // Absent on rows from before the flag: absence means "leave the thread as the
      // reviewer left it", the behaviour those rows were proposed under.
      resolve: action.resolve === true,
      // Absent on a rule's draft and on older rows: nothing to attribute this reply to, so
      // nothing is recorded rather than guessed.
      originRef: typeof action.originRef === 'string' && action.originRef !== '' ? action.originRef : null,
    },
  };
}
