import type { PlanPart } from '../types.js';

// → docs/spec/23-local-runs.md

export interface LocalRunOption {
  ref: string;
  part: { slug: string; title: string; seq: number; status: PlanPart['status'] } | null;
}

export interface LocalRunChoices {
  target: string | null;
  options: LocalRunOption[];
  parts: { total: number; merged: number };
}

function skippable(status: PlanPart['status']): boolean {
  return status === 'merged' || status === 'retired' || status === 'concluded';
}

export function localRunChoices(parts: readonly PlanPart[], own: string | null = null): LocalRunChoices {
  const ordered = [...parts].sort((a, b) => a.seq - b.seq);
  const options: LocalRunOption[] = own === null ? [] : [{ ref: own, part: null }];
  let tip: string | null = null;
  for (const part of ordered) {
    if (part.branch === null || part.branch === '') continue;
    options.push({
      ref: part.branch,
      part: { slug: part.slug, title: part.title, seq: part.seq, status: part.status },
    });
    if (!skippable(part.status)) tip = part.branch;
  }
  return {
    target: tip ?? own,
    options,
    parts: { total: ordered.length, merged: ordered.filter((p) => p.status === 'merged').length },
  };
}
