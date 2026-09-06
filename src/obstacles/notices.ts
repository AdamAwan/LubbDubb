import type { Obstacle } from '../types.js';
import { obstaclesForDispatch, type DeliverableObstacle } from './delivery.js';

// → docs/spec/27-obstacles.md

type ObstacleNoticeReason = 'standing' | 'owned' | 'resolved';

export interface NoticeAgent {
  agentId: string;
  goalRef: string | null;
  scopes: readonly string[];
  reported: ReadonlySet<string>;
  notified: ReadonlySet<string>;
}

interface ObstacleNotice {
  agentId: string;
  obstacleId: string;
  reason: ObstacleNoticeReason;
  text: string;
}

export function obstacleNotices(
  rows: readonly DeliverableObstacle[],
  agents: readonly NoticeAgent[],
): ObstacleNotice[] {
  const out: ObstacleNotice[] = [];
  for (const agent of agents) {
    const owned = new Set(
      rows.filter((row) => row.obstacle.ownerRef !== null && row.obstacle.ownerRef === agent.goalRef),
    );
    const mine = rows.filter((row) => agent.reported.has(row.obstacle.id) && !owned.has(row));
    const theirs = obstaclesForDispatch({
      rows: rows.filter(
        (row) => row.obstacle.state === 'standing' && !agent.reported.has(row.obstacle.id) && !owned.has(row),
      ),
      scopes: agent.scopes,
      paths: [],
    });
    for (const row of mine) {
      const reason = reporterReason(row.obstacle);
      if (reason === null) continue;
      if (agent.notified.has(row.obstacle.id)) continue;
      out.push({ agentId: agent.agentId, obstacleId: row.obstacle.id, reason, text: noticeText(row.obstacle, reason) });
    }
    for (const row of theirs) {
      if (agent.notified.has(row.obstacle.id)) continue;
      out.push({
        agentId: agent.agentId,
        obstacleId: row.obstacle.id,
        reason: 'standing',
        text: noticeText(row.obstacle, 'standing'),
      });
    }
  }
  return out;
}

function reporterReason(obstacle: Obstacle): ObstacleNoticeReason | null {
  if (obstacle.state === 'owned') return 'owned';
  if (obstacle.state === 'resolved') return 'resolved';
  return null;
}

function noticeText(obstacle: Obstacle, reason: ObstacleNoticeReason): string {
  const claim = obstacle.what.replace(/\s+/g, ' ').trim();
  if (reason === 'owned') {
    const owner = obstacle.ownerRef ?? 'Something else';
    return `${owner} now owns what you reported: "${claim}". Do not fix it. Note it and carry on with your task.`;
  }
  if (reason === 'resolved') {
    return (
      `What you reported has been resolved: "${claim}". If it is still in your way, say so with \`raise\` — ` +
      `a matching report reopens it. Otherwise carry on with your task.`
    );
  }
  return (
    `Another goal has now hit the same thing on a check you are working: "${claim}". Two independent voices ` +
    `have seen it, so it is not your doing and not your task: work around it and say so in what you ` +
    `conclude. Do not go fixing it.`
  );
}
