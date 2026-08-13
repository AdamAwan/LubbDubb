import { join } from 'node:path';

/**
 * Where a goal's validation resources live: one directory per goal under
 * `validationRoot`, named for the goal's origin.
 *
 * Per goal rather than one flat root because a fixture is only meaningful
 * alongside the checks that use it — and because two goals may legitimately both
 * want a `fixture-repo.tar.gz`. The directory name comes off the origin ref the
 * whole harness already keys per-goal records on, so nothing has to be told which
 * goal a file belongs to.
 */
function validationGoalDir(root: string, originRef: string): string {
  // `issue:284` → `issue-284`. Every separator a ref can carry is folded, so a
  // ref shape added later cannot produce a nested path out of one segment.
  return join(root, originRef.replace(/[^A-Za-z0-9._-]+/g, '-'));
}

/**
 * The absolute path a named resource is expected at.
 *
 * The name is a file name and nothing else — `ResourceSchema` refuses separators
 * and `..`, which is what makes this join safe rather than something this
 * function has to re-check.
 */
export function validationResourcePath(root: string, originRef: string, name: string): string {
  return join(validationGoalDir(root, originRef), name);
}
