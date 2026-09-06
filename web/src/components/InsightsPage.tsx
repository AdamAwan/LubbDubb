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
  ReviewCalibration,
  SpendInsights,
  SpendTrend,
} from '../types.js';
import type { CockpitActions, InsightsView } from '../cockpit/actions.js';
import { api } from '../api.js';
import { Downloads, toCsv } from './Downloads.js';
import { AllowanceTab } from './AllowanceTab.js';
import { EconomicsTab, spendCsv } from './EconomicsTab.js';
import { ReliabilityTab, reliabilityCsv } from './ReliabilityTab.js';
import { CausesTab } from './CausesTab.js';
import { SpendTrendTab } from './SpendTrendTab.js';
import { WorkMixTab } from './WorkMixTab.js';
import { McpUsageTab, mcpCsv } from './McpUsageTab.js';
import { UsageTab, usageCsv } from './UsageTab.js';
import { PoolTab } from './PoolTab.js';
import { ReviewCalibrationTab } from './ReviewCalibrationTab.js';
import { Label } from './label.js';
import { logUsage } from '../cockpit/usage.js';

// → docs/spec/17-cockpit.md

const TABS: readonly { id: InsightsView; label: string; note: string }[] = [
  { id: 'economics', label: 'Economics', note: 'what it cost, what it landed, what leaked' },
  { id: 'allowance', label: 'Allowance', note: 'what the account has left, and what spent it' },
  { id: 'reliability', label: 'Reliability', note: 'did it finish, and did it go green' },
  { id: 'causes', label: 'Causes', note: 'what keeps sending the fleet back' },
  { id: 'trend', label: 'Trend', note: 'whether what you changed is working' },
  { id: 'mix', label: 'Work mix', note: 'why this kind of work costs what it does' },
  { id: 'mcp', label: 'MCP', note: 'which tools the fleet reaches for, and which it never does' },
  { id: 'review', label: 'Review', note: 'what the review packs say about the agents that write them' },
  {
    id: 'usage',
    label: 'Usage',
    note: 'what the harness asked of you, what it cost to wait, and what you never opened',
  },
  { id: 'pool', label: 'Pool', note: 'what the whole pool spent, across fleets' },
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
  window: chosen,
  poolProject,
  actions,
}: {
  view: InsightsView;
  window: InsightsWindow;
  poolProject: string | null;
  actions: CockpitActions;
}): JSX.Element {
  const page = useRef<HTMLDivElement>(null);
  const [spend, setSpend] = useState<Fetched<SpendInsights>>(PENDING);
  const [reliability, setReliability] = useState<Fetched<ReliabilityInsights>>(PENDING);
  const [remedies, setRemedies] = useState<RemedyInsights | null>(null);
  const [trend, setTrend] = useState<Fetched<SpendTrend>>({ state: 'loading', data: null });
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
    let live = true;
    setSpend(PENDING);
    setReliability(PENDING);
    trendFetchedFor.current = null;
    setTrend(PENDING);
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
  }, [chosen]);

  useEffect(() => {
    if (view !== 'trend' || trendFetchedFor.current === chosen) return;
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
  }, [view, chosen]);

  useEffect(() => {
    if (view !== 'mcp' || mcpFetchedFor.current === chosen) return;
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
  }, [view, chosen]);

  useEffect(() => {
    if (view !== 'allowance' || allowanceFetchedFor.current === chosen) return;
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
  }, [view, chosen]);

  useEffect(() => {
    if (view !== 'review' || calibrationFetchedFor.current === chosen) return;
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
  }, [view, chosen]);

  useEffect(() => {
    if (view !== 'usage' || usageFetchedFor.current === chosen) return;
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
  }, [view, chosen]);

  useEffect(() => {
    if (view !== 'pool' || poolFetchedFor.current === poolProject) return;
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
  }, [view, poolProject]);

  useEffect(() => {
    if (view === 'pool') logUsage('pool.view');
  }, [view]);

  const note = TABS.find((t) => t.id === view)?.note ?? '';
  const resolved = spend.data?.window ?? reliability.data?.window ?? null;

  return (
    <div className="insights" ref={page}>
      <div className="insights-head">
        <h2>Insights</h2>
        <span className="insights-note">{note}</span>
        <span className="insights-gap" />
        <Exports
          view={view}
          spend={spend.data}
          reliability={reliability.data}
          remedies={remedies}
          trend={trend.data}
          mcp={mcp.data}
          usage={usage.data}
          page={page}
        />
      </div>

      <div className="insights-bar">
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
      </div>

      {resolved?.session && <SessionNote session={resolved.session} window={resolved} now={Date.now()} />}

      <div className="insights-tabs" role="tablist" aria-label="Insights">
        {TABS.map((t) => (
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
          spend={spend}
          reliability={reliability}
          remedies={remedies}
          trend={trend}
          mcp={mcp}
          allowance={allowance}
          calibration={calibration}
          usage={usage}
          pool={pool}
          poolProject={poolProject}
          actions={actions}
          windowLabel={resolved?.label ?? 'this window'}
        />
      </div>
    </div>
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
        <b>The last five hours</b>, not the account&apos;s five-hour window — no agent on this deployment has ever
        reported one. API-key auth carries no windows at all, and a stream agent has to take a turn before the first
        reading arrives. The split below is over {stamp(view.since, now)} to now.
      </p>
    );
  if (session.kind === 'stale')
    return (
      <p className="insights-anchor is-loose">
        <b>The last five hours</b>, not the account&apos;s five-hour window. The newest reading — taken{' '}
        {stamp(session.capturedAt, now)} — names a reset at {stamp(session.resetsAt, now)}, which this harness cannot
        anchor to: the window has turned over since an agent last took a turn, and nothing observed where the new one
        began. The split below is over {stamp(view.since, now)} to now.
      </p>
    );
  return (
    <p className="insights-anchor">
      <b>The account&apos;s five-hour window</b>, opened {stamp(session.startsAt, now)} and resetting{' '}
      {stamp(session.resetsAt, now)}.
      {session.usedPercentage === null ? null : (
        <>
          {' '}
          The account reported it <b>{Math.round(session.usedPercentage)}% spent</b> as of{' '}
          {stamp(session.capturedAt, now)}.
        </>
      )}{' '}
      What the limit meters is not published and this harness cannot see it — the split below is <b>cost</b>, which is
      the only dated per-run measure it holds. The two move together; they are not the same quantity, and the shares
      below are the honest half of the pair.
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
  spend,
  reliability,
  remedies,
  trend,
  mcp,
  allowance,
  calibration,
  usage,
  pool,
  poolProject,
  actions,
  windowLabel,
}: {
  view: InsightsView;
  spend: Fetched<SpendInsights>;
  reliability: Fetched<ReliabilityInsights>;
  remedies: RemedyInsights | null;
  trend: Fetched<SpendTrend>;
  mcp: Fetched<McpInsights>;
  allowance: Fetched<AllowancePayload>;
  calibration: Fetched<ReviewCalibration>;
  usage: Fetched<UsagePayload>;
  pool: Fetched<PoolInsightsPayload>;
  poolProject: string | null;
  actions: CockpitActions;
  windowLabel: string;
}): JSX.Element {
  if (view === 'economics' || view === 'mix') {
    if (spend.state === 'loading') return <p className="empty">Reading the meter…</p>;
    if (spend.data === null) return <p className="empty">Could not read the spend log.</p>;
    return view === 'economics' ? <EconomicsTab insights={spend.data} /> : <WorkMixTab insights={spend.data} />;
  }

  if (view === 'reliability' || view === 'causes') {
    if (reliability.state === 'loading') return <p className="empty">Reading the run log…</p>;
    if (reliability.data === null) return <p className="empty">Could not read the run log.</p>;
    if (view === 'reliability') return <ReliabilityTab insights={reliability.data} />;
    if (remedies === null) return <p className="empty">No causes were reported for this window.</p>;
    return <CausesTab remedies={remedies} windowLabel={windowLabel.toLowerCase()} />;
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

  if (view === 'pool') {
    if (pool.state === 'loading') return <p className="empty">Reading the pool…</p>;
    if (pool.data === null) return <p className="empty">Could not read the pool.</p>;
    return <PoolTab payload={pool.data} project={poolProject} actions={actions} />;
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
  usage,
  page,
}: {
  view: InsightsView;
  spend: SpendInsights | null;
  reliability: ReliabilityInsights | null;
  remedies: RemedyInsights | null;
  trend: SpendTrend | null;
  mcp: McpInsights | null;
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
  const spendTab = view === 'economics' || view === 'mix' || view === 'trend';
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
