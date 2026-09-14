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
import { InsightsQuery, resolveWindow, timelineSpan, windowView } from '../../insights/insightsWindow.js';
import { checked, PrNumberParams, requiredBoolean } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

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

function ownedHunks(idea: ReviewIdea): ReviewRange[] {
  return idea.anchors.filter((a) => a.kind === 'hunk').map((a) => a.range);
}

export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store, reviewPacks, reviewPackChecker } = system;

  const sharing = (prNumber: number): ReviewPackSharing => ({
    available: system.pool !== undefined,
    share: store.reviewPacks.getReviewPackShare(prNumber),
  });

  app.post(
    '/api/prs/:number/review-pack',
    checked({ params: PrNumberParams }, async ({ params, reply }) => {
      const outcome = reviewPacks.request(params.number);
      if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });
      return reply.code(202).send({ ok: true, prNumber: outcome.prNumber, headSha: outcome.headSha });
    }),
  );

  app.get(
    '/api/prs/:number/review-pack',
    checked({ params: PrNumberParams }, async ({ params, reply }) => {
      const record = store.reviewPacks.getCurrentReviewPack(params.number);
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
        marks: store.reviewPacks.listReviewMarks(params.number),
        head,
        stale,
        checking: reviewPackChecker.checking(params.number),
        sharing: sharing(params.number),
      } satisfies ReviewPackPayload;
    }),
  );

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

  app.get(
    '/api/review-calibration',
    checked({ query: InsightsQuery }, async ({ query }) => {
      const now = Date.now();
      const window = resolveWindow(query.window, now, store.rateLimits.readRateLimits());
      const packs = store.reviewPacks.listCurrentReviewPacks();
      const earliest = packs.reduce<number | null>(
        (oldest, record) => Math.min(oldest ?? Infinity, new Date(record.writtenAt).getTime()),
        null,
      );
      return {
        calibration: buildReviewCalibration({
          packs,
          marks: store.reviewPacks.listAllReviewMarks(),
          merged: new Set(
            store.graph
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

  const resolve = (params: {
    number: number;
    id: string;
  }):
    | { ok: true; prNumber: number; headSha: string; hunks: ReviewRange[] }
    | { ok: false; status: 404 | 409; error: string } => {
    const record = store.reviewPacks.getCurrentReviewPack(params.number);
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
      store.reviewPacks.markReviewIdeaRead({
        prNumber: target.prNumber,
        headSha: target.headSha,
        hunks: target.hunks,
        read: body.read,
      });
      return { marks: store.reviewPacks.listReviewMarks(params.number) } satisfies ReviewMarksPayload;
    }),
  );

  app.post(
    '/api/prs/:number/review-pack/ideas/:id/seen',
    checked({ params: IdeaParams, body: SeenBody }, async ({ params, body, reply }) => {
      const target = resolve(params);
      if (!target.ok) return reply.code(target.status).send({ error: target.error });
      store.reviewPacks.markReviewFindingSeen({
        prNumber: target.prNumber,
        headSha: target.headSha,
        hunks: target.hunks,
        seen: body.seen,
      });
      return { marks: store.reviewPacks.listReviewMarks(params.number) } satisfies ReviewMarksPayload;
    }),
  );

  app.post(
    '/api/prs/:number/review-pack/ideas/:id/attention',
    checked({ params: IdeaParams, body: AttentionBody }, async ({ params, body, reply }) => {
      const target = resolve(params);
      if (!target.ok) return reply.code(target.status).send({ error: target.error });
      store.reviewPacks.overrideReviewAttention({
        prNumber: target.prNumber,
        headSha: target.headSha,
        hunks: target.hunks,
        attention: body.attention,
      });
      return { marks: store.reviewPacks.listReviewMarks(params.number) } satisfies ReviewMarksPayload;
    }),
  );
}
