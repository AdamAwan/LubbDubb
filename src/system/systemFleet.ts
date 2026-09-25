import { issueOriginNumber, issueOriginRef } from '../issueOrigins.js';
import { prRefStyle } from '../pr/prRef.js';
import type { Config } from '../config/config.js';
import { ticketAmendCommands } from '../goalInstructions.js';
import { AgentManager } from '../agents/agentManager.js';
import { EscalationInbox } from '../escalation/escalationInbox.js';
import { ProposalDesk } from '../proposals/proposalDesk.js';
import { StackLandingDesk } from '../stacks/landingDesk.js';
import { screenCheckNote, stateDeclareNote, testPartNote, watchDeclareNote, watchNote } from '../plans/planning.js';
import { validationPlanNote } from '../validation/authoring.js';
import { PermissionDesk } from '../agents/permissionDesk.js';
import { RecoveryDesk } from '../agents/recoveryDesk.js';
import { EjectionDesk } from '../ejection/desk.js';
import { ActionExecutor } from '../executor/actionExecutor.js';
import { ReadyingBoard } from '../executor/readying.js';
import { RuleDispatcher } from '../dispatcher/ruleDispatcher.js';
import type { PromptTemplates } from '../dispatcher/promptTemplates.js';
import type { Dispatcher } from '../dispatcher/dispatcher.js';
import { issueWatchGateReason, type IssuePickupPolicy } from '../dispatcher/issuePickup.js';
import { featureSummariesOn } from '../features/featureBoard.js';
import { featureRecords, type FeatureBoardFacts } from '../featureSummaries/featureRecord.js';
import { resolveModelTag } from '../modelLabels.js';
import { sequenceableFeatures } from '../sequence/sequence.js';
import { LiveConfig } from '../config/configApply.js';
import type { BuildOptions, LateBinding, Foundation, AgentRuntime } from './systemFoundation.js';
import type { Channels } from './system.js';

// → docs/spec/01-overview.md

export type Fleet = ReturnType<typeof buildFleet>;

type Crew = ReturnType<typeof buildAgentManager>;

export function buildAgentManager(
  config: Config,
  base: Foundation,
  { agentSetup, fileEvents }: AgentRuntime,
  { mcp }: Channels,
  late: LateBinding,
) {
  const { store, connector, errors, watchLabel } = base;
  const sequenceWatchPolicy: IssuePickupPolicy = {
    watchLabel,
    requireOwnLabel: config.ownWorkOnly && config.userId !== undefined,
    priorityLabels: {},
    defaultPriority: 0,
  };

  const featureBoard = (): FeatureBoardFacts | null =>
    featureSummariesOn(config, connector)
      ? {
          containerTypes: config.issueContainerTypes,
          watchLabel,
          environments: config.environments,
        }
      : null;

  const agents: AgentManager = new AgentManager(store, {
    command: config.claudeCommand,
    buildArgs: agentSetup.buildArgs,
    whitelistedApprovals: config.whitelistedApprovals,
    reviewPolicy: config.review,
    goalProfile:
      config.labelPrefix && config.agentModels
        ? {
            effective: (issueOrigin: string): string | null => {
              const models = config.agentModels;
              const number = issueOriginNumber('root', issueOrigin);
              const issue =
                number === null ? undefined : store.world.getWorldBaseline()?.issues.find((i) => i.number === number);
              return resolveModelTag(issue?.labels, config.labelPrefix, models).profile ?? models?.default ?? null;
            },
          }
        : undefined,
    featureStanding: (featureOrigin: string): string | null => {
      const facts = featureBoard();
      if (!facts) return null;
      return featureRecords(store, facts).find((f) => issueOriginRef('root', f.number) === featureOrigin)?.key ?? null;
    },
    featureSequenceStanding: (featureOrigin: string): { key: string; members: number[] } | null => {
      const found = sequenceableFeatures(
        store.world.getWorldBaseline()?.issues ?? [],
        config.issueContainerTypes,
        (issue) => issueWatchGateReason(issue, sequenceWatchPolicy) === null,
        config.issueSequenceMaxChildren,
      ).find((f) => issueOriginRef('root', f.feature.number) === featureOrigin);
      return found ? { key: found.key, members: found.members } : null;
    },
    createSession: agentSetup.factory,
    initialInput: agentSetup.initialInput,
    resumeInput: agentSetup.resumeInput,
    promptDelayMs: agentSetup.promptDelayMs,
    waitingPatterns: config.agentWaitingPatterns,
    stallNudges: config.agentStallNudges,
    stallParkMs: config.agentStallParkMs,
    stallExtendMs: config.agentStallExtendMs,
    silenceParkMs: config.agentSilenceParkMs,
    resumable: agentSetup.resumable,
    resumeAttempts: config.agentResumeAttempts,
    fileEvents,
    docsFolderPrefix: config.docsFolderPrefix,
    mcp,
    watch: { run: (originRef: string): Promise<string[]> => late.get().watchDryRun.run(originRef) },
    errors,
  });
  return { sequenceWatchPolicy, featureBoard, agents };
}

export function buildFleet(
  config: Config,
  opts: BuildOptions,
  base: Foundation,
  { agentSetup }: AgentRuntime,
  { prompts, reviewCharters }: Channels,
  crew: Crew,
) {
  const { store, connector, sink, now, errors, worktrees, runtimeControl } = base;
  const { sequenceWatchPolicy, featureBoard, agents } = crew;
  const escalations = new EscalationInbox(store, agents);
  const permissions = new PermissionDesk(escalations);
  const recovery = new RecoveryDesk({
    store,
    agents,
    escalations,
    resumable: agentSetup.resumable,
    bootedAt: opts.bootedAt,
    errors,
  });

  const ejections = new EjectionDesk({
    store,
    agents: () => agents,
    policy: () => config.ejection,
    now,
  });

  const landings = new StackLandingDesk(store, escalations, errors);

  const readying = new ReadyingBoard();

  const executor = new ActionExecutor({
    store,
    landings,
    agents,
    worktrees,
    escalations,
    readying,
    sink,
    agentModels: config.agentModels,
    agentPermissionMode: config.agentPermissionMode,
    deskRoot: config.deskRoot,
    defaultBranch: config.defaultBranch,
    runtime: runtimeControl,
    errors,
    autoSendReplies: () => config.sendPrRepliesWithoutApproval,
    ciEvidence: opts.ciEvidence ?? connector,
    instructionTracker: (issueNumber) => ticketAmendCommands(config, issueNumber),
    featureBoard,
  });

  const proposals = new ProposalDesk(store, escalations, executor, {
    sink,
    config,
    errors,
  });

  return {
    sequenceWatchPolicy,
    featureBoard,
    agents,
    escalations,
    permissions,
    recovery,
    ejections,
    landings,
    readying,
    executor,
    proposals,
    ...buildDispatch(config, base, prompts, reviewCharters),
  };
}

function buildDispatch(
  config: Config,
  { runtimeControl, watchLabel }: Foundation,
  prompts: PromptTemplates,
  reviewCharters: Channels['reviewCharters'],
) {
  const issuePickup: IssuePickupPolicy = {
    watchLabel,
    requireOwnLabel: config.ownWorkOnly && config.userId !== undefined,
    priorityLabels: config.issuePriorityLabels,
    defaultPriority: config.issueDefaultPriority,
    pickupStates: config.issuePickupStates,
    inReviewState: config.issueInReviewState,
    inProgressState: config.issueInProgressState,
    containerTypes: config.issueContainerTypes,
    parentedTypes: config.issueParentedTypes,
    sequencing: config.issueSequencing,
    sequenceMaxChildren: config.issueSequenceMaxChildren,
  };
  const rules = new RuleDispatcher({
    pickup: issuePickup,
    templates: prompts,
    defaultBranch: config.defaultBranch,
    planning: config.planning,
    ci: config.ci,
    validation: config.validation,
    validationRoot: config.validationRoot,
    prRefStyle: prRefStyle(config.integrations.sourceControl),
    review: config.review,
    reviewCharters,
    watchNote: watchNote(config.environments),
    watchDeclareNote: watchDeclareNote(config.environments),
    testPartNote: testPartNote(config.environments),
    screenCheckNote: screenCheckNote(config.environments),
    stateDeclareNote: stateDeclareNote(config.environments),
    remoteValidationOn: config.environments.some((env) => env.validate !== undefined),
    checkSets: config.validation.checkSets,
    validationPlanNote: validationPlanNote(config.environments),
  });
  const dispatcher: Dispatcher = rules;

  const liveConfig = new LiveConfig({ running: config, runtimeControl, dispatcher: rules });
  return { issuePickup, dispatcher, liveConfig };
}
