import { join } from 'node:path';
import type { EnvironmentConfig } from '../environments/policy.js';
import type { RemoteTenant, TenantCall, TenantLaunch, TenantStanding } from '../types.js';
import { firstLine } from '../primitives.js';
import {
  launchDir,
  readExit,
  readTail,
  runnerAlive,
  startRunner,
  type TenantExit,
  type TenantTail,
} from './tenantLog.js';

// → docs/spec/36-remote-validation.md#tenants

export interface TenantRequest {
  environment: string;
  command: string;
  /** What the command receives as `LUBBDUBB_TENANT`. Null where nothing has supplied one yet. */
  tenant: string | null;
}

export interface TenantOutcome {
  /** The name the command answered with, or the one it was handed back. Null means it did not say. */
  tenant: string | null;
  /** Why it did not work, in the words an operator is told. Null on success. */
  detail: string | null;
}

/**
 * `ensureTenant` and `reseed`, the two project-supplied commands that touch a tenant. Both are
 * operator-invoked and neither runs per arrival: provisioning is possibly very slow, and reseeding
 * is destructive to the residue an operator may still be reading.
 *
 * A command outlives the harness that started it, so each launch is named by a `TenantLaunch` the
 * caller records, and a later process `follow`s it by that record.
 * → docs/spec/36-remote-validation.md#what-the-gate-shows-while-it-runs
 */
export interface TenantKeeper {
  ensure(request: TenantRequest, launched?: (launch: TenantLaunch) => void): Promise<TenantOutcome>;
  reseed(request: TenantRequest, launched?: (launch: TenantLaunch) => void): Promise<TenantOutcome>;
  /** A launch an earlier process started. Null where it is gone and left no outcome behind. */
  follow(call: TenantCall, request: TenantRequest, launch: TenantLaunch): Promise<TenantOutcome | null>;
  /** The tail of what a launch has printed, stdout and stderr together. */
  tail(environment: string, launch: TenantLaunch): TenantTail;
}

/**
 * `remoteValidation.tenantTimeoutMs`. Not the 30 seconds every other command gets: provisioning or
 * reseeding a tenant is a job of tens of minutes — this document's own account of `ensureTenant` is
 * "possibly very slow, so it is an operator-invoked setup step" — so the ordinary kill would end both
 * commands on every invocation, and the failure presents as a tenant command that will not answer.
 */
const DEFAULT_TENANT_TIMEOUT_MS = 60 * 60 * 1000;
const FOLLOW_POLL_MS = 2_000;

export class CommandTenantKeeper implements TenantKeeper {
  private readonly timeoutMs: number;
  private readonly followPollMs: number;

  constructor(private readonly opts: { repoRoot: string; logRoot: string; timeoutMs?: number; followPollMs?: number }) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TENANT_TIMEOUT_MS;
    this.followPollMs = opts.followPollMs ?? FOLLOW_POLL_MS;
  }

  ensure(request: TenantRequest, launched?: (launch: TenantLaunch) => void): Promise<TenantOutcome> {
    return this.run('ensure', request, launched);
  }

  reseed(request: TenantRequest, launched?: (launch: TenantLaunch) => void): Promise<TenantOutcome> {
    return this.run('reseed', request, launched);
  }

  async follow(call: TenantCall, request: TenantRequest, launch: TenantLaunch): Promise<TenantOutcome | null> {
    const dir = launchDir(this.opts.logRoot, request.environment, launch.id);
    let missed = 0;
    for (;;) {
      const exit = readExit(dir);
      if (exit !== null) return outcome(call, request, exit);
      missed = runnerAlive(dir, launch.pid, Date.now()) ? 0 : missed + 1;
      // Twice, a poll apart: one stale heartbeat can be a machine waking from sleep.
      if (missed >= 2) {
        const late = readExit(dir);
        return late === null ? null : outcome(call, request, late);
      }
      await new Promise((r) => setTimeout(r, this.followPollMs));
    }
  }

  tail(environment: string, launch: TenantLaunch): TenantTail {
    return readTail(launchDir(this.opts.logRoot, environment, launch.id));
  }

  private async run(
    call: TenantCall,
    request: TenantRequest,
    launched?: (launch: TenantLaunch) => void,
  ): Promise<TenantOutcome> {
    const env: NodeJS.ProcessEnv = { ...process.env, LUBBDUBB_ENVIRONMENT: request.environment };
    if (request.tenant !== null) env['LUBBDUBB_TENANT'] = request.tenant;
    const now = Date.now();
    const runner = startRunner({
      root: this.opts.logRoot,
      environment: request.environment,
      command: request.command,
      cwd: this.opts.repoRoot,
      env,
      timeoutMs: this.timeoutMs,
      now,
    });
    launched?.({ id: runner.id, pid: runner.pid, startedAt: new Date(now).toISOString() });
    await runner.exited;
    const exit = readExit(runner.dir);
    if (exit === null)
      return { tenant: null, detail: 'the runner that holds the command ended without recording how it finished.' };
    return outcome(call, request, exit);
  }
}

/**
 * The command names the tenant it provisioned, on the first line of stdout. The harness reads that
 * name and never invents one: environments commonly reap tenants matching a pattern past a short age,
 * so a harness-invented name survives about an hour and its disappearance presents as mysterious mass
 * failure.
 */
function outcome(call: TenantCall, request: TenantRequest, exit: TenantExit): TenantOutcome {
  if (exit.error !== null) return { tenant: null, detail: `the command could not start: ${exit.error}` };
  if (exit.timedOut) return { tenant: null, detail: 'the command was killed after timeout' };
  if (exit.signal !== null) return { tenant: null, detail: `the command was killed after ${exit.signal}` };
  if (exit.code !== 0)
    return {
      tenant: null,
      detail: `the command exited ${String(exit.code ?? 'unknown')}: ${firstLine(exit.stderrHead) ?? 'it printed nothing on stderr'}`,
    };
  if (call === 'reseed') return { tenant: request.tenant, detail: null };
  const named = firstLine(exit.stdoutHead);
  return named === null
    ? {
        tenant: null,
        detail:
          'the command exited 0 and named no tenant. It has to print the tenant it provisioned, ' +
          'because the harness never generates or infers one.',
      }
    : { tenant: named, detail: null };
}

/** Where a deployment's tenant-command logs live: beside the validation resources, which the harness owns. */
export function tenantLogRoot(validationRoot: string): string {
  return join(validationRoot, 'tenant-commands');
}

/** What a `tenantEnv`'s value is read out of. Injected so a test never reads the machine's own. */
export type TenantEnvironment = Record<string, string | undefined>;

interface ResolvedTenant {
  standing: TenantStanding;
  /**
   * The identifier a project-supplied command receives as `LUBBDUBB_TENANT`. It goes into the spawn
   * env and nowhere else — never into a prompt, never into the cockpit, never into a committed
   * project layer.
   */
  value: string | null;
}

/**
 * Which tenant this environment has, in whichever of the three shapes it declared, and how old it is.
 *
 * The `key` a run is locked on is never a `tenantEnv`'s value: config names the variable, so the
 * variable's own name is what a surface draws and what the lock is enforced on, and the value it
 * carries never leaves the spawn env. An environment declaring no shape at all locks on the empty
 * string, which is the absence rather than a name the harness made up.
 */
export function resolveTenant(input: {
  environment: EnvironmentConfig;
  stamped: readonly RemoteTenant[];
  now: number;
  env?: TenantEnvironment;
}): ResolvedTenant {
  const validate = input.environment.validate;
  const freshnessMs = validate?.tenantFreshnessMs ?? null;
  const stamps = input.stamped.filter((t) => t.environment === input.environment.name);

  if (validate?.tenant !== undefined)
    return dated({ tenant: validate.tenant, value: validate.tenant, stamps, freshnessMs, now: input.now });

  if (validate?.tenantEnv !== undefined) {
    const variable = validate.tenantEnv;
    const value = (input.env ?? process.env)[variable] ?? null;
    if (value === null || value.trim() === '')
      return {
        value: null,
        standing: {
          tenant: `$${variable}`,
          reseededAt: null,
          ageMs: null,
          freshnessMs,
          stale: false,
          blockedReason:
            `"${input.environment.name}" reads its tenant from the environment variable ${variable}, and ` +
            'nothing set it here. Export it before pressing — the harness never invents a tenant name, ' +
            'because an invented one is reaped within the hour and its disappearance reads as mass failure.',
        },
      };
    return dated({ tenant: `$${variable}`, value, stamps, freshnessMs, now: input.now });
  }

  if (validate?.ensureTenant !== undefined) {
    const provisioned = stamps.find((t) => t.ensuredAt !== null) ?? stamps[0];
    if (provisioned === undefined)
      return {
        value: null,
        standing: {
          tenant: null,
          reseededAt: null,
          ageMs: null,
          freshnessMs,
          stale: false,
          blockedReason:
            `"${input.environment.name}" provisions its tenant on demand and nothing has provisioned one yet. ` +
            `Run its "validate.ensureTenant" command — \`${validate.ensureTenant}\` — from this goal's sheet, ` +
            'and it will name the tenant every row here is put to.',
        },
      };
    return dated({ tenant: provisioned.tenant, value: provisioned.tenant, stamps, freshnessMs, now: input.now });
  }

  return {
    value: null,
    standing: { tenant: null, reseededAt: null, ageMs: null, freshnessMs, stale: false, blockedReason: null },
  };
}

function dated(input: {
  tenant: string;
  value: string;
  stamps: readonly RemoteTenant[];
  freshnessMs: number | null;
  now: number;
}): ResolvedTenant {
  const reseededAt = input.stamps.find((t) => t.tenant === input.tenant)?.reseededAt ?? null;
  const ageMs = reseededAt === null ? null : Math.max(0, input.now - Date.parse(reseededAt));
  return {
    value: input.value,
    standing: {
      tenant: input.tenant,
      reseededAt,
      ageMs,
      freshnessMs: input.freshnessMs,
      stale: input.freshnessMs !== null && (ageMs === null || ageMs > input.freshnessMs),
      blockedReason: null,
    },
  };
}

/**
 * What a stale tenant adds to a reading, and all it adds. Staleness is a **qualifier**, never a
 * fourth outcome: a fourth state multiplies against every row kind and every environment and needs
 * teaching to every consumer, where "failed, against a tenant 19 days old, beyond the declared 7-day
 * window" tells the reader everything without touching the state machine.
 */
export function stalenessNote(standing: TenantStanding): string | null {
  if (!standing.stale || standing.tenant === null) return null;
  const window = standing.freshnessMs === null ? null : days(standing.freshnessMs);
  const age = standing.ageMs === null ? 'never reseeded' : `${days(standing.ageMs)} old`;
  return `against \`${standing.tenant}\`, ${age}${window === null ? '' : `, beyond the declared ${window} window`}`;
}

function days(ms: number): string {
  const n = Math.max(1, Math.round(ms / 86_400_000));
  return `${String(n)} day${n === 1 ? '' : 's'}`;
}
