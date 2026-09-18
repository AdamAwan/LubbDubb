import type { ActionSink, IssueCommentInput, IssueImageSink, SendResult } from '../../src/sink/actionSink.js';

/** What a bench may put on top of the default: the image half, or a comment that refuses. */
type Scripted = Partial<ActionSink & IssueImageSink>;

/**
 * An `ActionSink` that can do exactly one thing — upsert an issue comment — and refuses everything
 * else **by name**. `RemoteValidationDesk` takes a sink because it posts a captured screen to the
 * goal's ticket, and a desk handed a silent no-op would let a test pass while posting nothing.
 *
 * `over` is how a bench adds the image half or makes a call fail. It is a parameter rather than
 * something a caller spreads on afterwards, and that is load-bearing: this is a `Proxy` over an empty
 * target, so it has no own keys and `{ ...commentSink() }` silently yields an object with **nothing
 * on it** — a sink that records no comment and fails no assertion about why.
 *
 * @public the seam every `RemoteValidationDesk` test is given instead of a live connector
 */
export function commentSink(over: Scripted = {}): ActionSink & IssueImageSink & { comments: IssueCommentInput[] } {
  const comments: IssueCommentInput[] = [];
  return new Proxy({} as ActionSink & IssueImageSink & { comments: IssueCommentInput[] }, {
    get(_t, prop: string) {
      if (prop === 'comments') return comments;
      const scripted = (over as Record<string, unknown>)[prop];
      if (scripted !== undefined) return scripted;
      if (prop === 'upsertIssueComment')
        return async (input: IssueCommentInput): Promise<SendResult> => {
          comments.push(input);
          return { ok: true, ref: `comment_${String(comments.length)}` };
        };
      // A provider with no attachment API answers the question rather than throwing, which is the
      // shape the desk reads: `false` is a fact about the provider, not an incident.
      if (prop === 'canAttachIssueImage') return () => false;
      return () => {
        throw new Error(`${prop} is not scripted in this test`);
      };
    },
  });
}
