import type { Config } from '../config/config.js';
import { fetchRemote } from '../git/gitCli.js';
import { openPrForIssue } from '../dispatcher/issuePickup.js';
import { LocalRunner } from '../localRun/runner.js';
import { localRunConfigured } from '../localRun/policy.js';
import { LocalValidationDesk } from '../validation/local/desk.js';
import { LocalValidationAutoPress } from '../validation/local/auto.js';
import { LocalValidationTicketDesk } from '../validation/local/ticket.js';
import { trackerCoordinates } from '../mcp/findings.js';
import type { TicketFiler } from '../tickets/filing.js';
import type { PromptTemplates } from '../dispatcher/promptTemplates.js';
import { LocalRunWatch } from '../localRun/watch.js';
import { CommandPortLister } from '../localRun/ports.js';
import { FakePortLister } from '../localRun/fakePortLister.js';
import { localRunChoices, type LocalRunChoices } from '../localRun/ref.js';
import { bySlug, partBase, planIssueNumber } from '../plans/parts.js';
import type { BuildOptions, Foundation, AgentRuntime } from './systemFoundation.js';

// → docs/spec/01-overview.md

export type LocalRuns = ReturnType<typeof buildLocalRuns>;

interface LocalRunNeighbours {
  pulse: { localCycles: { request(): void } };
  bench: { filing: TicketFiler };
  channels: { prompts: PromptTemplates };
}

export function buildLocalRuns(
  config: Config,
  opts: BuildOptions,
  base: Foundation,
  runtime: AgentRuntime,
  { pulse, bench, channels }: LocalRunNeighbours,
) {
  const { store, worktrees, gitObserver, errors } = base;
  const { agentSetup, reapTree, realTransport } = runtime;
  const choicesFor = (originRef: string): LocalRunChoices => {
    const plan = store.plans.getPlanByOrigin(originRef);
    const number = planIssueNumber(originRef);
    const world = store.world.getWorldBaseline();
    const issue = number === null ? undefined : world?.issues.find((i) => i.number === number);
    const own = issue ? (openPrForIssue(issue, world?.pullRequests ?? [])?.branch ?? null) : null;
    return localRunChoices(plan ? store.plans.listPlanParts(plan.id) : [], own);
  };
  const localRun = new LocalRunner({
    store,
    worktrees,
    sessions: agentSetup.factory,
    policy: () => config.localRun,
    claudeCommand: config.claudeCommand,
    claudeArgs: config.claudeArgs,
    permissionMode: config.agentPermissionMode,
    defaultBranch: config.defaultBranch,
    choicesFor,
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
  const localValidationAuto = new LocalValidationAutoPress({
    store,
    on: () => config.localValidation.auto,
    configured: () => localRunConfigured(config.localRun),
    start: (originRef, at) => localRun.start(originRef, at),
    request: (input) => localValidations.request(input),
    tipOf: (ref) => worktrees.previewCommit(ref),
    choicesFor,
    cycle: () => pulse.localCycles.request(),
    errors,
  });
  const localValidationTickets = new LocalValidationTicketDesk({
    store,
    filing: bench.filing,
    canFile: () => trackerCoordinates(config) !== null,
    prompts: channels.prompts,
    watchLabel: base.watchLabel,
    defaultBranch: config.defaultBranch,
    errors,
    changed: () => localValidations.emit('changed'),
  });
  return { localRun, localRunWatch, localValidations, localValidationAuto, localValidationTickets };
}
