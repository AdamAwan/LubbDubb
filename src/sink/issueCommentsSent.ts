import type { ActionSink, IssueCommentInput, SendResult } from './actionSink.js';

// → docs/spec/40-discussions.md#pulling-tracker-comments-in

/**
 * The sink, with every issue comment it sends recorded by the id the provider answered. A
 * `Proxy` rather than a subclass because the sink is whatever was injected — the composite, or a
 * test's fake — and every other member must reach it unchanged.
 */
export function recordIssueComments<T extends Pick<ActionSink, 'upsertIssueComment'>>(
  sink: T,
  record: (issueNumber: number, commentRef: string) => void,
): T {
  const upsert = async (input: IssueCommentInput): Promise<SendResult> => {
    const result = await sink.upsertIssueComment(input);
    if (result.ref) record(input.number, result.ref);
    return result;
  };
  return new Proxy(sink, {
    get(target, prop) {
      if (prop === 'upsertIssueComment') return upsert;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
