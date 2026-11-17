import type { ExtensionHost } from '../../extensions/host.js';
import type { ExtensionSlots } from '../../extensions/slots.js';
import type { EnvironmentConfig } from '../../environments/policy.js';
import type { TenantCall, TenantLaunch } from '../../types.js';
import type { TenantTail } from './tenantLog.js';
import type { TenantKeeper, TenantOutcome, TenantRequest } from './tenants.js';

// → docs/spec/36-remote-validation.md#a-tenant-from-the-projects-extension

type TenantHost = Pick<ExtensionHost<ExtensionSlots>, 'provider' | 'call'>;

const SLOT_OF: Record<TenantCall, keyof ExtensionSlots> = { ensure: 'ensureTenant', reseed: 'reseedTenant' };

/** What runs each tenant step for an environment, in the words the gate shows. Null is a step it does not have. */
export interface TenantSteps {
  ensure: string | null;
  reseed: string | null;
}

export function tenantSteps(validate: EnvironmentConfig['validate'], host: Pick<TenantHost, 'provider'>): TenantSteps {
  if (validate?.tenantExtension !== true)
    return { ensure: validate?.ensureTenant ?? null, reseed: validate?.reseed ?? null };
  return { ensure: slotStep(host, 'ensure'), reseed: slotStep(host, 'reseed') };
}

function slotStep(host: Pick<TenantHost, 'provider'>, call: TenantCall): string | null {
  const provider = host.provider(SLOT_OF[call]);
  return provider === null ? null : `the "${SLOT_OF[call]}" slot of extension "${provider}"`;
}

/** Every environment that takes its tenant from the extension needs one that provisions it. */
export function checkTenantExtension(
  environments: readonly EnvironmentConfig[],
  host: Pick<TenantHost, 'provider'>,
): void {
  const unanswered = environments.filter((env) => env.validate?.tenantExtension === true);
  if (unanswered.length === 0 || host.provider('ensureTenant') !== null) return;
  throw new Error(
    `Refusing to start: ${unanswered.map((env) => `"${env.name}"`).join(', ')} set "validate.tenantExtension" ` +
      'and no extension fills the "ensureTenant" slot, so nothing could provision its tenant. Add the extension ' +
      'to "extensions", or declare the tenant another way.',
  );
}

/**
 * The project's extension answering for its tenants. It runs inside the harness, so a restart ends it:
 * nothing is left to `follow`, and the gate reads the preparation as not knowable from here.
 */
export class ExtensionTenantKeeper implements TenantKeeper {
  private readonly latest = new Map<string, { id: string; lines: string[] }>();
  private launches = 0;

  constructor(
    private readonly host: TenantHost,
    private readonly now: () => number = Date.now,
  ) {}

  async ensure(request: TenantRequest, launched?: (launch: TenantLaunch) => void): Promise<TenantOutcome> {
    const lines = this.launch('ensure', request, launched);
    const answer = await this.host.call('ensureTenant', { environment: request.environment, tenant: request.tenant });
    return this.done(lines, answer.ok ? { tenant: answer.value.tenant.trim(), detail: null } : failed(answer.detail));
  }

  async reseed(request: TenantRequest, launched?: (launch: TenantLaunch) => void): Promise<TenantOutcome> {
    const lines = this.launch('reseed', request, launched);
    if (request.tenant === null) return this.done(lines, failed('nothing named a tenant to reseed'));
    const answer = await this.host.call('reseedTenant', { environment: request.environment, tenant: request.tenant });
    return this.done(lines, answer.ok ? { tenant: request.tenant, detail: null } : failed(answer.detail));
  }

  provider(slot: keyof ExtensionSlots): string | null {
    return this.host.provider(slot);
  }

  follow(): Promise<TenantOutcome | null> {
    return Promise.resolve(null);
  }

  tail(environment: string, launch: TenantLaunch): TenantTail {
    const latest = this.latest.get(environment);
    return { lines: latest?.id === launch.id ? [...latest.lines] : [], lastOutputAt: null };
  }

  private launch(call: TenantCall, request: TenantRequest, launched?: (launch: TenantLaunch) => void): string[] {
    this.launches += 1;
    const startedAt = new Date(this.now()).toISOString();
    const id = `extension-${startedAt}-${String(this.launches)}`;
    const lines = [`asked ${request.command}`];
    this.latest.set(request.environment, { id, lines });
    launched?.({ id, pid: null, startedAt });
    return lines;
  }

  private done(lines: string[], outcome: TenantOutcome): TenantOutcome {
    lines.push(
      outcome.detail === null
        ? `it answered${outcome.tenant === null ? '' : ` \`${outcome.tenant}\``}`
        : outcome.detail,
    );
    return outcome;
  }
}

function failed(detail: string): TenantOutcome {
  return { tenant: null, detail };
}
