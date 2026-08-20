import type { EnvironmentReading, GoalEnvironmentReach, GoalLanding, WorkNode } from '../types.js';
import { unattributedMerges } from './landings.js';
import type { EnvironmentConfig } from './policy.js';

/** Everything the fold reads, for one goal. */
interface GoalReachInput {
  goalRef: string;
  /** Every landing held — filtered to this goal here, so callers pass the store's list whole. */
  landings: GoalLanding[];
  readings: EnvironmentReading[];
  /** The configured environments, in the order the operator declared them. */
  environments: EnvironmentConfig[];
  /**
   * This goal's merged pull requests with no landing recorded — from
   * {@link unattributedMerges}. Non-zero is what turns an otherwise clean `absent`
   * into an `unknown`, and it is the whole reason this parameter exists.
   */
  unattributed: number;
}

/**
 * Where one goal stands in each environment.
 *
 * A read-only lens over stored rows, beside `src/graph/` and `prAttention.ts` and
 * deliberately not in `src/dispatcher/`: a rule consulting it would be a second
 * opinion about a decision made elsewhere. → `docs/spec/24-environments.md#the-lens`
 *
 * The fold is a count, and the interesting value is `partial`. A goal is several
 * pull requests, they land separately, and a release cut between two of them puts
 * half a feature in production — a boolean rollup calls that "shipped".
 *
 * **`unknown` beats `absent`.** Nothing here may report work as not-deployed on the
 * strength of a probe that could not answer, or a merge whose commit nobody caught:
 * the two states read identically on the glass and only one of them is a reason to
 * go looking. So a goal with nothing confirmed and anything unaccounted for is
 * `unknown`, and `absent` is reserved for the case where every one of its landings
 * was asked and every answer was no.
 */
export function goalReach(input: GoalReachInput): GoalEnvironmentReach[] {
  const landings = input.landings.filter((l) => l.goalRef === input.goalRef);
  const total = landings.length + input.unattributed;
  return input.environments.map(({ name: environment, arrival }) => {
    const verdicts = readingsFor(input.readings, environment);
    let reached = 0;
    let absent = 0;
    let latest: string | null = null;
    for (const landing of landings) {
      const reading = verdicts.get(landing.sha);
      if (reading?.status === 'reached') {
        reached += 1;
        // The whole goal arrived when its *last* landing did, so the moment to
        // report is the newest of the readings, not the first one to come back.
        if (latest === null || reading.observedAt > latest) latest = reading.observedAt;
      } else if (reading?.status === 'absent') absent += 1;
    }
    const unresolved = total - reached - absent;
    return {
      environment,
      status: rollUp({ total, reached, unresolved }),
      landed: reached,
      total,
      at: reached === total && total > 0 ? latest : null,
      // Carried onto the row rather than looked up beside it, so the cockpit can
      // say why a goal's bench rows are waiting without a second copy of the
      // operator's configuration to disagree with this one.
      opens: arrival?.opens ?? [],
    };
  });
}

/**
 * Every goal worth a row, folded — the landings' goals plus the work graph's, and
 * the one place that set is decided.
 *
 * Shared by the cockpit's panel and by the desk that records arrivals, because
 * two folds of "which goals has this been anywhere" would be two answers to the
 * question the comment on a ticket is posted off. The goal set comes from the
 * landings and the graph and **never from the world**: a goal is at its most
 * interesting here once its ticket has closed, which is precisely when the world
 * stops listing it.
 *
 * A goal with nothing merged is dropped rather than drawn as `absent` everywhere:
 * a row on every issue the graph has ever held would bury the ones that moved.
 */
export function allGoalReach(input: {
  landings: GoalLanding[];
  readings: EnvironmentReading[];
  nodes: WorkNode[];
  landed: ReadonlySet<number>;
  environments: EnvironmentConfig[];
}): { goalRef: string; environments: GoalEnvironmentReach[] }[] {
  const goalRefs = new Set(input.landings.map((l) => l.goalRef));
  for (const node of input.nodes) if (node.kind === 'issue') goalRefs.add(node.ref);
  const out: { goalRef: string; environments: GoalEnvironmentReach[] }[] = [];
  for (const goalRef of goalRefs) {
    const unattributed = unattributedMerges(goalRef, input.nodes, input.landed);
    if (unattributed === 0 && !input.landings.some((l) => l.goalRef === goalRef)) continue;
    out.push({ goalRef, environments: goalReach({ ...input, goalRef, unattributed }) });
  }
  return out;
}

function rollUp(counts: { total: number; reached: number; unresolved: number }): GoalEnvironmentReach['status'] {
  // A goal with nothing behind it at all has not been anywhere, and saying so is
  // not a guess: there is no merge to be uncertain about.
  if (counts.total === 0) return 'absent';
  if (counts.reached === counts.total) return 'reached';
  // Something confirmed there outranks the rest: half of it is *in* the
  // environment, whatever is unresolved about the other half.
  if (counts.reached > 0) return 'partial';
  return counts.unresolved > 0 ? 'unknown' : 'absent';
}

function readingsFor(readings: EnvironmentReading[], environment: string): Map<string, EnvironmentReading> {
  const out = new Map<string, EnvironmentReading>();
  for (const r of readings) if (r.environment === environment) out.set(r.sha, r);
  return out;
}
