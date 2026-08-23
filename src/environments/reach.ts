import type { EnvironmentReading, GoalEnvironmentReach, GoalLanding, Plan, PlanPart, WorkNode } from '../types.js';
import { partSettled } from '../plans/parts.js';
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
  /**
   * This goal's plan parts still owed a merge — from {@link partsOwed}. Work whose
   * commit does not exist yet is work no environment can be holding, and leaving it
   * out of the denominator is what let the first part of a four-part plan read as
   * the whole goal arriving.
   */
  outstanding: number;
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
 * **The denominator is the goal's work, not its merges.** A plan is cut into parts
 * up front and they merge one at a time, so counting only what has landed makes the
 * fraction whole on the day part one merges: the environment holding the first of
 * four parts reported `reached`, the goal's arrival was recorded, its comment went
 * out and its gates opened — all on a tenth of the feature. What has not merged is
 * counted too, and it counts as **`absent`, never `unresolved`**: nobody has to go
 * looking for a part that has no commit yet.
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
  const total = landings.length + input.unattributed + input.outstanding;
  return input.environments.map(({ name: environment, arrival }) => {
    const verdicts = readingsFor(input.readings, environment);
    let reached = 0;
    // Work still owed a merge starts the absent count rather than the unresolved
    // one: an unmerged part is not a question the probe could have answered.
    let absent = input.outstanding;
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
 * a row on every issue the graph has ever held would bury the ones that moved. That
 * is a rule about the **goal set**, and the parts a goal still owes do not widen it:
 * a plan whose first part has yet to merge has been nowhere, and the row would say
 * `0/4` on every environment from the day it was cut.
 *
 * The one exception is `held` — a goal a gate is holding **right now**. It earns a
 * row because it is held, not because it has been anywhere, and without the arm the
 * hold is drawn nowhere: the sentence and the release control both live inside the
 * card the empty list stops drawing. The goals a gate's escape hatch exists for are
 * exactly the ones with nothing to land (a docs change, a config change, work that
 * shipped from another repository), so the drop landed on precisely the goals the
 * control was written for — held forever, with both obligations withheld and the
 * goal reading as finished (#514). It cannot bury anything: a hold is non-null only
 * while a goal is delivered, ungated-through and unshortfalled.
 */
export function allGoalReach(input: {
  landings: GoalLanding[];
  readings: EnvironmentReading[];
  nodes: WorkNode[];
  landed: ReadonlySet<number>;
  /** Every plan, for {@link partsOwed} — the goal each belongs to is its `originRef`. */
  plans: Plan[];
  /** Every plan's parts, whichever plan they belong to; filtered per goal below. */
  parts: PlanPart[];
  environments: EnvironmentConfig[];
  /**
   * Goals an environment gate is holding right now, plus the ones an operator has
   * released from one — a row each, whatever they have landed. Both draw only
   * inside the card, so both need the row to exist.
   */
  held?: ReadonlySet<string>;
}): { goalRef: string; environments: GoalEnvironmentReach[] }[] {
  const goalRefs = new Set(input.landings.map((l) => l.goalRef));
  for (const node of input.nodes) if (node.kind === 'issue') goalRefs.add(node.ref);
  // A held goal need not be in either — a goal delivered by hand with nothing
  // merged is held by the gate and known to neither the landings nor a PR node.
  for (const goalRef of input.held ?? []) goalRefs.add(goalRef);
  const out: { goalRef: string; environments: GoalEnvironmentReach[] }[] = [];
  for (const goalRef of goalRefs) {
    const unattributed = unattributedMerges(goalRef, input.nodes, input.landed);
    if (unattributed === 0 && !input.landings.some((l) => l.goalRef === goalRef) && input.held?.has(goalRef) !== true)
      continue;
    const outstanding = partsOwed(goalRef, input.plans, input.parts);
    out.push({ goalRef, environments: goalReach({ ...input, goalRef, unattributed, outstanding }) });
  }
  return out;
}

/**
 * How much of a goal's planned work is still owed a merge — the parts that exist
 * as intent and not yet as a commit.
 *
 * Three exclusions, and each is the difference between a fraction that closes and
 * one that never does:
 *
 * - a **settled** part is done being owed. Its merge is already counted as a
 *   landing (or as an unattributed merge), so counting it here as well would put
 *   half a goal's work in the denominator twice;
 * - a **retired** part was un-planned by an amendment and is not work any more;
 * - a part expected to produce anything **other than code** never merges anything,
 *   so a report, a determination or a person's hand-check would sit in the
 *   denominator for good — the goal would read `partial` in an environment holding
 *   every commit it has, its arrival would never be recorded, its comment never
 *   posted and its gated obligations never filed. A goal held out of the bench for
 *   ever by a part with nothing to deploy is the expensive direction here, and it
 *   is silent: the card says `3/4` and looks like it is waiting for a deploy.
 *   → `docs/spec/24-environments.md#the-lens`
 *
 * An **abandoned** plan's parts are not owed either — the plan is the thing that
 * said they were work, and it has withdrawn the claim.
 */
function partsOwed(goalRef: string, plans: Plan[], parts: PlanPart[]): number {
  // `originRef` is the goal ref itself (`issue:12`), which is how every other
  // reader of a plan finds the goal it hangs off.
  const owning = new Set(plans.filter((p) => p.originRef === goalRef && p.status !== 'abandoned').map((p) => p.id));
  let owed = 0;
  for (const part of parts) {
    if (!owning.has(part.planId)) continue;
    if (part.status === 'retired' || partSettled(part)) continue;
    // Null reads as `code` — the planner leaving it unstated is the common case.
    if (part.expectedKind !== null && part.expectedKind !== 'code') continue;
    owed += 1;
  }
  return owed;
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
