import type { Agent, TaskSummary } from './types.js';
import { roundUsd } from './issueSpend.js';
import { DISPATCH_RULES, type DispatchRuleId } from './dispatcher/rules.js';

/**
 * What each *kind* of work costs, and what each failing check costs.
 *
 * The phase split (`src/spendInsights.ts`) answers where money went at the
 * coarsest useful grain — deliberation, build, CI, landing. This is the grain
 * below it, and it exists because the operator's question is not "what does
 * landing cost" but **"what is `dotnet test` costing me, and what are review
 * comments costing me"**. A phase cannot answer either: one folds every check
 * into a single figure, and the other is half of `landing`.
 *
 * Two readings, and they are deliberately different shapes:
 *
 * - **By task type** — cost per dispatch rule, off `Task.rule`. A partition of
 *   every measured run: each run had one rule (or none), so the rows sum to the
 *   fleet. This is the one that gives review comments a number of their own.
 * - **By check** — cost per CI check name, off `Task.ciChecks`. *Not* a
 *   partition in the same clean way, because one agent is dispatched for several
 *   red checks at once — see {@link CheckSpend.costUsd}.
 *
 * ## Why this reads columns rather than sentences
 *
 * `dispatchReason` names the failing checks too, in prose
 * (`ciDispatchReason`). Nothing here reads it. That is the same rule
 * `worldDiff.ciStatusOf` keeps and for the same reason: a reader that
 * re-derives a format reports zero, silently, the first time the wording
 * changes — and a spend table that quietly reads `$0.00` is worse than one that
 * is missing. The prose is parsed exactly once, by the boot backfill in
 * `src/store/tasks.ts`, and never on a read.
 *
 * ## Derived, never stored
 *
 * For the rest of the spend module's reason: the money is already durable on the
 * `agents` rows, and the kind is already durable on the `tasks` rows. A table of
 * pre-summed totals would be a copy that goes stale the moment a turn reports.
 */

/** How many rows each ranking carries. Both are rankings, and both say the cap out loud. */
const TOP_ROWS = 15;

/** One kind of work, priced. */
export interface TaskTypeSpend {
  /** The `DISPATCH_RULES` id, or `null` for runs dispatched outside any rule. */
  rule: string | null;
  /** The rule's own name from the registry — never a second vocabulary. */
  label: string;
  /** The registry's standing rationale, so a row can explain itself in a tooltip. */
  description: string | null;
  costUsd: number;
  runs: number;
  /** `costUsd / runs` — what one of these typically costs to answer. */
  perRunUsd: number;
}

/**
 * One CI check, priced by what the fleet spent answering it.
 *
 * Not exported: the cockpit reaches it as `ChecksSpend['checks']`, and an export
 * nothing names by name is what `knip` is set to `error` to catch.
 */
interface CheckSpend {
  /** The check as its provider names it: `dotnet test`, `Qodana`. */
  name: string;
  /**
   * This check's share of the CI money.
   *
   * **Split evenly across the checks a run was dispatched for.** One agent sent
   * at a PR that is red on `dotnet test` and `Qodana` answers both, and there is
   * no signal anywhere in the harness saying which of them it actually spent its
   * turns on. Splitting keeps the column a partition — the rows sum to
   * {@link ChecksSpend.attributedCostUsd}, so the table cannot overstate what was
   * spent. Charging each check the whole run would read better per row and add
   * up to more money than exists.
   */
  costUsd: number;
  /** Runs dispatched for this check — including the ones that answered others too. */
  runs: number;
  /** Runs where this check was the *only* one red, so the cost is unshared. */
  soleRuns: number;
  /** `costUsd / runs` — the share-weighted cost of one dispatch against this check. */
  perRunUsd: number;
  /** When this check last cost anything. */
  lastAt: string | null;
}

export interface ChecksSpend {
  /** Costliest check first. */
  checks: CheckSpend[];
  /** How many distinct checks were seen, so the {@link TOP_ROWS} cap can be stated. */
  seen: number;
  /** The money the rows above divide between them. */
  attributedCostUsd: number;
  /**
   * CI money on runs that named no check — a provider reporting no per-check
   * detail, or a historical row the backfill could not place.
   *
   * Shipped rather than dropped, for `unattributedCostUsd`'s reason exactly: the
   * per-check figures read as a partition of CI spend, and a silently discarded
   * remainder would let them look complete while a provider that reports nothing
   * quietly landed nowhere.
   */
  unnamedCostUsd: number;
}

interface TaskTypeInput {
  agents: readonly Agent[];
  tasks: readonly TaskSummary[];
}

/** A rule's display name and rationale, or a rendering of an id the registry has lost. */
function copyOf(rule: string | null): { label: string; description: string | null } {
  if (rule === null) {
    return { label: 'No rule', description: 'Dispatched outside the pulse — an accepted proposal, or agent lifecycle' };
  }
  const known = DISPATCH_RULES[rule as DispatchRuleId] as { name: string; description: string } | undefined;
  // An id the registry no longer carries is rendered as itself rather than
  // dropped or folded into "no rule": a rule renamed last month must show up as
  // a row an operator can ask about, not vanish from the bill.
  return known === undefined
    ? { label: rule, description: null }
    : { label: known.name, description: known.description };
}

/**
 * What each kind of work has cost, all-time, costliest first.
 *
 * A partition of every measured run: an agent has exactly one task, a task has
 * at most one rule, and the `null` rule is a row rather than a silence.
 */
export function rollUpTaskTypes(input: TaskTypeInput): TaskTypeSpend[] {
  const taskOf = new Map(input.tasks.map((t) => [t.id, t]));
  const byRule = new Map<string | null, TaskTypeSpend>();

  for (const agent of input.agents) {
    // The same silence the rest of the spend module keeps: a run that reported
    // nothing is unmeasured, not free, and appears in no figure.
    if (agent.costUsd === null && agent.inputTokens === null && agent.outputTokens === null) continue;
    const rule = taskOf.get(agent.taskId)?.rule ?? null;
    const row = byRule.get(rule) ?? { rule, ...copyOf(rule), costUsd: 0, runs: 0, perRunUsd: 0 };
    row.costUsd = roundUsd(row.costUsd + (agent.costUsd ?? 0));
    row.runs += 1;
    byRule.set(rule, row);
  }

  return [...byRule.values()]
    .map((row) => ({ ...row, perRunUsd: roundUsd(row.costUsd / row.runs) }))
    .sort((a, b) => b.costUsd - a.costUsd || a.label.localeCompare(b.label));
}

/**
 * What each CI check has cost the fleet to answer, costliest first.
 *
 * Reads `Task.ciChecks`, which only the two CI rules set — so a run that was
 * never about a named check contributes to neither the rows nor
 * {@link ChecksSpend.unnamedCostUsd}. That figure is about *CI* runs with no
 * detail, which is the caveat worth stating; a build agent is simply not this
 * table's subject.
 */
export function rollUpChecks(input: TaskTypeInput): ChecksSpend {
  const taskOf = new Map(input.tasks.map((t) => [t.id, t]));
  const byCheck = new Map<string, CheckSpend>();
  let attributedCostUsd = 0;
  let unnamedCostUsd = 0;

  for (const agent of input.agents) {
    if (agent.costUsd === null && agent.inputTokens === null && agent.outputTokens === null) continue;
    const task = taskOf.get(agent.taskId);
    // Only the CI rules record checks, so the rule is what says whether this run
    // is in scope at all — never the presence of the array, which would make a
    // provider reporting no detail indistinguishable from a build agent.
    if (task === undefined || (task.rule !== 'pr-ci-failing' && task.rule !== 'pr-ci-gate')) continue;
    const cost = agent.costUsd ?? 0;
    const names = task.ciChecks ?? null;
    if (names === null || names.length === 0) {
      unnamedCostUsd = roundUsd(unnamedCostUsd + cost);
      continue;
    }

    attributedCostUsd = roundUsd(attributedCostUsd + cost);
    const share = cost / names.length;
    const at = agent.endedAt ?? agent.startedAt;
    for (const name of names) {
      const row = byCheck.get(name) ?? { name, costUsd: 0, runs: 0, soleRuns: 0, perRunUsd: 0, lastAt: null };
      row.costUsd = roundUsd(row.costUsd + share);
      row.runs += 1;
      if (names.length === 1) row.soleRuns += 1;
      if (row.lastAt === null || at > row.lastAt) row.lastAt = at;
      byCheck.set(name, row);
    }
  }

  const ranked = [...byCheck.values()]
    .map((row) => ({ ...row, perRunUsd: roundUsd(row.costUsd / row.runs) }))
    .sort((a, b) => b.costUsd - a.costUsd || a.name.localeCompare(b.name));

  return {
    checks: ranked.slice(0, TOP_ROWS),
    seen: ranked.length,
    attributedCostUsd,
    unnamedCostUsd,
  };
}
