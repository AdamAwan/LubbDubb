import type { TenantCall, TenantLaunch } from '../../types.js';
import type { TenantTail } from './tenantLog.js';
import type { TenantKeeper, TenantOutcome, TenantRequest } from './tenants.js';

// → docs/spec/36-remote-validation.md#seams-and-why-the-fake-comes-first

/**
 * Every project-supplied command in this design is a live shell command against a real environment,
 * and `ensureTenant` provisions one. A test without this spawns the project's own script and passes
 * while doing it — the `FakeUpstreamIssues` failure exactly.
 *
 * A launch the fake `hold`s stands in for a runner that outlived the last process: it is
 * followed until `finish` settles it. Any other launch it is asked to follow is gone.
 */
export class FakeTenantKeeper implements TenantKeeper {
  readonly asked: { call: TenantCall; environment: string; command: string; tenant: string | null }[] = [];
  readonly followed: { call: TenantCall; environment: string; launchId: string }[] = [];
  private readonly output = new Map<string, string[]>();
  private readonly running = new Map<string, (outcome: TenantOutcome) => void>();
  private readonly held = new Set<string>();
  private launches = 0;

  constructor(private readonly scripted: Record<string, TenantOutcome> = {}) {}

  ensure(request: TenantRequest, launched?: (launch: TenantLaunch) => void): Promise<TenantOutcome> {
    return this.launch('ensure', request, launched);
  }

  reseed(request: TenantRequest, launched?: (launch: TenantLaunch) => void): Promise<TenantOutcome> {
    return this.launch('reseed', request, launched);
  }

  follow(call: TenantCall, request: TenantRequest, launch: TenantLaunch): Promise<TenantOutcome | null> {
    this.followed.push({ call, environment: request.environment, launchId: launch.id });
    if (!this.held.has(launch.id)) return Promise.resolve(null);
    return new Promise((resolve) => this.running.set(launch.id, resolve));
  }

  tail(_environment: string, launch: TenantLaunch): TenantTail {
    return { lines: [...(this.output.get(launch.id) ?? [])], lastOutputAt: null };
  }

  /** A launch still running on the machine — one an earlier process started and this one follows. */
  hold(launchId: string, lines: readonly string[] = []): this {
    this.held.add(launchId);
    this.output.set(launchId, [...lines]);
    return this;
  }

  /** The held launch ends. */
  finish(launchId: string, outcome: TenantOutcome): void {
    this.held.delete(launchId);
    this.running.get(launchId)?.(outcome);
    this.running.delete(launchId);
  }

  private launch(
    call: TenantCall,
    request: TenantRequest,
    launched?: (launch: TenantLaunch) => void,
  ): Promise<TenantOutcome> {
    const { environment, command, tenant } = request;
    this.asked.push({ call, environment, command, tenant });
    this.launches += 1;
    const id = `fake-${String(this.launches)}`;
    this.output.set(id, [`$ ${command}`]);
    launched?.({ id, pid: null, startedAt: new Date(0).toISOString() });
    return Promise.resolve(this.scripted[`${call}:${environment}`] ?? { tenant, detail: null });
  }
}
