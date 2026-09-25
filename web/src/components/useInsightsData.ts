import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type {
  AllowancePayload,
  InsightsWindow,
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
import type { InsightsScope, InsightsView } from '../cockpit/actions.js';
import { api } from '../api.js';
import { logUsage } from '../cockpit/usage.js';

export type Fetched<T> = { state: 'loading' | 'ready' | 'failed'; data: T | null };

const PENDING = { state: 'loading', data: null } as const;

type Load<T> = (window: InsightsWindow) => Promise<T>;

const loadTrend: Load<SpendTrend> = (w) => api.getSpendTrend(w).then((res) => res.trend);
const loadThroughput: Load<ThroughputInsights> = (w) => api.getThroughput(w).then((res) => res.insights);
const loadMcp: Load<McpInsights> = (w) => api.getMcpUsage(w).then((res) => res.insights);
const loadAllowance: Load<AllowancePayload> = (w) => api.getAllowance(w);
const loadUsage: Load<UsagePayload> = (w) => api.getUsage(w);

export function useInsightsData(
  view: InsightsView,
  scope: InsightsScope,
  chosen: InsightsWindow,
  poolProject: string | null,
) {
  const [spend, setSpend] = useState<Fetched<SpendInsights>>(PENDING);
  const [reliability, setReliability] = useState<Fetched<ReliabilityInsights>>(PENDING);
  const [remedies, setRemedies] = useState<RemedyInsights | null>(null);
  const [reviewLabels, setReviewLabels] = useState<ReviewLabelInsights | null>(null);
  useEffect(() => {
    if (scope !== 'mine') return;
    let live = true;
    setSpend(PENDING);
    setReliability(PENDING);
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
        setReviewLabels(res.reviewLabels);
      })
      .catch(() => live && setReliability({ state: 'failed', data: null }));
    return () => {
      live = false;
    };
  }, [chosen, scope]);

  const mine = scope === 'mine';
  const trend = useLazyRead(mine, mine && view === 'trend', chosen, loadTrend);
  const throughput = useLazyRead(mine, mine && view === 'throughput', chosen, loadThroughput);
  const mcp = useLazyRead(mine, mine && view === 'mcp', chosen, loadMcp);
  const allowance = useLazyRead(mine, mine && view === 'allowance', chosen, loadAllowance);
  const usage = useLazyRead(mine, mine && view === 'usage', chosen, loadUsage);
  const prediction = usePrediction(mine && view === 'prediction');
  const pool = usePool(scope === 'pool', poolProject);

  useEffect(() => {
    if (scope === 'pool') logUsage('pool.view');
  }, [scope]);

  return { spend, reliability, remedies, reviewLabels, trend, throughput, mcp, allowance, usage, prediction, pool };
}

/** A read made only while its tab is open, once per window, and forgotten whenever the window or scope moves. */
function useLazyRead<T>(mine: boolean, open: boolean, chosen: InsightsWindow, load: Load<T>): Fetched<T> {
  const [fetched, set] = useState<Fetched<T>>(PENDING);
  const fetchedFor = useRef<InsightsWindow | null>(null);
  useEffect(() => {
    if (!mine) return;
    fetchedFor.current = null;
    set(PENDING);
  }, [chosen, mine]);
  useLazyFetch(open, chosen, load, set, fetchedFor);
  return fetched;
}

function useLazyFetch<T>(
  open: boolean,
  chosen: InsightsWindow,
  load: Load<T>,
  set: Dispatch<SetStateAction<Fetched<T>>>,
  fetchedFor: MutableRefObject<InsightsWindow | null>,
): void {
  useEffect(() => {
    if (!open || fetchedFor.current === chosen) return;
    fetchedFor.current = chosen;
    let live = true;
    set(PENDING);
    load(chosen)
      .then((data) => live && set({ state: 'ready', data }))
      .catch(() => live && set({ state: 'failed', data: null }));
    return () => {
      live = false;
    };
  }, [open, chosen, load, set, fetchedFor]);
}

/* No window in the dependency list, and no reset when the bar moves: the
   aggregate is a fold over the whole record. → docs/spec/17-cockpit.md
   It is read again on every arrival at the tab rather than once per mount,
   because marking a slot on a goal page moves these figures — and a once-only
   ref would have to be cleared somewhere, which under the double-invoked effects
   of a development build leaves the panel reading "Reading the prediction
   record…" for good: the first pass is cancelled and the second bails on the
   ref the first one set. */
function usePrediction(open: boolean): Fetched<PredictionAggregate> {
  const [prediction, setPrediction] = useState<Fetched<PredictionAggregate>>(PENDING);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setPrediction(PENDING);
    api
      .getPredictionAggregate()
      .then((res) => live && setPrediction({ state: 'ready', data: res.aggregate }))
      .catch(() => live && setPrediction({ state: 'failed', data: null }));
    return () => {
      live = false;
    };
  }, [open]);
  return prediction;
}

function usePool(open: boolean, poolProject: string | null): Fetched<PoolInsightsPayload> {
  const [pool, setPool] = useState<Fetched<PoolInsightsPayload>>(PENDING);
  const poolFetchedFor = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!open || poolFetchedFor.current === poolProject) return;
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
  }, [open, poolProject]);
  return pool;
}
