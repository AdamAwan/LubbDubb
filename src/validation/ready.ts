import { issueOriginRef } from '../issueOrigins.js';
import { DESK_SETTLED, deskSettled } from '../benchSettlement.js';
import { sheetBenchLine } from './remote/sheet.js';
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
  /** Goals whose check set is released; null reads every set as released. */
  released: ReadonlySet<string> | null;
  watchCleared: ReadonlySet<string> | null;
}

export function validationReadyPass(input: ValidationReadyInput): ValidationReadyStep[] {
  const byOrigin = new Map(input.existing.map((t) => [t.originRef ?? '', t]));
  const inWorld = new Map(input.issues.map((i) => [issueOriginRef('root', i.number), i]));
  const shortfalls = new Set(input.shortfalls.map((s) => s.originRef));
  const delivered = new Set(input.deliveries.map((d) => d.originRef));
  const steps: ValidationReadyStep[] = [];

  for (const delivery of input.deliveries) {
    const originRef = delivery.originRef;
    if (shortfalls.has(originRef)) continue;
    const step = deliveryStep(input, originRef, byOrigin.get(originRef), inWorld.get(originRef) ?? null);
    if (step !== null) steps.push(step);
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

function deliveryStep(
  input: ValidationReadyInput,
  originRef: string,
  existing: HumanTask | undefined,
  issue: Issue | null,
): ValidationReadyStep | null {
  const live = liveChecks(input.checks.get(originRef) ?? []);
  const owed = live.filter(owedToAPerson);

  if (owed.length === 0) {
    if (existing?.status !== 'open') return null;
    return { kind: 'settle', taskId: existing.id, status: 'done', resolution: settledResolution(live.length) };
  }
  if (!admits(input.released, originRef)) {
    if (existing?.status !== 'open') return null;
    return {
      kind: 'settle',
      taskId: existing.id,
      status: 'declined',
      resolution: DESK_SETTLED + 'the check set is waiting on your accept — it is not work until you do',
    };
  }
  if (existing && existing.status !== 'open') {
    if (!deskSettled(existing)) return null;
    return {
      kind: 'reopen',
      taskId: existing.id,
      detail: validateDetail(issue, live, owed.length, input.sheetRows.get(originRef)),
    };
  }
  if (!admits(input.opened, originRef) && !existing) return null;
  if (!admits(input.watchCleared, originRef) && !existing) return null;
  return {
    kind: 'file',
    originRef,
    title: validateTitle(originRef),
    detail: validateDetail(issue, live, owed.length, input.sheetRows.get(originRef)),
  };
}

function admits(gate: ReadonlySet<string> | null, originRef: string): boolean {
  return gate === null || gate.has(originRef);
}

/**
 * `declined` is settled and owed to nobody: the operator read that row at the accept gate and said
 * no to it. Counting it here would put a row back on the bench as work the very press that struck
 * it out — the ask reading "1 check for you to run" against a check nobody is going to run.
 * → docs/spec/20-validation.md#declining-a-single-row
 */
function owedToAPerson(check: ValidationCheck): boolean {
  if (check.state === 'passed' || check.state === 'waived' || check.state === 'declined') return false;
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
