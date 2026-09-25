import { useRef, type JSX, type RefObject } from 'react';
import type {
  AllowancePayload,
  InsightsWindow,
  InsightsWindowView,
  McpInsights,
  PoolInsightsPayload,
  PredictionAggregate,
  UsagePayload,
  ReliabilityInsights,
  ReviewLabelInsights,
  RemedyInsights,
  ThroughputInsights,
  SpendInsights,
  SpendTrend,
} from '../types.js';
import type { CockpitActions, InsightsScope, InsightsView } from '../cockpit/actions.js';
import { Downloads, toCsv } from './Downloads.js';
import { AllowanceTab } from './AllowanceTab.js';
import { EconomicsTab } from './EconomicsTab.js';
import { spendCsv } from './spendCsv.js';
import { ReliabilityTab, reliabilityCsv } from './ReliabilityTab.js';
import { ThroughputTab, throughputCsv } from './ThroughputTab.js';
import { CausesTab } from './CausesTab.js';
import { SpendTrendTab } from './SpendTrendTab.js';
import { McpUsageTab, mcpCsv } from './McpUsageTab.js';
import { UsageTab, usageCsv } from './UsageTab.js';
import { PoolCauses, PoolEconomics, PoolThroughput, PoolUsage } from './PoolTab.js';
import { PredictionTab } from './PredictionTab.js';
import { Label } from './label.js';
import { logUsage } from '../cockpit/usage.js';
import { POOL_VIEWS } from '../cockpit/place.js';
import { PoolBar, SessionNote } from './insightsBars.js';
import { useInsightsData, type Fetched } from './useInsightsData.js';

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
  { id: 'prediction', label: 'Prediction', asks: 'Did you see the plan coming, and was the plan right?' },
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
  const { spend, reliability, remedies, reviewLabels, trend, throughput, mcp, allowance, usage, prediction, pool } =
    useInsightsData(view, scope, chosen, poolProject);

  const asks = askedBy(view, scope);
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
            reviewLabels={reviewLabels}
            trend={trend.data}
            mcp={mcp.data}
            throughput={throughput.data}
            usage={usage.data}
            page={page}
          />
        )}
      </div>

      <InsightsBar
        scope={scope}
        chosen={chosen}
        resolved={resolved}
        pool={pool.data}
        poolProject={poolProject}
        actions={actions}
      />

      {scope === 'mine' && resolved?.session && (
        <SessionNote session={resolved.session} window={resolved} now={Date.now()} />
      )}

      <InsightsTabs tabs={tabs} view={view} actions={actions} />

      <div className="insights-body">
        <Body
          view={view}
          scope={scope}
          spend={spend}
          reliability={reliability}
          remedies={remedies}
          reviewLabels={reviewLabels}
          trend={trend}
          mcp={mcp}
          throughput={throughput}
          allowance={allowance}
          prediction={prediction}
          usage={usage}
          pool={pool}
          windowLabel={resolved?.label ?? 'this window'}
        />
      </div>
    </div>
  );
}

function askedBy(view: InsightsView, scope: InsightsScope): string {
  const tab = TABS.find((t) => t.id === view);
  return (scope === 'pool' ? (tab?.poolAsks ?? tab?.asks) : tab?.asks) ?? 'Insights';
}

function InsightsTabs({
  tabs,
  view,
  actions,
}: {
  tabs: readonly (typeof TABS)[number][];
  view: InsightsView;
  actions: CockpitActions;
}): JSX.Element {
  return (
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
  );
}

function InsightsBar({
  scope,
  chosen,
  resolved,
  pool,
  poolProject,
  actions,
}: {
  scope: InsightsScope;
  chosen: InsightsWindow;
  resolved: InsightsWindowView | null;
  pool: PoolInsightsPayload | null;
  poolProject: string | null;
  actions: CockpitActions;
}): JSX.Element {
  return (
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
        <PoolBar payload={pool} project={poolProject} actions={actions} />
      ) : (
        <WindowBar chosen={chosen} resolved={resolved} actions={actions} />
      )}
    </div>
  );
}

function WindowBar({
  chosen,
  resolved,
  actions,
}: {
  chosen: InsightsWindow;
  resolved: InsightsWindowView | null;
  actions: CockpitActions;
}): JSX.Element {
  return (
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
  );
}

export function windowButtonLabel(
  window: { key: InsightsWindow; label: string },
  chosen: InsightsWindow,
  resolved: InsightsWindowView | null,
): string {
  return window.key === chosen && resolved?.key === window.key ? resolved.label : window.label;
}

function gated<T>(fetched: Fetched<T>, reading: string, failed: string, draw: (data: T) => JSX.Element): JSX.Element {
  if (fetched.state === 'loading') return <p className="empty">{reading}</p>;
  if (fetched.data === null) return <p className="empty">{failed}</p>;
  return draw(fetched.data);
}

function PoolBody({ view, pool }: { view: InsightsView; pool: Fetched<PoolInsightsPayload> }): JSX.Element {
  return gated(pool, 'Reading the pool…', 'Could not read the pool.', (data) => {
    if (view === 'causes') return <PoolCauses payload={data} />;
    if (view === 'throughput') return <PoolThroughput payload={data} />;
    if (view === 'usage') return <PoolUsage payload={data} />;
    return <PoolEconomics payload={data} />;
  });
}

function Body({
  view,
  scope,
  spend,
  reliability,
  remedies,
  reviewLabels,
  trend,
  mcp,
  throughput,
  allowance,
  prediction,
  usage,
  pool,
  windowLabel,
}: {
  view: InsightsView;
  scope: InsightsScope;
  spend: Fetched<SpendInsights>;
  reliability: Fetched<ReliabilityInsights>;
  remedies: RemedyInsights | null;
  reviewLabels: ReviewLabelInsights | null;
  trend: Fetched<SpendTrend>;
  mcp: Fetched<McpInsights>;
  throughput: Fetched<ThroughputInsights>;
  allowance: Fetched<AllowancePayload>;
  prediction: Fetched<PredictionAggregate>;
  usage: Fetched<UsagePayload>;
  pool: Fetched<PoolInsightsPayload>;
  windowLabel: string;
}): JSX.Element {
  if (scope === 'pool') return <PoolBody view={view} pool={pool} />;

  if (view === 'economics')
    return gated(spend, 'Reading the meter…', 'Could not read the spend log.', (data) => (
      <EconomicsTab insights={data} />
    ));

  if (view === 'reliability' || view === 'causes')
    return gated(reliability, 'Reading the run log…', 'Could not read the run log.', (data) => {
      if (view === 'reliability') return <ReliabilityTab insights={data} />;
      if (remedies === null) return <p className="empty">No causes were reported for this window.</p>;
      return <CausesTab remedies={remedies} reviewLabels={reviewLabels} windowLabel={windowLabel.toLowerCase()} />;
    });

  if (view === 'throughput')
    return gated(throughput, 'Counting what came out…', 'Could not read the activity record.', (data) => (
      <ThroughputTab insights={data} />
    ));

  if (view === 'allowance')
    return gated(allowance, 'Reading the allowance…', 'Could not read the allowance.', (data) => (
      <AllowanceTab payload={data} />
    ));

  if (view === 'mcp')
    return gated(mcp, 'Reading the tool channel…', 'Could not read the tool channel.', (data) => (
      <McpUsageTab insights={data} />
    ));

  /* The route is not mounted at all with both keys off, so a read that does not
     answer is the switch being off far more often than it is a fault — and this
     surface reads the presence of the data, never the flag.
     → docs/proposals/prediction-record-and-criteria-integrity.md */
  if (view === 'prediction')
    return gated(
      prediction,
      'Reading the prediction record…',
      'Could not read the prediction record. Neither the reveal gate nor goal criteria is switched on, or the read failed.',
      (data) => <PredictionTab aggregate={data} />,
    );

  if (view === 'usage')
    return gated(usage, 'Reading what was asked of you…', 'Could not read the operator ledger.', (data) => (
      <UsageTab payload={data} />
    ));

  return gated(trend, 'Reading eight windows…', 'Could not read the trend.', (data) => <SpendTrendTab trend={data} />);
}

const CSV_TITLE = 'Every table on this tab, in the order it is drawn, headed by the window it was taken over';
const JSON_TITLE = 'The exact payload this tab drew, unrounded';

function tabFiles(csv: () => string, json: () => string) {
  return [
    { format: 'csv', title: CSV_TITLE, build: csv },
    { format: 'json', title: JSON_TITLE, build: json },
  ] as const;
}

function Exports({
  view,
  spend,
  reliability,
  remedies,
  reviewLabels,
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
  reviewLabels: ReviewLabelInsights | null;
  trend: SpendTrend | null;
  mcp: McpInsights | null;
  throughput: ThroughputInsights | null;
  usage: UsagePayload | null;
  page: RefObject<HTMLDivElement | null>;
}): JSX.Element | null {
  /* The aggregate carries no author and no word of what was written, and it is not
     a window's reading either — so it gets neither the CSV of a windowed tab nor,
     by falling through, somebody else's. */
  if (view === 'prediction') return null;
  const label = TABS.find((t) => t.id === view)?.label ?? 'Insights';
  const sheet = {
    heading: `Insights · ${label}`,
    title: 'This tab as it stands, through the browser\u2019s own print — choose “Save as PDF”',
    node: () => page.current,
  };
  const download = (name: string, csv: () => string, json: () => string): JSX.Element => (
    <Downloads name={name} files={tabFiles(csv, json)} sheet={sheet} />
  );
  if (view === 'usage') {
    if (usage === null) return null;
    return download(
      'lubbdubb-usage',
      () => toCsv(usageCsv(usage)),
      () => JSON.stringify(usage, null, 2),
    );
  }
  if (view === 'throughput') {
    if (throughput === null) return null;
    return download(
      'lubbdubb-throughput',
      () => throughputCsv(throughput),
      () => JSON.stringify({ insights: throughput }, null, 2),
    );
  }
  if (view === 'mcp') {
    if (mcp === null) return null;
    return download(
      'lubbdubb-mcp',
      () => mcpCsv(mcp),
      () => JSON.stringify({ insights: mcp }, null, 2),
    );
  }
  const spendTab = view === 'economics' || view === 'trend';
  if (spendTab && spend !== null) {
    return download(
      `lubbdubb-${view}`,
      () => spendCsv(spend, view === 'trend' ? trend : null),
      () => JSON.stringify(view === 'trend' ? { trend } : { insights: spend }, null, 2),
    );
  }
  if (!spendTab && reliability !== null) {
    return download(
      `lubbdubb-${view}`,
      () => reliabilityCsv(reliability, remedies),
      () => JSON.stringify({ insights: reliability, remedies, reviewLabels }, null, 2),
    );
  }
  return null;
}
