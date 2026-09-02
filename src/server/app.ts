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
import { artifactSignerFor, attachmentSignerFor, register as registerArtifacts } from './routes/artifacts.js';
import { register as registerControl } from './routes/control.js';
import { register as registerEscalations } from './routes/escalations.js';
import { register as registerFeatures } from './routes/features.js';
import { register as registerHumanTasks } from './routes/humanTasks.js';
import { register as registerIngress } from './routes/ingress.js';
import { register as registerIssues } from './routes/issues.js';
import { register as registerJobs } from './routes/jobs.js';
import { register as registerKnowledge } from './routes/knowledge.js';
import { register as registerLocalRun } from './routes/localRun.js';
import { register as registerMcpUsage } from './routes/mcpUsage.js';
import { register as registerPets } from './routes/pets.js';
import { register as registerPool } from './routes/pool.js';
import { register as registerPlans } from './routes/plans.js';
import { register as registerPrs } from './routes/prs.js';
import { register as registerReadings } from './routes/readings.js';
import { register as registerReliability } from './routes/reliability.js';
import { register as registerReviewPacks } from './routes/reviewPacks.js';
import { register as registerSetup } from './routes/setup.js';
import { register as registerSchedules } from './routes/schedules.js';
import { register as registerSpend } from './routes/spend.js';
import { register as registerTickets } from './routes/tickets.js';
import { register as registerUpgrade } from './routes/upgrade.js';
import { register as registerStacks } from './routes/stacks.js';
import { register as registerState } from './routes/state.js';
import { register as registerWatches } from './routes/watches.js';
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
  registerAllowance,
  registerArtifacts,
  registerControl,
  registerEscalations,
  registerFeatures,
  registerHumanTasks,
  registerIngress,
  registerIssues,
  registerJobs,
  registerKnowledge,
  registerLocalRun,
  registerMcpUsage,
  registerPets,
  registerPool,
  registerPlans,
  registerPrs,
  registerReadings,
  registerReliability,
  registerReviewPacks,
  registerSchedules,
  registerSetup,
  registerSpend,
  registerStacks,
  registerTickets,
  registerUpgrade,
  registerValidation,
  registerWatches,
  registerWork,
];

/** Bind addresses that mean "this machine only" — the ones the Host check is sound for. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * The status a caught error already classified itself with, when that is a 4xx —
 * the caller's fault, stated by the framework before any handler ran. Anything
 * else (a 5xx, or no status at all) is an unanticipated throw and belongs in the
 * error log. Fastify's body-parser errors are the ones this exists for.
 */
function clientRefusalStatus(err: unknown): number | null {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : null;
}

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
      // Asking the throttle, deciding and counting the refusal are one call, because
      // the order of them is the property — a throttled refusal must not renew the
      // window that produced it. See `guardRequest`.
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
  //
  // An error that carries its own 4xx is the framework refusing a malformed
  // request before `checked` can see it — the JSON body parser is the one that
  // reaches every mutating route — so it is returned with that status and *not*
  // recorded. Recording it would bury real faults under other people's typos,
  // which is the whole reason the surface refuses by value rather than by throw.
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
      if (!wantsAppShell(req.url)) return reply.code(404).send({ error: 'not found' });
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

/**
 * Does this URL want the SPA shell, or a file that is simply not there?
 *
 * The fallback exists for the cockpit's own deep links — `/goals/42` is a route in
 * the bundle, not a path on disk, so a reload of one must be answered with
 * `index.html`. Every other miss must be a 404, and **a request for a file is the
 * case that must not be given the shell**: Vite hashes asset names and
 * `emptyOutDir` deletes the previous ones, so for as long as any browser still
 * holds the last `index.html` it goes on asking for chunks that no longer exist.
 * Answering those with the shell returns `200 text/html` for a JavaScript module —
 * the browser refuses it on the MIME type, the cockpit does not start, and the
 * server logged a successful request. A 404 is the same staleness said out loud,
 * which one reload fixes.
 *
 * The test is the path's last segment, not the `Accept` header: a module request
 * asks for any type at all, and so does curl, so deciding on that header would turn
 * a deep link typed into a terminal into a 404 while fixing nothing. An extension is
 * a claim about a file, and cockpit routes are ref ids and slugs.
 */
export function wantsAppShell(url: string): boolean {
  const path = url.split(/[?#]/)[0] ?? '/';
  if (path.startsWith('/api') || path.startsWith('/ws')) return false;
  return !path.slice(path.lastIndexOf('/') + 1).includes('.');
}
