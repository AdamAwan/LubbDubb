import { validationHeadline } from './delivery/closeOut.js';
import type { Store } from './store/store.js';
import type { HumanTask, PlanPart } from './types.js';
import { goalValidation } from './validation/goal.js';

/**
 * The two ways a bench row is answered, as one function both surfaces call.
 *
 * The cockpit's routes were the only place a human task settled, which made the
 * route the definition of what settling *means* — the close-out's note, the part
 * that concludes on `done` and deliberately does not on `declined`. The desktop
 * channel needs the same act, and a second copy of those rules would be free to
 * drift: an operator answering from their own Claude could conclude a part the
 * cockpit would have left blocked, silently.
 *
 * The caller keeps what is theirs — broadcasting, and running the cycle when
 * `runCycle` says a part moved. What is decided here is the settlement.
 */
type HumanTaskSettleInput = {
  id: string;
  status: 'done' | 'declined';
  /** The operator's note. `undefined` is "none given", which `done` may refuse. */
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
    // The backing part is deliberately left where it is: concluding it would make
    // `partSettled` true and release every dependent waiting on the work that was
    // just refused. → `docs/spec/13-jobs-and-tickets.md#declining-is-a-settlement-not-a-failure`
    return { ok: true, task, part: null, runCycle: task.partId !== null };
  }

  // Closing out a goal whose validation is not clear costs a sentence — it refuses
  // a *silent* close, not the close.
  const owed = closeOutValidation(store, input.id);
  if (owed && note === undefined)
    return {
      ok: false,
      code: 400,
      error: `note is required — ${owed.headline} Say what you are doing about them, or waive them first.`,
    };
  // Settle the task first, then the part: a failed part write leaves a settled task
  // an operator can see, where the other order would leave a concluded part nothing
  // accounts for. `concludeHumanPart` is compare-and-set, so a part somebody merged
  // or retired underneath this is left alone.
  const task = store.settleHumanTask(input.id, 'done', note ?? null);
  if (!task) return { ok: false, code: 409, error: 'human task not found or already settled' };
  const part = task.partId ? store.concludeHumanPart(task.partId, humanPartSummary(task)) : null;
  return { ok: true, task, part, runCycle: part !== null };
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
export function closeOutValidation(store: Store, taskId: string): { headline: string } | null {
  const task = store.getHumanTask(taskId);
  if (!task || task.kind !== 'close_out' || task.status !== 'open' || task.originRef === null) return null;
  const validation = goalValidation(store, task.originRef);
  if (!validation || validation.verdict.state === 'clear') return null;
  return { headline: validationHeadline(validation.verdict) };
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
