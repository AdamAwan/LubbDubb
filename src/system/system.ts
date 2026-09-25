import { prRefStyle } from '../pr/prRef.js';
import { configFilePath, projectConfigFilePath, revealGateOn, type Config } from '../config/config.js';
import { Store } from '../store/store.js';
import type { PredictionStore } from '../store/predictions.js';
import { CompositeConnector } from '../integrations/compositeConnector.js';
import { PoolDesk } from '../pool/poolDesk.js';
import type { TicketFiler } from '../tickets/filing.js';
import type { UpstreamIssues } from '../tickets/upstream.js';
import type { Worktrees } from '../worktree/worktreeManager.js';
import { PrewarmDesk } from '../worktree/prewarmDesk.js';
import { AreaPathDirectory } from '../intake/areaPaths.js';
import type { AreaPathTree } from '../intake/placement.js';
import { TicketSweep } from '../tickets/sweep.js';
import { WorkGraphRecorder } from '../graph/workGraphRecorder.js';
import { AgentManager } from '../agents/agentManager.js';
import { judgeSeam } from '../predictionJudge/seam.js';
import { FileEventsSpool } from '../agents/fileEvents.js';
import { AttachmentFiles } from '../jobs/attachmentFiles.js';
import { EscalationInbox } from '../escalation/escalationInbox.js';
import { ProposalDesk } from '../proposals/proposalDesk.js';
import { StackLandingDesk } from '../stacks/landingDesk.js';
import { escalationTypeForAsk, recentOutputExcerpt } from '../escalation/context.js';
import { defaultConfigDir, defaultSocketPath, McpBridgeServer } from '../mcp/server.js';
import { McpDesktopServer } from '../mcp/desktop.js';
import { ValidationReadyDesk } from '../validation/readyDesk.js';
import { CommandReviewProber } from '../review/reviewedElsewhere.js';
import type { WatchDryRunner } from '../environments/watchDryRun.js';
import { StateQueryDesk } from '../validation/remote/stateQueries.js';
import { RemoteValidationDesk } from '../validation/remote/desk.js';
import { RemoteRunDesk } from '../validation/remote/run.js';
import { RemoteReadingDesk } from '../validation/remote/readings.js';
import { RemoteListingDesk } from '../validation/remote/listing.js';
import { stepCapabilities } from '../validation/steps.js';
import { remoteRunBriefs } from '../validation/remote/briefing.js';
import { UpdateDesk } from '../selfUpdate/updateDesk.js';
import type { McpToolDeps } from '../mcp/tools/context.js';
import { isSealedRule } from '../mcp/names.js';
import { PermissionDesk } from '../agents/permissionDesk.js';
import { RecoveryDesk } from '../agents/recoveryDesk.js';
import { EjectionDesk } from '../ejection/desk.js';
import { ActionExecutor } from '../executor/actionExecutor.js';
import { ReadyingBoard } from '../executor/readying.js';
import { loadPromptTemplates, type PromptTemplates } from '../dispatcher/promptTemplates.js';
import { loadReviewCharters } from '../review/charter.js';
import { reviewModeNames } from '../review/prReview.js';
import type { Dispatcher } from '../dispatcher/dispatcher.js';
import type { IssuePickupPolicy } from '../dispatcher/issuePickup.js';
import { featureRecords } from '../featureSummaries/featureRecord.js';
import { orderedProfiles } from '../agents/modelPolicy.js';
import { Harness } from '../harness.js';
import { CycleTrigger } from '../cycleTrigger.js';
import { Ingress, resolveIngressSecrets } from '../ingress/ingress.js';
import { RuntimeControl } from '../runtimeControl.js';
import { PetKeeper } from '../pets/keeper.js';
import { LocalRunner } from '../localRun/runner.js';
import { LocalValidationDesk } from '../validation/local/desk.js';
import { LocalRunWatch } from '../localRun/watch.js';
import { LiveConfig } from '../config/configApply.js';
import { ErrorLog } from '../errorLog.js';
import { planIsWithheld } from '../server/planReveal.js';
import {
  type BuildOptions,
  type LateBinding,
  type Foundation,
  buildFoundation,
  lateBinding,
  lateParts,
  buildAgentRuntime,
} from './systemFoundation.js';
import { type Fleet, buildAgentManager, buildFleet } from './systemFleet.js';
import { buildLocalRuns } from './systemLocalRuns.js';
import { PrAssignDesk } from '../pr/prAssignAsk.js';
import {
  type IntakeDesks,
  buildIntakeDesks,
  type EnvironmentDesks,
  buildEnvironmentDesks,
  type BenchDesks,
  buildBenchDesks,
} from './systemDesks.js';

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
  prAssign: PrAssignDesk;
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

export function buildSystem(config: Config, opts: BuildOptions = {}): System {
  const late = lateBinding();
  const base = buildFoundation(config, opts);
  const runtime = buildAgentRuntime(config, opts, base);
  const channels = buildChannels(config, base, late);
  const crew = buildAgentManager(config, base, runtime, channels, late);
  const fleet = buildFleet(config, opts, base, runtime, channels, crew);
  const intake = buildIntakeDesks(config, opts, base, channels);
  const envs = buildEnvironmentDesks(config, opts, base);
  const bench = {
    ...buildBenchDesks(config, opts, base, channels, fleet),
    graph: new WorkGraphRecorder({ store: base.store, errors: base.errors }),
  };
  const harness = buildHarness(config, opts, { base, channels, fleet, intake, envs, bench, late });
  const pulse = wirePulse(config, opts, base, fleet, harness);
  const local = buildLocalRuns(config, opts, base, runtime);
  late.bind(lateParts({ fleet, envs, bench, harness, local }));
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
    prAssign: new PrAssignDesk({
      store: base.store,
      sink: base.sink,
      errors: base.errors,
      operator: config.userId,
      prAuthorConfigured: config.ownWorkOnly && config.userId !== undefined,
    }),
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

interface HarnessPhases {
  base: Foundation;
  channels: Channels;
  fleet: Fleet;
  intake: IntakeDesks;
  envs: EnvironmentDesks;
  bench: BenchDesks & { graph: WorkGraphRecorder };
  late: LateBinding;
}

export type Channels = ReturnType<typeof buildChannels>;

function buildChannels(config: Config, base: Foundation, late: LateBinding) {
  const { store, errors, sink, areaPaths, watchLabel } = base;
  const predictions = store.openPredictions();
  const mcp: McpBridgeServer = new McpBridgeServer({
    store,
    agents: (): AgentManager => late.get().agents,
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
    permissions: (): PermissionDesk => late.get().permissions,
    openPr: (): McpToolDeps['openPr'] => ({
      sink,
      defaultBranch: config.defaultBranch,
      prompts,
      watchLabel,
      prRefStyle: prRefStyle(config.integrations.sourceControl),
    }),
    filing: (): McpToolDeps['filing'] => late.get().filing,
    prReply: (): McpToolDeps['prReply'] => late.get().executor,
    watch: (): McpToolDeps['watch'] => late.get().watchDryRun,
    state: (): McpToolDeps['state'] => late.get().stateQueries,
    localValidations: (): LocalValidationDesk => late.get().localValidations,
    remoteReadings: (): RemoteReadingDesk => late.get().remoteReadings,
    remoteListings: (): RemoteListingDesk => late.get().remoteListings,
    localRun: (): { runner: LocalRunner; watch: LocalRunWatch } => ({
      runner: late.get().localRun,
      watch: late.get().localRunWatch,
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

  const desktop = buildDesktop(config, base, predictions, prompts, late);
  return { predictions, mcp, prompts, reviewCharters, desktop };
}

function buildDesktop(
  config: Config,
  { store, connector, runtimeControl, errors }: Foundation,
  predictions: PredictionStore,
  prompts: PromptTemplates,
  late: LateBinding,
): McpDesktopServer {
  return new McpDesktopServer({
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
    localRun: (): LocalRunner => late.get().localRun,
    localRunWatch: (): LocalRunWatch => late.get().localRunWatch,
    runtimeControl,
    harness: () => late.get().harness,
    escalations: () => late.get().escalations,
    permissions: () => late.get().permissions,
    recovery: () => late.get().recovery,
    ejections: () => late.get().ejections,
    agents: () => late.get().agents,
    filing: () => late.get().filing,
    briefConfig: () => config,
    renderTicketBody: (vars) => prompts.render('brief-ticket-body', vars),
    profileNames: () => orderedProfiles(config.agentModels).map((p) => p.name),
    connector,
    labelPrefix: config.labelPrefix,
    issueContainerTypes: config.issueContainerTypes,
    agentModels: config.agentModels,
    proposals: () => late.get().proposals,
    runCycle: () =>
      late
        .get()
        .harness.runCycle('manual')
        .then(() => undefined),
    now: () => new Date().toISOString(),
    socketPath: config.validation.desktopSocketPath,
    credentialPath: config.validation.desktopCredentialPath,
    errors,
  });
}

function buildHarness(
  config: Config,
  opts: BuildOptions,
  { base, channels: { predictions }, fleet, intake, envs, bench, late }: HarnessPhases,
): Harness {
  const { store, connector, areaPaths, errors, runtimeControl, ingressInbox, watchLabel } = base;
  const reads = harnessReads(config, store, predictions, fleet.featureBoard);
  return new Harness({
    store,
    connector,
    dispatcher: fleet.dispatcher,
    executor: fleet.executor,
    featureStandings: reads.featureStandings,
    plans: intake.plans,
    appraisals: intake.appraisals,
    areaPaths,
    naming: intake.naming,
    prBodyEdits: intake.prBodyEdits,
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
    localRun: { noteAlive: () => late.get().localRun.noteAlive() },
    localValidations: {
      sweep: () => {
        late.get().localValidations.sweep();
      },
    },
    goalIntake: reads.goalIntake,
    remoteRuns: reads.remoteRuns,
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

function harnessReads(config: Config, store: Store, predictions: PredictionStore, featureBoard: Fleet['featureBoard']) {
  return {
    featureStandings: (): { number: number; title: string; key: string }[] => {
      const facts = featureBoard();
      if (!facts) return [];
      return featureRecords(store, facts).map((f) => ({ number: f.number, title: f.title, key: f.key }));
    },
    // Computed here rather than in the rule: `src/validation/remote/` is a lens as far as the
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
  };
}

function wireAgentEvents({ store, errors, worktrees }: Foundation, { agents, escalations }: Fleet): void {
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
}

function wirePulse(config: Config, opts: BuildOptions, base: Foundation, fleet: Fleet, harness: Harness) {
  const { store, errors, worktrees, runtimeControl, ingressInbox } = base;
  const { agents } = fleet;
  wireAgentEvents(base, fleet);

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
