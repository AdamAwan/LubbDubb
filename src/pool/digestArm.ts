import { CAUSES_BY_KIND, GUARD_ORDER } from '../remedies/remedies.js';
import { isReturnOrigin } from '../remedyInsights.js';
import { PHASE_ORDER, phaseOf, type SpendPhase } from '../spendInsights.js';
import type { Store } from '../store/store.js';
import type { Agent, ErrorLogEntry, PoolDigestDocument, PoolDigestRow, Remedy, UsageEvent } from '../types.js';
import { POOL_SCHEMA_VERSION } from './document.js';

/**
 * The digest arm: ninety UTC days of what this fleet spent and what coming back to
 * a pull request cost it.
 *
 * **Nothing here measures anything new.** `src/spendInsights.ts` already partitions
 * spend by phase, `src/remedyInsights.ts` already folds why the fleet came back and
 * what it cost, and `src/remedies/remedies.ts` already holds the closed vocabularies
 * both are keyed by. This re-cuts what exists into UTC days and hands it to the
 * transport.
 *
 * Every dimension is a closed vocabulary that already exists, and none of them is a
 * provider identifier — except `byCheck`, which is a provider's own check name and
 * is therefore a **separate section** that only ever sums inside one project.
 *
 * → `docs/spec/28-cross-fleet-pool.md#the-digest-arm`
 */

/**
 * How far back the document reaches. **A stated constant and never a config key**:
 * an operator tuning it would be tuning the answer rather than the thing measured,
 * and two deployments' figures would stop being comparable — which is the one thing
 * a shared page exists to make them.
 *
 * Ninety days covers a quarter, which is the longest question anyone asks of a page
 * like this, and it bounds the document. The bound matters more than it looks:
 * unbounded, a fleet running two years publishes some seven hundred days against
 * every live key combination, republished hourly — a large file rewritten
 * twenty-four times a day, per fleet, forever, with nothing about it visible until
 * it is.
 *
 * **Stated limitation: the pool answers questions about the last ninety days and
 * nothing older.** A year-over-year reading is not available. On the `git` transport
 * the older rows do survive in commit history, and that is deliberately not part of
 * the contract — a service has no such history.
 */
export const POOL_RETENTION_DAYS = 90;

/**
 * The UTC day an instant falls in.
 *
 * **UTC, and this is the sharp edge of the digest.** Two fleets bucketing by local
 * midnight put one afternoon's work in two different days, and every company-wide
 * daily figure is then wrong by a sliver that nothing surfaces. Obvious once said,
 * invisible forever if not.
 */
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
    byFault: byFault(store.listErrorsSince(since), today),
  };
}

/** The earliest instant the document reaches, as an ISO string. */
function retentionStart(now: string): string {
  return new Date(new Date(now).getTime() - POOL_RETENTION_DAYS * 86_400_000).toISOString();
}

/**
 * Cost and runs per phase per day.
 *
 * **There is no separate total.** `PHASE_ORDER` includes `other`, so the phases
 * partition the fleet's spend and the total is their sum — a total shipped beside
 * them would be a second statement of one number, free to disagree with the one
 * that adds up.
 *
 * The money is bucketed on the **dated delta**, which is the only date a cost has
 * that is not a guess; a run is bucketed on the day it ended, which is the day
 * `src/spendInsights.ts` already windows one by.
 */
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

/**
 * Accounts and cost per `kind/cause/guard` per day.
 *
 * `RemedyCause` and `RemedyGuard` are resolved from the dispatch origin rather than
 * claimed, with the copy for every value in one place — so two fleets on two
 * providers produce comparable values by construction, and nobody had to agree on
 * anything.
 */
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
 * Accounts and cost per check name per day.
 *
 * **A normalised check bucket is refused.** Classifying every check into `lint` /
 * `unit` / `build` / `e2e` would let names cross projects, and it is rejected twice
 * over: it is a new measurement invented here rather than moved from what exists,
 * and it would be regex over provider names, silently misfiling every project whose
 * naming did not match whoever wrote the patterns.
 *
 * An account naming three reds contributes to all three, exactly as
 * `RemedyCauseTotal.topCheck` counts — so the figure is "accounts this check appears
 * on", never "reds it caused". The cost is **not** divided again between them: it is
 * the account's cost, and a reader summing this section is summing accounts, not
 * money that must add to the fleet's total.
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

/**
 * Return dispatches that filed no account, per day.
 *
 * **Not optional.** Without it every share is a share of a minority and reads as
 * authoritative once summed across nine fleets — `src/remedyInsights.ts` already
 * refuses to draw the causes without it, and a company page has no reason to be
 * held to a lower standard than one laptop's.
 *
 * Counted by **membership** rather than arithmetic, for the local fold's reason: a
 * dispatch created just before a day boundary that filed its account just after
 * must not cancel a genuinely unaccounted one.
 */
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

/**
 * Runs that reported no usage at all, per day.
 *
 * **Not optional either.** Without it, a fleet running on a PTY contributes real
 * work and no dollars and is drawn as a cheap fleet — and a window in which nothing
 * was measured answers null rather than `$0.00`, which is the same discipline one
 * level up.
 */
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
 * Faults per source per day.
 *
 * **The one section that measures the harness rather than the work**, and the only
 * one that carries no money: a fault has no cost figure anywhere in the harness, and
 * inventing one here would be a new measurement rather than a move of what exists.
 * `costUsd` therefore stays null on every row, which the companion draws as no
 * column at all — a column of dashes is worse than no column.
 *
 * The key is `ErrorLogEntry['source']` unchanged: five words, closed, and the same
 * five the Faults panel already draws, so nobody had to agree on a vocabulary and
 * there is no second spelling of one.
 *
 * **What it counts is the fault log as it stands, and the file says so.**
 * `Store.clearErrors` drops the whole table, so an operator who clears the log
 * republishes a fleet that had no faults this quarter. That is a reading and never a
 * trigger — nothing anywhere reads these rows back, and the section exists to be
 * read by a person in `digest.md`.
 */
function byFault(errors: readonly ErrorLogEntry[], today: string): PoolDigestRow[] {
  const rows = new Bucket();
  for (const error of errors) rows.add(utcDay(error.createdAt), error.source, { count: 1 });
  return rows.rows(today);
}

/** A run that reported nothing — PTY throughout, or dead before its first `result`. */
function unmeasuredRun(agent: Agent): boolean {
  return agent.costUsd === null && agent.inputTokens === null && agent.outputTokens === null;
}

/**
 * What each account cost: its filing agent's in-window spend divided evenly across
 * the accounts that agent filed.
 *
 * **The existing per-account figure**, and re-using it is the point — it is the only
 * claim the data supports, it is already what the local panel states, and a second
 * derivation here is how a fleet's contribution to the company page and its own
 * panel come to disagree. Kept local to this file rather than exported from
 * `src/remedyInsights.ts` would be the same figure computed twice; it is exported
 * from there for exactly that reason.
 */
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

/**
 * One section's rows as they accumulate, keyed on `(day, key)`.
 *
 * `costUsd` starts null and becomes a number only when something is actually added
 * to it, which is what keeps a day that measured nothing answering null rather than
 * `$0.00` — the digest's one rule that is easy to lose to a `?? 0` somewhere.
 */
class Bucket {
  private readonly cells = new Map<string, { day: string; key: string; count: number; costUsd: number | null }>();

  add(day: string, key: string, delta: { count?: number; costUsd?: number }): void {
    const id = `${day} ${key}`;
    const cell = this.cells.get(id) ?? { day, key, count: 0, costUsd: null };
    cell.count += delta.count ?? 0;
    if (delta.costUsd !== undefined) cell.costUsd = (cell.costUsd ?? 0) + delta.costUsd;
    this.cells.set(id, cell);
  }

  /**
   * The rows, sorted, with the origin's current day marked partial.
   *
   * **The current day is marked partial**, because otherwise every average on the
   * page is dragged down by a day that is not over — wrong by up to its whole width,
   * silently, on the newest and most-read number. Marked, the rule is one line: a
   * partial day counts in a total and never in an average.
   */
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
