import { tmpdir } from 'node:os';
import { prRefStyle } from './prRef.js';
import { join } from 'node:path';
import { configFilePath, projectConfigFilePath, type Config } from './config.js';
import { Store } from './store/store.js';
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
import { GitCliObserver, type GitObserver } from './git/gitObserver.js';
import { fetchRemote } from './git/gitCli.js';
import { ReviewPackAuthor } from './reviewPacks/author.js';
import { ReviewPackChecker } from './reviewPacks/checker.js';
import { PlanReconciler } from './plans/planReconciler.js';
import { AppraisalDesk } from './intake/appraisalDesk.js';
import { AreaPathDirectory } from './intake/areaPaths.js';
import type { AreaPathTree } from './intake/placement.js';
import { TicketSweep } from './tickets/sweep.js';
import { WorkGraphRecorder } from './graph/workGraphRecorder.js';
import { AgentManager } from './agents/agentManager.js';
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
import { ObstacleModelDesk, type ObstacleReader } from './obstacles/desk.js';
import { ObstacleEndingsDesk } from './obstacles/endingsDesk.js';
import { ObstacleNoticeDesk } from './obstacles/noticeDesk.js';
import { ObstacleOwnershipDesk } from './obstacles/ownershipDesk.js';
import { ObstacleVoiceDesk } from './obstacles/voiceDesk.js';
import { trackerCoordinates } from './mcp/findings.js';
import { PrNamingDesk } from './prNamingDesk.js';
import { DeliveryCloseOutDesk } from './delivery/closeOutDesk.js';
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
import { CommandTenantKeeper, type TenantKeeper } from './remoteValidation/tenants.js';
import { CommandRemoteRunner, type RemoteRunner } from './remoteValidation/runner.js';
import { WatchDesk } from './environments/watchDesk.js';
import { stateDeclareNote, testPartNote, watchDeclareNote, watchNote } from './plans/planning.js';
import { remoteRunBriefs } from './remoteValidation/briefing.js';
import { PrWatchDesk } from './prWatchDesk.js';
import { PrWorkItemDesk } from './prWorkItemDesk.js';
import { ScheduleDesk } from './schedules/scheduleDesk.js';
import { UpdateDesk } from './selfUpdate/updateDesk.js';
import type { McpToolDeps } from './mcp/tools/context.js';
import { PERMISSION_PROMPT_TOOL } from './mcp/names.js';
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
import { featureBoardOn } from './features/featureBoard.js';
import { featureRecords } from './summaries/featureRecord.js';
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
import { LiveConfig } from './configApply.js';
import { ErrorLog } from './errorLog.js';
import type { ErrorLogEntry } from './types.js';

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
  remoteRuns: RemoteRunDesk;
  filing: TicketFiler;
  upstream: UpstreamIssues;
  updates: UpdateDesk;
  runtimeControl: RuntimeControl;
  pets: PetKeeper;
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
  reviewPacks: ReviewPackAuthor;
  reviewPackChecker: ReviewPackChecker;
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
  remoteRunner?: RemoteRunner;
  errorMirror?: (entry: ErrorLogEntry) => void;
  ingressSecrets?: IngressSecrets;
  configFile?: string;
  projectConfigFile?: string;
  upstream?: UpstreamIssues;
  poolTransport?: PoolTransport;
  obstacleReader?: ObstacleReader;
  bootedAt?: string;
}

export function buildSystem(config: Config, opts: BuildOptions = {}): System {
  const store = new Store(config.dbPath);
  store.compactMcpCallArgs(config.mcpArgsRetentionDays, true);
  store.pruneSurfaceReach(true);
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
          return defaultPoolSize(runtimeControl.cap) + store.liveEjections().length;
        },
        held: (branch) => store.findActiveTaskByBranch(branch) !== null || store.ejectionOnBranch(branch) !== null,
      },
      config.localRunRoot,
      errors,
    );
  const gitObserver = opts.gitObserver ?? new GitCliObserver(config.repoRoot);

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

  type ArgsBuilder = (opts: {
    sessionId: string;
    resume: boolean;
    mcpConfigPath: string | null;
    extraAllowedTools: string[];
    model: string | null;
    effort: string | null;
  }) => string[];
  const agentSetup = {
    stream: {
      buildArgs: (({ sessionId, resume, mcpConfigPath, extraAllowedTools, model, effort }) =>
        buildClaudeStreamArgs({
          permissionMode: perm,
          extraArgs,
          allowedTools,
          additionalDirectories,
          sessionId,
          resume,
          fileEvents: true,
          mcpConfigPath,
          extraAllowedTools,
          permissionPromptTool,
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

  const mcp: McpBridgeServer = new McpBridgeServer({
    store,
    agents: (): AgentManager => agents,
    argsRetentionDays: config.mcpArgsRetentionDays,
    configDir: defaultConfigDir(),
    socketPath: defaultSocketPath(),
    profiles: orderedProfiles(config.agentModels),
    reviewModes: reviewModeNames(config.review),
    reviewAllowSkip: config.review.allowSkip,
    repoRoot: config.repoRoot,
    areaPaths: (): AreaPathTree | null => areaPaths.current(),
    permissions: (): PermissionDesk => permissions,
    openPr: (): McpToolDeps['openPr'] => ({
      sink: opts.sink ?? connector,
      defaultBranch: config.defaultBranch,
      prompts,
      watchLabel,
      prRefStyle: prRefStyle(config.integrations.sourceControl),
    }),
    filing: (): McpToolDeps['filing'] => filing,
    prReply: (): McpToolDeps['prReply'] => executor,
    watch: (): McpToolDeps['watch'] => watchDryRun,
    state: (): McpToolDeps['state'] => stateQueries,
    reviewPacks: (): McpToolDeps['reviewPacks'] => reviewPacks,
    localValidations: (): LocalValidationDesk => localValidations,
    localRun: (): { runner: LocalRunner; watch: LocalRunWatch } => ({ runner: localRun, watch: localRunWatch }),
    reviewPackChecker: (): McpToolDeps['reviewPackChecker'] => reviewPackChecker,
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
    argsRetentionDays: config.mcpArgsRetentionDays,
    claimMinutes: config.validation.desktopClaimMinutes,
    validationRoot: config.validationRoot,
    environments: config.environments,
    prRefStyle: prRefStyle(config.integrations.sourceControl),
    localRun: (): LocalRunner => localRun,
    localRunWatch: (): LocalRunWatch => localRunWatch,
    runtimeControl,
    harness: () => harness,
    escalations: () => escalations,
    permissions: () => permissions,
    recovery: () => recovery,
    ejections: () => ejections,
    agents: () => agents,
    filing: () => filing,
    briefConfig: () => config,
    renderTicketBody: (vars) => prompts.render('brief-ticket-body', vars),
    profileNames: () => orderedProfiles(config.agentModels).map((p) => p.name),
    connector,
    labelPrefix: config.labelPrefix,
    issueContainerTypes: config.issueContainerTypes,
    agentModels: config.agentModels,
    proposals: () => proposals,
    runCycle: () => harness.runCycle('manual').then(() => undefined),
    now: () => new Date().toISOString(),
    socketPath: config.validation.desktopSocketPath,
    credentialPath: config.validation.desktopCredentialPath,
    errors,
  });

  const sequenceWatchPolicy: IssuePickupPolicy = {
    watchLabel: watchLabelFor(config.labelPrefix),
    requireOwnLabel: config.ownWorkOnly && config.userId !== undefined,
    priorityLabels: {},
    defaultPriority: 0,
  };

  const featureBoard = featureBoardOn(config, connector)
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
    goalProfile:
      config.labelPrefix && config.agentModels
        ? {
            effective: (issueOrigin: string): string | null => {
              const models = config.agentModels;
              const number = Number(/^issue:(\d+)$/.exec(issueOrigin)?.[1]);
              const issue = Number.isFinite(number)
                ? store.getWorldBaseline()?.issues.find((i) => i.number === number)
                : undefined;
              return resolveModelTag(issue?.labels, config.labelPrefix, models).profile ?? models?.default ?? null;
            },
          }
        : undefined,
    featureStanding: featureBoard
      ? (featureOrigin: string): string | null =>
          featureRecords(store, featureBoard).find((f) => `issue:${f.number}` === featureOrigin)?.key ?? null
      : undefined,
    featureSequenceStanding: (featureOrigin: string): { key: string; members: number[] } | null => {
      const found = sequenceableFeatures(
        store.getWorldBaseline()?.issues ?? [],
        config.issueContainerTypes,
        (issue) => issueWatchGateReason(issue, sequenceWatchPolicy) === null,
        config.issueSequenceMaxChildren,
      ).find((f) => `issue:${f.feature.number}` === featureOrigin);
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
    watch: { run: (originRef: string): Promise<string[]> => watchDryRun.run(originRef) },
    errors,
  });
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
    sink: opts.sink ?? connector,
    agentModels: config.agentModels,
    deskRoot: config.deskRoot,
    defaultBranch: config.defaultBranch,
    runtime: runtimeControl,
    errors,
    autoSendReplies: () => config.sendPrRepliesWithoutApproval,
    ciEvidence: opts.ciEvidence ?? connector,
    instructionTracker: (issueNumber) => ticketAmendCommands(config, issueNumber),
    featureBoard: featureBoard ?? undefined,
  });

  const reviewPacks = new ReviewPackAuthor({
    store,
    agents,
    worktrees,
    git: gitObserver,
    prompts,
    defaultBranch: config.defaultBranch,
    runtime: runtimeControl,
    fetch: opts.gitObserver ? undefined : () => fetchRemote(config.repoRoot),
    errors,
  });

  const reviewPackChecker = new ReviewPackChecker({
    store,
    agents,
    worktrees,
    git: gitObserver,
    prompts,
    defaultBranch: config.defaultBranch,
    runtime: runtimeControl,
    errors,
  });

  const proposals = new ProposalDesk(store, escalations, executor, {
    sink: opts.sink ?? connector,
    config,
    errors,
  });

  const watchLabel = watchLabelFor(config.labelPrefix);
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
  const rules = new RuleDispatcher(
    issuePickup,
    {},
    prompts,
    config.defaultBranch,
    config.planning,
    config.ci,
    config.validation,
    config.validationRoot,
    prRefStyle(config.integrations.sourceControl),
    config.review,
    reviewCharters,
    watchNote(config.environments),
    watchDeclareNote(config.environments),
    undefined,
    testPartNote(config.environments),
    stateDeclareNote(config.environments),
    config.environments.some((env) => env.validate !== undefined),
  );
  const dispatcher: Dispatcher = rules;

  const liveConfig = new LiveConfig({ running: config, runtimeControl, dispatcher: rules });

  const plans = new PlanReconciler({
    store,
    git: gitObserver,
    sink: opts.sink ?? connector,
    planning: config.planning,
    defaultBranch: config.defaultBranch,
    prRefStyle: prRefStyle(config.integrations.sourceControl),
    fetch: opts.gitObserver ? undefined : () => fetchRemote(config.repoRoot),
    errors,
  });

  const appraisals = new AppraisalDesk({ store, sink: opts.sink ?? connector, errors });
  const prAuthorConfigured = config.ownWorkOnly && config.userId !== undefined;
  const naming = new PrNamingDesk({
    sink: opts.sink ?? connector,
    defaultBranch: config.defaultBranch,
    prAuthorConfigured,
    template: prompts.render('pr-title', {}),
    errors,
  });
  const prWatch = new PrWatchDesk({
    sink: opts.sink ?? connector,
    store,
    watchLabel,
    legacyIgnoreLabel: config.labelPrefix ? `${config.labelPrefix}-ignore` : '',
    errors,
  });

  const prWorkItems = new PrWorkItemDesk({
    sink: opts.sink ?? connector,
    store,
    prAuthorConfigured,
    errors,
  });

  const branchReaps = new BranchReapDesk({
    sink: opts.sink ?? connector,
    store,
    worktrees,
    defaultBranch: config.defaultBranch,
    prAuthorConfigured,
    errors,
  });

  const environmentObserver = opts.environmentObserver ?? new CommandEnvironmentObserver(config.repoRoot);
  const environments = new EnvironmentDesk({
    store,
    environments: config.environments,
    prober: opts.environmentProber ?? new CommandEnvironmentProber(config.repoRoot),
    healthProber: opts.environmentHealthProber ?? new CommandEnvironmentHealthProber(config.repoRoot),
    git: gitObserver,
    sink: opts.sink ?? connector,
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
    runner: opts.remoteRunner ?? new CommandRemoteRunner(config.repoRoot, config.remoteValidation.runTimeoutMs),
    probeIntervalMs: config.environmentProbeIntervalMs,
    errors,
  });

  const remoteRuns = new RemoteRunDesk({
    store,
    environments: config.environments,
    desk: remoteValidation,
    prober: opts.environmentProber ?? new CommandEnvironmentProber(config.repoRoot),
    git: gitObserver,
    tenants: opts.tenants ?? new CommandTenantKeeper(config.repoRoot),
    errors,
  });

  const closeOutSink = opts.sink ?? connector;
  const closeOuts = new DeliveryCloseOutDesk(store, config.environments, () => closeOutSink.canCloseIssue());

  const validationAsks = new ValidationAskDesk(store);

  const validationReady = new ValidationReadyDesk(store, config.environments);

  const burn = new SpendBurnDesk(store, config.spendBurn);

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

  const filing = ticketFiler(config, opts.sink ?? connector);
  const upstream = opts.upstream ?? ghCliUpstreamIssues();
  const graph = new WorkGraphRecorder({ store, errors });

  const tickets = new TicketSweep({ store, source: connector, errors });

  const obstacleVoice = new ObstacleVoiceDesk({ store, errors });

  const obstacleDesk = opts.obstacleReader
    ? new ObstacleModelDesk({ store, reader: opts.obstacleReader, repoRoot: config.repoRoot, errors })
    : undefined;

  const obstacleNotices = new ObstacleNoticeDesk({ store, fleet: agents, errors });

  const obstacleOwnership = new ObstacleOwnershipDesk({
    store,
    filing: trackerCoordinates(config) ? filing : undefined,
    ticketBody: (vars) => prompts.render('obstacle-ticket-body', vars),
    watchLabel,
    errors,
  });

  const obstacleEndings = new ObstacleEndingsDesk({
    store,
    dormantMs: config.obstacleDormantMs,
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
          closedPrWindowMs: config.closedPrWindowMs,
          worldScope: worldScope(config.integrations, { store, config, now, errors }),
          errors,
        });

  const harness = new Harness({
    store,
    connector,
    dispatcher,
    executor,
    featureStandings: featureBoard
      ? (): { number: number; title: string; key: string }[] =>
          featureRecords(store, featureBoard).map((f) => ({ number: f.number, title: f.title, key: f.key }))
      : undefined,
    plans,
    appraisals,
    areaPaths,
    naming,
    closeOuts,
    validationAsks,
    validationReady,
    burn,
    runway,
    issuePickup,
    branchReaps,
    environments,
    remoteValidation,
    prWatch,
    prWorkItems,
    review: config.review,
    reviewProber:
      config.review.reviewedElsewhere === null
        ? undefined
        : (opts.reviewProber ?? new CommandReviewProber(config.repoRoot)),
    schedules,
    updates: config.selfUpdate.enabled ? updates : undefined,
    graph,
    tickets,
    localRun: { noteAlive: () => localRun.noteAlive() },
    localValidations: {
      sweep: () => {
        localValidations.sweep();
      },
    },
    // Computed here rather than in the rule: `src/remoteValidation/` is a lens as far as the
    // dispatcher is concerned, so what reaches it is a run row and a rendered string.
    remoteRuns: () =>
      remoteRunBriefs({ store, environments: config.environments, validationRoot: config.validationRoot }),
    landings,
    recovery,
    ejections,
    escalations,
    fleet: agents,
    obstacleVoice,
    obstacleDesk,
    obstacleNotices,
    obstacleOwnership,
    obstacleEndings,
    pool,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    idleHeartbeatIntervalMs: config.idleHeartbeatIntervalMs,
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

  agents.on('waiting', ({ agentId, taskId, reason, ask }) => {
    if (store.listOpenEscalations().some((e) => e.agentId === agentId)) return;
    const task = store.getTask(taskId);
    escalations.create({
      type: escalationTypeForAsk(ask?.kind),
      prompt: reason,
      context: {
        taskTitle: task?.title,
        originRef: task?.originRef ?? null,
        recentOutput: recentOutputExcerpt(store.getTranscript(agentId)),
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
    const task = store.getTask(taskId);
    const branch = task?.branch;
    if (!branch) return;
    const active = (s: string): boolean => s === 'queued' || s === 'running' || s === 'waiting';
    if (store.listTasks().some((t) => t.id !== taskId && t.branch === branch && active(t.status))) return;
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
  harness.on('cycle:end', () => {
    try {
      pets.scan();
    } catch (err) {
      errors.record({ source: 'cycle', message: `Pet scan failed: ${(err as Error).message}` });
    }
  });

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
      const plan = store.getPlanByOrigin(originRef);
      const number = planIssueNumber(originRef);
      const world = store.getWorldBaseline();
      const issue = number === null ? undefined : world?.issues.find((i) => i.number === number);
      const own = issue ? (openPrForIssue(issue, world?.pullRequests ?? [])?.branch ?? null) : null;
      return localRunChoices(plan ? store.listPlanParts(plan.id) : [], own);
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
      const plan = store.getPlanByOrigin(originRef);
      const parts = plan ? store.listPlanParts(plan.id) : [];
      const part = parts.find((p) => p.branch === ref);
      if (part !== undefined && number !== null) return partBase(part, bySlug(parts), number, config.defaultBranch);
      const pr = store.getWorldBaseline()?.pullRequests.find((p) => p.branch === ref);
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
  return {
    config,
    store,
    connector,
    agents,
    escalations,
    proposals,
    landings,
    permissions,
    areaPaths,
    recovery,
    ejections,
    executor,
    readying,
    dispatcher,
    harness,
    localCycles,
    ingress,
    ingressCycles,
    graph,
    tickets,
    pool,
    filing,
    upstream,
    watch: watchDryRun,
    stateQueries,
    remoteValidation,
    remoteRuns,
    updates,
    runtimeControl,
    pets,
    localRun,
    localRunWatch,
    localValidations,
    liveConfig,
    configFile: opts.configFile ?? configFilePath(),
    projectConfigFile: opts.projectConfigFile ?? projectConfigFilePath(config.repoRoot),
    issuePickup,
    prompts,
    fileEvents,
    attachments,
    mcp,
    desktop,
    worktrees,
    reviewPacks,
    reviewPackChecker,
    errors,
  };
}
