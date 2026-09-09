import { parseWatchResult, unanswered, type WatchResult } from '../environments/watchResult.js';
import { aggregatingTail } from '../validation/watchQueryShape.js';
import { watchRow } from '../environments/fakeObserver.js';
import { parsedAs, type StateReadRequest, type StateReader } from './stateReader.js';

// → docs/spec/36-remote-validation.md

export class FakeStateReader implements StateReader {
  readonly asked: { environment: string; command: string; queryId: string; kind: string; query: string }[] = [];

  constructor(private readonly output: Record<string, string> = {}) {}

  read(request: StateReadRequest): Promise<WatchResult> {
    const { environment, command, queryId, kind, query } = request;
    this.asked.push({ environment, command, queryId, kind, query });
    const stdout = this.output[`${queryId}:${kind}`];
    if (stdout === undefined) return Promise.resolve(unanswered('unscripted'));
    const result = parseWatchResult(stdout, queryId, parsedAs(kind));
    if (result.rows === null || aggregatingTail(query) === null) return Promise.resolve(result);
    return Promise.resolve(
      parseWatchResult(JSON.stringify([watchRow(queryId, { count_: result.rows.length })]), queryId, parsedAs(kind)),
    );
  }
}
