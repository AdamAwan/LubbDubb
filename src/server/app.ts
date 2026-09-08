import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { System } from '../system.js';
import { Hub } from './hub.js';
import { authRefusalHint, createAuthThrottle, describeAuthAttempt, guardRequest, resolveCockpitToken } from './auth.js';
import { debugLog } from '../debug.js';
import type { RouteModule } from './routes/context.js';
import { register as registerAgents } from './routes/agents.js';
import { register as registerAllowance } from './routes/allowance.js';
import {
  artifactSignerFor,
  attachmentSignerFor,
  localValidationFileSignerFor,
  register as registerArtifacts,
} from './routes/artifacts.js';
import { register as registerControl } from './routes/control.js';
import { register as registerEjections } from './routes/ejections.js';
import { register as registerEscalations } from './routes/escalations.js';
import { register as registerFeatures } from './routes/features.js';
import { register as registerHumanTasks } from './routes/humanTasks.js';
import { register as registerIngress } from './routes/ingress.js';
import { register as registerIssues } from './routes/issues.js';
import { register as registerJobs } from './routes/jobs.js';
import { register as registerLocalRun } from './routes/localRun.js';
import { register as registerLocalValidation } from './routes/localValidation.js';
import { register as registerMcpUsage } from './routes/mcpUsage.js';
import { register as registerObstacles } from './routes/obstacles.js';
import { register as registerPets } from './routes/pets.js';
import { register as registerPool } from './routes/pool.js';
import { register as registerPlans } from './routes/plans.js';
import { register as registerPrs } from './routes/prs.js';
import { register as registerReadings } from './routes/readings.js';
import { register as registerReliability } from './routes/reliability.js';
import { register as registerThroughput } from './routes/throughput.js';
import { register as registerReviewPacks } from './routes/reviewPacks.js';
import { register as registerSetup } from './routes/setup.js';
import { register as registerSchedules } from './routes/schedules.js';
import { register as registerSpend } from './routes/spend.js';
import { register as registerTickets } from './routes/tickets.js';
import { register as registerUpgrade } from './routes/upgrade.js';
import { register as registerUsage } from './routes/usage.js';
import { register as registerStacks } from './routes/stacks.js';
import { register as registerState } from './routes/state.js';
import { register as registerWatches } from './routes/watches.js';
import { register as registerValidation } from './routes/validation.js';
import { register as registerWork } from './routes/work.js';

// → docs/spec/16-http-api.md#shape

const ROUTE_MODULES: RouteModule[] = [
  registerState,
  registerAgents,
  registerAllowance,
  registerArtifacts,
  registerControl,
  registerEjections,
  registerEscalations,
  registerFeatures,
  registerHumanTasks,
  registerIngress,
  registerIssues,
  registerJobs,
  registerLocalRun,
  registerLocalValidation,
  registerMcpUsage,
  registerObstacles,
  registerPets,
  registerPool,
  registerPlans,
  registerPrs,
  registerReadings,
  registerReliability,
  registerThroughput,
  registerReviewPacks,
  registerSchedules,
  registerSetup,
  registerSpend,
  registerStacks,
  registerTickets,
  registerUpgrade,
  registerUsage,
  registerValidation,
  registerWatches,
  registerWork,
];

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function clientRefusalStatus(err: unknown): number | null {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : null;
}

interface BuiltApp {
  app: FastifyInstance;
  hub: Hub;
  cockpitUrl: string | null;
  tokenPath: string | null;
}

export async function buildApp(system: System): Promise<BuiltApp> {
  const app = Fastify({ logger: false });
  const hub = new Hub(system);

  const auth = system.config.auth.enabled ? resolveCockpitToken(system.config.auth.tokenFile) : null;
  if (auth) {
    const requireLoopbackHost = LOOPBACK_HOSTS.has(system.config.host);
    const throttle = createAuthThrottle();
    let refused = false;
    app.addHook('onRequest', async (req, reply) => {
      const now = Date.now();
      const attempt = {
        url: req.url,
        host: req.headers.host,
        origin: req.headers.origin,
        authorization: req.headers.authorization,
        queryToken:
          typeof (req.query as { t?: unknown } | undefined)?.t === 'string'
            ? (req.query as { t: string }).t
            : undefined,
      };
      const verdict = guardRequest(attempt, {
        token: auth.token,
        requireLoopbackHost,
        throttle,
        key: req.ip,
        now,
      });
      if (verdict.ok) return;
      const summary = `${verdict.code} ${verdict.error} — ${describeAuthAttempt(attempt)}`;
      if (refused) {
        debugLog('auth', summary);
      } else {
        refused = true;
        const hint = authRefusalHint(attempt);
        system.errors.record({
          source: 'server',
          message: 'cockpit refused a request — the first of this run',
          detail: [
            JSON.stringify(summary),
            ...(hint ? [hint] : []),
            'Set LUBBDUBB_DEBUG=1 to log every refusal, not just the first.',
          ].join('\n'),
        });
      }
      if (req.headers.upgrade) {
        reply.header('connection', 'close');
        reply.raw.once('finish', () => reply.raw.socket?.destroy());
      }
      return reply.code(verdict.code).send({ error: verdict.error });
    });
  }

  await app.register(websocket);
  await app.register(rateLimit, { global: false });

  const { config, errors } = system;

  const artifactKey = auth ? randomBytes(32) : null;

  app.setErrorHandler((err: unknown, req, reply) => {
    const message = err instanceof Error ? err.message : String(err);
    const status = clientRefusalStatus(err);
    if (status !== null) return reply.code(status).send({ error: message });
    errors.record({
      source: 'server',
      message: `${req.method} ${req.url} failed: ${message}`,
      detail: err instanceof Error ? (err.stack ?? null) : null,
    });
    return reply.code(500).send({ error: message });
  });

  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'POST' || reply.statusCode >= 400) return;
    try {
      system.pets.scan();
    } catch (err) {
      errors.record({ source: 'server', message: `Pet scan failed: ${(err as Error).message}` });
    }
  });

  app.register(async (scoped) => {
    scoped.get('/ws', { websocket: true }, (socket) => {
      hub.add(socket);
      socket.on('message', (raw) => hub.handleClientMessage(socket, raw.toString()));
      socket.send(JSON.stringify({ type: 'dirty' }));
    });
  });

  const ctx = {
    system,
    hub,
    artifactKey,
    artifactSigner: artifactKey ? artifactSignerFor(artifactKey) : undefined,
    attachmentSigner: artifactKey ? attachmentSignerFor(artifactKey) : undefined,
    localValidationFileSigner: artifactKey ? localValidationFileSignerFor(artifactKey) : undefined,
  };
  for (const registerRoutes of ROUTE_MODULES) registerRoutes(app, ctx);

  const distDir = resolve(process.cwd(), 'web/dist');
  if (existsSync(distDir)) {
    await app.register(fastifyStatic, { root: distDir });
    app.setNotFoundHandler((req, reply) => {
      if (!wantsAppShell(req.url)) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  const urlHost = LOOPBACK_HOSTS.has(config.host) ? config.host : '127.0.0.1';
  return {
    app,
    hub,
    cockpitUrl: auth ? `http://${urlHost}:${config.port}/#t=${auth.token}` : null,
    tokenPath: auth?.source === 'minted' ? auth.path : null,
  };
}

export function wantsAppShell(url: string): boolean {
  const path = url.split(/[?#]/)[0] ?? '/';
  if (path.startsWith('/api') || path.startsWith('/ws')) return false;
  return !path.slice(path.lastIndexOf('/') + 1).includes('.');
}
