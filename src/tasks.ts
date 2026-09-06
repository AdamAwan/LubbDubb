import type { TaskSummary } from './types.js';

// → docs/spec/13-jobs-and-tickets.md

const ACTIVE_TASK_STATUSES: readonly TaskSummary['status'][] = ['queued', 'running', 'waiting'];

export function isActiveTask(t: TaskSummary): boolean {
  return ACTIVE_TASK_STATUSES.includes(t.status);
}

export const ACTIVE_TASK_STATUS_SQL = `(${ACTIVE_TASK_STATUSES.map((s) => `'${s}'`).join(',')})`;
