import type { FastifyInstance } from 'fastify';
import { composeFaultReports } from '../../faultReports/compose.js';
import { harnessVocabulary, instanceTerms } from '../../faultReports/sources.js';
import { harnessBuild } from '../../pool/harnessVersion.js';
import { installRoot } from '../../selfUpdate/buildStanding.js';
import { UPSTREAM_REPO } from '../../tickets/upstream.js';
import type { RouteContext } from './context.js';
import type { FaultReports } from '../../wire.js';

// → docs/spec/16-http-api.md

const MAX_ENTRIES = 500;

export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store, config, errors } = system;

  app.get('/api/errors/reports', async (): Promise<FaultReports> => {
    const root = installRoot();
    if (root === null)
      return {
        reports: [],
        unavailable: 'LubbDubb is not running from a git checkout, so it cannot check a report against its own source',
      };
    try {
      const reports = composeFaultReports(store.errors.listErrors(MAX_ENTRIES), {
        root,
        vocabulary: harnessVocabulary(root),
        instanceTerms: instanceTerms(config),
        build: await harnessBuild(root),
        runtime: `node ${process.versions.node.split('.')[0]} · ${process.platform}`,
        now: new Date().toISOString(),
        newIssueBase: `https://github.com/${UPSTREAM_REPO}/issues/new`,
      });
      return { reports, unavailable: null };
    } catch (err) {
      const message = (err as Error).message;
      errors.record({ source: 'server', message: `composing fault reports failed: ${message}` });
      return { reports: [], unavailable: `composing the reports failed: ${message}` };
    }
  });
}
