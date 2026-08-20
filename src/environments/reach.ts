import type { EnvironmentReading, GoalEnvironmentReach, GoalLanding } from '../types.js';

/** Everything the fold reads, for one goal. */
interface GoalReachInput {
  goalRef: string;
  /** Every landing held — filtered to this goal here, so callers pass the store's list whole. */
  landings: GoalLanding[];
  readings: EnvironmentReading[];
  /** The configured environments, in the order the operator declared them. */
  environments: string[];
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
  return input.environments.map((environment) => {
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
    };
  });
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
