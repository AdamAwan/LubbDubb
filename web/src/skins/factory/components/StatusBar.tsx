import type { JSX } from 'react';
import type { CockpitView } from '../../../view/viewModel.js';
import type { CockpitActions } from '../../../cockpit/actions.js';
import { AsyncButton } from '../../../components/AsyncButton.js';
import { FleetControl } from '../../../components/FleetControl.js';
import { UsageChip } from '../../../components/UsageChip.js';
import { relTime } from '../../../components/util.js';
import { SkinPicker } from '../../SkinPicker.js';
import { powerReading } from '../power.js';
import { Icon } from './Sprite.js';

/** One labelled gauge. */
function Read({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="fx-read">{children}</div>;
}

/**
 * The accumulator bank: the 7-day window as a reserve behind the 5-hour draw.
 *
 * Two gauges rather than one because they fail differently and an operator needs
 * to tell the difference — satisfaction full with the bank draining is a week's
 * budget going on a busy afternoon, which reads as healthy right up until it
 * isn't. Absent when the subscriber limits were never captured: there is no
 * denominator on an API key, and a bank drawn from nothing would be a decoration
 * standing in for a number.
 */
function Accumulators({ cells }: { cells: number[] }): JSX.Element {
  return (
    <span className="fx-accs" aria-hidden="true">
      {cells.map((fill, i) => (
        <span key={i} className="fx-acc fx-sunk">
          <i style={{ height: `${Math.round(fill * 100)}%` }} />
        </span>
      ))}
    </span>
  );
}

/**
 * The control-room strip: scan, power, bots, alerts, and the controls.
 *
 * The radar is the pulse, and it is the one gauge with an off state — it stops
 * turning when the harness is paused or held, because a sweep that keeps going
 * while nothing is being decided is the single most misleading thing this page
 * could draw.
 */
export function StatusBar({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const { state } = view;
  const stopped = view.pulseHeld || state.control.paused;
  // Power is the subscriber window when the status-line capture has seen one;
  // otherwise there is no percentage to draw and the shared cost chip says what
  // is actually known instead of a meter inventing a denominator.
  const power = powerReading(state.usage);

  return (
    <div className="fx-status fx-bev">
      <div className="fx-ident">
        <Icon name="assembler" className="lg" />
        <h1>Factory Floor</h1>
        <span className="sub">
          {state.config.dispatcher} dispatcher
          {view.demo && ' · demo'}
        </span>
      </div>

      <Read>
        <svg
          className={`fx-radar ${stopped ? 'held' : ''}`}
          viewBox="0 0 24 24"
          role="img"
          aria-label={
            view.pulseHeld
              ? 'Scan held: agents from the previous run need a recovery decision'
              : state.control.paused
                ? 'Scan paused'
                : `Next scan in about ${view.nextPulseIn} seconds`
          }
        >
          <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.3" opacity=".5" />
          <circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" strokeWidth="1" opacity=".35" />
          <g className="fx-sweep">
            <path d="M12 12 L12 2.5 A9.5 9.5 0 0 1 20.2 7.2 Z" fill="var(--accent)" opacity=".45" />
            <path d="M12 12 L12 2.5" stroke="var(--accent)" strokeWidth="1.4" />
          </g>
          <circle cx="12" cy="12" r="1.6" fill="var(--accent)" />
        </svg>
        <span className="fx-lbl">Scan</span>
        <span className="fx-val">
          {view.pulseHeld ? 'held' : state.control.paused ? 'paused' : `${view.nextPulseIn}s`}
          <small>
            {' · world '}
            {state.worldObservedAt ? relTime(state.worldObservedAt, view.now) : 'unseen'}
          </small>
        </span>
      </Read>

      {power.satisfaction !== null ? (
        <Read>
          <Icon name="battery" className="sm" />
          <span className="fx-lbl">Power</span>
          <span
            className={`fx-meter fx-sunk ${power.brownout ? 'low' : ''}`}
            role="img"
            aria-label={`Satisfaction: ${power.satisfaction} percent of the 5-hour model window remaining`}
          >
            <i style={{ width: `${power.satisfaction}%` }} />
          </span>
          <span className="fx-val">
            {power.satisfaction}
            <small>%</small>
          </span>
          {power.bank !== null && (
            <span
              className="fx-bank"
              title={`Accumulator bank: ${power.bank}% of the 7-day window left · $${power.sevenDayCostUsd.toFixed(2)} spent`}
            >
              <Accumulators cells={power.cells} />
              <span className="fx-lbl">Bank {power.bank}%</span>
            </span>
          )}
        </Read>
      ) : (
        <UsageChip usage={state.usage} now={view.now} />
      )}

      <Read>
        <Icon name="bot" className="sm" />
        <span className="fx-lbl">Bots</span>
        <span className="fx-val">
          {view.live.length}
          <small>/{state.control.cap}</small>
        </span>
      </Read>

      <Read>
        <Icon
          name="alert"
          className="sm"
          title={`${view.openEscalations.length} open alerts, ${state.errors.length} recorded faults`}
        />
        <span className="fx-lbl">Alerts</span>
        <span className={`fx-val ${view.openEscalations.length > 0 ? 'crit' : ''}`}>{view.openEscalations.length}</span>
      </Read>

      <span className={`chip ${view.connected ? 'ok' : 'bad'}`}>
        <span className={`dot ${view.connected ? 'green' : 'red'}`} /> {view.connected ? 'live' : 'offline'}
      </span>
      <FleetControl live={view.live.length} cap={state.control.cap} paused={state.control.paused} />
      <SkinPicker />
      <AsyncButton className="primary" onClick={() => actions.pulse()}>
        Run a scan
      </AsyncButton>
    </div>
  );
}
