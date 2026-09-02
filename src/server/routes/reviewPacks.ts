import type { FastifyInstance } from 'fastify';
import type { ReviewPackPayload } from '../../wire.js';
import { checked, PrNumberParams } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * Asking for a review pack, and reading the one a pull request has.
 * → `docs/spec/31-review-packs.md#when-a-pack-is-made`
 *
 * The ask returns at once and the pack arrives later: the author is an agent run,
 * and a route that held the connection open for one would time out on every
 * proxy between the cockpit and the port. Nothing here regenerates a pack on its
 * own — not a push, not a read — so the read says when the one it has is stale
 * and how far behind, and the ask is the same control the second time.
 */
export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store, reviewPacks, reviewPackChecker } = system;

  /**
   * Ask for a pack from the pull request's row. `202` — accepted, not done. The
   * refusals are the desk's, in its order: no such open pull request (404), then a
   * head the provider did not report, an author already on it, or a paused fleet
   * (409). A second ask on a new head is the same call; the new pack replaces the
   * old one when it lands.
   */
  app.post(
    '/api/prs/:number/review-pack',
    checked({ params: PrNumberParams }, async ({ params, reply }) => {
      const outcome = reviewPacks.request(params.number);
      if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });
      return reply.code(202).send({ ok: true, prNumber: outcome.prNumber, headSha: outcome.headSha });
    }),
  );

  /**
   * The pull request's current pack with the reviewer's marks, or a 404 that
   * says whether one is on its way. `checking` says whether the checker is on it,
   * so a pack with every verdict null reads as "being checked" or "unchecked"
   * rather than either. Staleness is decided here, against the
   * pull request's head as the harness last saw it — the store does not know the
   * head — and the count between the two is asked of the clone, which may not
   * hold the newer commits yet: then the pack is stale by sha and the count is
   * null, never zero.
   */
  app.get(
    '/api/prs/:number/review-pack',
    checked({ params: PrNumberParams }, async ({ params, reply }) => {
      const record = store.getCurrentReviewPack(params.number);
      if (!record) {
        const writing = reviewPacks.writing(params.number);
        return reply.code(404).send({
          error: writing
            ? `no review pack for #${params.number} yet — one is being written`
            : `no review pack for #${params.number}; ask for one from the pull request's row`,
          writing,
        });
      }
      const { head, stale } = await reviewPacks.staleness(params.number, record.pack.headSha);
      return {
        ...record,
        marks: store.listReviewMarks(params.number),
        head,
        stale,
        checking: reviewPackChecker.checking(params.number),
      } satisfies ReviewPackPayload;
    }),
  );
}
