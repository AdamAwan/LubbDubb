/**
 * The fleet review's operator policy — whether the harness reviews its own pull
 * requests before a person is asked to, and what a project may say about how.
 *
 * Its own module for {@link DEFAULT_VALIDATION}'s reason: the default belongs
 * beside the subsystem that means it rather than in the middle of `config.ts`.
 *
 * **Off by default**, and off is the honest default rather than a cautious one:
 * this is the one rule that spends an agent on every pull request the fleet
 * opens, and a deployment that took the defaults would find its bill changed by
 * a build it did not ask anything of. Every field below is written to be set by
 * the *project* — `lubbdubb.project.json` carries any key, so what a team looks
 * for in a diff is committed beside the code it is about rather than pasted into
 * each member's own config.
 * → `docs/spec/07-pull-requests.md#the-fleet-review`
 */
export interface PrReviewPolicy {
  /**
   * Whether the review runs at all. It switches rule `pr-review` into
   * {@link DISPATCH_PIPELINE} through `RuleConditions`, exactly as the work-item
   * rules are switched in — so with it off there is no stage, no origin and no
   * gate, and the merge test is the one every deployment had before this existed.
   */
  enabled: boolean;
  /**
   * Whether a pull request nobody has reviewed is held out of rule
   * `pr-merge-ready`.
   *
   * On is the point of the feature — a review that cannot stop a merge is a
   * comment — but it is separable, because a team adopting it wants a week of
   * reading what the reviewer says before it starts blocking. Off, the verdict is
   * still recorded and still drawn; it simply gates nothing.
   *
   * **Unknown is never clear.** A pull request with no verdict is held, which is
   * the whole of the gate: the alternative reads a review that never ran as a
   * review that found nothing.
   */
  blocking: boolean;
  /**
   * Whether the reviewer is told to publish what it found on the pull request.
   *
   * `'none'` keeps the review inside the harness: the verdict is on the pull
   * request's row and in the prompt of whoever fixes it, and nothing is written
   * to the provider. `'comment'` adds one line to the prompt telling the agent to
   * post its findings through `reply_to_review`, which is the *only* way it may —
   * that tool raises an act the executor authorises and signs, where an agent
   * posting from its own shell would be an unaudited write under the operator's
   * credential ([09](docs/spec/09-execution.md)).
   *
   * It is deliberately not a free-form channel. What the comment *says* is the
   * project's, through the prompt and the charter; where it goes is the
   * harness's.
   */
  publish: 'none' | 'comment';
  /**
   * A file in the repository holding what this project wants looked at — the
   * checklist a team would otherwise have to keep in each member's prompt
   * override.
   *
   * Repo-relative, resolved against `repoRoot` and **appended** to the rendered
   * `pr-review` prompt rather than interpolated into it, for the reason every
   * addition to a prompt is appended: an operator's override that never learned
   * about a `{charter}` placeholder would drop it silently, on exactly the
   * deployments that customised most ([05](docs/spec/05-dispatcher.md)).
   *
   * **Read from the working tree, never from the branch under review.** The
   * project layer is read the same way and for the same reason: a pull request
   * that could edit the rules it is reviewed against is a gate that reviews
   * whatever it is told to.
   *
   * Null — the default — appends nothing, and the reviewer reads the repository's
   * own conventions as any agent does.
   */
  charterFile: string | null;
}

export const DEFAULT_PR_REVIEW: PrReviewPolicy = {
  enabled: false,
  blocking: true,
  publish: 'none',
  charterFile: null,
};
