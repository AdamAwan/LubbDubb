import type { ObstacleBlock, ObstacleStanding } from '../types.js';
import { reachesAgents } from './lifecycle.js';

// → docs/spec/27-obstacles.md

export function blockedGoals(
  blocks: readonly ObstacleBlock[],
  board: readonly ObstacleStanding[],
): Map<string, ObstacleBlock> {
  const byId = new Map(board.map((row) => [row.obstacle.id, row]));
  const out = new Map<string, ObstacleBlock>();
  for (const block of blocks) {
    const row = byId.get(block.obstacleId);
    if (row && reachesAgents(row.obstacle.state)) out.set(block.originRef, block);
  }
  return out;
}

export function releasedBlocks(blocks: readonly ObstacleBlock[], board: readonly ObstacleStanding[]): ObstacleBlock[] {
  const held = blockedGoals(blocks, board);
  return blocks.filter((block) => !held.has(block.originRef));
}
