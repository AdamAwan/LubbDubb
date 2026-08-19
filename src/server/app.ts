import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { System } from '../system.js';
import { Hub } from './hub.js';
import {
  authRefusalHint,
  authorizeRequest,
  createAuthThrottle,
  describeAuthAttempt,
  resolveCockpitToken,
} from './auth.js';
import { debugLog } from '../debug.js';
import type { RouteModule } from './routes/context.js';
import { register as registerAgents } from './routes/agents.js';
import { artifactSignerFor, attachmentSignerFor, register as registerArtifacts } from './routes/artifacts.js';
import { register as registerControl } from './routes/control.js';
import { register as registerEscalations } from './routes/escalations.js';
import { register as registerFindings } from './routes/findings.js';
import { register as registerHumanTasks } from './routes/humanTasks.js';
import { register as registerIssues } from './routes/issues.js';
import { register as registerJobs } from './routes/jobs.js';
import { register as registerLessons } from './routes/lessons.js';
import { register as registerPets } from './routes/pets.js';
import { register as registerPlans } from './routes/plans.js';
import { register as registerReadings } from './routes/readings.js';
import { register as registerReliability } from './routes/reliability.js';
import { register as registerSchedules } from './routes/schedules.js';
import { register as registerSpend } from './routes/spend.js';
import { register as registerTickets } from './routes/tickets.js';
import { register as registerUpgrade } from './routes/upgrade.js';
import { register as registerStacks } from './routes/stacks.js';
import { register as registerState } from './routes/state.js';
import { register as registerValidation } from './routes/validation.js';
import { register as registerWork } from './routes/work.js';

/**
 * Every route module, in the order `buildApp` mounts them. Fastify does not care
 * about the order, so this list is read rather than depended on — it is the one
 * place that says what the surface consists of, and `test/cockpitAuth.test.ts`
 * and `test/requestValidation.test.ts` walk the directory it names rather than a
 * single file, so a group added later is covered on the day it is written.
 */
const ROUTE_MODULES: RouteModule[] = [
  registerState,
  registerAgents,
  registerArtifacts,
  registerControl,
  registerEscalations,
  registerFindings,
  registerHumanTasks,
  registerIssues,
  registerJobs,
  registerLessons,
  registerPets,
  registerPlans,
  registerReadings,
  registerReliability,
  registerSchedules,
  registerSpend,
  registerStacks,
  registerTickets,
  registerUpgrade,
  registerValidation,
  registerWork,
];

/** Bind addresses that mean "this machine only" — the ones the Host check is sound for. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

interface BuiltApp {
  app: FastifyInstance;
  hub: Hub;
  /** The cockpit URL to open, token fragment included, or null when auth is off. */
  cockpitUrl: string | null;
  /** Where a minted token was persisted, for the banner. Null when it came from the env or auth is off. */
  tokenPath: string | null;
}

/**
 * Builds the cockpit HTTP + WebSocket surface. REST for actions and state,
 * WebSocket for live streaming, and (in production) the built SPA served from
 * `web/dist`. Returns the Fastify instance and the hub so `main.ts` can wire the
 * harness lifecycle around it and tests can drive it via `.inject()`, plus the
 * tokenised URL for the startup banner.
 *
 * **Wiring and nothing else (issue #237).** The routes live one group per module
 * under `routes/`, the state snapshot in `stateSnapshot.ts`; what is left here is
 * the three things that are genuinely the whole surface's — the auth hook, the
 * error handler, and the socket — plus the composition that mounts the rest. The
 * same facade shape `Store` has over `src/store/`, and for the same reason: a
 * file holding every route had no natural stopping size.
 */
export async function buildApp(system: System): Promise<BuiltApp> {
  const app = Fastify({ logger: false });
  const hub = new Hub(system);

  // Registered before every route and plugin below, because a Fastify hook is
  // inherited only by contexts created after it — the `/ws` route lives in a
  // child context, and adding this later would leave the live transcript stream
  // (source code, agent output) as the one unguarded surface.
  const auth = system.config.auth.enabled ? resolveCockpitToken(system.config.auth.tokenFile) : null;
  if (auth) {
    const requireLoopbackHost = LOOPBACK_HOSTS.has(system.config.host);
    // Only refusals are counted, so the cockpit's continuous state polling can
    // never throttle itself — the same reason rate limiting is registered
    // `global: false` below.
    const throttle = createAuthThrottle();
    // The *first* refusal of a run is recorded, and every one after it goes to
    // the opt-in debug log. A cockpit that cannot authenticate polls, so logging
    // each one would bury the only one that matters under thousands of copies of
    // itself — while logging none is how a stale bundle stays invisible through
    // restarts and hard refreshes. The first line names the cause; the flag is
    // there for when the cause changes between requests.
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
      const verdict = authorizeRequest(attempt, {
        token: auth.token,
        requireLoopbackHost,
        throttled: throttle.blocked(req.ip, now),
      });
      if (verdict.ok) return;
      throttle.fail(req.ip, now);
      const summary = `${verdict.code} ${verdict.error} — ${describeAuthAttempt(attempt)}`;
      if (refused) {
        debugLog('auth', summary);
      } else {
        refused = true;
        const hint = authRefusalHint(attempt);
        system.errors.record({
          source: 'server',
          message: 'cockpit refused a request — the first of this run',
          // JSON-encoded: every field in the summary is an attacker-controlled
          // header, and a newline in an Origin would otherwise forge a second,
          // fake log line. (`debugLog` does its own encoding.)
          detail: [
            JSON.stringify(summary),
            ...(hint ? [hint] : []),
            'Set LUBBDUBB_DEBUG=1 to log every refusal, not just the first.',
          ].join('\n'),
        });
      }
      // A refused *upgrade* needs its connection torn down explicitly. The client
      // asked to switch protocols and got an ordinary response instead, which
      // leaves a socket that belongs to neither side's bookkeeping — the HTTP
      // server no longer counts it, so `app.close()` waits on it forever and the
      // harness never shuts down. `Connection: close` makes node end it with the
      // response.
      if (req.headers.upgrade) {
        reply.header('connection', 'close');
        reply.raw.once('finish', () => reply.raw.socket?.destroy());
      }
      // Returning the reply is what tells Fastify the lifecycle is over —
      // without it the route handler still runs.
      return reply.code(verdict.code).send({ error: verdict.error });
    });
  }

  await app.register(websocket);
  // Opt-in rate limiting (`global: false`): only routes that set `config.rateLimit`
  // are limited, so the cockpit's frequent state polling is never throttled. The
  // artifact route opts in because it reads files off disk.
  await app.register(rateLimit, { global: false });

  const { config, errors } = system;

  // How the artifact route authorizes a browser *navigation*. The `/artifacts`
  // route sits outside the `/api` prefix on purpose (see `routes/artifacts.ts`),
  // so the bearer-token guard doesn't apply and it must authorize itself. It does
  // so with a per-flag capability: a fresh per-run secret signs `<flag id>.<expiry>`,
  // the signer mints one into every artifact URL the snapshot ships, and the route
  // verifies it against the flag id in its own path. A per-run key (not the cockpit
  // token) means a capability is never the cockpit token even derived. Null when
  // auth is off — the whole surface is then open by the operator's choice and
  // loopback-only, so there is nothing to verify against.
  const artifactKey = auth ? randomBytes(32) : null;

  // An unanticipated throw in a route must not vanish into a silent 500: record
  // it to the error log (which also mirrors it to stderr and streams it to the
  // cockpit), then return a plain 500.
  // fastify 5 types the handler's error as `unknown` — a route may throw a
  // non-Error, and the recorded message must not read as "undefined".
  app.setErrorHandler((err: unknown, req, reply) => {
    const message = err instanceof Error ? err.message : String(err);
    errors.record({
      source: 'server',
      message: `${req.method} ${req.url} failed: ${message}`,
      detail: err instanceof Error ? (err.stack ?? null) : null,
    });
    return reply.code(500).send({ error: message });
  });

  // Roll for a pet after any successful write, so a creature that an operator's
  // click earned appears while they are still looking at the screen rather than
  // at the next pulse.
  //
  // One hook rather than a call in each settling route, and that is the point:
  // the scan is idempotent — an action already rolled is skipped by key, and the
  // roll is a hash — so calling it after every write costs a few small reads and
  // **cannot be forgotten by a route written later**. `cycle:end` still runs it,
  // which is what guarantees delivery for anything that settles off the surface.
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'POST' || reply.statusCode >= 400) return;
    try {
      system.pets.scan();
    } catch (err) {
      errors.record({ source: 'server', message: `Pet scan failed: ${(err as Error).message}` });
    }
  });

  // -- Live stream ---------------------------------------------------------
  app.register(async (scoped) => {
    scoped.get('/ws', { websocket: true }, (socket) => {
      hub.add(socket);
      socket.on('message', (raw) => hub.handleClientMessage(socket, raw.toString()));
      socket.send(JSON.stringify({ type: 'dirty' }));
    });
  });

  // -- Routes --------------------------------------------------------------
  const ctx = {
    system,
    hub,
    artifactKey,
    artifactSigner: artifactKey ? artifactSignerFor(artifactKey) : undefined,
    attachmentSigner: artifactKey ? attachmentSignerFor(artifactKey) : undefined,
  };
  for (const registerRoutes of ROUTE_MODULES) registerRoutes(app, ctx);

  // -- Static SPA (production build) --------------------------------------
  const distDir = resolve(process.cwd(), 'web/dist');
  if (existsSync(distDir)) {
    await app.register(fastifyStatic, { root: distDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  // `0.0.0.0` is a bind address, not somewhere to point a browser; a URL built
  // from it lands nowhere. Loopback is the honest thing to print in that case —
  // the operator exposing the port knows their own hostname, and the token in the
  // fragment is what actually matters to them.
  const urlHost = LOOPBACK_HOSTS.has(config.host) ? config.host : '127.0.0.1';
  return {
    app,
    hub,
    cockpitUrl: auth ? `http://${urlHost}:${config.port}/#t=${auth.token}` : null,
    tokenPath: auth?.source === 'minted' ? auth.path : null,
  };
}
