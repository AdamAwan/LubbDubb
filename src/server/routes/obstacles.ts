import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { noteWriteUpFields } from '../../obstacles/endings.js';
import { trackerCoordinates } from '../../mcp/findings.js';
import type { ObstacleBoardPayload, ObstacleBoardRow, ObstacleCallRate } from '../../wire.js';
import { checked, IdParams, requiredBoolean, requiredText } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store } = system;

  app.get('/api/obstacles', async () => {
    const board = store.obstacles.obstacleBoard();
    const rows: ObstacleBoardRow[] = board.map((row) => ({
      ...row,
      sightings: store.obstacles.listObstacleSightings(row.obstacle.id),
    }));
    return {
      rows,
      counts: {
        sightings: rows.reduce((n, row) => n + row.sightings.length, 0),
        goals: new Set(rows.flatMap((row) => row.goalRefs)).size,
        told: store.obstacles.obstacleNoticesSent(),
        window: callRate(store, system.config.obstacleDormantMs),
      },
      dormantMs: system.config.obstacleDormantMs,
      canFileTickets: trackerCoordinates(system.config) !== null,
    } satisfies ObstacleBoardPayload;
  });

  const MuteBody = z.object({
    muted: requiredBoolean(
      'muted is required: true silences this obstacle for the fleet, false tells them about it again',
    ),
  });
  app.post(
    '/api/obstacles/:id/mute',
    checked({ params: IdParams, body: MuteBody }, async ({ params, body, reply }) => {
      const obstacle = store.obstacles.getObstacle(params.id);
      if (!obstacle) return reply.code(404).send({ error: 'obstacle not found' });
      if (!store.obstacles.muteObstacle(params.id, body.muted)) {
        return reply.code(409).send({
          error: body.muted
            ? `this obstacle is ${obstacle.state}, so it is already reaching nobody — there is nothing to silence`
            : `this obstacle is ${obstacle.state} rather than muted`,
        });
      }
      hub.broadcast({ type: 'dirty' });
      return { ok: true, obstacle: store.obstacles.getObstacle(params.id) };
    }),
  );

  const OwnBody = z.object({
    ownerRef: requiredText(
      'ownerRef is required: name the ticket or work you are using to fix this, as a ref — the fleet is told ' +
        'to stand down from it and shown this',
    ),
  });
  app.post(
    '/api/obstacles/:id/own',
    checked({ params: IdParams, body: OwnBody }, async ({ params, body, reply }) => {
      const obstacle = store.obstacles.getObstacle(params.id);
      if (!obstacle) return reply.code(404).send({ error: 'obstacle not found' });
      if (!store.obstacles.claimObstacle(params.id)) {
        return reply.code(409).send({
          error:
            obstacle.ownerRef === null
              ? `this obstacle is ${obstacle.state}, and only a standing one can be taken`
              : `${obstacle.ownerRef} already owns this obstacle`,
        });
      }
      store.obstacles.setObstacleOwner(params.id, body.ownerRef);
      hub.broadcast({ type: 'dirty' });
      return { ok: true, obstacle: store.obstacles.getObstacle(params.id) };
    }),
  );

  app.post(
    '/api/obstacles/:id/retire',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const obstacle = store.obstacles.getObstacle(params.id);
      if (!obstacle) return reply.code(404).send({ error: 'obstacle not found' });
      if (!store.obstacles.endObstacle(params.id, 'resolved', 'retired')) {
        return reply
          .code(409)
          .send({ error: `this obstacle is ${obstacle.state}, so nothing is owed of anybody about it` });
      }
      hub.broadcast({ type: 'dirty' });
      return { ok: true, obstacle: store.obstacles.getObstacle(params.id) };
    }),
  );

  app.post(
    '/api/obstacles/:id/write-up',
    checked({ params: IdParams, body: z.object({}).optional() }, async ({ params, reply }) => {
      const row = store.obstacles.obstacleBoard().find((entry) => entry.obstacle.id === params.id);
      if (!row) return reply.code(404).send({ error: 'obstacle not found' });
      const { obstacle } = row;
      if (obstacle.kind !== 'note') {
        return reply.code(409).send({
          error:
            'only a note is written down — this is an obstacle, which a fix ends. File a ticket against it, or ' +
            'let the pulse do it',
        });
      }
      if (obstacle.state !== 'standing') {
        return reply.code(409).send({
          error: `this note is ${obstacle.state}, and only a standing one is written down — one report is not evidence`,
        });
      }
      if (store.obstacles.obstaclesWrittenUp().has(obstacle.id)) {
        return reply
          .code(409)
          .send({ error: 'this note has already been written up once, and that is the whole of it' });
      }
      if (store.obstacles.openObstacleWriteUps().length > 0) {
        return reply
          .code(409)
          .send({ error: 'a note is already being written up — one at a time, across the whole fleet' });
      }
      const fields = noteWriteUpFields(row);
      const prompt = [system.prompts.render('docs-change', fields.vars), fields.note].join('\n\n');
      const job = store.writeUpObstacle(obstacle.id, { title: fields.title, prompt });
      hub.broadcast({ type: 'world:changed' });
      const report = await system.harness.runCycle('manual');
      return { ok: true, job, report };
    }),
  );
}

function callRate(store: RouteContext['system']['store'], dormantMs: number): ObstacleCallRate {
  const since = new Date(Date.now() - dormantMs).toISOString();
  const calls = store.mcpCalls.listMcpCallsSince(since).filter((call) => call.channel === 'fleet');
  const raises = calls.filter((call) => call.tool === 'raise');
  return {
    since,
    calls: raises.length,
    callers: new Set(raises.flatMap((call) => (call.agentId === null ? [] : [call.agentId]))).size,
    agents: new Set(calls.flatMap((call) => (call.agentId === null ? [] : [call.agentId]))).size,
  };
}
