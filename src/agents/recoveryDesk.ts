import { existsSync } from 'node:fs';
import type { Store } from '../store/store.js';
import type { AgentManager } from './agentManager.js';
import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { Job } from '../types.js';
import {
  describeCrash,
  isRecoveryCandidate,
  requeueJobRequest,
  restorability,
  type CrashedAgent,
  type RecoveryVerdict,
} from './crashRecovery.js';

/** What a settled recovery did, for the API response and the audit line. */
interface RecoveryOutcome {
  verdict: RecoveryVerdict;
  agentId: string;
  taskId: string;
  detail: string;
  /** The job a `requeue` filed, so the cockpit can point at it. */
  job?: Job;
}

/** Either the verdict was applied, or it was refused with a reason the operator can act on. */
type RecoveryResult = { ok: true; outcome: RecoveryOutcome } | { ok: false; error: string };

/**
 * Where an agent orphaned by a crash or a shutdown waits for an operator's call.
 *
 * **The reason this exists is that the harness used to make the call itself.** The
 * old boot reconciler resumed every orphan it could and marked the rest
 * `interrupted`, then the boot cycle dispatched new work straight over the top.
 * Both outcomes are choices an operator has an opinion about — a resumed agent
 * carries on from a turn nobody has read, and an abandoned one silently drops work
 * that may have been minutes from a PR — and neither was ever put to anyone. Worse,
 * the harness went on staffing the fleet while its own model of that fleet was a
 * lie: rows saying `running` with no process behind them.
 *
 * So detection no longer decides. It marks each orphan `crashed` — a status that is
 * explicitly *not* live, so it stops counting toward the concurrency cap and stops
 * pretending in the cockpit — and the harness **holds every pulse** until the set is
 * empty (see {@link file://../harness.ts}). Nothing new is queued in front of a
 * decision about work already in flight, which is the whole point.
 *
 * **Why the pending set is durable but this class is not.** The set is the `crashed`
 * rows themselves, so it survives a second restart with no state here to persist and
 * no chance of the two disagreeing; {@link detect} is idempotent because a row that
 * is already `crashed` is already in the set. Contrast {@link PermissionDesk}, whose
 * pending calls are open sockets that genuinely die with the process. Each of the
 * three verdicts moves the row *out* of the candidate set — restore makes it live,
 * requeue and remove settle its task — so "already decided" needs no separate record.
 */
export class RecoveryDesk {
  constructor(
    private readonly deps: {
      store: Store;
      agents: AgentManager;
      escalations: EscalationInbox;
      /** Whether the configured runtime can `--resume` a session at all (PTY only). */
      resumable: boolean;
      errors?: ErrorRecorder;
    },
  ) {}

  /**
   * Find every agent orphaned by the previous run and park it for a decision.
   * Runs once at boot, **before** the heartbeat starts — though the hold does not
   * depend on that ordering, since the harness re-asks on every pulse.
   *
   * Marking the row is the whole of it: no resume is attempted, nothing is buried.
   * **Only a row that still claimed to be live is restamped** — an `interrupted`
   * one is already both non-live and honest about how it ended, and leaving it
   * alone is what preserves the crash / graceful-shutdown distinction without a
   * column to hold it. `endedAt` is stamped because the process really is gone,
   * and leaving it null would have the file-overlap detector treat a dead agent as
   * eternally live. A genuine crash also lands in the error log; a clean shutdown
   * does not, because nothing failed.
   */
  detect(): CrashedAgent[] {
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
    if (pending.length > 0)
      this.deps.store.recordDecision({
        cycleId: RECOVERY_CYCLE,
        action: { type: 'no_op', reason: 'crash recovery' },
        outcome: 'skipped',
        detail:
          `Holding the pulse: ${pending.length} agent(s) from the previous run need a recovery decision ` +
          `(${pending.map((p) => p.agentId).join(', ')})`,
      });
    return pending;
  }

  /**
   * The outstanding decisions, derived from the rows rather than held in a field —
   * so a restart, a second cockpit and this process always agree.
   *
   * Two statuses, for the two ways a run ends without an ending: `crashed` (the
   * process fell over) and `interrupted` (a clean shutdown). The task check is what
   * keeps a *decided* orphan out — both `requeue` and `remove` settle the task, so
   * an agent left `interrupted` by an earlier verdict is history, not a question.
   */
  pending(): CrashedAgent[] {
    const out: CrashedAgent[] = [];
    for (const agent of this.deps.store.listAgentsByStatus('crashed', 'interrupted')) {
      const task = this.deps.store.getTask(agent.taskId);
      if (!isRecoveryCandidate(agent, task) || !task) continue;
      out.push(
        describeCrash(
          agent,
          task,
          restorability(agent, { resumable: this.deps.resumable, worktreeExists: existsSync(agent.cwd) }),
        ),
      );
    }
    return out;
  }

  /** How many decisions are outstanding — the harness's hold reads exactly this. */
  pendingCount(): number {
    return this.pending().length;
  }

  /** Whether this agent is one of the outstanding decisions (the escalation route refuses answers for those). */
  isPending(agentId: string): boolean {
    return this.pending().some((p) => p.agentId === agentId);
  }

  /**
   * Apply an operator's verdict. Returns a refusal rather than throwing when the
   * agent is not (or is no longer) awaiting one, so a double-click on a card the
   * other tab already settled reads as a 409 instead of a 500.
   */
  decide(agentId: string, verdict: RecoveryVerdict): RecoveryResult {
    const item = this.pending().find((p) => p.agentId === agentId);
    if (!item) return { ok: false, error: 'no crashed agent awaiting a recovery decision for this id' };
    const agent = this.deps.store.getAgent(agentId);
    const task = this.deps.store.getTask(item.taskId);
    if (!agent || !task) return { ok: false, error: 'agent or task no longer exists' };

    if (verdict === 'restore') {
      if (!item.restorable) return { ok: false, error: item.restoreBlocked ?? 'this agent cannot be restored' };
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

    // Both remaining verdicts end this agent for good, so they share the teardown:
    // the row and its task are settled (which is also what keeps them out of the
    // next boot's candidate set) and the questions it left open are dismissed —
    // nobody can answer a dead agent, and the answer would route nowhere.
    const at = new Date().toISOString();
    this.deps.store.updateAgent(agentId, { status: 'interrupted', endedAt: agent.endedAt ?? at, pid: null });
    this.deps.store.updateTask(task.id, { status: 'interrupted' });
    this.deps.escalations.dismissEscalationsForAgent(
      agentId,
      verdict === 'requeue' ? 'agent crashed; work requeued' : 'agent crashed; work dropped',
    );

    if (verdict === 'remove')
      return this.settled({
        verdict,
        agentId,
        taskId: task.id,
        // The worktree is deliberately left alone, exactly as a failed or killed
        // agent's is: it is the only surviving record of what the run had done.
        detail: `Dropped agent ${agentId} and its task; the worktree is kept for inspection`,
      });

    const request = requeueJobRequest(agent, task);
    const job = this.deps.store.createJob({
      title: request.title,
      prompt: request.prompt,
      kind: task.kind,
      branch: task.branch,
    });
    return this.settled({
      verdict,
      agentId,
      taskId: task.id,
      detail: `Requeued the work of agent ${agentId} as job ${job.id}`,
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
 * The audit-log cycle id every recovery decision is grouped under — the same
 * device `agent-lifecycle` uses for bookkeeping that happens outside a pulse. Not
 * the `human:` prefix, which the cockpit's decision log resolves to a *proposal*
 * id; a recovery is settled by its own route, not through the proposal desk.
 */
const RECOVERY_CYCLE = 'crash-recovery';
