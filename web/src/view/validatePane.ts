import type { RemoteSheetView, ValidationCheckResultBy, ValidationCheckView } from '../types.js';

// → docs/spec/17-cockpit.md#the-validate-pane

/**
 * Which of the pane's four bands a check sits in. The bands answer one question — *who has a run for
 * this* — and nothing else: a check is `running` while a live run carries it, `open` where a press
 * would take it, `yours` where no runner offered, and `answered` once a reading settled it.
 *
 * `yours` is the residue rather than a judgement. Whether the fleet could carry a check's first step
 * is the server's reading (`fleetCanStart`, three-valued), and a cockpit re-deriving it would be a
 * second opinion drawn beside the sheet's own — the same refusal `idleReason` exists for.
 * → docs/spec/17-cockpit.md#the-validate-pane, docs/spec/36-remote-validation.md#a-row-no-press-can-read
 */
export type CheckBand = 'running' | 'open' | 'yours' | 'answered';

export interface CheckStanding {
  band: CheckBand;
  /** What the pane draws beside the check: the run that is on it, or the runners that could take it. */
  label: string;
}

export const BAND_HEADING: Record<CheckBand, string> = {
  running: 'a run is on them',
  open: 'no run yet',
  yours: 'only you can answer',
  answered: 'answered',
};

/** A run that is still going. The sheet's own vocabulary — `pending` is dispatched-for, not idle. */
function live(sheet: RemoteSheetView): boolean {
  return sheet.run !== null && (sheet.run.status === 'pending' || sheet.run.status === 'dispatched');
}

/**
 * Whether a press against this sheet would read this check's row. Read off `blockedReason` and
 * `idleReason`, both folded on the server beside the row they describe, and never worked out here.
 */
function readable(sheet: RemoteSheetView, checkId: string): boolean {
  return sheet.rows.some((row) => row.sourceId === checkId && row.blockedReason === null && row.idleReason === null);
}

/**
 * One standing per live check: what the Checks panel groups on, and what each of its rows says about
 * where its answer is coming from. The runner panels below it draw the same facts from the other
 * end — a run, and the checks it carries.
 */
export function checkStandings(
  checks: readonly ValidationCheckView[],
  sheets: readonly RemoteSheetView[],
): Map<string, CheckStanding> {
  const standings = new Map<string, CheckStanding>();
  for (const check of checks) {
    if (check.supersededReason !== null) continue;
    if (check.state === 'passed' || check.state === 'waived') {
      standings.set(check.id, { band: 'answered', label: answeredBy(check, sheets) });
      continue;
    }
    const onIt = sheets.filter((sheet) => live(sheet) && readable(sheet, check.id));
    if (onIt.length > 0) {
      standings.set(check.id, { band: 'running', label: `a run on ${onIt.map((s) => s.environment).join(', ')}` });
      continue;
    }
    const could = sheets.filter((sheet) => readable(sheet, check.id)).map((sheet) => sheet.environment);
    if (could.length > 0) {
      standings.set(check.id, { band: 'open', label: `${could.join(' or ')} can take it` });
      continue;
    }
    standings.set(check.id, { band: 'yours', label: 'no run offers to take this' });
  }
  return standings;
}

/**
 * Where an answered check's reading came from, in the record's own words. `resultBy` is what wrote
 * the reading; the sheet says which environment's run carried it. Neither is inferred from the
 * other, and a reading with no sheet behind it says only who recorded it.
 */
const BY_WORD: Record<ValidationCheckResultBy, string> = {
  operator: 'you',
  agent: 'an agent',
  desktop: 'your own Claude Code',
  spec: 'a spec run',
  script: 'a script',
};

function answeredBy(check: ValidationCheckView, sheets: readonly RemoteSheetView[]): string {
  const through = sheets.find((sheet) => sheet.rows.some((row) => row.sourceId === check.id && row.reading !== null));
  if (through !== undefined) return `a run on ${through.environment}`;
  return check.resultBy === null ? 'answered' : BY_WORD[check.resultBy];
}

/**
 * How many **rows** a press against this sheet would read — the gate's own count, so the strip and
 * the gate never offer different numbers.
 *
 * Rows, and never checks: a sheet carries `state` queries and `measure` rows beside its check rows,
 * and a press re-reads every selected row including the ones already answered. Called *checks*, the
 * number is larger than the list's unanswered count and reads as a miscount of the list.
 * → docs/spec/36-remote-validation.md#a-row-no-press-can-read
 */
export function pressableRows(sheet: RemoteSheetView): number {
  return sheet.rows.filter((row) => row.selected && row.blockedReason === null && row.idleReason === null).length;
}

/**
 * How many of this environment's checks have no answer yet, read off the same standings the bands
 * are drawn from. It is the number an operator is actually asking about when they read a press, and
 * it is deliberately *not* derived from the sheet a second time.
 */
export function unanswered(environment: string, standings: Map<string, CheckStanding>): number {
  return [...standings.values()].filter((s) => s.band === 'open' && s.label.includes(environment)).length;
}
