import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SetupPayload, SetupResolvePayload } from '../../wire.js';
import { RealSetupProbes } from '../../setup/probes.js';
import { buildSetupReading } from '../../setup/reading.js';
import { resolveFromRepo } from '../../setup/resolve.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system }: RouteContext): void {
  const probes = new RealSetupProbes();

  app.get(
    '/api/setup',
    async () =>
      (await buildSetupReading({
        config: system.config,
        store: system.store,
        probes,
        configFile: system.configFile,
        pending: system.liveConfig.pending(),
        prompts: system.prompts,
      })) satisfies SetupPayload,
  );

  const ResolveBody = z.object({
    email: z.string({ required_error: 'email is required', invalid_type_error: 'email must be a string' }).trim(),
    repoRoot: z
      .string({ required_error: 'repoRoot is required', invalid_type_error: 'repoRoot must be a string' })
      .trim()
      .min(1, 'repoRoot must name a directory'),
  });
  app.post(
    '/api/setup/resolve',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    checked({ body: ResolveBody }, async ({ body }) => {
      return (await resolveFromRepo(body, { probes, config: system.config })) satisfies SetupResolvePayload;
    }),
  );
}
