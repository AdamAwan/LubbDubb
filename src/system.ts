import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.js';
import { Store } from './store/store.js';
import { CompositeConnector } from './integrations/compositeConnector.js';
import { buildIntegrations } from './integrations/registry.js';
import type { ActionSink } from './sink/actionSink.js';
import { NodePtyBackend, type PtyBackend } from './pty/backend.js';
import { WorktreeManager } from './worktree/worktreeManager.js';
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
import type { SessionFactory } from './agents/session.js';
import { EscalationInbox } from './escalation/escalationInbox.js';
import { recentOutputExcerpt } from './escalation/context.js';
import { ActionExecutor } from './executor/actionExecutor.js';
import { RuleDispatcher } from './dispatcher/ruleDispatcher.js';
import { ClaudeDispatcher } from './dispatcher/claudeDispatcher.js';
import type { Dispatcher } from './dispatcher/dispatcher.js';
import type { IssuePickupPolicy } from './dispatcher/issuePickup.js';
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
  executor: ActionExecutor;
  dispatcher: Dispatcher;
  harness: Harness;
  /** Live, ephemeral dispatch controls (cap + pause). Seeded from config at boot. */
  runtimeControl: RuntimeControl;
  /**
   * Account rate-limit capture (status-line payloads), wired only for the PTY
   * runtime — the status line never fires headless. Null in other modes; the
   * snapshot then falls back to the rolling cost windows from `usage_events`.
   */
  rateLimits: StatusFileRateLimits | null;
  /** Central error log: every caught failure is persisted here and streamed to the cockpit. */
  errors: ErrorLog;
}

export interface BuildOptions {
  /** Inject a fake PTY backend (tests) instead of the real node-pty one. */
  backend?: PtyBackend;
  /** Override the outbound sink (tests). Defaults to the FakeConnector. */
  sink?: ActionSink;
  /** Inject a fake process spawner (tests) for the stream-JSON runtime. */
  streamSpawner?: Spawner;
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

  // Pick the agent runtime and how it's launched from the configured mode.
  // `legible` turns on the terminal-emulation transcript (settled text instead of
  // raw TUI bytes) — wanted for the real claude TUI, not for raw/mock sessions.
  const ptyFactory = (legible: boolean): SessionFactory => {
    return (spec) =>
      new PtySession(backend, {
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
        waitingPatterns: spec.waitingPatterns,
        submitDelayMs: config.agentSubmitDelayMs,
        legibleTranscript: legible,
      });
  };
  const streamFactory: SessionFactory = (spec) => new StreamJsonSession(spec, opts.streamSpawner);

  const perm = config.agentPermissionMode;
  const extraArgs = config.claudeArgs;
  type ArgsBuilder = (opts: { sessionId: string; resume: boolean }) => string[];
  const agentSetup = {
    stream: {
      // Stream-JSON resume is out of scope; ignore the session id.
      buildArgs: (() => buildClaudeStreamArgs({ permissionMode: perm, extraArgs })) as ArgsBuilder,
      factory: streamFactory,
      initialInput: (task: Parameters<typeof buildInitialMessage>[0]) => buildInitialMessage(task),
      resumeInput: undefined,
      promptDelayMs: 0, // stdin is ready immediately; no TUI to wait for
      resumable: false,
    },
    pty: {
      // The one resumable runtime: pin the session id up front, `--resume` it later.
      buildArgs: (({ sessionId, resume }) =>
        buildClaudeArgs({ permissionMode: perm, extraArgs, sessionId, resume, statusLine: true })) as ArgsBuilder,
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

  const agents = new AgentManager(store, {
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
    errors,
  });
  const escalations = new EscalationInbox(store, agents);

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
    runtime: runtimeControl,
  });

  // Dispatcher-level issue-pickup policy (gate + label-encoded priority), honoured
  // by whichever dispatcher is selected — provider-agnostic.
  const issuePickup: IssuePickupPolicy = {
    pickupLabel: config.issuePickupLabel,
    requireOwnLabel: config.issuePickupRequireOwnLabel,
    priorityLabels: config.issuePriorityLabels,
    defaultPriority: config.issueDefaultPriority,
    pickupStates: config.issuePickupStates,
    inReviewState: config.issueInReviewState,
  };
  const dispatcher: Dispatcher =
    config.dispatcher === 'claude'
      ? new ClaudeDispatcher(backend, {
          command: config.claudeCommand,
          args: config.claudeArgs,
          cwd: config.repoRoot,
          issuePickup,
        })
      : new RuleDispatcher(issuePickup);

  const harness = new Harness({
    store,
    connector,
    dispatcher,
    executor,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    errors,
    runtime: runtimeControl,
    steeringPriorities: config.steeringPriorities,
    prExclusionLabel: config.prExclusionLabel,
  });

  // Auto-escalate any non-whitelisted waiting agent so it surfaces in the inbox.
  // Idempotent per agent: an agent already has at most one open escalation, so a
  // repeat 'waiting' (e.g. a resumed agent re-surfacing its park) never doubles up.
  // Enrich with the task's originating signal and a tail of the agent's output so
  // the human can answer from the card without opening the drawer for context.
  agents.on('waiting', ({ agentId, taskId, reason }) => {
    if (store.listOpenEscalations().some((e) => e.agentId === agentId)) return;
    const task = store.getTask(taskId);
    escalations.create({
      type: 'answer_question',
      prompt: reason,
      context: {
        taskTitle: task?.title,
        originRef: task?.originRef ?? null,
        recentOutput: recentOutputExcerpt(store.getTranscript(agentId)),
      },
      agentId,
      taskId,
    });
  });

  // A dead agent can never receive an answer, so cascade-dismiss its open
  // escalations at every terminal-dead transition. Kill surfaces as a `killed`
  // status; an unexpected exit / crash surfaces as a `failed` done. (Server-restart
  // orphans are handled separately by reconcileAndResumeOnBoot, before the heartbeat runs.)
  agents.on('status', ({ agentId, status }) => {
    if (status === 'killed') escalations.dismissEscalationsForAgent(agentId, 'agent killed');
  });
  agents.on('done', ({ agentId, status }) => {
    if (status === 'failed') escalations.dismissEscalationsForAgent(agentId, 'agent failed');
  });

  return {
    config,
    store,
    connector,
    agents,
    escalations,
    executor,
    dispatcher,
    harness,
    runtimeControl,
    rateLimits,
    errors,
  };
}

/**
 * Restart reconciliation, run once on boot *before* the harness reacts to the
 * world. Any agent the store still thinks is live is really dead (its PTY died
 * with the old process). For each such orphan whose work is still in flight we
 * try to resume it — re-attaching to the same Claude session in the same
 * worktree — so a restart continues rather than discards work. Best-effort:
 * anything not resumable (no session id, missing worktree, non-PTY runtime)
 * falls back to today's `interrupted` behaviour; boot never blocks on a resume.
 *
 * Resumed agents re-enter the live set (keeping their pre-restart escalation, so
 * a queued answer still routes in) and count against `maxConcurrentAgents` before
 * the boot cycle dispatches anything new. An orphan that *can't* be resumed is
 * truly dead, so its now-orphaned open escalations are cascade-dismissed.
 *
 * Candidate set (orphans): agents in a live-ish state — `starting`/`running`/
 * `waiting` (crash) or `interrupted` (graceful shutdown) — whose task is still
 * active. A cockpit kill leaves the agent `killed` and its task `interrupted`,
 * so it is excluded on both counts and stays dead. A prior boot's give-up leaves
 * both agent and task `interrupted`, so it isn't resurrected on every restart.
 */
export function reconcileAndResumeOnBoot(
  store: Store,
  agents: AgentManager,
  escalations: EscalationInbox,
  errors?: ErrorLog,
): { resumed: number; interrupted: number } {
  const isActive = (status: string): boolean => status === 'running' || status === 'waiting' || status === 'queued';
  const orphans = store.listAgentsByStatus('starting', 'running', 'waiting', 'interrupted').filter((a) => {
    const task = store.getTask(a.taskId);
    return task != null && isActive(task.status);
  });

  const at = new Date().toISOString();
  const result = { resumed: 0, interrupted: 0 };
  for (const agent of orphans) {
    const task = store.getTask(agent.taskId);
    if (!task) continue;

    let resumed = false;
    if (agent.sessionId && existsSync(agent.cwd)) {
      try {
        resumed = agents.resume(agent, task);
      } catch (err) {
        resumed = false; // never let a bad resume block boot — but do record why it failed
        errors?.record({ source: 'boot', message: `Boot resume failed: ${(err as Error).message}` });
      }
    }
    if (resumed) {
      result.resumed += 1;
      continue;
    }

    // Fallback: agent can't be resumed, so it's truly dead. Mark agent and task
    // interrupted (also stops it being retried next boot) and cascade-dismiss its
    // now-orphaned open escalations (a fresh agent re-raises anything still needed).
    store.updateAgent(agent.id, { status: 'interrupted', endedAt: at, pid: null });
    store.updateTask(task.id, { status: 'interrupted' });
    escalations.dismissEscalationsForAgent(agent.id, 'server restart');
    result.interrupted += 1;
  }
  return result;
}
