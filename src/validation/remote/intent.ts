import { createHash } from 'node:crypto';
import type { ErrorRecorder } from '../../errorLog.js';
import type { EnvironmentConfig } from '../../environments/policy.js';
import type { Store } from '../../store/store.js';
import type { OkStanding, RemoteRun, RemoteRunIntent, RemoteSheet, RemoteSheetRow } from '../../types.js';
import type { RemoteValidationDesk } from './desk.js';
import type { RemoteRunDesk } from './run.js';
import type { ProposalDesk } from '../../proposals/proposalDesk.js';
import { checkSetStanding, pendingValidationPlanProposal, validationPlanProposalRef } from '../planApproval.js';
import { checkTerms } from '../checkMerge.js';
import { noSheetAssembled } from './sheet.js';
import { issueOriginNumber } from '../../issueOrigins.js';

// → docs/spec/36-remote-validation.md#the-ok

interface RemoteIntentDeps {
  store: Store;
  environments: readonly EnvironmentConfig[];
  desk: RemoteValidationDesk;
  runs: RemoteRunDesk;
  /** Accepts the goal's check set through the card's own path, so its proposal and escalation close. */
  proposals: Pick<ProposalDesk, 'accept'>;
  errors?: ErrorRecorder;
}

type OkResult =
  | { ok: true; intent: RemoteRunIntent; refused: { queryId: string; detail: string }[] }
  | { ok: false; code: 404 | 409; error: string };

/**
 * The OK and what follows it. An operator answers a sheet once: every `state` query not yet approved
 * here is dry-run and approved where it answered, and an intent is written over what the page held.
 * The pulse then presses each given intent whose tenant is resolved and whose lock is free.
 */
export class RemoteIntentDesk {
  constructor(private readonly deps: RemoteIntentDeps) {}

  /** @public the seam the OK route gives an operator's OK through */
  async give(goalRef: string, environmentName: string): Promise<OkResult> {
    const { store } = this.deps;
    const environment = this.deps.environments.find((e) => e.name === environmentName);
    if (environment?.validate === undefined)
      return { ok: false, code: 409, error: `"${environmentName}" declares no "validate" block.` };
    if (!this.deps.desk.hasSheet(goalRef, environmentName))
      return { ok: false, code: 404, error: noSheetAssembled(environmentName) };

    const refused: { queryId: string; detail: string }[] = [];
    for (const query of this.unapproved(goalRef, environmentName)) {
      const ruled = await this.deps.desk.ruleStateQuery(goalRef, query, environment, true);
      if (ruled !== null && ruled.approval === null)
        refused.push({ queryId: query, detail: ruled.reading?.blocked ?? 'the dry run did not answer' });
    }

    await this.acceptCheckSet(goalRef, environmentName);
    this.deps.desk.adoptNewRows(goalRef, environment);
    const intent = store.remoteIntents.giveIntent(goalRef, environmentName, this.fingerprint(goalRef, environment));
    return { ok: true, intent, refused };
  }

  /** @public the seam the not-validating-here route records an operator's word through */
  notHere(goalRef: string, environmentName: string, note: string): RemoteRunIntent | null {
    if (!this.deps.desk.hasSheet(goalRef, environmentName)) return null;
    return this.deps.store.remoteIntents.markNotHere(goalRef, environmentName, note);
  }

  /**
   * The OK accepts the set the page shows if nobody has yet. Through the card's own accept where one is
   * pending, so its proposal and escalation close the ordinary way; released directly where none was
   * ever filed, because then there is nothing to close.
   */
  private async acceptCheckSet(goalRef: string, environmentName: string): Promise<void> {
    const { store } = this.deps;
    const standing = checkSetStanding(store.validation.getValidationPlanRecord(goalRef), () =>
      store.validation.listValidationChecks(goalRef),
    );
    if (standing.accepted || standing.authoredAt === null) return;
    const number = issueOriginNumber('root', goalRef);
    const pending =
      number === null
        ? null
        : pendingValidationPlanProposal(validationPlanProposalRef(number), store.escalations.listProposals());
    if (pending === null) store.validation.releaseValidationPlan(goalRef);
    else await this.deps.proposals.accept(pending.id, `Accepted with the OK on ${environmentName}.`);
  }

  /** @public the seam the withdraw route takes an OK back through */
  withdraw(goalRef: string, environmentName: string): RemoteRunIntent | null {
    return this.deps.store.remoteIntents.withdrawIntent(goalRef, environmentName);
  }

  /** The pulse's arm: press every given intent that can be pressed, and say why of every one that cannot. */
  async run(): Promise<void> {
    for (const intent of this.deps.store.remoteIntents.listGivenIntents()) {
      try {
        await this.press(intent);
      } catch (err) {
        this.deps.errors?.record({
          source: 'cycle',
          message: `pressing the OK'd sheet for ${intent.goalRef} on ${intent.environment} failed: ${(err as Error).message}`,
        });
      }
    }
  }

  private async press(intent: RemoteRunIntent): Promise<void> {
    const { store, runs } = this.deps;
    const { goalRef, environment } = intent;
    const config = this.deps.environments.find((e) => e.name === environment);
    if (config?.validate === undefined)
      return store.remoteIntents.noteIntent(
        goalRef,
        environment,
        `"${environment}" no longer declares a "validate" block.`,
      );
    if (this.fingerprint(goalRef, config) !== intent.fingerprint) {
      store.remoteIntents.withdrawIntent(
        goalRef,
        environment,
        'the page has changed since the OK was given — read it again and give it again.',
      );
      return;
    }
    const waiting = runs.waitReason(environment);
    if (waiting !== null) return store.remoteIntents.noteIntent(goalRef, environment, waiting);

    const pressed = await runs.press(goalRef, environment);
    if (pressed.ok) store.remoteIntents.consumeIntent(goalRef, environment, pressed.run.id);
    else store.remoteIntents.noteIntent(goalRef, environment, pressed.error);
  }

  private unapproved(goalRef: string, environmentName: string): string[] {
    const { remoteValidation } = this.deps.store;
    const approved = new Set(
      remoteValidation
        .listStateQueryApprovals()
        .filter((a) => a.environment === environmentName)
        .map((a) => a.digest),
    );
    return remoteValidation
      .listStateQueries()
      .filter((q) => q.originRef === goalRef && !approved.has(q.digest))
      .map((q) => q.id);
  }

  /**
   * What the OK was given over: every row on the sheet, read through the text an operator saw. A check
   * is its wording and steps, a query its digest — so a re-authored set, an amended check or an edited
   * query moves it, and a reading, a selection or an approval does not.
   */
  private fingerprint(goalRef: string, environment: EnvironmentConfig): string {
    const { store } = this.deps;
    const checks = new Map(store.validation.listValidationChecks(goalRef).map((c) => [c.id, c]));
    const queries = new Map(
      store.remoteValidation
        .listStateQueries()
        .filter((q) => q.originRef === goalRef)
        .map((q) => [q.id, q.digest]),
    );
    const parts = this.deps.desk
      .fold(environment, goalRef)
      .map((r) => {
        if (r.kind === 'check') {
          const c = checks.get(r.sourceId);
          return `${r.rowId}\x00${JSON.stringify(c === undefined ? null : [...checkTerms(c), c.steps])}`;
        }
        return `${r.rowId}\x00${queries.get(r.sourceId) ?? ''}`;
      })
      .sort();
    return createHash('sha256').update(parts.join('\x01')).digest('hex').slice(0, 32);
  }
}

/**
 * A row there is something to OK for: one a press would read or hand an agent, or a query still waiting
 * for its approval here. A row blocked for any other reason, or a person's, is not asked about.
 */
export function okable(row: RemoteSheetRow): boolean {
  return row.selected && row.idleReason === null && (row.blockedReason === null || row.awaitingApproval);
}

/**
 * Where one page stands, off its intent, its latest run and its rows. An OK whose run was abandoned
 * comes back to the operator with the run's reason; a consumed intent with no run is one written on
 * ship day for a sheet from before the OK, answered but runnable. → docs/spec/36-remote-validation.md#the-ok
 */
export function okStanding(input: {
  rows: readonly RemoteSheetRow[];
  intent: RemoteRunIntent | null;
  run: RemoteRun | null;
}): OkStanding {
  const { rows, intent, run } = input;
  if (run?.status === 'pending' || run?.status === 'dispatched') return { status: 'running', why: null };
  const answered = intent === null ? null : intentStanding(intent, run);
  if (answered !== null) return answered;
  if (!rows.some(okable)) return { status: 'nothing', why: null };
  if (intent?.state === 'consumed') return { status: 'open', why: null };
  return { status: 'needs-you', why: intent?.note ?? null };
}

/** Where an OK, a not-here or a consumed OK puts the page; null where the page still turns on its rows. */
function intentStanding(intent: RemoteRunIntent, run: RemoteRun | null): OkStanding | null {
  if (intent.state === 'not_here') return { status: 'not-here', why: intent.note };
  if (intent.state === 'given') return { status: 'queued', why: intent.note };
  if (intent.state === 'consumed' && intent.runId !== null) return consumedStanding(run, intent.runId);
  return null;
}

function consumedStanding(run: RemoteRun | null, runId: string): OkStanding {
  if (run?.id !== runId || run.status !== 'abandoned') return { status: 'done', why: null };
  return { status: 'needs-you', why: run.note ?? 'the run was called off before it finished' };
}

/**
 * Each goal's environments whose page needs the operator's OK — the one standing the cockpit draws as
 * _needs you_. A sheet with nothing to OK holds nothing. → docs/spec/36-remote-validation.md#the-ok
 */
export function sheetsAwaitingOk(input: {
  sheets: readonly RemoteSheet[];
  rows: readonly RemoteSheetRow[];
  intents: readonly RemoteRunIntent[];
  runs: readonly RemoteRun[];
}): Map<string, string[]> {
  const key = (x: { goalRef: string; environment: string }) => `${x.goalRef} ${x.environment}`;
  const intents = new Map(input.intents.map((i) => [key(i), i]));
  const latest = new Map(input.runs.map((r) => [key(r), r]));
  const rows = new Map<string, RemoteSheetRow[]>();
  for (const row of input.rows) rows.set(key(row), [...(rows.get(key(row)) ?? []), row]);
  const out = new Map<string, string[]>();
  for (const sheet of input.sheets) {
    const k = key(sheet);
    const standing = okStanding({
      rows: rows.get(k) ?? [],
      intent: intents.get(k) ?? null,
      run: latest.get(k) ?? null,
    });
    if (standing.status !== 'needs-you') continue;
    out.set(sheet.goalRef, [...(out.get(sheet.goalRef) ?? []), sheet.environment]);
  }
  return out;
}
