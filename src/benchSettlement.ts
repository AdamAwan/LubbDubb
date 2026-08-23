import type { HumanTask } from './types.js';

/**
 * The prefix a resolution carries when the **harness** settled a bench row rather
 * than a person.
 *
 * A settled row is normally the last thing said about an obligation, and that is
 * right when a person said it: an operator who declined "Provide fixture-repo.tar.gz"
 * must not be asked for it again next pulse. A desk that settles a row because the
 * obligation is not owed *right now* is saying something else entirely — every one
 * of those arms documents that the obligation comes back — and nothing else on
 * `human_tasks` tells the two apart. `recordHumanTask`'s dedup cannot: it keys on
 * `(agent_id, origin_ref, title, kind)` and ignores status, so a re-file refreshes
 * a settled row's detail and leaves it settled.
 *
 * A row settled before this prefix existed, or by any path that does not use it,
 * reads as an operator's. That is the safe direction: it leaves standing answers
 * standing.
 */
export const DESK_SETTLED = 'Settled by the harness — ';

/** Whether a desk settled this row itself, and so may reopen it when it is owed again. */
export function deskSettled(task: HumanTask): boolean {
  return (task.resolution ?? '').startsWith(DESK_SETTLED);
}
