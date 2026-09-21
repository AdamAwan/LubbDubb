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
  /**
   * The sheet row a press would read this check through, on the environment the pane is showing.
   * It carries the **sheet's own** `selected` — the pane draws a box for it and writes back through
   * `selectRemoteRow`, so what a press will carry has one answer and not two. Null where that
   * environment holds no readable row for the check; where the pane is showing none, the row of the
   * one sheet that holds it, and null where two do — a box would then mean an environment without
   * saying which, and each panel's own rows still carry theirs.
   */
  row: CheckRow | null;
}

interface CheckRow {
  environment: string;
  rowId: string;
  selected: boolean;
  /** A run is on it now, so what it carries is settled and the box is not a question any more. */
  live: boolean;
  /** Its query has not been approved, so a press reads nothing here whatever the box says. */
  awaitingApproval: boolean;
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
function readableRow(sheet: RemoteSheetView, checkId: string): RemoteSheetView['rows'][number] | undefined {
  return sheet.rows.find((row) => row.sourceId === checkId && row.blockedReason === null && row.idleReason === null);
}

function readable(sheet: RemoteSheetView, checkId: string): boolean {
  return readableRow(sheet, checkId) !== undefined;
}

/** The row a press would read this check through on the shown environment, or null. */
function boxRow(
  sheets: readonly RemoteSheetView[],
  checkId: string,
  showing: string | null | undefined,
): CheckRow | null {
  const holding = sheets.filter((sheet) => readable(sheet, checkId));
  const sheet =
    showing == null ? (holding.length === 1 ? holding[0] : undefined) : holding.find((s) => s.environment === showing);
  if (sheet === undefined) return null;
  const row = readableRow(sheet, checkId);
  if (row === undefined) return null;
  return {
    environment: sheet.environment,
    rowId: row.rowId,
    selected: row.selected,
    live: live(sheet),
    awaitingApproval: row.awaitingApproval,
  };
}

/**
 * One standing per live check: what the Checks panel groups on, and what each of its rows says about
 * where its answer is coming from. The runner panels below it draw the same facts from the other
 * end — a run, and the checks it carries.
 */
export function checkStandings(
  checks: readonly ValidationCheckView[],
  sheets: readonly RemoteSheetView[],
  /** The environment the pane is showing, whose selection the boxes write. */
  showing?: string | null,
): Map<string, CheckStanding> {
  const standings = new Map<string, CheckStanding>();
  for (const check of checks) {
    if (check.supersededReason !== null) continue;
    const row = boxRow(sheets, check.id, showing);
    if (check.state === 'passed' || check.state === 'waived') {
      standings.set(check.id, { band: 'answered', label: answeredBy(check, sheets), row });
      continue;
    }
    const onIt = sheets.filter((sheet) => live(sheet) && readable(sheet, check.id));
    if (onIt.length > 0) {
      standings.set(check.id, { band: 'running', label: `a run on ${onIt.map((s) => s.environment).join(', ')}`, row });
      continue;
    }
    const could = sheets.filter((sheet) => readable(sheet, check.id)).map((sheet) => sheet.environment);
    if (could.length > 0) {
      standings.set(check.id, { band: 'open', label: `${could.join(' or ')} can take it`, row });
      continue;
    }
    standings.set(check.id, { band: 'yours', label: 'no run offers to take this', row });
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
 * What a press is made of: the ticked checks an operator can see in the list above, and the rows the
 * sheet carries of its own — the `state` queries and `measure` rows, which have no check to tick.
 * Said because the two numbers differ and the difference is the whole of the question *why does it
 * say five when I ticked three*.
 */
export function pressBreakdown(sheet: RemoteSheetView): { checks: number; own: number } {
  const rows = sheet.rows.filter((row) => row.selected && row.blockedReason === null && row.idleReason === null);
  const checks = rows.filter((row) => row.kind === 'check').length;
  return { checks, own: rows.length - checks };
}
