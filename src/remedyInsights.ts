import type { Remedy, RemedyCause, RemedyGuard, RemedyKind, UsageEvent } from './types.js';
import { roundUsd } from './issueSpend.js';
import { CAUSES_BY_KIND, CAUSE_COPY, GUARD_COPY, GUARD_ORDER } from './remedies/remedies.js';

// → docs/spec/18-observability.md

const RECENT_ROWS = 12;

export interface RemedyCauseTotal {
  cause: RemedyCause;
  label: string;
  blurb: string;
  accounts: number;
  costUsd: number;
  undocumented: number;
  topCheck: { name: string; accounts: number } | null;
}

export interface RemedyKindHealth {
  kind: RemedyKind;
  accounts: number;
  costUsd: number;
  byCause: RemedyCauseTotal[];
}

interface RemedyGuardTotal {
  guard: RemedyGuard;
  label: string;
  blurb: string;
  accounts: number;
  costUsd: number;
}

export interface RemedyRow {
  id: string;
  kind: RemedyKind;
  ref: string;
  prNumber: number;
  cause: RemedyCause;
  causeLabel: string;
  guard: RemedyGuard;
  guardLabel: string;
  summary: string;
  checks: string[];
  at: string;
}

export interface RemedyInsights {
  accounts: number;
  costUsd: number;
  unaccounted: number;
  byKind: RemedyKindHealth[];
  byGuard: RemedyGuardTotal[];
  recent: RemedyRow[];
}

interface RemedyInput {
  remedies: readonly Remedy[];
  returnDispatches: readonly string[];
  usageEvents: readonly UsageEvent[];
}

export function buildRemedyInsights(input: RemedyInput): RemedyInsights {
  const { remedies } = input;
  const perAccount = costPerAccount(remedies, input.usageEvents);

  const byKind: RemedyKindHealth[] = (['ci', 'review'] as const).map((kind) => {
    const mine = remedies.filter((r) => r.kind === kind);
    return {
      kind,
      accounts: mine.length,
      costUsd: roundUsd(mine.reduce((sum, r) => sum + (perAccount.get(r.id) ?? 0), 0)),
      byCause: CAUSES_BY_KIND[kind].map((cause) => {
        const rows = mine.filter((r) => r.cause === cause);
        return {
          cause,
          label: CAUSE_COPY[cause].label,
          blurb: CAUSE_COPY[cause].blurb,
          accounts: rows.length,
          costUsd: roundUsd(rows.reduce((sum, r) => sum + (perAccount.get(r.id) ?? 0), 0)),
          undocumented: rows.filter((r) => r.guard === 'undocumented').length,
          topCheck: topCheck(rows),
        };
      }),
    };
  });

  const byGuard: RemedyGuardTotal[] = GUARD_ORDER.map((guard) => {
    const rows = remedies.filter((r) => r.guard === guard);
    return {
      guard,
      label: GUARD_COPY[guard].label,
      blurb: GUARD_COPY[guard].blurb,
      accounts: rows.length,
      costUsd: roundUsd(rows.reduce((sum, r) => sum + (perAccount.get(r.id) ?? 0), 0)),
    };
  });

  return {
    accounts: remedies.length,
    costUsd: roundUsd([...perAccount.values()].reduce((sum, c) => sum + c, 0)),
    unaccounted: unaccounted(input.returnDispatches, remedies),
    byKind,
    byGuard,
    recent: [...remedies]
      .reverse()
      .slice(0, RECENT_ROWS)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        ref: `pr:${r.prNumber}`,
        prNumber: r.prNumber,
        cause: r.cause,
        causeLabel: CAUSE_COPY[r.cause].label,
        guard: r.guard,
        guardLabel: GUARD_COPY[r.guard].label,
        summary: r.summary,
        checks: r.checks,
        at: r.createdAt,
      })),
  };
}

function costPerAccount(remedies: readonly Remedy[], usageEvents: readonly UsageEvent[]): Map<string, number> {
  const filedBy = new Map<string, string[]>();
  for (const r of remedies) filedBy.set(r.agentId, [...(filedBy.get(r.agentId) ?? []), r.id]);

  const spend = new Map<string, number>();
  for (const event of usageEvents) {
    if (!filedBy.has(event.agentId)) continue;
    spend.set(event.agentId, (spend.get(event.agentId) ?? 0) + event.costUsd);
  }

  const per = new Map<string, number>();
  for (const [agentId, ids] of filedBy) {
    const share = (spend.get(agentId) ?? 0) / ids.length;
    for (const id of ids) per.set(id, share);
  }
  return per;
}

export function isReturnOrigin(originRef: string | null): boolean {
  return originRef !== null && /^pr:\d+:(ci|comments)$/.test(originRef);
}

function unaccounted(returnDispatches: readonly string[], remedies: readonly Remedy[]): number {
  const accounted = new Set(remedies.map((r) => r.taskId));
  return returnDispatches.filter((taskId) => !accounted.has(taskId)).length;
}

function topCheck(rows: readonly Remedy[]): { name: string; accounts: number } | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const name of new Set(row.checks)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best: { name: string; accounts: number } | null = null;
  for (const [name, accounts] of counts) {
    if (best === null || accounts > best.accounts) best = { name, accounts };
  }
  return best;
}
