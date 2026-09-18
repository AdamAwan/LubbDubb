import type { ActionSink, IssueCommentInput, SendResult } from '../../src/sink/actionSink.js';

/**
 * An `ActionSink` that can do exactly one thing — upsert an issue comment — and refuses everything
 * else by name. `RemoteValidationDesk` takes a sink because it posts a captured screen to the goal's
 * ticket, and a desk handed a silent no-op would let a test pass while posting nothing.
 *
 * @public the seam every `RemoteValidationDesk` test is given instead of a live connector
 */
export function commentSink(): ActionSink & { comments: IssueCommentInput[] } {
  const comments: IssueCommentInput[] = [];
  const sink = new Proxy({} as ActionSink & { comments: IssueCommentInput[] }, {
    get(_t, prop: string) {
      if (prop === 'comments') return comments;
      if (prop === 'upsertIssueComment')
        return async (input: IssueCommentInput): Promise<SendResult> => {
          comments.push(input);
          return { ok: true, ref: `comment_${String(comments.length)}` };
        };
      return () => {
        throw new Error(`${prop} is not scripted in this test`);
      };
    },
  });
  return sink;
}
