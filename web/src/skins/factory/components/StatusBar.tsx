import type { JSX } from 'react';
import type { CockpitView } from '../../../view/viewModel.js';
import type { CockpitActions } from '../../../cockpit/actions.js';
import { AsyncButton } from '../../../components/AsyncButton.js';
import { FleetControl } from '../../../components/FleetControl.js';
import { UsageChip } from '../../../components/UsageChip.js';
import { relTime } from '../../../components/util.js';
import { SkinPicker } from '../../SkinPicker.js';
import { Icon } from './Sprite.js';

/** One labelled gauge. */
function Read({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="fx-read">{children}</div>;
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
  const fiveHour = state.usage.rateLimits?.fiveHour ?? null;
  const remaining = fiveHour ? Math.max(0, 100 - fiveHour.usedPercentage) : null;

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

      {remaining !== null ? (
        <Read>
          <Icon name="battery" className="sm" />
          <span className="fx-lbl">Power</span>
          <span
            className={`fx-meter fx-sunk ${remaining <= 15 ? 'low' : ''}`}
            role="img"
            aria-label={`${remaining} percent of the 5-hour model window remaining`}
          >
            <i style={{ width: `${remaining}%` }} />
          </span>
          <span className="fx-val">
            {remaining}
            <small>%</small>
          </span>
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
