/**
 * What the fleet review has to say about one pull request, as a single reading
 * the cockpit draws — the mark on a PR row and the card on its page.
 *
 * A lens over rows that already exist (`pr_reviews`, `pr_review_routes`,
 * `pr_review_externals`), never a gate: `reviewSatisfied` stays the one place a
 * review holds a merge, so nothing on either surface can disagree with it. It is
 * folded server-side beside `health`, `attention` and `ciVerdict` for their
 * reason — the arms below read `config.review`, and a browser re-deciding which
 * of them applies would be a second opinion about a decision already taken
 * (`docs/spec/17-cockpit.md#the-fleet-reviews-mark`).
 */
import type { PrReviewThread } from '../types.js';
import type { PrReviewPolicy } from './policy.js';
import { defaultReviewMode, resolvedReviewMode, reviewSkipped, triageRuns, type PrReviewReading } from './prReview.js';

/**
 * Where a pull request stands with the fleet's reviewer, in the order the harness
 * produces the answers.
 *
 * Six values rather than {@link PrReviewVerdict}'s two, because the verdict is
 * only the half of it an operator sees *last*: a pull request nothing has read
 * yet is the common case, and drawing that as an absent verdict says the review
 * found nothing.
 */
export type PrReviewStatus =
  /** No route yet, and the triage is the thing that decides — it is choosing. */
  | 'deciding'
  /** A mode is chosen and the reviewer has not run. */
  | 'routed'
  /** Read, and it found nothing worth a person's attention. */
  | 'clear'
  /** Read, and it did. */
  | 'findings'
  /** The triage decided this one needs no review at all. */
  | 'skipped'
  /** A check outside the harness reported it already reviewed. */
  | 'elsewhere';

/** The whole of what the mark draws and its tooltip says. */
export interface PrReviewState {
  status: PrReviewStatus;
  /**
   * The mode this review runs (or ran) in, as `review.modes` keys it. Null on a
   * project that declared none, and on the two arms that are not about a mode.
   */
  mode: string | null;
  /** Why the triage routed it there — or skipped it — in its own words. */
  routeReason: string | null;
  /** One sentence: what the diff does, as the reviewer understood it. */
  summary: string | null;
  /** What it found, one entry each. Empty on every arm but `findings`. */
  findings: readonly string[];
  /**
   * Somebody has dealt with what it found: the thread the findings were published
   * into reads **resolved** on the provider. False on every other arm, and on a
   * `findings` review that was never published, whose thread the current reading
   * does not carry, or whose thread is still open.
   *
   * It is the resolution of the fleet's *own* published thread and nothing else —
   * read off `PrReview.publishedThread`, which is a record of what the harness
   * sent. Any wider rule (every thread on the pull request, a thread whose author
   * matches the credential) would let somebody else's tidy-up report the fleet's
   * findings as answered, which is the one thing this bit must never say wrongly:
   * it is what turns the mark from red to green.
   */
  addressed: boolean;
  /** When the reviewer reported, for the tooltip's foot. Null until it has. */
  reviewedAt: string | null;
  /** When the triage decided. Null where nothing routed this pull request. */
  routedAt: string | null;
  /** The reviewer's run, so the agent behind a verdict is reachable. */
  agentId: string | null;
  /** The triage's run, which is a different agent and a different reading. */
  routeAgentId: string | null;
  /** The commit the reviewer read, where the provider reported one. Display only. */
  headSha: string | null;
}

/**
 * Fold the four rows into the one reading, or null where there is nothing to say.
 *
 * **Null is the honest answer on a deployment with the review off**, and it is
 * why the mark is absent rather than grey there: a "no review" glyph on every row
 * of every default deployment is a claim about a feature nobody turned on.
 *
 * The arms are ordered as the harness settles them — an external review and a
 * skip both stand *over* a missing verdict, because each is why no verdict is
 * coming.
 */
export function prReviewState(
  prNumber: number,
  reading: PrReviewReading,
  policy: PrReviewPolicy,
  /**
   * The pull request's review threads, where the caller has them — the only
   * source for {@link PrReviewState.addressed}. Omitted (a closed pull request's
   * row, a test about the arms) leaves it false, which draws the findings exactly
   * as they were reported.
   */
  threads?: readonly PrReviewThread[],
): PrReviewState | null {
  if (!policy.enabled) return null;
  const { review, route } = reading;
  const base = {
    mode: null,
    routeReason: route?.reason ?? null,
    summary: null,
    findings: [],
    addressed: false,
    reviewedAt: null,
    routedAt: route?.decidedAt ?? null,
    agentId: null,
    routeAgentId: route?.agentId ?? null,
    headSha: null,
  } satisfies Omit<PrReviewState, 'status'>;

  if (review !== null) {
    return {
      ...base,
      status: review.verdict === 'findings' ? 'findings' : 'clear',
      mode: resolvedReviewMode(route, policy),
      summary: review.summary,
      findings: review.findings,
      // Only the thread the harness recorded publishing into, and only where this
      // reading still carries it: a thread the provider no longer reports is a
      // thread nothing can say was resolved, and "cannot say" is not "dealt with".
      addressed:
        review.publishedThread !== null &&
        (threads ?? []).some((t) => t.id === review.publishedThread && t.state === 'resolved'),
      reviewedAt: review.reviewedAt,
      agentId: review.agentId,
      headSha: review.headSha,
    };
  }
  // Read before the route arms below, and both before `routed`: each is a reason
  // no verdict is coming, where `routed` is a verdict on its way.
  if (reading.elsewhere.has(prNumber)) return { ...base, status: 'elsewhere' };
  if (reviewSkipped(route, policy)) return { ...base, status: 'skipped', mode: null };
  if (route !== null) return { ...base, status: 'routed', mode: resolvedReviewMode(route, policy) };
  // No route. Whether that means "being decided" or "there was nothing to decide"
  // is the triage's own switch, asked exactly as rule `pr-review-triage` asks it —
  // so a project with one mode reads as routed to that mode rather than as a
  // decision nobody is making.
  return triageRuns(policy)
    ? { ...base, status: 'deciding' }
    : { ...base, status: 'routed', mode: defaultReviewMode(policy) };
}
