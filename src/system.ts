import { existsSync } from 'node:fs';
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
import type { SessionFactory } from './agents/session.js';
import { EscalationInbox } from './escalation/escalationInbox.js';
import { recentOutputExcerpt } from './escalation/context.js';
import { ActionExecutor } from './executor/actionExecutor.js';
import { RuleDispatcher } from './dispatcher/ruleDispatcher.js';
import { ClaudeDispatcher } from './dispatcher/claudeDispatcher.js';
import type { Dispatcher } from './dispatcher/dispatcher.js';
import type { IssuePickupPolicy } from './dispatcher/issuePickup.js';
import { Harness } from './harness.js';

export interface System {
  config: Config;
  store: Store;
  connector: CompositeConnector;
  agents: AgentManager;
  escalations: EscalationInbox;
  executor: ActionExecutor;
  dispatcher: Dispatcher;
  harness: Harness;
}

export interface BuildOptions {
  /** Inject a fake PTY backend (tests) instead of the real node-pty one. */
  backend?: PtyBackend;
  /** Override the outbound sink (tests). Defaults to the FakeConnector. */
  sink?: ActionSink;
  /** Inject a fake process spawner (tests) for the stream-JSON runtime. */
  streamSpawner?: Spawner;
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
  const integrations = buildIntegrations(config.integrations, { store, config, now });
  const connector = new CompositeConnector(integrations, store, now);
  const backend = opts.backend ?? new NodePtyBackend();

  const worktrees = new WorktreeManager(config.repoRoot, config.worktreeRoot);

  // Pick the agent runtime and how it's launched from the configured mode.
  const ptyFactory: SessionFactory = (spec) =>
    new PtySession(backend, {
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
      waitingPatterns: spec.waitingPatterns,
    });
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
        buildClaudeArgs({ permissionMode: perm, extraArgs, sessionId, resume })) as ArgsBuilder,
      factory: ptyFactory,
      initialInput: (task: Parameters<typeof buildInitialMessage>[0]) => buildInitialMessage(task),
      resumeInput: buildResumeMessage,
      promptDelayMs: config.agentPromptDelayMs,
      resumable: true,
    },
    raw: {
      buildArgs: (() => config.claudeArgs) as ArgsBuilder,
      factory: ptyFactory,
      initialInput: undefined,
      resumeInput: undefined,
      promptDelayMs: config.agentPromptDelayMs,
      resumable: false,
    },
  }[config.agentMode];

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
  });
  const escalations = new EscalationInbox(store, agents);

  const executor = new ActionExecutor({
    store,
    agents,
    worktrees,
    escalations,
    sink: opts.sink ?? connector,
    autoSend: config.autoSend,
    deskRoot: config.deskRoot,
    maxConcurrentAgents: config.maxConcurrentAgents,
  });

  // Dispatcher-level issue-pickup policy (gate + label-encoded priority), honoured
  // by whichever dispatcher is selected — provider-agnostic.
  const issuePickup: IssuePickupPolicy = {
    pickupLabel: config.issuePickupLabel,
    priorityLabels: config.issuePriorityLabels,
    defaultPriority: config.issueDefaultPriority,
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
    maxConcurrentAgents: config.maxConcurrentAgents,
    steeringPriorities: config.steeringPriorities,
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

  return { config, store, connector, agents, escalations, executor, dispatcher, harness };
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
      } catch {
        resumed = false; // never let a bad resume block boot
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
