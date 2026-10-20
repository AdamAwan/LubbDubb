import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppErrorSearchPayload, AppErrorsPayload } from '../../wire.js';
import {
  fileAppErrorBug,
  reopenAppErrorTicket,
  type AppErrorFilingDeps,
  type PressOutcome,
} from '../../appErrors/filing.js';
import { issueWatchContext } from '../../issueWatch.js';
import { checked, requiredText } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md, docs/spec/39-app-errors.md#on-the-wire, docs/spec/39-app-errors.md#the-presses

const GroupBody = z.object({
  environment: requiredText('environment is required'),
  fingerprint: requiredText('fingerprint is required'),
  investigate: z.boolean({ error: 'investigate must be a boolean' }).optional(),
  unsearched: z.boolean({ error: 'unsearched must be a boolean' }).optional(),
});

const KeyBody = z.object({
  key: requiredText('key is required').refine((key) => key.startsWith('err:'), 'key must be an app error key (err:…)'),
});

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, config, errors, sink } = system;
  const current = (): Promise<AppErrorsPayload> => system.appErrorPayloads.read(Date.now());
  const deps = (): AppErrorFilingDeps => ({
    tracker: system.appErrorTracker,
    filing: system.filing,
    prompts: system.prompts,
    watch: issueWatchContext({ store, connector: sink, errors, config }),
    current,
  });

  /** A press: what it did is broadcast, a refusal is its status, and a tracker that throws is a 502 on the log. */
  const pressRoute =
    <B>(what: string, work: (body: B) => Promise<PressOutcome>) =>
    async ({ body, reply }: { body: B; reply: FastifyReply }) => {
      let outcome: PressOutcome;
      try {
        outcome = await work(body);
      } catch (err) {
        const message = `the tracker refused the ${what}: ${(err as Error).message}`;
        errors.record({ source: 'server', message });
        outcome = { ok: false, status: 502, error: message };
      }
      if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });
      hub.broadcast({ type: 'world:changed' });
      return outcome;
    };

  app.get(
    '/api/app-errors',
    checked({}, (): Promise<AppErrorsPayload> => current()),
  );

  app.post(
    '/api/app-errors/file-bug',
    checked(
      { body: GroupBody },
      pressRoute('bug', (body: z.infer<typeof GroupBody>) =>
        fileAppErrorBug(deps(), {
          ...body,
          investigate: body.investigate ?? false,
          unsearched: body.unsearched ?? false,
        }),
      ),
    ),
  );

  app.post(
    '/api/app-errors/reopen',
    checked(
      { body: KeyBody },
      pressRoute('reopen', (body: z.infer<typeof KeyBody>) => reopenAppErrorTicket(deps(), sink, body.key)),
    ),
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
