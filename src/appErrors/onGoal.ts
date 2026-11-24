import type { AppErrorDismissal, AppErrorOnGoal } from '../types.js';
import type { AppErrorGroupView, AppErrorsPayload } from '../wire.js';
import { MOVED } from './states.js';

// → docs/spec/39-app-errors.md#on-the-goal, docs/spec/39-app-errors.md#not-it

function onGoalOf(group: AppErrorGroupView, dismissed: readonly string[]): AppErrorOnGoal | null {
  if (!MOVED.has(group.state)) return null;
  const link = group.link;
  if (link?.goalRef != null && link.how.some((how) => how !== 'route-hint') && !dismissed.includes(link.goalRef))
    return { goalRef: link.goalRef, basis: 'linked' };
  const triage = group.triage;
  if (triage?.verdict === 'caused-by' && triage.goalRef !== null && !dismissed.includes(triage.goalRef))
    return { goalRef: triage.goalRef, basis: 'guess' };
  return null;
}

/** Each group's "Not it"s, by key, and the goal it is put on. */
export function withGoals(payload: AppErrorsPayload, dismissals: readonly AppErrorDismissal[]): AppErrorsPayload {
  const byKey = new Map<string, string[]>();
  for (const d of dismissals) {
    const goals = byKey.get(d.key) ?? [];
    goals.push(d.goalRef);
    byKey.set(d.key, goals);
  }
  return {
    ...payload,
    environments: payload.environments.map((env) => ({
      ...env,
      groups: env.groups.map((g) => {
        const dismissed = byKey.get(g.key) ?? [];
        return { ...g, dismissed, onGoal: onGoalOf(g, dismissed) };
      }),
    })),
  };
}
