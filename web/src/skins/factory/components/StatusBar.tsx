import type { JSX } from 'react';
import type { CockpitView } from '../../../view/viewModel.js';
import type { CockpitActions } from '../../../cockpit/actions.js';
import { useAsyncAction } from '../../../components/AsyncButton.js';
import { FleetControl } from '../../../components/FleetControl.js';
import { UsageChip } from '../../../components/UsageChip.js';
import { SettingsButton } from '../../SettingsButton.js';
import { powerReading } from '../power.js';
import type { ProductionReading } from '../production.js';
import type { FactoryModal } from './Modal.js';
import { ProductionSpark } from './Production.js';
import { Icon, type IconName } from './Sprite.js';

/** One labelled gauge. */
function Read({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="fx-read">{children}</div>;
}

/**
 * This bar's one word for "there is a panel behind this".
 *
 * Bound once because it is a claim rather than a decoration: `Scan` presses and
 * wears the same raised face, and the chevron is the entire difference between a
 * gauge that opens something and a gauge that acts. Two copies of the mark would
 * be two places for that claim to drift, and the test that counts the ways in
 * counts these.
 */
function Chev(): JSX.Element {
  return (
    <svg className="fx-chev" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
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
      <Chev />
    </button>
  );
}

/**
 * Output: the gauge whose subject is a shape rather than a count.
 *
 * Production was a panel at the head of the world rail carrying a tile you
 * clicked to open the graph — which is a panel whose whole content is a way in,
 * standing in a rail, above two panels an operator actually watches. It is read
 * the way the four desks are read: consulted, not watched. So it is a gauge, and
 * the graph opens from it. Same argument that dissolved the act rail, applied to
 * the one panel on the world rail it also fitted.
 *
 * What a count cannot carry is the reason the graph exists: whether effort is
 * turning into output is a question about *time*, and one number for a 6h window
 * is a snapshot again. So the face is the spark, and the value beside it is the
 * output rate alone — merges per hour, the series this floor is judged on.
 * Dispatches per merge is the number that puts the two together, and it is
 * one sentence rather than a glyph, so it is the hover and the graph's own note.
 *
 * Muted at nothing merged, like every other gauge at zero, and for the same
 * reason it is never removed: the graph is the only place the truncation caveat
 * and the spend rate are stated, and a quiet floor is exactly when an operator
 * goes looking for why.
 */
function ProdRead({ reading, onOpen }: { reading: ProductionReading; onOpen: () => void }): JSX.Element {
  const merges = reading.series.find((s) => s.key === 'merges')?.perHour ?? 0;
  const hours = Math.round(reading.windowMs / 3_600_000);
  const title =
    reading.churnRatio === null
      ? `Nothing has merged in ${hours}h — every dispatch so far is effort without output. Open the production graph`
      : `${merges.toFixed(1)} merges an hour over ${hours}h, ${reading.churnRatio.toFixed(1)} dispatches per merge — open the production graph`;

  return (
    <button
      type="button"
      className={`fx-read fx-act fx-prod-read ${merges > 0 ? '' : 'quiet'}`}
      onClick={onOpen}
      title={title}
      aria-label={title}
    >
      <Icon name="lamp" className="sm" />
      <span className="fx-lbl">Output</span>
      <ProductionSpark reading={reading} />
      <span className="fx-val">
        {merges.toFixed(1)}
        <small>/h</small>
      </span>
      <Chev />
    </button>
  );
}

/**
 * The pulse, and the way to force one.
 *
 * These were two things a moment apart in the bar — a Scan gauge counting down
 * and a "Run a scan" button at the far end — which is one subject drawn twice,
 * and the reading is what says whether pressing it is worth anything. So the
 * gauge *is* the button: it wears the pressable chrome of `.fx-act` (raised face,
 * hover lift, pointer) and carries no chevron, because a chevron is this bar's
 * word for "opens a panel" and this one acts.
 *
 * The radar is the one gauge with an off state — it stops turning when the
 * harness is paused or held, because a sweep that keeps going while nothing is
 * being decided is the single most misleading thing this page could draw. It
 * stays pressable in both: a held pulse is exactly when an operator wants to
 * confirm nothing moves, and a paused one is where the pause is proven.
 */
function ScanRead({ view, onScan }: { view: CockpitView; onScan: () => Promise<void> }): JSX.Element {
  const { phase, run } = useAsyncAction();
  const { state } = view;
  const stopped = view.pulseHeld || state.control.paused;
  const reading = view.pulseHeld ? 'held' : state.control.paused ? 'paused' : `${view.nextPulseIn}s`;
  const title = view.pulseHeld
    ? 'Scan held: agents from the previous run need a recovery decision — press to try one anyway'
    : state.control.paused
      ? 'Scan paused — press to run one now'
      : `Next scan in about ${view.nextPulseIn} seconds — press to run one now`;

  return (
    <button
      type="button"
      className={`fx-read fx-act fx-run ${phase === 'error' ? 'is-error' : ''}`}
      onClick={() => void run(onScan)}
      disabled={phase === 'pending'}
      title={title}
      aria-label={title}
    >
      <svg className={`fx-radar ${stopped ? 'held' : ''}`} viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.3" opacity=".5" />
        <circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" strokeWidth="1" opacity=".35" />
        <g className="fx-sweep">
          <path d="M12 12 L12 2.5 A9.5 9.5 0 0 1 20.2 7.2 Z" fill="var(--accent)" opacity=".45" />
          <path d="M12 12 L12 2.5" stroke="var(--accent)" strokeWidth="1.4" />
        </g>
        <circle cx="12" cy="12" r="1.6" fill="var(--accent)" />
      </svg>
      <span className="fx-lbl">Scan</span>
      <span className="fx-val">{phase === 'pending' ? 'now' : reading}</span>
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
 * The control-room strip: scan, power, bots, output, and the five ways in.
 *
 * Alerts, Faults and Blueprints used to be three panels standing in a permanent
 * left-hand rail, and all three are read as a *number* far more often than as
 * contents. A number is a gauge, so each is one here and its panel opens from it.
 * That is what deleted the rail. Findings is the fourth and was the last panel on
 * the floor read the same way — `Off-Blueprint` there, renamed to the harness's
 * own word for it, which is also short enough not to wrap the bar. Output is the
 * fifth and the only one whose face is a picture, because its subject is a rate:
 * see `ProdRead`.
 *
 * Every gauge is one subject stated once, which is what the bar had stopped
 * being: the fleet was a Bots reading *and* a `2/3` inside the cap control a few
 * inches to its right, and the pulse was a countdown at one end and a "Run a
 * scan" button at the other. So Bots is now the cap control itself, wearing the
 * gauge's icon and label (the shared component is unchanged — a skin may not
 * reach `api.js`, so this is the sanctioned route to a control), and Scan is the
 * button. Nothing else was moved to make room; the room came from the two
 * duplicates leaving.
 *
 * When the socket is down the bar is the ident and one reading, because
 * everything else here is a number the harness stopped confirming — see
 * `FactoryRoot`, which draws the same conclusion for the floor.
 */
export function StatusBar({
  view,
  actions,
  production,
  onOpen,
}: {
  view: CockpitView;
  actions: CockpitActions;
  /** Derived once by the root, which needs the same reading for the graph itself. */
  production: ProductionReading;
  onOpen: (modal: FactoryModal) => void;
}): JSX.Element {
  const { state } = view;
  // Power is the subscriber window when the status-line capture has seen one;
  // otherwise there is no percentage to draw and the shared cost chip says what
  // is actually known instead of a meter inventing a denominator.
  const power = powerReading(state.usage);
  const queued = state.jobs.filter((j) => j.status === 'queued').length;
  const unactioned = (state.findings ?? []).filter((f) => f.status === 'open').length;

  // Which dispatcher is wired is config: read once, never again, and it cannot
  // change while the harness is up — so it is a hover on the name rather than a
  // permanent caption competing with the gauges. `demo` stays on the face,
  // because it is the difference between a floor and a picture of one.
  const ident = (
    <div className="fx-ident" title={`${state.config.dispatcher} dispatcher`}>
      <Icon name="assembler" className="lg" />
      <h1>Factory Floor</h1>
      {view.demo && <span className="sub">demo</span>}
    </div>
  );

  // Off the air: every gauge below this line is a number the harness has stopped
  // confirming, and a stale number in gauge chrome is indistinguishable from a
  // live one. So the bar states the one thing still true.
  if (!view.connected) {
    return (
      <div className="fx-status fx-bev">
        {ident}
        <Read>
          <Icon name="alert" className="sm" />
          <span className="fx-lbl">Link</span>
          <span className="fx-val crit">offline</span>
        </Read>
      </div>
    );
  }

  return (
    <div className="fx-status fx-bev">
      {ident}

      <ScanRead view={view} onScan={() => actions.pulse()} />

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
          {/* The bank keeps its cells and loses its caption: the cells *are* the
              reading, and the percentage they spell out is a hover away in a bar
              where width is the scarce thing. */}
          {power.bank !== null && (
            <span
              className="fx-bank"
              title={`Accumulator bank: ${power.bank}% of the 7-day window left · $${power.sevenDayCostUsd.toFixed(2)} spent`}
            >
              <Accumulators cells={power.cells} />
            </span>
          )}
        </Read>
      ) : (
        <UsageChip usage={state.usage} now={view.now} />
      )}

      {/* The gauge and the control are one thing. `FleetControl` already draws
          `live/cap`, so a Bots reading beside it was the same number twice —
          and the number an operator wants is the one with the steppers on it. */}
      <div className="fx-read fx-fleet">
        <Icon name="bot" className="sm" />
        <span className="fx-lbl">Bots</span>
        <FleetControl live={view.live.length} cap={state.control.cap} paused={state.control.paused} />
      </div>

      {/* Last of the readings and first of the ways in, which is what it is: the
          floor's own output, read against time. It sits beside Bots because
          those two are the same subject a beat apart — bots out is effort now,
          Output is what the effort came to — and before the desks, which are
          all things waiting on you rather than readings of the floor. */}
      <ProdRead reading={production} onOpen={() => onOpen('production')} />

      {/* Alerts is red and the other three never are: on this floor red means one
          thing, an agent parked on a question only you can answer. A fault blocks
          nothing, a finding is something a bot noticed rather than something it is
          stuck on, and a queued blueprint is waiting on a slot, not on you. */}
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

      {/* Open findings only. A promoted, filed or dismissed one is done and a
          `filing` one is decided, so neither is waiting on you; overlaps are
          diagnostic — nothing here or in the harness actions them — so they can
          never add to a number whose whole claim is that a click resolves it.
          They still show in the desk. */}
      <ActRead
        icon="chest"
        label="Findings"
        count={unactioned}
        tone="warn"
        title={
          unactioned === 0
            ? 'Nothing reported outside a bot’s own task — open the findings desk anyway'
            : `${unactioned} finding${unactioned === 1 ? '' : 's'} nothing schedules — open the findings desk`
        }
        onOpen={() => onOpen('findings')}
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

      <SettingsButton open={view.settingsOpen} onOpen={actions.openSettings} />
    </div>
  );
}
