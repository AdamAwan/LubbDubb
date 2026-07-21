import type { Capability, Integration, IntegrationContext, IntegrationSelection } from './integration.js';
import { FakeWorldStore } from './fake/fakeWorld.js';
import { FakeGitHubIntegration } from './fake/fakeGitHub.js';
import { FakeIssuesIntegration } from './fake/fakeIssues.js';
import { FakeBacklogIntegration } from './fake/fakeBacklog.js';
import { FakeCalendarIntegration } from './fake/fakeCalendar.js';

type ProviderFactory = (ctx: IntegrationContext, world: FakeWorldStore) => Integration;

/**
 * The provider registry: capability → provider id → factory. Adding a real
 * provider is one line here (e.g. `github` under `sourceControl`, `outlook` under
 * `calendar`); nothing else in the harness changes. Selecting it is a config
 * change (`integrations.sourceControl: 'github'`).
 */
const REGISTRY: Record<Capability, Record<string, ProviderFactory>> = {
  sourceControl: {
    fake: (ctx, world) => new FakeGitHubIntegration(world, ctx.store),
  },
  issues: {
    fake: (_ctx, world) => new FakeIssuesIntegration(world),
  },
  backlog: {
    fake: (_ctx, world) => new FakeBacklogIntegration(world),
  },
  calendar: {
    fake: (_ctx, world) => new FakeCalendarIntegration(world),
  },
};

const CAPABILITIES = Object.keys(REGISTRY) as Capability[];

/**
 * Resolve a config selection into the enabled integrations. Throws a clear error
 * (listing the valid provider ids) if a capability points at an unknown provider.
 * The fake providers share one {@link FakeWorldStore} so their world stays coherent.
 */
export function buildIntegrations(selection: IntegrationSelection, ctx: IntegrationContext): Integration[] {
  const world = new FakeWorldStore(ctx.store);
  return CAPABILITIES.map((capability) => {
    const providerId = selection[capability];
    const factory = REGISTRY[capability][providerId];
    if (!factory) {
      const valid = Object.keys(REGISTRY[capability]).join(', ');
      throw new Error(`Unknown ${capability} provider '${providerId}'. Valid providers: ${valid}.`);
    }
    return factory(ctx, world);
  });
}
