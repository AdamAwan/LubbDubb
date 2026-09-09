import type { EnvironmentConfig } from '../environments/policy.js';
import { queryDigest } from '../store/remoteValidation.js';
import type { GoalWatch, RemoteRowKind, RemoteSheetRow, StateQuery, ValidationCheck } from '../types.js';
import { liveChecks } from '../validation/verdict.js';

// → docs/spec/36-remote-validation.md

/** What the desk executes for a row, once nothing has blocked it. `null` is a row a person runs. */
export type SheetRowRun = 'state' | 'watch' | null;

/**
 * What a stored row is executed by, read back off its own id. The press re-runs a confirmed row
 * through the same two readers the assembly used, rather than a second reader free to disagree
 * with them about what a row of that kind is.
 */
export function rowRun(rowId: string): SheetRowRun {
  if (rowId.startsWith('state:')) return 'state';
  if (rowId.startsWith('watch:')) return 'watch';
  return null;
}

export interface SheetRowPlan extends Omit<RemoteSheetRow, 'goalRef' | 'environment'> {
  run: SheetRowRun;
}

interface SheetInput {
  environment: EnvironmentConfig;
  checks: readonly ValidationCheck[];
  watches: readonly GoalWatch[];
  queries: readonly StateQuery[];
  /** `${digest} ${environment}` for every approval a person has written. */
  approvals: ReadonlySet<string>;
}

/**
 * The goal's own checks, its live watch checks and its `state` queries, as one list against one
 * environment. Nothing here is a second checklist beside the one an operator already keeps.
 *
 * Every cause of `blocked` this function can see is resolved **per row**: a kind the environment
 * does not permit, and a query nobody has accepted here. What is left to the desk is the causes only
 * a reading can produce, which is why a state row on a store nothing can reach is blocked while
 * every other row on the same sheet still reports.
 */
export function sheetRows(input: SheetInput): SheetRowPlan[] {
  const { environment } = input;
  const permits = environment.validate?.permits ?? [];
  const out: SheetRowPlan[] = [];
  let seq = 0;

  for (const check of liveChecks(input.checks)) {
    seq += 1;
    out.push({
      rowId: `check:${check.id}`,
      kind: 'check',
      seq,
      title: check.title,
      sourceId: check.id,
      selected: true,
      blockedReason: unpermitted('check', permits, environment.name),
      awaitingApproval: false,
      run: null,
    });
  }

  for (const query of input.queries) {
    seq += 1;
    const approved = input.approvals.has(`${query.digest} ${environment.name}`);
    const unpermittedReason = unpermitted('state', permits, environment.name);
    out.push({
      rowId: `state:${query.id}`,
      kind: 'state',
      seq,
      title: query.title,
      sourceId: query.id,
      selected: true,
      blockedReason: unpermittedReason ?? (approved ? null : unapproved(environment.name)),
      awaitingApproval: unpermittedReason === null && !approved,
      run: 'state',
    });
  }

  for (const watch of input.watches) {
    if (!watch.live) continue;
    seq += 1;
    const approved = input.approvals.has(`${queryDigest(watch.query, watch.presence ?? '')} ${environment.name}`);
    const unpermittedReason = unpermitted(watch.kind, permits, environment.name);
    const observable = (environment.watch?.observe ?? '').trim() !== '';
    out.push({
      rowId: `watch:${watch.id}`,
      kind: watch.kind,
      seq,
      title: watch.title,
      sourceId: watch.id,
      selected: true,
      blockedReason:
        unpermittedReason ??
        (observable
          ? approved
            ? null
            : unapproved(environment.name)
          : `${environment.name} declares no "watch.observe" command, so there is nothing here to put this query to.`),
      awaitingApproval: unpermittedReason === null && observable && !approved,
      run: 'watch',
    });
  }

  return out;
}

function unpermitted(kind: RemoteRowKind, permits: readonly RemoteRowKind[], environment: string): string | null {
  if (permits.includes(kind)) return null;
  return (
    `${environment} does not permit ${kind} rows — its "validate.permits" names ` +
    `${permits.length === 0 ? 'nothing' : permits.join(', ')}. Nothing was learned about the goal here.`
  );
}

function unapproved(environment: string): string {
  return (
    `this query is waiting for an operator to read it and accept it against ${environment}. Consent to a ` +
    'place is not transferable, so an approval written on another environment does not carry here.'
  );
}

/**
 * The one line the `validate` bench row carries about a sheet. Deliberately minimal: an operator has
 * to be told a sheet exists on the pulse sheets start existing, and what the row that follows it
 * says is the sheet's own surface to say.
 */
export function sheetBenchLine(environment: string, rows: readonly RemoteSheetRow[]): string {
  const waiting = rows.filter((r) => r.awaitingApproval).length;
  const said = `A validation sheet is assembled for \`${environment}\` — ${count(rows.length, 'row')}`;
  return waiting === 0 ? `${said}.` : `${said}, ${String(waiting)} waiting on an approval.`;
}

function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}
