import { exec } from 'node:child_process';
import type { EnvironmentConfig } from '../environments/policy.js';
import type { RemoteTenant, TenantStanding } from '../types.js';

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
 */
export interface TenantKeeper {
  ensure(request: TenantRequest): Promise<TenantOutcome>;
  reseed(request: TenantRequest): Promise<TenantOutcome>;
}

/**
 * `remoteValidation.tenantTimeoutMs`. Not the 30 seconds every other command gets: provisioning or
 * reseeding a tenant is a job of tens of minutes — this document's own account of `ensureTenant` is
 * "possibly very slow, so it is an operator-invoked setup step" — so the ordinary kill would end both
 * commands on every invocation, and the failure presents as a tenant command that will not answer.
 */
const DEFAULT_TENANT_TIMEOUT_MS = 60 * 60 * 1000;

export class CommandTenantKeeper implements TenantKeeper {
  constructor(
    private readonly repoRoot: string,
    private readonly timeoutMs: number = DEFAULT_TENANT_TIMEOUT_MS,
  ) {}

  /**
   * The command names the tenant it provisioned, on stdout. The harness reads that name and never
   * invents one: environments commonly reap tenants matching a pattern past a short age, so a
   * harness-invented name survives about an hour and its disappearance presents as mysterious mass
   * failure.
   */
  ensure(request: TenantRequest): Promise<TenantOutcome> {
    return this.run(request, (stdout) => {
      const named = firstLine(stdout);
      return named === null
        ? {
            tenant: null,
            detail:
              'the command exited 0 and named no tenant. It has to print the tenant it provisioned, ' +
              'because the harness never generates or infers one.',
          }
        : { tenant: named, detail: null };
    });
  }

  reseed(request: TenantRequest): Promise<TenantOutcome> {
    return this.run(request, () => ({ tenant: request.tenant, detail: null }));
  }

  private run(request: TenantRequest, done: (stdout: string) => TenantOutcome): Promise<TenantOutcome> {
    return new Promise((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env, LUBBDUBB_ENVIRONMENT: request.environment };
      if (request.tenant !== null) env['LUBBDUBB_TENANT'] = request.tenant;
      exec(
        request.command,
        { cwd: this.repoRoot, timeout: this.timeoutMs, windowsHide: true, env },
        (err, stdout, stderr) => {
          if (err !== null) return resolve({ tenant: null, detail: failure(err as ExecFailure, stderr) });
          resolve(done(stdout));
        },
      );
    });
  }
}

interface ExecFailure extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

function failure(err: ExecFailure, stderr: string): string {
  if (err.killed === true || (err.signal !== null && err.signal !== undefined))
    return `the command was killed after ${err.signal ?? 'timeout'}`;
  return `the command exited ${String(err.code ?? 'unknown')}: ${firstLine(stderr) ?? err.message}`;
}

function firstLine(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return line === undefined ? null : line.trim().slice(0, 200);
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
