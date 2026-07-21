import type { Config } from './config.js';
import { Store } from './store/store.js';
import { FakeConnector } from './connector/fakeConnector.js';
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
import { Harness } from './harness.js';

export interface System {
  config: Config;
  store: Store;
  connector: FakeConnector;
  agents: AgentManager;
  escalations: EscalationInbox;
  executor: ActionExecutor;
  dispatcher: Dispatcher;
  harness: Harness;
}

export interface BuildOptions {
  /** Inject a fake PTY backend (tests) instead of the real node-pty one. */
  backend?: PtyBackend;
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
  const connector = new FakeConnector(store);
  const backend = opts.backend ?? new NodePtyBackend();

  const worktrees = new WorktreeManager(config.repoRoot, config.worktreeRoot);

  // Pick the agent runtime and how it's launched from the configured mode.
  const ptyFactory: SessionFactory = (spec) =>
    new PtySession(backend, { command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env, waitingPatterns: spec.waitingPatterns });
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
    deskRoot: config.deskRoot,
    maxConcurrentAgents: config.maxConcurrentAgents,
  });

  const dispatcher: Dispatcher =
    config.dispatcher === 'claude'
      ? new ClaudeDispatcher(backend, { command: config.claudeCommand, args: config.claudeArgs, cwd: config.repoRoot })
      : new RuleDispatcher();

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
