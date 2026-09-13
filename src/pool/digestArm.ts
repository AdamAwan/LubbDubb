import { CAUSES_BY_KIND, GUARD_ORDER } from '../remedies/remedies.js';
import { isReturnOrigin } from '../insights/remedyInsights.js';
import { PHASE_ORDER, phaseOf, type SpendPhase } from '../insights/spendInsights.js';
import type { Store } from '../store/store.js';
import type {
  Agent,
  ErrorLogEntry,
  PoolDigestDocument,
  PrReplySent,
  PoolDigestRow,
  Remedy,
  SurfaceReach,
  UsageEvent,
  WorldEvent,
} from '../types.js';
import type { WorldScope } from '../integrations/registry.js';
import {
  poolableThroughputMeasures,
  THROUGHPUT_EVENT_KINDS,
  throughputMeasureOf,
} from '../insights/throughputInsights.js';
import { VERBS_BY_SUBJECT } from '../usage/events.js';
import { POOL_SCHEMA_VERSION } from './document.js';

// → docs/spec/28-cross-fleet-pool.md

export const POOL_RETENTION_DAYS = 90;

export function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

export function buildDigestDocument(
  store: Store,
  context: { fleetId: string; project: string; harnessVersion: string; now: string; scope: WorldScope },
): PoolDigestDocument {
  const since = retentionStart(context.now);
  const today = utcDay(context.now);
  const usage = store.agents.listUsageEventsSince(since);
  const agents = store.agents.listAgents();
  const tasks = store.tasks.listTasks();
  const remedies = store.remedies.listRemediesSince(since);

  const phaseOfAgent = new Map<string, SpendPhase>();
  const originOfTask = new Map(tasks.map((t) => [t.id, t.originRef]));
  for (const agent of agents) phaseOfAgent.set(agent.id, phaseOf(originOfTask.get(agent.taskId) ?? null));

  return {
    pool: POOL_SCHEMA_VERSION,
    kind: 'digest',
    fleetId: context.fleetId,
    project: context.project,
    publishedAt: context.now,
    harnessVersion: context.harnessVersion,
    byPhase: byPhase(usage, agents, phaseOfAgent, since, today),
    byCause: byCause(remedies, usage, today),
    byCheck: byCheck(remedies, usage, today),
    unaccounted: unaccounted(tasks, remedies, since, today),
    unmeasured: unmeasured(agents, since, today),
    byUsage: byUsage(store.surfaceReach.listSurfaceReachSince(since), today),
    poolableThroughput: [...poolableThroughputMeasures(context.scope)],
    byThroughput: byThroughput(
      store.world.listWorldEventsOfKindsSince(since, THROUGHPUT_EVENT_KINDS),
      store.prReplies.listPrRepliesSentSince(since),
      today,
    ),
    byFault: byFault(store.errors.listErrorsSince(since), today),
  };
}

function retentionStart(now: string): string {
  return new Date(new Date(now).getTime() - POOL_RETENTION_DAYS * 86_400_000).toISOString();
}

function byPhase(
  usage: readonly UsageEvent[],
  agents: readonly Agent[],
  phaseOfAgent: ReadonlyMap<string, SpendPhase>,
  since: string,
  today: string,
): PoolDigestRow[] {
  const rows = new Bucket();
  for (const event of usage) {
    rows.add(utcDay(event.at), phaseOfAgent.get(event.agentId) ?? 'other', { costUsd: event.costUsd });
  }
  for (const agent of agents) {
    if (unmeasuredRun(agent)) continue;
    const at = agent.endedAt ?? agent.startedAt;
    if (at < since) continue;
    rows.add(utcDay(at), phaseOfAgent.get(agent.id) ?? 'other', { count: 1 });
  }
  return rows.rows(today).filter((row) => PHASE_ORDER.includes(row.key as SpendPhase));
}

function byCause(remedies: readonly Remedy[], usage: readonly UsageEvent[], today: string): PoolDigestRow[] {
  const perAccount = costPerAccount(remedies, usage);
  const rows = new Bucket();
  for (const remedy of remedies) {
    if (!CAUSES_BY_KIND[remedy.kind].includes(remedy.cause) || !GUARD_ORDER.includes(remedy.guard)) continue;
    rows.add(utcDay(remedy.createdAt), `${remedy.kind}/${remedy.cause}/${remedy.guard}`, {
      count: 1,
      costUsd: perAccount.get(remedy.id) ?? 0,
    });
  }
  return rows.rows(today);
}

function byCheck(remedies: readonly Remedy[], usage: readonly UsageEvent[], today: string): PoolDigestRow[] {
  const perAccount = costPerAccount(remedies, usage);
  const rows = new Bucket();
  for (const remedy of remedies) {
    for (const name of new Set(remedy.checks)) {
      rows.add(utcDay(remedy.createdAt), name, { count: 1, costUsd: perAccount.get(remedy.id) ?? 0 });
    }
  }
  return rows.rows(today);
}

function unaccounted(
  tasks: readonly { id: string; originRef: string | null; createdAt: string }[],
  remedies: readonly Remedy[],
  since: string,
  today: string,
): PoolDigestRow[] {
  const accounted = new Set(remedies.map((r) => r.taskId));
  const rows = new Bucket();
  for (const task of tasks) {
    if (task.createdAt < since || !isReturnOrigin(task.originRef) || accounted.has(task.id)) continue;
    rows.add(utcDay(task.createdAt), '', { count: 1 });
  }
  return rows.rows(today);
}

function unmeasured(agents: readonly Agent[], since: string, today: string): PoolDigestRow[] {
  const rows = new Bucket();
  for (const agent of agents) {
    if (!unmeasuredRun(agent)) continue;
    const at = agent.endedAt ?? agent.startedAt;
    if (at < since) continue;
    rows.add(utcDay(at), '', { count: 1 });
  }
  return rows.rows(today);
}

function byUsage(reach: readonly SurfaceReach[], today: string): PoolDigestRow[] {
  const rows = new Bucket();
  for (const row of reach) {
    const verbs: readonly string[] = VERBS_BY_SUBJECT[row.subject] ?? [];
    if (!verbs.includes(row.verb)) continue;
    rows.add(utcDay(row.at), `${row.subject}.${row.verb}`, { count: 1 });
  }
  return rows.rows(today);
}

function byThroughput(events: readonly WorldEvent[], replies: readonly PrReplySent[], today: string): PoolDigestRow[] {
  const rows = new Bucket();
  for (const event of events) {
    const measure = throughputMeasureOf(event.kind);
    if (measure === null) continue;
    rows.add(utcDay(event.createdAt), measure, { count: 1 });
  }
  for (const reply of replies) rows.add(utcDay(reply.sentAt), 'reply-sent', { count: 1 });
  return rows.rows(today);
}

function byFault(errors: readonly ErrorLogEntry[], today: string): PoolDigestRow[] {
  const rows = new Bucket();
  for (const error of errors) rows.add(utcDay(error.createdAt), error.source, { count: 1 });
  return rows.rows(today);
}

function unmeasuredRun(agent: Agent): boolean {
  return agent.costUsd === null && agent.inputTokens === null && agent.outputTokens === null;
}

function costPerAccount(remedies: readonly Remedy[], usage: readonly UsageEvent[]): Map<string, number> {
  const filedBy = new Map<string, string[]>();
  for (const r of remedies) filedBy.set(r.agentId, [...(filedBy.get(r.agentId) ?? []), r.id]);
  const spend = new Map<string, number>();
  for (const event of usage) {
    if (!filedBy.has(event.agentId)) continue;
    spend.set(event.agentId, (spend.get(event.agentId) ?? 0) + event.costUsd);
  }
  const per = new Map<string, number>();
  for (const [agentId, ids] of filedBy) {
    const share = (spend.get(agentId) ?? 0) / ids.length;
    for (const id of ids) per.set(id, share);
  }
  return per;
}

class Bucket {
  private readonly cells = new Map<string, { day: string; key: string; count: number; costUsd: number | null }>();

  add(day: string, key: string, delta: { count?: number; costUsd?: number }): void {
    const id = `${day}\u0000${key}`;
    const cell = this.cells.get(id) ?? { day, key, count: 0, costUsd: null };
    cell.count += delta.count ?? 0;
    if (delta.costUsd !== undefined) cell.costUsd = (cell.costUsd ?? 0) + delta.costUsd;
    this.cells.set(id, cell);
  }

  rows(today: string): PoolDigestRow[] {
    return [...this.cells.values()]
      .sort((a, b) => a.day.localeCompare(b.day) || a.key.localeCompare(b.key))
      .map((cell) => ({
        day: cell.day,
        key: cell.key,
        count: cell.count,
        costUsd: cell.costUsd === null ? null : roundUsd(cell.costUsd),
        partial: cell.day === today,
      }));
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
