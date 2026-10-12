import type { JSX } from 'react';
import type { PoolInsightsPayload, PoolTrends } from '../types.js';
import type { CockpitActions } from '../cockpit/actions.js';
import { fmtUsd } from './util.js';
import { BareButton } from './button.js';
import { Label } from './label.js';
import { MethodNote } from './insightsMethod.js';

// → docs/spec/28-cross-fleet-pool.md#the-trend-tab

type Step = PoolTrends['steps'][number];
type Release = Step['releases'][number];

export function PoolTrend({
  payload,
  step: chosen,
  actions,
}: {
  payload: PoolInsightsPayload;
  step: string | null;
  actions: CockpitActions;
}): JSX.Element {
  const { trends } = payload;
  const { smoothingDays, compareDays, recentDays } = trends.windows;
  if (trends.steps.length === 0)
    return (
      <p className="empty">
        No fleet has published what its steps cost yet. A fleet starts to once it runs a build with the trend section.
      </p>
    );
  const step = trends.steps.find((s) => s.key === chosen) ?? trends.steps[0]!;
  const latest = step.releases.at(-1) ?? null;
  return (
    <div className="pool">
      <div className="pt-steps" role="group" aria-label="Step">
        <Label dense>Step</Label>
        {trends.steps.map((s) => (
          <BareButton
            key={s.key}
            usage="pool.filter"
            logs={s.key !== step.key}
            aria-pressed={s.key === step.key}
            className={s.key === step.key ? 'on' : ''}
            onClick={() => actions.openInsights({ poolStep: s.key })}
          >
            {s.label}
          </BareButton>
        ))}
      </div>

      <section className="pool-section">
        <h3>{step.label} · cost per run</h3>
        <p className="pool-note">
          {smoothingDays}-day average across {step.fleets} fleet{step.fleets === 1 ? '' : 's'}. The line is the middle
          fleet, the band the middle half, and each dashed line a harness version arriving.
        </p>
        <TrendChart days={trends.days} step={step} />
      </section>

      <Releases step={step} compareDays={compareDays} />

      {latest !== null && (
        <section className="pool-section">
          <h3>By fleet, around {latest.version}</h3>
          <p className="pool-note">which fleets the latest release moved, and which it did not</p>
          <FleetTable release={latest} />
        </section>
      )}

      <section className="pool-section">
        <h3>
          Every step, last {recentDays} days against the {recentDays} before
        </h3>
        <p className="pool-note">pooled per run, so a busy fleet weighs what it spent</p>
        <StepTable steps={trends.steps} chosen={step.key} recentDays={recentDays} actions={actions} />
      </section>

      <TrendMethod />
    </div>
  );
}

function Releases({ step, compareDays }: { step: Step; compareDays: number }): JSX.Element {
  return (
    <section className="pool-section">
      <h3>What each release did to this step</h3>
      <p className="pool-note">
        Each fleet&apos;s {compareDays} days before its upgrade against the {compareDays} after it, per run. The newest{' '}
        {RECENT_RELEASES} first; every release is marked on the chart.
      </p>
      {step.releases.length === 0 ? (
        <p className="empty">No fleet has changed harness version while running this step.</p>
      ) : (
        <div className="pt-releases">
          {step.releases
            .slice(-RECENT_RELEASES)
            .reverse()
            .map((r) => (
              <ReleaseCard key={r.version} release={r} />
            ))}
        </div>
      )}
    </section>
  );
}

function TrendMethod(): JSX.Element {
  return (
    <MethodNote>
      <p>
        <b>A step is a dispatch rule</b>, the harness&apos;s own vocabulary, so it sums across projects. Runs nothing
        proposed are not a step and are left out here; they stay on Economics.
      </p>
      <p>
        <b>A release is a version a fleet was seen moving to.</b> The first version a fleet ever reports is where its
        record starts, not a change. Each fleet is compared around its own upgrade day, so a fleet that upgraded late
        does not count its old-version days as after.
      </p>
      <p>
        <b>Today is left out</b> of every figure here: it is still filling, and a half-day reads as a cheap one.
      </p>
    </MethodNote>
  );
}

const RECENT_RELEASES = 6;

function shortBuild(version: string): string {
  return version.split('+').at(-1)!.slice(0, 7);
}

const W = 720;
const H = 240;
const P = { left: 52, right: 12, top: 22, bottom: 24 };

function TrendChart({ days, step }: { days: readonly string[]; step: Step }): JSX.Element {
  const top =
    [step.upper, ...step.byFleet.map((f) => f.perRunUsd)].reduce(
      (peak, series) => series.reduce<number>((m, v) => (v === null ? m : Math.max(m, v)), peak),
      0.01,
    ) * 1.05;
  const last = Math.max(days.length - 1, 1);
  const x = (i: number) => P.left + (i / last) * (W - P.left - P.right);
  const y = (v: number) => P.top + (1 - v / top) * (H - P.top - P.bottom);
  const line = (series: readonly (number | null)[]) =>
    series
      .map((v, i) => (v === null ? '' : `${i === 0 || series[i - 1] === null ? 'M' : 'L'}${x(i)} ${y(v)}`))
      .join('');
  const bands: string[] = [];
  let run: number[] = [];
  const close = () => {
    if (run.length > 0) {
      const top = run.map((i) => `${x(i)} ${y(step.upper[i]!)}`);
      const bottom = run.map((i) => `${x(i)} ${y(step.lower[i]!)}`).reverse();
      bands.push(`M${[...top, ...bottom].join('L')}Z`);
    }
    run = [];
  };
  step.upper.forEach((v, i) => (v === null || step.lower[i] === null ? close() : run.push(i)));
  close();
  const ticks = [0, 0.5, 1];
  const labelEvery = Math.max(1, Math.ceil(days.length / 6));
  const endAt = step.median.reduce<number>((at, v, i) => (v === null ? at : i), -1);

  return (
    <div className="sp-well pt-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${step.label}: median cost per run by day`}>
        <g stroke="var(--border-lo)" strokeWidth="1">
          {ticks.map((f) => (
            <path key={f} d={`M${P.left} ${P.top + f * (H - P.top - P.bottom)}H${W - P.right}`} />
          ))}
        </g>
        <g className="sp-axis" textAnchor="end">
          {ticks.map((f) => (
            <text key={f} x={P.left - 7} y={P.top + f * (H - P.top - P.bottom) + 3}>
              {fmtUsd(top * (1 - f))}
            </text>
          ))}
        </g>
        <g className="sp-axis" textAnchor="middle">
          {days.map((day, i) =>
            i % labelEvery === 0 ? (
              <text key={day} x={x(i)} y={H - 6}>
                {day.slice(5)}
              </text>
            ) : null,
          )}
        </g>
        {bands.map((d) => (
          <path key={d} d={d} fill="var(--accent)" opacity="0.14" />
        ))}
        {step.byFleet.map((f) => (
          <path key={f.fleetId} d={line(f.perRunUsd)} fill="none" stroke="var(--text)" strokeWidth="1" opacity="0.18">
            <title>{f.fleetId}</title>
          </path>
        ))}
        {step.releases.map((r) => {
          const i = days.indexOf(r.day);
          if (i < 0) return null;
          return (
            <g key={r.version}>
              <path d={`M${x(i)} ${P.top - 6}V${H - P.bottom}`} stroke="var(--blue)" strokeDasharray="4 3" />
              <text className="pt-mark" x={x(i) + 4} y={P.top - 9} fill="var(--blue)">
                {shortBuild(r.version)}
                <title>{r.version}</title>
              </text>
            </g>
          );
        })}
        <path d={line(step.median)} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
        {endAt >= 0 && <circle cx={x(endAt)} cy={y(step.median[endAt]!)} r="3.5" fill="var(--accent)" />}
      </svg>
    </div>
  );
}

function ReleaseCard({ release }: { release: Release }): JSX.Element {
  const compared = release.cheaper + release.dearer + release.steady;
  return (
    <div className="pt-release sp-well">
      <span className="pt-ver">
        {release.version} · first seen {release.day}
      </span>
      <span className="pt-big">
        {usd(release.beforePerRunUsd)} → {usd(release.afterPerRunUsd)} <Change shift={release} />
      </span>
      <span className="pool-note">
        per run, pooled ·{' '}
        {compared === 0
          ? 'not enough whole days on both sides of it yet'
          : `${release.cheaper} of ${compared} fleets cheaper, ${release.dearer} dearer, ${release.steady} about the same`}
      </span>
    </div>
  );
}

function FleetTable({ release }: { release: Release }): JSX.Element {
  const rows = [...release.fleets].sort((a, b) => (a.changePct ?? Infinity) - (b.changePct ?? Infinity));
  return (
    <table className="pool-table">
      <thead>
        <tr>
          <th>Fleet</th>
          <th>Upgraded</th>
          <th className="num">Before</th>
          <th className="num">After</th>
          <th className="num">Change</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.fleetId}>
            <td>{r.fleetId}</td>
            <td>{r.day}</td>
            <td className="num">{usd(r.beforePerRunUsd)}</td>
            <td className="num">{usd(r.afterPerRunUsd)}</td>
            <td className="num">
              <Change shift={r} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StepTable({
  steps,
  chosen,
  recentDays,
  actions,
}: {
  steps: readonly Step[];
  chosen: string;
  recentDays: number;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <table className="pool-table">
      <thead>
        <tr>
          <th>Step</th>
          <th className="num">Prior {recentDays}d</th>
          <th className="num">Last {recentDays}d</th>
          <th className="num">Change</th>
          <th className="num">Runs</th>
          <th className="num">Fleets</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((s) => {
          return (
            <tr key={s.key} className={s.key === chosen ? 'pt-on' : undefined}>
              <td>
                <BareButton
                  usage="pool.filter"
                  logs={s.key !== chosen}
                  className="pt-link"
                  onClick={() => actions.openInsights({ poolStep: s.key })}
                >
                  {s.label}
                </BareButton>
              </td>
              <td className="num">{usd(s.recent.beforePerRunUsd)}</td>
              <td className="num">{usd(s.recent.afterPerRunUsd)}</td>
              <td className="num">
                <Change shift={s.recent} />
              </td>
              <td className="num">{s.runs}</td>
              <td className="num">{s.fleets}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* Never `$0.00` for an absence: a dash says no run was measured. */
function usd(value: number | null): string {
  return value === null ? '—' : fmtUsd(value);
}

const TONE = { cheaper: 'good', dearer: 'bad', steady: 'level' } as const;

function Change({ shift }: { shift: Step['recent'] }): JSX.Element {
  if (shift.changePct === null || shift.verdict === null) return <span className="sp-delta level">—</span>;
  const sign = shift.changePct > 0 ? '+' : shift.changePct < 0 ? '−' : '';
  return <span className={`sp-delta ${TONE[shift.verdict]}`}>{`${sign}${Math.abs(shift.changePct)}%`}</span>;
}
