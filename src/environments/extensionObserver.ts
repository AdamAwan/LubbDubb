import type { ExtensionHost } from '../extensions/host.js';
import type { ExtensionSlots } from '../extensions/slots.js';
import { unexposed, type ExposureReading, type ExposureRequest } from './exposure.js';
import type { EnvironmentObservationRequest, EnvironmentObserver } from './observer.js';
import type { EnvironmentConfig } from './policy.js';
import { routeByEnvironment, watchFromExtension } from './readingExtensions.js';
import { preparedQuery, readWatchRows, unanswered, type WatchResult } from './watchResult.js';

// → docs/spec/29-post-deploy-watch.md#from-the-projects-extension

type ReadingHost = Pick<ExtensionHost<ExtensionSlots>, 'call'>;

/**
 * The project's extension answering the watch. The query is prepared exactly as for a command — refused
 * without `{since}`, the id projection appended to `kql` — and the rows it answers are held to the same
 * contract, id echo included. Not answering is `unknown`, never clean.
 */
export class ExtensionEnvironmentObserver implements EnvironmentObserver {
  constructor(private readonly host: ReadingHost) {}

  async observe(request: EnvironmentObservationRequest): Promise<WatchResult> {
    const prepared = preparedQuery(request.query, request, request.checkId, request.kind, request.language);
    if (prepared.query === null) return unanswered(prepared.refusal);
    const answer = await this.host.call('watchReading', {
      environment: request.environment,
      source: request.source,
      language: request.language,
      checkId: request.checkId,
      query: prepared.query,
      kind: request.kind,
      since: request.since,
      until: request.until,
      commits: request.commits === undefined ? null : [...request.commits],
    });
    if (!answer.ok) return unanswered(`the observation failed: ${answer.detail}`);
    return readWatchRows(answer.value, request.checkId, request.kind);
  }

  async exposure(request: ExposureRequest): Promise<ExposureReading> {
    if (request.commits.length === 0) return unexposed('the goal has no landed commit to ask about');
    const answer = await this.host.call('watchExposure', {
      environment: request.environment,
      commits: [...request.commits],
    });
    if (!answer.ok) return unexposed(`the exposure probe failed: ${answer.detail}`);
    return { share: answer.value.share, detail: null };
  }
}

/** The observer for each environment: the extension's where it sets `watch.extension`, else its commands'. */
export class RoutedEnvironmentObserver implements EnvironmentObserver {
  private readonly for: (environment: string) => EnvironmentObserver;

  constructor(
    environments: readonly EnvironmentConfig[],
    commands: EnvironmentObserver,
    extension: EnvironmentObserver,
  ) {
    this.for = routeByEnvironment(environments, watchFromExtension, commands, extension);
  }

  observe(request: EnvironmentObservationRequest): Promise<WatchResult> {
    return this.for(request.environment).observe(request);
  }

  exposure(request: ExposureRequest): Promise<ExposureReading> {
    return this.for(request.environment).exposure(request);
  }
}
