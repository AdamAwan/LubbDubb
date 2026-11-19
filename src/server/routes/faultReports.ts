import type { FastifyInstance } from 'fastify';
import { FaultReporter } from '../../faultReports/sources.js';
import { failure } from '../../primitives.js';
import { installRoot } from '../../selfUpdate/buildStanding.js';
import type { RouteContext } from './context.js';
import type { FaultReports } from '../../wire.js';

// → docs/spec/16-http-api.md

const MAX_ENTRIES = 500;

export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store, config, errors } = system;
  const root = installRoot();
  const reporter = root === null ? null : new FaultReporter(root, config);

  app.get('/api/errors/reports', async (): Promise<FaultReports> => {
    if (reporter === null)
      return {
        reports: [],
        unavailable: 'LubbDubb is not running from a git checkout, so it cannot check a report against its own source',
      };
    try {
      const reports = await reporter.compose(store.errors.listErrors(MAX_ENTRIES), new Date().toISOString());
      return { reports, unavailable: null };
    } catch (err) {
      const message = failure(err);
      errors.record({ source: 'server', message: `composing fault reports failed: ${message}` });
      return { reports: [], unavailable: `composing the reports failed: ${message}` };
    }
  });
}
