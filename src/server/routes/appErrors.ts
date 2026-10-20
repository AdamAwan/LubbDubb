import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppErrorSearchPayload, AppErrorsPayload } from '../../wire.js';
import { currentAppErrors } from '../../appErrors/current.js';
import {
  fileAppErrorBug,
  reopenAppErrorTicket,
  type AppErrorFilingDeps,
  type PressOutcome,
} from '../../appErrors/filing.js';
import { issueWatchContext } from '../../issueWatch.js';
import { trackerCoordinates } from '../../mcp/findings.js';
import { checked, requiredText } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md, docs/spec/39-app-errors.md#on-the-wire, docs/spec/39-app-errors.md#the-presses

const GroupBody = z.object({
  environment: requiredText('environment is required'),
  fingerprint: requiredText('fingerprint is required'),
  unsearched: z.boolean({ error: 'unsearched must be a boolean' }).optional(),
});

const KeyBody = z.object({
  key: requiredText('key is required').refine((key) => key.startsWith('err:'), 'key must be an app error key (err:…)'),
});

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, config, errors } = system;
  const current = (): AppErrorsPayload => currentAppErrors(store, config, Date.now());
  const deps = (): AppErrorFilingDeps => ({
    tracker: system.appErrorTracker,
    sink: system.appErrorTracker.sink,
    filing: system.filing,
    prompts: system.prompts,
    watch: issueWatchContext({ store, connector: system.appErrorTracker.sink, errors, config }),
    current,
    trackerTarget: () => trackerCoordinates(config),
  });

  const press = async (what: string, work: () => Promise<PressOutcome>): Promise<PressOutcome> => {
    try {
      const outcome = await work();
      if (outcome.ok) hub.broadcast({ type: 'world:changed' });
      return outcome;
    } catch (err) {
      const message = `the tracker refused the ${what}: ${(err as Error).message}`;
      errors.record({ source: 'server', message });
      return { ok: false, status: 502, error: message };
    }
  };

  app.get(
    '/api/app-errors',
    checked({}, () => current() satisfies AppErrorsPayload),
  );

  app.post(
    '/api/app-errors/file-bug',
    checked({ body: GroupBody }, async ({ body, reply }) => {
      const outcome = await press('bug', () =>
        fileAppErrorBug(deps(), { ...body, investigate: false, unsearched: body.unsearched ?? false }),
      );
      return outcome.ok ? outcome : reply.code(outcome.status).send({ error: outcome.error });
    }),
  );

  app.post(
    '/api/app-errors/investigate',
    checked({ body: GroupBody }, async ({ body, reply }) => {
      const outcome = await press('bug', () =>
        fileAppErrorBug(deps(), { ...body, investigate: true, unsearched: body.unsearched ?? false }),
      );
      return outcome.ok ? outcome : reply.code(outcome.status).send({ error: outcome.error });
    }),
  );

  app.post(
    '/api/app-errors/reopen',
    checked({ body: KeyBody }, async ({ body, reply }) => {
      const outcome = await press('reopen', () => reopenAppErrorTicket(deps(), body.key));
      return outcome.ok ? outcome : reply.code(outcome.status).send({ error: outcome.error });
    }),
  );

  app.post(
    '/api/app-errors/search',
    checked({ body: KeyBody }, async ({ body, reply }) => {
      if (!system.appErrorTracker.searchable())
        return reply.code(409).send({ error: 'no tracker this deployment files into can be searched by key' });
      const search = (await system.appErrorTracker.search([body.key])).get(body.key)!;
      return { ok: true, search } satisfies AppErrorSearchPayload;
    }),
  );
}
