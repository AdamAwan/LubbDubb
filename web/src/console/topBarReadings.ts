import type { CockpitView } from '../view/viewModel.js';
import type { EnvironmentHealthReading } from '../types.js';
import type { CockpitActions } from '../cockpit/actions.js';
import { fmtUsd, relTime } from '../components/util.js';
import { signalRows } from './WorldSignals.js';

// → docs/spec/17-cockpit.md

interface EnvironmentsReading {
  value: string;
  quiet: boolean;
  tone: 'ill' | 'watch' | null;
  title: string;
}

function healthRank(reading: EnvironmentHealthReading): number {
  if (reading.state === 'unhealthy') return reading.tier === 'orange' ? 1 : 0;
  if (reading.state === 'unknown') return 2;
  return 3;
}

function healthWord(reading: EnvironmentHealthReading): string {
  if (reading.tier !== null) return reading.tier;
  return reading.state === 'healthy' ? 'well' : reading.state === 'unknown' ? 'no answer' : 'not well';
}

export function environmentsReading(readings: readonly EnvironmentHealthReading[], now: number): EnvironmentsReading {
  const worst = [...readings].sort((a, b) => healthRank(a) - healthRank(b))[0]!;
  const word = healthWord(worst);
  const count = readings.filter((r) => healthWord(r) === word).length;
  const rank = healthRank(worst);
  const read = `read ${relTime(worst.observedAt, now)}`;
  const said = worst.reasons.length > 0 ? worst.reasons.join(' · ') : worst.detail;
  const title =
    rank === 3
      ? `Every environment answered well — ${read}.`
      : `${worst.environment} ${worst.state === 'unknown' ? 'did not answer' : 'is not well'} — ${word} since ${relTime(worst.changedAt, now).replace(' ago', '')}, ${read}.${said === null || said === '' ? '' : ` ${said}`}`;
  return {
    value: `${count} ${word}`,
    quiet: rank === 3,
    tone: rank === 2 ? 'watch' : rank === 3 ? null : 'ill',
    title,
  };
}

function buildReading(view: CockpitView): MenuReading {
  const build = view.state.build;
  const due = build.state === 'behind' || build.state === 'ready';
  const title =
    build.state === 'behind'
      ? `LubbDubb is ${build.standing.behind} commit(s) behind upstream — open to see what changed`
      : build.state === 'draining'
        ? 'Upgrade pending: dispatch is paused while the fleet finishes — open to apply or cancel'
        : build.state === 'ready'
          ? 'Ready to upgrade — open to apply'
          : build.state === 'unknown'
            ? `This build could not be checked: ${build.standing.unavailable ?? 'no reason given'}`
            : 'This build is up to date with upstream — open for details';
  return {
    value: build.label,
    tone: due ? 'watch' : null,
    quiet: build.state === 'current' || build.state === 'unknown',
    title,
  };
}

const USAGE_STALE_MS = 10 * 60 * 1000;

type Usage = CockpitView['state']['usage'];
type UsageWindow = NonNullable<Usage['rateLimits']>['fiveHour'];

interface UsageSlot {
  label: string;
  value: string;
  binds: boolean;
}

interface UsageReading {
  slots: UsageSlot[];
  cost: string | null;
  tone: 'quiet' | 'plain' | 'warn' | 'spent';
  title: string;
  age: string | null;
}

function resetIn(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / (24 * 60))}d`;
}

function spendReading({ fiveHourCostUsd, sevenDayCostUsd }: Usage['windows']): UsageReading {
  return {
    slots: [],
    cost: fmtUsd(fiveHourCostUsd),
    tone: fiveHourCostUsd === 0 && sevenDayCostUsd === 0 ? 'quiet' : 'plain',
    title:
      'No subscriber usage windows have been reported — API-key auth, or no agent has taken a turn yet. ' +
      `Spent ${fmtUsd(fiveHourCostUsd)} in the last five hours, ${fmtUsd(sevenDayCostUsd)} over seven days.`,
    age: null,
  };
}

function usageTone(pct: number): UsageReading['tone'] {
  return pct >= 90 ? 'spent' : pct >= 75 ? 'warn' : pct >= 25 ? 'plain' : 'quiet';
}

function windowsTitle(weekBinds: boolean, binding: UsageWindow, other: UsageWindow, now: number): string {
  const bindingPct = binding === null ? 0 : Math.round(binding.usedPercentage);
  return (
    `Claude account: ${weekBinds ? 'weekly' : 'five-hour'} window ${bindingPct}% used` +
    `${binding?.resetsAt == null ? '' : `, resets in ${resetIn(binding.resetsAt, now)}`}` +
    `${other === null ? '' : ` · ${weekBinds ? 'five-hour' : 'weekly'} ${Math.round(other.usedPercentage)}%`}. `
  );
}

export function usageReading(usage: Usage, now: number): UsageReading {
  const limits = usage.rateLimits;
  const five = limits?.fiveHour ?? null;
  const seven = limits?.sevenDay ?? null;

  if (limits === null || (five === null && seven === null)) return spendReading(usage.windows);

  const weekBinds = five === null || (seven !== null && seven.usedPercentage > five.usedPercentage);
  const binding = weekBinds ? seven : five;
  const pct = (w: UsageWindow) => (w === null ? '—' : `${Math.round(w.usedPercentage)}%`);

  return {
    slots: [
      { label: '5h', value: pct(five), binds: !weekBinds },
      { label: '7d', value: pct(seven), binds: weekBinds },
    ],
    cost: null,
    tone: usageTone(binding === null ? 0 : Math.round(binding.usedPercentage)),
    title:
      windowsTitle(weekBinds, binding, weekBinds ? five : seven, now) +
      `Read ${relTime(limits.capturedAt, now)} off an agent's turn — the windows keep moving while the fleet is idle.`,
    age: now - new Date(limits.capturedAt).getTime() >= USAGE_STALE_MS ? relTime(limits.capturedAt, now) : null,
  };
}

interface MenuReading {
  value: string | null;
  tone: 'ill' | 'watch' | null;
  quiet: boolean;
  title: string;
}

interface MenuEntry extends MenuReading {
  key: string;
  icon: 'alert' | 'rocket' | 'download' | 'globe' | 'bolt' | 'book' | 'gear';
  label: string;
  pending?: boolean;
  onPick: () => void;
}

function envEntries(view: CockpitView, actions: CockpitActions): MenuEntry[] {
  const health = view.state.environmentHealth ?? [];
  if (health.length === 0) return [];
  const env = environmentsReading(health, view.now);
  return [
    {
      key: 'env',
      icon: 'globe',
      label: 'Env',
      value: env.value,
      tone: env.tone,
      quiet: env.quiet,
      title: env.title,
      onPick: () => actions.openPanel('environments'),
    },
  ];
}

export function menuEntries(view: CockpitView, actions: CockpitActions, themeUnsaved = false): MenuEntry[] {
  const faults = view.state.errors.length;
  const queued = view.state.jobs.filter((job) => job.status === 'queued').length;
  const build = buildReading(view);
  const signals = signalRows(view).length;
  return [
    {
      key: 'faults',
      icon: 'alert',
      label: 'Faults',
      value: `${faults}`,
      tone: faults === 0 ? null : 'ill',
      quiet: faults === 0,
      title: 'Recorded faults — open the fault log',
      onPick: () => actions.openPanel('faults'),
    },
    {
      key: 'launch',
      icon: 'rocket',
      label: 'Launch',
      value: `${queued}`,
      tone: null,
      quiet: queued === 0,
      title: 'Briefs waiting for a free slot — open the launch desk',
      onPick: () => actions.openPanel('launch'),
    },
    {
      key: 'build',
      icon: 'download',
      label: 'Build',
      value: build.value,
      tone: build.tone,
      quiet: build.quiet,
      title: build.title,
      onPick: () => actions.openPanel('build'),
    },
    ...envEntries(view, actions),
    {
      key: 'signals',
      icon: 'bolt',
      label: 'Signals',
      value: `${signals}`,
      tone: null,
      quiet: signals === 0,
      title: 'What the world did — the feed the queue is decided off',
      onPick: () => actions.openPanel('signals'),
    },
    {
      key: 'record',
      icon: 'book',
      label: 'Record',
      value: null,
      tone: null,
      quiet: false,
      title: 'What the harness did, after the world snapshot forgot it — operator jobs, and the goals it has worked',
      onPick: () => actions.openPanel('record'),
    },
    {
      key: 'config',
      icon: 'gear',
      label: 'Config',
      value: null,
      tone: null,
      quiet: false,
      pending: themeUnsaved,
      title: themeUnsaved
        ? 'Config — an unsaved theme edit is pending; a reload drops it'
        : 'Config — how this harness is configured',
      onPick: () => actions.openConfig({}),
    },
  ];
}
