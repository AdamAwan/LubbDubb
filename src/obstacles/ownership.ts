import { basePrOf } from '../prHealth.js';
import type { ObstacleStanding, PullRequest } from '../types.js';

// → docs/spec/27-obstacles.md

const REPAIR_VOICES = 3;

export function obstacleRepairOrigin(obstacleId: string): string {
  return `obstacle:${obstacleId}`;
}

export function obstacleRepairBranch(obstacleId: string): string {
  return `obstacle/${obstacleId}`;
}

export function ownershipDoor(row: ObstacleStanding, redBaseChecks: ReadonlySet<string>): 'repair' | 'ticket' | null {
  const { obstacle } = row;
  if (obstacle.kind !== 'obstacle') return null;
  if (obstacle.state !== 'standing' || obstacle.ownerRef !== null) return null;
  return blockingNow(row, redBaseChecks) ? 'repair' : 'ticket';
}

function blockingNow(row: ObstacleStanding, redBaseChecks: ReadonlySet<string>): boolean {
  if (row.voices >= REPAIR_VOICES) return true;
  return row.keys.some((key) => key.kind === 'check' && key.binds && redBaseChecks.has(key.value));
}

export function obstacleTicketFields(
  row: ObstacleStanding,
  sightings: readonly { words: string; goalRef: string | null }[],
): { title: string; vars: Record<string, string> } {
  const claim = row.obstacle.what.replace(/\s+/g, ' ').trim();
  const keys = row.keys
    .filter((key) => key.binds)
    .map((key) => `${key.kind}:${key.value}`)
    .join(', ');
  return {
    title: `Fix: ${claim}`.slice(0, TITLE_CHARS),
    vars: {
      claim,
      keys: keys === '' ? '(none that bind)' : keys,
      voices: String(row.voices),
      goals: row.goalRefs.length === 0 ? '(none — the harness saw it itself)' : row.goalRefs.join(', '),
      sightings: sightings
        .map((s) => `- ${s.goalRef ?? 'the harness'}: ${s.words.replace(/\s+/g, ' ').trim()}`)
        .join('\n'),
    },
  };
}

const TITLE_CHARS = 80;

export function obstacleTicketGoal(row: ObstacleStanding): number | null {
  for (const ref of row.goalRefs) {
    const match = /^issue:(\d+)$/.exec(ref);
    if (match) return Number(match[1]);
  }
  return null;
}

export function redBaseChecks(openPrs: readonly PullRequest[]): ReadonlySet<string> {
  const out = new Set<string>();
  const prs = [...openPrs];
  for (const pr of prs) {
    const base = basePrOf(pr, prs);
    if (!base) continue;
    for (const check of base.ciChecks ?? []) if (!check.advisory && check.status === 'failing') out.add(check.name);
  }
  return out;
}
