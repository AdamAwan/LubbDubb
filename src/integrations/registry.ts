import type { AzureDevOpsConfig, GitHubConfig } from '../config.js';
import type { Capability, Integration, IntegrationContext, IntegrationSelection } from './integration.js';
import { FakeWorldStore } from './fake/fakeWorld.js';
import { FakeGitHubIntegration } from './fake/fakeGitHub.js';
import { FakeIssuesIntegration } from './fake/fakeIssues.js';
import { OctokitGitHubApi } from './github/octokitGitHubApi.js';
import { GitHubSourceControlIntegration } from './github/sourceControl.js';
import { GitHubIssuesIntegration } from './github/issues.js';
import { RestAzureDevOpsApi, resolveAzureAuth } from './azure/restAzureDevOpsApi.js';
import { AzureDevOpsSourceControlIntegration } from './azure/sourceControl.js';
import { AzureDevOpsWorkItemsIntegration } from './azure/workItems.js';
import { watchLabelFor } from '../watchLabels.js';

type ProviderFactory = (ctx: IntegrationContext, world: FakeWorldStore) => Integration;

/**
 * The provider registry: capability → provider id → factory. Adding a real
 * provider is one line here (e.g. `github` under `sourceControl`); nothing else in
 * the harness changes. Selecting it is a config
 * change (`integrations.sourceControl: 'github'`).
 */
const REGISTRY: Record<Capability, Record<string, ProviderFactory>> = {
  sourceControl: {
    fake: (ctx, world) => new FakeGitHubIntegration(world, ctx.config.defaultBranch),
    github: (ctx) => {
      const { api, gh } = githubApi(ctx);
      return new GitHubSourceControlIntegration({
        api,
        errors: ctx.errors,
        prAuthor: filterToViewer(ctx),
        owner: gh.owner,
        repo: gh.repo,
        closedPrWindowMs: ctx.config.closedPrWindowMs,
      });
    },
    azure: (ctx) => {
      const { api, az } = azureApi(ctx);
      return new AzureDevOpsSourceControlIntegration({
        api,
        errors: ctx.errors,
        prAuthor: filterToViewer(ctx),
        organization: az.organization,
        project: az.project,
        repository: az.repository,
        policyChecks: az.policyChecks,
        closedPrWindowMs: ctx.config.closedPrWindowMs,
      });
    },
  },
  issues: {
    fake: (_ctx, world) => new FakeIssuesIntegration(world),
    github: (ctx) => {
      const { api, gh } = githubApi(ctx);
      return new GitHubIssuesIntegration({
        api,
        errors: ctx.errors,
        owner: gh.owner,
        repo: gh.repo,
        ownershipLabel: ownershipLabel(ctx),
      });
    },
    azure: (ctx) => {
      const { api, az } = azureApi(ctx);
      return new AzureDevOpsWorkItemsIntegration({
        api,
        errors: ctx.errors,
        organization: az.organization,
        project: az.project,
        repository: az.repository,
        workItemTag: az.filters?.workItemTag,
        assignedTo: filterToViewer(ctx),
        ownershipTag: ownershipLabel(ctx),
      });
    },
  },
};

const CAPABILITIES = Object.keys(REGISTRY) as Capability[];

/**
 * Who the world is narrowed to at fetch time, or `undefined` for "narrow it to
 * nobody" — the one place the two halves of the identity split are read together.
 *
 * A filter needs both: an identity to filter *to* (`userId`) and a project that
 * wants filtering at all (`ownWorkOnly`). Either missing leaves the whole world
 * arriving, which is the honest answer in both cases — with no identity there is
 * nothing to compare against, and with the policy off the team has said they work
 * each other's queue.
 *
 * Assignment and branch naming deliberately do *not* come through here: they read
 * `config.userId` directly, because what the harness signs its own work with is
 * not a thing a filtering policy has an opinion about.
 * → `docs/spec/02-configuration.md#userid`
 */
function filterToViewer(ctx: IntegrationContext): string | undefined {
  return ctx.config.ownWorkOnly ? ctx.config.userId : undefined;
}

/**
 * The label whose *authorship* the issues provider must resolve, or `undefined` when
 * it needn't bother. The gate label is the derived `${labelPrefix}-watch` tag, and it
 * is resolved only when {@link filterToViewer} says there is somebody to attribute a
 * tag to; otherwise the provider skips the history lookups entirely.
 */
function ownershipLabel(ctx: IntegrationContext): string | undefined {
  return filterToViewer(ctx) === undefined ? undefined : watchLabelFor(ctx.config.labelPrefix);
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
  // Same sink as Azure's, for the same reason: a rate limit the retry absorbs is
  // invisible otherwise, and it is the early warning that the world read has
  // outgrown the heartbeat.
  const log = ctx.errors ? (message: string) => void ctx.errors!.record({ source: 'provider', message }) : undefined;
  return { api: OctokitGitHubApi.fromToken(token, gh.owner, gh.repo, log), gh };
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
  // Surface transient-retry notices (sign-in-HTML blips, throttling) in the Errors panel
  // so an occasional failure is visible even when the retry silently recovers.
  const log = ctx.errors ? (message: string) => void ctx.errors!.record({ source: 'provider', message }) : undefined;
  return { api: RestAzureDevOpsApi.create(az, resolveAzureAuth(), log), az };
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
