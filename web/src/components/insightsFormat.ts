import type { SpendInsights } from '../types.js';

// → docs/spec/17-cockpit.md

export function share(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

export function fmtShare(part: number, whole: number): string {
  const pct = share(part, whole);
  if (pct === 0) return '0%';
  return pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}

export function fmtRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return '—';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = mins / 60;
  if (hours < 24) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
  const days = hours / 24;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}d`;
}

export function fmtSince(iso: string, now: number = Date.now()): string {
  return `${fmtDuration(Math.max(0, now - Date.parse(iso)))} ago`;
}

export const PLOT = { left: 34, right: 596, top: 10, bottom: 152 };

export function localPhaseCostUsd(insights: SpendInsights): number {
  return insights.phases.find((p) => p.phase === 'local')?.costUsd ?? 0;
}
