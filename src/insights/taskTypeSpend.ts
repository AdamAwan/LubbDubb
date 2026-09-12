import type { Agent, TaskSummary } from '../types.js';
import { roundUsd, unmeasured } from './issueSpend.js';
import { DISPATCH_RULES, type DispatchRuleId } from '../dispatcher/rules.js';

// → docs/spec/18-observability.md

const TOP_ROWS = 15;

export interface TaskTypeSpend {
  rule: string | null;
  label: string;
  description: string | null;
  costUsd: number;
  runs: number;
  perRunUsd: number;
}

interface CheckSpend {
  name: string;
  costUsd: number;
  runs: number;
  soleRuns: number;
  perRunUsd: number;
  lastAt: string | null;
}

export interface ChecksSpend {
  checks: CheckSpend[];
  seen: number;
  attributedCostUsd: number;
  unnamedCostUsd: number;
}

interface TaskTypeInput {
  agents: readonly Agent[];
  tasks: readonly TaskSummary[];
}

function copyOf(rule: string | null): { label: string; description: string | null } {
  if (rule === null) {
    return { label: 'No rule', description: 'Dispatched outside the pulse — an accepted proposal, or agent lifecycle' };
  }
  const known = DISPATCH_RULES[rule as DispatchRuleId] as { name: string; description: string } | undefined;
  return known === undefined
    ? { label: rule, description: null }
    : { label: known.name, description: known.description };
}

export function rollUpTaskTypes(input: TaskTypeInput): TaskTypeSpend[] {
  const taskOf = new Map(input.tasks.map((t) => [t.id, t]));
  const byRule = new Map<string | null, TaskTypeSpend>();

  for (const agent of input.agents) {
    if (unmeasured(agent)) continue;
    const rule = taskOf.get(agent.taskId)?.rule ?? null;
    const row = byRule.get(rule) ?? { rule, ...copyOf(rule), costUsd: 0, runs: 0, perRunUsd: 0 };
    row.costUsd = roundUsd(row.costUsd + (agent.costUsd ?? 0));
    row.runs += 1;
    byRule.set(rule, row);
  }

  return [...byRule.values()]
    .map((row) => ({ ...row, perRunUsd: roundUsd(row.costUsd / row.runs) }))
    .sort((a, b) => b.costUsd - a.costUsd || a.label.localeCompare(b.label));
}

export function rollUpChecks(input: TaskTypeInput): ChecksSpend {
  const taskOf = new Map(input.tasks.map((t) => [t.id, t]));
  const byCheck = new Map<string, CheckSpend>();
  let attributedCostUsd = 0;
  let unnamedCostUsd = 0;

  for (const agent of input.agents) {
    if (unmeasured(agent)) continue;
    const task = taskOf.get(agent.taskId);
    if (task === undefined || (task.rule !== 'pr-ci-failing' && task.rule !== 'pr-ci-gate')) continue;
    const cost = agent.costUsd ?? 0;
    const names = task.ciChecks ?? null;
    if (names === null || names.length === 0) {
      unnamedCostUsd = roundUsd(unnamedCostUsd + cost);
      continue;
    }

    attributedCostUsd = roundUsd(attributedCostUsd + cost);
    const share = cost / names.length;
    const at = agent.endedAt ?? agent.startedAt;
    for (const name of names) {
      const row = byCheck.get(name) ?? { name, costUsd: 0, runs: 0, soleRuns: 0, perRunUsd: 0, lastAt: null };
      row.costUsd = roundUsd(row.costUsd + share);
      row.runs += 1;
      if (names.length === 1) row.soleRuns += 1;
      if (row.lastAt === null || at > row.lastAt) row.lastAt = at;
      byCheck.set(name, row);
    }
  }

  const ranked = [...byCheck.values()]
    .map((row) => ({ ...row, perRunUsd: roundUsd(row.costUsd / row.runs) }))
    .sort((a, b) => b.costUsd - a.costUsd || a.name.localeCompare(b.name));

  return {
    checks: ranked.slice(0, TOP_ROWS),
    seen: ranked.length,
    attributedCostUsd,
    unnamedCostUsd,
  };
}
