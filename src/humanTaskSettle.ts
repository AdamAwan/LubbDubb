import { validationHeadline } from './delivery/closeOut.js';
import type { Store } from './store/store.js';
import type { HumanTask, PlanPart } from './types.js';
import { goalValidation } from './validation/goal.js';

// → docs/spec/13-jobs-and-tickets.md

type HumanTaskSettleInput = {
  id: string;
  status: 'done' | 'declined';
  note?: string | null;
};

type HumanTaskSettleResult =
  | { ok: true; task: HumanTask; part: PlanPart | null; runCycle: boolean }
  | { ok: false; error: string; code: 400 | 409 };

export function settleHumanTask(store: Store, input: HumanTaskSettleInput): HumanTaskSettleResult {
  const note = typeof input.note === 'string' ? input.note.trim() : input.note;
  if (input.status === 'declined') {
    if (!note) return { ok: false, code: 400, error: 'note is required — say why, so a replan has something to go on' };
    const task = store.settleHumanTask(input.id, 'declined', note);
    if (!task) return { ok: false, code: 409, error: 'human task not found or already settled' };
    return { ok: true, task, part: null, runCycle: task.partId !== null };
  }

  const owed = closeOutValidation(store, input.id);
  if (owed && note === undefined)
    return {
      ok: false,
      code: 400,
      error: `note is required — ${owed.headline} Say what you are doing about them, or waive them first.`,
    };
  const task = store.settleHumanTask(input.id, 'done', note ?? null);
  if (!task) return { ok: false, code: 409, error: 'human task not found or already settled' };
  const part = task.partId ? store.concludeHumanPart(task.partId, humanPartSummary(task)) : null;
  return { ok: true, task, part, runCycle: part !== null };
}

export function closeOutValidation(store: Store, taskId: string): { headline: string } | null {
  const task = store.getHumanTask(taskId);
  if (!task || task.kind !== 'close_out' || task.status !== 'open' || task.originRef === null) return null;
  const validation = goalValidation(store, task.originRef);
  if (!validation || validation.verdict.state === 'clear') return null;
  return { headline: validationHeadline(validation.verdict) };
}

function humanPartSummary(task: { title: string; resolution: string | null }): string {
  return task.resolution ?? `Done by hand: ${task.title}`;
}
