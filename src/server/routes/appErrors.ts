import type { FastifyInstance } from 'fastify';
import type { AppErrorsPayload } from '../../wire.js';
import { appErrorProject } from '../../appErrors/key.js';
import { appErrorsView } from '../../appErrors/view.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md, docs/spec/39-app-errors.md#on-the-wire

export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store, config } = system;

  app.get(
    '/api/app-errors',
    checked({}, async (): Promise<AppErrorsPayload> => {
      const now = Date.now();
      const payload = appErrorsView({
        environments: config.environments,
        reads: store.appErrors.listReads(),
        groups: store.appErrors.listGroups(),
        project: appErrorProject(config),
        minCount: config.appErrorMinCount,
        ignore: config.appErrorIgnore,
        now,
      });
      await system.appErrorLinks.link(payload, {
        landings: store.environments.listGoalLandings(),
        readings: store.environments.listEnvironmentReach(),
        nodes: store.graph.listWorkNodes(),
        now,
      });
      return payload;
    }),
  );
}
