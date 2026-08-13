import type { JSX, ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions, ConsolePanel, ConsoleTab } from '../cockpit/actions.js';
import { TopBar } from './TopBar.js';
import { QueueRail } from './QueueRail.js';
import { GoalPage } from './GoalPage.js';
import { Overview } from './Overview.js';
import { Backlog, backlogGroups } from './Backlog.js';
import { Panel } from './Panel.js';
import { RecoveryPanel } from '../components/RecoveryPanel.js';
import { WorkTreePanel } from '../components/WorkTreePanel.js';
import { FindingsPanel } from '../components/FindingsPanel.js';
import { LaunchPanel } from '../components/LaunchPanel.js';
import { SchedulePanel } from '../components/SchedulePanel.js';
import { InjectPanel } from '../components/InjectPanel.js';
import { ConfirmButton } from '../components/ConfirmButton.js';
import { relTime } from '../components/util.js';
import { axisScale, productionReading, type ProductionReading, type SeriesKey } from '../view/production.js';

/**
 * The console's placement, and what each full-surface panel contains: what a
 * panel *is* and where it sits are separate edits, so every one below is bound to
 * a const and then placed.
 *
 * A dropped socket empties the whole surface. Every reading here is one the
 * harness confirms, and a stale one is drawn in exactly the chrome of a live
 * one — so rather than ask an operator to remember to check a chip, nothing is
 * drawn at all.
 */
export function ConsoleRoot({ view, actions }: { view: CockpitView; actions: CockpitActions }) {
  if (!view.connected) {
    return (
      <div className="cn">
        <TopBar view={view} actions={actions} />
        <div className="cn-offline">
          <h1>Off the air</h1>
          <p>
            The link to the harness dropped. The harness is unaffected; the console returns by itself when it
            reconnects.
          </p>
        </div>
      </div>
    );
  }

  // Outside and above `.cn-body`, not inside it: while a crashed run stands, the
  // heartbeat is held and every goal the rail or situation area would draw is
  // stale for the same reason — this banner is the one thing still true.
  const recovery =
    view.crashed.length > 0 ? (
      <div className="cn-recovery">
        <RecoveryPanel
          crashed={view.crashed}
          now={view.now}
          refUrls={view.state.refUrls}
          onDecide={(id, verdict) => actions.decideRecovery(id, verdict)}
        />
      </div>
    ) : null;

  // A selected goal outranks the nav. Selecting one is what a queue row does, and
  // it does not move the nav — so with a tab winning, clicking an ask would land
  // on a triage list, or on the record, instead of on the ask.
  const situation =
    view.goalPage !== null ? (
      <GoalPage page={view.goalPage} view={view} actions={actions} />
    ) : (
      tabBody(view.tab, view, actions)
    );

  const panel =
    view.consolePanel === null ? null : (
      <Panel title={PANEL_TITLE[view.consolePanel]} onClose={() => actions.openPanel(null)}>
        <div className="cn-pbody">{panelBody(view.consolePanel, view, actions)}</div>
      </Panel>
    );

  return (
    <div className="cn">
      <TopBar view={view} actions={actions} />
      {recovery}
      <div className="cn-body">
        <aside className="cn-rail">
          <QueueRail view={view} actions={actions} />
        </aside>
        <main className="cn-sit">
          <Nav view={view} actions={actions} />
          {situation}
        </main>
      </div>
      {panel}
    </div>
  );
}

/** What the situation area draws for a tab, when no goal outranks it. */
function tabBody(tab: ConsoleTab, view: CockpitView, actions: CockpitActions): JSX.Element {
  switch (tab) {
    case 'overview':
      return <Overview view={view} actions={actions} />;
    case 'backlog':
      return <Backlog view={view} actions={actions} />;
    case 'work':
      // The shared panel, embedded exactly as the launch desk is: it reaches its
      // own routes, which `console/` may not, but rendering one that does is not
      // reaching — the import ban is on `api.js`, and it still holds here.
      return (
        <section className="work-panel">
          <WorkTreePanel now={view.now} canFileTickets={view.state.config.canFileTickets} />
        </section>
      );
  }
}

/** The nav's destinations, in reading order — the order the tabs are drawn in. */
const TABS: readonly ConsoleTab[] = ['overview', 'backlog', 'work'];

const TAB_LABEL: Record<ConsoleTab, string> = {
  overview: 'Overview',
  backlog: 'Backlog',
  work: 'Work',
};

/**
 * Where you are, and the other places you can be.
 *
 * A click clears *both* pieces of state, because a nav click means "go here" and
 * either half left standing would land somewhere else. The backlog carries its
 * triage count — the one number that says whether it is worth opening; the other
 * two carry none, since neither has a number that decides whether to look. And a
 * goal draws its crumb, which is the only thing on the page naming what the
 * situation area is currently about.
 */
function Nav({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const goal = view.goalPage;
  const unwatched = backlogGroups(view).unwatched.length;
  const go = (tab: ConsoleTab) => () => {
    actions.selectGoal(null);
    actions.openTab(tab);
  };

  return (
    <nav className="cn-nav">
      {TABS.map((tab) => (
        <button key={tab} type="button" className={goal === null && view.tab === tab ? 'cn-on' : ''} onClick={go(tab)}>
          {TAB_LABEL[tab]}
          {/* The space is the gap: `.cn-n` carries no margin of its own. */}
          {tab === 'backlog' && (
            <>
              {' '}
              <i className="cn-n">{unwatched} unwatched</i>
            </>
          )}
        </button>
      ))}
      {goal !== null && (
        <>
          <span className="cn-navsep">/</span>
          <span className="cn-on">
            #{goal.issue.number} {goal.issue.title}
          </span>
        </>
      )}
    </nav>
  );
}

/** What each panel calls itself — the same word as the reading that opens it. */
const PANEL_TITLE: Record<NonNullable<ConsolePanel>, string> = {
  findings: 'Findings',
  faults: 'Faults',
  output: 'Output',
  launch: 'Launch',
};

function panelBody(panel: NonNullable<ConsolePanel>, view: CockpitView, actions: CockpitActions): ReactNode {
  const { state } = view;
  switch (panel) {
    case 'findings':
      return (
        <FindingsPanel
          findings={state.findings}
          now={view.now}
          refUrls={state.refUrls}
          canFileTickets={state.config.canFileTickets}
          onPromote={(id) => actions.promoteFinding(id)}
          onFile={(id) => actions.fileFinding(id)}
          onDismiss={(id) => actions.dismissFinding(id)}
        />
      );
    case 'faults':
      return <FaultLog view={view} actions={actions} />;
    case 'output':
      return (
        <OutputGraph
          reading={productionReading({
            decisions: state.decisions,
            worldEvents: state.worldEvents,
            fiveHourCostUsd: state.usage.windows.fiveHourCostUsd,
            now: view.now,
          })}
        />
      );
    case 'launch':
      return (
        <>
          <LaunchPanel
            jobs={state.jobs}
            attachments={state.attachments}
            attachmentUrls={state.attachmentUrls}
            onChanged={() => void actions.refresh()}
          />
          <SchedulePanel schedules={state.schedules} onChanged={() => void actions.refresh()} />
          {/* Injection fakes a world change, which only the static demo has any
              use for: a real run against a fake provider is still a real run, and
              a panel that lies to the harness there is a way to lie to yourself
              about what it is reacting to. `view.demo` is the whole gate — there
              is no server route behind it for a second predicate to disagree
              with. */}
          {view.demo && <InjectPanel onInjected={() => void actions.refresh()} world={state.world} />}
        </>
      );
  }
}

/** How many faults the log draws. This is the surface you went looking for, so it is not cropped to a column. */
const FAULT_ROWS = 40;

/**
 * The fault log. Nothing in the harness reads these back, so it blocks nothing
 * and is never red — amber is the whole of its claim on your attention.
 *
 * The clear is two-step and sits **above** the rows, and it is drawn at zero rows
 * as well. A clear costs nothing the harness decides on, but it costs the only
 * copy and for every cockpit rather than this one, so one misclick between
 * "leave" and "delete the only copy" is too few — and the only route to it must
 * not depend on there being rows, or the control moves under the operator exactly
 * as the log fills.
 */
function FaultLog({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const { errors } = view.state;
  return (
    <>
      <div className="cn-acts">
        <ConfirmButton
          className="ghost"
          label="Clear"
          confirmLabel="Delete every recorded fault?"
          title={`Delete all ${errors.length} recorded faults — this cannot be undone, for any cockpit`}
          onConfirm={() => actions.clearErrors()}
        />
      </div>
      <div className="cn-rows">
        {errors.length === 0 && <p className="cn-empty">No fault has been recorded.</p>}
        {errors.slice(0, FAULT_ROWS).map((err) => (
          <div className="cn-row" key={err.id}>
            <i className="cn-lamp cn-wait" />
            <span className="cn-grow">
              <b className="cn-name">{err.source}</b>
              <span className="cn-sub cn-wrap">{err.message}</span>
              {err.detail !== null && <span className="cn-sub cn-wrap">{err.detail}</span>}
            </span>
            <span className="cn-num">{relTime(err.createdAt, view.now)}</span>
          </div>
        ))}
        {errors.length > FAULT_ROWS && <p className="cn-empty">…{errors.length - FAULT_ROWS} older</p>}
      </div>
    </>
  );
}

const SERIES_COLOR: Record<SeriesKey, string> = {
  dispatches: 'var(--cn-accent)',
  merges: 'var(--cn-green)',
  escalations: 'var(--cn-red)',
};

const PLOT = { left: 38, right: 608, top: 12, bottom: 176 };

function pointsPath(points: readonly number[], peak: number): string {
  const span = points.length > 1 ? (PLOT.right - PLOT.left) / (points.length - 1) : 0;
  const height = PLOT.bottom - PLOT.top;
  return points
    .map(
      (v, i) =>
        `${i === 0 ? 'M' : 'L'}${(PLOT.left + i * span).toFixed(1)} ${(PLOT.bottom - (v / peak) * height).toFixed(1)}`,
    )
    .join(' ');
}

/**
 * The production graph: the one panel that reads against *time*, which is the
 * only way to answer whether the harness is producing rather than merely busy.
 *
 * The churn ratio under it is the point of the whole panel — dispatches are
 * effort and merges are output, and a rising first line over a flat second one is
 * a fleet spinning. The truncation note is not decoration either: a rate that
 * silently under-reports is worse than no rate.
 */
function OutputGraph({ reading }: { reading: ProductionReading }): JSX.Element {
  const hours = Math.round(reading.windowMs / 3_600_000);
  const { max: peak, lines: gridLines } = axisScale(reading.peak);
  const label = reading.series.map((s) => `${s.label} ${s.perHour.toFixed(1)} per hour`).join('; ');

  return (
    <div className="cn-prod">
      <svg viewBox="0 0 620 200" role="img" aria-label={label}>
        <g stroke="var(--cn-line)" strokeWidth="1">
          {gridLines.map((f) => {
            const y = PLOT.top + f * (PLOT.bottom - PLOT.top);
            return <path key={f} d={`M${PLOT.left} ${y}H${PLOT.right}`} />;
          })}
        </g>
        <g textAnchor="end">
          {gridLines.map((f) => {
            const y = PLOT.top + f * (PLOT.bottom - PLOT.top);
            return (
              <text key={f} x={PLOT.left - 8} y={y + 3}>
                {Math.round(peak * (1 - f))}
              </text>
            );
          })}
        </g>
        <g textAnchor="middle">
          <text x={PLOT.left} y="194">
            {hours}h ago
          </text>
          <text x={PLOT.right} y="194">
            now
          </text>
        </g>
        {reading.series.map((s) => (
          <path
            key={s.key}
            d={pointsPath(s.points, peak)}
            fill="none"
            stroke={SERIES_COLOR[s.key]}
            strokeWidth={s.key === 'escalations' ? 1.8 : 2}
            strokeDasharray={s.key === 'escalations' ? '4 3' : undefined}
            strokeLinejoin="round"
          />
        ))}
      </svg>

      <div className="cn-rows">
        {reading.series.map((s) => (
          <div className="cn-row" key={s.key}>
            <i className="cn-sw" style={{ background: SERIES_COLOR[s.key] }} />
            <span className="cn-grow">
              <b className="cn-name">{s.label}</b>
              {/* The first half being empty is not a 0% change — there is nothing
                  to have changed from, and an arrow there would be invented. */}
              <span className="cn-sub">
                {s.deltaPct === null
                  ? 'nothing in the first half to compare against'
                  : `${s.deltaPct > 0 ? '+' : ''}${s.deltaPct}% against the first half of the window`}
              </span>
            </span>
            <span className="cn-num">{s.perHour.toFixed(1)}/h</span>
          </div>
        ))}
        {reading.costPerHour !== null && (
          <div className="cn-row">
            <i className="cn-sw" style={{ background: 'var(--cn-violet)' }} />
            <span className="cn-grow">
              <b className="cn-name">Spend</b>
              {/* No delta: the 5h window is one total, not a series, so there are
                  no halves to compare and an arrow here would be invented. */}
              <span className="cn-sub">averaged over the rolling 5h window</span>
            </span>
            <span className="cn-num">${reading.costPerHour.toFixed(2)}/h</span>
          </div>
        )}
      </div>
      <p className="cn-empty">
        {reading.churnRatio === null
          ? `Nothing has merged in ${hours}h — every dispatch so far is effort without output.`
          : `${reading.churnRatio.toFixed(1)} dispatches per merge — the number that separates producing from churning.`}
      </p>
      {reading.truncated && (
        <p className="cn-empty">
          The decision log does not reach back {hours}h, so the dispatch and escalation rates are a floor.
        </p>
      )}
    </div>
  );
}
