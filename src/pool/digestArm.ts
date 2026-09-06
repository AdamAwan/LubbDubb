import { CAUSES_BY_KIND, GUARD_ORDER } from '../remedies/remedies.js';
import { isReturnOrigin } from '../remedyInsights.js';
import { PHASE_ORDER, phaseOf, type SpendPhase } from '../spendInsights.js';
import type { Store } from '../store/store.js';
import type {
  Agent,
  ErrorLogEntry,
  PoolDigestDocument,
  PoolDigestRow,
  Remedy,
  SurfaceReach,
  UsageEvent,
} from '../types.js';
import { VERBS_BY_SUBJECT } from '../usage/events.js';
import { POOL_SCHEMA_VERSION } from './document.js';

/**
 * The digest arm: ninety UTC days of what this fleet spent and what coming back to a pull
 * request cost it. Nothing here measures anything new — it re-cuts what `src/spendInsights.ts`,
 * `src/remedyInsights.ts` and `src/usage/events.ts` already hold into UTC days. Every dimension
 * is an existing closed vocabulary, never a provider identifier, except `byCheck`, a provider's
 * own check name — a separate section that only ever sums inside one project.
 * → `docs/spec/28-cross-fleet-pool.md#the-digest-arm`
 */

/**
 * How far back the document reaches. A stated constant, never a config key: a tuned window
 * makes two deployments' figures incomparable, and it bounds the document, which would
 * otherwise be rewritten hourly at unbounded size. The pool answers nothing older than ninety
 * days; the `git` transport's commit history is not part of the contract.
 */
export const POOL_RETENTION_DAYS = 90;

/** The UTC day an instant falls in. UTC always: two fleets bucketing by local midnight split one afternoon across two days, silently corrupting a company-wide daily figure. */
export function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

/** This fleet's digest document, derived whole — {@link buildClaimsDocument}'s property, for its reason. */
export function buildDigestDocument(
  store: Store,
  context: { fleetId: string; project: string; harnessVersion: string; now: string },
): PoolDigestDocument {
  const since = retentionStart(context.now);
  const today = utcDay(context.now);
  const usage = store.listUsageEventsSince(since);
  const agents = store.listAgents();
  const tasks = store.listTasks();
  const remedies = store.listRemediesSince(since);

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
    byUsage: byUsage(store.listSurfaceReachSince(since), today),
    byFault: byFault(store.listErrorsSince(since), today),
  };
}

/** The earliest instant the document reaches, as an ISO string. */
function retentionStart(now: string): string {
  return new Date(new Date(now).getTime() - POOL_RETENTION_DAYS * 86_400_000).toISOString();
}

/** Cost and runs per phase per day. No separate total: `PHASE_ORDER` includes `other`, so the phases partition the spend and the total is their sum. Money bucketed on the dated delta, a run on the day it ended. */
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

/** Accounts and cost per `kind/cause/guard` per day. `RemedyCause` and `RemedyGuard` are resolved from the dispatch origin rather than claimed, so two fleets on two providers produce comparable values. */
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

/**
 * Accounts and cost per check name per day. A normalised check bucket is refused: it would be
 * regex over provider names, silently misfiling every project named otherwise. An account
 * naming three reds contributes to all three, so the figure is "accounts this check appears on",
 * never "reds it caused"; cost is not divided again between them, so this section sums accounts, not money.
 */
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

/** Return dispatches that filed no account, per day. Not optional — without it every share is a share of a minority that reads as authoritative. Counted by membership, so a dispatch straddling a day boundary can't cancel a genuinely unaccounted one. */
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

/** Runs that reported no usage at all, per day. Not optional: without it a PTY fleet contributes real work and no dollars and is drawn as cheap. A window that measured nothing answers null, never `$0.00`. */
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

/**
 * What a person did, per `subject.verb` per day — keyed on the registry's two closed axes.
 * The cockpit's place key stays local: a redesign moves it, and a cross-fleet series keyed
 * on it would break at a release. Only the `ui` half of the registry appears; a `record` event
 * is absent by declaration (`EVENT_SOURCE` says which and why), not by an omission that would
 * read as a fleet where nobody approved anything. → `docs/spec/34-usage-metrics.md#the-digest-section`
 * `costUsd` stays null on every row. A pair `VERBS_BY_SUBJECT` doesn't have is dropped.
 */
function byUsage(reach: readonly SurfaceReach[], today: string): PoolDigestRow[] {
  const rows = new Bucket();
  for (const row of reach) {
    const verbs: readonly string[] = VERBS_BY_SUBJECT[row.subject] ?? [];
    if (!verbs.includes(row.verb)) continue;
    rows.add(utcDay(row.at), `${row.subject}.${row.verb}`, { count: 1 });
  }
  return rows.rows(today);
}

/** Faults per source per day — the one section measuring the harness rather than the work, carrying no money. The key is `ErrorLogEntry['source']` unchanged. Counts the fault log as it stands: `Store.clearErrors` drops the table, so a cleared log republishes a quarter with no faults. */
function byFault(errors: readonly ErrorLogEntry[], today: string): PoolDigestRow[] {
  const rows = new Bucket();
  for (const error of errors) rows.add(utcDay(error.createdAt), error.source, { count: 1 });
  return rows.rows(today);
}

/** A run that reported nothing — PTY throughout, or dead before its first `result`. */
function unmeasuredRun(agent: Agent): boolean {
  return agent.costUsd === null && agent.inputTokens === null && agent.outputTokens === null;
}

/** What each account cost: its filing agent's in-window spend divided evenly across the accounts that agent filed — the existing per-account figure re-used, so the company page and local panel can't disagree. */
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

/** One section's rows as they accumulate, keyed on `(day, key)`. `costUsd` starts null and becomes a number only when something is added, so a day that measured nothing answers null rather than `$0.00`; do not `?? 0` it. */
class Bucket {
  private readonly cells = new Map<string, { day: string; key: string; count: number; costUsd: number | null }>();

  add(day: string, key: string, delta: { count?: number; costUsd?: number }): void {
    const id = `${day} ${key}`;
    const cell = this.cells.get(id) ?? { day, key, count: 0, costUsd: null };
    cell.count += delta.count ?? 0;
    if (delta.costUsd !== undefined) cell.costUsd = (cell.costUsd ?? 0) + delta.costUsd;
    this.cells.set(id, cell);
  }

  /** The rows, sorted, with the origin's current day marked partial — otherwise every average is silently dragged down by a day that is not over. A partial day counts in a total, never an average. */
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

/** Cents, matching every other money figure the harness ships. */
function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
