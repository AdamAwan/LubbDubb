import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validateHumanTask } from '../../mcp/humanTasks.js';
import { closeOutIssueNumber } from '../../delivery/closeOut.js';
import { closeOutValidation, settleHumanTask } from '../../humanTaskSettle.js';
import { checked, IdParams, optionalText, requiredText } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, harness, connector, errors } = system;

  const CreateBody = z.object({
    title: requiredText('title is required'),
    detail: optionalText('detail'),
    originRef: optionalText('originRef'),
  });
  app.post(
    '/api/human-tasks',
    checked({ body: CreateBody }, async ({ body, reply }) => {
      const parsed = validateHumanTask(body);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      const { task } = store.humanTasks.recordHumanTask({
        ...parsed.input,
        originRef: body.originRef ?? null,
        agentId: null,
        taskId: null,
      });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, humanTask: task };
    }),
  );

  const DoneBody = z.object({ note: optionalText('note') });
  app.post(
    '/api/human-tasks/:id/done',
    checked({ params: IdParams, body: DoneBody }, async ({ params, body, reply }) => {
      const settled = settleHumanTask(store, { id: params.id, status: 'done', note: body.note });
      if (!settled.ok) return reply.code(settled.code).send({ error: settled.error });
      hub.broadcast({ type: 'world:changed' });
      const report = settled.runCycle ? await harness.runCycle('manual') : null;
      return { ok: true, humanTask: settled.task, part: settled.part, report };
    }),
  );

  const DeclineBody = z.object({
    note: requiredText('note is required — say why, so a replan has something to go on'),
  });
  app.post(
    '/api/human-tasks/:id/decline',
    checked({ params: IdParams, body: DeclineBody }, async ({ params, body, reply }) => {
      const settled = settleHumanTask(store, { id: params.id, status: 'declined', note: body.note });
      if (!settled.ok) return reply.code(settled.code).send({ error: settled.error });
      hub.broadcast({ type: 'world:changed' });
      const report = settled.runCycle ? await harness.runCycle('manual') : null;
      return { ok: true, humanTask: settled.task, report };
    }),
  );

  const CloseTicketBody = z.object({ note: optionalText('note') });
  app.post(
    '/api/human-tasks/:id/close-ticket',
    checked({ params: IdParams, body: CloseTicketBody }, async ({ params, body, reply }) => {
      const task = store.humanTasks.getHumanTask(params.id);
      if (!task || task.kind !== 'close_out' || task.status !== 'open')
        return reply.code(409).send({ error: 'human task not found, not a close-out, or already settled' });
      const number = closeOutIssueNumber(task.originRef);
      if (number === null) return reply.code(409).send({ error: 'this close-out names no tracker item to close' });
      if (!connector.canCloseIssue())
        return reply
          .code(400)
          .send({ error: 'This tracker cannot be written from here — close the item there and this settles itself.' });
      const owed = closeOutValidation(store, params.id);
      if (owed && body.note === undefined)
        return reply.code(400).send({
          error: `note is required — ${owed.headline} Say what you are doing about them, or waive them first.`,
        });

      try {
        const result = await connector.closeIssue({ number, reason: 'completed' });
        if (!result.ok) return reply.code(400).send({ error: `The tracker did not close #${number}.` });
      } catch (err) {
        const message = (err as Error).message;
        errors.record({ source: 'server', message: `Failed to close #${number} from its close-out row: ${message}` });
        return reply.code(400).send({ error: message });
      }

      const settled = store.humanTasks.settleHumanTask(
        params.id,
        'done',
        closeTicketResolution(number, body.note ?? null),
      );
      hub.broadcast({ type: 'world:changed' });
      const report = await harness.runCycle('manual');
      return { ok: true, humanTask: settled, report };
    }),
  );

  app.post(
    '/api/human-tasks/:id/dismiss',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const task = store.humanTasks.dismissHumanTask(params.id);
      if (!task) return reply.code(409).send({ error: 'human task not found, still open, or already dismissed' });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, humanTask: task };
    }),
  );
}

function closeTicketResolution(issueNumber: number, note: string | null): string {
  const closed = `Closed #${issueNumber} in the tracker from the cockpit.`;
  return note === null ? closed : `${closed} ${note}`;
}
