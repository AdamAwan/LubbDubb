import type { LoadedExtension } from '../../extensions/contract.js';
import type { ExtensionHost } from '../../extensions/host.js';
import type { ExtensionSlots } from '../../extensions/slots.js';
import type { EnvironmentConfig } from '../../environments/policy.js';
import type { TenantCall, TenantLaunch } from '../../types.js';
import { appendTail, type TenantTail } from './tenantLog.js';
import { sentence } from '../../primitives.js';
import { type TenantKeeper, type TenantOutcome, type TenantRequest, type TenantSteps } from './tenants.js';

// → docs/spec/36-remote-validation.md#a-tenant-from-the-projects-extension

type TenantHost = Pick<ExtensionHost<ExtensionSlots>, 'provider' | 'call'>;

/** Every environment that takes its tenant from the extension needs one that provisions it. */
export function checkTenantExtension(
  environments: readonly EnvironmentConfig[],
  loaded: readonly LoadedExtension[] = [],
): void {
  const unanswered = environments.filter((env) => env.validate?.tenantExtension === true);
  if (unanswered.length === 0 || loaded.some((extension) => extension.slots.has('ensureTenant'))) return;
  throw new Error(
    `Refusing to start: ${sentence(unanswered.map((env) => `"${env.name}"`))} set "validate.tenantExtension" ` +
      'and no extension fills the "ensureTenant" slot, so nothing could provision its tenant. Add the extension ' +
      'to "extensions", or declare the tenant another way.',
  );
}

/**
 * The project's extension answering for its tenants. It runs inside the harness, so a restart ends it:
 * nothing is left to `follow`, and the gate reads the preparation as not knowable from here.
 */
export class ExtensionTenantKeeper implements TenantKeeper {
  private readonly latest = new Map<string, Launched>();
  private launches = 0;

  constructor(
    private readonly host: TenantHost,
    private readonly now: () => number = Date.now,
  ) {}

  steps(): TenantSteps {
    const ensure = this.slotStep('ensureTenant');
    return { ensure, reseed: this.slotStep('reseedTenant'), ensureName: ensure ?? 'the "ensureTenant" slot' };
  }

  private slotStep(slot: keyof ExtensionSlots): string | null {
    const provider = this.host.provider(slot);
    return provider === null ? null : `the "${slot}" slot of extension "${provider}"`;
  }

  async ensure(request: TenantRequest, launched?: (launch: TenantLaunch) => void): Promise<TenantOutcome> {
    const run = this.launch('ensure', request, launched);
    const answer = await this.host.call(
      'ensureTenant',
      { environment: request.environment, tenant: request.tenant },
      run.print,
    );
    return this.done(run, answer.ok ? { tenant: answer.value.tenant.trim(), detail: null } : failed(answer.detail));
  }

  async reseed(request: TenantRequest, launched?: (launch: TenantLaunch) => void): Promise<TenantOutcome> {
    const run = this.launch('reseed', request, launched);
    if (request.tenant === null) return this.done(run, failed('nothing named a tenant to reseed'));
    const answer = await this.host.call(
      'reseedTenant',
      { environment: request.environment, tenant: request.tenant },
      run.print,
    );
    return this.done(run, answer.ok ? { tenant: request.tenant, detail: null } : failed(answer.detail));
  }

  follow(): Promise<TenantOutcome | null> {
    return Promise.resolve(null);
  }

  tail(environment: string, launch: TenantLaunch): TenantTail {
    const latest = this.latest.get(environment);
    return latest?.id === launch.id
      ? { lines: [...latest.lines], lastOutputAt: latest.lastOutputAt }
      : { lines: [], lastOutputAt: null };
  }

  private launch(call: TenantCall, request: TenantRequest, launched?: (launch: TenantLaunch) => void): Launched {
    this.launches += 1;
    const startedAt = new Date(this.now()).toISOString();
    const id = `extension-${startedAt}-${String(this.launches)}`;
    const run: Launched = {
      id,
      lines: [`asked ${request.command}`],
      lastOutputAt: null,
      print: (line) => {
        if (appendTail(run.lines, line) > 0) run.lastOutputAt = new Date(this.now()).toISOString();
      },
    };
    this.latest.set(request.environment, run);
    launched?.({ id, pid: null, startedAt });
    return run;
  }

  private done(run: Launched, outcome: TenantOutcome): TenantOutcome {
    appendTail(
      run.lines,
      outcome.detail === null
        ? `it answered${outcome.tenant === null ? '' : ` \`${outcome.tenant}\``}`
        : outcome.detail,
    );
    return outcome;
  }
}

interface Launched {
  id: string;
  lines: string[];
  lastOutputAt: string | null;
  print: (line: string) => void;
}

function failed(detail: string): TenantOutcome {
  return { tenant: null, detail };
}

/** The tenant keeper for each environment: the extension's where it sets `validate.tenantExtension`, else the commands'. */
export class RoutedTenantKeeper implements TenantKeeper {
  private readonly fromExtension: ReadonlySet<string>;

  constructor(
    environments: readonly EnvironmentConfig[],
    private readonly commands: TenantKeeper,
    private readonly extension: TenantKeeper,
  ) {
    this.fromExtension = new Set(environments.filter((e) => e.validate?.tenantExtension === true).map((e) => e.name));
  }

  steps(environment: EnvironmentConfig): TenantSteps {
    return this.for(environment.name).steps(environment);
  }

  ensure(request: TenantRequest, launched?: (launch: TenantLaunch) => void): Promise<TenantOutcome> {
    return this.for(request.environment).ensure(request, launched);
  }

  reseed(request: TenantRequest, launched?: (launch: TenantLaunch) => void): Promise<TenantOutcome> {
    return this.for(request.environment).reseed(request, launched);
  }

  follow(call: TenantCall, request: TenantRequest, launch: TenantLaunch): Promise<TenantOutcome | null> {
    return this.for(request.environment).follow(call, request, launch);
  }

  tail(environment: string, launch: TenantLaunch): TenantTail {
    return this.for(environment).tail(environment, launch);
  }

  private for(environment: string): TenantKeeper {
    return this.fromExtension.has(environment) ? this.extension : this.commands;
  }
}
