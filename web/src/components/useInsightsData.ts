import { useEffect, useRef, useState } from 'react';
import type {
  AllowancePayload,
  InsightsWindow,
  McpInsights,
  PoolInsightsPayload,
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
  const windowKey = mine ? chosen : null;
  const trend = useLazyRead(view === 'trend', windowKey, loadTrend);
  const throughput = useLazyRead(view === 'throughput', windowKey, loadThroughput);
  const mcp = useLazyRead(view === 'mcp', windowKey, loadMcp);
  const allowance = useLazyRead(view === 'allowance', windowKey, loadAllowance);
  const usage = useLazyRead(view === 'usage', windowKey, loadUsage);
  const pool = usePool(scope === 'pool', poolProject);

  useEffect(() => {
    if (scope === 'pool') logUsage('pool.view');
  }, [scope]);

  return { spend, reliability, remedies, reviewLabels, trend, throughput, mcp, allowance, usage, pool };
}

/** A read made only while its tab is open, once per window, and forgotten whenever the window or scope moves. A null key is the pool's scope. */
function useLazyRead<T>(open: boolean, key: InsightsWindow | null, load: Load<T>): Fetched<T> {
  const [fetched, set] = useState<Fetched<T>>(PENDING);
  const fetchedFor = useRef<InsightsWindow | null>(null);
  useEffect(() => {
    if (key === null) return;
    fetchedFor.current = null;
    set(PENDING);
  }, [key]);
  useEffect(() => {
    if (!open || key === null || fetchedFor.current === key) return;
    fetchedFor.current = key;
    let live = true;
    set(PENDING);
    load(key)
      .then((data) => live && set({ state: 'ready', data }))
      .catch(() => live && set({ state: 'failed', data: null }));
    return () => {
      live = false;
    };
  }, [open, key, load]);
  return fetched;
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
