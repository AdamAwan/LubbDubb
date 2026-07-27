import type { PullRequest } from '../../types.js';
import type { StatusTone } from './vocabulary.js';

/**
 * An open PR as a rocket silo, filling toward a launch.
 *
 * The Launches panel beside this one lists PRs that have *already* closed, which
 * makes it a scoreboard: the silo is only ever empty or fired. What was missing
 * is the part with any tension in it — a PR three gates from merging is a silo
 * three quarters full, and that is a thing you can read across a room.
 */

interface SiloGate {
  label: string;
  met: boolean;
}

/**
 * The four gates, and they are a *fixed* four on purpose.
 *
 * `health.reasons` is the server's verdict and the honest source for *why* a PR
 * is stuck, but it is a variable-length list of prose — it names only what is
 * wrong, so it can supply a numerator and never a denominator, and "2 reasons"
 * does not fill anything. These four are the gates every provider maps onto, so
 * the fill has a stable bottom and top. `health` still speaks for itself in the
 * panel; it is quoted, never parsed.
 */
export function siloGates(pr: PullRequest): SiloGate[] {
  const unresolved = pr.unresolvedComments.filter((c) => !c.handled).length;
  const behind = pr.mergeableState === 'behind' || pr.mergeableState === 'dirty';
  return [
    { label: 'CI passing', met: pr.ciStatus === 'passing' },
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

/** How full the silo stands, 0–1. */
export function siloFill(gates: readonly SiloGate[]): number {
  if (gates.length === 0) return 0;
  return gates.filter((g) => g.met).length / gates.length;
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
export function siloCourt(pr: PullRequest): { label: string; tone: StatusTone } {
  switch (pr.attention?.status) {
    case 'you':
      return { label: 'Your call', tone: 'bad' };
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
      return pr.health?.blocked ? { label: 'Blocked', tone: 'warn' } : { label: 'Launch ready', tone: 'ok' };
  }
}
