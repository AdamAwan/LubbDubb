import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { absentOr } from '../../schemaErrors.js';
import type { SetupPayload, SetupResolvePayload } from '../../wire.js';
import { RealSetupProbes } from '../../setup/probes.js';
import { buildSetupReading } from '../../setup/reading.js';
import { resolveFromRepo } from '../../setup/resolve.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system, hub, setup }: RouteContext): void {
  const probes = new RealSetupProbes();

  app.get('/api/setup', async () => {
    const reading = (await buildSetupReading({
      config: system.config,
      store: system.store,
      probes,
      configFile: system.configFile,
      pending: system.liveConfig.pending(),
      prompts: system.prompts,
    })) satisfies SetupPayload;
    const changed = JSON.stringify(reading.checks) !== JSON.stringify(setup.latest?.checks ?? null);
    setup.latest = reading;
    if (changed) hub.broadcast({ type: 'dirty', sections: ['asks'] });
    return reading;
  });

  const ResolveBody = z.object({
    email: z.string(absentOr('email is required', 'email must be a string')).trim(),
    repoRoot: z
      .string(absentOr('repoRoot is required', 'repoRoot must be a string'))
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
