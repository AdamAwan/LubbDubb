import { tmpdir } from 'node:os';
import { prRefStyle } from './prRef.js';
import { join } from 'node:path';
import { configFilePath, projectConfigFilePath, type Config } from './config.js';
import { Store } from './store/store.js';
import { CompositeConnector } from './integrations/compositeConnector.js';
import { buildIntegrations, buildPoolTransport } from './integrations/registry.js';
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
import { WatchDesk } from './environments/watchDesk.js';
import { watchDeclareNote, watchNote } from './plans/planning.js';
import { PrWatchDesk } from './prWatchDesk.js';
import { PrWorkItemDesk } from './prWorkItemDesk.js';
import { ScheduleDesk } from './schedules/scheduleDesk.js';
import { UpdateDesk } from './selfUpdate/updateDesk.js';
import type { McpToolDeps } from './mcp/tools/context.js';
import { PERMISSION_PROMPT_TOOL } from './mcp/names.js';
import { PermissionDesk } from './agents/permissionDesk.js';
import { RecoveryDesk } from './agents/recoveryDesk.js';
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

export interface System {
  config: Config;
  store: Store;
  connector: CompositeConnector;
  agents: AgentManager;
  escalations: EscalationInbox;
  /** Where a human's accept/reject on a proposed act is applied. */
  proposals: ProposalDesk;
  /** Where an operator's standing authorization to land a whole stack is recorded, ended, and reconciled with the world each pulse. */
  landings: StackLandingDesk;
  /** The permission backstop: an agent's tool call the allow-list doesn't cover blocks until the operator allows or denies it. */
  permissions: PermissionDesk;
  /** The project's area tree, cached; read synchronously by the state snapshot and the appraisal tool. */
  areaPaths: AreaPathDirectory;
  /** Where agents orphaned by a crash or shutdown wait for restore / requeue / remove. Its pending set holds the pulse. */
  recovery: RecoveryDesk;
  executor: ActionExecutor;
  /**
   * What the executor is working on that is not an agent yet. A reading, never a gate: nothing on it
   * counts against the cap. → `docs/spec/09-execution.md#what-is-being-readied`
   */
  readying: ReadyingBoard;
  dispatcher: Dispatcher;
  harness: Harness;
  /**
   * Fires a local cycle when an agent ends, so the freed slot is filled in seconds. Exposed because
   * `main.ts` must stop it on the way down. → `docs/spec/04-harness-cycle.md#the-local-cycle`
   */
  localCycles: CycleTrigger;
  /**
   * Verifies inbound webhook deliveries and asks for a real cycle. Exposed for the route module that
   * fronts it and for `main.ts`, which stops its trigger on the way down. → `docs/spec/30-ingress.md`
   */
  ingress: Ingress;
  /** The ingress's own cycle trigger, separate from {@link localCycles} because it fires a **real** cycle. */
  ingressCycles: CycleTrigger;
  /** Writes the durable work graph each pulse; exposed because its readers have no other handle on the writer. */
  graph: WorkGraphRecorder;
  /** Keeps the ticket mirror current, and knows whether the first sweep has landed (an empty list mid-backfill differs from an empty tracker). */
  tickets: TicketSweep;
  /**
   * The cross-fleet pool, or undefined on the `fake` default. → `docs/spec/28-cross-fleet-pool.md`
   */
  pool?: PoolDesk;
  /** The post-deploy watch's dry run, route-driven. → `docs/spec/29-post-deploy-watch.md` */
  watch: WatchDryRunner;
  /** Files a tracker item; route-driven rather than an executor action or pulse desk. */
  filing: TicketFiler;
  /** Files a report about LubbDubb itself into LubbDubb's own tracker, past the connector entirely. */
  upstream: UpstreamIssues;
  /** Where the harness watches its own build and drives an upgrade. Always constructed; with the watch off it reports unknown. */
  updates: UpdateDesk;
  /** Live, ephemeral dispatch controls (cap + pause). Seeded from config at boot. */
  runtimeControl: RuntimeControl;
  /** The vivarium (`src/pets/`). Always constructed; with `pets.enabled` off it scans nothing. */
  pets: PetKeeper;
  /** The machine's one dev environment (`src/localRun/`). Always constructed; refuses starts without `localRun.instruction`. */
  localRun: LocalRunner;
  /** The fleet driving that environment (`src/localValidation/`). Always constructed. */
  localValidations: LocalValidationDesk;
  /** Readings on that environment, on a timer `main.ts` arms; nothing on the pulse reads it. */
  localRunWatch: LocalRunWatch;
  /** Applies a reloaded config to this running process; the one apply path a cockpit save and a hand edit both go through. */
  liveConfig: LiveConfig;
  /** The issue-pickup policy the dispatcher honours, exposed so the snapshot computes the same verdict. */
  issuePickup: IssuePickupPolicy;
  /** The operator-customisable prompt book, exposed because `finding-ticket` renders on a click. */
  prompts: PromptTemplates;
  /** Per-agent spool for the file-events hook. Always present; only wired for the real (stream) runtime. */
  fileEvents: FileEventsSpool;
  /** Where images attached to a brief are written. */
  attachments: AttachmentFiles;
  /** The agents' typed channel back to the harness; inert until `listen()` succeeds and MCP is enabled. */
  mcp: McpBridgeServer;
  /** The operator's own Claude Code channel; binds nothing until `listen()`, called only by `main.ts`. */
  desktop: McpDesktopServer;
  /** The pool of worktree directories code dispatch leases slots from. */
  worktrees: Worktrees;
  /** The review pack author desk. Outside the dispatcher — a pack is made on request, never by a rule. → `docs/spec/31-review-packs.md#when-a-pack-is-made` */
  reviewPacks: ReviewPackAuthor;
  /** The review pack checker desk: follows the author and merges verdicts back. → `docs/spec/31-review-packs.md#the-check` */
  reviewPackChecker: ReviewPackChecker;
  /** Central error log: every caught failure is persisted here and streamed to the cockpit. */
  errors: ErrorLog;
  /** The config file a save writes and the watcher watches; a test exercising it must inject a temp path. */
  configFile: string;
  /** The targeted project's shared config at `<repoRoot>/lubbdubb.project.json`. Injected in tests for `configFile`'s reason. */
  projectConfigFile: string;
}

interface BuildOptions {
  /** Inject a fake PTY backend (tests) instead of the real node-pty one. */
  backend?: PtyBackend;
  /** Override the outbound sink (tests). Defaults to the FakeConnector. */
  sink?: ActionSink;
  /** Override where a CI-fix dispatch's failing output comes from. Defaults to the composite. */
  ciEvidence?: CiEvidenceReader;
  /** Inject a fake process spawner (tests) for the stream-JSON runtime. */
  streamSpawner?: Spawner;
  /** Override how a killed agent's process subtree is taken down. Defaults to a no-op whenever a fake transport is injected. */
  reapProcessTree?: ProcessReaper;
  /** Override the git observer plan reconciliation reads through; injecting one also disables the reconciler's `git fetch`. */
  gitObserver?: GitObserver;
  /** Override how the local run's listening ports are read. Defaults to the fake alongside a fake transport. */
  portLister?: PortLister;
  /** Override the worktree manager code dispatch cuts branches through; without it a test's `repoRoot` defaults to `process.cwd()`. */
  worktrees?: Worktrees;
  /** Override how an environment is asked whether it holds a commit. Without it the real prober shells out. */
  environmentProber?: EnvironmentProber;
  /** Override how an environment is asked whether it is well. Without it the real prober runs the configured `health` command. */
  environmentHealthProber?: EnvironmentHealthProber;
  /** Override how a pull request is asked whether it was reviewed elsewhere. Without it the configured command runs for real. */
  reviewProber?: ReviewProber;
  /** Override how an environment's telemetry is asked a declared question. Without it the configured `observe` command runs for real. */
  environmentObserver?: EnvironmentObserver;
  /** Override where recorded errors are mirrored (tests silence the default stderr echo). */
  errorMirror?: (entry: ErrorLogEntry) => void;
  /** The inbound ingress secrets, for a test that drives the endpoint. → `docs/spec/30-ingress.md#turning-it-on` */
  ingressSecrets?: IngressSecrets;
  /** Override the config file the write route targets; see {@link System.configFile}. */
  configFile?: string;
  /** Override the targeted project's shared config path; see {@link System.projectConfigFile}. */
  projectConfigFile?: string;
  /** Override how a report about LubbDubb itself is filed. Without it the collection-level issue routes hit the real repo. */
  upstream?: UpstreamIssues;
  /** Override the pool's transport. Wiring one also wires the pool desk. → `docs/spec/28-cross-fleet-pool.md#a-fleet-with-no-name-yet` */
  poolTransport?: PoolTransport;
  /** How one obstacle's prose is read by a model. Wiring one wires the model desk. → `docs/spec/27-obstacles.md#what-may-be-decided-by-a-model-and-what-may-not` */
  obstacleReader?: ObstacleReader;
  /** Override when crash recovery considers this process to have started. Everything older is a previous run's orphan. Defaults to module load. */
  bootedAt?: string;
}

/**
 * The composition root. Wires every module together through its interface so any one can be
 * swapped: tests build a System with fakes and an in-memory store, the server builds a real one.
 */
export function buildSystem(config: Config, opts: BuildOptions = {}): System {
  const store = new Store(config.dbPath);
  // Recorded MCP-call args past their retention, cleared at boot as well as on the write path.
  store.compactMcpCallArgs(config.mcpArgsRetentionDays, true);
  store.pruneSurfaceReach(true);
  const now = (): string => new Date().toISOString();
  const errors = new ErrorLog(store, opts.errorMirror);
  // Built above the harness: the ingress's two ends are wired at opposite ends of this file.
  const ingressInbox = new IngressInbox();
  const integrations = buildIntegrations(config.integrations, { store, config, now, errors });
  const connector = new CompositeConnector(integrations, now, {
    hotMaxAgeMs: config.hotReadMaxAgeMs,
    coldMaxAgeMs: config.coldReadMaxAgeMs,
  });
  // Cached so the appraisal tool and state snapshot read it without awaiting; refreshed on
  // its own TTL, null until the first read lands.
  const areaPaths = new AreaPathDirectory(connector, { now: () => Date.now(), errors });
  const backend = opts.backend ?? new NodePtyBackend();

  // Live, in-memory dispatch controls; ephemeral by design, a restart reverts to config.
  const runtimeControl = new RuntimeControl(config.maxConcurrentAgents, config.startPaused);

  // Worktrees are a bounded pool of directories leased to branches. `held` is the durable
  // half of the lease.
  const worktrees =
    opts.worktrees ??
    new WorktreeManager(
      config.repoRoot,
      config.worktreeRoot,
      {
        // A getter, so the bound is the live cap's — a raised cap would otherwise dispatch
        // past the pool and be rejected forever.
        get size() {
          return defaultPoolSize(runtimeControl.cap);
        },
        held: (branch) => store.findActiveTaskByBranch(branch) !== null,
      },
      config.localRunRoot,
      errors,
    );
  const gitObserver = opts.gitObserver ?? new GitCliObserver(config.repoRoot);

  // How a stopped agent's descendants die with it. The real reaper is wired only alongside
  // the real transports — a fake transport's pid belongs to something else on the host.
  const realTransport = opts.backend === undefined && opts.streamSpawner === undefined;
  const reapTree: ProcessReaper =
    opts.reapProcessTree ??
    (realTransport
      ? (pid) => killProcessTree(pid, (message) => errors.record({ source: 'agent', message }))
      : () => {});
  // `raw` only: the operator's argv runs verbatim, speaking no protocol beyond sentinels.
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

  // One canonical attachment file per image under the config'd root, outside every worktree.
  const attachments = new AttachmentFiles(config.attachmentRoot);
  // Validation resources ride alongside, granted regardless of `validation.enabled` so an
  // agent's readable set never depends on config it cannot see.
  const additionalDirectories = [config.attachmentRoot, config.validationRoot];

  const perm = config.agentPermissionMode;
  const extraArgs = config.claudeArgs;
  const allowedTools = config.agentAllowedTools;
  const permissionPromptTool = PERMISSION_PROMPT_TOOL;
  // `mcpConfigPath` and `model` are per-launch (minted by AgentManager) and MUST be threaded
  // through — a builder that accepts and forgets to forward either type-checks clean but is dead.

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
      // Resumable: the id is pinned up front so a restart can re-open this conversation.
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
      promptDelayMs: 0, // stdin is ready immediately; no TUI to wait for
      resumable: true,
    },
    raw: {
      // Deliberately ignores `model`: running the operator's argv verbatim is this mode's whole contract.
      buildArgs: (() => config.claudeArgs) as ArgsBuilder,
      factory: ptyFactory(),
      initialInput: undefined,
      resumeInput: undefined,
      promptDelayMs: config.agentPromptDelayMs,
      resumable: false,
    },
  }[config.agentMode];

  // File-events capture spool: one dir per agent under the OS tmpdir.
  const fileEvents = new FileEventsSpool(join(tmpdir(), 'lubbdubb', 'events'));

  // Constructed unconditionally so `system.mcp` is addressable; handed to the fleet only
  // when the operator leaves it on. The lazy thunks below break construction-order cycles.
  const mcp: McpBridgeServer = new McpBridgeServer({
    store,
    agents: (): AgentManager => agents,
    argsRetentionDays: config.mcpArgsRetentionDays,
    configDir: defaultConfigDir(),
    socketPath: defaultSocketPath(),
    profiles: orderedProfiles(config.agentModels),
    reviewModes: reviewModeNames(config.review),
    reviewAllowSkip: config.review.allowSkip,
    // What an obstacle's `path` key is validated against; a key naming a file the tree
    // doesn't have is dropped and the report kept.
    repoRoot: config.repoRoot,
    // A thunk, not a snapshot: captured here it would pin every agent to the tree at boot.
    areaPaths: (): AreaPathTree | null => areaPaths.current(),
    permissions: (): PermissionDesk => permissions,
    openPr: (): McpToolDeps['openPr'] => ({
      sink: opts.sink ?? connector,
      defaultBranch: config.defaultBranch,
      prompts,
      // So the pull request is watched the moment it exists, never briefly invisible.
      watchLabel,
      // So body guidance names the sigil this provider reads as "pull request".
      prRefStyle: prRefStyle(config.integrations.sourceControl),
    }),
    filing: (): McpToolDeps['filing'] => filing,
    // `reply_to_review` hands its reply here so it is held, authorized and signed like a
    // rule-drafted one, instead of posted from inside the agent under the operator's credential.
    prReply: (): McpToolDeps['prReply'] => executor,
    watch: (): McpToolDeps['watch'] => watchDryRun,
    reviewPacks: (): McpToolDeps['reviewPacks'] => reviewPacks,
    localValidations: (): LocalValidationDesk => localValidations,
    localRun: (): { runner: LocalRunner; watch: LocalRunWatch } => ({ runner: localRun, watch: localRunWatch }),
    reviewPackChecker: (): McpToolDeps['reviewPackChecker'] => reviewPackChecker,
    errors,
  });

  // Hoisted out of the RuleDispatcher: the findings route and desktop channel also render from it.
  const prompts = loadPromptTemplates(config.promptTemplatesDir);

  // The project's review charters, read once from the checkout; a configured path that
  // names nothing is recorded rather than swallowed.
  const reviewCharters = loadReviewCharters(config.repoRoot, config.review, (error, path) =>
    errors.record({
      source: 'boot',
      message: `Review charter "${path}" could not be read; the reviewer runs without it.`,
      detail: error instanceof Error ? error.message : String(error),
    }),
  );

  // Constructed unconditionally so `system.desktop` is addressable; inert until `listen()`,
  // which is the only thing that binds the socket or writes a credential to the operator's home.
  const desktop = new McpDesktopServer({
    store,
    argsRetentionDays: config.mcpArgsRetentionDays,
    claimMinutes: config.validation.desktopClaimMinutes,
    validationRoot: config.validationRoot,
    environments: config.environments,
    prRefStyle: prRefStyle(config.integrations.sourceControl),
    // Lazily: the runner is built further down, and this channel and the cockpit's panel
    // must start the same run.
    localRun: (): LocalRunner => localRun,
    localRunWatch: (): LocalRunWatch => localRunWatch,
    // `runtimeControl` is handed over by reference — it is the live cap/pause the executor
    // reads on every dispatch, and a copy would be a second opinion.
    runtimeControl,
    harness: () => harness,
    escalations: () => escalations,
    permissions: () => permissions,
    recovery: () => recovery,
    agents: () => agents,
    filing: () => filing,
    // By reference: `labelPrefix` is live-applied, and a snapshot would carry a stale tag.
    briefConfig: () => config,
    renderTicketBody: (vars) => prompts.render('brief-ticket-body', vars),
    profileNames: () => orderedProfiles(config.agentModels).map((p) => p.name),
    connector,
    labelPrefix: config.labelPrefix,
    issueContainerTypes: config.issueContainerTypes,
    // The whole set rather than the names: pinning one profile has to clear the others.
    agentModels: config.agentModels,
    proposals: () => proposals,
    runCycle: () => harness.runCycle('manual').then(() => undefined),
    now: () => new Date().toISOString(),
    socketPath: config.validation.desktopSocketPath,
    credentialPath: config.validation.desktopCredentialPath,
    errors,
  });

  // What a Feature summary is gathered/digested with, or null with no feature board — asked
  // once so the rule, the dossier and an agent's stamped key cannot disagree.
  //
  // The watch half of the pickup gate alone, needed here because the sequence key digests
  // the watched children; priority plays no part, hence the two inert fields.
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
    // What a goal's work runs on today, off the world baseline; absent when either half of
    // a pin is unconfigured.
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
    // Where a Feature's children stand the moment a summary lands — taken here, never at
    // dispatch, or the stored key would never re-match and the Feature would never be
    // summarised again.
    featureStanding: featureBoard
      ? (featureOrigin: string): string | null =>
          featureRecords(store, featureBoard).find((f) => `issue:${f.number}` === featureOrigin)?.key ?? null
      : undefined,
    // Which stories are under a Feature the moment an order lands, off the world baseline
    // (not the ticket mirror, which lacks the Predecessor links the key folds in).
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
    // The `plan.json` transport's half of the approval gate and the watch dry run, wrapped
    // because the desk is built below this.
    watch: { run: (originRef: string): Promise<string[]> => watchDryRun.run(originRef) },
    errors,
  });
  const escalations = new EscalationInbox(store, agents);
  // The permission backstop, reached by the fleet via the MCP server's `permissions` thunk.
  const permissions = new PermissionDesk(escalations);
  // Where a restart's orphaned agents wait for a verdict.
  const recovery = new RecoveryDesk({
    store,
    agents,
    escalations,
    resumable: agentSetup.resumable,
    // The fence on the agentless arm; production takes the module-load default.
    bootedAt: opts.bootedAt,
    errors,
  });

  // Before the executor, which asks it whether a rung's merge is already authorized.
  const landings = new StackLandingDesk(store, escalations, errors);

  // Owned by the executor: every write is that loop's, and entries live only as long as the frame.
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
    // Through the running config, never copied: the flip that matters is turning it back off.
    autoSendReplies: () => config.sendPrRepliesWithoutApproval,
    // The composite, never `opts.sink`: a read of the provider, unrelated to the outbound sink.
    ciEvidence: opts.ciEvidence ?? connector,
    // How an agent amends a goal's ticket; null under the fake provider.
    instructionTracker: (issueNumber) => ticketAmendCommands(config, issueNumber),
    featureBoard: featureBoard ?? undefined,
  });

  // The review pack author: a spawn outside the pulse — a pack is made when a person asks,
  // never on a rule. Leases through `worktrees`, reaps through `agents.kill`; does not count
  // against the cap.
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

  // The checker follows the author: listens for a run ending with a pack against its head
  // and spawns itself the same way. No fetch — the head the author just diffed is in the clone.
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

  // The accept/reject surface for every act the harness won't perform on its own; runs an
  // accepted act through the executor so the outbound sink keeps a single caller.
  const proposals = new ProposalDesk(store, escalations, executor, {
    sink: opts.sink ?? connector,
    config,
    errors,
  });

  // Dispatcher-level issue-pickup policy (gate + label-encoded priority), provider-agnostic.
  const watchLabel = watchLabelFor(config.labelPrefix);
  const issuePickup: IssuePickupPolicy = {
    watchLabel,
    // Needs both halves: a project that wants filtering (`ownWorkOnly`) and someone to filter to.
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
    // Rendered here, so the dispatcher gets a sentence rather than the config it came from.
    watchNote(config.environments),
    watchDeclareNote(config.environments),
  );
  const dispatcher: Dispatcher = rules;

  // What a config change does to this process — the live keys' arms and pending list.
  const liveConfig = new LiveConfig({ running: config, runtimeControl, dispatcher: rules });

  // The store holds scheduling intent; this folds git + provider reality back onto it every
  // pulse. `git fetch` is wired only for the real observer, floored by `planning.gitFetchIntervalMs`.
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

  // The goal appraisal's outbound half: one living comment per refused goal on the ticket.
  const appraisals = new AppraisalDesk({ store, sink: opts.sink ?? connector, errors });
  // Asks whether the world arrives filtered, not who the operator is: with `ownWorkOnly`
  // off the harness sees everyone's pull requests and may not assume one is its own.
  const prAuthorConfigured = config.ownWorkOnly && config.userId !== undefined;
  const naming = new PrNamingDesk({
    sink: opts.sink ?? connector,
    defaultBranch: config.defaultBranch,
    prAuthorConfigured,
    template: prompts.render('pr-title', {}),
    errors,
  });
  // Tidying up after a pull request: once merged, worktree, local ref, then remote branch
  // go — only the operator's own, never a branch another open PR still targets.
  //
  // Below: the harness's own PRs, tagged watched once per PR so an operator's un-watch is
  // never written back over.
  const prWatch = new PrWatchDesk({
    sink: opts.sink ?? connector,
    store,
    watchLabel,
    // The retired tag: seeding is the one path that could put the fleet back on a PR
    // somebody explicitly parked.
    legacyIgnoreLabel: config.labelPrefix ? `${config.labelPrefix}-ignore` : '',
    errors,
  });

  // The other thing a pull request owes: the work item it was opened for, linked on the
  // tracker (Azure's "linked work items" policy needs it). A row read, not an agent.
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

  // Where a goal's landed work has got to. Built whether or not any environment is
  // configured: a merge SHA is only on offer inside `closedPrWindowMs` and unrecoverable after.
  //
  // The observer below is the operator's own telemetry, behind the seam the dry run also
  // uses — one observer for both readers.
  const environmentObserver = opts.environmentObserver ?? new CommandEnvironmentObserver(config.repoRoot);
  const environments = new EnvironmentDesk({
    store,
    environments: config.environments,
    prober: opts.environmentProber ?? new CommandEnvironmentProber(config.repoRoot),
    // Whether the environment is well, on a different clock than where it is.
    healthProber: opts.environmentHealthProber ?? new CommandEnvironmentHealthProber(config.repoRoot),
    // Answers "is this landing in what the environment named" once per environment however
    // many goals are in flight.
    git: gitObserver,
    sink: opts.sink ?? connector,
    probeIntervalMs: config.environmentProbeIntervalMs,
    healthIntervalMs: config.environmentHealthIntervalMs,
    // Opens on an arrival the desk's own pass records, so where it runs is the invariant.
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

  // What a goal declared production would have to show. Only ever dry-runs, one reading per
  // declared check as the plan is submitted. Built whether or not any environment declares `observe`.
  const watchDryRun = new WatchDryRun({
    store,
    environments: config.environments,
    observer: environmentObserver,
  });

  // A delivered goal whose ticket is still open owes a close. Store-only — files and settles
  // a `human_tasks` row and touches no sink, since closing is precisely what the harness isn't doing.
  const closeOutSink = opts.sink ?? connector;
  const closeOuts = new DeliveryCloseOutDesk(store, config.environments, () => closeOutSink.canCloseIssue());

  // The other ask a delivered goal owes: fixtures and accounts its validation plan couldn't produce.
  const validationAsks = new ValidationAskDesk(store);

  // The moment the checks become somebody's to run. Store-only, gated on the same delivery.
  const validationReady = new ValidationReadyDesk(store, config.environments);

  // The one cost reading taken while the money is still being spent: an expensive run is
  // not a wrong run, so this is a visible obligation, never a kill.
  const burn = new SpendBurnDesk(store, config.spendBurn);

  // Whether there is anything left for the fleet to do — the one desk whose subject is the
  // pipeline rather than a piece of work in it.
  const runway = new RunwayDesk(store, config.runway);

  // Where a recurrence becomes a queued job. Writes the same `jobs` row the launch route
  // writes and leaves the rest to rule `manual-job`.
  const schedules = new ScheduleDesk({ store, errors });

  // The harness watching its own build. Store-and-flag only — its repo is resolved from
  // this module's own path, never `config.repoRoot`. → `src/selfUpdate/buildStanding.ts`
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

  // How the harness files a tracker item.
  const filing = ticketFiler(config, opts.sink ?? connector);
  // Not `opts.sink`, and not the connector at all: a cockpit fault belongs on the cockpit's
  // own tracker whatever the fleet is pointed at.
  const upstream = opts.upstream ?? ghCliUpstreamIssues();
  const graph = new WorkGraphRecorder({ store, errors });

  // The ticket mirror's keeper: one month of backfill on a fresh database, then incremental
  // changed-since reads every pulse. A record, not a decision.
  const tickets = new TicketSweep({ store, source: connector, errors });

  // The harness's own voice on the obstacle board. Always wired: with nothing changed
  // between two readings it writes nothing. → `docs/spec/27-obstacles.md`
  const obstacleVoice = new ObstacleVoiceDesk({ store, errors });

  // What a model may decide about a row nobody has read since a voice last landed words on
  // it. Wired only where a reader is injected — without one this subsystem calls no model
  // at all. → `docs/spec/27-obstacles.md`
  const obstacleDesk = opts.obstacleReader
    ? new ObstacleModelDesk({ store, reader: opts.obstacleReader, repoRoot: config.repoRoot, errors })
    : undefined;

  // What has changed on the obstacle board since a running agent was dispatched. Always wired.
  const obstacleNotices = new ObstacleNoticeDesk({ store, fleet: agents, errors });

  // Who owns each standing obstacle, and which goals the board has let back out. Always wired.
  //
  // The filing arm is off where no tracker is configured — `trackerCoordinates` is the same
  // gate every filing route already asks.
  const obstacleOwnership = new ObstacleOwnershipDesk({
    store,
    filing: trackerCoordinates(config) ? filing : undefined,
    // The item's body, not a prompt — nothing is dispatched to write it.
    ticketBody: (vars) => prompts.render('obstacle-ticket-body', vars),
    watchLabel,
    errors,
  });

  // How each obstacle ends. Always wired: without it a row stands forever.
  const obstacleEndings = new ObstacleEndingsDesk({
    store,
    dormantMs: config.obstacleDormantMs,
    docsPrompt: (vars) => prompts.render('docs-change', vars),
    errors,
  });

  // The cross-fleet pool: what this fleet has vouched for, carried to the others, and a
  // daily spend digest. Wired only when the pool is selected. The coordinates come straight
  // from config because `validatePool` has already refused a boot without them.
  //
  // `fleetId` is the exception, and it is a gate: not refused at load, so a deployment can
  // select the pool before naming its fleet and boot to be asked on Needs You. An unnamed
  // fleet must publish nothing at all. → `docs/spec/28-cross-fleet-pool.md#a-fleet-with-no-name-yet`
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
          // The clock a shared review pack is pruned on: the same one that drops a closed
          // pull request out of the world.
          closedPrWindowMs: config.closedPrWindowMs,
          errors,
        });

  const harness = new Harness({
    store,
    connector,
    dispatcher,
    executor,
    // Empty with no feature board, so the pulse does no mirror read at all.
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
    // The same policy object the dispatcher carries, so the lens and rule `issue-pickup`
    // cannot disagree.
    issuePickup,
    branchReaps,
    environments,
    prWatch,
    prWorkItems,
    review: config.review,
    // Only where the project configured a command; the pulse's own guard reads the same absence.
    reviewProber:
      config.review.reviewedElsewhere === null
        ? undefined
        : (opts.reviewProber ?? new CommandReviewProber(config.repoRoot)),
    schedules,
    updates: config.selfUpdate.enabled ? updates : undefined,
    graph,
    tickets,
    // Dates the environment this process is holding, once a beat.
    localRun: { noteAlive: () => localRun.noteAlive() },
    // Settles the rows an agent will never answer: the environment went away, or it ended
    // without reporting.
    localValidations: {
      sweep: () => {
        localValidations.sweep();
      },
    },
    landings,
    recovery,
    escalations,
    // Resumes agents parked on a usage limit whose window has turned over.
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
    // Only when both halves exist: pins are labels naming profiles.
    modelPins:
      config.labelPrefix && config.agentModels
        ? { labelPrefix: config.labelPrefix, models: config.agentModels }
        : undefined,
    upNextOverrideTtlMs: config.upNextOverrideTtlMs,
    freshReads: ingressInbox,
  });

  // Auto-escalate any non-whitelisted waiting agent so it surfaces in the inbox. Idempotent
  // per agent. `ask` is present only when the park came through the `escalate` tool.
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

  // A dead agent can never answer, so cascade-dismiss its open escalations at every
  // terminal-dead transition. An agent orphaned by a restart is deliberately not dismissed
  // here — it may be restored and must come back to its question (see `RecoveryDesk`).
  //
  // The fast path only: the pulse also sweeps dead agents through `EscalationInbox.tidyDeadAgents`.
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

  // A code agent's worktree slot is released once its process has actually exited, and
  // nothing is deleted — the slot keeps its checkout for whichever branch is handed it next.
  //
  // Every status, not just `done`: skipping failed/killed would shrink the pool with
  // nothing to say so. Slots are shared per-branch, so hold off while a sibling task is active.
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

  // What fires here is a local cycle: full decide/execute against the world the last real
  // cycle read, every world-facing pass skipped — a store pass and no provider traffic
  // instead of a freed slot sitting idle. → `docs/spec/04-harness-cycle.md#the-local-cycle`
  //
  // Wired here because only the composition root knows both halves: `done` is when a row
  // stops counting against the cap, `reaped` is when its worktree slot goes back.
  const localCycles = new CycleTrigger({
    run: () => harness.runCycle('local'),
    ready: () => store.open,
    errors,
  });
  agents.on('done', () => localCycles.request());
  agents.on('reaped', () => localCycles.request());

  // The ingress's half of the same wiring — a real cycle, floored so a verified flood can't
  // burn the provider budget. → `docs/spec/30-ingress.md#what-a-delivery-is-allowed-to-cost`
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

  // The vivarium reads what the operator has already done and writes only its own tables.
  // Wired to the pulse's event rather than into `Harness`: it decides nothing.
  const pets = new PetKeeper(store, config.pets);
  harness.on('cycle:end', () => {
    try {
      pets.scan();
    } catch (err) {
      errors.record({ source: 'cycle', message: `Pet scan failed: ${(err as Error).message}` });
    }
  });

  // The machine's one dev environment. Constructed unconditionally.
  const localRun = new LocalRunner({
    store,
    worktrees,
    // The same factory the fleet's agents come from, so a test's fake runtime holds the
    // environment up too.
    sessions: agentSetup.factory,
    // By reference, so an instruction corrected in the cockpit reaches the next start.
    policy: () => config.localRun,
    claudeCommand: config.claudeCommand,
    claudeArgs: config.claudeArgs,
    permissionMode: config.agentPermissionMode,
    defaultBranch: config.defaultBranch,
    choicesFor: (originRef) => {
      const plan = store.getPlanByOrigin(originRef);
      // The goal's own branch as well as its parts', through the same `openPrForIssue` the
      // pickup verdict uses, off the baseline.
      const number = planIssueNumber(originRef);
      const world = store.getWorldBaseline();
      const issue = number === null ? undefined : world?.issues.find((i) => i.number === number);
      const own = issue ? (openPrForIssue(issue, world?.pullRequests ?? [])?.branch ?? null) : null;
      return localRunChoices(plan ? store.listPlanParts(plan.id) : [], own);
    },
    reap: reapTree,
    errors,
  });
  // Built here, armed in `main.ts`: the timer probes ports and asks git, and belongs only
  // to a running harness — every test builds a `System`.
  const localRunWatch = new LocalRunWatch({
    runner: localRun,
    git: gitObserver,
    fetch: opts.gitObserver ? undefined : () => fetchRemote(config.repoRoot),
    ports: opts.portLister ?? (realTransport ? new CommandPortLister(errors) : new FakePortLister()),
    // The branch this ref was cut from: a part's base is its one unsettled dependency's
    // branch or the integration branch, the goal's own branch is based wherever its PR says.
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
  // The fleet driving that same environment. Its sweep is wired onto the runner's own
  // `changed` as well as the pulse, so a row doesn't say "validating" after the environment
  // it was pinned to has gone.
  const localValidations = new LocalValidationDesk({
    store,
    validationRoot: config.validationRoot,
    errors,
  });
  localRun.on('changed', () => {
    localValidations.sweep();
  });
  // A row saying `running` after a restart describes a process this harness never spawned.
  // What happens to it is `LocalRunner.resumeInterrupted`, called from `main.ts` (it can
  // spawn a session, so it must run below that file's shutdown handlers).
  // → docs/spec/23-local-runs.md
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
