import type { EnvironmentConfig } from '../environments/policy.js';
import { environmentGroups } from '../environments/groups.js';
import { groupBy } from '../primitives.js';
import type {
  AppErrorDay,
  AppErrorGroup,
  AppErrorRead,
  AppErrorReadStatus,
  AppErrorState,
  DeployedHead,
} from '../types.js';
import type {
  AppErrorBandGroup,
  AppErrorBandView,
  AppErrorEnvironmentView,
  AppErrorGroupView,
  AppErrorsPayload,
} from '../wire.js';
import { retainedDays } from './groups.js';
import { appErrorKey } from './key.js';
import { appErrorCount, appErrorState } from './states.js';

// → docs/spec/39-app-errors.md#on-the-wire

const STATE_RANK: Record<AppErrorState, number> = { new: 0, returned: 1, spiking: 2, steady: 3, gone: 4 };

interface AppErrorsViewInput {
  environments: readonly EnvironmentConfig[];
  reads: readonly AppErrorRead[];
  groups: readonly AppErrorGroup[];
  heads: readonly DeployedHead[];
  project: string;
  minCount: number;
  ignore: readonly string[];
  now: number;
}

export function appErrorsView(input: AppErrorsViewInput): AppErrorsPayload {
  const declaring = input.environments.filter((e) => e.errors !== undefined);
  const bands = environmentGroups(declaring);
  const bandOf = new Map(bands.flatMap((b) => b.environments.map((name) => [name, b.name] as const)));
  const ignore = new Set(input.ignore);
  const days = retainedDays(input.now);
  const reads = new Map(input.reads.map((r) => [r.environment, r]));
  const heads = new Map(input.heads.map((h) => [h.environment, h]));
  const groupsOf = groupBy(input.groups, (g) => g.environment);
  const environments: AppErrorEnvironmentView[] = declaring.map((env) => {
    const reading = reads.get(env.name) ?? null;
    const head = heads.get(env.name) ?? null;
    const groups = (groupsOf.get(env.name) ?? [])
      .map((g): AppErrorGroupView => {
        const key = appErrorKey(input.project, g.fingerprint);
        const ignored = ignore.has(g.fingerprint) || ignore.has(key);
        const group = { ...g, daily: dense(g.daily, days) };
        return {
          ...group,
          key,
          state: appErrorState({
            group,
            deployedAt: head?.changedAt ?? null,
            now: input.now,
            minCount: input.minCount,
            ignored,
          }),
          count: appErrorCount(group),
          ignored,
          link: null,
          tracker: null,
        };
      })
      .sort(byState);
    return { environment: env.name, band: bandOf.get(env.name) ?? env.name, reading, head, groups };
  });
  return {
    project: input.project,
    environments,
    bands: bands.map((band) => bandView(band, environments)),
  };
}

function bandView(
  band: { name: string; environments: string[]; declared: boolean },
  environments: readonly AppErrorEnvironmentView[],
): AppErrorBandView {
  const members = environments.filter((e) => band.environments.includes(e.environment));
  const byKey = new Map<string, AppErrorBandGroup>();
  for (const member of members)
    for (const g of member.groups) {
      const held = byKey.get(g.key);
      if (held === undefined) {
        byKey.set(g.key, {
          key: g.key,
          fingerprint: g.fingerprint,
          title: g.title,
          state: g.state,
          environments: [member.environment],
          count: g.count,
          lastSeen: g.lastSeen,
        });
        continue;
      }
      held.environments.push(member.environment);
      held.count += g.count;
      if (STATE_RANK[g.state] < STATE_RANK[held.state]) held.state = g.state;
      if (g.lastSeen > held.lastSeen) {
        held.lastSeen = g.lastSeen;
        held.title = g.title;
      }
    }
  return {
    band: band.name,
    declared: band.declared,
    environments: band.environments,
    status: bandStatus(members),
    groups: [...byKey.values()].sort(byState),
  };
}

function byState(a: { state: AppErrorState; lastSeen: string }, b: { state: AppErrorState; lastSeen: string }): number {
  return STATE_RANK[a.state] - STATE_RANK[b.state] || b.lastSeen.localeCompare(a.lastSeen);
}

function bandStatus(members: readonly AppErrorEnvironmentView[]): AppErrorReadStatus | null {
  if (members.every((m) => m.reading === null)) return null;
  return members.every((m) => m.reading?.status === 'ok') ? 'ok' : 'unknown';
}

function dense(daily: readonly AppErrorDay[], days: readonly string[]): AppErrorDay[] {
  const counts = new Map(daily.map((d) => [d.day, d.count]));
  return days.map((day) => ({ day, count: counts.get(day) ?? 0 }));
}
