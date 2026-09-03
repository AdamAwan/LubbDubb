import type { ObstacleBlock, ObstacleStanding } from '../types.js';
import { reachesAgents } from './lifecycle.js';

/**
 * The `blocked` verdict's pure layer: which goals are parked behind an obstacle,
 * and which of those parks the board has since ended.
 *
 * An agent whose task is genuinely stopped — the base will not build — is not
 * helped by *carry on*, and telling it to carry on makes it spin. So it concludes
 * `blocked`, naming the obstacle, and the goal stops being picked up until the
 * obstacle stops reaching agents. That is the difference between the fleet
 * queueing behind one obstacle and the fleet spending its allowance on it.
 *
 * **The exit is the obstacle, never the goal.** A block is not one of the four
 * verdicts about whether a goal's work is finished (`src/store/verdicts.ts`) and
 * clears none of them: it answers whether the work can be *attempted* right now.
 *
 * Pure — no I/O, no clock, no store. → `docs/spec/32-obstacles.md#blocked-is-an-answer`
 */

/**
 * The goals pickup must skip, with the obstacle each is behind.
 *
 * A block naming a row that is **gone** releases rather than holds, which is the
 * repo's discipline about failing toward the visible mistake: an unheld goal is a
 * redundant agent an operator can see, and a goal held behind an id nothing
 * resolves is work that never comes back with nothing red.
 */
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

/**
 * The blocks whose obstacle no longer reaches agents — the desk's whole reading.
 *
 * `reachesAgents` is asked rather than the states restated, so the rows the
 * intake answers *it is not yours* on and the rows a goal still waits behind
 * cannot drift. `owned` still holds: something is fixing it, which is not the
 * same as fixed.
 */
export function releasedBlocks(blocks: readonly ObstacleBlock[], board: readonly ObstacleStanding[]): ObstacleBlock[] {
  const held = blockedGoals(blocks, board);
  return blocks.filter((block) => !held.has(block.originRef));
}
