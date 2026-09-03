import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { foldPoolDigest } from '../../pool/aggregate.js';
import type { PoolInsightsPayload, PoolStatePayload } from '../../wire.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * The cross-fleet pool, as an operator reaches it (issue #28).
 *
 * Two reads and one write, and the shape of all three follows from the pool being
 * a **view** and never a database:
 *
 * - `GET /api/pool` is this fleet's own side plus the mirror — what has been
 *   published, when this fleet last polled, which claims the secret backstop
 *   refused, and which fleets have been heard from.
 * - `GET /api/pool/insights` is the shared page: the mirror folded across fleets.
 *   It takes a project **argument**, because `byCheck` is only comparable inside
 *   one project.
 * - `POST /api/knowledge/facts/:id/keep-local` is the per-claim opt-out, and it is
 *   the only write. It writes the store and **never publishes** — the desk's next
 *   pulse re-derives and puts, which is what stops an operator's click waiting on a
 *   push to another continent.
 *
 * Neither read rides on `/api/state`. The mirror is thousands of characters of
 * other teams' prose plus ninety days of rows per fleet, and the snapshot comes
 * round every couple of seconds for every open cockpit — the argument
 * `/api/spend` already makes, one subsystem over.
 *
 * → `docs/spec/28-cross-fleet-pool.md#in-the-cockpit`, `docs/spec/16-http-api.md`
 */
export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store } = system;

  app.get('/api/pool', async () => {
    return {
      // Null rather than an empty status: a deployment on the `fake` default has no
      // pool at all, and drawing one that had never published would say in the
      // operator's words that something is broken. → the three verdicts, spec 24.
      status: system.pool?.status() ?? null,
      fleets: store.listPoolFleets(),
    } satisfies PoolStatePayload;
  });

  const InsightsQuery = z.object({
    /** Omitted means every project — and then `byCheck` is absent rather than summed. */
    project: z.string().min(1).optional(),
    /** A UTC day, `YYYY-MM-DD`. The bucket is a day, so every window a reader wants is a whole number of them. */
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
        rollup: foldPoolDigest(store.listPoolDigestRows(project), { project, since: query.since ?? null }),
        // The projects the mirror actually holds, so the page's picker offers what
        // exists rather than what somebody typed.
        projects: [...new Set(store.listPoolFleets().flatMap((f) => (f.project === null ? [] : [f.project])))].sort(),
        fleets: store.listPoolFleets(),
      } satisfies PoolInsightsPayload;
    }),
  );
}
