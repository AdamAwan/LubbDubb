/**
 * How a branch name becomes a directory name, in one place.
 *
 * The real manager and the fake each had their own copy — the fake's carrying the
 * comment "the real manager's own path rule, so a fake path is wrong in the same
 * ways", which is the coupling admitted in prose and left unenforced. It has to be
 * one function rather than two that agree, because the property the fake exists to
 * reproduce is a *collision*: `WorktreeManager.ensure` is reuse-first and two
 * branches can sanitize onto one directory, so a fake that mapped names even
 * slightly differently would stop reproducing the case the tests are there to pin.
 */
export function branchDirName(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]/g, '-');
}
