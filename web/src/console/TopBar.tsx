import type { JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import { FleetControl } from '../components/FleetControl.js';

/**
 * One reading: a label and a value, optionally a button that opens something.
 *
 * A zero count mutes the reading — `.cn-quiet` dims the value — and never
 * removes it. The gauge staying put is what lets an operator glance at the same
 * spot every time rather than hunting for a control that reflows when the count
 * it reads happens to hit zero.
 */
function Read({
  label,
  value,
  quiet,
  onOpen,
  title,
}: {
  label: string;
  value: string | null;
  quiet: boolean;
  onOpen?: () => void;
  title: string;
}): JSX.Element {
  const cls = `cn-read ${onOpen ? 'cn-act' : ''} ${quiet ? 'cn-quiet' : ''}`;
  if (!onOpen) {
    return (
      <div className={cls} title={title}>
        <span>{label}</span>
        {value !== null && <b>{value}</b>}
      </div>
    );
  }
  return (
    <button type="button" className={cls} onClick={onOpen} title={title} aria-label={title}>
      <span>{label}</span>
      {value !== null && <b>{value}</b>}
      <i className="cn-chev">›</i>
    </button>
  );
}

/**
 * The pulse countdown, and the way to force one. Wears the same raised chrome
 * as the other readings but acts rather than opening a panel, so it carries no
 * chevron — the same distinction `factory/components/StatusBar.tsx` draws
 * between its gauges and its `ScanRead`.
 */
function Scan({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const stopped = view.pulseHeld || view.state.control.paused;
  const reading = view.pulseHeld ? 'held' : view.state.control.paused ? 'paused' : `${view.nextPulseIn}s`;
  const title = view.pulseHeld
    ? 'Scan held: agents from the previous run need a recovery decision — press to try one anyway'
    : view.state.control.paused
      ? 'Scan paused — press to run one now'
      : `Next scan in about ${view.nextPulseIn} seconds — press to run one now`;
  return (
    <button
      type="button"
      className={`cn-read cn-act cn-scan ${stopped ? 'cn-quiet' : ''}`}
      onClick={() => void actions.pulse()}
      title={title}
      aria-label={title}
    >
      <span>Scan</span>
      <b>{reading}</b>
    </button>
  );
}

/**
 * The control-room strip: ident, the pulse, the fleet cap, and six readings.
 *
 * Each reading is one subject stated once, mirroring `StatusBar`'s rule but
 * with the mockup's plain text-and-number face rather than the Factory's icon
 * sprites — the console has no sprite sheet of its own to draw from. Spend,
 * Yield, Output, Findings and Faults open a panel or a full-surface view;
 * Settings does too. None reaches `api.js` — every one of these is a method on
 * `CockpitActions`, and the fleet cap is the shared `FleetControl`, which is
 * already on that seam.
 */
export function TopBar({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const { state } = view;

  if (!view.connected) {
    return (
      <div className="cn-bar">
        <div className="cn-ident">
          <i className="cn-dot" style={{ background: 'var(--cn-red)' }} />
          LubbDubb
        </div>
        <div className="cn-read">
          <span>Link</span>
          <b>offline</b>
        </div>
      </div>
    );
  }

  const merges = state.worldEvents.filter((e) => e.kind === 'pr_merged').length;
  const yieldPct =
    state.runOutcomes.completionRate === null ? null : Math.round(state.runOutcomes.completionRate * 100);
  const spendUsd = state.usage.windows.fiveHourCostUsd;
  const faultCount = state.errors.length;

  return (
    <div className="cn-bar">
      <div className="cn-ident">
        <i className="cn-dot" />
        LubbDubb
        {view.demo && <span style={{ color: 'var(--cn-fg-faint)', fontWeight: 400 }}>· demo</span>}
      </div>
      <div className="cn-sep" />

      <Scan view={view} actions={actions} />

      <div className="cn-read cn-cap">
        <span>Fleet</span>
        <FleetControl live={view.live.length} cap={state.control.cap} paused={state.control.paused} />
      </div>

      <div className="cn-reads">
        <Read
          label="Spend"
          value={`$${spendUsd.toFixed(2)}`}
          quiet={spendUsd === 0}
          onOpen={() => actions.openSpend(true)}
          title="What the fleet has spent — open the breakdown"
        />
        <Read
          label="Yield"
          value={yieldPct === null ? null : `${yieldPct}%`}
          quiet={yieldPct === null || yieldPct === 100}
          onOpen={() => actions.openReliability(true)}
          title="How much of the settled work finished — open the breakdown"
        />
        <Read
          label="Output"
          value={`${merges}`}
          quiet={merges === 0}
          onOpen={() => actions.openPanel('output')}
          title="Pull requests merged — open the output panel"
        />
        <Read
          label="Findings"
          value={`${view.openFindingCount}`}
          quiet={view.openFindingCount === 0}
          onOpen={() => actions.openPanel('findings')}
          title="Findings nobody has ruled on — open the findings panel"
        />
        <Read
          label="Faults"
          value={`${faultCount}`}
          quiet={faultCount === 0}
          onOpen={() => actions.openPanel('faults')}
          title="Recorded faults — open the fault log"
        />
        <Read label="Settings" value={null} quiet={false} onOpen={() => actions.openSettings(true)} title="Settings" />
      </div>
    </div>
  );
}
