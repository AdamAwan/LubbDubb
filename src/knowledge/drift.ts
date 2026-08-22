import { dispatchFactScopes } from './block.js';

/**
 * Whether a `check:` scope still names a check that runs (issue #27 phase 7).
 *
 * A check scope is the fragile axis, and its failure is silent in the worst way
 * available: a check name is a provider identifier, `dispatchFactScopes` matches
 * it exactly, and somebody renaming a job or adding a matrix dimension simply
 * stops the fact being delivered. Nothing errors. A claim scoped to
 * `test (windows)` after the job became `test (windows-latest)` sits on the
 * cockpit's page looking exactly like a claim that is being delivered and nobody
 * has needed. This is the only reading that can tell the two apart.
 *
 * ## Derived, never recorded
 *
 * Nothing writes a match, and nothing should. A recorder for a reading is a second
 * record that has to be kept true, and the failure this exists to surface is
 * *silent non-delivery* — which a recorder that quietly stopped writing would
 * reproduce rather than reveal, indistinguishably. So the evidence is what the
 * harness already holds:
 *
 * - **The dispatches it made**, through {@link dispatchFactScopes} itself rather
 *   than through a second reading of `task.ciChecks`. That function is the one
 *   spelling of what a dispatch matches, so the scopes this reads a fact against
 *   and the scopes that fact is actually delivered on cannot drift apart.
 * - **The checks the world reports right now.** This half is not optional: most
 *   checks are green most of the time and a green check is dispatched about
 *   never, so dispatch evidence alone would call almost every `check:` scope stale
 *   within a week. A check the provider is reporting on an open pull request is
 *   running, whatever the fleet has had to do about it.
 *
 * ## A reading and never a trigger
 *
 * Nothing is demoted, lapsed or dropped from a prompt because its scope went
 * quiet. A `check:` scope that matched nothing may be a check that is simply not
 * running this week — a release job, a nightly, a matrix leg behind a label — and
 * a rule that acted on this would delete the fleet's record of the checks it sees
 * least and understands worst. The contradiction ratio is the precedent: it counts
 * and it does not act.
 *
 * → `docs/spec/27-knowledge.md#scope--who-it-is-relevant-to`
 */

/** A dispatch, as this reads one — a structural subset of `TaskSummary`, so a row passes as one. */
interface DispatchRecord {
  originRef: string | null;
  ciChecks?: string[] | null;
  createdAt: string;
}

/** A pull request, as this reads one — a structural subset of `PullRequest`. */
interface ReportingPr {
  ciChecks?: { name: string; aliases?: string[] }[];
}

/** What the harness has seen of each check name, from the two records that hold it. */
interface CheckSightings {
  /** Check name to the most recent dispatch that carried it, ISO. */
  lastDispatched: Map<string, string>;
  /** Check names the provider is reporting on an open pull request *now*. */
  reported: Set<string>;
}

/**
 * Fold the two records into one lookup.
 *
 * Every task rather than the window's, because the answer wanted is *when a check
 * was last seen* and a lower bound would answer "not inside the window" for a
 * check last seen the day before it — which is the same string as never, and reads
 * as a check that never existed.
 */
export function checkSightings(
  dispatches: readonly DispatchRecord[],
  pullRequests: readonly ReportingPr[],
): CheckSightings {
  const lastDispatched = new Map<string, string>();
  for (const task of dispatches) {
    for (const scope of dispatchFactScopes(task.originRef, task.ciChecks ?? null)) {
      if (!scope.startsWith('check:')) continue;
      const name = scope.slice('check:'.length);
      const seen = lastDispatched.get(name);
      if (seen === undefined || task.createdAt > seen) lastDispatched.set(name, task.createdAt);
    }
  }
  const reported = new Set<string>();
  for (const pr of pullRequests) {
    for (const check of pr.ciChecks ?? []) {
      reported.add(check.name);
      // Aliases too: a provider that shows one check under two names would
      // otherwise have the fleet's claim about the name it does *not* report read
      // as a claim about a check that no longer runs. `ci.checks` matches an alias
      // exactly as it matches the name, and so does a scope written against one.
      for (const alias of check.aliases ?? []) reported.add(alias);
    }
  }
  return { lastDispatched, reported };
}

/** Whether one fact's scope has gone quiet, and the last thing that matched it. */
interface ScopeDrift {
  stale: boolean;
  /** The most recent dispatch that carried this check, or null if none ever has. */
  lastMatchedAt: string | null;
}

/**
 * The verdict for one fact, or `null` when its scope is not a check's.
 *
 * Three things keep it from crying wolf, and each is a case where a true "stale"
 * would be a lie:
 *
 * - **A check the world is reporting is not gone**, however long it is since a
 *   dispatch had to answer it.
 * - **A claim younger than the window cannot be stale**, because there has not
 *   been time for it to be. Without this, every `check:` claim filed today reads
 *   as drifted on a harness whose window is thirty days.
 * - **`staleDays` of zero turns the reading off**, which is how an operator who
 *   does not want it says so without anything being demoted to achieve it.
 */
export function checkScopeDrift(
  fact: { scope: string; createdAt: string },
  sightings: CheckSightings,
  opts: { now: number; staleDays: number },
): ScopeDrift | null {
  if (!fact.scope.startsWith('check:')) return null;
  const name = fact.scope.slice('check:'.length);
  const lastMatchedAt = sightings.lastDispatched.get(name) ?? null;
  if (opts.staleDays <= 0 || sightings.reported.has(name)) return { stale: false, lastMatchedAt };
  const cutoff = opts.now - opts.staleDays * 24 * 60 * 60 * 1000;
  const since = (at: string | null): boolean => at !== null && Date.parse(at) >= cutoff;
  return { stale: !since(lastMatchedAt) && !since(fact.createdAt), lastMatchedAt };
}
