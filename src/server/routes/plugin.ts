import type { FastifyInstance } from 'fastify';
import type { PluginInstallPayload, PluginStatusPayload } from '../../wire.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { plugin } = system;

  app.get(
    '/api/plugin',
    checked({}, async () => (await plugin.status()) satisfies PluginStatusPayload),
  );

  app.post(
    '/api/plugin/install',
    { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    checked({}, async () => (await plugin.install()) satisfies PluginInstallPayload),
  );
}
