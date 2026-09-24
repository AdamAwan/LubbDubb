import { tmpdir } from 'node:os';
import { issueOriginNumber, issueOriginRef } from './issueOrigins.js';
import { prRefStyle } from './pr/prRef.js';
import { join } from 'node:path';
import { configFilePath, projectConfigFilePath, revealGateOn, type Config } from './config/config.js';
import { Store } from './store/store.js';
import type { PredictionStore } from './store/predictions.js';
import { CompositeConnector } from './integrations/compositeConnector.js';
import { buildIntegrations, buildPoolTransport, worldScope } from './integrations/registry.js';
import { PoolDesk } from './pool/poolDesk.js';
import type { PoolTransport } from './pool/transport.js';
import { harnessVersion } from './pool/harnessVersion.js';
import type { ActionSink } from './sink/actionSink.js';
import { ticketFiler, type TicketFiler } from './tickets/filing.js';
import { ghCliUpstreamIssues, type UpstreamIssues } from './tickets/upstream.js';
import type { CiEvidenceReader } from './ci/ciEvidence.js';
import { ticketAmendCommands } from './goalInstructions.js';
import { NodePtyBackend, type PtyBackend } from './pty/backend.js';
import { defaultPoolSize, WorktreeManager, type Worktrees } from './worktree/worktreeManager.js';
import { PrewarmDesk } from './worktree/prewarmDesk.js';
import { GitCliObserver, type GitObserver } from './git/gitObserver.js';
import { fetchRemote } from './git/gitCli.js';
import { PlanReconciler } from './plans/planReconciler.js';
import { AppraisalDesk } from './intake/appraisalDesk.js';
import { AreaPathDirectory } from './intake/areaPaths.js';
import type { AreaPathTree } from './intake/placement.js';
import { TicketSweep } from './tickets/sweep.js';
import { WorkGraphRecorder } from './graph/workGraphRecorder.js';
import { AgentManager } from './agents/agentManager.js';
import { judgeSeam } from './predictionJudge/seam.js';
import { buildClaudeStreamArgs, buildInitialMessage, buildResumeMessage } from './agents/agentProtocol.js';
import { PtySession } from './pty/ptySession.js';
import { StreamJsonSession, type Spawner } from './agents/streamJsonSession.js';
import { FileEventsSpool } from './agents/fileEvents.js';
import { AttachmentFiles } from './jobs/attachmentFiles.js';
import type { SessionFactory } from './agents/session.js';
import { killProcessTree, type ProcessReaper } from './agents/processTree.js';
import { EscalationInbox } from './escalation/escalationInbox.js';
import { ProposalDesk } from './proposals/proposalDesk.js';
import { StackLandingDesk } from './stacks/landingDesk.js';
import { escalationTypeForAsk, recentOutputExcerpt } from './escalation/context.js';
import { defaultConfigDir, defaultSocketPath, McpBridgeServer } from './mcp/server.js';
import { McpDesktopServer } from './mcp/desktop.js';
import { ObstacleDesk, type ObstacleReader } from './obstacles/desk.js';
import { trackerCoordinates } from './mcp/findings.js';
import { PrNamingDesk } from './pr/prNamingDesk.js';
import { PrDescriptionDesk } from './pr/prDescriptionDesk.js';
import { DeliveryCloseOutDesk } from './delivery/closeOutDesk.js';
import { UnwatchedChildDesk } from './features/unwatchedDesk.js';
import { ValidationAskDesk } from './validation/askDesk.js';
import { ValidationReadyDesk } from './validation/readyDesk.js';
import { SpendBurnDesk } from './spendBurnDesk.js';
import { RunwayDesk } from './supply/runwayDesk.js';
import { BranchReapDesk } from './branchReapDesk.js';
import { EnvironmentDesk } from './environments/environmentDesk.js';
import { CommandEnvironmentHealthProber, type EnvironmentHealthProber } from './environments/healthProber.js';
import { CommandReviewProber, type ReviewProber } from './review/reviewedElsewhere.js';
import { CommandEnvironmentProber, type EnvironmentProber } from './environments/prober.js';
import { CommandEnvironmentObserver, type EnvironmentObserver } from './environments/observer.js';
import { WatchDryRun, type WatchDryRunner } from './environments/watchDryRun.js';
import { CommandStateReader, type StateReader } from './remoteValidation/stateReader.js';
import { StateQueryDesk } from './remoteValidation/stateQueries.js';
import { RemoteValidationDesk } from './remoteValidation/desk.js';
import { RemoteRunDesk } from './remoteValidation/run.js';
import { RemoteReadingDesk } from './remoteValidation/readings.js';
import { RemoteListingDesk } from './remoteValidation/listing.js';
import { CommandTenantKeeper, tenantLogRoot, type TenantKeeper } from './remoteValidation/tenants.js';
import { WatchDesk } from './environments/watchDesk.js';
import { screenCheckNote, stateDeclareNote, testPartNote, watchDeclareNote, watchNote } from './plans/planning.js';
import { validationPlanNote } from './validation/authoring.js';
import { stepCapabilities } from './validation/steps.js';
import { remoteRunBriefs } from './remoteValidation/briefing.js';
import { PrWatchDesk } from './pr/prWatchDesk.js';
import { PrWorkItemDesk } from './pr/prWorkItemDesk.js';
import { ScheduleDesk } from './schedules/scheduleDesk.js';
import { UpdateDesk } from './selfUpdate/updateDesk.js';
import type { McpToolDeps } from './mcp/tools/context.js';
import { PERMISSION_PROMPT_TOOL, isSealedRule } from './mcp/names.js';
import { PermissionDesk } from './agents/permissionDesk.js';
import { RecoveryDesk } from './agents/recoveryDesk.js';
import { EjectionDesk } from './ejection/desk.js';
import { ActionExecutor } from './executor/actionExecutor.js';
import { ReadyingBoard } from './executor/readying.js';
import { RuleDispatcher } from './dispatcher/ruleDispatcher.js';
import { loadPromptTemplates, type PromptTemplates } from './dispatcher/promptTemplates.js';
import { loadReviewCharters } from './review/charter.js';
import { reviewModeNames } from './review/prReview.js';
import type { Dispatcher } from './dispatcher/dispatcher.js';
import { issueWatchGateReason, openPrForIssue, type IssuePickupPolicy } from './dispatcher/issuePickup.js';
import { watchLabelFor } from './watchLabels.js';
import { featureSummariesOn } from './features/featureBoard.js';
import { featureRecords, type FeatureBoardFacts } from './summaries/featureRecord.js';
import { resolveModelTag } from './modelLabels.js';
import { sequenceableFeatures } from './sequence/sequence.js';
import { orderedProfiles } from './agents/modelPolicy.js';
import { Harness } from './harness.js';
import { CycleTrigger } from './cycleTrigger.js';
import { Ingress, resolveIngressSecrets, type IngressSecrets } from './ingress/ingress.js';
import { IngressInbox } from './ingress/inbox.js';
import { RuntimeControl } from './runtimeControl.js';
import { PetKeeper } from './pets/keeper.js';
import { LocalRunner } from './localRun/runner.js';
import { LocalValidationDesk } from './localValidation/desk.js';
import { LocalRunWatch } from './localRun/watch.js';
import { CommandPortLister, type PortLister } from './localRun/ports.js';
import { FakePortLister } from './localRun/fakePortLister.js';
import { localRunChoices } from './localRun/ref.js';
import { bySlug, partBase, planIssueNumber } from './plans/parts.js';
import { LiveConfig } from './config/configApply.js';
import { ErrorLog } from './errorLog.js';
import type { ErrorLogEntry } from './types.js';
import { planIsWithheld } from './server/planReveal.js';

// → docs/spec/01-overview.md

export interface System {
  config: Config;
  store: Store;
  connector: CompositeConnector;
  agents: AgentManager;
  escalations: EscalationInbox;
  proposals: ProposalDesk;
  landings: StackLandingDesk;
  permissions: PermissionDesk;
  areaPaths: AreaPathDirectory;
  recovery: RecoveryDesk;
  ejections: EjectionDesk;
  executor: ActionExecutor;
  readying: ReadyingBoard;
  dispatcher: Dispatcher;
  harness: Harness;
  localCycles: CycleTrigger;
  ingress: Ingress;
  ingressCycles: CycleTrigger;
  graph: WorkGraphRecorder;
  tickets: TicketSweep;
  pool?: PoolDesk;
  watch: WatchDryRunner;
  stateQueries: StateQueryDesk;
  remoteValidation: RemoteValidationDesk;
  validationReady: ValidationReadyDesk;
  remoteRuns: RemoteRunDesk;
  remoteReadings: RemoteReadingDesk;
  remoteListings: RemoteListingDesk;
  filing: TicketFiler;
  upstream: UpstreamIssues;
  updates: UpdateDesk;
  runtimeControl: RuntimeControl;
  pets: PetKeeper;
  /**
   * Deliberately NOT `store.predictions`. Opened here and handed to the prediction
   * routes and nothing else, so that nothing holding a `Store` can reach an operator's
   * prediction. → docs/spec/14-persistence.md#the-prediction-store-is-not-on-store
   */
  predictions: PredictionStore;
  localRun: LocalRunner;
  localValidations: LocalValidationDesk;
  localRunWatch: LocalRunWatch;
  liveConfig: LiveConfig;
  issuePickup: IssuePickupPolicy;
  prompts: PromptTemplates;
  fileEvents: FileEventsSpool;
  attachments: AttachmentFiles;
  mcp: McpBridgeServer;
  desktop: McpDesktopServer;
  worktrees: Worktrees;
  errors: ErrorLog;
  configFile: string;
  projectConfigFile: string;
}

interface BuildOptions {
  backend?: PtyBackend;
  sink?: ActionSink;
  ciEvidence?: CiEvidenceReader;
  streamSpawner?: Spawner;
  reapProcessTree?: ProcessReaper;
  gitObserver?: GitObserver;
  portLister?: PortLister;
  worktrees?: Worktrees;
  environmentProber?: EnvironmentProber;
  environmentHealthProber?: EnvironmentHealthProber;
  reviewProber?: ReviewProber;
  environmentObserver?: EnvironmentObserver;
  stateReader?: StateReader;
  tenants?: TenantKeeper;
  errorMirror?: (entry: ErrorLogEntry) => void;
  ingressSecrets?: IngressSecrets;
  configFile?: string;
  projectConfigFile?: string;
  upstream?: UpstreamIssues;
  poolTransport?: PoolTransport;
  obstacleReader?: ObstacleReader;
  bootedAt?: string;
  /** Overrides the harness's stuck-cycle threshold. Injected by tests; nothing else sets it. */
  stuckCycleAfterMs?: number;
}

/** Components a later phase builds, reached only from closures that run after that phase. */
interface Late {
  agents: AgentManager;
  escalations: EscalationInbox;
  permissions: PermissionDesk;
  recovery: RecoveryDesk;
  ejections: EjectionDesk;
  proposals: ProposalDesk;
  executor: ActionExecutor;
  filing: TicketFiler;
  watchDryRun: WatchDryRun;
  stateQueries: StateQueryDesk;
  remoteReadings: RemoteReadingDesk;
  remoteListings: RemoteListingDesk;
  harness: Harness;
  localRun: LocalRunner;
  localRunWatch: LocalRunWatch;
  localValidations: LocalValidationDesk;
}

export function buildSystem(config: Config, opts: BuildOptions = {}): System {
  const late = {} as Late;
  const base = buildFoundation(config, opts);
  const runtime = buildAgentRuntime(config, opts, base);
  const channels = buildChannels(config, base, late);
  const crew = buildAgentManager(config, base, runtime, channels, late);
  const fleet = buildFleet(config, opts, base, runtime, channels, crew);
  Object.assign(late, fleet);
  const intake = buildIntakeDesks(config, opts, base, channels);
  const envs = buildEnvironmentDesks(config, opts, base);
  Object.assign(late, envs);
  const bench = buildBenchDesks(config, opts, base, channels, fleet);
  Object.assign(late, bench);
  const harness = buildHarness(config, opts, base, channels, fleet, intake, envs, bench, late);
  late.harness = harness;
  const pulse = wirePulse(config, opts, base, fleet, harness);
  const local = buildLocalRuns(config, opts, base, runtime);
  Object.assign(late, local);
  return {
    config,
    store: base.store,
    connector: base.connector,
    agents: fleet.agents,
    escalations: fleet.escalations,
    proposals: fleet.proposals,
    landings: fleet.landings,
    permissions: fleet.permissions,
    areaPaths: base.areaPaths,
    recovery: fleet.recovery,
    ejections: fleet.ejections,
    executor: fleet.executor,
    readying: fleet.readying,
    dispatcher: fleet.dispatcher,
    harness,
    localCycles: pulse.localCycles,
    ingress: pulse.ingress,
    ingressCycles: pulse.ingressCycles,
    graph: bench.graph,
    tickets: bench.tickets,
    pool: bench.pool,
    filing: bench.filing,
    upstream: bench.upstream,
    watch: envs.watchDryRun,
    stateQueries: envs.stateQueries,
    remoteValidation: envs.remoteValidation,
    validationReady: bench.validationReady,
    remoteRuns: envs.remoteRuns,
    remoteReadings: envs.remoteReadings,
    remoteListings: envs.remoteListings,
    updates: bench.updates,
    runtimeControl: base.runtimeControl,
    pets: pulse.pets,
    predictions: channels.predictions,
    localRun: local.localRun,
    localRunWatch: local.localRunWatch,
    localValidations: local.localValidations,
    liveConfig: fleet.liveConfig,
    configFile: opts.configFile ?? configFilePath(),
    projectConfigFile: opts.projectConfigFile ?? projectConfigFilePath(config.repoRoot),
    issuePickup: fleet.issuePickup,
    prompts: channels.prompts,
    fileEvents: runtime.fileEvents,
    attachments: runtime.attachments,
    mcp: channels.mcp,
    desktop: channels.desktop,
    worktrees: base.worktrees,
    errors: base.errors,
  };
}

type Foundation = ReturnType<typeof buildFoundation>;

function buildFoundation(config: Config, opts: BuildOptions) {
  const store = new Store(config.dbPath);
  store.mcpCalls.compactMcpCallArgs(config.mcpArgsRetentionDays, true);
  store.surfaceReach.pruneSurfaceReach(true);
  const now = (): string => new Date().toISOString();
  const errors = new ErrorLog(store, opts.errorMirror);
  const ingressInbox = new IngressInbox();
  const integrations = buildIntegrations(config.integrations, { store, config, now, errors });
  const connector = new CompositeConnector(integrations, now, {
    hotMaxAgeMs: config.hotReadMaxAgeMs,
    coldMaxAgeMs: config.coldReadMaxAgeMs,
  });
  const areaPaths = new AreaPathDirectory(connector, { now: () => Date.now(), errors });
  const backend = opts.backend ?? new NodePtyBackend();

  const runtimeControl = new RuntimeControl(config.maxConcurrentAgents, config.startPaused);

  const worktrees =
    opts.worktrees ??
    new WorktreeManager(
      config.repoRoot,
      config.worktreeRoot,
      {
        get size() {
          // Grown by the ejections, not shared with them: a held slot the cap did not
          // account for is a dispatch refused for want of a directory, forever.
          return defaultPoolSize(runtimeControl.cap) + store.ejections.liveEjections().length;
        },
        held: (branch) =>
          store.tasks.findActiveTaskByBranch(branch) !== null || store.ejections.ejectionOnBranch(branch) !== null,
      },
      config.localRunRoot,
      errors,
    );
  const gitObserver = opts.gitObserver ?? new GitCliObserver(config.repoRoot, errors);
  return {
    store,
    now,
    errors,
    ingressInbox,
    connector,
    sink: opts.sink ?? connector,
    areaPaths,
    backend,
    runtimeControl,
    worktrees,
    gitObserver,
    watchLabel: watchLabelFor(config.labelPrefix),
  };
}

type ArgsBuilder = (opts: {
  sessionId: string;
  resume: boolean;
  mcpConfigPath: string | null;
  extraAllowedTools: string[];
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  sealed: boolean;
}) => string[];

type AgentRuntime = ReturnType<typeof buildAgentRuntime>;

function buildAgentRuntime(config: Config, opts: BuildOptions, { backend, errors }: Foundation) {
  const realTransport = opts.backend === undefined && opts.streamSpawner === undefined;
  const reapTree: ProcessReaper =
    opts.reapProcessTree ??
    (realTransport
      ? (pid) => killProcessTree(pid, (message) => errors.record({ source: 'agent', message }))
      : () => {});
  const ptyFactory = (): SessionFactory => {
    return (spec) =>
      new PtySession(backend, {
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
        waitingPatterns: spec.waitingPatterns,
        submitDelayMs: config.agentSubmitDelayMs,
        onWarning: (message) => errors.record({ source: 'agent', message }),
        reap: reapTree,
      });
  };
  const streamFactory: SessionFactory = (spec) =>
    new StreamJsonSession(spec, opts.streamSpawner, reapTree, config.agentSilenceParkMs);

  const attachments = new AttachmentFiles(config.attachmentRoot);
  const additionalDirectories = [config.attachmentRoot, config.validationRoot];

  const perm = config.agentPermissionMode;
  const extraArgs = config.claudeArgs;
  const allowedTools = config.agentAllowedTools;
  const permissionPromptTool = PERMISSION_PROMPT_TOOL;

  const agentSetup = {
    stream: {
      buildArgs: (({ sessionId, resume, mcpConfigPath, extraAllowedTools, model, effort, permissionMode, sealed }) =>
        buildClaudeStreamArgs({
          permissionMode: permissionMode ?? perm,
          extraArgs,
          allowedTools: sealed ? [] : allowedTools,
          additionalDirectories,
          sessionId,
          resume,
          fileEvents: true,
          mcpConfigPath,
          extraAllowedTools,
          permissionPromptTool: sealed ? undefined : permissionPromptTool,
          sealed,
          model: model ?? undefined,
          effort: effort ?? undefined,
        })) as ArgsBuilder,
      factory: streamFactory,
      initialInput: (task: Parameters<typeof buildInitialMessage>[0]) => buildInitialMessage(task),
      resumeInput: buildResumeMessage,
      promptDelayMs: 0,
      resumable: true,
    },
    raw: {
      buildArgs: (() => config.claudeArgs) as ArgsBuilder,
      factory: ptyFactory(),
      initialInput: undefined,
      resumeInput: undefined,
      promptDelayMs: config.agentPromptDelayMs,
      resumable: false,
    },
  }[config.agentMode];

  const fileEvents = new FileEventsSpool(join(tmpdir(), 'lubbdubb', 'events'));
  return { realTransport, reapTree, attachments, agentSetup, fileEvents };
}

type Channels = ReturnType<typeof buildChannels>;

function buildChannels(config: Config, base: Foundation, late: Late) {
  const { store, errors, connector, sink, areaPaths, runtimeControl, watchLabel } = base;
  const predictions = store.openPredictions();
  const mcp: McpBridgeServer = new McpBridgeServer({
    store,
    agents: (): AgentManager => late.agents,
    argsRetentionDays: config.mcpArgsRetentionDays,
    configDir: defaultConfigDir(),
    socketPath: defaultSocketPath(),
    profiles: orderedProfiles(config.agentModels),
    reviewModes: reviewModeNames(config.review),
    reviewAllowSkip: config.review.allowSkip,
    checkSets: config.validation.checkSets,
    autoUseAgentDescriptions: config.autoUseAgentDescriptions,
    repoRoot: config.repoRoot,
    areaPaths: (): AreaPathTree | null => areaPaths.current(),
    permissions: (): PermissionDesk => late.permissions,
    openPr: (): McpToolDeps['openPr'] => ({
      sink,
      defaultBranch: config.defaultBranch,
      prompts,
      watchLabel,
      prRefStyle: prRefStyle(config.integrations.sourceControl),
    }),
    filing: (): McpToolDeps['filing'] => late.filing,
    prReply: (): McpToolDeps['prReply'] => late.executor,
    watch: (): McpToolDeps['watch'] => late.watchDryRun,
    state: (): McpToolDeps['state'] => late.stateQueries,
    localValidations: (): LocalValidationDesk => late.localValidations,
    remoteReadings: (): RemoteReadingDesk => late.remoteReadings,
    remoteListings: (): RemoteListingDesk => late.remoteListings,
    localRun: (): { runner: LocalRunner; watch: LocalRunWatch } => ({
      runner: late.localRun,
      watch: late.localRunWatch,
    }),
    // The one agent that may read a prediction is handed it through this seam, never the store.
    judge: judgeSeam(predictions, store),
    stepCapabilities: (): McpToolDeps['stepCapabilities'] => stepCapabilities(config.environments),
    errors,
  });

  const prompts = loadPromptTemplates(config.promptTemplatesDir);

  const reviewCharters = loadReviewCharters(config.repoRoot, config.review, (error, path) =>
    errors.record({
      source: 'boot',
      message: `Review charter "${path}" could not be read; the reviewer runs without it.`,
      detail: error instanceof Error ? error.message : String(error),
    }),
  );

  const desktop = new McpDesktopServer({
    store,
    // The desktop channel is the operator's own Claude Code, and it can read a plan
    // aloud. It is handed the *answer* to whether a plan is withheld, never the means
    // to ask — src/mcp/ must not be able to name the prediction store.
    planWithheld: (plan) => planIsWithheld({ config, predictions }, plan),
    argsRetentionDays: config.mcpArgsRetentionDays,
    claimMinutes: config.validation.desktopClaimMinutes,
    validationRoot: config.validationRoot,
    environments: config.environments,
    prRefStyle: prRefStyle(config.integrations.sourceControl),
    localRun: (): LocalRunner => late.localRun,
    localRunWatch: (): LocalRunWatch => late.localRunWatch,
    runtimeControl,
    harness: () => late.harness,
    escalations: () => late.escalations,
    permissions: () => late.permissions,
    recovery: () => late.recovery,
    ejections: () => late.ejections,
    agents: () => late.agents,
    filing: () => late.filing,
    briefConfig: () => config,
    renderTicketBody: (vars) => prompts.render('brief-ticket-body', vars),
    profileNames: () => orderedProfiles(config.agentModels).map((p) => p.name),
    connector,
    labelPrefix: config.labelPrefix,
    issueContainerTypes: config.issueContainerTypes,
    agentModels: config.agentModels,
    proposals: () => late.proposals,
    runCycle: () => late.harness.runCycle('manual').then(() => undefined),
    now: () => new Date().toISOString(),
    socketPath: config.validation.desktopSocketPath,
    credentialPath: config.validation.desktopCredentialPath,
    errors,
  });
  return { predictions, mcp, prompts, reviewCharters, desktop };
}

type Fleet = ReturnType<typeof buildFleet>;

type Crew = ReturnType<typeof buildAgentManager>;

function buildAgentManager(
  config: Config,
  base: Foundation,
  { agentSetup, fileEvents }: AgentRuntime,
  { mcp }: Channels,
  late: Late,
) {
  const { store, connector, errors } = base;
  const sequenceWatchPolicy: IssuePickupPolicy = {
    watchLabel: watchLabelFor(config.labelPrefix),
    requireOwnLabel: config.ownWorkOnly && config.userId !== undefined,
    priorityLabels: {},
    defaultPriority: 0,
  };

  const featureBoard = (): FeatureBoardFacts | null =>
    featureSummariesOn(config, connector)
      ? {
          containerTypes: config.issueContainerTypes,
          watchLabel: watchLabelFor(config.labelPrefix),
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
    watch: { run: (originRef: string): Promise<string[]> => late.watchDryRun.run(originRef) },
    errors,
  });
  return { sequenceWatchPolicy, featureBoard, agents };
}

function buildFleet(
  config: Config,
  opts: BuildOptions,
  base: Foundation,
  { agentSetup }: AgentRuntime,
  { prompts, reviewCharters }: Channels,
  crew: Crew,
) {
  const { store, connector, sink, now, errors, worktrees, runtimeControl, watchLabel } = base;
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
    issuePickup,
    dispatcher,
    liveConfig,
  };
}

type IntakeDesks = ReturnType<typeof buildIntakeDesks>;

function buildIntakeDesks(config: Config, opts: BuildOptions, base: Foundation, { prompts }: Channels) {
  const { store, sink, errors, gitObserver, worktrees, watchLabel } = base;
  const plans = new PlanReconciler({
    store,
    git: gitObserver,
    sink,
    planning: config.planning,
    defaultBranch: config.defaultBranch,
    prRefStyle: prRefStyle(config.integrations.sourceControl),
    fetch: opts.gitObserver ? undefined : () => fetchRemote(config.repoRoot),
    errors,
  });

  const appraisals = new AppraisalDesk({ store, sink, errors });
  const prAuthorConfigured = config.ownWorkOnly && config.userId !== undefined;
  const naming = new PrNamingDesk({
    sink,
    defaultBranch: config.defaultBranch,
    prAuthorConfigured,
    template: prompts.render('pr-title', {}),
    errors,
  });
  const prDescriptions = new PrDescriptionDesk({ sink, store, errors });

  const prWatch = new PrWatchDesk({
    sink,
    store,
    watchLabel,
    legacyIgnoreLabel: config.labelPrefix ? `${config.labelPrefix}-ignore` : '',
    errors,
  });

  const prWorkItems = new PrWorkItemDesk({
    sink,
    store,
    prAuthorConfigured,
    errors,
  });

  const branchReaps = new BranchReapDesk({
    sink,
    store,
    worktrees,
    defaultBranch: config.defaultBranch,
    prAuthorConfigured,
    errors,
  });
  return { plans, appraisals, naming, prDescriptions, prWatch, prWorkItems, branchReaps };
}

type EnvironmentDesks = ReturnType<typeof buildEnvironmentDesks>;

function buildEnvironmentDesks(config: Config, opts: BuildOptions, base: Foundation) {
  const { store, sink, errors, gitObserver } = base;
  const environmentObserver = opts.environmentObserver ?? new CommandEnvironmentObserver(config.repoRoot);
  const environments = new EnvironmentDesk({
    store,
    environments: config.environments,
    prober: opts.environmentProber ?? new CommandEnvironmentProber(config.repoRoot),
    healthProber: opts.environmentHealthProber ?? new CommandEnvironmentHealthProber(config.repoRoot),
    git: gitObserver,
    sink,
    integrationBranch: config.defaultBranch,
    probeIntervalMs: config.environmentProbeIntervalMs,
    healthIntervalMs: config.environmentHealthIntervalMs,
    watch: new WatchDesk({
      store,
      environments: config.environments,
      observer: environmentObserver,
      probeIntervalMs: config.environmentProbeIntervalMs,
      watchIntervalMs: config.watchIntervalMs,
      errors,
    }),
    errors,
  });

  const watchDryRun = new WatchDryRun({
    store,
    environments: config.environments,
    observer: environmentObserver,
  });

  const stateQueries = new StateQueryDesk({
    store,
    environments: config.environments,
    reader: opts.stateReader ?? new CommandStateReader(config.repoRoot),
  });

  const remoteValidation = new RemoteValidationDesk({
    store,
    environments: config.environments,
    observer: environmentObserver,
    queries: stateQueries,
    scriptGraceMs: config.remoteValidation.scriptGraceMs,
    probeIntervalMs: config.environmentProbeIntervalMs,
    sink,
    validationRoot: config.validationRoot,
    errors,
  });

  const remoteRuns = new RemoteRunDesk({
    store,
    environments: config.environments,
    desk: remoteValidation,
    prober: opts.environmentProber ?? new CommandEnvironmentProber(config.repoRoot),
    git: gitObserver,
    tenants:
      opts.tenants ??
      new CommandTenantKeeper({
        repoRoot: config.repoRoot,
        logRoot: tenantLogRoot(config.validationRoot),
        timeoutMs: config.remoteValidation.tenantTimeoutMs,
      }),
    errors,
  });

  // A tenant preparation the last process left open. The command outlives the harness, so one still
  // running is followed, and only one that is gone is closed as not knowable from here.
  // → docs/spec/36-remote-validation.md#what-the-gate-shows-while-it-runs
  remoteRuns.resumeTenantPrepares();

  const remoteListings = new RemoteListingDesk({ store, errors });

  const remoteReadings = new RemoteReadingDesk({
    store,
    environments: config.environments,
    prober: opts.environmentProber ?? new CommandEnvironmentProber(config.repoRoot),
    validationRoot: config.validationRoot,
    errors,
  });
  return { environments, watchDryRun, stateQueries, remoteValidation, remoteRuns, remoteListings, remoteReadings };
}

type BenchDesks = ReturnType<typeof buildBenchDesks>;

function buildBenchDesks(
  config: Config,
  opts: BuildOptions,
  base: Foundation,
  { prompts, predictions }: Channels,
  { sequenceWatchPolicy, agents }: Fleet,
) {
  const { store, connector, sink, now, errors, runtimeControl, watchLabel } = base;
  const closeOutSink = sink;
  const closeOuts = new DeliveryCloseOutDesk(
    store,
    config.environments,
    () => closeOutSink.canCloseIssue(),
    // The one place the close-out bench and the prediction record meet, and it
    // hands over origin refs alone. With the gate off the set is empty, which is
    // also what settles any row that was standing when it was turned off.
    () => (revealGateOn(config) ? new Set(predictions.listOutcomeOwed()) : new Set()),
  );

  const unwatchedChildren = new UnwatchedChildDesk({
    store,
    containerTypes: config.issueContainerTypes,
    watched: (issue) => issueWatchGateReason(issue, sequenceWatchPolicy) === null,
    errors,
  });

  const validationAsks = new ValidationAskDesk(store);

  const validationReady = new ValidationReadyDesk(store, config.environments);

  const burn = new SpendBurnDesk(store, config.spendBurn, config.agentModels);

  const runway = new RunwayDesk(store, config.runway);

  const schedules = new ScheduleDesk({ store, errors });

  const updates = new UpdateDesk({
    store,
    runtimeControl,
    errors,
    remote: config.selfUpdate.remote,
    branch: config.selfUpdate.branch,
    checkIntervalMs: config.selfUpdate.checkIntervalMs,
    autoUpdate: config.selfUpdate.autoUpdate,
    drainDeadlineMs: config.selfUpdate.drainDeadlineMs,
    projectAutoPull: config.selfUpdate.projectAutoPull,
    snoozeMs: config.selfUpdate.snoozeMs,
    project: { root: config.repoRoot, remote: 'origin', branch: config.defaultBranch },
  });

  const filing = ticketFiler(config, sink);
  const upstream = opts.upstream ?? ghCliUpstreamIssues();
  const graph = new WorkGraphRecorder({ store, errors });

  const tickets = new TicketSweep({ store, source: connector, errors });

  const obstacles = new ObstacleDesk({
    store,
    fleet: agents,
    dormantMs: config.obstacleDormantMs,
    watchLabel,
    ticketApproval: config.obstacleTicketApproval,
    reader: opts.obstacleReader,
    repoRoot: config.repoRoot,
    filing: trackerCoordinates(config) ? filing : undefined,
    ticketBody: (vars) => prompts.render('obstacle-ticket-body', vars),
    docsPrompt: (vars) => prompts.render('docs-change', vars),
    errors,
  });

  const fleetId = config.fleetId ?? '';
  const poolTransport =
    opts.poolTransport ??
    (config.integrations.pool === 'fake'
      ? undefined
      : buildPoolTransport(config.integrations, { store, config, now, errors }));
  const pool =
    poolTransport === undefined || fleetId === ''
      ? undefined
      : new PoolDesk({
          store,
          transport: poolTransport,
          fleetId,
          project: config.pool?.project ?? '',
          harnessVersion: harnessVersion(),
          now,
          digestIntervalMs: config.pool?.digestIntervalMs ?? 60 * 60 * 1000,
          worldScope: worldScope(config.integrations, { store, config, now, errors }),
          errors,
        });
  return {
    closeOuts,
    unwatchedChildren,
    validationAsks,
    validationReady,
    burn,
    runway,
    schedules,
    updates,
    filing,
    upstream,
    graph,
    tickets,
    obstacles,
    pool,
  };
}

function buildHarness(
  config: Config,
  opts: BuildOptions,
  base: Foundation,
  { predictions }: Channels,
  fleet: Fleet,
  intake: IntakeDesks,
  envs: EnvironmentDesks,
  bench: BenchDesks,
  late: Late,
): Harness {
  const { store, connector, areaPaths, errors, runtimeControl, ingressInbox, watchLabel } = base;
  const { featureBoard } = fleet;
  return new Harness({
    store,
    connector,
    dispatcher: fleet.dispatcher,
    executor: fleet.executor,
    featureStandings: (): { number: number; title: string; key: string }[] => {
      const facts = featureBoard();
      if (!facts) return [];
      return featureRecords(store, facts).map((f) => ({ number: f.number, title: f.title, key: f.key }));
    },
    plans: intake.plans,
    appraisals: intake.appraisals,
    areaPaths,
    naming: intake.naming,
    prDescriptions: intake.prDescriptions,
    closeOuts: bench.closeOuts,
    unwatchedChildren: bench.unwatchedChildren,
    validationAsks: bench.validationAsks,
    validationReady: bench.validationReady,
    burn: bench.burn,
    runway: bench.runway,
    issuePickup: fleet.issuePickup,
    branchReaps: intake.branchReaps,
    environments: envs.environments,
    remoteValidation: envs.remoteValidation,
    prWatch: intake.prWatch,
    prWorkItems: intake.prWorkItems,
    review: config.review,
    reviewProber:
      config.review.reviewedElsewhere === null
        ? undefined
        : (opts.reviewProber ?? new CommandReviewProber(config.repoRoot)),
    schedules: bench.schedules,
    updates: config.selfUpdate.enabled ? bench.updates : undefined,
    graph: bench.graph,
    tickets: bench.tickets,
    localRun: { noteAlive: () => late.localRun.noteAlive() },
    localValidations: {
      sweep: () => {
        late.localValidations.sweep();
      },
    },
    // Computed here rather than in the rule: `src/remoteValidation/` is a lens as far as the
    // dispatcher is concerned, so what reaches it is a run row and a rendered string.
    goalIntake: () => ({
      closedSittings: revealGateOn(config) ? new Set(predictions.listReveals().map((r) => r.originRef)) : null,
      criteria: config.goalCriteria.enabled ? store.goalCriteria.listCurrentCriteria() : [],
      judgeOwed: config.prediction.enabled ? predictions.listJudgeOwed() : [],
    }),
    remoteRuns: () =>
      remoteRunBriefs({
        store,
        environments: config.environments,
        validationRoot: config.validationRoot,
        // The one browser block, read by both dispatches. Off the live config each pulse, so an
        // operator who configures one does not have to restart the harness to use it.
        browser: config.localValidation.browser,
      }),
    landings: fleet.landings,
    recovery: fleet.recovery,
    ejections: fleet.ejections,
    escalations: fleet.escalations,
    fleet: fleet.agents,
    obstacles: bench.obstacles,
    pool: bench.pool,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    idleHeartbeatIntervalMs: config.idleHeartbeatIntervalMs,
    stuckCycleAfterMs: opts.stuckCycleAfterMs,
    readLanes: { hotMaxAgeMs: config.hotReadMaxAgeMs, coldMaxAgeMs: config.coldReadMaxAgeMs },
    errors,
    runtime: runtimeControl,
    prWatchLabel: watchLabel,
    modelPins:
      config.labelPrefix && config.agentModels
        ? { labelPrefix: config.labelPrefix, models: config.agentModels }
        : undefined,
    upNextOverrideTtlMs: config.upNextOverrideTtlMs,
    freshReads: ingressInbox,
  });
}

function wirePulse(config: Config, opts: BuildOptions, base: Foundation, fleet: Fleet, harness: Harness) {
  const { store, errors, worktrees, runtimeControl, ingressInbox } = base;
  const { agents, escalations } = fleet;
  agents.on('waiting', ({ agentId, taskId, reason, ask }) => {
    if (store.escalations.listOpenEscalations().some((e) => e.agentId === agentId)) return;
    const task = store.tasks.getTask(taskId);
    escalations.create({
      type: escalationTypeForAsk(ask?.kind),
      prompt: reason,
      context: {
        taskTitle: task?.title,
        originRef: task?.originRef ?? null,
        recentOutput: isSealedRule(task?.rule) ? '' : recentOutputExcerpt(store.transcripts.getTranscript(agentId)),
        ...(ask?.options ? { options: ask.options } : {}),
        ...(ask?.detail ? { detail: ask.detail } : {}),
        ...(ask?.questions ? { questions: ask.questions } : {}),
      },
      agentId,
      taskId,
    });
  });

  agents.on('status', ({ agentId, status }) => {
    if (status === 'killed') escalations.dismissEscalationsForAgent(agentId, 'agent killed');
  });
  agents.on('done', ({ agentId, status, by }) => {
    escalations.dismissEscalationsForAgent(
      agentId,
      status === 'failed'
        ? 'agent failed'
        : by === 'operator'
          ? 'operator marked the work complete'
          : by === 'expiry'
            ? 'nobody answered the stop, so the harness recorded the work complete'
            : 'agent finished its work',
    );
  });

  agents.on('reaped', ({ taskId }) => {
    const task = store.tasks.getTask(taskId);
    const branch = task?.branch;
    if (!branch) return;
    if (store.tasks.hasActiveTaskOnBranch(branch, taskId)) return;
    void worktrees.remove(branch).catch((err: Error) => {
      errors.record({ source: 'agent', message: `Failed to release the worktree slot for ${branch}: ${err.message}` });
    });
  });

  const localCycles = new CycleTrigger({
    run: () => harness.runCycle('local'),
    ready: () => store.open,
    errors,
  });
  agents.on('done', () => localCycles.request());
  agents.on('reaped', () => localCycles.request());

  const ingressCycles = new CycleTrigger({
    run: () => harness.runCycle('ingress'),
    ready: () => store.open,
    errors,
    debounceMs: config.ingress.debounceMs,
    minGapMs: config.ingress.minCycleGapMs,
  });
  const ingress = new Ingress({
    secrets: opts.ingressSecrets ?? resolveIngressSecrets(),
    inbox: ingressInbox,
    trigger: ingressCycles,
    errors,
  });

  const pets = new PetKeeper(store, config.pets);
  const prewarm = new PrewarmDesk({
    worktrees,
    upcoming: () => harness.upcoming?.items ?? [],
    enabled: () => config.prewarmWorktrees && harness.running && !runtimeControl.paused,
    errors,
  });
  harness.on('cycle:end', () => {
    try {
      pets.scan();
    } catch (err) {
      errors.record({ source: 'cycle', message: `Pet scan failed: ${(err as Error).message}` });
    }
    // Deliberately not awaited: a cycle that waited for the warming would have moved the wait it
    // exists to remove back onto the critical path. → docs/spec/09-execution.md
    prewarm.run();
  });
  return { localCycles, ingressCycles, ingress, pets };
}

function buildLocalRuns(config: Config, opts: BuildOptions, base: Foundation, runtime: AgentRuntime) {
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
