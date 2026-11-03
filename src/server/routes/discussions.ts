import type { FastifyInstance } from 'fastify';
import { readDiscussion } from '../../discussions/related.js';
import type { DiscussionReading } from '../../wire.js';
import { checked, IssueNumberParams } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md, docs/spec/40-discussions.md#in-the-cockpit

export function register(app: FastifyInstance, { system }: RouteContext): void {
  app.get(
    '/api/discussions/:number',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    checked({ params: IssueNumberParams }, ({ params }): DiscussionReading => {
      const issues = system.store.world.getWorldBaseline()?.issues ?? [];
      return readDiscussion(system.discussions, issues, params.number, system.config.issueContainerTypes).reading;
    }),
  );
}
