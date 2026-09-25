import type { EnvironmentConfig } from '../../environments/policy.js';
import { queryDigest } from '../../store/remoteValidation.js';
import type {
  GoalWatch,
  RemoteRowKind,
  RemoteRowOutcome,
  RemoteSheetRow,
  StateQuery,
  ValidationCheck,
} from '../../types.js';
import { handsBackAScreen, stepArea, stepDriven, stepScript } from '../steps.js';
import { liveChecks } from '../verdict.js';
import { selectorFault } from './runner.js';

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
  /**
   * The tenant this environment resolves to, and why it has none where it has none. A one-off script
   * **acts**, so it needs one — and the harness generates and infers no tenant identifier anywhere,
   * so an environment that names none blocks the row rather than running the script somewhere it
   * should not. → docs/spec/36-remote-validation.md#the-one-off-script
   */
  tenant?: { tenant: string | null; blockedReason: string | null };
}

/**
 * The goal's own checks, its live watch checks and its `state` queries, as one list against one
 * environment. Nothing here is a second checklist beside the one an operator already keeps.
 *
 * Every cause of `blocked` this function can see is resolved **per row**: a kind the environment
 * does not permit, a query nobody has accepted here, and an area holding the character its own
 * selector list is joined on. What is left to the desk is the causes only
 * a reading can produce, which is why a state row on a store nothing can reach is blocked while
 * every other row on the same sheet still reports.
 */
export function sheetRows(input: SheetInput): SheetRowPlan[] {
  const permits = input.environment.validate?.permits ?? [];
  const out: SheetRowPlan[] = [];
  let seq = 0;

  for (const check of liveChecks(input.checks)) {
    // A row the operator declined at the accept gate is settled, and a sheet is a list of what is
    // still to run. Assembled, it would be pressed, dispatched for and reported on — the decline
    // undone by the one surface that never saw it.
    // → docs/spec/36-remote-validation.md#a-declined-row-is-not-on-the-sheet
    if (check.state === 'declined') continue;
    seq += 1;
    out.push(checkRow(check, seq, input, permits));
  }

  for (const query of input.queries) {
    seq += 1;
    out.push(queryRow(query, seq, input, permits));
  }

  for (const watch of input.watches) {
    if (!watch.live) continue;
    seq += 1;
    out.push(watchRow(watch, seq, input, permits));
  }

  return out;
}

function checkRow(
  check: ValidationCheck,
  seq: number,
  input: SheetInput,
  permits: readonly RemoteRowKind[],
): SheetRowPlan {
  const { environment } = input;
  return {
    rowId: `check:${check.id}`,
    kind: 'check',
    seq,
    title: check.title,
    sourceId: check.id,
    selected: true,
    blockedReason:
      unpermitted('check', permits, environment.name) ??
      areaFault(stepArea(check.steps)) ??
      actingTenantFault(check, input.tenant, environment.name),
    awaitingApproval: false,
    matched: null,
    idleReason: idleReason(check, environment),
    run: null,
  };
}

function queryRow(query: StateQuery, seq: number, input: SheetInput, permits: readonly RemoteRowKind[]): SheetRowPlan {
  const { environment } = input;
  const approved = input.approvals.has(`${query.digest} ${environment.name}`);
  const unpermittedReason = unpermitted('state', permits, environment.name);
  return {
    rowId: `state:${query.id}`,
    kind: 'state',
    seq,
    title: query.title,
    sourceId: query.id,
    selected: true,
    blockedReason: unpermittedReason ?? (approved ? null : unapproved(environment.name)),
    awaitingApproval: unpermittedReason === null && !approved,
    matched: null,
    // A query row is read by the press itself, synchronously and under the pin: there is no
    // instrument for it to be missing.
    idleReason: null,
    run: 'state',
  };
}

function watchRow(watch: GoalWatch, seq: number, input: SheetInput, permits: readonly RemoteRowKind[]): SheetRowPlan {
  const { environment } = input;
  const approved = input.approvals.has(`${queryDigest(watch.query, watch.presence ?? '')} ${environment.name}`);
  const unpermittedReason = unpermitted(watch.kind, permits, environment.name);
  const observable = (environment.watch?.observe ?? '').trim() !== '';
  return {
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
    matched: null,
    idleReason: null,
    run: 'watch',
  };
}

/** The delimiter guard, asked only of a check that declares an area. */
function areaFault(area: string | null): string | null {
  return area === null ? null : selectorFault(area);
}

/**
 * Why a press reads nothing on this check's row and sends nobody for it. This is the quietest shape
 * this subsystem holds: the row stays `selected`, the gate still offers to run it, the press settles
 * `ended` on the spot and the row reads as one that was never run — a sheet that looks like it ran
 * and did not.
 *
 * It is a **sentence and never a `blockedReason`**. A block is a cause no press can overcome, and
 * this one is overcome by amending the check or writing the configuration block it names; and every
 * honest prose check — which is most checks — would be caught by it, so a sheet would report "N
 * blocked" on every goal and read as a misconfiguration it is not.
 *
 * What a run carries is named by a step and by nothing else: a `suite` step's area, a `browser`
 * step's one-off script, a `screenshot` step's screen, or a `browser` step the fleet carries, which
 * the run's own agent drives. The three arms are the three ways a check names none of them, and each
 * says what would.
 * → docs/spec/36-remote-validation.md#a-row-no-press-can-read
 */
function idleReason(check: ValidationCheck, environment: EnvironmentConfig): string | null {
  const runnable = environment.validate?.browser?.runner !== undefined;
  const names =
    stepArea(check.steps) !== null ||
    stepScript(check.steps) !== null ||
    handsBackAScreen(check.steps) ||
    stepDriven(check.steps);
  if (runnable && names) return null;
  if (check.steps.length === 0)
    return (
      'this check declares no test plan, so nothing names an instrument to run it with: a `suite` step names ' +
      'an area of the project’s own browser suite, a `browser` step carries a one-off script or is driven by ' +
      'the run’s own agent, and a `screenshot` step hands a screen back. It is a person’s to carry out, ' +
      'which is what it has always ' +
      'been — a press reads nothing here and sends nobody for it.'
    );
  // The first step's own `why`, which `stepFault` already wrote and which names the configuration
  // block that would have carried it. Nothing here forms a second opinion about that.
  const why = check.steps[0]?.why ?? null;
  if (check.steps.every((step) => step.actor === 'human') && why !== null)
    return `every step of this check is a person’s — ${why} A press reads nothing here and sends nobody for it.`;
  return (
    `nothing in this check’s test plan is an instrument a run on ${environment.name} can carry: it names no ` +
    '`suite` area, no one-off script, no screen to hand back and no `browser` step the fleet carries' +
    (runnable ? '' : `, and ${environment.name} declares no "validate.browser.runner" to carry one`) +
    '. A press reads nothing here and sends nobody for it.'
  );
}

/**
 * A check whose plan **acts** on the environment, on one with no tenant. Unlike every other row on a
 * sheet a one-off script writes, and so does an agent at a browser — it navigates, uploads and clicks
 * — and the machinery that makes that safe (provisioning, reseeding, the lock and the reap window) is
 * keyed on a tenant the operator declares. So the row is `blocked` **naming the command or the
 * variable that would provide one**, never "no tenant": an operator meeting this is entitled to read
 * which line they have not written, and the harness never invents a name, because an invented one is
 * reaped within the hour and its disappearance presents as mysterious mass failure.
 *
 * A check that only runs the reviewed suite or hands a screen back never reaches this.
 * → docs/spec/36-remote-validation.md#tenants
 */
function actingTenantFault(check: ValidationCheck, tenant: SheetInput['tenant'], environment: string): string | null {
  const script = stepScript(check.steps) !== null;
  if (!script && !check.steps.some((step) => step.kind === 'browser')) return null;
  if (tenant === undefined) return null;
  if (tenant.blockedReason !== null) return tenant.blockedReason;
  if (tenant.tenant !== null && tenant.tenant !== '') return null;
  return (
    `this check ${script ? 'carries a one-off script, and a script' : 'asks for a browser step, and an agent at a browser'} ` +
    `acts on ${environment} — it arranges the data the ` +
    'check is about. Nothing here names a tenant for it to act inside: declare a literal ' +
    '"validate.tenant", a "validate.tenantEnv" naming the variable that carries one, or a ' +
    '"validate.ensureTenant" command that provisions one. The harness will not invent a name, because an ' +
    'invented tenant is reaped within the hour and its disappearance reads as mass failure.'
  );
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

/**
 * The one line the Environments card's own row carries about a sheet. It is folded **here**, on the
 * server, off the same rows the sheet card draws: a cockpit that worked it out for itself would be a
 * second opinion drawn beside the reading it describes, which is the disagreement this fold exists
 * to prevent.
 *
 * A **blocked** row is one nothing was learned from, whichever road it took there — a cause the
 * sheet settled before any press, or a run that came back having learned nothing.
 */
export function sheetFoldLine(rows: readonly SheetFoldRow[]): string | null {
  if (rows.length === 0) return null;
  const blocked = rows.filter((r) => r.blockedReason !== null || r.outcome === 'blocked').length;
  const failed = rows.filter((r) => r.blockedReason === null && r.outcome === 'failed').length;
  // A captured row is counted apart from both: it is neither a red somebody has to act on nor a row
  // nothing was learned from — it is one waiting on a person's eyes, which is its own ask.
  const captured = rows.filter((r) => r.blockedReason === null && r.outcome === 'captured').length;
  return [
    `check plan · ${count(rows.length, 'check')}`,
    ...(failed === 0 ? [] : [`${String(failed)} failed`]),
    ...(captured === 0 ? [] : [`${String(captured)} captured`]),
    ...(blocked === 0 ? [] : [`${String(blocked)} blocked`]),
  ].join(' · ');
}

/** What the fold reads, which is exactly what the card reads: a row's own block, and its reading. */
interface SheetFoldRow {
  blockedReason: string | null;
  outcome: RemoteRowOutcome | null;
}

function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}
