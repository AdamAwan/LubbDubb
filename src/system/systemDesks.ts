import { prRefStyle } from '../pr/prRef.js';
import type { Config } from '../config/config.js';
import { buildPoolTransport, worldScope } from '../integrations/registry.js';
import { PoolDesk } from '../pool/poolDesk.js';
import { harnessVersion } from '../pool/harnessVersion.js';
import { ticketFiler } from '../tickets/filing.js';
import { ghCliUpstreamIssues } from '../tickets/upstream.js';
import { fetchRemote } from '../git/gitCli.js';
import { PlanReconciler } from '../plans/planReconciler.js';
import { AppraisalDesk } from '../intake/appraisalDesk.js';
import { TicketSweep } from '../tickets/sweep.js';
import { ObstacleDesk } from '../obstacles/desk.js';
import { trackerCoordinates } from '../mcp/findings.js';
import { PrNamingDesk } from '../pr/prNamingDesk.js';
import { PrBodyEditDesk } from '../pr/prBodyEditDesk.js';
import { PrDescriptionDesk } from '../pr/prDescriptionDesk.js';
import { DeliveryCloseOutDesk } from '../delivery/closeOutDesk.js';
import { UnwatchedChildDesk } from '../features/unwatchedDesk.js';
import { ValidationAskDesk } from '../validation/askDesk.js';
import { ValidationReadyDesk } from '../validation/readyDesk.js';
import { SpendBurnDesk } from '../insights/spendBurnDesk.js';
import { RunwayDesk } from '../supply/runwayDesk.js';
import { BranchReapDesk } from '../pr/branchReapDesk.js';
import { EnvironmentDesk } from '../environments/environmentDesk.js';
import { CommandEnvironmentHealthProber } from '../environments/healthProber.js';
import { CommandEnvironmentProber } from '../environments/prober.js';
import { CommandEnvironmentObserver } from '../environments/observer.js';
import { WatchDryRun } from '../environments/watchDryRun.js';
import { CommandStateReader } from '../validation/remote/stateReader.js';
import { StateQueryDesk } from '../validation/remote/stateQueries.js';
import { RemoteValidationDesk } from '../validation/remote/desk.js';
import { RemoteRunDesk } from '../validation/remote/run.js';
import { RemoteReadingDesk } from '../validation/remote/readings.js';
import { RemoteListingDesk } from '../validation/remote/listing.js';
import { CommandTenantKeeper, tenantLogRoot } from '../validation/remote/tenants.js';
import { WatchDesk } from '../environments/watchDesk.js';
import { PrWatchDesk } from '../pr/prWatchDesk.js';
import { PrWorkItemDesk } from '../pr/prWorkItemDesk.js';
import { ScheduleDesk } from '../schedules/scheduleDesk.js';
import { UpdateDesk } from '../selfUpdate/updateDesk.js';
import { issueWatchGateReason } from '../dispatcher/issuePickup.js';
import type { BuildOptions, Foundation } from './systemFoundation.js';
import type { Fleet } from './systemFleet.js';
import type { Channels } from './system.js';

// → docs/spec/01-overview.md

export type IntakeDesks = ReturnType<typeof buildIntakeDesks>;

export function buildIntakeDesks(config: Config, opts: BuildOptions, base: Foundation, { prompts }: Channels) {
  const { store, sink, connector, errors, gitObserver, worktrees, watchLabel } = base;
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
  const prBodyEdits = new PrBodyEditDesk({ bodies: connector, store, errors });

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
  return { plans, appraisals, naming, prDescriptions, prBodyEdits, prWatch, prWorkItems, branchReaps };
}

export type EnvironmentDesks = ReturnType<typeof buildEnvironmentDesks>;

export function buildEnvironmentDesks(config: Config, opts: BuildOptions, base: Foundation) {
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

export type BenchDesks = ReturnType<typeof buildBenchDesks>;

export function buildBenchDesks(
  config: Config,
  opts: BuildOptions,
  base: Foundation,
  { prompts }: Channels,
  { sequenceWatchPolicy, agents }: Fleet,
) {
  const { store, connector, sink, errors, runtimeControl, watchLabel } = base;
  const closeOuts = new DeliveryCloseOutDesk(store, config.environments, () => sink.canCloseIssue());

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
    tickets,
    obstacles,
    pool: buildPool(config, opts, base),
  };
}

function buildPool(config: Config, opts: BuildOptions, { store, now, errors }: Foundation): PoolDesk | undefined {
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
  return pool;
}
