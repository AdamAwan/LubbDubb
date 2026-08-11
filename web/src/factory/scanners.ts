import type { PullRequest } from '../types.js';
import { scannerStatus, type MachineStatus, type ScannerState } from './vocabulary.js';

/**
 * One PR's quality gates, read out of the CI policy's own verdict.
 *
 * This was inside `goalFloor.ts` and is here because a second surface needs it:
 * the Parts Inspection strip draws the same checks as its ladder, and the Goal
 * Floor draws them under a pull-request machine. Two folds would be two answers to
 * *which check is red and is anyone coming for it* — the drift this repo has paid
 * for twice — so there is one, and both import it.
 *
 * **Human review is fed from `pr.approved`, not from the verdict**, and that is the
 * thing to preserve: reviewer policies deliberately do not fold into `ciChecks` —
 * they map to `approved` / `unresolvedComments` — so a scanner drawn off
 * `ciVerdict` would be permanently absent.
 *
 * No check *name* is written here. Every name comes off the verdict, so a floor
 * running against a config naming any check at all renders with no change, which
 * is why no check name from any workplace appears in this repository.
 */
export interface Scanner {
  name: string;
  state: ScannerState;
  status: MachineStatus;
}

/**
 * The scanner row: one per check the policy classified, plus the aggregate's
 * fallback, plus human review.
 *
 * `withReview` is the one difference between the two callers, and it is a
 * difference in subject rather than in reading. The Goal Floor's pull-request
 * machine is the whole of *what stands between this part and the silo*, review
 * included. The strip keeps review in its own fixed gate beside two others a human
 * moves, so a scanner for it there would draw the same fact twice on one row.
 */
export function scannersFor(pr: PullRequest, opts: { withReview: boolean }): Scanner[] {
  const scanners: Scanner[] = [];
  const add = (name: string, state: ScannerState) => scanners.push({ name, state, status: scannerStatus(state) });
  const verdict = pr.ciVerdict;
  const named = (verdict?.dispatch.length ?? 0) + (verdict?.escalate.length ?? 0) + (verdict?.ignored.length ?? 0);

  for (const m of verdict?.dispatch ?? []) add(m.name, 'damaged');
  for (const m of verdict?.escalate ?? []) add(m.name, 'not_ours');
  for (const m of verdict?.ignored ?? []) add(m.name, 'muted');
  if (named === 0) {
    // The provider reported no per-check detail. That is missing detail rather
    // than a clean bill of health, so the aggregate speaks for itself under the
    // generic name the workflow doc uses for the whole row.
    if (pr.ciStatus === 'passing') add('quality gates', 'pass');
    else if (pr.ciStatus === 'failing') add('quality gates', 'damaged');
    else if (pr.ciStatus === 'pending') add('quality gates', 'awaiting');
  }
  if (opts.withReview) add('human review', pr.approved === true ? 'pass' : 'awaiting');
  return scanners;
}
