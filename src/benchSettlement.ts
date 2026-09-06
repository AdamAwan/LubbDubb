import type { HumanTask } from './types.js';

// → docs/spec/20-validation.md

export const DESK_SETTLED = 'Settled by the harness — ';

export function deskSettled(task: HumanTask): boolean {
  return (task.resolution ?? '').startsWith(DESK_SETTLED);
}
