import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { foldPoolDigest } from '../../pool/aggregate.js';
import type { PoolInsightsPayload, PoolStatePayload } from '../../wire.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store } = system;

  app.get('/api/pool', async () => {
    return {
      status: system.pool?.status() ?? null,
      fleets: store.pool.listPoolFleets(),
    } satisfies PoolStatePayload;
  });

  const InsightsQuery = z.object({
    project: z.string().min(1).optional(),
    since: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'since must be a UTC day, YYYY-MM-DD')
      .optional(),
  });

  app.get(
    '/api/pool/insights',
    checked({ query: InsightsQuery }, async ({ query }) => {
      const project = query.project ?? null;
      return {
        rollup: foldPoolDigest(store.pool.listDigestRows(project), { project, since: query.since ?? null }),
        projects: [
          ...new Set(store.pool.listPoolFleets().flatMap((f) => (f.project === null ? [] : [f.project]))),
        ].sort(),
        fleets: store.pool.listPoolFleets(),
      } satisfies PoolInsightsPayload;
    }),
  );
}
