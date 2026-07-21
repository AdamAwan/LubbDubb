import type { Config } from './config.js';
import { Store } from './store/store.js';
import { CompositeConnector } from './integrations/compositeConnector.js';
import { buildIntegrations } from './integrations/registry.js';
import type { ActionSink } from './sink/actionSink.js';
import { NodePtyBackend, type PtyBackend } from './pty/backend.js';
import { WorktreeManager } from './worktree/worktreeManager.js';
import { AgentManager } from './agents/agentManager.js';
import { buildClaudeArgs, buildClaudeStreamArgs, buildInitialMessage } from './agents/agentProtocol.js';
import { PtySession } from './pty/ptySession.js';
import { StreamJsonSession, type Spawner } from './agents/streamJsonSession.js';
import type { SessionFactory } from './agents/session.js';
import { EscalationInbox } from './escalation/escalationInbox.js';
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
  const agentSetup = {
    stream: {
      args: buildClaudeStreamArgs({ permissionMode: perm, extraArgs }),
      factory: streamFactory,
      initialInput: (task: Parameters<typeof buildInitialMessage>[0]) => buildInitialMessage(task),
      promptDelayMs: 0, // stdin is ready immediately; no TUI to wait for
    },
    pty: {
      args: buildClaudeArgs({ permissionMode: perm, extraArgs }),
      factory: ptyFactory,
      initialInput: (task: Parameters<typeof buildInitialMessage>[0]) => buildInitialMessage(task),
      promptDelayMs: config.agentPromptDelayMs,
    },
    raw: {
      args: config.claudeArgs,
      factory: ptyFactory,
      initialInput: undefined,
      promptDelayMs: config.agentPromptDelayMs,
    },
  }[config.agentMode];

  const agents = new AgentManager(store, {
    command: config.claudeCommand,
    args: agentSetup.args,
    whitelistedApprovals: config.whitelistedApprovals,
    createSession: agentSetup.factory,
    initialInput: agentSetup.initialInput,
    promptDelayMs: agentSetup.promptDelayMs,
    waitingPatterns: config.agentWaitingPatterns,
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
  agents.on('waiting', ({ agentId, taskId, reason }) => {
    const task = store.getTask(taskId);
    escalations.create({
      type: 'answer_question',
      prompt: reason,
      context: { taskTitle: task?.title, agentId, taskId },
      agentId,
      taskId,
    });
  });

  return { config, store, connector, agents, escalations, executor, dispatcher, harness };
}

/**
 * Restart reconciliation: any agent still marked live in the store is really
 * dead (its PTY died with the process), so mark it — and its task — interrupted.
 * The next dispatch cycle decides whether to resume. Must run before the
 * heartbeat starts.
 */
export function reconcileOnBoot(store: Store): number {
  const zombies = store.listAgentsByStatus('starting', 'running', 'waiting');
  const at = new Date().toISOString();
  for (const agent of zombies) {
    store.updateAgent(agent.id, { status: 'interrupted', endedAt: at, pid: null });
    const task = store.getTask(agent.taskId);
    if (task && (task.status === 'running' || task.status === 'waiting' || task.status === 'queued')) {
      store.updateTask(task.id, { status: 'interrupted' });
    }
  }
  return zombies.length;
}
