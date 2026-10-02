import { createHash } from 'node:crypto';
import type { ErrorRecorder } from '../../errorLog.js';
import type { EnvironmentConfig } from '../../environments/policy.js';
import type { Store } from '../../store/store.js';
import { queryDigest } from '../../store/remoteValidation.js';
import type { RemoteRunIntent } from '../../types.js';
import type { RemoteValidationDesk } from './desk.js';
import type { RemoteRunDesk } from './run.js';

// → docs/spec/36-remote-validation.md#the-ok

interface RemoteIntentDeps {
  store: Store;
  environments: readonly EnvironmentConfig[];
  desk: RemoteValidationDesk;
  runs: RemoteRunDesk;
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

    const intent = store.remoteIntents.giveIntent(goalRef, environmentName, this.fingerprint(goalRef, environmentName));
    return { ok: true, intent, refused };
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
    if (this.fingerprint(goalRef, environment) !== intent.fingerprint)
      return store.remoteIntents.noteIntent(
        goalRef,
        environment,
        'the page has changed since the OK was given — read it again and give it again.',
      );
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
  private fingerprint(goalRef: string, environmentName: string): string {
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
    const parts = store.remoteValidation
      .listRemoteSheetRows()
      .filter((r) => r.goalRef === goalRef && r.environment === environmentName)
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
