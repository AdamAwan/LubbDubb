import type { ReviewPackHead } from '../store/reviewPacks.js';

/**
 * Whether a pull request has a review pack, as the row draws it.
 *
 * **A reading, not a control.** Asking for a pack and opening one are the pull
 * request page's (`ReviewPackControl`), which reads the pack itself over its own
 * route; this is the one bit a rack of twenty rows can carry without twenty
 * requests, and its whole job is to say whether going there is worth it.
 * → `docs/spec/31-review-packs.md#on-the-row`
 */
export type PrPackStanding =
  /** A pack written against the head the pull request is on now. */
  | 'current'
  /** A pack, written against an older head. Still the best reading anybody has. */
  | 'stale'
  /**
   * A pack, and no way to say whether it is about the head: the provider reported
   * the pull request without one. Its own arm rather than a fold into `current`,
   * for the reason a reach verdict has three values — the one case that is about
   * the provider must not be drawn as the one that is about the pack.
   * → `docs/spec/24-environments.md#the-three-verdicts`
   */
  | 'unplaced'
  /** No pack yet, and an author is on the pull request writing one. */
  | 'writing';

/**
 * The fold, from the pack's head and the pull request's.
 *
 * **Staleness is decided by sha and never by time**: a pack is about the commit it
 * was written against, and a pull request whose head has not moved since is one
 * the pack still describes however long ago that was. A pull request whose head
 * the provider did not report cannot be compared at all, and says so — a `current`
 * claimed on a missing head is the row calling a reading fresh on the one occasion
 * it cannot know. → `docs/spec/31-review-packs.md#on-the-row`
 */
export function packStandingOf(
  pack: ReviewPackHead | undefined,
  headSha: string | undefined,
  writing: boolean,
): PrPackStanding | undefined {
  if (pack === undefined) return writing ? 'writing' : undefined;
  if (headSha === undefined) return 'unplaced';
  return pack.headSha === headSha ? 'current' : 'stale';
}
