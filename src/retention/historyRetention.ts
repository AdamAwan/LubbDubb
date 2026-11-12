import type { ErrorRecorder } from '../errorLog.js';
import { DAY_MS } from '../primitives.js';
import type { Store } from '../store/store.js';

// → docs/spec/14-persistence.md#history-retention

export interface RetentionSweep {
  transcriptChunks: number;
  decisions: number;
  taskPrompts: number;
  batches: number;
  freePagesLeft: number;
}

interface HistoryRetentionDeps {
  store: Store;
  retentionDays: number;
  errors: ErrorRecorder;
  now?: () => number;
  batchRows?: number;
}

const BATCH_ROWS = 2000;

const TRANSCRIPT_BATCH_ROWS = 250;

const AGENT_PAGE = 200;

const VACUUM_PAGES = 256;

const EMPTY: RetentionSweep = { transcriptChunks: 0, decisions: 0, taskPrompts: 0, batches: 0, freePagesLeft: 0 };

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class HistoryRetentionDesk {
  private readonly now: () => number;
  private lastSweptAt: number | null = null;
  private running = false;

  constructor(private readonly deps: HistoryRetentionDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  get enabled(): boolean {
    return Number.isFinite(this.deps.retentionDays) && this.deps.retentionDays > 0;
  }

  run(): void {
    if (!this.enabled || this.running) return;
    const now = this.now();
    if (this.lastSweptAt !== null && now - this.lastSweptAt < DAY_MS) return;
    this.lastSweptAt = now;
    void this.sweep();
  }

  async sweep(): Promise<RetentionSweep> {
    if (!this.enabled || this.running) return { ...EMPTY };
    this.running = true;
    const tally = { ...EMPTY };
    try {
      await this.sweepAll(tally);
    } catch (err) {
      if (this.deps.store.open)
        this.deps.errors.record({
          source: 'cycle',
          message: `The history retention sweep failed: ${(err as Error).message}`,
          detail: (err as Error).stack ?? null,
        });
    } finally {
      this.running = false;
    }
    return tally;
  }

  private async sweepAll(tally: RetentionSweep): Promise<void> {
    const { store } = this.deps;
    const before = new Date(this.now() - this.deps.retentionDays * DAY_MS).toISOString();
    const held = this.held();
    const rows = this.deps.batchRows ?? BATCH_ROWS;
    const chunkRows = this.deps.batchRows ?? TRANSCRIPT_BATCH_ROWS;

    let after = '';
    for (;;) {
      if (!store.open) return;
      const ids = store.agents.listRetiredAgentIds({ before, ...held, after, limit: AGENT_PAGE });
      if (ids.length === 0) break;
      after = ids[ids.length - 1]!;
      for (;;) {
        if (!store.open) return;
        const gone = store.transcripts.deleteTranscripts(ids, chunkRows);
        if (gone === 0) break;
        tally.transcriptChunks += gone;
        tally.batches += 1;
        await nextTurn();
      }
    }
    tally.decisions = await this.batched(tally, () => store.decisions.pruneDecisions(before, rows));
    tally.taskPrompts = await this.batched(tally, () => store.tasks.compactTaskPrompts(before, held.heldTaskIds, rows));
    if (tally.batches > 0) tally.freePagesLeft = await this.reclaim();
  }

  private async batched(tally: RetentionSweep, step: () => number): Promise<number> {
    let total = 0;
    while (this.deps.store.open) {
      const done = step();
      if (done === 0) break;
      total += done;
      tally.batches += 1;
      await nextTurn();
    }
    return total;
  }

  private async reclaim(): Promise<number> {
    const { store } = this.deps;
    let left = Number.POSITIVE_INFINITY;
    while (store.open) {
      const now = store.reclaimFreePages(VACUUM_PAGES);
      if (now === 0 || now >= left) return now;
      left = now;
      await nextTurn();
    }
    return 0;
  }

  private held(): { heldTaskIds: string[]; heldAgentIds: string[] } {
    const { store } = this.deps;
    const tasks = new Set<string>();
    const agents = new Set<string>();
    for (const task of store.tasks.listOutstandingTasks()) {
      tasks.add(task.id);
      if (task.agentId !== null) agents.add(task.agentId);
    }
    for (const ejection of store.ejections.liveEjections()) {
      tasks.add(ejection.taskId);
      agents.add(ejection.agentId);
    }
    for (const escalation of store.escalations.listOpenEscalations())
      if (escalation.agentId !== null) agents.add(escalation.agentId);
    return { heldTaskIds: [...tasks], heldAgentIds: [...agents] };
  }
}
