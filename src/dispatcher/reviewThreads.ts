import type { PrComment } from '../types.js';

/**
 * The dispatch origin for a PR's review feedback — **one per PR**, not one per
 * thread.
 *
 * A review is written as a unit: the same person leaves three comments in one
 * pass, each assuming the others. Handing an agent one thread in isolation is how
 * you get a fix for comment 1 that contradicts comment 3, or the same edit made
 * twice by two agents a cycle apart. Origin and branch stay 1:1 (the property
 * every dispatch gate leans on), and the whole review now costs one attempt cap
 * rather than one per thread.
 */
export function prCommentsOrigin(prNumber: number): string {
  return `pr:${prNumber}:comments`;
}

/**
 * The ref of a single review thread. No longer a dispatch origin — it is what
 * notify de-dup keys on, so a reviewer's fourth comment still reaches a running
 * agent instead of being swallowed by the origin its first three already claimed.
 * Deliberately the same string {@link replyProposalRef} names a drafted reply
 * with: one thread, one ref, whoever is asking about it.
 */
export function prCommentOrigin(prNumber: number, commentId: string): string {
  return `pr:${prNumber}:comment:${commentId}`;
}

/**
 * The unresolved threads, rendered for the end of the `pr-review-comment` prompt.
 *
 * **Appended, never interpolated**, for `ciFailureNote`'s reason: the template is
 * operator-overridable and `loadPromptTemplates` rejects only *unknown*
 * placeholders, so an override written against the old one-comment-per-agent
 * prompt declares no token for a thread list — interpolating would hand exactly
 * the deployments that customised most a single comment out of five, silently.
 * Appending has no fallback to get wrong.
 *
 * The thread id is named because it is what an agent needs to reply to the right
 * thread, and the count is stated up front so a truncated read still knows how
 * many there were.
 */
export function reviewThreadsNote(threads: PrComment[]): string {
  if (threads.length === 0) return '';
  const heading =
    threads.length === 1
      ? '\n\nThe unresolved review thread:'
      : `\n\nThe ${threads.length} unresolved review threads, in the order they were left:`;
  const bodies = threads.map((t, i) => `${i + 1}. ${t.author} (thread ${t.id}):\n${quote(t.body)}`);
  return `${heading}\n\n${bodies.join('\n\n')}`;
}

/**
 * The closing check appended after {@link reviewThreadsNote}: read the threads
 * again before finishing, and answer what is there now.
 *
 * The list in the prompt is a reading taken at dispatch, and a review is a live
 * thing — a reviewer leaves a fourth comment, or rewords the second, while the
 * agent is working. The branch-notify path in `prCiFailing` covers only part of
 * that: it delivers a thread the agent was never told about, only while the
 * agent is *running*, and an **edit** to a thread already in the prompt is no
 * new signal at all, so it is delivered to nobody. Anything it misses waits for
 * the next dispatch, which costs another attempt against the cooldown cap and,
 * at the cap, escalates to a human instead.
 *
 * Checking is cheap and the agent is the one who can do it: `world_read` serves
 * the same snapshot the dispatcher decided on, `unresolvedComments` and all, so
 * comparing it against the list it was handed is a read of the current review
 * rather than a memory of the one it started from.
 *
 * **Appended, never interpolated**, for {@link reviewThreadsNote}'s reason — and
 * more so here, since an override predating this cannot know to ask for it.
 */
export function reviewRecheckNote(prNumber: number): string {
  return (
    '\n\nBefore you finish, read that list again — it was taken when you were dispatched, and a review moves ' +
    `while you work. Call world_read("pr", "pr:${prNumber}") and compare its unresolvedComments against the ` +
    'threads above:\n\n' +
    '- A thread that is not above arrived after you started. It is yours — answer it in this dispatch.\n' +
    '- A thread whose body no longer reads as it does above was edited after you started. Answer the wording ' +
    'you can see now, and say that it changed.\n\n' +
    'The reading carries an observedAt: it is the last cycle’s snapshot rather than a live fetch, so if the ' +
    'work took a while, read it once more at the very end. Then account for every thread by its id — what you ' +
    'changed for it, or what you are defending and why. A thread you never mention reads as one you missed.'
  );
}

/**
 * The line a *running* agent on the branch is sent when a thread it has not been
 * told about appears. One per thread, collapsed into a single note by the caller.
 */
export function reviewThreadNote(prNumber: number, thread: PrComment): string {
  return `Review comment from ${thread.author} on PR #${prNumber} (thread ${thread.id}): "${thread.body}"`;
}

/** Indent a comment body so its own line breaks can't be read as the next thread. */
function quote(body: string): string {
  return body
    .split('\n')
    .map((line) => `   > ${line}`)
    .join('\n');
}
