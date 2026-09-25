import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config/config.js';
import { Store } from '../store/store.js';
import { CompositeConnector } from '../integrations/compositeConnector.js';
import { buildIntegrations } from '../integrations/registry.js';
import type { PoolTransport } from '../pool/transport.js';
import type { ActionSink } from '../sink/actionSink.js';
import type { TicketFiler } from '../tickets/filing.js';
import type { UpstreamIssues } from '../tickets/upstream.js';
import type { CiEvidenceReader } from '../ci/ciEvidence.js';
import { NodePtyBackend, type PtyBackend } from '../pty/backend.js';
import { defaultPoolSize, WorktreeManager, type Worktrees } from '../worktree/worktreeManager.js';
import { GitCliObserver, type GitObserver } from '../git/gitObserver.js';
import { AreaPathDirectory } from '../intake/areaPaths.js';
import { AgentManager } from '../agents/agentManager.js';
import { buildClaudeStreamArgs, buildInitialMessage, buildResumeMessage } from '../agents/agentProtocol.js';
import { PtySession } from '../pty/ptySession.js';
import { StreamJsonSession, type Spawner } from '../agents/streamJsonSession.js';
import { FileEventsSpool } from '../agents/fileEvents.js';
import { AttachmentFiles } from '../jobs/attachmentFiles.js';
import type { SessionFactory } from '../agents/session.js';
import { killProcessTree, type ProcessReaper } from '../agents/processTree.js';
import { EscalationInbox } from '../escalation/escalationInbox.js';
import { ProposalDesk } from '../proposals/proposalDesk.js';
import type { ObstacleReader } from '../obstacles/desk.js';
import type { EnvironmentHealthProber } from '../environments/healthProber.js';
import type { ReviewProber } from '../review/reviewedElsewhere.js';
import type { EnvironmentProber } from '../environments/prober.js';
import type { EnvironmentObserver } from '../environments/observer.js';
import { WatchDryRun } from '../environments/watchDryRun.js';
import type { StateReader } from '../validation/remote/stateReader.js';
import { StateQueryDesk } from '../validation/remote/stateQueries.js';
import { RemoteReadingDesk } from '../validation/remote/readings.js';
import { RemoteListingDesk } from '../validation/remote/listing.js';
import type { TenantKeeper } from '../validation/remote/tenants.js';
import { PERMISSION_PROMPT_TOOL } from '../mcp/names.js';
import { PermissionDesk } from '../agents/permissionDesk.js';
import { RecoveryDesk } from '../agents/recoveryDesk.js';
import { EjectionDesk } from '../ejection/desk.js';
import { ActionExecutor } from '../executor/actionExecutor.js';
import { watchLabelFor } from '../watchLabels.js';
import { Harness } from '../harness.js';
import type { IngressSecrets } from '../ingress/ingress.js';
import { IngressInbox } from '../ingress/inbox.js';
import { RuntimeControl } from '../runtimeControl.js';
import { LocalRunner } from '../localRun/runner.js';
import { LocalValidationDesk } from '../validation/local/desk.js';
import { LocalRunWatch } from '../localRun/watch.js';
import type { PortLister } from '../localRun/ports.js';
import { ErrorLog } from '../errorLog.js';
import type { ErrorLogEntry } from '../types.js';
import type { Fleet } from './systemFleet.js';
import type { BenchDesks, EnvironmentDesks } from './systemDesks.js';
import type { LocalRuns } from './systemLocalRuns.js';

// → docs/spec/01-overview.md

export interface BuildOptions {
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

export interface LateBinding {
  bind(parts: Late): void;
  get(): Late;
}

export function lateBinding(): LateBinding {
  let bound: Late | undefined;
  return {
    bind(parts) {
      bound = parts;
    },
    get() {
      if (bound === undefined) throw new Error('A late-bound component was read before buildSystem finished.');
      return bound;
    },
  };
}

export function lateParts({ fleet, envs, bench, harness, local }: LatePhases): Late {
  return {
    agents: fleet.agents,
    escalations: fleet.escalations,
    permissions: fleet.permissions,
    recovery: fleet.recovery,
    ejections: fleet.ejections,
    proposals: fleet.proposals,
    executor: fleet.executor,
    filing: bench.filing,
    watchDryRun: envs.watchDryRun,
    stateQueries: envs.stateQueries,
    remoteReadings: envs.remoteReadings,
    remoteListings: envs.remoteListings,
    harness,
    localRun: local.localRun,
    localRunWatch: local.localRunWatch,
    localValidations: local.localValidations,
  };
}

interface LatePhases {
  fleet: Fleet;
  envs: EnvironmentDesks;
  bench: BenchDesks;
  harness: Harness;
  local: LocalRuns;
}

export type Foundation = ReturnType<typeof buildFoundation>;

export function buildFoundation(config: Config, opts: BuildOptions) {
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

export type AgentRuntime = ReturnType<typeof buildAgentRuntime>;

export function buildAgentRuntime(config: Config, opts: BuildOptions, { backend, errors }: Foundation) {
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
