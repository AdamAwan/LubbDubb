import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fleetWorksUpstream, UPSTREAM_REPO } from '../../tickets/upstream.js';
import { watchLabelFor } from '../../watchLabels.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';
import type { FilingTargetProbe, IssueFiled } from '../../wire.js';

// → docs/spec/16-http-api.md

const MAX_ISSUE_BODY = 4000;

const MAX_ISSUE_TITLE = 200;

const PROBE_TIMEOUT_MS = 8000;

function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { config, errors } = system;
  const watchLabel = watchLabelFor(config.labelPrefix);

  app.get('/api/issues/filing-target', async (): Promise<FilingTargetProbe> => {
    try {
      const target = await withDeadline(
        system.upstream.describeTarget(),
        PROBE_TIMEOUT_MS,
        `the GitHub CLI did not answer within ${PROBE_TIMEOUT_MS / 1000}s`,
      );
      return { available: true, reason: null, watchable: fleetWorksUpstream(config), ...target };
    } catch (err) {
      const message = (err as Error).message;
      errors.record({ source: 'provider', message: `the filing-target probe failed: ${message}` });
      return { available: false, target: null, identity: null, reason: message };
    }
  });

  const RaiseIssueBody = z.object({
    title: z
      .string({ required_error: 'title is required', invalid_type_error: 'title must be a string' })
      .trim()
      .min(1, 'title is required — say what this is about')
      .max(MAX_ISSUE_TITLE, `title is too long (max ${MAX_ISSUE_TITLE} characters)`),
    body: z
      .string({ required_error: 'body is required', invalid_type_error: 'body must be a string' })
      .trim()
      .min(1, 'body is required — say what should happen')
      .max(MAX_ISSUE_BODY, `body is too long (max ${MAX_ISSUE_BODY} characters)`),
    watch: z.boolean({ invalid_type_error: 'watch must be a boolean' }).optional().default(false),
  });
  app.post(
    '/api/issues',
    checked({ body: RaiseIssueBody }, async ({ body, reply }) => {
      const watchable = fleetWorksUpstream(config);
      let filed: { number: number; url: string };
      try {
        filed = await system.upstream.create({
          title: body.title,
          body: body.body,
          labels: body.watch && watchable ? [watchLabel] : [],
        });
      } catch (err) {
        const message = (err as Error).message;
        errors.record({ source: 'provider', message: `filing an issue from the cockpit failed: ${message}` });
        return reply.code(502).send({ error: `${UPSTREAM_REPO} refused the issue: ${message}` });
      }
      const answer: IssueFiled = { ok: true, number: filed.number, url: filed.url };
      return answer;
    }),
  );
}
