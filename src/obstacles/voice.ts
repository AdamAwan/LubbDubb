import { basePrOf, newlyFailingChecks, recoveredOnSameCommit } from '../prHealth.js';
import type { CiCheck, PullRequest, WorldSnapshot } from '../types.js';

/**
 * The harness's own observation of the world, as the sightings it is prepared to
 * put its own name to.
 *
 * **The harness is one of the two voices.** Waiting for a second *agent* to notice
 * something the pulse is already watching is the fleet paying twice for a reading
 * it has, so an observation taken from the world counts on the same footing as a
 * goal and by the same rule — an independent party said it. It is the better
 * witness wherever it applies, because it is edge-triggered on a transition it
 * watches rather than on somebody happening to run into it.
 *
 * **The transition is the identity.** The same check going red once is one voice
 * however many pulses observe it still red: an operator reading why a row is
 * standing must never find one voice that is really the same reading counted
 * twice. That is why everything here is a comparison of two snapshots and never a
 * reading of one — a level-triggered *is it red now* would file the same
 * observation on every pulse for as long as the condition held, and
 * `Store.obstacleVoices` folds by transition precisely so it could not be counted.
 *
 * Pure over the pair, so both arms are testable without a store, a world or a
 * pulse — `diffWorlds`' shape, and for its reason. The two readings themselves are
 * `src/prHealth.ts`', shared with the knowledge notices rather than copied: a
 * second copy of a provider reading is a second thing to be wrong about.
 * → `docs/spec/32-obstacles.md#the-harness-is-a-voice`
 */

/** One thing the harness saw, in the shape the intake records any other sighting in. */
interface HarnessSighting {
  /**
   * What it saw, spelled so that two readings of one transition are one string.
   * It carries no pull request number for that reason: a base going red is one
   * transition however many rungs are stacked on it.
   */
  transition: string;
  /** The check the reading is about — the one key the report carries. */
  checkName: string;
  /** The claim, in the harness's own words and naming no goal. */
  what: string;
  /** What it read, and where. The sighting's own words, which an operator reads. */
  words: string;
}

/**
 * What the harness saw between these two snapshots that the fleet would otherwise
 * pay an agent's session to rediscover.
 *
 * Two transitions, and both are readings the harness already takes: a check going
 * red on a branch other pull requests are **based on**, and a check flapping
 * red-then-green on one `headSha`. Nothing here asks a provider anything it was
 * not already being asked.
 *
 * `prev` is null on the first pulse over a fresh store, and then nothing is seen
 * at all: every reading here is a comparison, and a single snapshot is not one.
 * A first pulse that filed sightings would report the whole world as news.
 */
export function harnessSightings(prev: WorldSnapshot | null, next: WorldSnapshot): HarnessSighting[] {
  if (!prev) return [];
  const before = new Map(prev.pullRequests.map((pr) => [pr.id, pr]));
  const seen = new Set<string>();
  const out: HarnessSighting[] = [];
  const push = (sighting: HarnessSighting): void => {
    // One sighting per transition per pass, and this is the collapse rather than a
    // tidying: two rungs stacked on one red base are two readings of **one**
    // transition, and filing both would be the same reading counted twice —
    // exactly what the count must never show. It is where the knowledge notices
    // deliberately do the opposite (there the rungs are the corroborators), which
    // is why this pass is its own and not a second arm of that one.
    if (seen.has(sighting.transition)) return;
    seen.add(sighting.transition);
    out.push(sighting);
  };
  for (const pr of next.pullRequests) {
    for (const check of recoveredOnSameCommit(before.get(pr.id), pr)) push(flakeSighting(pr, check));
    const base = basePrOf(pr, next.pullRequests);
    if (base) for (const check of newlyFailingChecks(before.get(base.id), base)) push(baseRedSighting(pr, base, check));
  }
  return out;
}

/**
 * A check that reported failing and then passing again on one commit.
 *
 * What was seen, and nothing about what to do with it. The conclusion an agent
 * draws — re-run it, look harder at the diff, read the job's logs — is the
 * agent's, and a sighting that drew it for them is how a real defect gets waved
 * through by a fleet that was told to expect a flake.
 *
 * The transition is the check and the commit, so a check that flaps twice on one
 * head is one voice and a flap on a later commit is a second reading of the world
 * rather than an echo of the first.
 */
function flakeSighting(pr: PullRequest, check: CiCheck): HarnessSighting {
  return {
    transition: `flake:${check.name}@${pr.headSha ?? ''}`,
    checkName: check.name,
    what:
      `The check \`${check.name}\` has reported failing and then passing again on the same commit, ` +
      `with nothing pushed in between.`,
    words:
      `The harness read \`${check.name}\` as failing on commit ${shortSha(pr.headSha)} of pr:${pr.number}, ` +
      `and as passing on that same commit at the next pulse. The pull request's head commit was ` +
      `unchanged between the two readings, so nothing was pushed between them.`,
  };
}

/**
 * A check red on a branch other pull requests are **based on**.
 *
 * The base is what makes a red check the fleet's problem rather than one pull
 * request's: red on a leaf holds up the goal that owns it, and red on a base holds
 * up everything stacked on it. `basePrOf` is the harness's one reading of that
 * relationship — the same one `redBaseChecks` opens the repair door on, so what
 * the harness says it saw and what the ownership desk calls *blocking the fleet
 * now* cannot drift.
 *
 * The transition names the check and the **base branch** and never the rung, which
 * is the whole of why two rungs are one voice. The words name the rung, where a
 * detail belongs that an operator reads and nothing counts.
 */
function baseRedSighting(rung: PullRequest, base: PullRequest, check: CiCheck): HarnessSighting {
  return {
    transition: `base-red:${check.name}@${base.branch}`,
    checkName: check.name,
    what:
      `The check \`${check.name}\` is failing on branch \`${base.branch}\`, which one or more open ` +
      `pull requests are based on.`,
    words:
      `The harness read \`${check.name}\` as failing on pr:${base.number}, whose branch \`${base.branch}\` ` +
      `is the base of pr:${rung.number}. It was not failing there on the previous pulse.`,
  };
}

/** Enough of a commit to recognise, in an operator's words. Never parsed by anything. */
function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : 'an unreported commit';
}
