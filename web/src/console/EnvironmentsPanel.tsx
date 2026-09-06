import type { JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { EnvironmentHealthReading } from '../types.js';
import { relTime } from '../components/util.js';
import { PanelRows, type PanelRowModel } from './PanelRow.js';
import { Tag, type TagTone } from '../components/tag.js';

// → docs/spec/17-cockpit.md

export function EnvironmentsPanel({ view }: { view: CockpitView }): JSX.Element {
  const readings = view.state.environmentHealth ?? [];
  if (readings.length === 0) return <p className="cn-empty">No environment declares a health check.</p>;
  return <PanelRows rows={readings.map((reading) => healthRow(reading, view.now))} />;
}

function healthRow(reading: EnvironmentHealthReading, now: number): PanelRowModel {
  const said = HEALTH_SAID[reading.state];
  return {
    key: reading.environment,
    title: reading.environment,
    refs: null,
    chips: (
      <Tag tone={healthTone(reading)} fill>
        {reading.tier ?? reading.state}
      </Tag>
    ),
    why: reading.reasons.length > 0 ? reading.reasons.join(' · ') : reading.detail,
    whyLabel: said,
    whyTone: reading.state === 'healthy' ? 'quiet' : reading.state === 'unknown' ? 'hold' : healthAsk(reading),
    facts: [
      { label: 'since', value: relTime(reading.changedAt, now) },
      { label: 'read', value: relTime(reading.observedAt, now) },
    ],
  };
}

const HEALTH_SAID: Record<EnvironmentHealthReading['state'], string> = {
  healthy: 'well',
  unhealthy: 'not well',
  unknown: 'no answer',
};

function healthTone(reading: EnvironmentHealthReading): TagTone {
  if (reading.state === 'healthy') return 'green';
  if (reading.state === 'unknown') return 'amber';
  return reading.tier === 'orange' ? 'amber' : 'red';
}

function healthAsk(reading: EnvironmentHealthReading): 'ask' | 'hold' {
  return reading.tier === 'orange' ? 'hold' : 'ask';
}
