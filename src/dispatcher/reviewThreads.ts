import type { PrComment } from '../types.js';

// → docs/spec/05-dispatcher.md

export function prCommentsOrigin(prNumber: number): string {
  return `pr:${prNumber}:comments`;
}

export function prCommentOrigin(prNumber: number, commentId: string): string {
  return `pr:${prNumber}:comment:${commentId}`;
}

export function prCommentSignalRef(prNumber: number, thread: PrComment): string {
  const origin = prCommentOrigin(prNumber, thread.id);
  const replies = thread.replies ?? [];
  const newest = replies[replies.length - 1];
  return newest === undefined ? origin : `${origin}@${newest.id}`;
}

export function reviewThreadsNote(threads: PrComment[]): string {
  if (threads.length === 0) return '';
  const heading =
    threads.length === 1
      ? '\n\nThe unresolved review thread:'
      : `\n\nThe ${threads.length} unresolved review threads, in the order they were left:`;
  const bodies = threads.map((t, i) => `${i + 1}. ${threadTranscript(t)}`);
  return `${heading}\n\n${bodies.join('\n\n')}${lastWordNote(threads)}`;
}

function threadTranscript(thread: PrComment): string {
  const head = `${thread.author} (thread ${thread.id}):\n${quote(thread.body)}`;
  const replies = thread.replies ?? [];
  if (replies.length === 0) return head;
  const rendered = replies.map(
    (r) => `   ${r.author}${r.ours ? ' (the fleet, earlier)' : ''} replied:\n${quote(r.body)}`,
  );
  return `${head}\n${rendered.join('\n')}`;
}

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

export function reviewThreadNote(prNumber: number, thread: PrComment): string {
  const replies = thread.replies ?? [];
  const head = `Review comment from ${thread.author} on PR #${prNumber} (thread ${thread.id}): "${thread.body}"`;
  if (replies.length === 0) return head;
  const rendered = replies
    .map((r) => `${r.author}${r.ours ? ' (the fleet, earlier)' : ''}: "${r.body}"`)
    .join('; then ');
  return `${head} — then ${rendered}. The last of those is the live ask.`;
}

function quote(body: string): string {
  return body
    .split('\n')
    .map((line) => `   > ${line}`)
    .join('\n');
}

export function replyOrigin(
  originRef: string | null,
): { ok: true; prNumber: number; originRef: string } | { ok: false; error: string } {
  const match = originRef ? /^pr:(\d+):(?:comments|review)$/.exec(originRef) : null;
  if (match) return { ok: true, prNumber: Number(match[1]), originRef: originRef! };
  return {
    ok: false,
    error:
      `reply_to_review is only for an agent dispatched to answer a pull request's review threads, or to ` +
      `review it, and ` +
      `this task's origin is ${originRef ?? '(none)'}. Do not post to the thread yourself instead: if you ` +
      `have something to say about a pull request that is not yours to answer, say it in the summary you ` +
      `finish with, or raise it.`,
  };
}

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
