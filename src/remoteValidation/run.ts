import { EventEmitter } from 'node:events';
import type { ErrorRecorder } from '../errorLog.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import type { EnvironmentProber } from '../environments/prober.js';
import type { GitObserver } from '../git/gitObserver.js';
import type { Store } from '../store/store.js';
import type { RemoteRun, RemoteSheetRow, TenantCall, TenantLaunch, TenantStanding } from '../types.js';
import { runnableDrives, runnableScreens, runnableScripts, runnableSelectors } from './briefing.js';
import type { RemoteValidationDesk } from './desk.js';
import { rowRun } from './sheet.js';
import { resolveTenant, stalenessNote, type TenantEnvironment, type TenantKeeper } from './tenants.js';

// → docs/spec/36-remote-validation.md#the-press

interface RemoteRunDeps {
  store: Store;
  environments: readonly EnvironmentConfig[];
  desk: RemoteValidationDesk;
  prober: EnvironmentProber;
  git: GitObserver;
  tenants: TenantKeeper;
  errors?: ErrorRecorder;
  now?: () => number;
  /** Where a `tenantEnv`'s value is read from. Injected so a test never reads the machine's own. */
  env?: TenantEnvironment;
}

/** A refusal is a returned value, never a throw — the route turns `code` into its status. */
interface PressRefusal {
  ok: false;
  code: 400 | 404 | 409;
  error: string;
  live?: RemoteRun;
}

interface PressResult {
  ok: true;
  run: RemoteRun;
  /** Non-null where the pin abandoned the press: it ran nothing and this is why. */
  abandoned: string | null;
  read: number;
  /** How many confirmed `check` rows the run is left open for an agent to carry out. */
  owed: number;
}

/**
 * The press, the pin and the lock. A press re-runs the sheet's confirmed **deterministic** rows
 * synchronously under the pin — they are read-only, consented and cheap — and leaves the run row
 * `pending` where a confirmed `check` row is owed the agent rule `remote-validation` dispatches.
 */
export class RemoteRunDesk extends EventEmitter {
  private readonly now: () => number;

  constructor(private readonly deps: RemoteRunDeps) {
    super();
    this.now = deps.now ?? (() => Date.now());
  }

  /** `tenantSettled`: a preparation finished, so every surface drawing it is stale. */
  override emit(event: 'tenantSettled'): boolean;
  override emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }
  override on(event: 'tenantSettled', cb: () => void): this;
  override on(event: string, cb: (...args: unknown[]) => void): this {
    return super.on(event, cb);
  }

  /** @public the seam the press route runs a cycle through */
  async press(goalRef: string, environmentName: string): Promise<PressResult | PressRefusal> {
    const environment = this.deps.environments.find((e) => e.name === environmentName);
    if (environment?.validate === undefined)
      return {
        ok: false,
        code: 409,
        error: `"${environmentName}" declares no "validate" block, so there is no sheet here to press.`,
      };
    const { store } = this.deps;
    if (
      !store.remoteValidation.listRemoteSheets().some((s) => s.goalRef === goalRef && s.environment === environmentName)
    )
      return { ok: false, code: 404, error: `no validation sheet is assembled for this goal on "${environmentName}".` };

    const rows = store.remoteValidation
      .listRemoteSheetRows()
      .filter((r) => r.goalRef === goalRef && r.environment === environmentName && r.selected);
    if (rows.length === 0)
      return {
        ok: false,
        code: 400,
        error:
          'nothing on this sheet is selected. A press with no row selected would open a run that learns ' +
          'nothing — take a row back first.',
      };

    const tenant = resolveTenant({
      environment,
      stamped: store.remoteValidation.listRemoteTenants(),
      now: this.now(),
      env: this.deps.env,
    });
    if (tenant.standing.blockedReason !== null) {
      for (const row of rows)
        store.remoteValidation.blockRemoteSheetRow(goalRef, environmentName, row.rowId, tenant.standing.blockedReason);
      return { ok: false, code: 400, error: tenant.standing.blockedReason };
    }
    const key = tenant.standing.tenant ?? '';

    const pin = await this.pin(goalRef, environment);

    const { run, live } = store.remoteValidation.beginRemoteRun({
      goalRef,
      environment: environmentName,
      tenant: key,
      startedSha: pin.deployedSha,
    });
    if (run === null)
      return {
        ok: false,
        code: 409,
        error:
          `a run is already live on "${environmentName}" against ${named(live?.tenant ?? key)} — it started at ` +
          `${live?.startedAt ?? 'an earlier moment'}. Call that one off first if you want to press again.`,
        ...(live === null || live === undefined ? {} : { live }),
      };

    if (pin.abandon !== null) {
      const ended = store.remoteValidation.endRemoteRun(run.id, { status: 'abandoned', note: pin.abandon });
      return { ok: true, run: ended ?? run, abandoned: pin.abandon, read: 0, owed: 0 };
    }

    const read = await this.readAll(environment, goalRef, run, rows, tenant.standing);

    // The deterministic rows are read here, synchronously and under the pin: they are read-only,
    // consented and cheap, and the agent is for the browser half. The run the rule dispatches for is
    // **this** row — it is left `pending` where a confirmed `check` row is owed one, and settled here
    // where none is, which is a run nothing will ever report against.
    // Both browser instruments count, and so does a screen. A sheet whose only confirmed check
    // carries a one-off script names no selector at all, and one whose check only hands a screen back
    // names neither, and one the agent drives itself at the browser names none of the three — a press
    // counting selectors alone would settle that run on the spot with its whole browser half still
    // owed, which is a press that quietly did less than it said.
    const owed =
      runnableSelectors(store, environment, goalRef, rows).length +
      runnableScripts(store, environment, goalRef, rows).length +
      runnableScreens(store, environment, goalRef, rows).length +
      runnableDrives(store, environment, goalRef, rows).length;
    if (owed > 0) return { ok: true, run, abandoned: null, read, owed };

    const endedSha = await this.deployedSha(environment);
    store.remoteValidation.attributeRemoteReadings(run.id, endedSha);
    const ended = store.remoteValidation.endRemoteRun(run.id, { status: 'ended', endedSha });
    return { ok: true, run: ended ?? run, abandoned: null, read, owed: 0 };
  }

  /** @public the seam the cancel route settles a run an operator abandoned by hand through */
  cancel(environmentName: string, tenantKey: string | null): RemoteRun | null {
    const environment = this.deps.environments.find((e) => e.name === environmentName);
    if (environment === undefined) return null;
    const key =
      tenantKey ??
      resolveTenant({
        environment,
        stamped: this.deps.store.remoteValidation.listRemoteTenants(),
        now: this.now(),
        env: this.deps.env,
      }).standing.tenant ??
      '';
    const live = this.deps.store.remoteValidation.liveRemoteRun(environmentName, key);
    if (live === null) return null;
    return this.deps.store.remoteValidation.endRemoteRun(live.id, {
      status: 'abandoned',
      note: 'an operator called this run off from the sheet.',
    });
  }

  /**
   * The gate's own entry point. `prepareTenant` awaits commands that run for **tens of minutes**, so
   * an HTTP request that waited on it would be a request no proxy keeps open and no reload survives —
   * an operator who pressed reseed and then refreshed would have destroyed their tenant with nothing
   * on screen to say so. This opens the record first, returns, and settles it when the commands
   * answer; the gate reads the record, so the press survives a reload and a second browser.
   *
   * @public the seam the reseed route starts a preparation through
   */
  beginPrepareTenant(
    environmentName: string,
    onSettled: () => void = () => {},
  ): { started: boolean; detail: string; standing: TenantStanding } {
    const opened = this.deps.store.remoteValidation.beginTenantPrepare(environmentName);
    if (opened === null)
      return {
        started: false,
        detail: `a tenant preparation is already running against "${environmentName}". Wait for it rather than starting a second one over the same tenant.`,
        standing: this.standing(environmentName),
      };
    this.settle(environmentName, this.prepareTenant(environmentName), onSettled);
    return {
      started: true,
      detail: 'the environment’s own tenant commands are running.',
      standing: this.standing(environmentName),
    };
  }

  /**
   * At boot: every preparation the last process left open. A command outlives the harness that
   * started it, so a row whose runner is still beating stays open — and keeps refusing a second press
   * over the same tenant — while this process follows it to the end. Only a row with no launch on
   * record, or whose runner is gone with no outcome, is closed as not knowable from here.
   *
   * @public the seam `buildSystem` resumes preparations through
   */
  resumeTenantPrepares(onSettled: () => void = () => {}): void {
    for (const open of this.deps.store.remoteValidation.openTenantPrepares()) {
      if (open.launched === null) {
        this.deps.store.remoteValidation.closeOrphanedTenantPrepare(open.environment);
        continue;
      }
      this.settle(open.environment, this.prepareTenant(open.environment, open.launched), onSettled);
    }
  }

  /** @public the seam the tenant-command output route reads through */
  tenantOutput(environmentName: string): { lines: string[]; lastOutputAt: string | null } {
    const launched = this.deps.store.remoteValidation.tenantLaunch(environmentName);
    if (launched === null) return { lines: [], lastOutputAt: null };
    return this.deps.tenants.tail(environmentName, launched.launch);
  }

  private standing(environmentName: string): TenantStanding {
    const environment = this.deps.environments.find((e) => e.name === environmentName);
    return environment === undefined
      ? absent()
      : resolveTenant({
          environment,
          stamped: this.deps.store.remoteValidation.listRemoteTenants(),
          now: this.now(),
          env: this.deps.env,
        }).standing;
  }

  private settle(
    environmentName: string,
    running: Promise<{ ok: boolean | null; detail: string; standing: TenantStanding }>,
    onSettled: () => void,
  ): void {
    void running
      .then((outcome) => {
        this.deps.store.remoteValidation.finishTenantPrepare({
          environment: environmentName,
          tenant: outcome.standing.tenant,
          ok: outcome.ok,
          detail: outcome.detail,
        });
      })
      .catch((err: unknown) => {
        // Never a swallowed catch: the operator is told, and the harness records it.
        // → docs/spec/18-observability.md
        this.deps.errors?.record({
          source: 'cycle',
          message: `the tenant commands for ${environmentName} threw: ${(err as Error).message}`,
        });
        this.deps.store.remoteValidation.finishTenantPrepare({
          environment: environmentName,
          tenant: this.standing(environmentName).tenant,
          ok: false,
          detail: `the tenant commands threw — ${err instanceof Error ? err.message : String(err)}`,
        });
      })
      .finally(() => {
        this.emit('tenantSettled');
        onSettled();
      });
  }

  /**
   * Provisioning and reseeding, the two operator acts on a tenant. Both are invoked from the gate and
   * neither runs per arrival: provisioning is possibly very slow, and reseeding destroys the residue
   * an operator may still be reading. The name stamped is always the one the project's own command
   * gave back — the harness generates or infers no tenant identifier, anywhere.
   *
   * `resumed` is a launch an earlier process started: that command is followed rather than started
   * again, and the preparation carries on from it.
   */
  async prepareTenant(
    environmentName: string,
    resumed: { call: TenantCall; launch: TenantLaunch } | null = null,
  ): Promise<{ ok: boolean | null; detail: string; standing: TenantStanding }> {
    const environment = this.deps.environments.find((e) => e.name === environmentName);
    const validate = environment?.validate;
    if (environment === undefined || validate === undefined)
      return {
        ok: false,
        detail: `"${environmentName}" declares no "validate" block, so it has no tenant to prepare.`,
        standing: absent(),
      };

    const standing = (): TenantStanding => this.standing(environmentName);
    const launched =
      (call: TenantCall) =>
      (launch: TenantLaunch): void =>
        this.deps.store.remoteValidation.recordTenantLaunch(environmentName, call, launch);
    const gone = (): { ok: null; detail: string; standing: TenantStanding } => ({
      ok: null,
      detail:
        'The harness restarted while this was running, and the command is no longer running. Whether it ' +
        'finished is not known from here — read its output and the tenant’s age, or run it again.',
      standing: standing(),
    });

    const said: string[] = [];
    if (validate.ensureTenant !== undefined && resumed?.call !== 'reseed') {
      const request = { environment: environmentName, command: validate.ensureTenant, tenant: standing().tenant };
      const provisioned =
        resumed === null
          ? await this.deps.tenants.ensure(request, launched('ensure'))
          : await this.deps.tenants.follow('ensure', request, resumed.launch);
      if (provisioned === null) return gone();
      if (provisioned.detail !== null || provisioned.tenant === null)
        return {
          ok: false,
          detail: `the "ensureTenant" command did not provide a tenant — ${provisioned.detail ?? 'it named none'}`,
          standing: standing(),
        };
      this.deps.store.remoteValidation.stampRemoteTenant({
        environment: environmentName,
        tenant: provisioned.tenant,
        ensured: true,
      });
      said.push(`\`${provisioned.tenant}\` is provisioned`);
    }

    const resolved = resolveTenant({
      environment,
      stamped: this.deps.store.remoteValidation.listRemoteTenants(),
      now: this.now(),
      env: this.deps.env,
    });
    if (validate.reseed !== undefined) {
      if (resolved.standing.tenant === null || resolved.value === null)
        return {
          ok: false,
          detail:
            resolved.standing.blockedReason ??
            `"${environmentName}" declares a reseed and nothing has supplied a tenant to reseed.`,
          standing: resolved.standing,
        };
      const request = { environment: environmentName, command: validate.reseed, tenant: resolved.value };
      const reseeded =
        resumed?.call === 'reseed'
          ? await this.deps.tenants.follow('reseed', request, resumed.launch)
          : await this.deps.tenants.reseed(request, launched('reseed'));
      if (reseeded === null) return gone();
      if (reseeded.detail !== null)
        return { ok: false, detail: `the reseed did not run — ${reseeded.detail}`, standing: resolved.standing };
      this.deps.store.remoteValidation.stampRemoteTenant({
        environment: environmentName,
        tenant: resolved.standing.tenant,
        reseeded: true,
      });
      said.push(`\`${resolved.standing.tenant}\` is reseeded`);
    }

    if (said.length === 0)
      return {
        ok: false,
        detail: `"${environmentName}" declares neither an "ensureTenant" nor a "reseed", so there is nothing to run.`,
        standing: resolved.standing,
      };
    return { ok: true, detail: `${said.join(' and ')}.`, standing: standing() };
  }

  /**
   * Is this goal's work still in the deployed commit? Not *is the sha the one the sheet was assembled
   * against*: an environment that has moved **forward** still contains the work, so the reading
   * stands. That is the whole difference from [32](docs/spec/32-local-validation.md#the-pin)'s pin,
   * where a moved checkout is a different subject — a deployed environment is *supposed* to move, and
   * a design that abandoned on sha inequality would starve any project that deploys faster than it
   * validates.
   *
   * `contains` is three-valued and `unknown` is folded into neither arm: an expired credential, a
   * missing binary and a commit that genuinely has not shipped all fail the same way, and only the
   * last is about deployment.
   */
  private async pin(
    goalRef: string,
    environment: EnvironmentConfig,
  ): Promise<{ deployedSha: string | null; abandon: string | null }> {
    const head = await this.deps.prober.at(environment.name, environment.at);
    const deployed = head.commits ?? [];
    if (deployed.length === 0)
      return {
        deployedSha: null,
        abandon:
          `"${environment.name}" did not say which commit it stands at — ${head.detail ?? 'the probe named no commit'}. ` +
          'Nothing was run, because a reading of a product nobody can name is not a reading.',
      };
    const deployedSha = deployed[0]!;

    const landings = this.deps.store.environments
      .listGoalLandings()
      .filter((l) => l.goalRef === goalRef && l.onIntegration !== false)
      .map((l) => l.sha);
    if (landings.length === 0)
      return {
        deployedSha,
        abandon:
          'nothing is recorded as having landed for this goal, so there is no work to ask whether this ' +
          'environment still holds. Nothing was run.',
      };

    const said = await this.deps.git.contains(landings, deployed);
    const unknown = landings.filter((sha) => (said.get(sha) ?? null) === null);
    if (unknown.length > 0)
      return {
        deployedSha,
        abandon:
          `the clone could not say whether ${environment.name} still holds ${shas(unknown)} — an expired ` +
          'credential, a missing binary and a commit that never shipped all fail this way, and only the last ' +
          'is about deployment. Nothing was run, because an unknown is not an assumed present.',
      };
    const gone = landings.filter((sha) => said.get(sha) === false);
    if (gone.length > 0)
      return {
        deployedSha,
        abandon:
          `${environment.name} has gone back past this goal's work — it stands at ${short(deployedSha)}, which ` +
          `no longer holds ${shas(gone)}. Nothing was run, because a reading here would be of a product this ` +
          'goal is not in.',
      };
    return { deployedSha, abandon: null };
  }

  private async readAll(
    environment: EnvironmentConfig,
    goalRef: string,
    run: RemoteRun,
    rows: readonly RemoteSheetRow[],
    tenant: TenantStanding,
  ): Promise<number> {
    const stale = stalenessNote(tenant);
    let read = 0;
    for (const row of rows) {
      const runs = rowRun(row.rowId);
      if (runs === null || row.blockedReason !== null) continue;
      try {
        const reading = await this.deps.desk.readRow(environment, goalRef, runs, row.sourceId);
        if (reading === null) continue;
        if (reading.outcome === 'blocked') {
          this.deps.store.remoteValidation.blockRemoteSheetRow(
            goalRef,
            environment.name,
            row.rowId,
            qualified(reading.detail, stale) ?? 'no reading was taken',
          );
          continue;
        }
        this.deps.store.remoteValidation.recordRemoteReading({
          goalRef,
          environment: environment.name,
          rowId: row.rowId,
          runId: run.id,
          outcome: reading.outcome,
          rows: reading.rows,
          value: reading.value,
          detail: qualified(reading.detail, stale),
          startedSha: run.startedSha,
          endedSha: null,
          // A deterministic row is a query, not a suite: nothing here matched, ran or published.
          executed: null,
          retries: null,
          durationMs: null,
          artefacts: null,
          capture: null,
        });
        read += 1;
      } catch (err) {
        this.deps.errors?.record({
          source: 'cycle',
          message: `reading ${row.rowId} on ${environment.name} for ${goalRef} failed: ${(err as Error).message}`,
        });
      }
    }
    return read;
  }

  private async deployedSha(environment: EnvironmentConfig): Promise<string | null> {
    const head = await this.deps.prober.at(environment.name, environment.at);
    return head.commits?.[0] ?? null;
  }
}

/**
 * Staleness is a qualifier on the reading and never a fourth outcome — the vocabulary stays
 * `passed | failed | blocked`.
 */
function qualified(detail: string | null, stale: string | null): string | null {
  if (stale === null) return detail;
  return detail === null ? `Read ${stale}.` : `${detail} Read ${stale}.`;
}

function named(tenant: string | null): string {
  return tenant === null || tenant === '' ? 'no tenant (this environment declares none)' : `\`${tenant}\``;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function shas(list: readonly string[]): string {
  return list.map(short).join(', ');
}

function absent(): TenantStanding {
  return { tenant: null, reseededAt: null, ageMs: null, freshnessMs: null, stale: false, blockedReason: null };
}
