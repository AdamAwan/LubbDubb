import type { PullRequest } from '../../types.js';
import { scannersFor, type Scanner } from './scanners.js';
import type { StatusTone } from './vocabulary.js';

/**
 * Open pull requests as parts on an inspection rack.
 *
 * This replaces `silo.ts`, and the rename is the point rather than tidying. A
 * launch is a *goal closing* — that is what `iconForStage` spends the rocket on —
 * so a pull request drawn as a silo topped with a rocket said the merge was the
 * ending. It is not: a merge loads one part into the silo, and the rocket goes up
 * when the recipe is full. The game already had the slot, so nothing here is
 * invented.
 *
 * What the towers could not do, and this exists for: a pull request is the thing on
 * the floor most often waiting on *you*, and eight of them at 184px each is a
 * column you scroll rather than a set you read.
 */

/** A gate a *human* moves. Machines report checks; these three are not checks. */
export interface MergeGate {
  label: string;
  met: boolean;
}

/**
 * The three fixed gates, and they are three rather than four for a reason worth
 * keeping: `siloGates`' fixed four existed because `health.reasons` is prose — a
 * numerator with no denominator, so "2 reasons" fills nothing. That argument holds
 * for these three and *fails* for CI, because `ciVerdict` is an enumerable list of
 * named checks with states. So CI left the fixed set and became the scanner group,
 * and what remains is exactly the gates with no enumerable detail behind them.
 *
 * They stay a fixed three so every row's right-hand cells sit at the same x and the
 * strip can be read downward.
 */
export function mergeGates(pr: PullRequest): MergeGate[] {
  const unresolved = pr.unresolvedComments.filter((c) => !c.handled).length;
  const behind = pr.mergeableState === 'behind' || pr.mergeableState === 'dirty';
  return [
    { label: 'Approved', met: pr.approved === true },
    {
      // Named for the state it is *in*, not the state it would be in if met: an
      // unmet gate reading "1 comment resolved" beside a cross says the opposite
      // of what is true.
      label: unresolved === 0 ? 'Comments resolved' : `${unresolved} unresolved comment${unresolved === 1 ? '' : 's'}`,
      met: unresolved === 0,
    },
    { label: 'No conflicts with base', met: pr.mergeable !== false && !behind },
  ];
}

/**
 * One row's ladder: the checks the policy named, then the gates a human moves.
 *
 * The scanners come from the shared `scannersFor` — the same fold the Goal Floor's
 * pull-request machine draws — with review left out, because review has its own
 * fixed gate here and drawing it twice on one row would be two marks for one fact.
 */
export function ladderFor(pr: PullRequest): { scanners: Scanner[]; gates: MergeGate[] } {
  return { scanners: scannersFor(pr, { withReview: false }), gates: mergeGates(pr) };
}

/**
 * Whose turn it is, in one chip.
 *
 * Read off `attention.status` — the server's own answer to *whose court* — and
 * never re-derived here, because a second opinion computed client-side is the
 * drift `prAttention.ts` was split out to prevent. Absent (an older snapshot),
 * it falls back to the health verdict, which answers a different question but
 * answers it correctly.
 */
export function prCourt(pr: PullRequest): { label: string; tone: StatusTone } {
  switch (pr.attention?.status) {
    case 'you':
      // `next`, not `bad`: red is the fault colour everywhere else on the floor, and
      // "the harness is asking you a question" is not a fault. The row's stripe reads
      // `rackGroup`, so this no longer decides severity — see `Row`.
      return { label: 'Your call', tone: 'next' };
    case 'harness':
      return { label: 'Harness working it', tone: 'ok' };
    case 'elsewhere':
      return { label: 'Waiting elsewhere', tone: 'idle' };
    case 'settled':
      return { label: 'Settled — you said no', tone: 'off' };
    case 'stalled':
      return { label: 'Stalled', tone: 'warn' };
    case 'ignored':
      return { label: 'Ignored', tone: 'off' };
    case 'done':
      return { label: 'Done', tone: 'ok' };
    default:
      return pr.health?.blocked ? { label: 'Blocked', tone: 'warn' } : { label: 'Ready to load', tone: 'ok' };
  }
}

/** The two groups the strip draws, in the order it draws them. */
type RackGroup = 'yours' | 'in_hand';

/**
 * Which group a PR sits in.
 *
 * `you` and `stalled` are yours; everything else is in hand. **A merge-ready PR
 * needs no arm of its own** — it is already `you`, because the merge proposal is
 * pending on it and that is `prAttentionStatus`'s first arm. So "ready sits with
 * the things waiting on you" is the server's existing verdict rather than a rule
 * invented here, and under `autoSend` the same PR reads `harness` and drops into
 * *in hand*, which is the honest difference: nobody is waiting on you for it.
 *
 * `stalled` is yours because it means nobody's court — and a thing no rule will
 * ever pick up is only ever going to move because you looked at it.
 */
export function rackGroup(pr: PullRequest): RackGroup {
  const status = pr.attention?.status;
  if (status === 'you' || status === 'stalled') return 'yours';
  // No `attention` at all (an older snapshot): fall back on the health verdict, so
  // a blocked PR is still surfaced rather than filed under "in hand" by absence.
  if (!status) return pr.health?.blocked ? 'yours' : 'in_hand';
  return 'in_hand';
}

/**
 * Why this row is where it is, in the server's words.
 *
 * `attention.reasons` first, because the group was chosen off `attention.status`
 * and the two must agree; `health.reasons` is the fallback for an older snapshot.
 * Quoted and never parsed — the ladder's states carry the structure, this carries
 * the sentence.
 */
export function rackReason(pr: PullRequest): string {
  const reasons = pr.attention?.reasons?.length ? pr.attention.reasons : (pr.health?.reasons ?? []);
  return reasons.join(' · ');
}

/**
 * The rack, in reading order: your court first, then the rest.
 *
 * Ordering *inside* a group is by PR number and nothing cleverer. The old sort was
 * fullest-first, which is exactly backwards for the panel's job — it put the PRs
 * you have to decide on below the ones the harness was already fixing — and a
 * second ordering axis derived from the ladder would be a client-side opinion about
 * urgency sitting nowhere near the verdict that decides it.
 */
export function rack(prs: PullRequest[]): { yours: PullRequest[]; inHand: PullRequest[] } {
  const byNumber = (a: PullRequest, b: PullRequest) => a.number - b.number;
  return {
    yours: prs.filter((pr) => rackGroup(pr) === 'yours').sort(byNumber),
    inHand: prs.filter((pr) => rackGroup(pr) === 'in_hand').sort(byNumber),
  };
}

/** Merges inside the retained closed-PR window — all that survives of the Launches log. */
export function loadedCount(closed: PullRequest[]): number {
  return closed.filter((pr) => pr.state === 'merged' || pr.merged).length;
}
