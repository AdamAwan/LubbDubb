import type { PrComment, PrReviewThread, PrThreadState, PullRequest, WorldSnapshot } from './types.js';

// → docs/spec/07-pull-requests.md#attribution-is-a-record-never-an-identity

export function threadState(opts: { resolved: boolean; answered: boolean }): PrThreadState {
  if (opts.resolved) return 'resolved';
  return opts.answered ? 'answered' : 'open';
}

function threadHandled(state: PrThreadState): boolean {
  return state === 'answered' || state === 'resolved';
}

export function threadComments(threads: readonly PrReviewThread[]): PrComment[] {
  return threads.map((t) => {
    const comment: PrComment = { id: t.id, author: t.author, body: t.body, handled: threadHandled(t.state) };
    if (t.replies.length > 0) comment.replies = t.replies;
    return comment;
  });
}

export interface SentPrReplies {
  prReplyRefs(prNumber: number): ReadonlySet<string>;
}

const NO_REPLIES: ReadonlySet<string> = new Set();

export function ourReplyRefs(sent: SentPrReplies | undefined, prNumber: number): ReadonlySet<string> {
  return sent === undefined ? NO_REPLIES : sent.prReplyRefs(prNumber);
}

export interface PrThreadReopen {
  prNumber: number;
  threadId: string;
  reopenedAt: string;
}

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
