import type { AzureDevOpsConfig, GitHubConfig } from '../config.js';
import { resolve } from 'node:path';
import type { Integration, IntegrationContext, IntegrationSelection, WorldCapability } from './integration.js';
import type { PoolTransport } from '../pool/transport.js';
import { FakePoolTransport } from './fake/fakePool.js';
import { GitPoolTransport } from './pool/gitPool.js';
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

// → docs/spec/15-integrations.md

type ProviderFactory = (ctx: IntegrationContext, world: FakeWorldStore, clients: ProviderClients) => Integration;

interface ProviderClients {
  github?: { api: OctokitGitHubApi; gh: GitHubConfig };
}

const REGISTRY: Record<WorldCapability, Record<string, ProviderFactory>> = {
  sourceControl: {
    fake: (ctx, world) => new FakeGitHubIntegration(world, ctx.config.defaultBranch),
    github: (ctx, _world, clients) => {
      const { api, gh } = githubApi(ctx, clients);
      return new GitHubSourceControlIntegration({
        api,
        errors: ctx.errors,
        prAuthor: filterToViewer(ctx),
        owner: gh.owner,
        repo: gh.repo,
        closedPrWindowMs: ctx.config.closedPrWindowMs,
        sentReplies: ctx.store,
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
        sentReplies: ctx.store,
      });
    },
  },
  issues: {
    fake: (_ctx, world) => new FakeIssuesIntegration(world),
    github: (ctx, _world, clients) => {
      const { api, gh } = githubApi(ctx, clients);
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

/* Whether a provider's slice arrives filtered to `userId`, per capability. It is a
   fact about the query each integration issues and nothing else can answer it: both
   source-control providers filter pull requests by author-or-assignee, Azure filters
   work items by `assignedTo`, and **GitHub's issue sweep is `listOpenIssues()` — the
   whole repository, always**, because the ownership label annotates an issue rather
   than scoping the sweep. The pool reads this to decide which of a fleet's throughput
   measures are its own to publish, so a wrong entry here is a silent over-count on a
   shared project. → docs/spec/15-integrations.md, docs/spec/28-cross-fleet-pool.md */
export const VIEWER_SCOPED: Record<WorldCapability, Record<string, boolean>> = {
  sourceControl: { fake: false, github: true, azure: true },
  issues: { fake: false, github: false, azure: true },
};

export interface WorldScope {
  pullRequests: boolean;
  issues: boolean;
}

export function worldScope(selection: IntegrationSelection, ctx: IntegrationContext): WorldScope {
  const filtered = filterToViewer(ctx) !== undefined;
  return {
    pullRequests: filtered && (VIEWER_SCOPED.sourceControl[selection.sourceControl] ?? false),
    issues: filtered && (VIEWER_SCOPED.issues[selection.issues] ?? false),
  };
}

/* The provider names each capability can build. Exported so the scoping table above
   can be asserted complete against it: the two must not drift. */
export const INTEGRATION_PROVIDERS: Record<WorldCapability, Record<string, unknown>> = REGISTRY;

const CAPABILITIES = Object.keys(REGISTRY) as WorldCapability[];

function filterToViewer(ctx: IntegrationContext): string | undefined {
  return ctx.config.ownWorkOnly ? ctx.config.userId : undefined;
}

function ownershipLabel(ctx: IntegrationContext): string | undefined {
  return filterToViewer(ctx) === undefined ? undefined : watchLabelFor(ctx.config.labelPrefix);
}

function githubApi(ctx: IntegrationContext, clients: ProviderClients): { api: OctokitGitHubApi; gh: GitHubConfig } {
  if (clients.github) return clients.github;
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('The github provider needs a token: set the GITHUB_TOKEN environment variable.');
  }
  const gh = ctx.config.github;
  if (!gh?.owner || !gh?.repo) {
    throw new Error('The github provider needs a target: set `github.owner` and `github.repo` in your config.');
  }
  const log = ctx.errors ? (message: string) => void ctx.errors!.record({ source: 'provider', message }) : undefined;
  clients.github = { api: OctokitGitHubApi.fromToken(token, gh.owner, gh.repo, log), gh };
  return clients.github;
}

function azureApi(ctx: IntegrationContext): { api: RestAzureDevOpsApi; az: AzureDevOpsConfig } {
  const az = ctx.config.azureDevOps;
  if (!az?.organization || !az?.project || !az?.repository) {
    throw new Error(
      'The azure provider needs a target: set `azureDevOps.organization`, `azureDevOps.project` and `azureDevOps.repository` in your config.',
    );
  }
  const log = ctx.errors ? (message: string) => void ctx.errors!.record({ source: 'provider', message }) : undefined;
  return { api: RestAzureDevOpsApi.create(az, resolveAzureAuth(), log), az };
}

export function buildIntegrations(selection: IntegrationSelection, ctx: IntegrationContext): Integration[] {
  const world = new FakeWorldStore(ctx.store);
  const clients: ProviderClients = {};
  return CAPABILITIES.map((capability) => {
    const providerId = selection[capability];
    const factory = REGISTRY[capability][providerId];
    if (!factory) {
      const valid = Object.keys(REGISTRY[capability]).join(', ');
      throw new Error(`Unknown ${capability} provider '${providerId}'. Valid providers: ${valid}.`);
    }
    return factory(ctx, world, clients);
  });
}

const POOL_REGISTRY: Record<string, (ctx: IntegrationContext) => PoolTransport> = {
  fake: () => new FakePoolTransport(),
  git: (ctx) => {
    const pool = ctx.config.pool ?? {};
    return new GitPoolTransport({
      root: poolRoot(ctx),
      remote: pool.remote ?? '',
      branch: pool.branch ?? 'main',
      path: pool.path ?? '',
      fleetId: ctx.config.fleetId ?? '',
    });
  },
};

function poolRoot(ctx: IntegrationContext): string {
  return resolve(ctx.config.deskRoot, 'pool');
}

export function buildPoolTransport(selection: IntegrationSelection, ctx: IntegrationContext): PoolTransport {
  const factory = POOL_REGISTRY[selection.pool];
  if (!factory) {
    throw new Error(
      `Unknown pool provider '${selection.pool}'. Valid providers: ${Object.keys(POOL_REGISTRY).join(', ')}.`,
    );
  }
  return factory(ctx);
}
