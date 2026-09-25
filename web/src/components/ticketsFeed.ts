import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { api } from '../api.js';
import type {
  TicketFeatureFacet,
  TicketOrder,
  TicketRow,
  TicketStateFacet,
  TicketTrackingFilter,
  TicketWatchFilter,
} from '../types.js';

export interface TicketFeed {
  rows: TicketRow[];
  refUrls: Record<string, string>;
  total: number;
  kept: number;
  live: number;
  states: TicketStateFacet[];
  features: TicketFeatureFacet[];
  orphanCount: number;
  totalCostUsd: number;
  anchorAt: string;
  backfilling: boolean;
  loading: boolean;
  done: boolean;
  foot: MutableRefObject<HTMLDivElement | null>;
}

export function useTicketFeed({
  watch,
  tracking,
  state,
  feature,
  order,
}: {
  watch: TicketWatchFilter;
  tracking: TicketTrackingFilter;
  state: string;
  feature: number | 'none' | null;
  order: TicketOrder;
}): TicketFeed {
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [refUrls, setRefUrls] = useState<Record<string, string>>({});
  const [total, setTotal] = useState(0);
  const [kept, setKept] = useState(0);
  const [live, setLive] = useState(0);
  const [states, setStates] = useState<TicketStateFacet[]>([]);
  const [features, setFeatures] = useState<TicketFeatureFacet[]>([]);
  const [orphanCount, setOrphanCount] = useState(0);
  const [totalCostUsd, setTotalCostUsd] = useState(0);
  const [anchorAt, setAnchorAt] = useState('');
  const [backfilling, setBackfilling] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);

  const read = useCallback(
    async (from: string | null) => {
      setLoading(true);
      const page = await api.getTickets({
        watch,
        tracking,
        state,
        feature: feature === null ? null : String(feature),
        order,
        cursor: from,
      });
      setRows((prev) => (from === null ? page.rows : [...prev, ...page.rows]));
      setRefUrls((prev) => (from === null ? page.refUrls : { ...prev, ...page.refUrls }));
      setTotal(page.total);
      setKept(page.kept);
      setLive(page.live);
      setStates(page.states);
      setFeatures(page.features);
      setOrphanCount(page.orphanCount);
      setTotalCostUsd(page.totalCostUsd);
      setAnchorAt(page.anchorAt);
      setBackfilling(page.backfilling);
      setCursor(page.nextCursor);
      setDone(page.nextCursor === null);
      setLoading(false);
    },
    [watch, tracking, state, feature, order],
  );

  useEffect(() => {
    setRows([]);
    setCursor(null);
    setDone(false);
    void read(null);
  }, [read]);

  const foot = useRef<HTMLDivElement | null>(null);
  useNextPage(foot, cursor, done, loading, read);

  return {
    rows,
    refUrls,
    total,
    kept,
    live,
    states,
    features,
    orphanCount,
    totalCostUsd,
    anchorAt,
    backfilling,
    loading,
    done,
    foot,
  };
}

function useNextPage(
  foot: MutableRefObject<HTMLDivElement | null>,
  cursor: string | null,
  done: boolean,
  loading: boolean,
  read: (from: string | null) => Promise<void>,
): void {
  useEffect(() => {
    const sentinel = foot.current;
    if (sentinel === null || done || loading) return;
    const root = sentinel.closest('.cn-sit');
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void read(cursor);
      },
      { root, rootMargin: '400px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [foot, cursor, done, loading, read]);
}
