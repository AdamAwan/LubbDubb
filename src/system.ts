import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.js';
import { Store } from './store/store.js';
import { CompositeConnector } from './integrations/compositeConnector.js';
import { buildIntegrations } from './integrations/registry.js';
import type { ActionSink } from './sink/actionSink.js';
import type { CiEvidenceReader } from './ci/ciEvidence.js';
import { NodePtyBackend, type PtyBackend } from './pty/backend.js';
import { defaultSessionRoot } from './agents/sessionTranscript.js';
import { WorktreeManager, type Worktrees } from './worktree/worktreeManager.js';
import { GitCliObserver, type GitObserver } from './git/gitObserver.js';
import { fetchRemote } from './git/gitCli.js';
import { PlanReconciler } from './plans/planReconciler.js';
import { AssayDesk } from './intake/assayDesk.js';
import { WorkGraphRecorder } from './graph/workGraphRecorder.js';
import { AgentManager } from './agents/agentManager.js';
import {
  buildClaudeArgs,
  buildClaudeStreamArgs,
  buildInitialMessage,
  buildResumeMessage,
} from './agents/agentProtocol.js';
import { PtySession } from './pty/ptySession.js';
import { StreamJsonSession, type Spawner } from './agents/streamJsonSession.js';
import { StatusFileRateLimits } from './agents/statusLine.js';
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
import { PrNamingDesk } from './prNamingDesk.js';
import { DeliveryCloseOutDesk } from './delivery/closeOutDesk.js';
import { BranchReapDesk } from './branchReapDesk.js';
import { ScheduleDesk } from './schedules/scheduleDesk.js';
import type { McpToolDeps } from './mcp/tools/context.js';
import { PERMISSION_PROMPT_TOOL } from './mcp/names.js';
import { PermissionDesk } from './agents/permissionDesk.js';
import { RecoveryDesk } from './agents/recoveryDesk.js';
import { ActionExecutor } from './executor/actionExecutor.js';
import { RuleDispatcher } from './dispatcher/ruleDispatcher.js';
import { loadPromptTemplates, type PromptTemplates } from './dispatcher/promptTemplates.js';
import type { Dispatcher } from './dispatcher/dispatcher.js';
import type { IssuePickupPolicy } from './dispatcher/issuePickup.js';
import { watchLabelsFor } from './watchLabels.js';
import { resolveModelTag } from './modelLabels.js';
import { orderedProfiles } from './agents/modelPolicy.js';
import { Harness } from './harness.js';
import { RuntimeControl } from './runtimeControl.js';
import { ErrorLog } from './errorLog.js';
import type { ErrorLogEntry } from './types.js';

export interface System {
  config: Config;
  store: Store;
  connector: CompositeConnector;
  agents: AgentManager;
  escalations: EscalationInbox;
  /**
   * Where a human's accept/reject on a proposed act is applied (issue #109) — the
   * missing wire between "approve" and "the approved thing happens".
   */
  proposals: ProposalDesk;
  /**
   * Where an operator's standing authorization to land a whole stack is recorded,
   * ended, and reconciled with the world each pulse (see `src/stacks/landing.ts`).
   */
  landings: StackLandingDesk;
  /**
   * The permission backstop (issue #130 phase B): where an agent's tool call that
   * the allow-list doesn't cover blocks until the operator allows or denies it.
   */
  permissions: PermissionDesk;
  /**
   * Where agents orphaned by a crash or a shutdown wait for an operator to choose
   * restore / requeue / remove. Its pending set holds the harness's pulse, so no
   * new work is queued in front of work that was already in flight.
   */
  recovery: RecoveryDesk;
  executor: ActionExecutor;
  dispatcher: Dispatcher;
  harness: Harness;
  /**
   * Writes the durable work graph each pulse. Exposed because the record outlives
   * the world's memory of it — the routes and tests that read the graph back have
   * no other handle on the thing that wrote it.
   */
  graph: WorkGraphRecorder;
  /** Live, ephemeral dispatch controls (cap + pause). Seeded from config at boot. */
  runtimeControl: RuntimeControl;
  /**
   * The issue-pickup policy the dispatcher honours, exposed so the snapshot can
   * compute the same per-issue pickup verdict the dispatcher will act on.
   */
  issuePickup: IssuePickupPolicy;
  /**
   * The operator-customisable prompt book. Exposed because one prompt is
   * route-driven rather than dispatcher-driven: filing a finding as a ticket
   * (`finding-ticket`), which renders on a click rather than on a pulse.
   */
  prompts: PromptTemplates;
  /**
   * Account rate-limit capture (status-line payloads), wired only for the PTY
   * runtime — the status line never fires headless. Null in other modes; the
   * snapshot then falls back to the rolling cost windows from `usage_events`.
   */
  rateLimits: StatusFileRateLimits | null;
  /**
   * Per-agent spool for the file-events `PostToolUse` hook — where written paths
   * land before {@link AgentManager.drainFileEvents} folds them into the files
   * list / artifact chips. Always present; the hook feeding it is only wired for
   * the real runtimes (stream/pty).
   */
  fileEvents: FileEventsSpool;
  /**
   * Where images attached to a blueprint are written (issue #249). Exposed because
   * the launch route stores them and the cancel route removes them, and both need
   * the same root the agents are granted read access to.
   */
  attachments: AttachmentFiles;
  /**
   * The agents' typed channel back to the harness (issue #108). Always present,
   * but inert until `listen()` succeeds *and* `config.mcp.enabled` let it reach
   * the fleet — so a system built without either behaves exactly as it did before
   * the channel existed. Tests reach tools through `mcp.session(agentId)`, which
   * is the same entry point an agent's bridge lands on.
   */
  mcp: McpBridgeServer;
  /**
   * The operator's own Claude Code channel — validation checks run at their
   * keyboard, on a machine that can reach what the fleet cannot. Always present
   * and always constructed, but it binds nothing and writes no credential until
   * `listen()` is called, which `main.ts` only does when
   * `config.validation.desktop` is on.
   */
  desktop: McpDesktopServer;
  /** Central error log: every caught failure is persisted here and streamed to the cockpit. */
  errors: ErrorLog;
}

interface BuildOptions {
  /** Inject a fake PTY backend (tests) instead of the real node-pty one. */
  backend?: PtyBackend;
  /** Override the outbound sink (tests). Defaults to the FakeConnector. */
  sink?: ActionSink;
  /**
   * Override where a CI-fix dispatch's failing output comes from (tests inject a
   * provider integration built on a scripted `*Api`). Defaults to the composite,
   * which answers `[]` unless the selected provider can supply any.
   */
  ciEvidence?: CiEvidenceReader;
  /** Inject a fake process spawner (tests) for the stream-JSON runtime. */
  streamSpawner?: Spawner;
  /**
   * Override how a killed agent's process *subtree* is taken down (tests inject a
   * recorder). Defaulted below, and defaulted to a no-op whenever a fake transport
   * is injected — see the wiring for why that pairing is not optional.
   */
  reapProcessTree?: ProcessReaper;
  /**
   * Override the git observer plan reconciliation reads branch reality through
   * (tests inject `FakeGitObserver`). Injecting one also turns the reconciler's
   * `git fetch` off — a scripted observer has no remote to refresh.
   */
  gitObserver?: GitObserver;
  /**
   * Override the worktree manager code dispatch cuts branches through (tests
   * inject `FakeWorktreeManager`). Without it a test's `repoRoot` defaults to
   * `process.cwd()`, so every dispatched code agent leaves a real branch behind
   * in the developer's own checkout — and on a CI `pull_request` checkout, where
   * there is no `main` ref to resolve a base against, `ensure` throws and the
   * dispatch is rejected instead.
   */
  worktrees?: Worktrees;
  /** Override where recorded errors are mirrored (tests silence the default stderr echo). */
  errorMirror?: (entry: ErrorLogEntry) => void;
  /**
   * Override when crash recovery considers this process to have started (tests).
   * Everything older is a previous run's orphan; everything newer is a dispatch
   * this run is in the middle of. Defaults to module load.
   */
  bootedAt?: string;
}

/**
 * The composition root. Wires every module together through its interface so any
 * one can be swapped — the tests build a System with a fake PTY backend and an
 * in-memory store, the server builds a real one, and nothing else changes.
 */
export function buildSystem(config: Config, opts: BuildOptions = {}): System {
  const store = new Store(config.dbPath);
  // The world is assembled from the integrations config selects (default: the
  // fake provider for every capability), composed behind the Connector/ActionSink
  // seams the harness and executor depend on. Swapping a provider is a config
  // change; nothing here changes.
  const now = (): string => new Date().toISOString();
  // The one error-recording path: everything that catches a failure routes it
  // here so it's durable, mirrored to stderr, and streamed to the cockpit.
  const errors = new ErrorLog(store, opts.errorMirror);
  const integrations = buildIntegrations(config.integrations, { store, config, now, errors });
  const connector = new CompositeConnector(integrations, now);
  const backend = opts.backend ?? new NodePtyBackend();

  const worktrees = opts.worktrees ?? new WorktreeManager(config.repoRoot, config.worktreeRoot);
  // Branch reality for plan reconciliation — read-only, and the seam a test swaps
  // to script "has this part pushed" without a repo.
  const gitObserver = opts.gitObserver ?? new GitCliObserver(config.repoRoot);

  // Pick the agent runtime and how it's launched from the configured mode.
  // `claudeTui` marks the real interactive claude REPL, which needs two things
  // raw/mock sessions don't: its transcript read from the session file Claude
  // Code writes (the screen carries slash menus, hints and column-wrapped prose
  // that no chrome filter can undo), and an active exit-on-done — the REPL never
  // ends a session by itself, so without it the process and its worktree leak (#66).
  const sessionRoot = config.sessionTranscriptRoot ?? defaultSessionRoot();
  // How a stopped agent's *descendants* die with it (issue: a Bash-tool shell
  // outliving its agent pins the worktree cwd, and Windows then refuses rmdir on
  // it forever). See {@link ProcessReaper}.
  //
  // **The real reaper is wired only alongside the real transports.** It signals
  // whatever pid it is handed, and an injected `backend`/`streamSpawner` scripts a
  // process whose pid belongs to something else entirely on the host — so with a
  // fake in place the default must be, and is, a no-op. A test that wants to
  // observe the reap injects its own recorder.
  const realTransport = opts.backend === undefined && opts.streamSpawner === undefined;
  const reapTree: ProcessReaper =
    opts.reapProcessTree ??
    (realTransport
      ? (pid) => killProcessTree(pid, (message) => errors.record({ source: 'agent', message }))
      : () => {});
  const ptyFactory = (claudeTui: boolean): SessionFactory => {
    return (spec) =>
      new PtySession(backend, {
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
        waitingPatterns: spec.waitingPatterns,
        submitDelayMs: config.agentSubmitDelayMs,
        // Needs a pinned session id to name the transcript file. Both real runtimes
        // now carry one, but only the TUI needs its screen read back out of a file —
        // stream mode builds its transcript from the events themselves.
        sessionTranscript:
          claudeTui && spec.sessionId
            ? { root: sessionRoot, sessionId: spec.sessionId, startAtEof: spec.resume === true }
            : undefined,
        onWarning: (message) => errors.record({ source: 'agent', message }),
        exitOnDone: claudeTui,
        // Real-TUI only: raw/mock sessions are line-oriented and legitimately
        // silent between steps, so idle means nothing there.
        idleWaitMs: claudeTui ? config.agentIdleWaitMs : 0,
        reap: reapTree,
      });
  };
  const streamFactory: SessionFactory = (spec) => new StreamJsonSession(spec, opts.streamSpawner, reapTree);

  // Blueprint attachments (issue #249): one canonical file per image under the
  // config'd root, outside every worktree. Every launch is granted read access to
  // that root, which is what makes the path in an agent's prompt openable.
  const attachments = new AttachmentFiles(config.attachmentRoot);
  // Validation resources ride alongside for the same reason and on the same
  // terms: a fixture is only useful to an agent that can open it, and the root is
  // outside every worktree precisely so it survives the reap. Granted whether or
  // not `validation.enabled` — the directory is the harness's own and empty on a
  // deployment that never writes one, and a grant that came and went with a policy
  // flag would make an agent's readable set depend on config it cannot see.
  const additionalDirectories = [config.attachmentRoot, config.validationRoot];

  const perm = config.agentPermissionMode;
  const extraArgs = config.claudeArgs;
  const allowedTools = config.agentAllowedTools;
  // The permission backstop's tool name (issue #130 phase B). Passed on every
  // launch; it only takes effect when that launch also carries an `--mcp-config`.
  const permissionPromptTool = PERMISSION_PROMPT_TOOL;
  // `mcpConfigPath` is per-launch (minted by AgentManager) and MUST be threaded
  // through — without it neither `--mcp-config` nor `--permission-prompt-tool` is
  // ever added, and the tool channel is dead in production.
  // `model` is per-launch for the same reason and with the same trap: it is the
  // task's own resolved model (issue #321), so a builder that accepts it and
  // forgets to forward it type-checks clean and silently drops the flag.
  type ArgsBuilder = (opts: {
    sessionId: string;
    resume: boolean;
    mcpConfigPath: string | null;
    model: string | null;
    effort: string | null;
  }) => string[];
  const agentSetup = {
    stream: {
      // Resumable like the PTY runtime, and for the same reason: the id is pinned up
      // front so a restart can re-open *this* conversation. Headless `claude` honours
      // both flags (issue #318) — which is what puts `restore` on the recovery desk
      // for the default deployment instead of requeue-or-remove.
      buildArgs: (({ sessionId, resume, mcpConfigPath, model, effort }) =>
        buildClaudeStreamArgs({
          permissionMode: perm,
          extraArgs,
          allowedTools,
          additionalDirectories,
          sessionId,
          resume,
          fileEvents: true,
          mcpConfigPath,
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
    pty: {
      // Pin the session id up front, `--resume` it later.
      buildArgs: (({ sessionId, resume, mcpConfigPath, model, effort }) =>
        buildClaudeArgs({
          permissionMode: perm,
          extraArgs,
          allowedTools,
          additionalDirectories,
          sessionId,
          resume,
          statusLine: true,
          fileEvents: true,
          mcpConfigPath,
          permissionPromptTool,
          model: model ?? undefined,
          effort: effort ?? undefined,
        })) as ArgsBuilder,
      factory: ptyFactory(true),
      initialInput: (task: Parameters<typeof buildInitialMessage>[0]) => buildInitialMessage(task),
      resumeInput: buildResumeMessage,
      promptDelayMs: config.agentPromptDelayMs,
      resumable: true,
    },
    raw: {
      // Deliberately ignores `model`: running the operator's argv verbatim is this
      // mode's whole contract, and it speaks no protocol to assign work by.
      buildArgs: (() => config.claudeArgs) as ArgsBuilder,
      factory: ptyFactory(false),
      initialInput: undefined,
      resumeInput: undefined,
      promptDelayMs: config.agentPromptDelayMs,
      resumable: false,
    },
  }[config.agentMode];

  // PTY-only: capture the status-line payloads (the one surface carrying the
  // account 5h/weekly limits) into per-session files under the OS tmpdir — a
  // stable spot so the last known limits survive a restart.
  const rateLimits = config.agentMode === 'pty' ? new StatusFileRateLimits(join(tmpdir(), 'lubbdubb', 'status')) : null;

  // File-events capture (the PostToolUse hook's spool): one dir per agent under
  // the OS tmpdir. Wired for every mode — the hook itself is only injected for
  // the real runtimes (stream/pty), so mock/raw agents just leave it empty.
  const fileEvents = new FileEventsSpool(join(tmpdir(), 'lubbdubb', 'events'));

  // The typed channel back to the harness (issue #108). Constructed unconditionally
  // so `system.mcp` is always addressable, but only handed to the fleet when the
  // operator leaves it on — and it still needs `listen()` (the server's boot does
  // that) before any launch actually gets a `--mcp-config`. The `agents` thunk is
  // the mutual reference: a launch needs a credential, a tool call needs the fleet.
  // Both sides annotated so the mutual reference stays a *runtime* cycle and not
  // an inference one — TS can't infer either type from the other.
  const mcp: McpBridgeServer = new McpBridgeServer({
    store,
    agents: (): AgentManager => agents,
    configDir: defaultConfigDir(),
    socketPath: defaultSocketPath(),
    requirePlanApproval: config.planning.requireApproval,
    // What the assayer is offered when it proposes a profile for a goal.
    profiles: orderedProfiles(config.agentModels),
    // Lazy for the same reason as `agents`: the desk is built after this server
    // (it needs the escalation inbox).
    permissions: (): PermissionDesk => permissions,
    // Lazy for the same reason again: the sink and the template book are both built
    // below this. If this closure is ever dropped, `open_pr` reports itself unwired
    // in production and no test catches it — the ArgsBuilder/mcpConfigPath trap.
    openPr: (): McpToolDeps['openPr'] => ({
      sink: opts.sink ?? connector,
      defaultBranch: config.defaultBranch,
      prompts,
    }),
    errors,
  });

  // The desktop channel (the operator's own Claude Code). Constructed
  // unconditionally so `system.desktop` is addressable, and inert until
  // `listen()` — which is the only thing that binds the stable socket or writes
  // a credential into the operator's home directory. Neither should happen
  // because a deployment took the defaults, which is why `validation.desktop`
  // is off by default and `main.ts` reads it before calling.
  const desktop = new McpDesktopServer({
    store,
    claimMinutes: config.validation.desktopClaimMinutes,
    validationRoot: config.validationRoot,
    now: () => new Date().toISOString(),
    socketPath: config.validation.desktopSocketPath,
    credentialPath: config.validation.desktopCredentialPath,
    errors,
  });

  const agents: AgentManager = new AgentManager(store, {
    command: config.claudeCommand,
    buildArgs: agentSetup.buildArgs,
    whitelistedApprovals: config.whitelistedApprovals,
    // What a goal's work runs on today, so `recordAssay` can tell an agreeing
    // proposal from a diverging one. Read off the world baseline rather than a
    // live provider call: it is the same snapshot `world_read` serves an agent,
    // so the assayer and the harness are comparing against one reading. Absent
    // when either half of a pin is unconfigured, and then no proposal is stored.
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
    createSession: agentSetup.factory,
    initialInput: agentSetup.initialInput,
    resumeInput: agentSetup.resumeInput,
    promptDelayMs: agentSetup.promptDelayMs,
    waitingPatterns: config.agentWaitingPatterns,
    resumable: agentSetup.resumable,
    resumeAttempts: config.agentResumeAttempts,
    statusFile: rateLimits ? (sessionId): string => rateLimits.fileFor(sessionId) : undefined,
    fileEvents,
    docsFolderPrefix: config.docsFolderPrefix,
    mcp,
    // The `plan.json` transport's half of the approval gate — the tool transport
    // gets the same flag above, so a verdict lands identically either way.
    requirePlanApproval: config.planning.requireApproval,
    // So `link_ticket` can move a blueprint's images off the filing job and onto
    // the ticket it just created (issue #249) — the same instance the launch route
    // wrote them with, since both halves must agree about the root.
    attachments,
    errors,
  });
  const escalations = new EscalationInbox(store, agents);
  // The permission backstop (issue #130 phase B): where an agent's un-allowlisted
  // tool call blocks until the operator allows or denies. Reaches the fleet via the
  // MCP server's `permissions` thunk above; resolved on agent death via its `release`.
  const permissions = new PermissionDesk(escalations);
  // Where a restart's orphaned agents wait for a verdict. `resumable` is the same
  // runtime fact `AgentManager` uses, threaded in so the desk can say *why* restore
  // isn't on offer rather than the cockpit guessing from a missing session id.
  const recovery = new RecoveryDesk({
    store,
    agents,
    escalations,
    resumable: agentSetup.resumable,
    // The fence on the agentless arm. A test that wants a task read as an orphan of
    // a previous run sets this ahead of the rows it built; production takes the
    // module-load default.
    bootedAt: opts.bootedAt,
    errors,
  });

  // Live, in-memory dispatch controls both the harness and executor read by
  // reference each cycle. Ephemeral by design: a restart reverts to config.
  const runtimeControl = new RuntimeControl(config.maxConcurrentAgents, config.startPaused);

  // Recorded before the executor, which asks it whether a rung's merge is already
  // authorized. It reaches nothing but the store and the inbox, so the two are
  // wired one way and there is no cycle to break.
  const landings = new StackLandingDesk(store, escalations, errors);

  const executor = new ActionExecutor({
    store,
    landings,
    agents,
    worktrees,
    escalations,
    sink: opts.sink ?? connector,
    agentModels: config.agentModels,
    deskRoot: config.deskRoot,
    defaultBranch: config.defaultBranch,
    runtime: runtimeControl,
    errors,
    // The composite, never `opts.sink`: this is a *read* of the provider, and a
    // test that swaps the outbound sink is not saying anything about where CI
    // evidence comes from. It answers `[]` when no integration can supply any,
    // so the fake provider composes exactly the prompt it always did.
    ciEvidence: opts.ciEvidence ?? connector,
  });

  // The accept/reject surface for every act the harness will not perform on its
  // own — which is all of them. It runs an accepted act through the executor, so
  // the outbound sink keeps a single caller and the human's authorization lands in
  // the audit log.
  const proposals = new ProposalDesk(store, escalations, executor);

  // Dispatcher-level issue-pickup policy (gate + label-encoded priority), honoured
  // by whichever dispatcher is selected — provider-agnostic.
  const { watchLabel, ignoreLabel } = watchLabelsFor(config.labelPrefix);
  const issuePickup: IssuePickupPolicy = {
    watchLabel,
    ignoreLabel,
    // The ownership gate follows the operator's identity: with `userId` set, only a
    // watch tag *they* added counts. Unset — the fake provider, a first run — there
    // is no identity to attribute a tag to, so any tagger counts.
    requireOwnLabel: config.userId !== undefined,
    priorityLabels: config.issuePriorityLabels,
    defaultPriority: config.issueDefaultPriority,
    pickupStates: config.issuePickupStates,
    inReviewState: config.issueInReviewState,
    containerTypes: config.issueContainerTypes,
  };
  // Hoisted out of the RuleDispatcher's construction because the template book is
  // no longer only the dispatcher's: `POST /api/findings/:id/file` renders
  // `finding-ticket` from it, and that must work whether or not a cycle is running.
  const prompts = loadPromptTemplates(config.promptTemplatesDir);
  const dispatcher: Dispatcher = new RuleDispatcher(
    issuePickup,
    {},
    prompts,
    config.defaultBranch,
    config.planning,
    config.ci,
    config.validation,
    config.validationRoot,
  );

  // The store holds scheduling intent; this folds git + provider reality back onto
  // it every pulse. Its `git fetch` is wired only for the real observer: the seam
  // is fetch-free by design, so refreshing the remote is the caller's call (floored
  // by `planning.gitFetchIntervalMs` so a fast heartbeat can't storm the remote).
  const plans = new PlanReconciler({
    store,
    git: gitObserver,
    sink: opts.sink ?? connector,
    planning: config.planning,
    defaultBranch: config.defaultBranch,
    fetch: opts.gitObserver ? undefined : () => fetchRemote(config.repoRoot),
    errors,
  });

  // The goal assay's outbound half: one living comment per refused goal, on the
  // ticket. Beside the plan reconciler because it is the same act — mechanical
  // bookkeeping through the same seam, not an action the executor gates.
  const assays = new AssayDesk({ store, sink: opts.sink ?? connector, errors });
  // The naming convention's outbound half. `userId` being set is the operator's own
  // answer to "which pull requests are mine", and both providers apply it at fetch
  // time — so when it is set the world is already only theirs.
  const prAuthorConfigured = config.userId !== undefined;
  const naming = new PrNamingDesk({
    sink: opts.sink ?? connector,
    defaultBranch: config.defaultBranch,
    prAuthorConfigured,
    template: prompts.render('pr-title', {}),
    errors,
  });
  // The other half of tidying up after a pull request: once it has merged, the
  // branch behind it goes — worktree, local ref, then the remote. Only ever the
  // operator's own pull requests, and never a branch another open PR still targets.
  const branchReaps = new BranchReapDesk({
    sink: opts.sink ?? connector,
    store,
    worktrees,
    defaultBranch: config.defaultBranch,
    prAuthorConfigured,
    errors,
  });

  // The step after the launch, and the one station on the floor a person staffs:
  // a delivered goal whose ticket is still open owes a close. Store-only — it
  // files and settles a `human_tasks` row and touches no sink, because closing
  // the item is precisely the part the harness is not doing.
  const closeOuts = new DeliveryCloseOutDesk(store);

  // Where a recurrence becomes a queued job. Store-only, like the close-out desk:
  // it writes the same `jobs` row the launch route writes and leaves every
  // question about what happens to it to rule `manual-job`.
  const schedules = new ScheduleDesk({ store, errors });

  const graph = new WorkGraphRecorder({ store, errors });

  const harness = new Harness({
    store,
    connector,
    dispatcher,
    executor,
    plans,
    assays,
    naming,
    closeOuts,
    branchReaps,
    schedules,
    graph,
    landings,
    // Holds the pulse while a previous run's agents await a verdict.
    recovery,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    errors,
    runtime: runtimeControl,
    prIgnoreLabel: ignoreLabel,
    // Only when both halves exist: pins are labels naming profiles, so a
    // deployment with no `labelPrefix` has nowhere to write one and a deployment
    // with no `agentModels` has nothing for one to name.
    modelPins:
      config.labelPrefix && config.agentModels
        ? { labelPrefix: config.labelPrefix, models: config.agentModels }
        : undefined,
    upNextOverrideTtlMs: config.upNextOverrideTtlMs,
  });

  // Auto-escalate any non-whitelisted waiting agent so it surfaces in the inbox.
  // Idempotent per agent: an agent already has at most one open escalation, so a
  // repeat 'waiting' (e.g. a resumed agent re-surfacing its park) never doubles up.
  // Enrich with the task's originating signal and a tail of the agent's output so
  // the human can answer from the card without opening the drawer for context.
  //
  // `ask` is present only when the park came through the `escalate` tool, which is
  // the whole point of that tool: the *type* and the answer options are things the
  // agent knows and the WAITING sentinel had no way to say. Absent, this behaves
  // exactly as it did — one free-text question filed as `answer_question`.
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

  // A dead agent can never receive an answer, so cascade-dismiss its open
  // escalations at every terminal-dead transition. Kill surfaces as a `killed`
  // status; an unexpected exit / crash surfaces as a `failed` done. (An agent
  // orphaned by a *restart* is not dismissed here on purpose: it may be restored,
  // and a restored agent must come back to the question it parked on — see
  // `RecoveryDesk`, where the dismissal hangs off the requeue/remove verdicts.)
  agents.on('status', ({ agentId, status }) => {
    if (status === 'killed') escalations.dismissEscalationsForAgent(agentId, 'agent killed');
  });
  agents.on('done', ({ agentId, status, by }) => {
    if (status === 'failed') escalations.dismissEscalationsForAgent(agentId, 'agent failed');
    // An operator-declared done is the other way an agent leaves the fleet with a
    // question still open, and the commonest one: the shape `complete` exists for
    // is an agent parked on "ended its turn without finishing" that has in fact
    // finished. An agent-declared done is deliberately not swept here — it is the
    // same latent class, but changing it is a separate call.
    else if (by === 'operator') escalations.dismissEscalationsForAgent(agentId, 'operator marked the work complete');
  });

  // A cleanly finished code agent's worktree is removed once its process has
  // actually exited ('reaped' — a live process pins the cwd and would block the
  // removal). Failed/killed agents keep theirs for debugging; a next dispatch on
  // the branch recreates it via `ensure`. Worktrees are shared per-branch, so
  // hands off while any sibling task on the branch is still active.
  agents.on('reaped', ({ taskId, status }) => {
    if (status !== 'done') return;
    const task = store.getTask(taskId);
    const branch = task?.branch;
    if (!branch) return;
    const active = (s: string): boolean => s === 'queued' || s === 'running' || s === 'waiting';
    if (store.listTasks().some((t) => t.id !== taskId && t.branch === branch && active(t.status))) return;
    void worktrees.remove(branch).catch((err: Error) => {
      errors.record({ source: 'agent', message: `Failed to remove worktree for ${branch}: ${err.message}` });
    });
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
    recovery,
    executor,
    dispatcher,
    harness,
    graph,
    runtimeControl,
    issuePickup,
    prompts,
    rateLimits,
    fileEvents,
    attachments,
    mcp,
    desktop,
    errors,
  };
}
