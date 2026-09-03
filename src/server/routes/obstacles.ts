import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { noteWriteUpFields } from '../../obstacles/endings.js';
import { trackerCoordinates } from '../../mcp/findings.js';
import type { ObstacleBoardPayload, ObstacleBoardRow, ObstacleCallRate } from '../../wire.js';
import { checked, IdParams, requiredBoolean, requiredText } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * The obstacle board, as an operator reaches it (issue #32 phase 7).
 *
 * **Read-mostly, and the writes are the four controls that are on no path.** The
 * board runs itself: a row is filed by an agent through `raise` on a scoped
 * credential, carried to `standing` by a second independent voice, owned by the
 * pulse and ended by one of the four endings. Nothing here is a step in any of
 * that, and that is deliberate — *every state has an exit that is not you* is the
 * invariant this whole subsystem is arranged around
 * (`docs/spec/27-obstacles.md#every-state-has-an-exit-that-is-not-you`), and a
 * route that the harness waited on would be the state a person has to empty,
 * rebuilt. So there is no accept, no promote, no triage verdict, and no queue.
 *
 * The four are what a person can say that no reading can:
 *
 * - **Mute** — never tell the fleet this. The one state whose exit is a person,
 *   and a person put it there.
 * - **Own it** — a ticket you are already using. It takes the row through
 *   `Store.claimObstacle`, the same `UPDATE … WHERE owner_ref IS NULL` the
 *   ownership desk takes, so an operator and the pulse racing for one row is a
 *   uniqueness constraint rather than a rule either of them remembers.
 * - **Retire** — this is over, and no reading is going to say so. It is
 *   *not* rejecting: the row keeps its claim, its keys and its sightings, and a
 *   matching report reopens it at `standing` like any other terminal row
 *   — retiring is not rejecting. Nothing
 *   here bars a claim by name, because nothing here is a durable statement about
 *   the repository to bar.
 * - **Write it down** — queue a note's documentation change now rather than
 *   waiting for the endings desk to reach it. The same composition the desk uses
 *   (`noteWriteUpFields`), because a note written up two ways is two documents
 *   claiming to be the fleet's one statement of the same thing.
 *
 * **The board does not ride on `/api/state`.** It is every sighting's prose for
 * every row, and the snapshot comes round every couple of seconds for every open
 * cockpit — the argument `/api/spend` and `/api/pool` already make.
 *
 * → `docs/spec/27-obstacles.md#in-the-cockpit`, `docs/spec/16-http-api.md`
 */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store } = system;

  app.get('/api/obstacles', async () => {
    const board = store.obstacleBoard();
    const rows: ObstacleBoardRow[] = board.map((row) => ({
      ...row,
      sightings: store.listObstacleSightings(row.obstacle.id),
    }));
    return {
      rows,
      counts: {
        sightings: rows.reduce((n, row) => n + row.sightings.length, 0),
        goals: new Set(rows.flatMap((row) => row.goalRefs)).size,
        told: store.obstacleNoticesSent(),
        window: callRate(store, system.config.obstacleDormantMs),
      },
      dormantMs: system.config.obstacleDormantMs,
      canFileTickets: trackerCoordinates(system.config) !== null,
    } satisfies ObstacleBoardPayload;
  });

  /**
   * Say never tell the fleet this, or take it back.
   *
   * A boolean rather than two routes, because it is one thing being said about one
   * row and the operator is toggling it. The refusal it can meet is a row an ending
   * already took: `muted` is a state a row *reaching* agents is put into, and
   * silencing something that is already over would draw a control that appeared to
   * work and moved nothing.
   */
  const MuteBody = z.object({
    muted: requiredBoolean(
      'muted is required: true silences this obstacle for the fleet, false tells them about it again',
    ),
  });
  app.post(
    '/api/obstacles/:id/mute',
    checked({ params: IdParams, body: MuteBody }, async ({ params, body, reply }) => {
      const obstacle = store.getObstacle(params.id);
      if (!obstacle) return reply.code(404).send({ error: 'obstacle not found' });
      if (!store.muteObstacle(params.id, body.muted)) {
        return reply.code(409).send({
          error: body.muted
            ? `this obstacle is ${obstacle.state}, so it is already reaching nobody — there is nothing to silence`
            : `this obstacle is ${obstacle.state} rather than muted`,
        });
      }
      hub.broadcast({ type: 'dirty' });
      return { ok: true, obstacle: store.getObstacle(params.id) };
    }),
  );

  /**
   * Name what is fixing it — a ticket the operator is already using.
   *
   * The claim and the owner in that order, through the store's own two calls,
   * because that is the order the ownership desk takes them in and the window it
   * opens is closed at the other end: a row left `owned` with a null owner is
   * released at the top of the desk's next pass. Taken the other way round, an
   * operator and the pulse could each file against one row.
   *
   * It refuses a row that is not `standing`, which is the claim's own guard
   * answered in words rather than as a silent no-op: an `owned` row already has
   * something on it, and a terminal one is not something anybody needs to fix.
   */
  const OwnBody = z.object({
    ownerRef: requiredText(
      'ownerRef is required: name the ticket or work you are using to fix this, as a ref — the fleet is told ' +
        'to stand down from it and shown this',
    ),
  });
  app.post(
    '/api/obstacles/:id/own',
    checked({ params: IdParams, body: OwnBody }, async ({ params, body, reply }) => {
      const obstacle = store.getObstacle(params.id);
      if (!obstacle) return reply.code(404).send({ error: 'obstacle not found' });
      if (!store.claimObstacle(params.id)) {
        return reply.code(409).send({
          error:
            obstacle.ownerRef === null
              ? `this obstacle is ${obstacle.state}, and only a standing one can be taken`
              : `${obstacle.ownerRef} already owns this obstacle`,
        });
      }
      store.setObstacleOwner(params.id, body.ownerRef);
      hub.broadcast({ type: 'dirty' });
      return { ok: true, obstacle: store.getObstacle(params.id) };
    }),
  );

  /**
   * This is over, and no reading is going to say so.
   *
   * Recorded as its own ending rather than borrowed from one of the four, because
   * the board must never say a clock or the world ended a row a person did — which
   * is the whole reason `endedBy` is a column at all. `Store.endObstacle`'s guard
   * is what refuses a row already ended: the ending that took a row is the first
   * one that did.
   */
  app.post(
    '/api/obstacles/:id/retire',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const obstacle = store.getObstacle(params.id);
      if (!obstacle) return reply.code(404).send({ error: 'obstacle not found' });
      if (!store.endObstacle(params.id, 'resolved', 'retired')) {
        return reply
          .code(409)
          .send({ error: `this obstacle is ${obstacle.state}, so nothing is owed of anybody about it` });
      }
      hub.broadcast({ type: 'dirty' });
      return { ok: true, obstacle: store.getObstacle(params.id) };
    }),
  );

  /**
   * Write a note into the repository now, rather than when the endings desk
   * reaches it.
   *
   * The desk queues one note at a time across the whole fleet, so on a board with
   * several standing notes this is how an operator says *that one first*. It takes
   * the same bound for the same reason — a board that went to twenty standing notes
   * on a bad afternoon must not become twenty jobs — and `recordObstacleWriteUp`'s
   * primary key is what makes *one write-up per note, ever* true whichever door it
   * came through.
   *
   * **Only a `standing` note**, which is `notesToWriteUp`'s own predicate: one
   * report is not evidence, and committing one agent's reading to the repository
   * through an agent would be the auto-promotion this design refuses arriving
   * through the one door that ends outside the harness.
   */
  app.post(
    '/api/obstacles/:id/write-up',
    checked({ params: IdParams, body: z.object({}).optional() }, async ({ params, reply }) => {
      const row = store.obstacleBoard().find((entry) => entry.obstacle.id === params.id);
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
      if (store.obstaclesWrittenUp().has(obstacle.id)) {
        return reply
          .code(409)
          .send({ error: 'this note has already been written up once, and that is the whole of it' });
      }
      if (store.openObstacleWriteUps().length > 0) {
        return reply
          .code(409)
          .send({ error: 'a note is already being written up — one at a time, across the whole fleet' });
      }
      const fields = noteWriteUpFields(row);
      // Appended, never interpolated, and rendered from the operator's own template
      // book rather than built here — the same two rules the desk's own call follows.
      const prompt = [system.prompts.render('docs-change', fields.vars), fields.note].join('\n\n');
      const job = store.writeUpObstacle(obstacle.id, { title: fields.title, prompt });
      hub.broadcast({ type: 'world:changed' });
      // Dispatched on this pulse rather than the next, for the reason the knowledge
      // exits run one: a queue that only moves on the heartbeat reads as nothing
      // having happened.
      const report = await system.harness.runCycle('manual');
      return { ok: true, job, report };
    }),
  );
}

/**
 * Whether agents call the intake at all, over the same span a row is given before
 * it decays.
 *
 * The window is `obstacleDormantMs` rather than a constant, and that is the one
 * choice here worth stating: it is the deployment's own answer to *how long is a
 * report still about the world we are in*, and a rate measured over any other span
 * would be a second opinion about that with nothing holding the two together.
 *
 * `agents` is every agent that reached the fleet channel at all inside the span,
 * which is the honest denominator for *did an agent that could call it, call it*.
 * An agent whose `mcp__lubbdubb__*` grants were dropped never could, and that is a
 * different fault, drawn on the MCP tab.
 */
function callRate(store: RouteContext['system']['store'], dormantMs: number): ObstacleCallRate {
  const since = new Date(Date.now() - dormantMs).toISOString();
  const calls = store.listMcpCallsSince(since).filter((call) => call.channel === 'fleet');
  const raises = calls.filter((call) => call.tool === 'raise');
  return {
    since,
    calls: raises.length,
    callers: new Set(raises.flatMap((call) => (call.agentId === null ? [] : [call.agentId]))).size,
    agents: new Set(calls.flatMap((call) => (call.agentId === null ? [] : [call.agentId]))).size,
  };
}
