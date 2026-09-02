import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { REVIEW_ATTENTIONS } from '../../store/reviewPacks.js';
import type { ReviewAttention, ReviewIdea, ReviewRange } from '../../types.js';
import type {
  ReviewAttentionBody,
  ReviewCalibrationPayload,
  ReviewMarksPayload,
  ReviewPackAbsence,
  ReviewPackPayload,
  ReviewPackSharing,
  ReviewReadBody,
  ReviewSeenBody,
} from '../../wire.js';
import { buildReviewCalibration } from '../../reviewPacks/calibration.js';
import { InsightsQuery, resolveWindow, timelineSpan, windowView } from '../../insightsWindow.js';
import { checked, PrNumberParams, requiredBoolean } from '../validation.js';
import type { RouteContext } from './context.js';

/** `/api/prs/:number/review-pack/ideas/:id` — the idea's id as the current pack minted it. */
const IdeaParams = PrNumberParams.extend({ id: z.string().min(1, 'idea id is required') });

const ReadBody: z.ZodType<ReviewReadBody, z.ZodTypeDef, unknown> = z.object({
  read: requiredBoolean('read must be true or false'),
});

const SeenBody: z.ZodType<ReviewSeenBody, z.ZodTypeDef, unknown> = z.object({
  seen: requiredBoolean('seen must be true or false'),
});

const AttentionBody: z.ZodType<ReviewAttentionBody, z.ZodTypeDef, unknown> = z.object({
  attention: z
    .custom<ReviewAttention>((value) => REVIEW_ATTENTIONS.some((a) => a === value), {
      message: `attention must be one of ${REVIEW_ATTENTIONS.join(', ')}, or null`,
    })
    .nullable(),
});

/**
 * The hunks an idea owns — what a reviewer's mark on it is keyed to. Only the
 * `hunk` anchors: a `region` is a reference to code the idea does not own, and a
 * mark riding on one would land on whichever idea owns that hunk instead.
 */
function ownedHunks(idea: ReviewIdea): ReviewRange[] {
  return idea.anchors.filter((a) => a.kind === 'hunk').map((a) => a.range);
}

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
   * Whether this pull request's pack is in the pool. `available` is false on a
   * deployment with no pool desk — no pool selected, or no fleet name yet — where
   * there is nowhere to publish to and the page says so instead of offering a
   * control that could only refuse.
   */
  const sharing = (prNumber: number): ReviewPackSharing => ({
    available: system.pool !== undefined,
    share: store.getReviewPackShare(prNumber),
  });

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
        } satisfies ReviewPackAbsence);
      }
      const { head, stale } = await reviewPacks.staleness(params.number, record.pack.headSha);
      return {
        ...record,
        marks: store.listReviewMarks(params.number),
        head,
        stale,
        checking: reviewPackChecker.checking(params.number),
        sharing: sharing(params.number),
      } satisfies ReviewPackPayload;
    }),
  );

  /**
   * Share the pull request's current pack into the pool — **a second, deliberate
   * act**, and never something asking for a pack does. `202`, accepted rather
   * than done: the document goes out on the pool's own clock, because a route
   * that did the network write would make the click wait on a push to another
   * continent and report a failure there as a failure here
   * (`docs/spec/28-cross-fleet-pool.md#the-publish-is-never-inside-a-route-handler`).
   *
   * Refused with a 409 for a deployment with no pool, for a pull request with no
   * pack, and — the one that matters — by the secret backstop, which names the
   * line it stopped on and rewrites nothing.
   */
  app.post(
    '/api/prs/:number/review-pack/share',
    checked({ params: PrNumberParams }, async ({ params, reply }) => {
      if (!system.pool) {
        return reply.code(409).send({
          error: 'this deployment publishes to no pool — set integrations.pool and the fleet name to share a pack',
        });
      }
      const outcome = system.pool.shareReviewPack(params.number);
      if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });
      return reply.code(202).send(sharing(params.number) satisfies ReviewPackSharing);
    }),
  );

  /**
   * Take a shared pack back out of the pool — the inverse of the share, and the
   * same shape: `202`, because the removal is the pool's own arm's and never a
   * route handler's. A pack shared by mistake is out on the next pulse rather
   * than at the prune, which is weeks away.
   *
   * Unsharing something nobody shared is answered as done: the caller wanted it
   * out of the pool, and it is. → `docs/spec/31-review-packs.md#unsharing-a-pack`
   */
  app.post(
    '/api/prs/:number/review-pack/unshare',
    checked({ params: PrNumberParams }, async ({ params, reply }) => {
      if (!system.pool) {
        return reply.code(409).send({ error: 'this deployment publishes to no pool, so nothing is shared' });
      }
      system.pool.unshareReviewPack(params.number);
      return reply.code(202).send(sharing(params.number) satisfies ReviewPackSharing);
    }),
  );

  /**
   * What the packs say about the agents that wrote them — the overrides, the
   * plumbing ratio and whether false claims get read. **The operator's reading and
   * nobody else's**: it is never shown to the checker, because a label that has
   * learned to agree with its reader has stopped being evidence, and nothing here
   * reaches a prompt.
   *
   * It lives in this module because the review packs are the group that owns it,
   * and it obeys the Insights page's window like every other reading there.
   * → `docs/spec/31-review-packs.md#the-operators-reading`, `docs/spec/16-http-api.md`
   */
  app.get(
    '/api/review-calibration',
    checked({ query: InsightsQuery }, async ({ query }) => {
      const now = Date.now();
      const window = resolveWindow(query.window, now, store.readRateLimits());
      const packs = store.listCurrentReviewPacks();
      const earliest = packs.reduce<number | null>(
        (oldest, record) => Math.min(oldest ?? Infinity, new Date(record.writtenAt).getTime()),
        null,
      );
      return {
        calibration: buildReviewCalibration({
          packs,
          marks: store.listAllReviewMarks(),
          // The durable record of a merge, not the world's: the world drops a
          // closed pull request after `closedPrWindowMs`, and a merge that fell
          // out of it must not read as a pull request that never merged.
          merged: new Set(
            store
              .listWorkNodes()
              .filter((node) => node.status === 'merged' && node.ref.startsWith('pr:'))
              .map((node) => Number(node.ref.slice('pr:'.length)))
              .filter((n) => Number.isInteger(n)),
          ),
          window: windowView(window, timelineSpan(window, earliest)),
        }),
      } satisfies ReviewCalibrationPayload;
    }),
  );

  /**
   * A reviewer's three marks on an idea, each its own column on the same rows. The
   * idea is resolved in the **current** pack and the write is keyed to the hunks
   * it owns at that pack's head — so a mark survives the pack being rewritten,
   * and lands on whichever idea owns those hunks next time. Refused when there is
   * no pack, when the idea is not in the current one (the pack was rewritten
   * under the page — reload it), and when the idea owns no hunk at all (a walk of
   * regions only), since the mark would have nothing to ride on and would read
   * as taken.
   */
  const resolve = (params: {
    number: number;
    id: string;
  }):
    | { ok: true; prNumber: number; headSha: string; hunks: ReviewRange[] }
    | { ok: false; status: 404 | 409; error: string } => {
    const record = store.getCurrentReviewPack(params.number);
    if (!record) return { ok: false, status: 404, error: `no review pack for #${params.number}` };
    const idea = record.pack.ideas.find((i) => i.id === params.id);
    if (!idea) {
      return {
        ok: false,
        status: 404,
        error: `no idea ${params.id} in the current pack for #${params.number}; the pack may have been rewritten`,
      };
    }
    const hunks = ownedHunks(idea);
    if (hunks.length === 0) {
      return {
        ok: false,
        status: 409,
        error: `idea ${params.id} owns no changed code, so a mark on it has nothing to ride on`,
      };
    }
    return { ok: true, prNumber: params.number, headSha: record.pack.headSha, hunks };
  };

  app.post(
    '/api/prs/:number/review-pack/ideas/:id/read',
    checked({ params: IdeaParams, body: ReadBody }, async ({ params, body, reply }) => {
      const target = resolve(params);
      if (!target.ok) return reply.code(target.status).send({ error: target.error });
      store.markReviewIdeaRead({
        prNumber: target.prNumber,
        headSha: target.headSha,
        hunks: target.hunks,
        read: body.read,
      });
      return { marks: store.listReviewMarks(params.number) } satisfies ReviewMarksPayload;
    }),
  );

  /**
   * The reader took the finding on this idea's false claim. The third mark, and
   * the one that measures the four surface requirements *What a false claim does*
   * makes: a pull request that merged while this was unset is a false claim
   * nobody read, which is the number those requirements stand in for.
   * → `docs/spec/31-review-packs.md#whether-prominence-works`
   *
   * Not refused on an idea with no false claim: the mark rides on hunks and the
   * page only offers it under a finding, and a route that second-guessed the
   * document would be the renderer's rule stated twice.
   */
  app.post(
    '/api/prs/:number/review-pack/ideas/:id/seen',
    checked({ params: IdeaParams, body: SeenBody }, async ({ params, body, reply }) => {
      const target = resolve(params);
      if (!target.ok) return reply.code(target.status).send({ error: target.error });
      store.markReviewFindingSeen({
        prNumber: target.prNumber,
        headSha: target.headSha,
        hunks: target.hunks,
        seen: body.seen,
      });
      return { marks: store.listReviewMarks(params.number) } satisfies ReviewMarksPayload;
    }),
  );

  app.post(
    '/api/prs/:number/review-pack/ideas/:id/attention',
    checked({ params: IdeaParams, body: AttentionBody }, async ({ params, body, reply }) => {
      const target = resolve(params);
      if (!target.ok) return reply.code(target.status).send({ error: target.error });
      store.overrideReviewAttention({
        prNumber: target.prNumber,
        headSha: target.headSha,
        hunks: target.hunks,
        attention: body.attention,
      });
      return { marks: store.listReviewMarks(params.number) } satisfies ReviewMarksPayload;
    }),
  );
}
