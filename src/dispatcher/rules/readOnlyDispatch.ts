/**
 * The dispatch half of a **read-only checkout** (issue #396) — the fields a rule
 * that only needs to *read* the repository puts on its action, in one place.
 *
 * Three rules dispatch a code agent whose prompt tells it not to commit or push
 * anything: `issue-appraisal` ("do not implement anything, do not open a pull request"),
 * `issue-assess` ("do not implement anything and do not open a pull request") and
 * `validate-check` ("this is not a branch to build on"). All three are cut from the
 * default branch for one reason each says out loud — the state they are asked about
 * is *on* it. They need a repository. None of them needs a branch.
 *
 * Each used to mint one anyway, and nothing ever reaped it: `reapableBranches`
 * deletes the branch of a **merged** pull request and refuses everything else, so a
 * ref that never gets a pull request is never merged and never deleted. One per
 * appraisal, per assessment and per check, for the life of the deployment.
 *
 * **Why a helper rather than the same literal three times.** The failure this shape
 * exists to end is silent in both directions: a rule that stops asking for a
 * read-only checkout goes back to minting a ref nobody will collect, and no test
 * that is not looking for it goes red. One spelling means there is one thing to
 * read, and `test/readOnlyCheckout.test.ts` asserts all three rules produce it.
 */
export function readOnlyDispatch(name: string, of: string): { branch: string; base: string; readOnly: true } {
  return { branch: name, base: of, readOnly: true };
}
