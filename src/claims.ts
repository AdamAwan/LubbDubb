/**
 * Whether two agents wrote down the same claim.
 *
 * Written for `src/store/findings.ts`, and lifted out of it when `src/store/knowledge.ts`
 * needed the same answer (issue #27 phase 1). It is here rather than in either store
 * because it is a rule about **prose**, not about a table — SQLite has no opinion
 * about it, and a second copy tuned separately is the drift both stores exist to
 * avoid: a claim an operator dismissed as a finding and re-proposed as a fact must
 * look like the same sentence to both, or the rejection bar leaks.
 *
 * A domain module under `src/store/` may not reach a sibling (`test/storeModules.test.ts`),
 * which is the other half of why it sits up here: shared by two stores means owned
 * by neither.
 *
 * Pure — no I/O, no clock, no store.
 */

/**
 * A claim reduced to what it asserts: case, markdown emphasis, backticks, quotes
 * and punctuation dropped, whitespace collapsed. Two agents describing one
 * discovery rarely type the same string, but they very often type the same string
 * modulo exactly this — "`ingest.ts` buffers the whole body" and "ingest.ts
 * buffers the whole body." are one claim.
 */
export function claimKey(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The floor under whole-word containment. A very short key is a substring of far
 * too much, and a wrong merge is worse than a duplicate because it hides one
 * agent's report inside another's.
 */
const MIN_CONTAINMENT = 24;

/**
 * Whether two claim keys are the same claim.
 *
 * Equal, or one wholly contains the other — a restatement that appends its own
 * qualifier ("… on large uploads") is the same claim, and folding it in is the
 * point. {@link MIN_CONTAINMENT} is what keeps containment from being a
 * merge-everything rule.
 */
export function claimsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < MIN_CONTAINMENT) return false;
  // Padded, so containment lands on whole words: "rate limit" is not a claim
  // about "rate limiter" merely because one string sits inside the other.
  return ` ${long} `.includes(` ${short} `);
}
