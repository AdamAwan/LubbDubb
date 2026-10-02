import { createHash } from 'node:crypto';
import type { ErrorRecorder } from '../../errorLog.js';
import type { EnvironmentConfig } from '../../environments/policy.js';
import type { Store } from '../../store/store.js';
import { queryDigest } from '../../store/remoteValidation.js';
import type { RemoteRunIntent, RemoteSheet, RemoteSheetRow } from '../../types.js';
import type { RemoteValidationDesk } from './desk.js';
import type { RemoteRunDesk } from './run.js';
import type { ProposalDesk } from '../../proposals/proposalDesk.js';
import { validationPlanProposalRef } from '../planApproval.js';
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
    if (
      !store.remoteValidation.listRemoteSheets().some((s) => s.goalRef === goalRef && s.environment === environmentName)
    )
      return { ok: false, code: 404, error: `no validation sheet is assembled for this goal on "${environmentName}".` };

    const refused: { queryId: string; detail: string }[] = [];
    if ((environment.validate.state?.run ?? '').trim() !== '')
      for (const query of this.unapproved(goalRef, environmentName)) {
        const ruled = await this.deps.desk.ruleStateQuery(goalRef, query, environment, true);
        if (ruled !== null && ruled.approval === null)
          refused.push({ queryId: query, detail: ruled.reading?.blocked ?? 'the dry run did not answer' });
      }

    await this.acceptCheckSet(goalRef, environmentName);
    this.addNewRows(goalRef, environment);
    const intent = store.remoteIntents.giveIntent(goalRef, environmentName, this.fingerprint(goalRef, environment));
    return { ok: true, intent, refused };
  }

  /** @public the seam the not-validating-here route records an operator's word through */
  notHere(goalRef: string, environmentName: string, note: string): RemoteRunIntent | null {
    const { store } = this.deps;
    if (
      !store.remoteValidation.listRemoteSheets().some((s) => s.goalRef === goalRef && s.environment === environmentName)
    )
      return null;
    return store.remoteIntents.markNotHere(goalRef, environmentName, note);
  }

  /**
   * The OK accepts the set the page shows if nobody has yet. Through the card's own accept where one is
   * pending, so its proposal and escalation close the ordinary way; released directly where none was
   * ever filed, because then there is nothing to close.
   */
  private async acceptCheckSet(goalRef: string, environmentName: string): Promise<void> {
    const { store } = this.deps;
    const record = store.validation.getValidationPlanRecord(goalRef);
    if (record?.authoredAt == null || record.releasedAt !== null) return;
    const number = issueOriginNumber('root', goalRef);
    const ref = number === null ? null : validationPlanProposalRef(number);
    const pending = store.escalations
      .listProposals()
      .find((p) => p.kind === 'validation_plan' && p.status === 'pending' && p.ref === ref);
    if (pending === undefined) store.validation.releaseValidationPlan(goalRef);
    else await this.deps.proposals.accept(pending.id, `Accepted with the OK on ${environmentName}.`);
  }

  /** Rows the fold holds and the sheet does not yet — a check authored since the sheet was assembled. */
  private addNewRows(goalRef: string, environment: EnvironmentConfig): void {
    const { remoteValidation } = this.deps.store;
    const held = new Set(
      remoteValidation
        .listRemoteSheetRows()
        .filter((r) => r.goalRef === goalRef && r.environment === environment.name)
        .map((r) => r.rowId),
    );
    const fresh = this.deps.desk
      .fold(environment, goalRef)
      .filter((r) => !held.has(r.rowId))
      .map(({ run: _run, ...row }) => row);
    if (fresh.length > 0) remoteValidation.saveRemoteSheetRows(goalRef, environment.name, fresh);
  }

  /** @public the seam the withdraw route takes an OK back through */
  withdraw(goalRef: string, environmentName: string): RemoteRunIntent | null {
    return this.deps.store.remoteIntents.withdrawIntent(goalRef, environmentName);
  }

  /** The pulse's arm: press every given intent that can be pressed, and say why of every one that cannot. */
  async run(): Promise<void> {
    for (const intent of this.deps.store.remoteIntents.listIntents()) {
      if (intent.state !== 'given') continue;
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
      store.remoteIntents.lapseIntent(
        goalRef,
        environment,
        'the page has changed since the OK was given — read it again and give it again.',
      );
      return;
    }
    const standing = runs.standing(environment);
    if (standing.blockedReason !== null)
      return store.remoteIntents.noteIntent(goalRef, environment, standing.blockedReason);
    const live = store.remoteValidation.liveRemoteRun(environment, standing.tenant ?? '');
    if (live !== null)
      return store.remoteIntents.noteIntent(goalRef, environment, `queued behind the run for ${live.goalRef}.`);

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
    const watches = new Map(
      store.watches
        .listGoalWatches()
        .filter((w) => w.originRef === goalRef)
        .map((w) => [w.id, queryDigest(w.query, w.presence ?? '')]),
    );
    const parts = this.deps.desk
      .fold(environment, goalRef)
      .map((r) => {
        if (r.kind === 'check') {
          const c = checks.get(r.sourceId);
          return `${r.rowId}\x00${JSON.stringify(c === undefined ? null : [c.title, c.do, c.expect, c.proof, c.steps])}`;
        }
        return `${r.rowId}\x00${(r.kind === 'state' ? queries : watches).get(r.sourceId) ?? ''}`;
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
 * Each goal's environments whose sheet holds a row to OK and has no OK: no intent at all, or one taken
 * back. A sheet with nothing to OK holds nothing. → docs/spec/36-remote-validation.md#the-ok
 */
export function sheetsAwaitingOk(
  sheets: readonly RemoteSheet[],
  rows: readonly RemoteSheetRow[],
  intents: readonly RemoteRunIntent[],
): Map<string, string[]> {
  const answered = new Set(intents.filter((i) => i.state !== 'withdrawn').map((i) => `${i.goalRef} ${i.environment}`));
  const asking = new Set(rows.filter(okable).map((r) => `${r.goalRef} ${r.environment}`));
  const out = new Map<string, string[]>();
  for (const sheet of sheets) {
    const key = `${sheet.goalRef} ${sheet.environment}`;
    if (answered.has(key) || !asking.has(key)) continue;
    out.set(sheet.goalRef, [...(out.get(sheet.goalRef) ?? []), sheet.environment]);
  }
  return out;
}
