import type { AzureDevOpsConfig, GitHubConfig } from '../config.js';
import type { Capability, Integration, IntegrationContext, IntegrationSelection } from './integration.js';
import { FakeWorldStore } from './fake/fakeWorld.js';
import { FakeGitHubIntegration } from './fake/fakeGitHub.js';
import { FakeIssuesIntegration } from './fake/fakeIssues.js';
import { FakeBacklogIntegration } from './fake/fakeBacklog.js';
import { FakeCalendarIntegration } from './fake/fakeCalendar.js';
import { OctokitGitHubApi } from './github/octokitGitHubApi.js';
import { GitHubSourceControlIntegration } from './github/sourceControl.js';
import { GitHubIssuesIntegration } from './github/issues.js';
import { RestAzureDevOpsApi, resolveAzureAuth } from './azure/restAzureDevOpsApi.js';
import { AzureDevOpsSourceControlIntegration } from './azure/sourceControl.js';
import { AzureDevOpsWorkItemsIntegration } from './azure/workItems.js';
import { RestMicrosoftGraphApi, resolveMicrosoftGraphAuth } from './microsoft/restMicrosoftGraphApi.js';
import { MicrosoftCalendarIntegration } from './microsoft/calendar.js';
import { IngestedCalendarIntegration } from './ingested/calendar.js';

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
    github: (ctx) => {
      const { api, gh } = githubApi(ctx);
      return new GitHubSourceControlIntegration({
        api,
        store: ctx.store,
        prAuthor: gh.filters?.prAuthor,
        owner: gh.owner,
        repo: gh.repo,
      });
    },
    azure: (ctx) => {
      const { api, az } = azureApi(ctx);
      return new AzureDevOpsSourceControlIntegration({ api, store: ctx.store, prAuthor: az.filters?.prAuthor });
    },
  },
  issues: {
    fake: (_ctx, world) => new FakeIssuesIntegration(world),
    github: (ctx) => {
      const { api, gh } = githubApi(ctx);
      return new GitHubIssuesIntegration({
        api,
        store: ctx.store,
        issueLabel: gh.filters?.issueLabel,
        owner: gh.owner,
        repo: gh.repo,
        ownershipLabel: ownershipLabel(ctx),
      });
    },
    azure: (ctx) => {
      const { api, az } = azureApi(ctx);
      return new AzureDevOpsWorkItemsIntegration({
        api,
        store: ctx.store,
        workItemTag: az.filters?.workItemTag,
        ownershipTag: ownershipLabel(ctx),
      });
    },
  },
  backlog: {
    fake: (_ctx, world) => new FakeBacklogIntegration(world),
  },
  calendar: {
    fake: (_ctx, world) => new FakeCalendarIntegration(world),
    microsoft365: (ctx) => {
      const { api, windowDays } = microsoftApi(ctx);
      return new MicrosoftCalendarIntegration({ api, store: ctx.store, windowDays });
    },
    ingested: (ctx) => new IngestedCalendarIntegration({ store: ctx.store }),
  },
};

/** Default look-ahead window for the Microsoft 365 calendar when config doesn't set one. */
const DEFAULT_CALENDAR_WINDOW_DAYS = 7;

const CAPABILITIES = Object.keys(REGISTRY) as Capability[];

/**
 * The label whose *authorship* the issues provider must resolve, or `undefined` when
 * it needn't bother. Only set when the operator has both turned the ownership gate on
 * (`issuePickupRequireOwnLabel`) and named a pickup label — otherwise there's nothing
 * to attribute, so the provider skips the extra history lookups.
 */
function ownershipLabel(ctx: IntegrationContext): string | undefined {
  return ctx.config.issuePickupRequireOwnLabel ? ctx.config.issuePickupLabel : undefined;
}

/**
 * Build the real GitHub client for a `github`-selected capability. The token comes
 * from `GITHUB_TOKEN` (never config) and owner/repo from `config.github`; either
 * missing is a clear, actionable startup error rather than a later network failure.
 */
function githubApi(ctx: IntegrationContext): { api: OctokitGitHubApi; gh: GitHubConfig } {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('The github provider needs a token: set the GITHUB_TOKEN environment variable.');
  }
  const gh = ctx.config.github;
  if (!gh?.owner || !gh?.repo) {
    throw new Error('The github provider needs a target: set `github.owner` and `github.repo` in your config.');
  }
  return { api: OctokitGitHubApi.fromToken(token, gh.owner, gh.repo), gh };
}

/**
 * Build the real Azure DevOps client for an `azure`-selected capability.
 * organization/project/repository come from `config.azureDevOps`; auth is resolved
 * lazily ({@link resolveAzureAuth} — a PAT from `AZURE_DEVOPS_PAT`, else the
 * logged-in `az` CLI), so a missing login surfaces as a clear connector error at
 * snapshot time rather than blocking boot. A missing target *is* a startup error.
 */
function azureApi(ctx: IntegrationContext): { api: RestAzureDevOpsApi; az: AzureDevOpsConfig } {
  const az = ctx.config.azureDevOps;
  if (!az?.organization || !az?.project || !az?.repository) {
    throw new Error(
      'The azure provider needs a target: set `azureDevOps.organization`, `azureDevOps.project` and `azureDevOps.repository` in your config.',
    );
  }
  return { api: RestAzureDevOpsApi.create(az, resolveAzureAuth()), az };
}

/**
 * Build the real Microsoft Graph client for a `microsoft365`-selected capability.
 * Config is optional: with no `microsoft365` block it reads the delegated signed-in
 * user's calendar over the default window. Auth is resolved lazily
 * ({@link resolveMicrosoftGraphAuth} — a bearer from `MICROSOFT_GRAPH_TOKEN`, else the
 * logged-in `az` CLI), so a missing login surfaces as a clear connector error at
 * snapshot time rather than blocking boot.
 */
function microsoftApi(ctx: IntegrationContext): { api: RestMicrosoftGraphApi; windowDays: number } {
  const cfg = ctx.config.microsoft365 ?? {};
  return {
    api: RestMicrosoftGraphApi.create(cfg, resolveMicrosoftGraphAuth()),
    windowDays: cfg.windowDays ?? DEFAULT_CALENDAR_WINDOW_DAYS,
  };
}

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
