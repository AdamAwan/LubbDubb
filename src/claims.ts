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

/**
 * The words a claim is *made of* rather than *about*, dropped before two claims
 * are compared for likeness.
 *
 * Two agents describing one wall write two sentences that share almost none of
 * their function words in the same places and most of their content words
 * somewhere — so an overlap taken over everything is an overlap dominated by
 * *the*, *is* and *a*, which every claim in the store shares with every other.
 * Closed and small, like every other word list in this repository: each entry is
 * a word two claims may differ by and still be called one claim.
 */
const NOISE = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'but',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'in',
  'is',
  'it',
  'its',
  'not',
  'of',
  'on',
  'or',
  'so',
  'that',
  'the',
  'their',
  'then',
  'there',
  'this',
  'to',
  'was',
  'were',
  'when',
  'which',
  'will',
  'with',
  'you',
  'your',
]);

/**
 * The fewest content words a claim must have before it may be called *like*
 * anything.
 *
 * {@link MIN_CONTAINMENT}'s argument, in the other matcher's terms: a claim of
 * three words overlaps far too much, and a suggested merge that is wrong is worse
 * than a duplicate because it offers to hide one agent's report inside another's.
 */
const MIN_TOKENS = 5;

/**
 * How alike two claim keys are: twice the shared content words over the two
 * counts, from `0` (nothing in common) to `1` (the same words).
 *
 * Dice rather than Jaccard because a restatement that says more is still the same
 * claim, and Jaccard punishes the longer sentence for the words it added — which
 * is exactly the agent whose call is most worth folding in.
 *
 * @see claimsSimilar for what this score is allowed to decide, which is nothing.
 */
export function claimOverlap(a: string, b: string): number {
  const left = new Set(a.split(' ').filter((word) => word.length > 2 && !NOISE.has(word)));
  const right = new Set(b.split(' ').filter((word) => word.length > 2 && !NOISE.has(word)));
  if (left.size < MIN_TOKENS || right.size < MIN_TOKENS) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/**
 * The floor a pair has to clear to be *suggested* as one claim.
 *
 * High, and deliberately so: what this costs when it is too low is an operator
 * shown a page of clusters that are not clusters, who stops reading them — which
 * is the same failure `knowledgeScopeStaleDays` is set wide to avoid, arriving
 * from the other direction.
 */
const MIN_SIMILARITY = 0.6;

/**
 * Whether two claim keys are worth **suggesting** are one claim — and it decides
 * nothing at all.
 *
 * **This is not {@link claimsMatch} and must never become it.** That one is
 * strict, and it is what `proposeFact` joins on and what the rejection bar is
 * enforced by; loosening it would widen the bar by exactly what it gained in
 * agreement, so a claim nobody has rejected would be refused by name, the agent
 * could not argue, and the operator would be told nothing at all. Two functions,
 * one strict and one advisory, is what keeps a suggestion from being enforcement —
 * and `test/claims.test.ts` holds `proposeFact` and the bar against the strict one
 * so a merge of the two fails rather than passes.
 *
 * What this one answers is a question nobody is bound by: *do these look like one
 * claim to a machine?* The pass that asks it writes rows to
 * `knowledge_similarities`, the page draws a cluster, and an **operator's click**
 * is what moves a claim. A wrong merge is worse than a duplicate because it hides
 * one agent's report inside another's, and a merge nobody approved is a wrong
 * merge nobody can see. → `docs/spec/27-knowledge.md#one-claim-written-two-ways`
 */
export function claimsSimilar(a: string, b: string): boolean {
  if (a === b) return false;
  return claimOverlap(a, b) >= MIN_SIMILARITY;
}
