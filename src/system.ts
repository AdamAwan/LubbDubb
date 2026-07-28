import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.js';
import { Store } from './store/store.js';
import { CompositeConnector } from './integrations/compositeConnector.js';
import { buildIntegrations } from './integrations/registry.js';
import type { ActionSink } from './sink/actionSink.js';
import { NodePtyBackend, type PtyBackend } from './pty/backend.js';
import { defaultSessionRoot } from './agents/sessionTranscript.js';
import { WorktreeManager } from './worktree/worktreeManager.js';
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
import type { SessionFactory } from './agents/session.js';
import { EscalationInbox } from './escalation/escalationInbox.js';
import { ProposalDesk } from './proposals/proposalDesk.js';
import { escalationTypeForAsk, recentOutputExcerpt } from './escalation/context.js';
import { defaultConfigDir, defaultSocketPath, McpBridgeServer } from './mcp/server.js';
import { PERMISSION_PROMPT_TOOL } from './mcp/names.js';
import { PermissionDesk } from './agents/permissionDesk.js';
import { RecoveryDesk } from './agents/recoveryDesk.js';
import { ActionExecutor } from './executor/actionExecutor.js';
import { RuleDispatcher } from './dispatcher/ruleDispatcher.js';
import { loadPromptTemplates, type PromptTemplates } from './dispatcher/promptTemplates.js';
import { ClaudeDispatcher } from './dispatcher/claudeDispatcher.js';
import type { Dispatcher } from './dispatcher/dispatcher.js';
import type { IssuePickupPolicy } from './dispatcher/issuePickup.js';
import { watchLabelsFor } from './watchLabels.js';
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
   * The issue-pickup policy both dispatchers honour, exposed so the snapshot can
   * compute the same per-issue pickup verdict the dispatcher will act on.
   */
  issuePickup: IssuePickupPolicy;
  /**
   * The operator-customisable prompt book. Exposed because one prompt is
   * route-driven rather than dispatcher-driven: filing a finding as a ticket
   * (`finding-ticket`), which must render the same way under either dispatcher.
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
   * The agents' typed channel back to the harness (issue #108). Always present,
   * but inert until `listen()` succeeds *and* `config.mcp.enabled` let it reach
   * the fleet — so a system built without either behaves exactly as it did before
   * the channel existed. Tests reach tools through `mcp.session(agentId)`, which
   * is the same entry point an agent's bridge lands on.
   */
  mcp: McpBridgeServer;
  /** Central error log: every caught failure is persisted here and streamed to the cockpit. */
  errors: ErrorLog;
}

interface BuildOptions {
  /** Inject a fake PTY backend (tests) instead of the real node-pty one. */
  backend?: PtyBackend;
  /** Override the outbound sink (tests). Defaults to the FakeConnector. */
  sink?: ActionSink;
  /** Inject a fake process spawner (tests) for the stream-JSON runtime. */
  streamSpawner?: Spawner;
  /**
   * Override the git observer plan reconciliation reads branch reality through
   * (tests inject `FakeGitObserver`). Injecting one also turns the reconciler's
   * `git fetch` off — a scripted observer has no remote to refresh.
   */
  gitObserver?: GitObserver;
  /** Override where recorded errors are mirrored (tests silence the default stderr echo). */
  errorMirror?: (entry: ErrorLogEntry) => void;
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
  const connector = new CompositeConnector(integrations, store, now);
  const backend = opts.backend ?? new NodePtyBackend();

  const worktrees = new WorktreeManager(config.repoRoot, config.worktreeRoot);
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
  const ptyFactory = (claudeTui: boolean): SessionFactory => {
    return (spec) =>
      new PtySession(backend, {
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
        waitingPatterns: spec.waitingPatterns,
        submitDelayMs: config.agentSubmitDelayMs,
        // Needs a pinned session id to name the transcript file; only the resumable
        // PTY runtime has one, which is exactly the mode that needs it.
        sessionTranscript:
          claudeTui && spec.sessionId
            ? { root: sessionRoot, sessionId: spec.sessionId, startAtEof: spec.resume === true }
            : undefined,
        onWarning: (message) => errors.record({ source: 'agent', message }),
        exitOnDone: claudeTui,
        // Real-TUI only: raw/mock sessions are line-oriented and legitimately
        // silent between steps, so idle means nothing there.
        idleWaitMs: claudeTui ? config.agentIdleWaitMs : 0,
      });
  };
  const streamFactory: SessionFactory = (spec) => new StreamJsonSession(spec, opts.streamSpawner);

  const perm = config.agentPermissionMode;
  const extraArgs = config.claudeArgs;
  const allowedTools = config.agentAllowedTools;
  // The permission backstop's tool name, wired only when the MCP channel is on and
  // the operator left the backstop enabled (issue #130 phase B). Passed on every
  // launch; it only takes effect when that launch also carries an `--mcp-config`.
  const permissionPromptTool =
    config.mcp.enabled && config.mcp.permissionEscalation ? PERMISSION_PROMPT_TOOL : undefined;
  // `mcpConfigPath` is per-launch (minted by AgentManager) and MUST be threaded
  // through — without it neither `--mcp-config` nor `--permission-prompt-tool` is
  // ever added, and the tool channel is dead in production.
  type ArgsBuilder = (opts: { sessionId: string; resume: boolean; mcpConfigPath: string | null }) => string[];
  const agentSetup = {
    stream: {
      // Stream-JSON resume is out of scope; ignore the session id.
      buildArgs: (({ mcpConfigPath }) =>
        buildClaudeStreamArgs({
          permissionMode: perm,
          extraArgs,
          allowedTools,
          fileEvents: true,
          mcpConfigPath,
          permissionPromptTool,
        })) as ArgsBuilder,
      factory: streamFactory,
      initialInput: (task: Parameters<typeof buildInitialMessage>[0]) => buildInitialMessage(task),
      resumeInput: undefined,
      promptDelayMs: 0, // stdin is ready immediately; no TUI to wait for
      resumable: false,
    },
    pty: {
      // The one resumable runtime: pin the session id up front, `--resume` it later.
      buildArgs: (({ sessionId, resume, mcpConfigPath }) =>
        buildClaudeArgs({
          permissionMode: perm,
          extraArgs,
          allowedTools,
          sessionId,
          resume,
          statusLine: true,
          fileEvents: true,
          mcpConfigPath,
          permissionPromptTool,
        })) as ArgsBuilder,
      factory: ptyFactory(true),
      initialInput: (task: Parameters<typeof buildInitialMessage>[0]) => buildInitialMessage(task),
      resumeInput: buildResumeMessage,
      promptDelayMs: config.agentPromptDelayMs,
      resumable: true,
    },
    raw: {
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
    // Lazy for the same reason as `agents`: the desk is built after this server
    // (it needs the escalation inbox). Off entirely when the operator disabled the
    // backstop, so `request_permission` denies rather than blocks.
    permissions: (): PermissionDesk | undefined => (config.mcp.permissionEscalation ? permissions : undefined),
    errors,
  });

  const agents: AgentManager = new AgentManager(store, {
    command: config.claudeCommand,
    buildArgs: agentSetup.buildArgs,
    whitelistedApprovals: config.whitelistedApprovals,
    createSession: agentSetup.factory,
    initialInput: agentSetup.initialInput,
    resumeInput: agentSetup.resumeInput,
    promptDelayMs: agentSetup.promptDelayMs,
    waitingPatterns: config.agentWaitingPatterns,
    resumable: agentSetup.resumable,
    statusFile: rateLimits ? (sessionId): string => rateLimits.fileFor(sessionId) : undefined,
    fileEvents,
    docsFolderPrefix: config.docsFolderPrefix,
    mcp: config.mcp.enabled ? mcp : undefined,
    // The `plan.json` transport's half of the approval gate — the tool transport
    // gets the same flag above, so a verdict lands identically either way.
    requirePlanApproval: config.planning.requireApproval,
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
  const recovery = new RecoveryDesk({ store, agents, escalations, resumable: agentSetup.resumable, errors });

  // Live, in-memory dispatch controls both the harness and executor read by
  // reference each cycle. Ephemeral by design: a restart reverts to config.
  const runtimeControl = new RuntimeControl(config.maxConcurrentAgents, config.startPaused);

  const executor = new ActionExecutor({
    store,
    agents,
    worktrees,
    escalations,
    sink: opts.sink ?? connector,
    autoSend: config.autoSend,
    deskRoot: config.deskRoot,
    defaultBranch: config.defaultBranch,
    runtime: runtimeControl,
  });

  // The accept/reject surface for acts the auto-send gate refused to perform on
  // its own. It runs an accepted act through the executor, so the outbound sink
  // keeps a single caller and the human's authorization lands in the audit log.
  const proposals = new ProposalDesk(store, escalations, executor);

  // Dispatcher-level issue-pickup policy (gate + label-encoded priority), honoured
  // by whichever dispatcher is selected — provider-agnostic.
  const { watchLabel, ignoreLabel } = watchLabelsFor(config.labelPrefix);
  const issuePickup: IssuePickupPolicy = {
    watchLabel,
    ignoreLabel,
    requireOwnLabel: config.issuePickupRequireOwnLabel,
    priorityLabels: config.issuePriorityLabels,
    defaultPriority: config.issueDefaultPriority,
    pickupStates: config.issuePickupStates,
    inReviewState: config.issueInReviewState,
  };
  // Hoisted out of the RuleDispatcher's construction because the template book is
  // no longer only the dispatcher's: `POST /api/findings/:id/file` renders
  // `finding-ticket` from it, and that must work whichever dispatcher is active.
  const prompts = loadPromptTemplates(config.promptTemplatesDir);
  const dispatcher: Dispatcher =
    config.dispatcher === 'claude'
      ? new ClaudeDispatcher(backend, {
          command: config.claudeCommand,
          args: config.claudeArgs,
          cwd: config.repoRoot,
          issuePickup,
        })
      : new RuleDispatcher(
          issuePickup,
          {},
          prompts,
          config.defaultBranch,
          // The plan funnel is a rule-dispatcher feature; the LLM dispatcher
          // composes its own prompts and has no equivalent (see the README).
          config.planning,
          // Likewise rule-dispatcher only: the assessor is a rule, and the LLM
          // dispatcher reasons in prose with no equivalent branch.
          config.assessment,
          // Per-check CI policy narrows rule 1. The LLM dispatcher composes its
          // own prompts from the world and has no rule to narrow.
          config.ci,
          // Same again: the goal assay is a rule in front of the funnel, and the
          // LLM dispatcher has no branch it narrows.
          config.assay,
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
  const assays = new AssayDesk({ store, sink: opts.sink ?? connector, assay: config.assay, errors });

  const graph = new WorkGraphRecorder({ store, errors });

  const harness = new Harness({
    store,
    connector,
    dispatcher,
    executor,
    plans,
    assays,
    graph,
    // Holds the pulse while a previous run's agents await a verdict.
    recovery,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    errors,
    runtime: runtimeControl,
    steeringPriorities: config.steeringPriorities,
    prIgnoreLabel: ignoreLabel,
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
    mcp,
    errors,
  };
}
