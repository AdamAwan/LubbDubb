import type { FastifyInstance } from 'fastify';
import { DISCUSSION_AUTHORS, DISCUSSIONS_OFF } from '../../discussions/discussionFile.js';
import { readDiscussion } from '../../discussions/related.js';
import { knownDiscussionSubject } from '../../discussions/subject.js';
import { goalMergedPrs } from '../../environments/landings.js';
import { watchOutcomeKey, watchOutcomeNote } from '../../environments/watchOutcome.js';
import { issueOrigin } from '../../plans/planning.js';
import type { DiscussionReading } from '../../wire.js';
import { goalWatchOutcome, readGoalWatchRecords } from '../stateEnvironmentViews.js';
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
      const world = store.world.getWorldBaseline();
      const found = knownDiscussionSubject(
        system.discussions,
        world?.issues ?? [],
        params.number,
        config.issueContainerTypes,
      );
      if (!found.ok) return reply.code(404).send({ error: found.error });
      const goal = readGoalWatchRecords(store, issueOrigin(params.number));
      const outcome = goalWatchOutcome(config.environments, goal);
      if (outcome?.discussable !== true)
        return reply.code(409).send({
          error: 'only a watch that made something worse, or could not tell, is put to a discussion',
        });
      const key = watchOutcomeKey(outcome, goal.windows);
      const doc = system.discussions.read(params.number);
      const already = doc?.entries.find((e) => e.author === DISCUSSION_AUTHORS.watch && e.body.includes(key));
      if (doc !== null && already !== undefined) return { ok: true, entry: already, path: doc.path };
      const body = watchOutcomeNote({
        outcome,
        checks: goal.checks,
        windows: goal.windows,
        environments: config.environments,
        pullRequests: goalMergedPrs(goal.goalRef, store.environments.listGoalLandings(), world),
      });
      const written = system.discussions.add(found.subject, { kind: 'note', body, author: DISCUSSION_AUTHORS.watch });
      if (!written.ok) return reply.code(500).send({ error: written.error });
      hub.broadcast({ type: 'dirty', sections: ['goals', 'queue'] });
      return { ok: true, entry: written.entry, path: written.path };
    }),
  );
}
