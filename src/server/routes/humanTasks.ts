import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validateHumanTask } from '../../mcp/humanTasks.js';
import { checked, IdParams, optionalText } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * Work only a person can do: filing one, the two ways it settles, and clearing
 * the settled record off the bench.
 *
 * **No promotion route, unlike findings.** A finding is inert until an operator
 * turns it into an agent, so it needs a click to become work; a human task *is*
 * the work, and the operator is the one who does it. What these routes record is
 * that it happened.
 */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, harness } = system;

  // File one as the operator. The agent arm is `request_human_task` on the MCP
  // channel; this is the same row with no agent behind it, which is exactly what
  // a null `agentId` means.
  const CreateBody = z.object({
    title: z.string({ required_error: 'title is required' }),
    detail: optionalText('detail'),
    originRef: optionalText('originRef'),
  });
  app.post(
    '/api/human-tasks',
    checked({ body: CreateBody }, async ({ body, reply }) => {
      // The same pure validation the tool uses, so an operator-filed task and an
      // agent-filed one cannot be bounded differently — a one-line title is a
      // property of the panel row, not of who typed it.
      const parsed = validateHumanTask(body);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      const { task } = store.recordHumanTask({
        ...parsed.input,
        originRef: body.originRef ?? null,
        agentId: null,
        taskId: null,
      });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, humanTask: task };
    }),
  );

  // Done. A backing plan part concludes with it, which is what releases every
  // sibling that named it in `dependsOn` — on the next pulse, so a cycle is run
  // rather than left to the heartbeat.
  const DoneBody = z.object({ note: optionalText('note') });
  app.post(
    '/api/human-tasks/:id/done',
    checked({ params: IdParams, body: DoneBody }, async ({ params, body, reply }) => {
      const task = store.settleHumanTask(params.id, 'done', body.note ?? null);
      if (!task) return reply.code(409).send({ error: 'human task not found or already settled' });
      // Settle the task first, then the part: a failed part write leaves a settled
      // task an operator can see, where the other order would leave a concluded
      // part nothing accounts for. `concludeHumanPart` is compare-and-set, so a
      // part somebody merged or retired underneath this is left alone.
      const part = task.partId ? store.concludeHumanPart(task.partId, humanPartSummary(task)) : null;
      hub.broadcast({ type: 'world:changed' });
      const report = part ? await harness.runCycle('manual') : null;
      return { ok: true, humanTask: task, part, report };
    }),
  );

  // Declined. **The backing part is not concluded**, and that is the decision this
  // route encodes: concluding it would make `partSettled` true and release every
  // dependent waiting on the thing that was refused — a plan completing on work
  // nobody did. The part is left where it is; the reconciler blocks it on the next
  // pulse with its own account of why, and the ways out are Replan and Abandon.
  const DeclineBody = z.object({
    note: z.string({ required_error: 'note is required — say why, so a replan has something to go on' }),
  });
  app.post(
    '/api/human-tasks/:id/decline',
    checked({ params: IdParams, body: DeclineBody }, async ({ params, body, reply }) => {
      const note = body.note.trim();
      if (note.length === 0)
        return reply.code(400).send({ error: 'note is required — say why, so a replan has something to go on' });
      const task = store.settleHumanTask(params.id, 'declined', note);
      if (!task) return reply.code(409).send({ error: 'human task not found or already settled' });
      hub.broadcast({ type: 'world:changed' });
      const report = task.partId ? await harness.runCycle('manual') : null;
      return { ok: true, humanTask: task, report };
    }),
  );

  // Dismissed: the operator has read the settled record and wants it off the
  // bench. Not a third verdict — it says nothing about the work, only about the
  // row — so it takes no note, concludes no part and runs no cycle. **Settled
  // only**, which is what keeps it from being a way to make an obligation go
  // away: an open task has two answers, and hiding it is neither. Broadcasts
  // `dirty` rather than `world:changed`, `dismissFinding`'s reason — nothing in
  // the world moved, the cockpit just has a row fewer to draw.
  app.post(
    '/api/human-tasks/:id/dismiss',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const task = store.dismissHumanTask(params.id);
      if (!task) return reply.code(409).send({ error: 'human task not found, still open, or already dismissed' });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, humanTask: task };
    }),
  );
}

/**
 * What a concluded human part records as its outcome. The operator's note when
 * they left one, else the ask itself — never empty, because `outcomeSummary` is
 * what the plan comment, the modal and the retro dossier all read to say what the
 * part achieved.
 */
function humanPartSummary(task: { title: string; resolution: string | null }): string {
  return task.resolution ?? `Done by hand: ${task.title}`;
}
