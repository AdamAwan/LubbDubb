import type { ValidationCheckView, ValidationResourceView } from '../types.js';

// → docs/spec/17-cockpit.md#a-sheet-of-checks-is-a-queue

interface CheckSet {
  live: ValidationCheckView[];
  /** Dropped by an amendment: drawn apart, with the reason, and never in the work. */
  withdrawn: ValidationCheckView[];
}

export function splitChecks(checks: readonly ValidationCheckView[]): CheckSet {
  return {
    live: checks.filter((c) => c.supersededReason === null),
    withdrawn: checks.filter((c) => c.supersededReason !== null),
  };
}

/** Work still owed. `passed` and `waived` are the two states that settle a check; everything else —
 *  unrun, captured, failed, deferred, declined — is something somebody still has to answer.
 *  → docs/spec/20-validation.md#states */
export function isOwed(check: Pick<ValidationCheckView, 'state'>): boolean {
  return check.state !== 'passed' && check.state !== 'waived';
}

interface CheckQueue {
  owed: ValidationCheckView[];
  /** What the sheet draws open: the pinned check, else the first still owed, else the first at all. */
  shown: ValidationCheckView[];
  /** The rest as lines, owed apart from settled. Empty while the whole set is drawn. */
  rest: { owed: ValidationCheckView[]; done: ValidationCheckView[] };
}

/**
 * The queue a sheet of checks is drawn as. `focus` is the operator's pin, or null for *the queue
 * picks*; a pin the set no longer holds falls back to the queue. `all` draws every check open.
 */
export function checkQueue(live: readonly ValidationCheckView[], focus: string | null, all: boolean): CheckQueue {
  const owed = live.filter(isOwed);
  const picked = live.find((c) => c.id === focus) ?? owed[0] ?? live[0];
  return {
    owed,
    shown: all ? [...live] : picked === undefined ? [] : [picked],
    rest: {
      owed: all ? [] : owed.filter((c) => c !== picked),
      done: all ? [] : live.filter((c) => c !== picked && !isOwed(c)),
    },
  };
}

/** How many of the live checks are settled: the *N* of every "N of M done". */
export function settledCount(live: readonly Pick<ValidationCheckView, 'state'>[]): number {
  return live.filter((c) => !isOwed(c)).length;
}

/** The digest's count beside its heading. */
export function digestCount(live: readonly ValidationCheckView[]): string {
  if (live.length === 0) return 'withdrawn';
  return `${String(settledCount(live))} of ${String(live.length)} done`;
}

/** What a queue line says beside its title, if anything: the loudest of the three facts it could. */
export function lineAside(check: ValidationCheckView): string | null {
  if (check.amendedAt !== null) return 'changed';
  if (check.handbackNote !== null) return 'back with you';
  if (check.actor === 'fleet') return 'with the fleet';
  return null;
}

export function isMissingFile(resource: ValidationResourceView): boolean {
  return !resource.present && resource.kind !== 'access';
}

/** The set's resources a check names in `uses`, in its order; a name the set does not hold is skipped. */
export function resourcesFor(
  resources: readonly ValidationResourceView[],
): (check: ValidationCheckView) => ValidationResourceView[] {
  const byName = new Map(resources.map((r) => [r.name, r]));
  return (check) =>
    check.uses.flatMap((name) => {
      const found = byName.get(name);
      return found ? [found] : [];
    });
}

/** A resource chip's hover: its path, and its note under a blank line where it has one. */
export function resourceTitle(resource: ValidationResourceView): string {
  return resource.note === null ? resource.path : `${resource.path}\n\n${resource.note}`;
}
