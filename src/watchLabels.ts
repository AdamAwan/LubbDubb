/**
 * The one label model behind the cockpit's watch toggle, shared by PRs and issues.
 * An operator configures a single `labelPrefix` (e.g. `"lubbdubb"`); from it we
 * derive the one label the toggle writes and the gates read:
 *
 * - `${prefix}-watch` — "work this"
 *
 * There is no second tag and no third state. **Untagged means unwatched**, on every
 * item type: work is opt-in, and the harness tags the pull requests it opens itself
 * (`src/prWatch.ts`) so its own work is watched without anybody clicking anything.
 * An operator's un-watch is therefore the removal of a tag, which nothing writes
 * back — the one shape in which "leave this alone" cannot be argued with.
 *
 * This replaced a `${prefix}-ignore` tag and the three readings that came with it.
 * Both are still legible: an item carrying the old ignore tag carries no watch tag,
 * so it stays unworked, and nothing has to be migrated. The harness simply does not
 * read `-ignore` any more.
 */

/**
 * Derive the watch label from the operator's prefix. An empty prefix yields an empty
 * label, which the gates read as "feature off" — everything is watched, PRs and
 * issues alike. That is the escape hatch tests use to exercise dispatch mechanics
 * without the opt-in gate.
 */
export function watchLabelFor(prefix: string): string {
  return prefix ? `${prefix}-watch` : '';
}

/**
 * The whole of the gate: does this item carry the watch tag? Total — never throws;
 * a missing/empty label (feature off) reads as watched, and so does an item with no
 * labels under it.
 *
 * Pure and provider-agnostic — reads the label list alone, so the fake, github and
 * azure providers gate identically, and the dispatcher, `prAttention`, the server
 * and the cockpit cannot form different opinions about one item.
 */
export function isWatched(labels: string[] | undefined, watchLabel: string): boolean {
  if (!watchLabel) return true;
  return (labels ?? []).includes(watchLabel);
}
