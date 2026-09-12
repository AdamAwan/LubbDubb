import { existsSync } from 'node:fs';
import type { Store } from '../store/store.js';
import type { AgentManager } from './agentManager.js';
import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { Job, Task } from '../types.js';
import {
  describeOrphan,
  isAgentlessCandidate,
  isRecoveryCandidate,
  requeueJobRequest,
  restorability,
  type OrphanedWork,
  type RecoveryVerdict,
} from './crashRecovery.js';

// → docs/spec/10-agent-runtimes.md

interface RecoveryOutcome {
  verdict: RecoveryVerdict;
  agentId: string | null;
  taskId: string;
  detail: string;
  job?: Job;
}

type RecoveryResult = { ok: true; outcome: RecoveryOutcome } | { ok: false; error: string };

export class RecoveryDesk {
  constructor(
    private readonly deps: {
      store: Store;
      agents: AgentManager;
      escalations: EscalationInbox;
      resumable: boolean;
      bootedAt?: string;
      errors?: ErrorRecorder;
    },
  ) {}

  private get bootedAt(): string {
    return this.deps.bootedAt ?? BOOTED_AT;
  }

  detect(): OrphanedWork[] {
    const at = new Date().toISOString();
    for (const agent of this.deps.store.agents.listAgents()) {
      const task = this.deps.store.tasks.getTask(agent.taskId);
      if (!isRecoveryCandidate(agent, task)) continue;
      if (agent.status === 'crashed' || agent.status === 'interrupted') continue;
      this.deps.store.agents.updateAgent(agent.id, { status: 'crashed', endedAt: agent.endedAt ?? at, pid: null });
      this.deps.errors?.record({
        source: 'boot',
        message: `Agent ${agent.id} did not survive the last run (was ${agent.status}); awaiting a recovery decision`,
        detail: task?.originRef ?? null,
      });
    }
    const pending = this.pending();
    for (const item of pending)
      if (item.died === 'never_started')
        this.deps.errors?.record({
          source: 'boot',
          message:
            `Task ${item.taskId} was recorded but no agent ever started for it; its origin and branch are ` +
            'held shut until a recovery decision is made',
          detail: item.originRef ?? null,
        });
    if (pending.length > 0)
      this.deps.store.decisions.recordDecision({
        cycleId: RECOVERY_CYCLE,
        action: { type: 'no_op', reason: 'crash recovery' },
        outcome: 'skipped',
        detail:
          `Holding the pulse: ${pending.length} task(s) from the previous run need a recovery decision ` +
          `(${pending.map((p) => p.taskId).join(', ')})`,
      });
    return pending;
  }

  /**
   * Restore the agents this harness interrupted **on purpose**, coming back up from
   * an upgrade — the second half of a decision the operator already took.
   *
   * Two fences keep it narrow: only under the `applying` intent state, and only
   * `interrupted` rows. A `crashed` row means something else killed that agent
   * inside the upgrade window, so it lands in the panel like any other orphan.
   * Returns what it restored *and* what it left, so boot can say both out loud.
   *
   * @public called by `src/server/main.ts` at boot, after `detect`.
   */
  settleUpgrade(): { restored: OrphanedWork[]; left: OrphanedWork[] } {
    const restored: OrphanedWork[] = [];
    const left: OrphanedWork[] = [];
    if (this.deps.store.upgrades.readUpgradeIntent().state !== 'applying') return { restored, left: this.pending() };
    for (const item of this.pending()) {
      if (item.died !== 'interrupted' || !item.restorable) {
        left.push(item);
        continue;
      }
      const result = this.decide(item.taskId, 'restore');
      if (result.ok) {
        restored.push(item);
        continue;
      }
      left.push(item);
      this.deps.errors?.record({
        source: 'boot',
        message: `Could not restore ${item.taskId} after the upgrade: ${result.error}`,
        detail: item.originRef ?? null,
      });
    }
    return { restored, left };
  }

  pending(): OrphanedWork[] {
    const out: OrphanedWork[] = [];
    const staffed = new Set<string>();
    for (const agent of this.deps.store.agents.listAgents()) staffed.add(agent.taskId);
    for (const agent of this.deps.store.agents.listAgentsByStatus('crashed', 'interrupted')) {
      const task = this.deps.store.tasks.getTask(agent.taskId);
      if (!isRecoveryCandidate(agent, task) || !task) continue;
      out.push(
        describeOrphan(
          agent,
          task,
          restorability(agent, { resumable: this.deps.resumable, worktreeExists: existsSync(agent.cwd) }),
        ),
      );
    }
    for (const task of this.deps.store.tasks.listOutstandingTasks()) {
      if (!isAgentlessCandidate(task, { hasAgent: staffed.has(task.id), bootedAt: this.bootedAt })) continue;
      out.push(describeOrphan(null, task, restorability(null, { resumable: false, worktreeExists: false })));
    }
    return out;
  }

  pendingCount(): number {
    return this.pending().length;
  }

  pendingForAgent(agentId: string): OrphanedWork | null {
    return this.pending().find((p) => p.agentId === agentId) ?? null;
  }

  decide(taskId: string, verdict: RecoveryVerdict): RecoveryResult {
    const item = this.pending().find((p) => p.taskId === taskId);
    if (!item) return { ok: false, error: 'no orphaned work awaiting a recovery decision for this task id' };
    const agentId = item.agentId;
    const agent = agentId ? this.deps.store.agents.getAgent(agentId) : null;
    const task = this.deps.store.tasks.getTask(item.taskId);
    if (!task || (agentId && !agent)) return { ok: false, error: 'agent or task no longer exists' };

    if (verdict === 'restore') {
      if (!item.restorable || !agent)
        return { ok: false, error: item.restoreBlocked ?? 'this work cannot be restored' };
      let resumed = false;
      try {
        resumed = this.deps.agents.resume(agent, task);
      } catch (err) {
        this.deps.errors?.record({ source: 'boot', message: `Crash restore failed: ${(err as Error).message}` });
        return { ok: false, error: `restore failed: ${(err as Error).message}` };
      }
      if (!resumed) return { ok: false, error: 'the runtime refused to resume this session' };
      return this.settled({
        verdict,
        agentId,
        taskId: task.id,
        detail: `Restored agent ${agentId} into its existing session and worktree`,
      });
    }

    const at = new Date().toISOString();
    if (agent) {
      this.deps.store.agents.updateAgent(agent.id, { status: 'interrupted', endedAt: agent.endedAt ?? at, pid: null });
      this.deps.escalations.dismissEscalationsForAgent(
        agent.id,
        verdict === 'requeue' ? 'agent crashed; work requeued' : 'agent crashed; work dropped',
      );
    }
    this.deps.store.tasks.updateTask(task.id, { status: 'interrupted' });

    if (verdict === 'remove')
      return this.settled({
        verdict,
        agentId,
        taskId: task.id,
        detail: agent
          ? `Dropped agent ${agent.id} and its task; the worktree is kept for inspection`
          : `Dropped task ${task.id}, which no agent ever started; its origin and branch are free again`,
      });

    const standing = stillQueuedJobBehind(task, this.deps.store);
    if (standing)
      return this.settled({
        verdict,
        agentId,
        taskId: task.id,
        detail:
          `Requeued task ${task.id} by releasing job ${standing.id}, which never left the queue — ` +
          'its dispatch failed before any agent started, so there is nothing to redo',
        job: standing,
      });

    const request = requeueJobRequest(task, agent ? { note: agent.note } : null);
    const job = this.deps.store.jobs.createJob({
      title: request.title,
      prompt: request.prompt,
      kind: task.kind,
      branch: task.branch,
      originRef: task.originRef,
    });
    return this.settled({
      verdict,
      agentId,
      taskId: task.id,
      detail: agent
        ? `Requeued the work of agent ${agent.id} as job ${job.id}`
        : `Requeued task ${task.id}, which no agent ever started, as job ${job.id}`,
      job,
    });
  }

  private settled(outcome: RecoveryOutcome): RecoveryResult {
    this.deps.store.decisions.recordDecision({
      cycleId: RECOVERY_CYCLE,
      action: { type: 'no_op', reason: `crash recovery: ${outcome.verdict}` },
      outcome: 'executed',
      detail: outcome.detail,
    });
    return { ok: true, outcome };
  }
}

function stillQueuedJobBehind(task: Task, store: Store): Job | null {
  const id = task.originRef?.startsWith('job:') ? task.originRef.slice('job:'.length) : null;
  if (!id) return null;
  const job = store.jobs.getJob(id);
  return job && job.status === 'queued' ? job : null;
}

const RECOVERY_CYCLE = 'crash-recovery';

const BOOTED_AT = new Date().toISOString();
