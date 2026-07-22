import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { System } from '../system.js';
import { Hub } from './hub.js';
import { buildRefUrls } from './refUrls.js';
import { prHealth } from '../prHealth.js';
import type { InjectableEvent } from '../connector/connector.js';

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

  const { store, connector, harness, agents, escalations, config } = system;

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

  // -- Actions -------------------------------------------------------------
  app.post('/api/inject', async (req, reply) => {
    const event = req.body as InjectableEvent;
    if (!event || typeof event.kind !== 'string') return reply.code(400).send({ error: 'invalid event' });
    connector.inject(event);
    hub.broadcast({ type: 'world:changed' });
    // An injected event should provoke an immediate cycle.
    const report = await harness.runCycle('manual');
    return { ok: true, report };
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

export function buildStateSnapshot(system: System) {
  const { store, connector, config, runtimeControl } = system;
  // getState is async on the interface, but FakeConnector is synchronous under
  // the hood; read the same persisted world directly for a snapshot.
  return connector.getState().then((world) => {
    const tasks = store.listTasks();
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
      },
      // Live, mutable dispatch controls — the cockpit reads these (not the frozen
      // config block above) for the current cap and pause state.
      control: runtimeControl.snapshot(),
      // Fold each PR's signals into a health verdict so the cockpit can show *why*
      // a PR is stuck rather than leaving it implied by the absence of activity.
      world: {
        ...world,
        pullRequests: world.pullRequests.map((pr) => ({ ...pr, health: prHealth(pr) })),
      },
      tasks,
      agents: store.listAgents(),
      escalations: store.listEscalations(),
      decisions: store.listDecisions(100),
      worldEvents: store.listWorldEvents(100),
      refUrls,
    };
  });
}
