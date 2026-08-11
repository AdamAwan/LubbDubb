import type { PullRequest, Stack, StackRung } from '../types.js';
import { scannersFor, type Scanner } from './scanners.js';
import type { StatusTone } from './vocabulary.js';
import type { IconName } from './components/Sprite.js';

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
 * A rung, joined back to the pull request it is.
 *
 * `pr` is null when the snapshot the rack was handed does not carry it —
 * `buildStacks` runs on the **unfiltered** open list, deliberately, so an
 * `-ignore`d rung cannot put a hole in the chain. Such a rung still draws, from
 * the rung's own fields, and asserts no health it does not have.
 */
export interface RackRung {
  rung: StackRung;
  pr: PullRequest | null;
  /** Nearest rung below that is still holding — what this one waits on. Null at the bottom. */
  blockedBy: number | null;
  /** Nothing on this rung's ladder is unmet. The bottom rung being clear is "next to merge". */
  clear: boolean;
}

/** One entry on the rack, in reading order: a loose pull request, or a stack as one cluster. */
export type RackEntry =
  | { kind: 'pr'; sort: number; pr: PullRequest }
  | { kind: 'stack'; sort: number; stack: Stack; rungs: RackRung[] };

/**
 * Is anything on this rung's ladder unmet?
 *
 * Read off `ladderFor` rather than re-derived, so the "waiting on #N below" note
 * and the ladder drawn two rows down can never disagree about the same rung. A
 * `muted` scanner is policy saying it does not count, so it does not hold.
 */
function holding(pr: PullRequest | null): boolean {
  if (!pr) return true;
  const { scanners, gates } = ladderFor(pr);
  return gates.some((g) => !g.met) || scanners.some((s) => s.state !== 'pass' && s.state !== 'muted');
}

/**
 * The rack, with stacks folded in as clusters rather than listed beneath it.
 *
 * A stack goes to the group of its **most urgent rung** — `yours` if any rung is
 * yours — and the chain is never split across the two headings. Splitting it would
 * be the honest answer about attention and the wrong answer about the panel's job:
 * a stack is read as an order, and an order broken in half is not one. The rungs
 * that landed under *Your court* without being yours carry their own court chip
 * saying so, which is the same sentence the row would have made on its own.
 *
 * A rung never also appears loose. Ordering is by pull-request number and nothing
 * cleverer, a cluster sorting on its bottom rung, so clusters and loose rows
 * interleave exactly as the rows did before there were clusters. A second ordering
 * axis derived from the ladder would be a client-side opinion about urgency sitting
 * nowhere near the verdict that decides it.
 */
export function rackEntries(prs: PullRequest[], stacks: Stack[]): { yours: RackEntry[]; inHand: RackEntry[] } {
  const byNumber = new Map(prs.map((pr) => [pr.number, pr]));
  const claimed = new Set<number>();
  const yours: RackEntry[] = [];
  const inHand: RackEntry[] = [];

  for (const stack of stacks) {
    const joined = stack.rungs.map((rung) => ({ rung, pr: byNumber.get(rung.prNumber) ?? null }));
    for (const { rung } of joined) claimed.add(rung.prNumber);
    const held = joined.map(({ pr }) => holding(pr));
    const rungs: RackRung[] = joined.map(({ rung, pr }, i) => {
      let blockedBy: number | null = null;
      for (let j = i - 1; j >= 0; j -= 1) {
        if (held[j] === true) {
          blockedBy = joined[j]?.rung.prNumber ?? null;
          break;
        }
      }
      return { rung, pr, blockedBy, clear: held[i] === false };
    });
    const mine = rungs.some((r) => r.pr !== null && rackGroup(r.pr) === 'yours');
    const entry: RackEntry = { kind: 'stack', sort: stack.rungs[0]?.prNumber ?? 0, stack, rungs };
    (mine ? yours : inHand).push(entry);
  }

  for (const pr of prs) {
    if (claimed.has(pr.number)) continue;
    const entry: RackEntry = { kind: 'pr', sort: pr.number, pr };
    (rackGroup(pr) === 'yours' ? yours : inHand).push(entry);
  }

  const bySort = (a: RackEntry, b: RackEntry) => a.sort - b.sort;
  return { yours: yours.sort(bySort), inHand: inHand.sort(bySort) };
}

/** How many pull requests an entry list draws — a cluster counts its rungs, not itself. */
export function rackCount(entries: RackEntry[]): number {
  return entries.reduce((n, e) => n + (e.kind === 'stack' ? e.rungs.length : 1), 0);
}

/** Merges inside the retained closed-PR window — all that survives of the Launches log. */
export function loadedCount(closed: PullRequest[]): number {
  return closed.filter((pr) => pr.state === 'merged' || pr.merged).length;
}

/**
 * The game's status glyph for a reason the server wrote.
 *
 * Matched on the reason text, which is the only structure there is — `attention`
 * ships prose, and re-deriving the condition from the PR here would be a second
 * opinion sitting nowhere near the verdict that formed it.
 *
 * An unrecognised reason returns null and the cell draws its sentence alone. A
 * fallback glyph would put a confident picture on a condition nobody classified,
 * which is worse than no picture — the same rule `prState` follows in never
 * inventing `closed`.
 */
export function conditionGlyph(reason: string): IconName | null {
  const r = reason.toLowerCase();
  if (r.includes('ci ') || r.includes('check')) return 'alert';
  if (r.includes('comment')) return 'signal';
  if (r.includes('behind') || r.includes('conflict')) return 'belt';
  if (r.includes('propos') || r.includes('approv')) return 'blueprint';
  if (r.includes('agent')) return 'bot';
  return null;
}
