import type { JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { EnvironmentHealthReading } from '../types.js';
import { relTime } from '../components/util.js';
import { PanelRows, type PanelRowModel } from './PanelRow.js';
import { Tag, type TagTone } from '../components/tag.js';

/**
 * Whether each environment is **well** right now — one row per environment whose
 * operator gave it a health check.
 *
 * A panel rather than the overview card it used to be. Health is a fact about the
 * world the work ships into and not about anything on that page, and the answer is
 * *well* nearly all of the time: a sixth of the overview spent saying so, on the
 * page that answers *what is happening*. The reading that was actually read off it
 * — is anything broken out there — is the bar's `Env` chip, drawn only while
 * something is; this is what opens from it, and from the menu row beside it, when
 * the answer is *which, and what did the check say*.
 *
 * Not on a goal page, for the reason the card was not: drawn per goal it would be
 * the same sentence repeated on every card, and the place it is actually read has
 * no goal selected.
 *
 * Nothing here re-decides anything. The tier is the check's own word, the reasons
 * are its own sentences drawn verbatim, and `unknown` is drawn as its own reading
 * rather than folded into either of the two that mean something.
 * → docs/spec/24-environments.md#in-the-cockpit
 */
export function EnvironmentsPanel({ view }: { view: CockpitView }): JSX.Element {
  const readings = view.state.environmentHealth ?? [];
  // The panel opens from a reading that is itself absent where no environment
  // declares a check, so this is the arm nobody can reach by clicking — reachable
  // by URL, which is exactly why it says something rather than drawing an empty box.
  if (readings.length === 0) return <p className="cn-empty">No environment declares a health check.</p>;
  return <PanelRows rows={readings.map((reading) => healthRow(reading, view.now))} />;
}

/**
 * One environment's health, as a row.
 *
 * The reasons go behind the marker rather than on the glass, where every other
 * panel's long sentence goes: a check naming six services would otherwise be the
 * one row here three lines tall. What stays visible is the half a glance needs —
 * the word, and how long it has been that word.
 */
function healthRow(reading: EnvironmentHealthReading, now: number): PanelRowModel {
  const said = HEALTH_SAID[reading.state];
  return {
    key: reading.environment,
    title: reading.environment,
    // Nowhere to go: an environment is a command in a config file, not a thing
    // with a page. Said in the model rather than left out, which is the field's
    // whole purpose.
    refs: null,
    chips: (
      <Tag tone={healthTone(reading)} fill>
        {reading.tier ?? reading.state}
      </Tag>
    ),
    // The check's own sentences, verbatim and joined — or the harness's account of
    // why it has none, which is a different thing and never dressed as one.
    why: reading.reasons.length > 0 ? reading.reasons.join(' · ') : reading.detail,
    whyLabel: said,
    whyTone: reading.state === 'healthy' ? 'quiet' : reading.state === 'unknown' ? 'hold' : healthAsk(reading),
    facts: [
      { label: 'since', value: relTime(reading.changedAt, now) },
      { label: 'read', value: relTime(reading.observedAt, now) },
    ],
  };
}

/** What each state is called on the row, in the words an operator would use. */
const HEALTH_SAID: Record<EnvironmentHealthReading['state'], string> = {
  healthy: 'well',
  unhealthy: 'not well',
  unknown: 'no answer',
};

/**
 * No new colours: every tone is one the cockpit already draws, so the panel follows
 * a theme switch without the token layer having to learn about it.
 *
 * `unknown` takes the same amber as `orange` and is told apart by the word beside
 * it, which is the honest pairing — a check that could not answer is a thing to
 * look at, and drawing it green or red would be claiming an answer it did not give.
 * An **untiered** `unhealthy` takes red: a severity nobody stated is not a reason
 * to draw an outage quietly.
 */
function healthTone(reading: EnvironmentHealthReading): TagTone {
  if (reading.state === 'healthy') return 'green';
  if (reading.state === 'unknown') return 'amber';
  return reading.tier === 'orange' ? 'amber' : 'red';
}

/** An orange is the harness holding its nerve; a red — or an untiered one — is your move. */
function healthAsk(reading: EnvironmentHealthReading): 'ask' | 'hold' {
  return reading.tier === 'orange' ? 'hold' : 'ask';
}
