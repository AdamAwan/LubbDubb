import { useEffect, useRef, useState, type JSX, type RefObject } from 'react';
import type {
  InsightsWindow,
  McpInsights,
  PoolInsightsPayload,
  ReliabilityInsights,
  RemedyInsights,
  SpendInsights,
  SpendTrend,
} from '../types.js';
import type { CockpitActions, InsightsView } from '../cockpit/actions.js';
import { api } from '../api.js';
import { Downloads } from './Downloads.js';
import { EconomicsTab, spendCsv } from './EconomicsTab.js';
import { ReliabilityTab, reliabilityCsv } from './ReliabilityTab.js';
import { CausesTab } from './CausesTab.js';
import { SpendTrendTab } from './SpendTrendTab.js';
import { WorkMixTab } from './WorkMixTab.js';
import { McpUsageTab, mcpCsv } from './McpUsageTab.js';
import { PoolTab } from './PoolTab.js';

/**
 * Insights — one destination, one window, five readings of it.
 *
 * It replaces three surfaces that were the same subject cut three ways: Spend
 * answered *how much*, Output answered *how fast*, Yield answered *how much of
 * it survived*. Each had independently grown toward the other two — the output
 * graph drew a cost row, the yield panel drew four dollar figures, the spend
 * trend drew a completion rate off a second server builder — which is the shape
 * of a wrong seam rather than three panels that got busy.
 *
 * Three things about it are load-bearing.
 *
 * **It is a destination, not a modal.** The two it replaced covered the queue
 * rail, and the rail is where the ask that sends an operator here comes from: a
 * `burn` row saying an agent is running at four times its median. Answering it
 * behind a sheet that hides it was the arrangement. It also means the window and
 * the open tab are [`Place`](../cockpit/place.ts) fields, so a link to "causes,
 * last 24 hours" is a link somebody can send — which no modal state in this
 * cockpit has ever been.
 *
 * **The time bar sits above the tabs, so it is page state.** Switching tabs
 * keeps the window; every reading under it obeys the same one. That is the whole
 * argument for merging them, and it is why the control is drawn here rather than
 * in whichever tab happened to want it first.
 *
 * **It fetches, so it lives here rather than under `console/`.** The console may
 * not reach `api.js` — asserted structurally in `test/console.test.ts` — and the
 * sanctioned route is the one the tickets tab and the work tree already take: a
 * component that fetches, rendered from the situation area, with the place it
 * reads passed in as props.
 *
 * → docs/spec/17-cockpit.md#insights
 */

/** The tabs, in reading order, with the sentence each one answers. */
const TABS: readonly { id: InsightsView; label: string; note: string }[] = [
  { id: 'economics', label: 'Economics', note: 'what it cost, what it landed, what leaked' },
  { id: 'reliability', label: 'Reliability', note: 'did it finish, and did it go green' },
  { id: 'causes', label: 'Causes', note: 'what keeps sending the fleet back' },
  { id: 'trend', label: 'Trend', note: 'whether what you changed is working' },
  { id: 'mix', label: 'Work mix', note: 'why this kind of work costs what it does' },
  { id: 'mcp', label: 'MCP', note: 'which tools the fleet reaches for, and which it never does' },
  { id: 'pool', label: 'Pool', note: 'what the whole pool spent, across fleets' },
];

/**
 * The windows the bar offers, with the caption each carries.
 *
 * A cockpit-side list rather than the server's, because `web/src/` may name
 * nothing but the wire contract — and it is typed as `InsightsWindow`, so
 * dropping a member server-side turns a stale entry here into a type error
 * rather than a button the page offers and the route refuses.
 */
const WINDOWS: readonly { key: InsightsWindow; label: string }[] = [
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
  /** Which project the pool tab is narrowed to. Null is every one, and then `byCheck` is absent. */
  poolProject: string | null;
  actions: CockpitActions;
}): JSX.Element {
  // The page itself, for the print sheet: PDF is the surface *printed*, not a
  // document built to resemble it, so the export needs the nodes the browser
  // already laid out. The whole page rather than the tab body, so the file
  // carries the window it was taken over — a printed table with no window on it
  // is the same silent under-report the CSV's first row exists to prevent.
  const page = useRef<HTMLDivElement>(null);
  const [spend, setSpend] = useState<Fetched<SpendInsights>>(PENDING);
  const [reliability, setReliability] = useState<Fetched<ReliabilityInsights>>(PENDING);
  const [remedies, setRemedies] = useState<RemedyInsights | null>(null);
  const [trend, setTrend] = useState<Fetched<SpendTrend>>({ state: 'loading', data: null });
  const [mcp, setMcp] = useState<Fetched<McpInsights>>(PENDING);
  // The trend is fetched on its tab's first visit *for a given window* rather
  // than with the rest, for the reason the settings modal mounts its tabs
  // lazily: it reaches eight windows of world events on top of the same agent
  // walk, and an operator who came here to read the phase table should not pay
  // for it. The window is in the key because a window change invalidates it —
  // holding "already fetched" as a boolean is how the trend ends up drawn over
  // one stretch while everything above it describes another.
  const trendFetchedFor = useRef<InsightsWindow | null>(null);
  // The MCP tab is fetched on first visit for the trend's reason and keyed the
  // same way: its naming evidence is a scan of every dispatch prompt in the
  // window, which is the one read in the harness that touches `tasks.prompt` in
  // bulk. Same ref-per-window shape, because a window change invalidates it.
  const mcpFetchedFor = useRef<InsightsWindow | null>(null);
  // The pool tab's own, and the one that does **not** hang off the window: the
  // digest's bucket is a UTC day and its retention is ninety of them, so the page's
  // five spans are not the question anybody asks of it. It is keyed on the project
  // instead, which is the one narrowing that changes what the payload contains.
  const [pool, setPool] = useState<Fetched<PoolInsightsPayload>>(PENDING);
  const poolFetchedFor = useRef<string | null | undefined>(undefined);
  // Both refetch on a window change, and both are re-read from scratch rather
  // than merged: a payload for the old window left standing beside one for the
  // new is the disagreement the single window exists to remove.
  useEffect(() => {
    let live = true;
    setSpend(PENDING);
    setReliability(PENDING);
    trendFetchedFor.current = null;
    setTrend(PENDING);
    mcpFetchedFor.current = null;
    setMcp(PENDING);
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

  // The trend's fetch hangs off the *place*, not off the click that changed it.
  // Arriving on `?view=trend` — a reload, a shared link — is a first visit too,
  // and a tab that only ever fetched from its own button rendered empty for
  // everyone who was sent a link to it. It also means one guard rather than two:
  // the effect's `live` flag covers the click path as well.
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

  // The MCP tab's own, on the same terms and for the same reason — including
  // hanging off the *place* rather than off the click, so a shared
  // `?view=mcp` link is a first visit too.
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

  // On the *place* rather than off the click, for the trend's reason: arriving on a
  // shared `?view=pool&project=acme-api` link is a first visit too.
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

  const note = TABS.find((t) => t.id === view)?.note ?? '';
  // The window as the *server* resolved it, never as this page asked: the caption
  // and the buckets under it must be one window, and a caption derived from the
  // key would be free to disagree with the timeline drawn from the payload.
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
          page={page}
        />
      </div>

      <div className="insights-bar">
        <span className="insights-lb">Window</span>
        <div className="insights-win" role="group" aria-label="Window">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              aria-pressed={w.key === chosen}
              className={w.key === chosen ? 'on' : ''}
              onClick={() => actions.openInsights({ insightsWindow: w.key })}
            >
              {w.label}
            </button>
          ))}
        </div>
        {/* The resolution, said out loud. A reader counting bars to work out what
            one of them covers is a reader who will get it wrong on the window
            whose bucket count is not its span in days. */}
        <span className="insights-meta">{resolved === null ? 'reading…' : resolved.bucketLabel}</span>
      </div>

      <div className="insights-tabs" role="tablist" aria-label="Insights">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === view}
            tabIndex={t.id === view ? 0 : -1}
            className={t.id === view ? 'on' : ''}
            onClick={() => actions.openInsights({ insightsView: t.id })}
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
          pool={pool}
          poolProject={poolProject}
          actions={actions}
          windowLabel={resolved?.label ?? 'this window'}
        />
      </div>
    </div>
  );
}

/**
 * Which tab is drawn, and what each of the three fetch states looks like.
 *
 * **A failed fetch is its own answer and never an empty one.** `$0.00` and 100%
 * are both real readings here — a fresh harness, a fleet that has not failed —
 * so neither may double as the failure mode. That was the rule on both panels
 * this page replaces and it survives the merge unchanged; what changes is that
 * one refusal now covers two tabs, since they come off one payload.
 */
function Body({
  view,
  spend,
  reliability,
  remedies,
  trend,
  mcp,
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
    // Causes has a fourth state the others do not: the reading exists, and this
    // half of it was not shipped. Drawing an empty tab there would say the fleet
    // came back for no reason.
    if (remedies === null) return <p className="empty">No causes were reported for this window.</p>;
    return <CausesTab remedies={remedies} windowLabel={windowLabel.toLowerCase()} />;
  }

  if (view === 'mcp') {
    if (mcp.state === 'loading') return <p className="empty">Reading the tool channel…</p>;
    if (mcp.data === null) return <p className="empty">Could not read the tool channel.</p>;
    return <McpUsageTab insights={mcp.data} />;
  }

  if (view === 'pool') {
    if (pool.state === 'loading') return <p className="empty">Reading the pool…</p>;
    // A failed fetch is its own answer and never an empty one: an empty pool page
    // would say every other fleet knows nothing, which is a different fact.
    if (pool.data === null) return <p className="empty">Could not read the pool.</p>;
    return <PoolTab payload={pool.data} project={poolProject} actions={actions} />;
  }

  if (trend.state === 'loading') return <p className="empty">Reading eight windows…</p>;
  if (trend.data === null) return <p className="empty">Could not read the trend.</p>;
  return <SpendTrendTab trend={trend.data} />;
}

/**
 * The page as a file, and it follows the tab.
 *
 * One control rather than one per tab, and it exports **what is on screen** —
 * so a file is now "the last 24 hours of causes" rather than "all time, always",
 * which is what the window makes newly possible. Nothing exports what it could
 * not fetch: the control is absent until there is a payload, which is each
 * tab's own "a failed fetch must not read as a clean fleet" rule applied to the
 * one artefact that outlives the page.
 */
function Exports({
  view,
  spend,
  reliability,
  remedies,
  trend,
  mcp,
  page,
}: {
  view: InsightsView;
  spend: SpendInsights | null;
  reliability: ReliabilityInsights | null;
  remedies: RemedyInsights | null;
  trend: SpendTrend | null;
  mcp: McpInsights | null;
  page: RefObject<HTMLDivElement | null>;
}): JSX.Element | null {
  const label = TABS.find((t) => t.id === view)?.label ?? 'Insights';
  const sheet = {
    heading: `Insights · ${label}`,
    title: 'This tab as it stands, through the browser\u2019s own print — choose “Save as PDF”',
    node: () => page.current,
  };
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
