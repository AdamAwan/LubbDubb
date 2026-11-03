import type { ActionSink, IssueCommentInput, SendResult } from './actionSink.js';

// → docs/spec/14-persistence.md

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
