import type { JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import { FleetControl } from '../components/FleetControl.js';
import { productionReading } from '../view/production.js';

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
 * chevron: a reading that opens something and a reading that does something are
 * different promises, and the chevron is the only thing that says which.
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
 * with the mockup's plain text-and-number face — the console has no icon set of
 * its own to draw from. Spend,
 * Yield, Output, Findings and Faults open a panel or a full-surface view;
 * Settings does too. None reaches `api.js` — every one of these is a method on
 * `CockpitActions`, and the fleet cap is the shared `FleetControl`, which is
 * already on that seam.
 *
 * Output reads `productionReading` from `../view/production.js` — the same
 * derivation the production graph itself is built on — rather than a
 * differently-shaped count of the same events: a gauge and the panel it opens
 * must agree from the first paint, and only sharing the one function keeps
 * that true by construction. It sits in `view/` — a pure, React-free derivation,
 * same as `viewModel.ts` and `goalPage.ts` — so that a gauge and the panel behind
 * it can share it without either reaching into the other's presentation.
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

  const yieldPct =
    state.runOutcomes.completionRate === null ? null : Math.round(state.runOutcomes.completionRate * 100);
  const spendUsd = state.usage.windows.fiveHourCostUsd;
  const faultCount = state.errors.length;
  // The queue, not the history: a launched blueprint that has been dispatched is
  // an agent in the Fleet, and counting it here would have the reading climb as
  // work starts rather than as it waits.
  const queued = state.jobs.filter((job) => job.status === 'queued').length;
  // Same derivation the production graph itself is built on (`actions.openPanel('output')`
  // opens it) — a gauge and the panel it opens must start out agreeing, so this is
  // the windowed rate, not a different-shaped count of the same events.
  const production = productionReading({
    decisions: state.decisions,
    worldEvents: state.worldEvents,
    fiveHourCostUsd: state.usage.windows.fiveHourCostUsd,
    now: view.now,
  });
  const mergesPerHour = production.series.find((s) => s.key === 'merges')?.perHour ?? 0;

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
          value={`${mergesPerHour.toFixed(1)}/h`}
          quiet={mergesPerHour === 0}
          onOpen={() => actions.openPanel('output')}
          title={`${mergesPerHour.toFixed(1)} merges an hour over the last ${Math.round(production.windowMs / 3_600_000)}h — open the output panel`}
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
        <Read
          label="Launch"
          value={`${queued}`}
          quiet={queued === 0}
          onOpen={() => actions.openPanel('launch')}
          title="Blueprints waiting for a free slot — open the launch desk"
        />
        <Read label="Settings" value={null} quiet={false} onOpen={() => actions.openSettings(true)} title="Settings" />
      </div>
    </div>
  );
}
