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

type ProviderFactory = (ctx: IntegrationContext, world: FakeWorldStore, clients: ProviderClients) => Integration;

/**
 * The provider clients built for one {@link buildIntegrations} call, so the two
 * capabilities that select the same provider share one rather than each building
 * its own.
 *
 * Sharing is not tidiness. A GitHub client carries the throttling plugin's view of
 * the rate limit and the ETag cache behind its GETs, and both are *per instance* —
 * so two clients fan out into one hourly budget blind to each other, and neither
 * can be told by the other that it has run out. They also each resolve
 * `viewerLogin` separately, which is a second `GET /user` per boot for an answer
 * that is fixed for the token's lifetime.
 *
 * Scoped to the call rather than memoised on the context, so a rebuild after a
 * config change builds against the coordinates the new config states.
 */
interface ProviderClients {
  github?: { api: OctokitGitHubApi; gh: GitHubConfig };
}

/**
 * The provider registry: capability → provider id → factory. Adding a real
 * provider is one line here (e.g. `github` under `sourceControl`); nothing else in
 * the harness changes. Selecting it is a config
 * change (`integrations.sourceControl: 'github'`).
 */
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

const CAPABILITIES = Object.keys(REGISTRY) as WorldCapability[];

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
 * Build the real GitHub client for a `github`-selected capability, or hand back the
 * one this call already built ({@link ProviderClients}). The token comes from
 * `GITHUB_TOKEN` (never config) and owner/repo from `config.github`; either missing
 * is a clear, actionable startup error rather than a later network failure.
 */
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
  // Same sink as Azure's, for the same reason: a rate limit the retry absorbs is
  // invisible otherwise, and it is the early warning that the world read has
  // outgrown the heartbeat.
  const log = ctx.errors ? (message: string) => void ctx.errors!.record({ source: 'provider', message }) : undefined;
  clients.github = { api: OctokitGitHubApi.fromToken(token, gh.owner, gh.repo, log), gh };
  return clients.github;
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
  // Surface a request that failed *every* attempt (sign-in HTML, throttling, network) in
  // the Errors panel. A blip the retry recovers from records nothing: it is not a fault,
  // and a row saying the credential was rejected is read as one.
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
  // One per call, for the same reason the fakes share one `FakeWorldStore`: two
  // capabilities pointed at one provider are two views of one service, and a
  // client is where this codebase keeps what must be true across both of them.
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

/**
 * The pool's own registry — the third capability, and one line per provider exactly
 * as {@link REGISTRY} is.
 *
 * Separate from it rather than a third entry in it, because a pool transport is not
 * an {@link Integration}: it reads no slice of the world, has no `snapshot`, and is
 * never merged by the composite connector. Folding it in would mean either widening
 * `Integration` with two methods nothing else implements, or a `snapshot` that
 * returns nothing — and the second is the one that would go wrong silently, since a
 * capability the composite believes it has is one it will ask.
 *
 * `http` later is one more line here with nothing above it changing.
 * → `docs/spec/28-cross-fleet-pool.md#the-two-transports`
 */
const POOL_REGISTRY: Record<string, (ctx: IntegrationContext) => PoolTransport> = {
  fake: () => new FakePoolTransport(),
  git: (ctx) => {
    const pool = ctx.config.pool ?? {};
    // Every one of these is checked at config load (`validatePool`), which is where
    // a coordinate an operator types belongs — the reads here are the type's, not a
    // second gate free to disagree with the first.
    return new GitPoolTransport({
      root: poolRoot(ctx),
      remote: pool.remote ?? '',
      branch: pool.branch ?? 'main',
      path: pool.path ?? '',
      fleetId: ctx.config.fleetId ?? '',
    });
  },
};

/**
 * Where the pool's clone lives — **its own root, and never under `worktreeRoot`**.
 *
 * The worktree pool counts every registered worktree under that root as a slot
 * whatever the directory is called, so a pool clone in there is leased to an agent
 * and wiped with `git clean -ffdx` (`docs/spec/09-execution.md#exhaustion`). Exactly
 * the hazard `localRunRoot` exists to avoid, and the same answer: a separate root,
 * touched by nothing else. Under `deskRoot`, which is the harness's own scratch
 * space and is never a registered worktree.
 */
function poolRoot(ctx: IntegrationContext): string {
  return resolve(ctx.config.deskRoot, 'pool');
}

/**
 * Resolve the configured pool provider. Throws the registry's own clear error,
 * listing the valid ids, if it names one that does not exist.
 */
export function buildPoolTransport(selection: IntegrationSelection, ctx: IntegrationContext): PoolTransport {
  const factory = POOL_REGISTRY[selection.pool];
  if (!factory) {
    throw new Error(
      `Unknown pool provider '${selection.pool}'. Valid providers: ${Object.keys(POOL_REGISTRY).join(', ')}.`,
    );
  }
  return factory(ctx);
}
