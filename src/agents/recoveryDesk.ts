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

/** What a settled recovery did, for the API response and the audit line. */
interface RecoveryOutcome {
  verdict: RecoveryVerdict;
  /** Null when the orphan never had an agent — the task is the identity here. */
  agentId: string | null;
  taskId: string;
  detail: string;
  /** The job a `requeue` filed, so the cockpit can point at it. */
  job?: Job;
}

/** Either the verdict was applied, or it was refused with a reason the operator can act on. */
type RecoveryResult = { ok: true; outcome: RecoveryOutcome } | { ok: false; error: string };

/**
 * Where work orphaned by a crash or a shutdown waits for an operator's call.
 * Detection decides nothing: it marks each orphan `crashed` and the harness
 * **holds every pulse** until the set is empty.
 *
 * The pending set is the rows themselves, so it needs no state here and survives a
 * restart; each verdict moves a row out of it, so "already decided" needs no record.
 * The set has two arms — an orphaned agent, and a task with no agent row at all.
 * → `docs/spec/10-agent-runtimes.md#crash-recovery`
 */
export class RecoveryDesk {
  constructor(
    private readonly deps: {
      store: Store;
      agents: AgentManager;
      escalations: EscalationInbox;
      /** Whether the configured runtime can `--resume` a session at all (PTY only). */
      resumable: boolean;
      /** When *this* process started — the fence on the agentless arm: a task created since is a live dispatch mid-flight, not an orphan. Injectable for tests. */
      bootedAt?: string;
      errors?: ErrorRecorder;
    },
  ) {}

  private get bootedAt(): string {
    return this.deps.bootedAt ?? BOOTED_AT;
  }

  /**
   * Find every piece of work orphaned by the previous run and park it for a
   * decision. Runs once at boot; no resume is attempted and nothing is buried.
   *
   * **Only a row that still claimed to be live is restamped** — leaving an
   * `interrupted` one alone is what preserves the crash / graceful-shutdown
   * distinction without a column. `endedAt` is stamped because the process really is
   * gone; null would leave the file-overlap detector treating it as eternally live.
   * The agentless arm writes nothing, but is still announced — a wedged origin is
   * otherwise silent.
   */
  detect(): OrphanedWork[] {
    const at = new Date().toISOString();
    for (const agent of this.deps.store.listAgents()) {
      const task = this.deps.store.getTask(agent.taskId);
      if (!isRecoveryCandidate(agent, task)) continue;
      // Already parked (an earlier boot), or ended cleanly and said so.
      if (agent.status === 'crashed' || agent.status === 'interrupted') continue;
      this.deps.store.updateAgent(agent.id, { status: 'crashed', endedAt: agent.endedAt ?? at, pid: null });
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
      this.deps.store.recordDecision({
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
    if (this.deps.store.readUpgradeIntent().state !== 'applying') return { restored, left: this.pending() };
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
      // A failed restore leaves the row as it was — same three choices — plus a
      // fault line saying why the automatic one did not take.
      left.push(item);
      this.deps.errors?.record({
        source: 'boot',
        message: `Could not restore ${item.taskId} after the upgrade: ${result.error}`,
        detail: item.originRef ?? null,
      });
    }
    return { restored, left };
  }

  /**
   * The outstanding decisions, derived from the rows rather than held in a field, so
   * a restart, a second cockpit and this process always agree. Arm one is an
   * orphaned agent (`crashed` or `interrupted`, task still outstanding); arm two is
   * an outstanding task with no agent row, created before this process booted. The
   * two cannot double-count — the second requires there to be no agent row.
   */
  pending(): OrphanedWork[] {
    const out: OrphanedWork[] = [];
    const staffed = new Set<string>();
    for (const agent of this.deps.store.listAgents()) staffed.add(agent.taskId);
    for (const agent of this.deps.store.listAgentsByStatus('crashed', 'interrupted')) {
      const task = this.deps.store.getTask(agent.taskId);
      if (!isRecoveryCandidate(agent, task) || !task) continue;
      out.push(
        describeOrphan(
          agent,
          task,
          restorability(agent, { resumable: this.deps.resumable, worktreeExists: existsSync(agent.cwd) }),
        ),
      );
    }
    for (const task of this.deps.store.listOutstandingTasks()) {
      if (!isAgentlessCandidate(task, { hasAgent: staffed.has(task.id), bootedAt: this.bootedAt })) continue;
      out.push(describeOrphan(null, task, restorability(null, { resumable: false, worktreeExists: false })));
    }
    return out;
  }

  /** How many decisions are outstanding — the harness's hold reads exactly this. */
  pendingCount(): number {
    return this.pending().length;
  }

  /**
   * The outstanding decision this agent belongs to, if it is one — the escalation
   * route refuses answers for those, and names the recovery item in the refusal.
   * Keyed on the agent because that is what an escalation carries; everything else
   * keys on the task.
   */
  pendingForAgent(agentId: string): OrphanedWork | null {
    return this.pending().find((p) => p.agentId === agentId) ?? null;
  }

  /**
   * Apply an operator's verdict. Returns a refusal rather than throwing when the
   * agent is not (or is no longer) awaiting one, so a double-click on a card the
   * other tab already settled reads as a 409 instead of a 500.
   */
  decide(taskId: string, verdict: RecoveryVerdict): RecoveryResult {
    const item = this.pending().find((p) => p.taskId === taskId);
    if (!item) return { ok: false, error: 'no orphaned work awaiting a recovery decision for this task id' };
    const agentId = item.agentId;
    const agent = agentId ? this.deps.store.getAgent(agentId) : null;
    const task = this.deps.store.getTask(item.taskId);
    if (!task || (agentId && !agent)) return { ok: false, error: 'agent or task no longer exists' };

    if (verdict === 'restore') {
      // Never restorable without an agent, and `restorability` said so in words the
      // operator has already read on the card.
      if (!item.restorable || !agent)
        return { ok: false, error: item.restoreBlocked ?? 'this work cannot be restored' };
      let resumed = false;
      try {
        resumed = this.deps.agents.resume(agent, task);
      } catch (err) {
        this.deps.errors?.record({ source: 'boot', message: `Crash restore failed: ${(err as Error).message}` });
        return { ok: false, error: `restore failed: ${(err as Error).message}` };
      }
      // A false return leaves the row `crashed`, which is the honest state: the
      // decision has not been applied, so the hold stands and requeue/remove are
      // still on the table.
      if (!resumed) return { ok: false, error: 'the runtime refused to resume this session' };
      return this.settled({
        verdict,
        agentId,
        taskId: task.id,
        detail: `Restored agent ${agentId} into its existing session and worktree`,
      });
    }

    // Both remaining verdicts end this work for good and share the teardown.
    // Settling the *task* is the load-bearing half: `interrupted` is what releases
    // the origin and the branch the `queued` row was holding shut.
    const at = new Date().toISOString();
    if (agent) {
      this.deps.store.updateAgent(agent.id, { status: 'interrupted', endedAt: agent.endedAt ?? at, pid: null });
      this.deps.escalations.dismissEscalationsForAgent(
        agent.id,
        verdict === 'requeue' ? 'agent crashed; work requeued' : 'agent crashed; work dropped',
      );
    }
    this.deps.store.updateTask(task.id, { status: 'interrupted' });

    if (verdict === 'remove')
      return this.settled({
        verdict,
        agentId,
        taskId: task.id,
        // The worktree is deliberately left alone, exactly as a failed or killed
        // agent's is: it is the only surviving record of what the run had done.
        detail: agent
          ? `Dropped agent ${agent.id} and its task; the worktree is kept for inspection`
          : `Dropped task ${task.id}, which no agent ever started; its origin and branch are free again`,
      });

    // A requeue of work that came from a job **still sitting in the queue** files
    // nothing: that job *is* the requeue. See {@link stillQueuedJobBehind}.
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
    const job = this.deps.store.createJob({
      title: request.title,
      prompt: request.prompt,
      kind: task.kind,
      branch: task.branch,
      // What the job stands in for. The dispatch is still keyed on `job:<id>`;
      // this is what keeps the world-driven rule that produced the original from
      // dispatching it a second time while the requeue is redoing it.
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

  /** Record the verdict in the audit log and hand it back. */
  private settled(outcome: RecoveryOutcome): RecoveryResult {
    this.deps.store.recordDecision({
      cycleId: RECOVERY_CYCLE,
      action: { type: 'no_op', reason: `crash recovery: ${outcome.verdict}` },
      outcome: 'executed',
      detail: outcome.detail,
    });
    return { ok: true, outcome };
  }
}

/**
 * The job this task was dispatched for, if that job is **still queued** — the one
 * case where a requeue must file nothing and hand the existing job back instead.
 * A job leaves the queue only after the spawn succeeds, so one still `queued`
 * means no agent ever ran and there is nothing to redo.
 *
 * Filing a second job there wedges the queue: its `originRef` is `job:<predecessor>`,
 * which puts N+1 in the standing set for N, so only the newest link of the chain is
 * ever tried and no older one can run or expire. A chain already in a database stays
 * locked until its newest link is cancelled. The `dispatched` case does file a real
 * job — there an agent ran and its work may be on the branch.
 */
function stillQueuedJobBehind(task: Task, store: Store): Job | null {
  const id = task.originRef?.startsWith('job:') ? task.originRef.slice('job:'.length) : null;
  if (!id) return null;
  const job = store.getJob(id);
  return job && job.status === 'queued' ? job : null;
}

/**
 * The audit-log cycle id every recovery decision is grouped under. Not the `human:`
 * prefix, which the cockpit's decision log resolves to a *proposal* id.
 */
const RECOVERY_CYCLE = 'crash-recovery';

/**
 * When this process started, read once at module load — module scope rather than a
 * construction timestamp because it must not drift between two desks in one
 * process. Fences the agentless arm off from this run's own in-flight dispatches.
 */
const BOOTED_AT = new Date().toISOString();
