/**
 * The fleet review's operator policy — whether the harness reviews its own pull
 * requests before a person is asked to, and what a project may say about how.
 *
 * Its own module for {@link DEFAULT_VALIDATION}'s reason: the policy's default
 * belongs beside the subsystem that means it rather than in the middle of
 * `config.ts`.
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

/**
 * One way of reviewing, as a project declares it: what to look for, and what to
 * spend on looking.
 *
 * A record rather than a fixed pair of "quick" and "deep", because the modes a
 * team wants are a property of what they build — a shop with a migrations
 * problem wants a mode for schema changes, and naming their modes for them would
 * be this file having an opinion about their code.
 */
interface PrReviewMode {
  /**
   * The file in the repository saying what this mode looks for, resolved against
   * `repoRoot` and **appended** to the rendered `pr-review` prompt rather than
   * interpolated into it, for the reason every addition to a prompt is appended:
   * an operator's override that never learned about a `{charter}` placeholder
   * would drop it silently, on exactly the deployments that customised most
   * ([05](docs/spec/05-dispatcher.md)).
   *
   * **Read from the working tree, never from the branch under review.** The
   * project layer is read the same way and for the same reason: a pull request
   * that could edit the rules it is reviewed against is a gate that reviews
   * whatever it is told to.
   */
  charterFile?: string | null;
  /**
   * The model profile a review in this mode runs on — the half of the routing
   * decision that is about money rather than about attention. Absent leaves the
   * dispatch to resolve on its rule, exactly as every other dispatch does.
   *
   * An operator's own pin on the origin still wins over it
   * ([05](docs/spec/05-dispatcher.md)): a mode is the project's standing opinion,
   * and a pin is a person overruling it for one pull request.
   */
  profile?: string | null;
}

export interface PrReviewPolicy {
  /**
   * Whether the review runs at all. It switches rules `pr-review-triage` and
   * `pr-review` into {@link DISPATCH_PIPELINE} through `RuleConditions`, exactly
   * as the work-item rules are switched in — so with it off there is no stage, no
   * origin and no gate, and the merge test is the one every deployment had before
   * this existed.
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
   * The ways this project reviews, keyed by the name its routing charter uses.
   *
   * **Empty or one mode means no routing at all** — a decision with one option is
   * not a decision, so rule `pr-review-triage` proposes nothing, no agent is
   * spent on choosing, and the review runs the single declared mode (or, with
   * none, on its rule's own profile and with no charter). Two or more is what
   * turns the triage on. That is the whole switch; there is no separate flag for
   * it, because a flag could disagree with the modes and one of them would be
   * ignored silently.
   */
  modes: Record<string, PrReviewMode>;
  /**
   * Whether the triage may decide a pull request needs **no review at all** — a
   * version bump, a generated lockfile, a one-word typo in a comment — rather
   * than only which of the declared modes reads it.
   *
   * **Off**, because it is the one answer the triage can give that waives the gate
   * the feature exists to be. Everything else it decides is about *how much* to
   * read; this decides whether anything does, and with `blocking` on it is also
   * what lets the merge through. A project asks for it deliberately or it is not
   * on offer, and a triage that never learned about it cannot reach for it: the
   * `review_route` tool does not carry the argument, and the prompt does not
   * mention it.
   *
   * **It also turns the triage on by itself.** `review.modes` is the switch for the
   * *routing* question because a decision with one option is not a decision — but
   * with skipping allowed, one declared mode is two options ("read it that way" or
   * "do not"), so the triage runs. `triageRuns` is that reading, and every rule
   * asks it rather than `routesBetweenModes`.
   *
   * **Never the fail-open direction.** A triage that crashed, was killed or spent
   * its cap leaves no route, and `pr-review` then reads the pull request in the
   * default mode — exactly as before. A skip is only ever something an agent said
   * on purpose, recorded with its reason on the route row; silence is a review.
   */
  allowSkip: boolean;
  /**
   * A command asking whether a pull request has **already been reviewed somewhere
   * else** — an Azure branch policy with a required approver, a review bot,
   * another org's gate. Null (the default) asks nothing, which is every deployment
   * before this existed.
   *
   * The gap it closes: `pr_reviews` answers "has the *fleet* read this", which is
   * the only question the harness can answer on its own — and on a team that
   * already has a reviewer that is the wrong question. Without it the fleet spends
   * an agent on a diff somebody has read, and (with {@link blocking}) holds the
   * merge for a review that is already done.
   *
   * **A command, because there is no generic form**, exactly as an environment's
   * `health` is one: this is a policy evaluation on one deployment, a label on
   * another, and a script that asks two systems on a third. It is run in a shell in
   * `repoRoot` with `LUBBDUBB_PR` set, and **the exit code is the answer** — 0 for
   * "already reviewed" — because what an operator reaches for here already exits 0
   * for yes (`az repos pr policy list … | grep -q approved`, a `gh` query, a
   * `curl -f`), and a stdout contract would mean a wrapper around each one.
   *
   * **A check that could not answer leaves the fleet reviewing.** A missing
   * command, a timeout and a real "no" are one exit code apart, and folding any of
   * them into "already reviewed" would silently switch the whole feature off on
   * exactly the deployments whose gate broke. So only a clean exit 0 stands a pull
   * request down; everything else is the fail-open direction the triage and the
   * appraiser already take, and a failure that said nothing is recorded on the
   * error log rather than swallowed.
   * → `docs/spec/07-pull-requests.md#a-review-that-happened-somewhere-else`
   */
  reviewedElsewhere: string | null;
  /**
   * The mode a review runs in when nothing chose one — a triage that crashed, was
   * killed or spent its attempt cap.
   *
   * **The review fails open onto it**, the rule the appraiser, the planner and
   * the assessor all follow: a gate that can quietly stop the fleet is worse than
   * one that occasionally reads a diff more carefully than it needed to. So the
   * safe direction is the *thorough* mode, and this should name it.
   *
   * Null takes the first declared mode. Named, it must be one of {@link modes} —
   * a default naming a mode that does not exist is refused at load rather than
   * discovered on the first triage failure.
   */
  defaultMode: string | null;
  /**
   * The file saying **how to choose** between the modes — the project's own prose,
   * read by the triage agent.
   *
   * Prose rather than a threshold because the decision is not one: "under three
   * files" is a proxy for risk, and the things that actually make a diff worth a
   * careful read — it touches auth, it is the first change in a subsystem, the
   * ticket calls it a spike — are not counted, they are judged. A number here
   * would be a rule that is right about the shape of a change and wrong about the
   * change.
   *
   * Appended and read like a mode's charter, and on the same terms.
   */
  routingCharterFile: string | null;
}

export const DEFAULT_PR_REVIEW: PrReviewPolicy = {
  enabled: false,
  blocking: true,
  publish: 'none',
  modes: {},
  allowSkip: false,
  reviewedElsewhere: null,
  defaultMode: null,
  routingCharterFile: null,
};
