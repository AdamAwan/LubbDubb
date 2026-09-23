import type { Agent, ApiErrorEvent } from '../types.js';

// → docs/spec/18-observability.md#api-errors

interface ApiErrorCount {
  key: string;
  count: number;
}

interface ApiErrorDay {
  day: string;
  errors: number;
  agentsStarted: number;
}

export interface ApiErrorInsights {
  since: string | null;
  total: number;
  agentsStarted: number;
  agentsAffected: number;
  affectedRate: number | null;
  byKind: ApiErrorCount[];
  byCode: ApiErrorCount[];
  byModel: ApiErrorCount[];
  byDay: ApiErrorDay[];
  recent: ApiErrorEvent[];
}

const RECENT = 20;

export function buildApiErrorInsights(input: {
  errors: ApiErrorEvent[];
  agents: Agent[];
  since: string | null;
}): ApiErrorInsights {
  const started = input.agents.filter((a) => input.since === null || a.startedAt >= input.since);
  const affected = new Set(input.errors.map((e) => e.agentId));
  const days = new Map<string, ApiErrorDay>();
  const dayOf = (day: string) => {
    let row = days.get(day);
    if (!row) days.set(day, (row = { day, errors: 0, agentsStarted: 0 }));
    return row;
  };
  for (const a of started) dayOf(a.startedAt.slice(0, 10)).agentsStarted += 1;
  for (const e of input.errors) dayOf(e.createdAt.slice(0, 10)).errors += 1;
  return {
    since: input.since,
    total: input.errors.length,
    agentsStarted: started.length,
    agentsAffected: affected.size,
    affectedRate: started.length === 0 ? null : affected.size / started.length,
    byKind: countBy(input.errors, (e) => e.kind),
    byCode: countBy(input.errors, (e) => e.code ?? '(none)'),
    byModel: countBy(input.errors, (e) => e.model ?? '(default)'),
    byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    recent: input.errors.slice(-RECENT).reverse(),
  };
}

function countBy(errors: ApiErrorEvent[], key: (e: ApiErrorEvent) => string): ApiErrorCount[] {
  const counts = new Map<string, number>();
  for (const e of errors) counts.set(key(e), (counts.get(key(e)) ?? 0) + 1);
  return [...counts].map(([k, count]) => ({ key: k, count })).sort((a, b) => b.count - a.count);
}
