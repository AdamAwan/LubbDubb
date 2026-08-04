/**
 * Which standing verdicts about an issue may coexist, declared once (#222).
 *
 * Four tables record a verdict keyed on the same `issue:<n>` origin, and some
 * pairs contradict each other. That matrix used to be four half-rows, one
 * inline `DELETE` per writer, each explaining itself by pointing at the next —
 * so answering "may an issue carry a shortfall and a conclusion at once?" meant
 * reading three methods, and noticing which *omissions* were deliberate. An
 * absent `DELETE` said both "these may coexist" and "nobody considered this".
 *
 * Here it is one table, and every row is stated including the empty ones. Two
 * properties are what make this worth having over the prose:
 *
 * - **`Record<VerdictKind, …>`**, so a fifth verdict table is a compile error
 *   until its row is written. Getting a 5×5 matrix right by inspection is the
 *   thing that does not scale, and this codebase has added four of these tables
 *   in recent history.
 * - **The declaration is dependency-free** — no SQLite, no `Store` — so the test
 *   that walks it reads *this* rather than re-typing it, and a cell nobody
 *   thought to assert cannot exist.
 *
 * It states only which rows may *exist* together. Which one wins where two are
 * allowed to coexist is `resolveIssueConclusion`'s question, and stays there.
 */

/** The four verdicts an issue can carry, in the domain's own vocabulary. */
export type VerdictKind = 'conclusion' | 'delivery' | 'shortfall' | 'assay';

/** Every verdict kind, for callers that need to walk the matrix. */
export const VERDICT_KINDS = ['conclusion', 'delivery', 'shortfall', 'assay'] as const satisfies readonly VerdictKind[];

/**
 * The table each verdict lives in. The SQL identifier appears here once, so the
 * matrix below can be written in the domain vocabulary rather than in schema
 * names — and a rename is one edit rather than four scattered string literals.
 */
export const VERDICT_TABLES: Record<VerdictKind, string> = {
  conclusion: 'issue_conclusions',
  delivery: 'issue_deliveries',
  shortfall: 'issue_shortfalls',
  assay: 'issue_assays',
};

/**
 * Writing the key's verdict clears every verdict it lists, for that origin, in
 * the same transaction. An empty list is a statement — "these may honestly
 * coexist" — not an omission.
 *
 * The reasoning per row, which used to live in the writers' doc comments:
 *
 * - **conclusion → delivery.** Two answers to one question ("is this issue
 *   finished"), so one must win. The mirror of the delivery row below; without
 *   it, rule `work-item-back-to-pickup` returns the item to pickup while
 *   `deliveryHold` blocks it.
 * - **delivery → conclusion, shortfall.** The assessor is later and better
 *   informed than the agent that declared its own run, so it supersedes the
 *   conclusion. A shortfall is this row's direct contradiction — "worked, and
 *   not delivered" against "delivered" — so an assessment that changes its mind
 *   must not leave rule `issue-shortfall` proposing a replan for an issue this
 *   gate has just parked.
 * - **shortfall → delivery only.** The two polarities of one question, so the
 *   delivery goes. It deliberately does **not** clear a conclusion: that is the
 *   working agent's own statement about its own run, and overwriting it is
 *   precisely the bug the shortfall table was created to stop.
 *   `resolveIssueConclusion` ranks the two instead.
 * - **assay → nothing.** An assay answers a *different* question — whether the
 *   goal could be started from, not whether the work is finished — so an issue
 *   may honestly carry it alongside any of the other three.
 */
export const VERDICT_EXCLUSIONS: Record<VerdictKind, readonly VerdictKind[]> = {
  conclusion: ['delivery'],
  delivery: ['conclusion', 'shortfall'],
  shortfall: ['delivery'],
  assay: [],
};
