import type { FastifyInstance } from 'fastify';
import { DISCUSSION_AUTHORS, DISCUSSIONS_OFF } from '../../discussions/discussionFile.js';
import { readDiscussion } from '../../discussions/related.js';
import { discussionSubject } from '../../discussions/subject.js';
import { hintEmptyReason, watchOutcome, watchOutcomeNote } from '../../environments/watchOutcome.js';
import { issueOrigin } from '../../plans/planning.js';
import type { DiscussionReading } from '../../wire.js';
import { checked, IssueNumberParams } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md, docs/spec/40-discussions.md#in-the-cockpit

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  app.get(
    '/api/discussions/:number',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    checked({ params: IssueNumberParams }, ({ params }): DiscussionReading => {
      const issues = system.store.world.getWorldBaseline()?.issues ?? [];
      return readDiscussion(system.discussions, issues, params.number, system.config.issueContainerTypes).reading;
    }),
  );

  /** → docs/spec/29-post-deploy-watch.md#discussing-an-outcome */
  app.post(
    '/api/discussions/:number/watch-outcome',
    checked({ params: IssueNumberParams }, ({ params, reply }) => {
      if (!system.discussions.enabled) return reply.code(409).send({ error: DISCUSSIONS_OFF });
      const { store, config } = system;
      const goalRef = issueOrigin(params.number);
      const checks = store.watches.listGoalWatches();
      const windows = store.watches.listWatchWindows();
      const outcome = watchOutcome({
        goalRef,
        checks,
        windows,
        readings: store.watches.listWatchReadings(),
        emptyReason: hintEmptyReason(store.plans.getPlanByOrigin(goalRef)?.watchHint),
      });
      if (outcome?.outcome !== 'worse' && outcome?.outcome !== 'unknown')
        return reply.code(409).send({
          error: 'only a watch that made something worse, or could not tell, is put to a discussion',
        });
      const world = store.world.getWorldBaseline();
      const titles = new Map((world?.closedPullRequests ?? []).map((p) => [p.number, p.title]));
      const numbers = [
        ...new Set(
          store.environments
            .listGoalLandings()
            .filter((l) => l.goalRef === goalRef)
            .map((l) => l.prNumber),
        ),
      ];
      const body = watchOutcomeNote({
        outcome,
        checks,
        windows,
        environments: config.environments,
        pullRequests: numbers.map((number) => ({ number, title: titles.get(number) ?? null })),
      });
      const written = system.discussions.add(
        discussionSubject(world?.issues ?? [], params.number, config.issueContainerTypes),
        { kind: 'note', body, author: DISCUSSION_AUTHORS.watch },
      );
      if (!written.ok) return reply.code(500).send({ error: written.error });
      hub.broadcast({ type: 'dirty', sections: ['goals', 'queue'] });
      return { ok: true, entry: written.entry, path: written.path };
    }),
  );
}
