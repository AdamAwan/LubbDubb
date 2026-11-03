import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readDiscussion } from '../../discussions/related.js';
import type { DiscussionReading } from '../../wire.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md, docs/spec/40-discussions.md#in-the-cockpit

const DiscussionParams = z.object({
  number: z.coerce
    .number('number must be the story or Feature’s tracker number')
    .int('number must be the story or Feature’s tracker number')
    .positive('number must be the story or Feature’s tracker number'),
});

export function register(app: FastifyInstance, { system }: RouteContext): void {
  app.get(
    '/api/discussions/:number',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    checked({ params: DiscussionParams }, ({ params }): DiscussionReading => {
      const issues = system.store.world.getWorldBaseline()?.issues ?? [];
      return readDiscussion(system.discussions, issues, params.number);
    }),
  );
}
