import { DESK_SETTLED, deskSettled } from '../benchSettlement.js';
import { sheetBenchLine } from '../remoteValidation/sheet.js';
import type { HumanTask, Issue, IssueDelivery, IssueShortfall, RemoteSheetRow, ValidationCheck } from '../types.js';
import { liveChecks, outstandingChecks } from './verdict.js';

// → docs/spec/20-validation.md

type ValidationReadyStep =
  | { kind: 'file'; originRef: string; title: string; detail: string }
  | { kind: 'settle'; taskId: string; status: 'done' | 'declined'; resolution: string }
  | { kind: 'reopen'; taskId: string; detail: string };

interface ValidationReadyInput {
  issues: readonly Issue[];
  deliveries: readonly IssueDelivery[];
  shortfalls: readonly IssueShortfall[];
  existing: readonly HumanTask[];
  checks: ReadonlyMap<string, readonly ValidationCheck[]>;
  /** The sheet rows an arrival assembled, by goal — one line each on the row's detail. */
  sheetRows: ReadonlyMap<string, readonly RemoteSheetRow[]>;
  opened: ReadonlySet<string> | null;
  watchCleared: ReadonlySet<string> | null;
}

export function validationReadyPass(input: ValidationReadyInput): ValidationReadyStep[] {
  const byOrigin = new Map(input.existing.map((t) => [t.originRef ?? '', t]));
  const inWorld = new Map(input.issues.map((i) => [`issue:${i.number}`, i]));
  const shortfalls = new Set(input.shortfalls.map((s) => s.originRef));
  const delivered = new Set(input.deliveries.map((d) => d.originRef));
  const steps: ValidationReadyStep[] = [];

  for (const delivery of input.deliveries) {
    const originRef = delivery.originRef;
    if (shortfalls.has(originRef)) continue;
    const live = liveChecks(input.checks.get(originRef) ?? []);
    const existing = byOrigin.get(originRef);
    const owed = live.filter(owedToAPerson);

    if (owed.length === 0) {
      if (existing?.status === 'open')
        steps.push({
          kind: 'settle',
          taskId: existing.id,
          status: 'done',
          resolution: settledResolution(live.length),
        });
      continue;
    }
    if (existing && existing.status !== 'open') {
      if (deskSettled(existing))
        steps.push({
          kind: 'reopen',
          taskId: existing.id,
          detail: validateDetail(inWorld.get(originRef) ?? null, live, owed.length, input.sheetRows.get(originRef)),
        });
      continue;
    }
    if (input.opened !== null && !input.opened.has(originRef) && !existing) continue;
    if (input.watchCleared !== null && !input.watchCleared.has(originRef) && !existing) continue;
    steps.push({
      kind: 'file',
      originRef,
      title: validateTitle(originRef),
      detail: validateDetail(inWorld.get(originRef) ?? null, live, owed.length, input.sheetRows.get(originRef)),
    });
  }

  for (const task of input.existing) {
    if (task.status !== 'open' || !task.originRef || delivered.has(task.originRef)) continue;
    steps.push({
      kind: 'settle',
      taskId: task.id,
      status: 'declined',
      resolution: DESK_SETTLED + 'the goal went back into production — there is nothing delivered to validate',
    });
  }

  return steps;
}

function owedToAPerson(check: ValidationCheck): boolean {
  if (check.state === 'passed' || check.state === 'waived') return false;
  return !(check.actor === 'fleet' && check.state === 'unrun');
}

function validateTitle(originRef: string): string {
  return `Run the validation checks for ${originRef.replace(/^issue:/, 'issue #')}`;
}

function validateDetail(
  issue: Issue | null,
  live: readonly ValidationCheck[],
  owed: number,
  sheetRows: readonly RemoteSheetRow[] | undefined,
): string {
  const name = issue ? `**${issue.title}**` : 'This goal';
  const lines = [
    `${name} is delivered, and its validation plan has ${count(owed, 'check')} for you to run — of ${count(live.length, 'check')} in all.`,
    '',
    ...outstandingChecks(live),
    '',
    'Run them and record each result on the goal, with a note. Nothing is blocked by this: validation gates no dispatch, no merge and no close — what it changes is what closing this goal looks like.',
  ];
  for (const line of sheetLines(sheetRows ?? [])) lines.push('', line);
  if (issue?.url) lines.push('', issue.url);
  return lines.join('\n');
}

function sheetLines(rows: readonly RemoteSheetRow[]): string[] {
  const byEnvironment = new Map<string, RemoteSheetRow[]>();
  for (const row of rows) {
    const held = byEnvironment.get(row.environment);
    if (held === undefined) byEnvironment.set(row.environment, [row]);
    else held.push(row);
  }
  return [...byEnvironment.entries()].map(([environment, its]) => sheetBenchLine(environment, its));
}

function settledResolution(total: number): string {
  return total === 0
    ? 'the plan no longer asks for any checks'
    : 'every check is recorded, waived, or with the fleet — nothing is left for you to run';
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
