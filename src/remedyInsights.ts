import type { Remedy, RemedyCause, RemedyGuard, RemedyKind, UsageEvent } from './types.js';
import { roundUsd } from './issueSpend.js';
import { CAUSES_BY_KIND, CAUSE_COPY, GUARD_COPY, GUARD_ORDER } from './remedies/remedies.js';

/**
 * The Causes reading: why the fleet came back, folded from the accounts the
 * agents that came back wrote.
 *
 * The Yield panel already answers *how often* a pull request goes red and *what
 * it costs*; this is the half that says **why**, and it is deliberately the same
 * fortnight and the same dollars. Read together, one row says "eight reds on
 * `test (windows)`, $36" and the next says "all eight were the same flake" —
 * which is the difference between a number and a decision.
 *
 * ## Beside `reliabilityInsights`, not inside it
 *
 * The two folds share a window and a payload and nothing else. That one reads
 * agent rows, `pr_ci` world events and usage; this one reads a single table
 * written by one tool. Folding them together would put a 577-line module's state
 * machine and a group-by in one function for the sake of a shared constant, and
 * the constant is passed in instead.
 *
 * ## What the counts are counts of
 *
 * A remedy is one **account**, not one red and not one run. An agent that
 * answered four reds in one dispatch and says they were all the same flake files
 * one row; a pull request that went red four times over four days collects four.
 * So `accounts` is never comparable to `CiHealth.reds` and the panel must not
 * subtract one from the other — {@link RemedyInsights.unaccounted} is the honest
 * form of that question, and it is a count of *dispatches* with no account, which
 * is the thing an operator can actually chase.
 *
 * ## Money is divided, and the panel says so
 *
 * Cost is attributed by the **agent that filed the account**, split evenly across
 * the accounts it filed. One agent answering three unrelated reds genuinely spent
 * its money on all three and there is no reading that says which third went
 * where; dividing is the only claim the data supports, and it is stated on the
 * payload rather than assumed by the reader — the stance `CiSubject.costUsd`
 * already takes about cost per red.
 *
 * ## Derived, never stored
 *
 * Like every other insight fold: the `remedies` rows are already durable and
 * already dated, and a pre-summed table of causes would go stale the moment one
 * more was filed.
 */

/** How many rows the "lately" list carries. A ranking that says its own cap. */
const RECENT_ROWS = 12;

/** One cause's record inside the window, for one kind. */
export interface RemedyCauseTotal {
  cause: RemedyCause;
  label: string;
  blurb: string;
  /** Accounts naming this cause — not reds, and not runs. */
  accounts: number;
  costUsd: number;
  /** How many of these accounts said the fact was written down nowhere. */
  undocumented: number;
  /**
   * The check that appears on most of these accounts, and how many carry it.
   * Null for a review cause, and for a CI cause whose provider named no checks.
   * This is the row's one actionable detail: "twelve missed gates" is a statistic
   * and "twelve missed gates, nine of them `format:check`" is somewhere to go.
   */
  topCheck: { name: string; accounts: number } | null;
}

/** One kind's whole reading — the CI table, or the review one. */
export interface RemedyKindHealth {
  kind: RemedyKind;
  accounts: number;
  costUsd: number;
  /** Every cause the kind may name, in `CAUSES_BY_KIND` order, including the empty ones. */
  byCause: RemedyCauseTotal[];
}

/**
 * One guard's share of the whole window, across both kinds.
 *
 * Not exported: the cockpit reaches it as `RemedyInsights['byGuard']`, and an
 * export nothing names by name is what `knip` is set to `error` to catch.
 */
interface RemedyGuardTotal {
  guard: RemedyGuard;
  label: string;
  blurb: string;
  accounts: number;
  costUsd: number;
}

/** One account as the "lately" list draws it. */
export interface RemedyRow {
  id: string;
  kind: RemedyKind;
  /** `pr:<n>` — what the row links to. Not the dispatch origin: a reader wants the pull request. */
  ref: string;
  prNumber: number;
  cause: RemedyCause;
  causeLabel: string;
  guard: RemedyGuard;
  guardLabel: string;
  summary: string;
  checks: string[];
  at: string;
}

export interface RemedyInsights {
  /** Accounts filed inside the window, both kinds. */
  accounts: number;
  costUsd: number;
  /**
   * Dispatches that answered a red or a review inside the window and filed no
   * account at all. The panel's honesty figure: with this high, every share above
   * it is a share of a minority, and an operator reading a cause table without it
   * would take a partial record for the whole one.
   */
  unaccounted: number;
  byKind: RemedyKindHealth[];
  /** In {@link GUARD_ORDER} — cheapest thing to do about it first. */
  byGuard: RemedyGuardTotal[];
  /** The {@link RECENT_ROWS} most recent accounts, newest first. */
  recent: RemedyRow[];
}

interface RemedyInput {
  /** Every remedy filed inside the window, oldest first (`listRemediesSince`). */
  remedies: readonly Remedy[];
  /**
   * The task ids of the dispatches inside the window that were for a red or a
   * review — what {@link RemedyInsights.unaccounted} is counted over. Resolved by
   * the caller, which is the only place that can see the tasks.
   *
   * The **set**, not a count, because the two populations are windowed on
   * different dates: a dispatch is in on its `createdAt`, a remedy on the date it
   * was filed. Subtracting one count from the other let a dispatch created just
   * before the boundary that filed its account just after cancel a genuinely
   * unaccounted one — a figure moving in the direction that flatters the fleet.
   */
  returnDispatches: readonly string[];
  /** Dated cost deltas inside the same window. */
  usageEvents: readonly UsageEvent[];
}

export function buildRemedyInsights(input: RemedyInput): RemedyInsights {
  const { remedies } = input;
  const perAccount = costPerAccount(remedies, input.usageEvents);

  const byKind: RemedyKindHealth[] = (['ci', 'review'] as const).map((kind) => {
    const mine = remedies.filter((r) => r.kind === kind);
    return {
      kind,
      accounts: mine.length,
      costUsd: roundUsd(mine.reduce((sum, r) => sum + (perAccount.get(r.id) ?? 0), 0)),
      // Every cause the kind may name, empty ones included: a table that drew only
      // what happened cannot show that nothing was ever a flake, and "no flakes
      // this fortnight" is one of the more useful things it can say.
      byCause: CAUSES_BY_KIND[kind].map((cause) => {
        const rows = mine.filter((r) => r.cause === cause);
        return {
          cause,
          label: CAUSE_COPY[cause].label,
          blurb: CAUSE_COPY[cause].blurb,
          accounts: rows.length,
          costUsd: roundUsd(rows.reduce((sum, r) => sum + (perAccount.get(r.id) ?? 0), 0)),
          undocumented: rows.filter((r) => r.guard === 'undocumented').length,
          topCheck: topCheck(rows),
        };
      }),
    };
  });

  const byGuard: RemedyGuardTotal[] = GUARD_ORDER.map((guard) => {
    const rows = remedies.filter((r) => r.guard === guard);
    return {
      guard,
      label: GUARD_COPY[guard].label,
      blurb: GUARD_COPY[guard].blurb,
      accounts: rows.length,
      costUsd: roundUsd(rows.reduce((sum, r) => sum + (perAccount.get(r.id) ?? 0), 0)),
    };
  });

  return {
    accounts: remedies.length,
    costUsd: roundUsd([...perAccount.values()].reduce((sum, c) => sum + c, 0)),
    // Counted by membership: a dispatch with no account **at all**, which is what
    // the reading claims to be. Filing two accounts cannot take it below zero, so
    // no clamp is load-bearing here.
    unaccounted: unaccounted(input.returnDispatches, remedies),
    byKind,
    byGuard,
    recent: [...remedies]
      .reverse()
      .slice(0, RECENT_ROWS)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        ref: `pr:${r.prNumber}`,
        prNumber: r.prNumber,
        cause: r.cause,
        causeLabel: CAUSE_COPY[r.cause].label,
        guard: r.guard,
        guardLabel: GUARD_COPY[r.guard].label,
        summary: r.summary,
        checks: r.checks,
        at: r.createdAt,
      })),
  };
}

/**
 * What each account cost, by dividing its filing agent's spend evenly across the
 * accounts that agent filed.
 *
 * Only usage inside the window counts, for `ciCostUsd`'s reason: an agent that
 * started before it would otherwise drop its whole cost into a fortnight it
 * barely touched. An agent that reported no usage at all — PTY throughout, dead
 * before its first result — contributes nothing and its accounts are free, which
 * is the same silence the run half already reports as `unmeasuredRuns`.
 */
function costPerAccount(remedies: readonly Remedy[], usageEvents: readonly UsageEvent[]): Map<string, number> {
  const filedBy = new Map<string, string[]>();
  for (const r of remedies) filedBy.set(r.agentId, [...(filedBy.get(r.agentId) ?? []), r.id]);

  const spend = new Map<string, number>();
  for (const event of usageEvents) {
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

/** How many distinct dispatches filed at least one account. */
/**
 * In-window return dispatches that filed nothing.
 *
 * Membership rather than arithmetic, so an account filed inside the window by a
 * dispatch made before it accounts for *that* dispatch and for no other.
 */
/**
 * Whether a task was dispatched to answer a red or a review — the denominator
 * behind {@link RemedyInsights.unaccounted}.
 *
 * Read off the **origin** rather than off `Task.rule`, because the origin is what
 * `remedyOrigin` fences the tool on: counting by rule would make the denominator
 * and the numerator two different populations, and the gap between them would read
 * as agents failing to report when it was the two definitions disagreeing.
 *
 * Exported and living here rather than in the route that first needed it, because
 * the cross-fleet digest counts the same population per UTC day
 * (`src/pool/digestArm.ts`): two spellings of this predicate is how one fleet's own
 * Causes panel and its contribution to the company page come to describe two
 * different denominators, with both rendering perfectly.
 */
export function isReturnOrigin(originRef: string | null): boolean {
  return originRef !== null && /^pr:\d+:(ci|comments)$/.test(originRef);
}

function unaccounted(returnDispatches: readonly string[], remedies: readonly Remedy[]): number {
  const accounted = new Set(remedies.map((r) => r.taskId));
  return returnDispatches.filter((taskId) => !accounted.has(taskId)).length;
}

/**
 * The check named on most of these accounts.
 *
 * A remedy carries every check that was red when its agent was dispatched, so an
 * agent answering three reds at once contributes all three — the count is
 * therefore "accounts this check appears on", not "reds it caused", and the field
 * name says so. Ties go to the first in insertion order, which is the order the
 * provider listed them: an arbitrary tie broken by check name would read as a
 * ranking it is not.
 */
function topCheck(rows: readonly Remedy[]): { name: string; accounts: number } | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const name of new Set(row.checks)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best: { name: string; accounts: number } | null = null;
  for (const [name, accounts] of counts) {
    if (best === null || accounts > best.accounts) best = { name, accounts };
  }
  return best;
}
