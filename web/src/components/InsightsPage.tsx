import { useEffect, useRef, useState, type JSX, type RefObject } from 'react';
import type {
  AllowancePayload,
  InsightsWindow,
  InsightsWindowView,
  McpInsights,
  PoolInsightsPayload,
  UsagePayload,
  ReliabilityInsights,
  RemedyInsights,
  ThroughputInsights,
  ReviewCalibration,
  SpendInsights,
  SpendTrend,
} from '../types.js';
import type { CockpitActions, InsightsScope, InsightsView } from '../cockpit/actions.js';
import { api } from '../api.js';
import { Downloads, toCsv } from './Downloads.js';
import { AllowanceTab } from './AllowanceTab.js';
import { EconomicsTab, spendCsv } from './EconomicsTab.js';
import { ReliabilityTab, reliabilityCsv } from './ReliabilityTab.js';
import { ThroughputTab, throughputCsv } from './ThroughputTab.js';
import { CausesTab } from './CausesTab.js';
import { SpendTrendTab } from './SpendTrendTab.js';
import { McpUsageTab, mcpCsv } from './McpUsageTab.js';
import { UsageTab, usageCsv } from './UsageTab.js';
import { PoolCauses, PoolEconomics, PoolThroughput, PoolUsage } from './PoolTab.js';
import { ReviewCalibrationTab } from './ReviewCalibrationTab.js';
import { Label } from './label.js';
import { logUsage } from '../cockpit/usage.js';
import { POOL_VIEWS } from '../cockpit/place.js';

// → docs/spec/17-cockpit.md

/* One tab, one question — and the question is the page's heading, so a reader
   arrives at an answer rather than at a category. Every table under it is framed
   as part of that answer; a table that answers a different question is on a
   different tab. → docs/spec/17-cockpit.md#one-tab-one-question */
const TABS: readonly { id: InsightsView; label: string; asks: string; poolAsks?: string }[] = [
  {
    id: 'economics',
    label: 'Economics',
    asks: 'Is the fleet worth what it costs?',
    poolAsks: 'Where does the pool\u2019s money go?',
  },
  { id: 'allowance', label: 'Allowance', asks: 'What has the account got left?' },
  { id: 'reliability', label: 'Reliability', asks: 'Did it finish, and did it go green?' },
  {
    id: 'throughput',
    label: 'Throughput',
    asks: 'How much came out?',
    poolAsks: 'How much came out, across every fleet?',
  },
  {
    id: 'causes',
    label: 'Causes',
    asks: 'What keeps sending the fleet back?',
    poolAsks: 'What keeps sending fleets back?',
  },
  { id: 'trend', label: 'Trend', asks: 'Is what I changed working?' },
  { id: 'mcp', label: 'MCP', asks: 'Can the fleet reach its tools?' },
  { id: 'review', label: 'Review', asks: 'What do the packs say about the agents that write them?' },
  {
    id: 'usage',
    label: 'Usage',
    asks: 'What did the harness ask of you, and what did you never open?',
    poolAsks: 'What do people do with their fleets?',
  },
];

const SCOPES: readonly { key: InsightsScope; label: string; note: string }[] = [
  { key: 'mine', label: 'Just me', note: 'this fleet' },
  { key: 'pool', label: 'The pool', note: 'every fleet publishing a digest' },
];

const WINDOWS: readonly { key: InsightsWindow; label: string }[] = [
  { key: 'session', label: '5h session' },
  { key: '6h', label: '6h' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: 'all', label: 'All' },
];

type Fetched<T> = { state: 'loading' | 'ready' | 'failed'; data: T | null };

const PENDING = { state: 'loading', data: null } as const;

export function InsightsPage({
  view,
  scope,
  window: chosen,
  poolProject,
  actions,
}: {
  view: InsightsView;
  scope: InsightsScope;
  window: InsightsWindow;
  poolProject: string | null;
  actions: CockpitActions;
}): JSX.Element {
  const page = useRef<HTMLDivElement>(null);
  const [spend, setSpend] = useState<Fetched<SpendInsights>>(PENDING);
  const [reliability, setReliability] = useState<Fetched<ReliabilityInsights>>(PENDING);
  const [remedies, setRemedies] = useState<RemedyInsights | null>(null);
  const [trend, setTrend] = useState<Fetched<SpendTrend>>({ state: 'loading', data: null });
  const [throughput, setThroughput] = useState<Fetched<ThroughputInsights>>(PENDING);
  const throughputFetchedFor = useRef<InsightsWindow | null>(null);
  const [mcp, setMcp] = useState<Fetched<McpInsights>>(PENDING);
  const [allowance, setAllowance] = useState<Fetched<AllowancePayload>>(PENDING);
  const trendFetchedFor = useRef<InsightsWindow | null>(null);
  const mcpFetchedFor = useRef<InsightsWindow | null>(null);
  const allowanceFetchedFor = useRef<InsightsWindow | null>(null);
  const [calibration, setCalibration] = useState<Fetched<ReviewCalibration>>(PENDING);
  const calibrationFetchedFor = useRef<InsightsWindow | null>(null);
  const [usage, setUsage] = useState<Fetched<UsagePayload>>(PENDING);
  const usageFetchedFor = useRef<InsightsWindow | null>(null);
  const [pool, setPool] = useState<Fetched<PoolInsightsPayload>>(PENDING);
  const poolFetchedFor = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (scope !== 'mine') return;
    let live = true;
    setSpend(PENDING);
    setReliability(PENDING);
    trendFetchedFor.current = null;
    setTrend(PENDING);
    throughputFetchedFor.current = null;
    setThroughput(PENDING);
    mcpFetchedFor.current = null;
    setMcp(PENDING);
    allowanceFetchedFor.current = null;
    setAllowance(PENDING);
    calibrationFetchedFor.current = null;
    setCalibration(PENDING);
    usageFetchedFor.current = null;
    setUsage(PENDING);
    api
      .getSpend(chosen)
      .then((res) => live && setSpend({ state: 'ready', data: res.insights }))
      .catch(() => live && setSpend({ state: 'failed', data: null }));
    api
      .getReliability(chosen)
      .then((res) => {
        if (!live) return;
        setReliability({ state: 'ready', data: res.insights });
        setRemedies(res.remedies);
      })
      .catch(() => live && setReliability({ state: 'failed', data: null }));
    return () => {
      live = false;
    };
  }, [chosen, scope]);

  useEffect(() => {
    if (scope !== 'mine' || view !== 'trend' || trendFetchedFor.current === chosen) return;
    trendFetchedFor.current = chosen;
    let live = true;
    setTrend(PENDING);
    api
      .getSpendTrend(chosen)
      .then((res) => live && setTrend({ state: 'ready', data: res.trend }))
      .catch(() => live && setTrend({ state: 'failed', data: null }));
    return () => {
      live = false;
    };
  }, [view, chosen, scope]);

  useEffect(() => {
    if (scope !== 'mine' || view !== 'throughput' || throughputFetchedFor.current === chosen) return;
    throughputFetchedFor.current = chosen;
    let live = true;
    setThroughput(PENDING);
    api
      .getThroughput(chosen)
      .then((res) => live && setThroughput({ state: 'ready', data: res.insights }))
      .catch(() => live && setThroughput({ state: 'failed', data: null }));
    return () => {
      live = false;
    };
  }, [view, chosen, scope]);

  useEffect(() => {
    if (scope !== 'mine' || view !== 'mcp' || mcpFetchedFor.current === chosen) return;
    mcpFetchedFor.current = chosen;
    let live = true;
    setMcp(PENDING);
    api
      .getMcpUsage(chosen)
      .then((res) => live && setMcp({ state: 'ready', data: res.insights }))
      .catch(() => live && setMcp({ state: 'failed', data: null }));
    return () => {
      live = false;
    };
  }, [view, chosen, scope]);

  useEffect(() => {
    if (scope !== 'mine' || view !== 'allowance' || allowanceFetchedFor.current === chosen) return;
    allowanceFetchedFor.current = chosen;
    let live = true;
    setAllowance(PENDING);
    api
      .getAllowance(chosen)
      .then((res) => live && setAllowance({ state: 'ready', data: res }))
      .catch(() => live && setAllowance({ state: 'failed', data: null }));
    return () => {
      live = false;
    };
  }, [view, chosen, scope]);

  useEffect(() => {
    if (scope !== 'mine' || view !== 'review' || calibrationFetchedFor.current === chosen) return;
    calibrationFetchedFor.current = chosen;
    let live = true;
    setCalibration(PENDING);
    api
      .getReviewCalibration(chosen)
      .then((res) => live && setCalibration({ state: 'ready', data: res.calibration }))
      .catch(() => live && setCalibration({ state: 'failed', data: null }));
    return () => {
      live = false;
    };
  }, [view, chosen, scope]);

  useEffect(() => {
    if (scope !== 'mine' || view !== 'usage' || usageFetchedFor.current === chosen) return;
    usageFetchedFor.current = chosen;
    let live = true;
    setUsage(PENDING);
    api
      .getUsage(chosen)
      .then((res) => live && setUsage({ state: 'ready', data: res }))
      .catch(() => live && setUsage({ state: 'failed', data: null }));
    return () => {
      live = false;
    };
  }, [view, chosen, scope]);

  useEffect(() => {
    if (scope !== 'pool' || poolFetchedFor.current === poolProject) return;
    poolFetchedFor.current = poolProject;
    let live = true;
    setPool(PENDING);
    api
      .getPoolInsights(poolProject)
      .then((res) => live && setPool({ state: 'ready', data: res }))
      .catch(() => live && setPool({ state: 'failed', data: null }));
    return () => {
      live = false;
    };
  }, [scope, poolProject]);

  useEffect(() => {
    if (scope === 'pool') logUsage('pool.view');
  }, [scope]);

  const tab = TABS.find((t) => t.id === view);
  const asks = (scope === 'pool' ? (tab?.poolAsks ?? tab?.asks) : tab?.asks) ?? 'Insights';
  const resolved = spend.data?.window ?? reliability.data?.window ?? null;
  const tabs = scope === 'pool' ? TABS.filter((t) => POOL_VIEWS.includes(t.id)) : TABS;

  return (
    <div className="insights" ref={page}>
      <div className="insights-head">
        {/* The question, as the heading. A reader arrives with one, and a page
            titled for its category makes them work out which page holds it. */}
        <h2>{asks}</h2>
        <span className="insights-gap" />
        {scope === 'mine' && (
          <Exports
            view={view}
            spend={spend.data}
            reliability={reliability.data}
            remedies={remedies}
            trend={trend.data}
            mcp={mcp.data}
            throughput={throughput.data}
            usage={usage.data}
            page={page}
          />
        )}
      </div>

      <div className="insights-bar">
        <Label dense>Whose</Label>
        <div className="insights-win" role="group" aria-label="Whose numbers">
          {SCOPES.map((s) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={s.key === scope}
              className={s.key === scope ? 'on' : ''}
              title={s.note}
              onClick={() => {
                logUsage('insights.filter');
                actions.openInsights({ insightsScope: s.key });
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
        {scope === 'pool' ? (
          <PoolBar payload={pool.data} project={poolProject} actions={actions} />
        ) : (
          <>
            <Label dense>Window</Label>
            <div className="insights-win" role="group" aria-label="Window">
              {WINDOWS.map((w) => (
                <button
                  key={w.key}
                  type="button"
                  aria-pressed={w.key === chosen}
                  className={w.key === chosen ? 'on' : ''}
                  onClick={() => {
                    logUsage('insights.filter');
                    actions.openInsights({ insightsWindow: w.key });
                  }}
                >
                  {windowButtonLabel(w, chosen, resolved)}
                </button>
              ))}
            </div>
            {/* The resolution, said out loud. A reader counting bars to work out what
                one of them covers is a reader who will get it wrong on the window
                whose bucket count is not its span in days. */}
            <span className="insights-meta">{resolved === null ? 'reading…' : resolved.bucketLabel}</span>
          </>
        )}
      </div>

      {scope === 'mine' && resolved?.session && (
        <SessionNote session={resolved.session} window={resolved} now={Date.now()} />
      )}

      <div className="insights-tabs" role="tablist" aria-label="Insights">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === view}
            tabIndex={t.id === view ? 0 : -1}
            className={t.id === view ? 'on' : ''}
            onClick={() => {
              logUsage('insights.filter');
              actions.openInsights({ insightsView: t.id });
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="insights-body">
        <Body
          view={view}
          scope={scope}
          spend={spend}
          reliability={reliability}
          remedies={remedies}
          trend={trend}
          mcp={mcp}
          throughput={throughput}
          allowance={allowance}
          calibration={calibration}
          usage={usage}
          pool={pool}
          windowLabel={resolved?.label ?? 'this window'}
        />
      </div>
    </div>
  );
}

function PoolBar({
  payload,
  project,
  actions,
}: {
  payload: PoolInsightsPayload | null;
  project: string | null;
  actions: CockpitActions;
}): JSX.Element {
  const rollup = payload?.rollup ?? null;
  return (
    <>
      <Label dense>Project</Label>
      <div className="insights-win" role="group" aria-label="Project">
        <button
          type="button"
          aria-pressed={project === null}
          className={project === null ? 'on' : ''}
          onClick={() => {
            logUsage('pool.filter');
            actions.openInsights({ poolProject: null });
          }}
        >
          All
        </button>
        {(payload?.projects ?? []).map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={name === project}
            className={name === project ? 'on' : ''}
            onClick={() => {
              logUsage('pool.filter');
              actions.openInsights({ poolProject: name });
            }}
          >
            {name}
          </button>
        ))}
      </div>
      {/* The pool ignores the window bar: the digest's bucket is a UTC day and its
          retention is ninety of them. → docs/spec/28-cross-fleet-pool.md */}
      <span className="insights-meta">
        {rollup === null
          ? 'reading…'
          : `${rollup.fleets.length} fleet${rollup.fleets.length === 1 ? '' : 's'} · ${
              rollup.days.length === 0 ? 'nothing published yet' : `${rollup.days.length} UTC days`
            }`}
      </span>
    </>
  );
}

export function windowButtonLabel(
  window: { key: InsightsWindow; label: string },
  chosen: InsightsWindow,
  resolved: InsightsWindowView | null,
): string {
  return window.key === chosen && resolved?.key === window.key ? resolved.label : window.label;
}

function SessionNote({
  session,
  window: view,
  now,
}: {
  session: NonNullable<InsightsWindowView['session']>;
  window: InsightsWindowView;
  now: number;
}): JSX.Element {
  if (session.kind === 'unreported')
    return (
      <p className="insights-anchor is-loose">
        <b>The last five hours</b>, not the account&apos;s window — no agent here has ever reported one.{' '}
        <span className="dim">{stamp(view.since, now)} to now.</span>
      </p>
    );
  if (session.kind === 'stale')
    return (
      <p className="insights-anchor is-loose">
        <b>The last five hours</b>, not the account&apos;s window — the newest reading names a reset at{' '}
        {stamp(session.resetsAt, now)}, which this harness cannot anchor to.{' '}
        <span className="dim">{stamp(view.since, now)} to now.</span>
      </p>
    );
  return (
    <p className="insights-anchor">
      <b>The account&apos;s five-hour window</b>, opened {stamp(session.startsAt, now)}, resets{' '}
      {stamp(session.resetsAt, now)}.
      {session.usedPercentage === null ? null : (
        <>
          {' '}
          <b>{Math.round(session.usedPercentage)}% spent</b> as of {stamp(session.capturedAt, now)}.
        </>
      )}{' '}
      <span className="dim">The split below is cost, which is not what the limit meters.</span>
    </p>
  );
}

function stamp(iso: string | null, now: number): string {
  if (iso === null) return 'the start of the window';
  const at = new Date(iso);
  const ms = at.getTime() - now;
  if (Number.isNaN(ms)) return iso;
  const mins = Math.round(Math.abs(ms) / 60_000);
  const rel = mins < 1 ? 'just now' : mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  const clock = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (mins < 1) return `${clock} (just now)`;
  return ms < 0 ? `${clock} (${rel} ago)` : `${clock} (in ${rel})`;
}

function Body({
  view,
  scope,
  spend,
  reliability,
  remedies,
  trend,
  mcp,
  throughput,
  allowance,
  calibration,
  usage,
  pool,
  windowLabel,
}: {
  view: InsightsView;
  scope: InsightsScope;
  spend: Fetched<SpendInsights>;
  reliability: Fetched<ReliabilityInsights>;
  remedies: RemedyInsights | null;
  trend: Fetched<SpendTrend>;
  mcp: Fetched<McpInsights>;
  throughput: Fetched<ThroughputInsights>;
  allowance: Fetched<AllowancePayload>;
  calibration: Fetched<ReviewCalibration>;
  usage: Fetched<UsagePayload>;
  pool: Fetched<PoolInsightsPayload>;
  windowLabel: string;
}): JSX.Element {
  if (scope === 'pool') {
    if (pool.state === 'loading') return <p className="empty">Reading the pool…</p>;
    if (pool.data === null) return <p className="empty">Could not read the pool.</p>;
    if (view === 'causes') return <PoolCauses payload={pool.data} />;
    if (view === 'throughput') return <PoolThroughput payload={pool.data} />;
    if (view === 'usage') return <PoolUsage payload={pool.data} />;
    return <PoolEconomics payload={pool.data} />;
  }

  if (view === 'economics') {
    if (spend.state === 'loading') return <p className="empty">Reading the meter…</p>;
    if (spend.data === null) return <p className="empty">Could not read the spend log.</p>;
    return <EconomicsTab insights={spend.data} />;
  }

  if (view === 'reliability' || view === 'causes') {
    if (reliability.state === 'loading') return <p className="empty">Reading the run log…</p>;
    if (reliability.data === null) return <p className="empty">Could not read the run log.</p>;
    if (view === 'reliability') return <ReliabilityTab insights={reliability.data} />;
    if (remedies === null) return <p className="empty">No causes were reported for this window.</p>;
    return <CausesTab remedies={remedies} windowLabel={windowLabel.toLowerCase()} />;
  }

  if (view === 'throughput') {
    if (throughput.state === 'loading') return <p className="empty">Counting what came out…</p>;
    if (throughput.data === null) return <p className="empty">Could not read the activity record.</p>;
    return <ThroughputTab insights={throughput.data} />;
  }

  if (view === 'allowance') {
    if (allowance.state === 'loading') return <p className="empty">Reading the allowance…</p>;
    if (allowance.data === null) return <p className="empty">Could not read the allowance.</p>;
    return <AllowanceTab payload={allowance.data} />;
  }

  if (view === 'mcp') {
    if (mcp.state === 'loading') return <p className="empty">Reading the tool channel…</p>;
    if (mcp.data === null) return <p className="empty">Could not read the tool channel.</p>;
    return <McpUsageTab insights={mcp.data} />;
  }

  if (view === 'review') {
    if (calibration.state === 'loading') return <p className="empty">Reading the packs…</p>;
    if (calibration.data === null) return <p className="empty">Could not read the review packs.</p>;
    return <ReviewCalibrationTab calibration={calibration.data} />;
  }

  if (view === 'usage') {
    if (usage.state === 'loading') return <p className="empty">Reading what was asked of you…</p>;
    if (usage.data === null) return <p className="empty">Could not read the operator ledger.</p>;
    return <UsageTab payload={usage.data} />;
  }

  if (trend.state === 'loading') return <p className="empty">Reading eight windows…</p>;
  if (trend.data === null) return <p className="empty">Could not read the trend.</p>;
  return <SpendTrendTab trend={trend.data} />;
}

function Exports({
  view,
  spend,
  reliability,
  remedies,
  trend,
  mcp,
  throughput,
  usage,
  page,
}: {
  view: InsightsView;
  spend: SpendInsights | null;
  reliability: ReliabilityInsights | null;
  remedies: RemedyInsights | null;
  trend: SpendTrend | null;
  mcp: McpInsights | null;
  throughput: ThroughputInsights | null;
  usage: UsagePayload | null;
  page: RefObject<HTMLDivElement | null>;
}): JSX.Element | null {
  const label = TABS.find((t) => t.id === view)?.label ?? 'Insights';
  const sheet = {
    heading: `Insights · ${label}`,
    title: 'This tab as it stands, through the browser\u2019s own print — choose “Save as PDF”',
    node: () => page.current,
  };
  if (view === 'usage') {
    if (usage === null) return null;
    return (
      <Downloads
        name="lubbdubb-usage"
        files={[
          {
            format: 'csv',
            title: 'Every table on this tab, in the order it is drawn, headed by the window it was taken over',
            build: () => toCsv(usageCsv(usage)),
          },
          {
            format: 'json',
            title: 'The exact payload this tab drew, unrounded',
            build: () => JSON.stringify(usage, null, 2),
          },
        ]}
        sheet={sheet}
      />
    );
  }
  if (view === 'throughput') {
    if (throughput === null) return null;
    return (
      <Downloads
        name="lubbdubb-throughput"
        files={[
          {
            format: 'csv',
            title: 'Every table on this tab, in the order it is drawn, headed by the window it was taken over',
            build: () => throughputCsv(throughput),
          },
          {
            format: 'json',
            title: 'The exact payload this tab drew, unrounded',
            build: () => JSON.stringify({ insights: throughput }, null, 2),
          },
        ]}
        sheet={sheet}
      />
    );
  }
  if (view === 'mcp') {
    if (mcp === null) return null;
    return (
      <Downloads
        name="lubbdubb-mcp"
        files={[
          {
            format: 'csv',
            title: 'Every table on this tab, in the order it is drawn, headed by the window it was taken over',
            build: () => mcpCsv(mcp),
          },
          {
            format: 'json',
            title: 'The exact payload this tab drew, unrounded',
            build: () => JSON.stringify({ insights: mcp }, null, 2),
          },
        ]}
        sheet={sheet}
      />
    );
  }
  const spendTab = view === 'economics' || view === 'trend';
  if (spendTab && spend !== null) {
    return (
      <Downloads
        name={`lubbdubb-${view}`}
        files={[
          {
            format: 'csv',
            title: 'Every table on this tab, in the order it is drawn, headed by the window it was taken over',
            build: () => spendCsv(spend, view === 'trend' ? trend : null),
          },
          {
            format: 'json',
            title: 'The exact payload this tab drew, unrounded',
            build: () => JSON.stringify(view === 'trend' ? { trend } : { insights: spend }, null, 2),
          },
        ]}
        sheet={sheet}
      />
    );
  }
  if (!spendTab && reliability !== null) {
    return (
      <Downloads
        name={`lubbdubb-${view}`}
        files={[
          {
            format: 'csv',
            title: 'Every table on this tab, in the order it is drawn, headed by the window it was taken over',
            build: () => reliabilityCsv(reliability, remedies),
          },
          {
            format: 'json',
            title: 'The exact payload this tab drew, unrounded',
            build: () => JSON.stringify({ insights: reliability, remedies }, null, 2),
          },
        ]}
        sheet={sheet}
      />
    );
  }
  return null;
}
