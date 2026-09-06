/**
 * The fleet review's operator policy — whether the harness reviews its own pull requests
 * before a person is asked to, and what a project may say about how. →
 * `docs/spec/07-pull-requests.md#the-fleet-review`
 */

/**
 * One way of reviewing, as a project declares it: what to look for, and what to spend on
 * looking.
 */
interface PrReviewMode {
  /**
   * The file saying what this mode looks for, resolved against `repoRoot` and **appended**
   * to the rendered `pr-review` prompt, never interpolated. Read from the working tree,
   * never from the branch under review — a pull request must not edit the rules it is
   * reviewed against.
   */
  charterFile?: string | null;
  /**
   * The model profile a review in this mode runs on. Absent leaves the dispatch to resolve
   * on its rule; an operator's pin on the origin still wins.
   */
  profile?: string | null;
}

export interface PrReviewPolicy {
  /** Whether the review runs at all. */
  enabled: boolean;
  /**
   * Whether a pull request nobody has reviewed is held out of rule `pr-merge-ready`. Off,
   * the verdict is still recorded and drawn but gates nothing.
   */
  blocking: boolean;
  /**
   * Whether the reviewer is told to publish what it found on the pull request.
   * `'comment'` tells the agent to post through `reply_to_review`, its only write
   * channel ([09](docs/spec/09-execution.md)).
   */
  publish: 'none' | 'comment';
  /**
   * The key a thread the harness's own review tooling opened stamps itself with, on a
   * provider carrying a property bag (Azure DevOps only). It gates a mark's tint and
   * nothing else; it is not an identity test. →
   * `docs/spec/07-pull-requests.md#a-thread-the-harness-stamped`
   */
  publishedThreadProperty: string | null;
  /**
   * Which stamped threads count: the value required on the derived companion key
   * `"<publishedThreadProperty>.role"`.
   */
  publishedThreadRole: string | null;
  /** The ways this project reviews, keyed by the name its routing charter uses. */
  modes: Record<string, PrReviewMode>;
  /**
   * Whether the triage may decide a pull request needs **no review at all**, rather than
   * only which declared mode reads it.
   */
  allowSkip: boolean;
  /**
   * A command asking whether a pull request has already been reviewed outside the harness.
   * Null (the default) asks nothing. →
   * `docs/spec/07-pull-requests.md#a-review-that-happened-somewhere-else`
   */
  reviewedElsewhere: string | null;
  /**
   * The mode a review runs in when nothing chose one — a triage that crashed, was killed or
   * spent its attempt cap. Null takes the first declared mode; named, it must be one of
   * {@link modes} or the config is refused at load.
   */
  defaultMode: string | null;
  /**
   * The file saying **how to choose** between the modes — the project's own prose, read by
   * the triage agent.
   */
  routingCharterFile: string | null;
}

export const DEFAULT_PR_REVIEW: PrReviewPolicy = {
  enabled: false,
  blocking: true,
  publish: 'none',
  publishedThreadProperty: null,
  publishedThreadRole: null,
  modes: {},
  allowSkip: false,
  reviewedElsewhere: null,
  defaultMode: null,
  routingCharterFile: null,
};
