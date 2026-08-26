import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../../store/store.js';
import { validateHumanTask } from '../../mcp/humanTasks.js';
import { closeOutIssueNumber, validationHeadline } from '../../delivery/closeOut.js';
import { goalValidation } from '../../validation/goal.js';
import { checked, IdParams, optionalText, requiredText } from '../validation.js';
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
  const { store, harness, connector, errors } = system;

  // File one as the operator. The agent arm is `request_human_task` on the MCP
  // channel; this is the same row with no agent behind it, which is exactly what
  // a null `agentId` means.
  const CreateBody = z.object({
    title: requiredText('title is required'),
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
      // Closing out a goal whose validation is not clear costs a sentence.
      //
      // The only place a validation verdict changes what an operator may do, and
      // it still blocks nothing: it refuses a *silent* close, not the close. The
      // discipline is `/decline`'s, for its reason — there must be no way out
      // that costs nothing to say — and the note goes on the row, which is what
      // a reader of this goal in a month actually finds.
      //
      // Read here rather than folded into the settle, because the harness settles
      // this kind of task itself when the tracker closes the item. That path is
      // not an operator deciding to move on, and putting the guard in the store
      // would either stop the sweep or make its resolution the excuse.
      const owed = closeOutValidation(store, params.id);
      if (owed && body.note === undefined)
        return reply.code(400).send({
          error: `note is required — ${owed.headline} Say what you are doing about them, or waive them first.`,
        });
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
    note: requiredText('note is required — say why, so a replan has something to go on'),
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

  // Close the tracker item from here — the close-out row's third verb, and the one
  // that does the work rather than recording that somebody else did it.
  //
  // The row already settles itself when the tracker stops listing the item open
  // (`closeOutPass`), so this is not a second way to answer the obligation: it is
  // the *act* the obligation asks for, taken through the same outbound seam the
  // plan back-out closes an issue with. What it saves is the round trip — the
  // operator was being asked to leave the cockpit, do one click in a tracker, and
  // come back to a row that would settle a pulse later.
  //
  // **It settles the row itself rather than waiting for the sweep.** The sweep is
  // still the authority for a close that happened anywhere else, and it is
  // idempotent against a row already settled; leaving this one to it would leave an
  // obligation standing in front of the operator who has just discharged it, for as
  // long as a pulse takes. The resolution deliberately does **not** carry
  // `DESK_SETTLED`: a person pressed this, so it is an operator's answer and the
  // reopen arm must not treat it as the harness's own.
  //
  // The capability is checked, for `/api/issues/:number/state`'s reason —
  // `closeIssue` throws where no integration implements it, and an operator would
  // read that as this write failing rather than as the deployment not having the
  // operation at all. The cockpit reads the same flag off `config.canCloseIssue`
  // and does not draw the button, so this is the backstop rather than the notice.
  const CloseTicketBody = z.object({ note: optionalText('note') });
  app.post(
    '/api/human-tasks/:id/close-ticket',
    checked({ params: IdParams, body: CloseTicketBody }, async ({ params, body, reply }) => {
      const task = store.getHumanTask(params.id);
      if (!task || task.kind !== 'close_out' || task.status !== 'open')
        return reply.code(409).send({ error: 'human task not found, not a close-out, or already settled' });
      const number = closeOutIssueNumber(task.originRef);
      if (number === null) return reply.code(409).send({ error: 'this close-out names no tracker item to close' });
      if (!connector.canCloseIssue())
        return reply
          .code(400)
          .send({ error: 'This tracker cannot be written from here — close the item there and this settles itself.' });
      // The same sentence `/done` costs, asked for the same reason and rather more
      // so: this one closes the item as well as the row, and a goal whose checks
      // are outstanding is exactly the one that should not be closed in silence.
      const owed = closeOutValidation(store, params.id);
      if (owed && body.note === undefined)
        return reply.code(400).send({
          error: `note is required — ${owed.headline} Say what you are doing about them, or waive them first.`,
        });

      try {
        const result = await connector.closeIssue({ number, reason: 'completed' });
        if (!result.ok) return reply.code(400).send({ error: `The tracker did not close #${number}.` });
      } catch (err) {
        // The provider's own sentence, quoted whole — it is the only account of why
        // the item is still open, and the row is left exactly where it was so the
        // obligation still stands.
        const message = (err as Error).message;
        errors.record({ source: 'server', message: `Failed to close #${number} from its close-out row: ${message}` });
        return reply.code(400).send({ error: message });
      }

      const settled = store.settleHumanTask(params.id, 'done', closeTicketResolution(number, body.note ?? null));
      hub.broadcast({ type: 'world:changed' });
      // The world just changed outside the harness, exactly as the watch toggle and
      // the board's drag change it: a cycle re-reads the tracker, so the goal page
      // stops calling the item open without waiting for the heartbeat.
      const report = await harness.runCycle('manual');
      return { ok: true, humanTask: settled, report };
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
 * What a `close_out` task's goal still owes, or null when nothing does.
 *
 * Narrow on purpose, and each narrowing is deliberate. Only `close_out` — an
 * ordinary ask has nothing to do with a goal's validation plan, and asking a note
 * of somebody ticking off "plug the cable in" would be the friction that gets the
 * whole flag ignored. Only an open task, only one with an origin, and only a
 * flagged verdict.
 */
function closeOutValidation(store: Store, taskId: string): { headline: string } | null {
  const task = store.getHumanTask(taskId);
  if (!task || task.kind !== 'close_out' || task.status !== 'open' || task.originRef === null) return null;
  const validation = goalValidation(store, task.originRef);
  if (!validation || validation.verdict.state === 'clear') return null;
  return { headline: validationHeadline(validation.verdict) };
}

/**
 * What the row says once the operator closed the item from here.
 *
 * It names the act rather than the observation, because the two are different
 * facts and only this one has an author: the sweep's own wording ("the tracker
 * shows it closed") is what a later reader gets when somebody closed the item
 * elsewhere, and a shared sentence would make every close look like the harness
 * noticing one. The note rides along where the flag asked for it, so the reason a
 * flagged goal was closed anyway is on the row a month later rather than in a
 * request log.
 */
function closeTicketResolution(issueNumber: number, note: string | null): string {
  const closed = `Closed #${issueNumber} in the tracker from the cockpit.`;
  return note === null ? closed : `${closed} ${note}`;
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
