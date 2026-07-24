import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import type { System } from '../system.js';
import { Hub } from './hub.js';
import { buildRefUrls } from './refUrls.js';
import { prHealth } from '../prHealth.js';
import { issuePickupStatus, type IssuePickupContext } from '../dispatcher/issuePickup.js';
import { DEFAULT_COOLDOWN } from '../dispatcher/dispatchCooldown.js';
import type { InjectableEvent } from '../connector/connector.js';
import type { IntegrationSelection } from '../integrations/integration.js';
import { DeskBriefingSchema } from '../integrations/ingested/briefingSchema.js';
import { DISPATCH_RULES } from '../dispatcher/rules.js';

/**
 * Whether the configured world accepts synthetic events: only the `fake`
 * provider is injectable (`CompositeConnector.inject` records anything else as
 * `inject_unhandled`). Gates both the `/api/inject` route and the cockpit's
 * inject panel (via the state snapshot), so a real-integration deployment
 * doesn't expose a demo affordance.
 */
export function isWorldInjectable(integrations: IntegrationSelection): boolean {
  return Object.values(integrations).some((provider) => provider === 'fake');
}

/**
 * Builds the cockpit HTTP + WebSocket surface. REST for actions and state,
 * WebSocket for live streaming, and (in production) the built SPA served from
 * `web/dist`. Returns the Fastify instance and the hub so `main.ts` can wire the
 * harness lifecycle around it and tests can drive it via `.inject()`.
 */
export async function buildApp(system: System): Promise<{ app: FastifyInstance; hub: Hub }> {
  const app = Fastify({ logger: false });
  const hub = new Hub(system);
  await app.register(websocket);
  // Opt-in rate limiting (`global: false`): only routes that set `config.rateLimit`
  // are limited, so the cockpit's frequent state polling is never throttled. The
  // artifact route opts in because it reads files off disk.
  await app.register(rateLimit, { global: false });

  const { store, connector, harness, agents, escalations, config, errors } = system;

  // Operator-configured absolute docsFolderPrefix entries are trusted roots the
  // artifact route may serve from, on top of each agent's worktree. Relative
  // entries add nothing here — they're already covered by the worktree root.
  const artifactRoots = absolutePrefixes(config.docsFolderPrefix);

  // An unanticipated throw in a route must not vanish into a silent 500: record
  // it to the error log (which also mirrors it to stderr and streams it to the
  // cockpit), then return a plain 500.
  app.setErrorHandler((err, req, reply) => {
    errors.record({
      source: 'server',
      message: `${req.method} ${req.url} failed: ${err.message}`,
      detail: err.stack ?? null,
    });
    return reply.code(500).send({ error: err.message });
  });

  // -- Live stream ---------------------------------------------------------
  app.register(async (scoped) => {
    scoped.get('/ws', { websocket: true }, (socket) => {
      hub.add(socket);
      socket.on('message', (raw) => hub.handleClientMessage(socket, raw.toString()));
      socket.send(JSON.stringify({ type: 'dirty' }));
    });
  });

  // -- State ---------------------------------------------------------------
  app.get('/api/state', async () => buildStateSnapshot(system));

  app.get('/api/agents/:id/transcript', async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = store.getAgent(id);
    if (!agent) return reply.code(404).send({ error: 'agent not found' });
    return { agentId: id, transcript: store.getTranscript(id) };
  });

  // Serve a local artifact an agent flagged (a design doc, a report), addressed by
  // its flag id. The path is taken from the *stored* flag row, not the request, so
  // a client can only fetch a ref an agent actually surfaced — and the served path
  // is confined to that agent's worktree or an operator-configured absolute
  // `docsFolderPrefix` root (a symlink or `..` that escapes every root is refused).
  // The response is sandboxed (CSP `sandbox`) so agent-authored HTML can't script
  // the cockpit's origin. Rate-limited since it reads off disk. URL flags aren't
  // served here; the cockpit links those directly.
  app.get('/api/artifacts/:id', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const flag = store.getFlag(id);
    if (!flag) return reply.code(404).send({ error: 'artifact not found' });
    if (/^https?:\/\//i.test(flag.ref))
      return reply.code(400).send({ error: 'url refs are linked directly, not served' });
    const agent = store.getAgent(flag.agentId);
    if (!agent) return reply.code(404).send({ error: 'agent not found' });
    const file = resolveConfinedArtifact(agent.cwd, flag.ref, artifactRoots);
    if (!file) return reply.code(404).send({ error: 'artifact not found' });
    reply
      .header('content-type', artifactMime(file))
      .header('content-security-policy', 'sandbox allow-scripts allow-downloads')
      .header('x-content-type-options', 'nosniff');
    return reply.send(readFileSync(file));
  });

  // -- Actions -------------------------------------------------------------
  app.post('/api/inject', async (req, reply) => {
    // Defence in depth: the cockpit hides the panel, but the route itself also
    // refuses when no fake provider is configured to receive the event.
    if (!isWorldInjectable(config.integrations))
      return reply.code(403).send({ error: 'event injection is only available with fake integrations' });
    const event = req.body as InjectableEvent;
    if (!event || typeof event.kind !== 'string') return reply.code(400).send({ error: 'invalid event' });
    connector.inject(event);
    hub.broadcast({ type: 'world:changed' });
    // An injected event should provoke an immediate cycle.
    const report = await harness.runCycle('manual');
    return { ok: true, report };
  });

  // Ingest a Claude-bridged desk briefing (calendar + mail + Teams pings). The
  // bridge is an untrusted client, so the body is validated before it lands. Like
  // `/api/inject`, a successful ingest kicks a cycle so the meeting half emits its
  // `worldDiff` events promptly (the mail/pings half is a passive doc).
  app.post('/api/briefing', async (req, reply) => {
    const parsed = DeskBriefingSchema.safeParse(req.body);
    if (!parsed.success) {
      const error = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return reply.code(400).send({ error });
    }
    const briefing = parsed.data;
    store.setDeskBriefing(briefing);
    // Log/echo the owner the bridge acted as, so an ingest is auditable.
    store.recordConnectorEvent('desk_briefing_ingested', {
      owner: briefing.owner,
      areas: briefing.areas,
      counts: { meetings: briefing.meetings.length, mail: briefing.mail.length, pings: briefing.pings.length },
    });
    hub.broadcast({ type: 'world:changed' });
    await harness.runCycle('manual');
    return {
      ok: true,
      counts: { meetings: briefing.meetings.length, mail: briefing.mail.length, pings: briefing.pings.length },
    };
  });

  app.post('/api/pulse', async () => {
    const report = await harness.runCycle('manual');
    return { ok: true, report };
  });

  // Live dispatch controls (cap + pause). Changes are in-memory and ephemeral;
  // on success we broadcast so every open cockpit updates without a refetch.
  app.post('/api/control', async (req, reply) => {
    const body = (req.body ?? {}) as { cap?: unknown; paused?: unknown };
    const patch: { cap?: number; paused?: boolean } = {};
    if (body.cap !== undefined) {
      if (typeof body.cap !== 'number') return reply.code(400).send({ error: 'cap must be a number' });
      patch.cap = body.cap;
    }
    if (body.paused !== undefined) {
      if (typeof body.paused !== 'boolean') return reply.code(400).send({ error: 'paused must be a boolean' });
      patch.paused = body.paused;
    }
    try {
      const next = system.runtimeControl.apply(patch);
      hub.broadcast({ type: 'control:changed', cap: next.cap, paused: next.paused });
      return { ok: true, ...next };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Toggle the PR exclusion tag from the cockpit: add/remove the configured
  // exclusion label on the PR through the provider. The next snapshot reflects
  // the label and the harness leaves a tagged PR alone. Provider-agnostic — it
  // routes through the same outbound seam as replies/merges.
  app.post('/api/prs/:number/exclude', async (req, reply) => {
    const { number } = req.params as { number: string };
    const prNumber = Number(number);
    if (!Number.isInteger(prNumber)) return reply.code(400).send({ error: 'invalid PR number' });
    const { excluded } = (req.body ?? {}) as { excluded?: unknown };
    if (typeof excluded !== 'boolean') return reply.code(400).send({ error: 'excluded must be a boolean' });
    try {
      const result = await connector.setPrLabel({ prNumber, label: config.prExclusionLabel, present: excluded });
      // Reflect the change immediately: refetch on the next state read, and run a
      // cycle so a now-included PR is picked up (or a now-excluded one dropped).
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, ref: result.ref, excluded };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Queue an operator-launched job. It persists as `queued` and is drained by
  // the dispatcher ahead of world-driven work — taking the next free slot, or
  // waiting in the queue when the fleet is at capacity. A cycle is kicked so a
  // job dispatches immediately when there's headroom.
  app.post('/api/jobs', async (req, reply) => {
    const body = (req.body ?? {}) as { prompt?: unknown; title?: unknown; kind?: unknown; branch?: unknown };
    if (typeof body.prompt !== 'string' || body.prompt.trim() === '')
      return reply.code(400).send({ error: 'prompt required' });
    const kind = body.kind ?? 'code';
    if (kind !== 'code' && kind !== 'desk') return reply.code(400).send({ error: "kind must be 'code' or 'desk'" });
    if (body.title !== undefined && typeof body.title !== 'string')
      return reply.code(400).send({ error: 'title must be a string' });
    if (body.branch !== undefined && body.branch !== null && typeof body.branch !== 'string')
      return reply.code(400).send({ error: 'branch must be a string' });
    const prompt = body.prompt.trim();
    // Fall back to a title derived from the prompt's first line when none is given.
    const title = (typeof body.title === 'string' && body.title.trim()) || deriveTitle(prompt);
    const job = store.createJob({ title, prompt, kind, branch: (body.branch as string | undefined) ?? null });
    hub.broadcast({ type: 'world:changed' });
    const report = await harness.runCycle('manual');
    return { ok: true, job, report };
  });

  // Drop a still-queued job before it runs. A job already dispatched can't be
  // cancelled here — kill its agent instead.
  app.post('/api/jobs/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = store.cancelJob(id);
    if (!job) return reply.code(409).send({ error: 'job not found or no longer queued' });
    hub.broadcast({ type: 'world:changed' });
    return { ok: true, job };
  });

  app.post('/api/escalations/:id/answer', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { response } = (req.body ?? {}) as { response?: string };
    if (!response) return reply.code(400).send({ error: 'response required' });
    try {
      const result = escalations.answer(id, response);
      return { ok: true, ...result };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/agents/:id/respond', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text } = (req.body ?? {}) as { text?: string };
    if (!text) return reply.code(400).send({ error: 'text required' });
    const ok = agents.respond(id, text);
    return ok ? { ok: true } : reply.code(409).send({ error: 'agent not live' });
  });

  app.post('/api/agents/:id/kill', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = agents.kill(id);
    return ok ? { ok: true } : reply.code(409).send({ error: 'agent not live' });
  });

  app.post('/api/agents/:id/interrupt', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = agents.interrupt(id);
    return ok ? { ok: true } : reply.code(409).send({ error: 'agent not live' });
  });

  app.get('/api/health', async () => ({ ok: true, dispatcher: config.dispatcher }));

  // -- Static SPA (production build) --------------------------------------
  const distDir = resolve(process.cwd(), 'web/dist');
  if (existsSync(distDir)) {
    await app.register(fastifyStatic, { root: distDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  return { app, hub };
}

/**
 * Resolve a flagged artifact `ref` to an absolute path within one of the allowed
 * roots — the agent's worktree `cwd` plus any operator-configured `trustedRoots`
 * (the absolute `docsFolderPrefix` entries) — or null if it doesn't exist, isn't a
 * regular file, or escapes every root (via `..` or a symlink). A relative ref is
 * resolved against `cwd`; an absolute ref is honoured only if it lands inside a
 * trusted root. Two guards: a *lexical* containment check against some root runs
 * before any filesystem access, then `realpathSync` on both sides defeats symlink
 * traversal.
 */
function resolveConfinedArtifact(cwd: string, ref: string, trustedRoots: string[]): string | null {
  // A relative ref is worktree-relative; an absolute ref must land inside one of
  // the operator-configured absolute prefixes (its own trusted root). The
  // worktree cwd is always a trusted root. Serving re-validates containment here
  // independently of the flag, so an odd stored ref can't read outside a root.
  const target = isAbsolute(ref) ? resolve(ref) : resolve(cwd, ref);
  const roots = [cwd, ...trustedRoots];
  // Lexical containment against *some* root, before touching the filesystem.
  if (!roots.some((root) => target === root || target.startsWith(root + sep))) return null;
  try {
    const real = realpathSync(target);
    // Real-path containment: a symlink inside a root can't point outside it.
    const contained = roots.some((root) => {
      const realRoot = realpathSync(root);
      return real === realRoot || real.startsWith(realRoot + sep);
    });
    if (!contained) return null;
    if (!statSync(real).isFile()) return null;
    return real;
  } catch {
    return null; // missing path, broken symlink, permission error — treat as not found
  }
}

/** The absolute entries of `docsFolderPrefix` — the extra trusted roots the artifact route may serve from. */
export function absolutePrefixes(docsFolderPrefix?: string | string[]): string[] {
  if (docsFolderPrefix === undefined) return [];
  const list = Array.isArray(docsFolderPrefix) ? docsFolderPrefix : [docsFolderPrefix];
  return list.filter((p) => isAbsolute(p)).map((p) => resolve(p));
}

const ARTIFACT_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
};

/** Content type for a served artifact, by extension; opaque octet-stream otherwise. */
function artifactMime(file: string): string {
  return ARTIFACT_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export function buildStateSnapshot(system: System) {
  const { store, connector, config, runtimeControl, harness } = system;
  // getState is async on the interface, but FakeConnector is synchronous under
  // the hood; read the same persisted world directly for a snapshot.
  return connector.getState().then((world) => {
    const tasks = store.listTasks();
    const control = runtimeControl.snapshot();
    // The same inputs rule 4 of the dispatcher consults, so the per-issue verdict
    // below predicts what actually happens next cycle. The decision window (200)
    // and the headroom arithmetic mirror `Harness.runCycle`.
    const pickupCtx: IssuePickupContext = {
      policy: system.issuePickup,
      cooldown: DEFAULT_COOLDOWN,
      now: world.takenAt,
      tasks,
      recentDecisions: store.listDecisions(200),
      headroom: control.paused ? 0 : Math.max(0, control.cap - store.countLiveAgents()),
      paused: control.paused,
    };
    // The provider builds every URL (see CompositeConnector.resolveRefUrl); the
    // cockpit only looks refs up in this map, so it stays provider-agnostic.
    const refUrls = buildRefUrls({
      pullRequests: world.pullRequests,
      issues: world.issues,
      taskBranches: tasks.map((t) => t.branch),
      resolve: (ref) => connector.resolveRefUrl(ref),
    });
    return {
      config: {
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        maxConcurrentAgents: config.maxConcurrentAgents,
        dispatcher: config.dispatcher,
        steeringPriorities: config.steeringPriorities,
        // The exclusion tag name, so the cockpit knows which label its ignore/watch
        // toggle sets and which PRs to render as ignored.
        prExclusionLabel: config.prExclusionLabel,
        // Whether the inject panel should render: synthetic events only land on
        // the `fake` provider, so real-integration deployments hide it.
        injectable: isWorldInjectable(config.integrations),
      },
      // Live, mutable dispatch controls — the cockpit reads these (not the frozen
      // config block above) for the current cap and pause state.
      control,
      // Fold each PR's signals into a health verdict, and each issue's gates into
      // a pickup verdict, so the cockpit can show *why* an item is stuck or
      // untouched rather than leaving it implied by the absence of activity.
      world: {
        ...world,
        pullRequests: world.pullRequests.map((pr) => ({ ...pr, health: prHealth(pr) })),
        issues: world.issues.map((issue) => ({ ...issue, pickup: issuePickupStatus(issue, pickupCtx) })),
      },
      tasks,
      // Operator-launched jobs (newest first) — the cockpit shows the queued
      // ones and their place in line, plus recently-dispatched/cancelled history.
      jobs: store.listJobs(),
      agents: store.listAgents(),
      // Artifacts agents surfaced mid-run (design docs, reports, links). The
      // cockpit groups these by agentId onto the fleet card / drawer.
      flags: store.listAllFlags(),
      // Every file agents wrote (captured by the file-events hook), grouped by
      // agentId in the drawer's "files changed" list; the report-like ones also
      // appear above as artifact chips.
      files: store.listAllFiles(),
      escalations: store.listEscalations(),
      decisions: store.listDecisions(100),
      // The "Up next" queue: the last cycle's ordered pickup plan with the
      // headroom cut (issue #69). A per-pulse projection — null until a cycle
      // has run, or when the active dispatcher doesn't materialise a plan.
      upcoming: harness.upcoming,
      worldEvents: store.listWorldEvents(100),
      // Recorded failures (cycle exceptions, provider outages, agent crashes,
      // route 500s) for the cockpit's Errors panel.
      errors: store.listErrors(100),
      refUrls,
      // The rule book, as data: decision rows carry a rule id; the cockpit looks
      // the id up here to expand a decision into "which rule fired, and why".
      dispatchRules: DISPATCH_RULES,
      // The read-only desk briefing (mail + Teams pings + meetings). Nullable until
      // a bridge has posted one. Meetings also flow through the world's calendar.
      briefing: store.getDeskBriefing(),
      usage: buildUsage(system),
    };
  });
}

/** A concise task/job title from a free-form prompt: its first non-empty line, capped. */
function deriveTitle(prompt: string): string {
  const firstLine =
    prompt
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? 'Operator job';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}

/**
 * Account-level Claude usage for the cockpit chip (issue #60): the rolling cost
 * windows summed from stream-mode turn reports (all modes, self-computed), plus
 * the real subscriber 5h/weekly limits when the PTY status-line capture has
 * seen any (Pro/Max only — null otherwise, and the UI degrades to cost).
 */
function buildUsage(system: System) {
  const now = Date.now();
  const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();
  return {
    windows: {
      fiveHourCostUsd: system.store.sumUsageCostSince(iso(5 * 60 * 60 * 1000)),
      sevenDayCostUsd: system.store.sumUsageCostSince(iso(7 * 24 * 60 * 60 * 1000)),
    },
    rateLimits: system.rateLimits?.readLatest() ?? null,
  };
}
