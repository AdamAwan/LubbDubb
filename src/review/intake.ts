import type { PullRequest } from '../types.js';
import type { PrReviewPolicy } from './policy.js';

/**
 * The fleet review's **intake ledger** — which open pull requests the review is
 * for, as against which were simply already there when a project switched it on.
 *
 * The gap it closes: `needsFleetReview` asks four questions and none of them is
 * about time, so the pulse a team sets `review.enabled` every open pull request
 * with no verdict becomes eligible at once. On a repository with twenty of them
 * that is twenty review agents queued behind the agent cap, twenty read-only
 * checkouts cycling through a five-slot worktree pool — each hand-over a
 * `git clean -ffdx` and a cold dependency install — and, with `review.blocking`,
 * twenty pull requests held out of `pr-merge-ready` until each has been read.
 * Every part of that looks exactly like the feature working.
 *
 * **Stored, not derived, for `pr_watch_seeds`' reason: the world does not answer
 * the question.** "Was this pull request already open when the review started
 * asking" appears in no provider payload, and the live state cannot stand in for
 * it — a pull request nothing has reviewed yet and one nothing will ever review
 * are the same row. Re-deriving from the world alone would be a guard that
 * silently undoes itself on the next pulse, which is the failure the watch
 * seeds exist to prevent, one subsystem over.
 *
 * **And stamped either way, which is the other half.** The environments arrival
 * rule settled this exact question for a feature that writes to other people's
 * ticket threads, and settled it the same way: announce only on a reading the
 * harness watched, stamp whether or not there was anything to say, and a
 * deployment taking the build catches its past up *silently* and speaks for the
 * next thing that happens. A stamp written only for the eligible would leave
 * every backlog pull request unstamped and therefore re-judged every pulse
 * against a ledger that had meanwhile filled up — so the backlog would become
 * eligible one pulse later, which is the bug with a delay on it.
 * → `docs/spec/24-environments.md#announcing-an-arrival`
 *
 * Pure over the world, the policy and the stamped rows, and a lens's opposite in
 * `prsToSeedWatch`' sense: nothing in `src/dispatcher/` reads
 * {@link prsToStampReviewIntake}, but it drives the writes `Harness.runCycle`
 * makes a few lines above `dispatcher.decide`. {@link withinReviewIntake} is what
 * the two rules, the lens and the merge gate ask.
 * → `docs/spec/07-pull-requests.md#the-backfill-guard`
 */

/**
 * The ledger as its readers hold it: pull request number → whether the harness
 * watched that pull request appear.
 *
 * A pull request **missing** from it has not been stamped yet, and reads as not
 * within the intake — the safe direction in both halves at once: it is not
 * reviewed, and (with `review.blocking`) it is not held either, so a stamping
 * pass that failed or was never wired costs a review rather than wedging a
 * merge.
 */
export type PrReviewIntake = ReadonlyMap<number, boolean>;

/** What {@link prsToStampReviewIntake} needs beyond the world. */
interface PrReviewIntakeContext {
  /** Whether the review runs at all. Off, nothing is stamped — there is no intake to be within. */
  enabled: boolean;
  /** Already stamped, from `pr_review_intake`. The read lives in the caller so this stays pure. */
  stamped: PrReviewIntake;
  /** The world's own clock (`world.takenAt`), never `Date.now()` — the pulse decides what "now" is. */
  now: string;
  /**
   * How far back a pull request may have been opened and still count as one this
   * harness watched appear: `heartbeatIntervalMs`, doubled.
   *
   * Two pulses rather than one for the reason the arrival window is two probe
   * intervals: a pull request opened just before the pulse that first sees it is
   * still one this harness watched, and a cycle that ran long must not turn that
   * into a pull request nobody reads. Coupled to the pulse rather than given a
   * knob of its own because the pulse *is* the resolution of everything the
   * harness sees — a second interval could only sit above it (a window claiming
   * to have watched pulses that never happened) or below it (a window narrower
   * than the harness can observe, silently reviewing nothing).
   */
  windowMs: number;
}

/** One pull request to stamp, and the verdict the stamp carries. */
interface PrReviewIntakeStamp {
  prNumber: number;
  /** Whether the harness watched this pull request appear — see {@link prsToStampReviewIntake}. */
  watchedOpen: boolean;
}

/**
 * Which open pull requests the intake has not judged yet, and what the stamp says.
 *
 * A pull request is one the harness **watched appear** when either of two things
 * holds, and it is both for the environments rule's reason — each alone is wrong
 * in one direction:
 *
 * - **It was opened inside the window.** Without this a deployment's very first
 *   pulse with the review on has an empty ledger, so a pull request the fleet
 *   opened ninety seconds ago is indistinguishable from one that has been sitting
 *   there for a month and neither is read. That is the feature's whole first
 *   impression spent on a guard.
 * - **The ledger was already asking before this pull request appeared.** Without
 *   this a pull request that slipped past the window — held back by unhandled
 *   human threads, by a saturated cap, by a cooldown — falls out of the intake
 *   for good, having been the harness's to review the whole time. The stamp is
 *   what makes eligibility survive the wait: judged once, on the pulse it was
 *   first seen, and never re-judged against a clock that has moved on.
 *
 * `openedAt` absent is "cannot say" rather than old: the first test is simply
 * unavailable, the second carries every pull request from the second pulse on,
 * and a provider that does not report it costs that deployment its first pulse's
 * open set and nothing else.
 *
 * `review.backfill` is deliberately **not** read here. It is a live read at the
 * point of asking ({@link withinReviewIntake}), so a project that turns it on
 * next week still reaches the pull requests this pass has already stamped as
 * backlog — baked into the stamp, the switch would be inert on exactly the
 * pull requests it was reached for.
 */
export function prsToStampReviewIntake(openPrs: PullRequest[], ctx: PrReviewIntakeContext): PrReviewIntakeStamp[] {
  if (!ctx.enabled) return [];
  // Read before anything in this pass is stamped, or every pull request after the
  // first would see a ledger its own siblings had just filled and read as one of a
  // series — the whole open set eligible, which is the guard inverted.
  const wasAsking = ctx.stamped.size > 0;
  const now = Date.parse(ctx.now);
  const out: PrReviewIntakeStamp[] = [];
  for (const pr of openPrs) {
    if (pr.merged) continue;
    if (ctx.stamped.has(pr.number)) continue;
    const openedAt = pr.openedAt === undefined ? NaN : Date.parse(pr.openedAt);
    const fresh = Number.isFinite(openedAt) && Number.isFinite(now) && now - openedAt <= ctx.windowMs;
    out.push({ prNumber: pr.number, watchedOpen: fresh || wasAsking });
  }
  return out;
}

/**
 * Is this pull request one the fleet review is for?
 *
 * Asked by `needsFleetReview` and by `reviewSatisfied`, so the rule that
 * dispatches a review and the gate that holds a merge are answering one
 * question. **Both halves matter and the second is the sharp one**: a backlog
 * pull request nothing will ever review must not be held out of
 * `pr-merge-ready`, or the guard trades twenty wasted reviews for twenty pull
 * requests that can never merge — the same harm, wearing the fix.
 */
export function withinReviewIntake(pr: PullRequest, intake: PrReviewIntake, policy: PrReviewPolicy): boolean {
  // The operator asking for the backlog, read live rather than off the stamp.
  if (policy.backfill) return true;
  return intake.get(pr.number) === true;
}
