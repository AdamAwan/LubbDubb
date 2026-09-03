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
 * The notify de-dup key for one thread — {@link prCommentOrigin} while the thread
 * is just its root, and the root **plus its newest message** once somebody has
 * replied under it.
 *
 * De-dup asks "has this agent already been told this?", and keyed on the thread
 * alone the answer was yes forever after the first delivery. A reviewer's
 * follow-up on a thread the agent was handed at dispatch is then a signal
 * delivered to nobody — which is exactly the shape of feedback an operator gives
 * while watching an agent work, and the one it must never be. The key moves when
 * the conversation does, so the follow-up reaches the running agent and the
 * unchanged thread still does not repeat itself every pulse.
 *
 * Not folded into `prCommentOrigin`: that string is a *ref* — the one a refused
 * `reply_draft` proposal is filed under, and the one `rejectionGuidance` matches
 * whole — and it has to stay the same string across the life of a thread. A key
 * that must move and a ref that must not are two jobs, so they are two functions.
 */
export function prCommentSignalRef(prNumber: number, thread: PrComment): string {
  const origin = prCommentOrigin(prNumber, thread.id);
  const replies = thread.replies ?? [];
  const newest = replies[replies.length - 1];
  return newest === undefined ? origin : `${origin}@${newest.id}`;
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
  const bodies = threads.map((t, i) => `${i + 1}. ${threadTranscript(t)}`);
  return `${heading}\n\n${bodies.join('\n\n')}${lastWordNote(threads)}`;
}

/**
 * One thread as the agent must read it: the root, then **every reply under it**,
 * oldest first, each named by its author.
 *
 * The root alone was the whole of what an agent ever saw, and a review thread is
 * not its opening line. A reviewer narrows a finding in the reply; the operator
 * says which of a bot's five comments actually needs fixing, and what the fix is,
 * in the reply. Handed the root by itself, the agent answers the wrong question
 * confidently — and to the person who wrote the reply that is indistinguishable
 * from being ignored, because the harness's answer never mentions what they said.
 *
 * A reply the harness itself sent is marked as such rather than left to be read
 * as the reviewer's. Without it an agent re-reads the fleet's own last answer as a
 * fresh instruction, which is how a thread gets the same fix twice.
 */
function threadTranscript(thread: PrComment): string {
  const head = `${thread.author} (thread ${thread.id}):\n${quote(thread.body)}`;
  const replies = thread.replies ?? [];
  if (replies.length === 0) return head;
  const rendered = replies.map(
    (r) => `   ${r.author}${r.ours ? ' (the fleet, earlier)' : ''} replied:\n${quote(r.body)}`,
  );
  return `${head}\n${rendered.join('\n')}`;
}

/**
 * The line that says what the transcript above is *for*, appended only when
 * there is a conversation to read.
 *
 * The list looks like a list of comments, and an agent that treats it as one
 * answers each root and skips the replies underneath — the same failure the
 * transcript exists to end, moved one step later. So the ordering rule is stated
 * outright: the newest message is the live ask, and an earlier one it revises is
 * history rather than a second instruction.
 */
function lastWordNote(threads: PrComment[]): string {
  if (!threads.some((t) => (t.replies?.length ?? 0) > 0)) return '';
  return (
    '\n\nRead each thread whole, oldest to newest. **The last message in a thread is the live ask** — a ' +
    'reviewer narrowing a finding, or telling you which part of it to fix and how, replies rather than ' +
    'editing what they wrote first, so the opening comment is where the thread started and not what it ' +
    'now wants. Where the two differ, answer the newest and say what you took it to mean. A reply marked ' +
    'as the fleet\u2019s is your own earlier answer: it is context for what has been tried, never an ' +
    'instruction.'
  );
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
    'you can see now, and say that it changed.\n' +
    '- A thread carrying a reply that is not above was answered while you worked, and that reply is now the ' +
    'live ask on it. Answer that, not the root you were handed.\n\n' +
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
  const replies = thread.replies ?? [];
  const head = `Review comment from ${thread.author} on PR #${prNumber} (thread ${thread.id}): "${thread.body}"`;
  // The replies, for `threadTranscript`'s reason and one more: this line is often
  // the *only* delivery a follow-up gets — it is sent because the thread moved,
  // and the thing that moved it is the reply. Naming the root alone would deliver
  // the notification and drop its content.
  if (replies.length === 0) return head;
  const rendered = replies
    .map((r) => `${r.author}${r.ours ? ' (the fleet, earlier)' : ''}: "${r.body}"`)
    .join('; then ');
  return `${head} — then ${rendered}. The last of those is the live ask.`;
}

/** Indent a comment body so its own line breaks can't be read as the next thread. */
function quote(body: string): string {
  return body
    .split('\n')
    .map((line) => `   > ${line}`)
    .join('\n');
}

/**
 * Which pull request's review this caller may reply to, refusing every other
 * origin **by name and with what to do instead** — `remedyOrigin`'s shape, for
 * its reason.
 *
 * The pull request comes out of the origin rather than out of an argument, so an
 * agent cannot answer a review on a pull request it was not dispatched for. That
 * is the tool channel's one structural guarantee, and it is the whole of what
 * makes a reply the harness sends attributable at all.
 *
 * Fenced to the review dispatch and not to `pr:<n>:ci`: a CI agent is answering a
 * red check, and a reply from it is a comment nobody asked for on a thread
 * somebody else's agent is working.
 */
export function replyOrigin(
  originRef: string | null,
): { ok: true; prNumber: number; originRef: string } | { ok: false; error: string } {
  const match = originRef ? /^pr:(\d+):comments$/.exec(originRef) : null;
  if (match) return { ok: true, prNumber: Number(match[1]), originRef: originRef! };
  return {
    ok: false,
    error:
      `reply_to_review is only for an agent dispatched to answer a pull request's review threads, and ` +
      `this task's origin is ${originRef ?? '(none)'}. Do not post to the thread yourself instead: if you ` +
      `have something to say about a pull request that is not yours to answer, say it in the summary you ` +
      `finish with, or raise it.`,
  };
}

/**
 * The appendix that names {@link replyToReview} — and, just as importantly, tells
 * the agent **not** to post to the thread itself.
 *
 * The tool existing is not enough. This prompt hands an agent every thread id it
 * needs to reply with, a deployment's `agentAllowedTools` commonly grants it a
 * shell that reaches the tracker's CLI, and the sentence above about defending an
 * approach reads as an instruction to answer *somewhere*. Left to fill that in,
 * an agent posts as whoever is logged in on the machine: unsigned, unrecorded by
 * the harness, and attributed to the operator rather than to the fleet — with
 * nothing anywhere saying it happened.
 *
 * **Appended, never interpolated**, for {@link reviewThreadsNote}'s reason, and
 * unconditionally: an override written before the tool existed is exactly the
 * deployment whose agents still reach for `gh`.
 */
export function replyToolNote(): string {
  return (
    '\n\nWhen you have a reply for a thread — a defence, an answer, or a note about what you changed — ' +
    'call `reply_to_review` with the reply and that thread’s id. One call per thread.\n\n' +
    'Set `resolved: true` on that call when the thread is dealt with — you made the change the reviewer ' +
    'asked for, or answered a question that needed nothing changed — and the harness marks the thread ' +
    'resolved as it sends the reply. Leave it off where you are defending an approach the reviewer may ' +
    'still disagree with, or where your answer leaves them something to decide: that thread is theirs ' +
    'to close. **You cannot resolve a thread any other way** — the reply goes out as the harness, so a ' +
    'thread you answer without this flag stays open in front of the reviewer, and the fleet comes back ' +
    'to it.\n\n' +
    '**Do not post to a review thread yourself**: not with `gh`, not with `az`, not with the provider’s ' +
    'REST API, not from a shell of any kind, even if your credentials would let you. A reply the harness ' +
    'sends is signed as the harness and recorded against the pull request; one you post is unsigned, ' +
    'unrecorded, and attributed to the person whose credential is on this machine, who did not write it. ' +
    'The harness may put your reply to the operator before it goes out — that is their setting, not a ' +
    'fault — and the tool tells you which happened.'
  );
}
