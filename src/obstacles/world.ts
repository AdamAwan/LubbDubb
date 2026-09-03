import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import type { WorldSnapshot } from '../types.js';
import type { ObstacleWorld } from './keys.js';

/**
 * What the three gates are run against, assembled from what the harness already
 * holds.
 *
 * Nothing here asks a provider anything. The checks are the ones the world model
 * last read plus the ones this dispatch was made about, and the tree is the
 * checkout on disk — so a key is validated against a reading the harness is
 * already paying for, which is what keeps the intake a single round trip with no
 * model call and no waiting.
 * → `docs/spec/32-obstacles.md#where-a-key-comes-from`
 */
export function buildObstacleWorld(input: {
  /** Check names the provider is reporting, from the world baseline. */
  reported: readonly string[];
  /** The checks *this dispatch* is about — `Task.ciChecks`. */
  dispatchChecks: readonly string[];
  /** The files this dispatch's branch has touched. */
  branchPaths: readonly string[];
  /**
   * The checkout a `path` key is asked about. Null where the harness has none, and
   * then no path key validates — which drops keys rather than reports, exactly as
   * every other failed gate does.
   */
  repoRoot: string | null;
}): ObstacleWorld {
  const root = input.repoRoot;
  return {
    checks: [...new Set([...input.reported, ...input.dispatchChecks])],
    dispatchChecks: input.dispatchChecks,
    branchPaths: input.branchPaths,
    hasPath: (path) => root !== null && withinTree(path) && existsSync(join(root, path)),
  };
}

/**
 * A repository path, and nothing else.
 *
 * A key is a substring of what an agent wrote, so it can be anything at all — an
 * absolute path out of the checkout, a `..` walk, a URL. None of those is a fact
 * about *this* repository, and asking the filesystem about one would answer yes to
 * a key that identifies nothing here.
 */
function withinTree(path: string): boolean {
  if (path === '' || isAbsolute(path)) return false;
  const normalised = normalize(path);
  return !normalised.startsWith('..') && !normalised.includes('\0');
}

/**
 * Every check name the provider is reporting, off a reading of the world.
 *
 * The **validation** gate's set and nothing more: a `check` key must name a check
 * that exists somewhere rather than a phrase an agent wrote. Which of them a
 * report is *about* is a different question, asked of `Task.ciChecks` or of the
 * row's own keys, and the two are kept apart because a key that passes the first
 * and fails the second is a suggestion rather than nonsense.
 *
 * One reader for every door, so the intake, the harness's own voice and the model
 * desk cannot disagree about what the provider is reporting.
 */
export function reportedChecks(world: { pullRequests: WorldSnapshot['pullRequests'] } | null): string[] {
  return [...new Set((world?.pullRequests ?? []).flatMap((pr) => (pr.ciChecks ?? []).map((check) => check.name)))];
}
