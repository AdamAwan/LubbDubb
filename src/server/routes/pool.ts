import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { foldPoolDigest, foldPoolLessons, foldPoolTrends } from '../../pool/aggregate.js';
import { POOL_RETENTION_DAYS } from '../../pool/digestArm.js';
import type { PoolInsightsPayload, PoolStatePayload } from '../../wire.js';
import type { RemedyCause } from '../../types.js';
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

  const PoolInsightsQuery = z.object({
    project: z.string().min(1).optional(),
    since: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'since must be a UTC day, YYYY-MM-DD')
      .optional(),
  });

  app.get(
    '/api/pool/insights',
    checked({ query: PoolInsightsQuery }, async ({ query }) => {
      const project = query.project ?? null;
      const rows = store.pool.listDigestRows(project);
      return {
        rollup: foldPoolDigest(rows, { project, since: query.since ?? null }),
        trends: foldPoolTrends(rows),
        projects: [
          ...new Set(store.pool.listPoolFleets().flatMap((f) => (f.project === null ? [] : [f.project]))),
        ].sort(),
        fleets: store.pool.listPoolFleets(),
        lessons: foldPoolLessons(store.pool.listPoolLessons(), {
          project: system.config.pool?.project ?? null,
          causes: ownAdoptedCauses(system),
        }),
      } satisfies PoolInsightsPayload;
    }),
  );
}

function ownAdoptedCauses(system: RouteContext['system']): RemedyCause[] {
  const since = new Date(Date.now() - POOL_RETENTION_DAYS * 86_400_000).toISOString();
  return system.store.lessons
    .listDrafts()
    .filter((d) => d.status === 'adopted' && d.settledAt !== null && d.settledAt >= since)
    .map((d) => d.cause);
}
