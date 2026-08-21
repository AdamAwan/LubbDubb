import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SetupPayload, SetupResolvePayload } from '../../wire.js';
import { RealSetupProbes } from '../../setup/probes.js';
import { buildSetupReading } from '../../setup/reading.js';
import { resolveFromRepo } from '../../setup/resolve.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * The first-run surface's two reads. **Neither writes anything.**
 *
 * That is the whole shape of this module and the reason it is this short: what
 * Setup produces is a set of config keys, and those go to `POST /api/config` like
 * every other edit — through the same refusal ladder, the same surgical splice
 * and the same apply path a hand edit lands on. A second writer here would be a
 * second opinion about what a save means, and the first thing it would get wrong
 * is the one thing the config page is careful about: leaving the operator's
 * comments and key order alone.
 *
 * → `docs/spec/26-setup.md`, `docs/spec/16-http-api.md`
 */
export function register(app: FastifyInstance, { system }: RouteContext): void {
  // Constructed once per process rather than per request: the probes hold no
  // state, and the only thing a fresh one would buy is a fresh `process.env`
  // read — which `env()` does on every call anyway, because a credential
  // exported after boot is exactly the case the credential check exists for.
  const probes = new RealSetupProbes();

  // Fetched on open and after each answer rather than polled. It shells out to
  // git and to the agent binary, which is not a thing to do on a heartbeat — and
  // the `/api/state` snapshot is the wrong home for a reading whose whole subject
  // is the configuration that snapshot is built from.
  app.get(
    '/api/setup',
    async () =>
      (await buildSetupReading({
        config: system.config,
        store: system.store,
        probes,
        configFile: system.configFile,
        // What the file already answers, so a check stops asking for work the
        // operator has done. Read per request rather than closed over: the
        // watcher recomputes it on every apply, and this route is re-fetched the
        // moment one lands.
        pending: system.liveConfig.pending(),
      })) satisfies SetupPayload,
  );

  // A POST for a read, because the two answers are a body and not a path. The
  // rate limit is the honest reason to keep it off GET as well: this resolves a
  // directory the caller names and can reach the provider to ask who they are.
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
