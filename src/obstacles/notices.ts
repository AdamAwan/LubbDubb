import type { Obstacle } from '../types.js';
import { obstaclesForDispatch, type DeliverableObstacle } from './delivery.js';

/**
 * The second of the two channels: **mid-session, to a running agent**.
 *
 * A dispatch's prompt is written once, and an obstacle that reaches `standing`
 * an hour into a two-hour session is one the agent working that hour will never
 * be told about. So a desk sends into a live session when — and only when — a
 * state change alters what that agent should do.
 *
 * Three rules keep the channel worth reading, and each is a line here rather than
 * a habit:
 *
 * - **Once per agent per obstacle, ever.** A notice that arrives twice reads as a
 *   second problem. It is a primary key in `obstacle_notices` rather than a
 *   condition, and the claim is taken before the message goes out.
 * - **Never to the reporter or the owner.** Telling the agent whose report
 *   created the row that the row exists is absurd, and so is telling the agent
 *   fixing it that it is broken.
 * - **Never for anything else.** A chatty channel is skimmed, and then the
 *   message that mattered is skimmed too.
 *
 * Pure — no I/O, no clock, no store. What is live and what has already been sent
 * arrive as arguments, so `test/obstacleNotices.test.ts` holds the three rules
 * without a fleet. → `docs/spec/27-obstacles.md#delivery`
 */

/** Why one notice is going out. Recorded, and read by nothing that decides. */
type ObstacleNoticeReason = 'standing' | 'owned' | 'resolved';

/** A live agent, as the two arms read it. */
export interface NoticeAgent {
  agentId: string;
  /**
   * The goal this agent is on, collapsed from its dispatch origin — never the
   * origin, for the voice count's reason: `pr:412:ci` and `pr:412:comments` are
   * two origins of one goal, and an owner named as a goal would match neither.
   */
  goalRef: string | null;
  /** `dispatchFactScopes` for its own dispatch: the goal, and each check it answers. */
  scopes: readonly string[];
  /** The obstacles this agent itself reported. */
  reported: ReadonlySet<string>;
  /** The obstacles it has already been told about, ever. */
  notified: ReadonlySet<string>;
}

/** One message, to one agent, about one obstacle. */
interface ObstacleNotice {
  agentId: string;
  obstacleId: string;
  reason: ObstacleNoticeReason;
  text: string;
}

/**
 * Every notice owed right now.
 *
 * **Level-triggered, and safe to be**, which is what the once-ever ledger buys:
 * an edge would have to be read off a previous pulse's snapshot, and a restart
 * that straddled the transition would lose the notice for good. Asking *what is
 * true now, minus what this agent has already been told* survives every restart
 * and cannot repeat itself.
 *
 * The two arms are deliberately not symmetrical. The reporter is told what became
 * of **its own report** — that is the state change that alters what it should do,
 * and it is the one thing it asked for. Everybody else is told only that
 * something on its own checks has been corroborated, and only on the transition
 * to `standing`: a row that is `owned` or `sighted` changes nothing for an agent
 * that never reported it.
 */
export function obstacleNotices(
  rows: readonly DeliverableObstacle[],
  agents: readonly NoticeAgent[],
): ObstacleNotice[] {
  const out: ObstacleNotice[] = [];
  for (const agent of agents) {
    // **Never to the owner.** An agent working the goal that owns a row is the one
    // party the row is not news to, and a notice saying *do not fix this* to the
    // agent dispatched to fix it is the channel arguing with the fleet.
    const owned = new Set(
      rows.filter((row) => row.obstacle.ownerRef !== null && row.obstacle.ownerRef === agent.goalRef),
    );
    const mine = rows.filter((row) => agent.reported.has(row.obstacle.id) && !owned.has(row));
    // **Never to the reporter**, for the standing arm: it is the agent that put
    // the row there, so *this exists* is the one sentence it does not need.
    const theirs = obstaclesForDispatch({
      rows: rows.filter(
        (row) => row.obstacle.state === 'standing' && !agent.reported.has(row.obstacle.id) && !owned.has(row),
      ),
      scopes: agent.scopes,
      // The checks its dispatch is about, and nothing else. The paths half of
      // delivery is the dispatch prompt's, where the agent has not started work;
      // an interruption is a cost, and it is paid for a check the agent is
      // watching rather than for a file it may never open.
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

/**
 * What has become of a reporter's own row, or null where nothing has.
 *
 * `sighted` is not a change — it is where every report lands — and `dormant` and
 * `muted` change nothing the agent should do about the thing it hit. **Never for
 * anything else** is this returning null.
 */
function reporterReason(obstacle: Obstacle): ObstacleNoticeReason | null {
  if (obstacle.state === 'owned') return 'owned';
  if (obstacle.state === 'resolved') return 'resolved';
  return null;
}

/**
 * The one message, which is an imperative sentence and not a report.
 *
 * It is written to be read in the middle of a turn about something else: what
 * happened, and what it changes about the next ten turns. The wording matches the
 * intake's directives, because an agent that reads one thing from the tool and a
 * different one from this channel has two harnesses talking to it.
 */
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
