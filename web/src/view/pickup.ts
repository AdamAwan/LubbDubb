// → docs/spec/17-cockpit.md#the-work-tab

/**
 * The pickup kind in the operator's words. The kind is an identifier the dispatcher passes between
 * its own rules; `has_pr` reaching the glass unedited asks the operator to know the enum first.
 */
const PICKUP_WORD: Record<string, string> = {
  has_pr: 'in review',
  active: 'working',
  eligible: 'up next',
  blocked: 'no capacity',
  retained: 'kept',
  container: 'a container',
  investigation: 'investigating',
  parked: 'blocked',
};

/** A pickup status in the operator's words, or the status itself where there is no word for it. */
export function pickupWord(status: string): string {
  return PICKUP_WORD[status] ?? status;
}

/** The goals the overview's "Goals in flight" lists: delivered ones stay until they settle. */
export const OVERVIEW_IN_FLIGHT: ReadonlySet<string> = new Set([
  'active',
  'has_pr',
  'planning',
  'investigation',
  'delivered',
]);

/** The goals the Work tab counts in flight: a parked or escalated goal is held, not done; a delivered one is done. */
export const WORK_IN_FLIGHT: ReadonlySet<string> = new Set([
  'active',
  'has_pr',
  'planning',
  'investigation',
  'parked',
  'escalated',
]);
