import type { TenantKeeper, TenantOutcome, TenantRequest } from './tenants.js';

// → docs/spec/36-remote-validation.md#seams-and-why-the-fake-comes-first

/**
 * Every project-supplied command in this design is a live shell command against a real environment,
 * and `ensureTenant` provisions one. A test without this spawns the project's own script and passes
 * while doing it — the `FakeUpstreamIssues` failure exactly.
 */
export class FakeTenantKeeper implements TenantKeeper {
  readonly asked: { call: 'ensure' | 'reseed'; environment: string; command: string; tenant: string | null }[] = [];

  constructor(private readonly scripted: Record<string, TenantOutcome> = {}) {}

  ensure(request: TenantRequest): Promise<TenantOutcome> {
    return Promise.resolve(this.answer('ensure', request));
  }

  reseed(request: TenantRequest): Promise<TenantOutcome> {
    return Promise.resolve(this.answer('reseed', request));
  }

  private answer(call: 'ensure' | 'reseed', request: TenantRequest): TenantOutcome {
    const { environment, command, tenant } = request;
    this.asked.push({ call, environment, command, tenant });
    return this.scripted[`${call}:${environment}`] ?? { tenant, detail: null };
  }
}
