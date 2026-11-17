import type { Config } from '../config/config.js';
import { fetchRemote } from '../git/gitCli.js';
import { openPrForIssue } from '../dispatcher/issuePickup.js';
import { LocalRunner } from '../localRun/runner.js';
import { LocalValidationDesk } from '../validation/local/desk.js';
import { LocalRunWatch } from '../localRun/watch.js';
import { CommandPortLister } from '../localRun/ports.js';
import { FakePortLister } from '../localRun/fakePortLister.js';
import { localRunChoices } from '../localRun/ref.js';
import { bySlug, partBase, planIssueNumber } from '../plans/parts.js';
import type { BuildOptions, Foundation, AgentRuntime } from './systemFoundation.js';

// → docs/spec/01-overview.md

export type LocalRuns = ReturnType<typeof buildLocalRuns>;

export function buildLocalRuns(config: Config, opts: BuildOptions, base: Foundation, runtime: AgentRuntime) {
  const { store, worktrees, gitObserver, errors } = base;
  const { agentSetup, reapTree, realTransport } = runtime;
  const localRun = new LocalRunner({
    store,
    worktrees,
    sessions: agentSetup.factory,
    policy: () => config.localRun,
    claudeCommand: config.claudeCommand,
    claudeArgs: config.claudeArgs,
    permissionMode: config.agentPermissionMode,
    defaultBranch: config.defaultBranch,
    choicesFor: (originRef) => {
      const plan = store.plans.getPlanByOrigin(originRef);
      const number = planIssueNumber(originRef);
      const world = store.world.getWorldBaseline();
      const issue = number === null ? undefined : world?.issues.find((i) => i.number === number);
      const own = issue ? (openPrForIssue(issue, world?.pullRequests ?? [])?.branch ?? null) : null;
      return localRunChoices(plan ? store.plans.listPlanParts(plan.id) : [], own);
    },
    reap: reapTree,
    errors,
  });
  const localRunWatch = new LocalRunWatch({
    runner: localRun,
    git: gitObserver,
    fetch: opts.gitObserver ? undefined : () => fetchRemote(config.repoRoot),
    ports: opts.portLister ?? (realTransport ? new CommandPortLister(errors) : new FakePortLister()),
    baseFor: (originRef, ref) => {
      if (ref === config.defaultBranch) return null;
      const number = planIssueNumber(originRef);
      const plan = store.plans.getPlanByOrigin(originRef);
      const parts = plan ? store.plans.listPlanParts(plan.id) : [];
      const part = parts.find((p) => p.branch === ref);
      if (part !== undefined && number !== null) return partBase(part, bySlug(parts), number, config.defaultBranch);
      const pr = store.world.getWorldBaseline()?.pullRequests.find((p) => p.branch === ref);
      return pr?.baseBranch ?? config.defaultBranch;
    },
    fetchIntervalMs: config.planning.gitFetchIntervalMs,
    errors,
  });
  const localValidations = new LocalValidationDesk({
    store,
    validationRoot: config.validationRoot,
    errors,
  });
  localRun.on('changed', () => {
    localValidations.sweep();
  });
  return { localRun, localRunWatch, localValidations };
}
