import type {
  CockpitEnvironment,
  GoalEnvironmentReachView,
  RemoteRowOutcome,
  RemoteSheetRowView,
  RemoteSheetView,
  ValidationCheckResultBy,
  ValidationCheckState,
  ValidationCheckView,
} from '../types.js';
import { isOwed } from './validationChecks.js';

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
  /**
   * What each environment's last run made of this check: its sheet rows that carry a reading or a
   * block, one per environment. Drawn under the check itself, so a check and what the runs said about
   * it are read in one place rather than matched up across two panels.
   */
  runs: RemoteSheetRowView[];
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
  running: 'Running now',
  open: 'Ready for a run',
  yours: 'Yours to check',
  answered: 'Done',
};

export const BAND_HINT: Record<CheckBand, string> = {
  running: 'a run is reading these — what it sees lands on each row',
  open: 'tick the ones the next run should take',
  yours: 'no runner can answer these — open one and record what you saw',
  answered: 'passed or waived',
};

/** The bands in reading order: what is moving, what could move, what waits on a person, what is settled. */
const BANDS: readonly CheckBand[] = ['running', 'open', 'yours', 'answered'];

interface BandGroup {
  band: CheckBand;
  checks: ValidationCheckView[];
  /**
   * The runners named by a band's checks, said once on its heading. Null where they do not agree —
   * two environments across one band is a fact about the rows and belongs on them, not on a heading
   * that would then be wrong for half of what is under it.
   */
  runner: string | null;
}

/** The goal page's bands in reading order, each with the live checks in it; an empty band is left out. */
export function checkBands(
  live: readonly ValidationCheckView[],
  standings: ReadonlyMap<string, CheckStanding>,
): BandGroup[] {
  return BANDS.flatMap((band): BandGroup[] => {
    const checks = live.filter((check) => standings.get(check.id)?.band === band);
    if (checks.length === 0) return [];
    return [{ band, checks, runner: band === 'yours' ? null : runners(checks, standings) }];
  });
}

function runners(checks: readonly ValidationCheckView[], standings: ReadonlyMap<string, CheckStanding>): string | null {
  const said = new Set(checks.map((check) => standings.get(check.id)?.label ?? ''));
  return said.size === 1 ? ([...said][0] ?? null) : null;
}

/**
 * What a band already implies about the state of a check in it. A row that says it again is a chip
 * carrying no news, and a list of twelve of them is twelve boxes of shouting between the reader and
 * the two rows that are actually odd. → docs/spec/17-cockpit.md#the-validate-pane
 */
const BAND_IMPLIES: Record<CheckBand, ValidationCheckState | null> = {
  running: null,
  open: 'unrun',
  yours: 'unrun',
  answered: 'passed',
};

/** The check's state where its band does not already say it, or null where it does. */
export function oddState(band: CheckBand, state: ValidationCheckState): ValidationCheckState | null {
  return BAND_IMPLIES[band] === state ? null : state;
}

/** What a check's box says about the sheet row it writes. */
export function checkBoxTitle(row: CheckRow): string {
  if (row.live) return `A run on ${row.environment} is carrying it now`;
  if (row.awaitingApproval)
    return `In ${row.environment}’s next run — but its query needs approving before a press can read it`;
  if (row.selected) return `In ${row.environment}’s next run. Untick to leave it out — you will answer it another way`;
  return `Left out of ${row.environment}’s next run. Tick to put it back`;
}

/** What a run made of a check's row, in the row's own vocabulary: a block outranks any reading. */
export function runOutcome(row: RemoteSheetRowView): RemoteRowOutcome | null {
  return row.blockedReason !== null ? 'blocked' : (row.reading?.outcome ?? null);
}

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
    const runs = checkRuns(sheets, check.id);
    if (!isOwed(check)) {
      standings.set(check.id, { band: 'answered', label: answeredBy(check, sheets), row, runs });
      continue;
    }
    const onIt = sheets.filter((sheet) => live(sheet) && readable(sheet, check.id));
    if (onIt.length > 0) {
      standings.set(check.id, {
        band: 'running',
        label: `a run on ${onIt.map((s) => s.environment).join(', ')}`,
        row,
        runs,
      });
      continue;
    }
    const could = sheets.filter((sheet) => readable(sheet, check.id)).map((sheet) => sheet.environment);
    if (could.length > 0) {
      standings.set(check.id, { band: 'open', label: `${could.join(' or ')} can take it`, row, runs });
      continue;
    }
    standings.set(check.id, { band: 'yours', label: 'no run offers to take this', row, runs });
  }
  return standings;
}

/** A check's rows that something happened on — a reading taken, or a block said — in sheet order. */
function checkRuns(sheets: readonly RemoteSheetView[], checkId: string): RemoteSheetRowView[] {
  return sheets.flatMap((sheet) =>
    sheet.rows.filter(
      (row) => row.kind === 'check' && row.sourceId === checkId && (row.reading !== null || row.blockedReason !== null),
    ),
  );
}

/**
 * The rows an environment panel still lists: everything that is not a check's own row. A check row
 * is read on its check, and listed again here it is the second copy of the set that made the pane
 * hard to follow. A check row still waiting on an approval stays, since the approval is taken here.
 */
export function panelRows(sheet: RemoteSheetView): RemoteSheetRowView[] {
  return sheet.rows.filter((row) => row.kind !== 'check' || row.awaitingApproval);
}

/** Why an environment's tenant cannot be trusted right now, or nothing where it can. */
export interface TenantAlert {
  environment: string;
  tenant: string | null;
  why: 'blocked' | 'failed' | 'stale';
  /** The record's own words: the tenant's block, or what the failed preparation said. */
  detail: string | null;
}

/**
 * One alert per sheet whose tenant would make a reading on it untrustworthy, in the order that
 * matters: a tenant nothing can be put to, a preparation that ran and failed, then one past the
 * freshness window its environment declares. A preparation still running, or one whose outcome is
 * unknown, is not an alert — the gate follows it. `showing` narrows to the environment the pane shows.
 * → docs/spec/36-remote-validation.md#tenants
 */
export function tenantAlerts(sheets: readonly RemoteSheetView[], showing: string | null = null): TenantAlert[] {
  return sheets
    .filter((sheet) => showing === null || sheet.environment === showing)
    .flatMap((sheet): TenantAlert[] => {
      const { tenant } = sheet;
      const base = { environment: sheet.environment, tenant: tenant.tenant };
      if (tenant.blockedReason !== null) return [{ ...base, why: 'blocked', detail: tenant.blockedReason }];
      const prep = tenant.preparation;
      if (prep !== null && prep.finishedAt === null) return [];
      if (prep?.ok === false) return [{ ...base, why: 'failed', detail: prep.detail }];
      if (tenant.stale) return [{ ...base, why: 'stale', detail: null }];
      return [];
    });
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

/** A remote runner offering this goal no run, and why. `environment` null: no environment could. */
export interface RemoteRunGap {
  environment: string | null;
  why: string;
  /** An operator can set the run up by hand. → 36-remote-validation.md#setting-one-up-by-hand */
  setUp?: boolean;
}

/**
 * The remote runners with no sheet for this goal, each with its reason — the server's `noSheet` where a
 * reach row carries one. `showing` narrows to the environment the pane is showing.
 * → docs/spec/36-remote-validation.md#when-there-is-no-sheet
 */
export function remoteRunGaps(
  environments: readonly CockpitEnvironment[],
  sheets: readonly RemoteSheetView[],
  reach: readonly GoalEnvironmentReachView[],
  showing: string | null = null,
): RemoteRunGap[] {
  const validating = environments.filter((e) => e.validates);
  if (validating.length === 0)
    return [
      {
        environment: null,
        why: 'No environment declares a `validate` block, so nothing can run these checks remotely.',
      },
    ];
  if (showing !== null && !validating.some((e) => e.name === showing))
    return [{ environment: showing, why: `${showing} declares no \`validate\` block, so it cannot run these checks.` }];
  return validating
    .filter((env) => (showing === null || env.name === showing) && !sheets.some((s) => s.environment === env.name))
    .map((env) => ({
      environment: env.name,
      ...(reach.find((r) => r.environment === env.name)?.noSheet ?? {
        why: `This goal's work has not reached ${env.name} yet — a run is offered once it does.`,
      }),
    }));
}
