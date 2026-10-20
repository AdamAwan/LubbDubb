import type { EnvironmentConfig } from '../environments/policy.js';
import { environmentGroups } from '../environments/groups.js';
import type { AppErrorDay, AppErrorGroup, AppErrorRead, AppErrorState } from '../types.js';
import type {
  AppErrorBandGroup,
  AppErrorBandView,
  AppErrorEnvironmentView,
  AppErrorGroupView,
  AppErrorsPayload,
} from '../wire.js';
import { DAY_MS, RETENTION_DAYS, dayOf } from './groups.js';
import { appErrorKey } from './key.js';
import { appErrorCount, appErrorState } from './states.js';

// → docs/spec/39-app-errors.md#on-the-wire

const STATE_RANK: Record<AppErrorState, number> = { new: 0, returned: 1, spiking: 2, steady: 3, gone: 4 };

interface AppErrorsViewInput {
  environments: readonly EnvironmentConfig[];
  reads: readonly AppErrorRead[];
  groups: readonly AppErrorGroup[];
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
  const days = lastDays(input.now);
  const environments: AppErrorEnvironmentView[] = declaring.map((env) => {
    const reading = input.reads.find((r) => r.environment === env.name) ?? null;
    const groups = input.groups
      .filter((g) => g.environment === env.name)
      .map((g): AppErrorGroupView => {
        const key = appErrorKey(input.project, g.fingerprint);
        const ignored = ignore.has(g.fingerprint) || ignore.has(key);
        return {
          ...g,
          daily: dense(g.daily, days),
          key,
          state: appErrorState({
            group: g,
            deployedAt: reading?.deployedAt ?? null,
            now: input.now,
            minCount: input.minCount,
            ignored,
          }),
          count: appErrorCount(g),
          ignored,
          link: null,
          tracker: null,
        };
      })
      .sort(byState);
    return { environment: env.name, band: bandOf.get(env.name) ?? env.name, reading, groups };
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
  const read = members.filter((m) => m.reading !== null);
  const status =
    read.length === 0
      ? null
      : members.every((m) => m.reading?.status === 'ok')
        ? ('ok' as const)
        : ('unknown' as const);
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
    status,
    groups: [...byKey.values()].sort(byState),
  };
}

function byState(a: { state: AppErrorState; lastSeen: string }, b: { state: AppErrorState; lastSeen: string }): number {
  return STATE_RANK[a.state] - STATE_RANK[b.state] || b.lastSeen.localeCompare(a.lastSeen);
}

function lastDays(now: number): string[] {
  return Array.from({ length: RETENTION_DAYS }, (_, i) => dayOf(now - (RETENTION_DAYS - 1 - i) * DAY_MS));
}

function dense(daily: readonly AppErrorDay[], days: readonly string[]): AppErrorDay[] {
  const counts = new Map(daily.map((d) => [d.day, d.count]));
  return days.map((day) => ({ day, count: counts.get(day) ?? 0 }));
}
