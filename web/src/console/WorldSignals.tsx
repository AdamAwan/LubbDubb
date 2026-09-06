import type { JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { GoalArrival, WorldEvent } from '../types.js';
import { goalOfPr } from '../view/goalPage.js';
import { relTime } from '../components/util.js';
import { Ref, RefText, refLabel } from '../components/refs.js';
import { PanelRows } from './PanelRow.js';

// → docs/spec/17-cockpit.md

export function WorldSignals({ view }: { view: CockpitView }): JSX.Element {
  const rows = signalRows(view);
  if (rows.length === 0) return <p className="cn-empty">The world has not moved.</p>;
  return (
    <PanelRows
      rows={rows.map((row) => ({
        key: row.key,
        title: <RefText text={row.summary} />,
        refs: <Ref to={goalBehind(view, row.ref)} />,
        facts: [
          { label: 'kind', value: row.kind },
          { label: 'when', value: relTime(row.createdAt, view.now) },
          ...(row.count > 1 ? [{ label: 'times', value: `×${row.count}` }] : []),
        ],
      }))}
    />
  );
}

export function signalRows(view: CockpitView): Signal[] {
  return [
    ...groupSignals(view.state.worldEvents),
    ...arrivalSignals(view.state.environmentArrivals ?? [], view.now),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function goalBehind(view: CockpitView, ref: string | null): string | null {
  if (ref === null) return null;
  if (/^issue:\d+/.test(ref)) return ref;
  const pr = /^pr:(\d+)/.exec(ref);
  return pr ? goalOfPr(view.state, Number(pr[1])) : null;
}

interface Signal {
  key: string;
  kind: string;
  ref: string | null;
  summary: string;
  createdAt: string;
  count: number;
}

function groupSignals(events: readonly WorldEvent[]): Signal[] {
  const rows = new Map<string, Signal>();
  for (const event of events) {
    const key = `${event.kind}|${event.ref ?? ''}`;
    const seen = rows.get(key);
    if (seen) seen.count += 1;
    else
      rows.set(key, {
        key,
        kind: event.kind,
        ref: event.ref,
        summary: event.summary,
        createdAt: event.createdAt,
        count: 1,
      });
  }
  return [...rows.values()];
}

function arrivalSignals(arrivals: readonly GoalArrival[], now: number): Signal[] {
  const cutoff = now - SIGNAL_WINDOW_MS;
  return arrivals
    .filter((a) => Date.parse(a.arrivedAt) >= cutoff)
    .map((a) => ({
      key: `arrival|${a.goalRef}|${a.environment}`,
      kind: 'environment',
      ref: a.goalRef,
      summary: `${refLabel(a.goalRef)} reached ${a.environment}`,
      createdAt: a.arrivedAt,
      count: 1,
    }));
}

const SIGNAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
