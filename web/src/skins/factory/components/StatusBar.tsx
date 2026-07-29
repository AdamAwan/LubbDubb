import type { JSX } from 'react';
import type { CockpitView } from '../../../view/viewModel.js';
import type { CockpitActions } from '../../../cockpit/actions.js';
import { AsyncButton } from '../../../components/AsyncButton.js';
import { FleetControl } from '../../../components/FleetControl.js';
import { UsageChip } from '../../../components/UsageChip.js';
import { relTime } from '../../../components/util.js';
import { SkinPicker } from '../../SkinPicker.js';
import { powerReading } from '../power.js';
import type { FactoryModal } from './Modal.js';
import { Icon, type IconName } from './Sprite.js';

/** One labelled gauge. */
function Read({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="fx-read">{children}</div>;
}

/**
 * A gauge that opens a panel over the floor.
 *
 * Distinct from `Read` on purpose. The plain gauges are *inert* — Scan, Power and
 * Bots are readings, and pressing one does nothing — so an `onClick` bolted to
 * one of those is invisible: it looks exactly like the three neighbours that
 * don't respond, which is precisely how the first attempt was reported. This is a
 * real button with its own chrome, and the chevron is the part that says so while
 * standing still.
 *
 * A count of zero mutes the gauge but never removes it. Faults is the only way to
 * the fault log, which carries the two-step `clear` — a control that must not
 * become unreachable because the log happens to be empty — and a gauge that
 * vanished would reflow the bar every time the number moved off zero.
 */
function ActRead({
  icon,
  label,
  count,
  tone,
  title,
  onOpen,
}: {
  icon: IconName;
  label: string;
  count: number;
  /** `crit` is red and reserved: an agent is parked on a question only you can answer. */
  tone?: 'crit' | 'warn';
  title: string;
  onOpen: () => void;
}): JSX.Element {
  const lit = count > 0;
  return (
    <button
      type="button"
      className={`fx-read fx-act ${lit ? '' : 'quiet'}`}
      onClick={onOpen}
      title={title}
      aria-label={title}
    >
      <Icon name={icon} className="sm" />
      <span className="fx-lbl">{label}</span>
      <span className={`fx-val ${lit && tone ? tone : ''}`}>{count}</span>
      <svg className="fx-chev" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
    </button>
  );
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
 * The control-room strip: scan, power, bots, the three ways in, and the controls.
 *
 * The radar is the pulse, and it is the one gauge with an off state — it stops
 * turning when the harness is paused or held, because a sweep that keeps going
 * while nothing is being decided is the single most misleading thing this page
 * could draw.
 *
 * Alerts, Faults and Blueprints used to be three panels standing in a permanent
 * left-hand rail, and all three are read as a *number* far more often than as
 * contents. A number is a gauge, so each is one here and its panel opens from it.
 * That is what deleted the rail. See
 * `docs/spec/2026-07-29-factory-two-rail-layout-design.md`.
 */
export function StatusBar({
  view,
  actions,
  onOpen,
}: {
  view: CockpitView;
  actions: CockpitActions;
  onOpen: (modal: FactoryModal) => void;
}): JSX.Element {
  const { state } = view;
  const stopped = view.pulseHeld || state.control.paused;
  // Power is the subscriber window when the status-line capture has seen one;
  // otherwise there is no percentage to draw and the shared cost chip says what
  // is actually known instead of a meter inventing a denominator.
  const power = powerReading(state.usage);
  const queued = state.jobs.filter((j) => j.status === 'queued').length;

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

      {/* Alerts is red and the other two never are: on this floor red means one
          thing, an agent parked on a question only you can answer. A fault blocks
          nothing and a queued blueprint is waiting on a slot, not on you. */}
      <ActRead
        icon="alert"
        label="Alerts"
        count={view.openEscalations.length}
        tone="crit"
        title={
          view.openEscalations.length === 0
            ? 'Nothing is waiting on you — open the stamp desk anyway'
            : `${view.openEscalations.length} bot${view.openEscalations.length === 1 ? '' : 's'} parked on a question only you can answer — open the stamp desk`
        }
        onOpen={() => onOpen('alerts')}
      />

      <ActRead
        icon="gear"
        label="Faults"
        count={state.errors.length}
        tone="warn"
        title={
          state.errors.length === 0
            ? 'No faults recorded — open the fault log anyway'
            : `${state.errors.length} recorded fault${state.errors.length === 1 ? '' : 's'} — open the fault log`
        }
        onOpen={() => onOpen('faults')}
      />

      <ActRead
        icon="blueprint"
        label="Queued"
        count={queued}
        title={
          queued === 0
            ? 'Stamp a new blueprint'
            : `${queued} blueprint${queued === 1 ? '' : 's'} waiting for a free pad — open the blueprint desk`
        }
        onOpen={() => onOpen('blueprints')}
      />

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
