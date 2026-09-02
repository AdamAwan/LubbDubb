import type { PrComment, PrReviewThread, PrThreadState, PullRequest, WorldSnapshot } from './types.js';

/**
 * Review threads: the one place their state is decided, and the one place the
 * operator's reopen is laid over them.
 *
 * Both providers read a pull request's threads and both used to fold them
 * straight down to a `handled` bit. They now build {@link PrReviewThread}s and
 * derive the comment list from those, through {@link threadComments} — one
 * derivation per provider rather than two, so the list a rule dispatches on and
 * the threads a person reads can never come to disagree about the same thread.
 * → `docs/spec/07-pull-requests.md#review-threads`
 */

/**
 * Where a thread stands, from the two things a provider can actually answer.
 *
 * `resolved` is the reviewer's own verdict and leads, because it is a statement
 * rather than an inference. `answered` is the fallback the two providers share:
 * the harness wrote the last reply — which is now read off the record of what the
 * harness actually sent ({@link SentPrReplies}) rather than off the reply's
 * author. Identity is never sufficient: the credential the harness posts under is
 * the operator's own on a single-operator deployment, so an author test marked
 * the operator's follow-up on their own thread as the fleet's answer and dropped
 * it. Neither is `reopened` — that is the operator's, written on top by
 * {@link applyThreadReopens} and never derived from a provider reading.
 */
export function threadState(opts: { resolved: boolean; answered: boolean }): PrThreadState {
  if (opts.resolved) return 'resolved';
  return opts.answered ? 'answered' : 'open';
}

/**
 * Whether the fleet still owes this thread an answer — the whole of what a
 * dispatch rule needs, and the fold {@link PrComment.handled} carries.
 *
 * A **reopened** thread is unhandled whatever the provider says about it. That is
 * the point of the reopen: the operator has decided the answer was not good
 * enough, and a thread the provider still calls resolved has to read as work.
 */
function threadHandled(state: PrThreadState): boolean {
  return state === 'answered' || state === 'resolved';
}

/**
 * The comment list every dispatch rule reads, derived from the threads rather
 * than built beside them. One entry per thread, keyed on the same id, in the
 * order the provider gave them.
 */
export function threadComments(threads: readonly PrReviewThread[]): PrComment[] {
  return threads.map((t) => ({ id: t.id, author: t.author, body: t.body, handled: threadHandled(t.state) }));
}

/**
 * The record of what the harness itself sent, as a provider asks it.
 *
 * One method, per pull request, answered synchronously off SQLite — a provider
 * building threads has the pull request in hand and nothing else to join on.
 * `Store` implements it; a caller that has no record to offer passes nothing and
 * every thread reads as unanswered work, which is the safe direction.
 * → `docs/spec/07-pull-requests.md#review-threads`
 */
export interface SentPrReplies {
  /** Provider comment refs of every reply the harness recorded sending on this PR. */
  prReplyRefs(prNumber: number): ReadonlySet<string>;
}

/** No record at all — what a provider built without one derives against. */
const NO_REPLIES: ReadonlySet<string> = new Set();

/**
 * What {@link SentPrReplies} says about one pull request, or nothing.
 *
 * The absence of a ledger and a ledger with nothing in it are deliberately the
 * same answer: both mean "no reply here is known to be ours", and both leave every
 * thread open. Failing the other way would hand the reviewer's comment back to the
 * silence this record exists to end.
 */
export function ourReplyRefs(sent: SentPrReplies | undefined, prNumber: number): ReadonlySet<string> {
  return sent === undefined ? NO_REPLIES : sent.prReplyRefs(prNumber);
}

/** One operator reopen, as the store holds it. */
export interface PrThreadReopen {
  prNumber: number;
  threadId: string;
  reopenedAt: string;
}

/**
 * Lay the operator's reopens over a world reading.
 *
 * **One function, applied at the two seams that read a world**: the harness lays
 * it over the reading the moment it arrives, before anything decides against it,
 * and the cockpit's snapshot lays it over the stored baseline as it serves it.
 * Both, because they are not the same read — a click that lands while a cycle is
 * in flight is followed by no world read at all, so a cockpit waiting for the
 * pulse to fold it in would draw the thread as settled for a beat.
 *
 * It is never written **into** the baseline. That row is the record of what the
 * provider last said, and folding the operator's override into it would leave the
 * harness unable to put the thread back when the ask is taken back.
 *
 * Open pull requests only: nothing acts on a merged or closed one, so a reopen
 * there would be a row nothing could ever answer.
 *
 * A reopen naming a thread this reading does not carry is **skipped, not
 * invented** — the pull request may have been re-read since, or the thread
 * deleted. It stays in the store, costing nothing, and takes effect again if the
 * thread comes back.
 * → `docs/spec/07-pull-requests.md#reopening-a-thread`
 */
export function applyThreadReopens(world: WorldSnapshot, reopens: readonly PrThreadReopen[]): WorldSnapshot {
  if (reopens.length === 0) return world;
  const byPr = new Map<number, Map<string, string>>();
  for (const r of reopens) {
    const threads = byPr.get(r.prNumber) ?? new Map<string, string>();
    threads.set(r.threadId, r.reopenedAt);
    byPr.set(r.prNumber, threads);
  }
  let touched = false;
  const pullRequests = world.pullRequests.map((pr) => {
    const marks = byPr.get(pr.number);
    if (marks === undefined || pr.reviewThreads === undefined) return pr;
    if (!pr.reviewThreads.some((t) => marks.has(t.id))) return pr;
    touched = true;
    const reviewThreads = pr.reviewThreads.map((t) => {
      const at = marks.get(t.id);
      return at === undefined ? t : { ...t, state: 'reopened' as const, reopenedAt: at };
    });
    return { ...pr, reviewThreads, unresolvedComments: threadComments(reviewThreads) } satisfies PullRequest;
  });
  return touched ? { ...world, pullRequests } : world;
}
