import { basePrOf } from '../prHealth.js';
import type { ObstacleStanding, PullRequest } from '../types.js';

/**
 * Who gets an obstacle, and through which of the two doors.
 *
 * **Never an agent.** The reporting agent is not the owner and no agent stakes a
 * claim: a lock an agent takes is a lock an agent forgets. Ownership is a row the
 * harness writes on the pulse, transactionally on `owner IS NULL`
 * (`Store.claimObstacle`) — so *do not all pile on* is a uniqueness constraint
 * rather than an instruction. Nothing here writes anything; it says which door a
 * row is at, and the desk and the rule each take their own.
 *
 * Pure — no I/O, no clock, no store. → `docs/spec/27-obstacles.md#ownership`
 */

/**
 * How many independent voices make an obstacle *the fleet's problem now* rather
 * than a ticket for later.
 *
 * Three rather than the two that carry a row to `standing`, and the gap is the
 * whole distinction: two voices mean it is real and not one goal's own doing,
 * which is what the fleet is told; a third is the fleet paying for it a third
 * time, which is what an agent is spent on. A threshold rather than a judgement
 * because the alternative is a severity an agent assigns, and severities from
 * different agents are not comparable.
 */
const REPAIR_VOICES = 3;

/** The dispatch origin a repair for one obstacle is keyed on. */
export function obstacleRepairOrigin(obstacleId: string): string {
  return `obstacle:${obstacleId}`;
}

/** The branch a repair is cut on — `obstacle/<id>`, so a reaper reads it like any other. */
export function obstacleRepairBranch(obstacleId: string): string {
  return `obstacle/${obstacleId}`;
}

/**
 * Which door this row is at, or null for one no door is open for.
 *
 * - **`repair`** — it is blocking the fleet *now*: a base branch red, or three or
 *   more voices. One bounded rule dispatches for it, subject to the headroom cut
 *   like every other candidate; this only says which rows it may look at.
 * - **`ticket`** — everything else standing. It enters the normal funnel and is
 *   ranked and priced like any other goal, which is the whole point of filing one
 *   rather than inventing a second queue.
 * - **null** — anything that is not a standing, unowned obstacle. A **note** is
 *   never here: it has no owner and ends by being written down.
 *
 * The `owner` check is belt to the store's braces. The claim itself is the
 * `UPDATE … WHERE owner_ref IS NULL`, and a predicate that read the same field a
 * moment earlier would be exactly the check-then-act the constraint exists to
 * replace — this only keeps the desk from asking.
 */
export function ownershipDoor(row: ObstacleStanding, redBaseChecks: ReadonlySet<string>): 'repair' | 'ticket' | null {
  const { obstacle } = row;
  if (obstacle.kind !== 'obstacle') return null;
  if (obstacle.state !== 'standing' || obstacle.ownerRef !== null) return null;
  return blockingNow(row, redBaseChecks) ? 'repair' : 'ticket';
}

/**
 * Is this obstacle costing the fleet its sessions right now?
 *
 * The check half reads **binding** keys only, and that is the suggestion rule
 * arriving here rather than a second policy: a key that may not resolve an
 * obstacle may not decide that the fleet dispatches an agent for one either, or
 * "does not bind" would mean *binds when convenient*.
 */
function blockingNow(row: ObstacleStanding, redBaseChecks: ReadonlySet<string>): boolean {
  if (row.voices >= REPAIR_VOICES) return true;
  return row.keys.some((key) => key.kind === 'check' && key.binds && redBaseChecks.has(key.value));
}

/**
 * The ticket, from the sightings — title, body and the goal it is filed against.
 *
 * **Written by the harness, not by a model.** Composing the prose from the
 * sightings is a job a model may do (`docs/spec/27-obstacles.md#what-may-be-decided-by-a-model-and-what-may-not`),
 * and the desk that would is a later phase; until then the ticket says what the
 * board holds, in the reporters' own words, which is the thing an operator would
 * have to go and read otherwise.
 *
 * **What the ticket must carry is not in here.** Type, labels, assignee and the
 * bug relation are arguments to `ActionSink.createIssue`, resolved by
 * `ticketFiler` — a ticket without the watch label is created, linked, shown
 * complete, and never dispatched for. This composes the two fields that are
 * genuinely prose. → `docs/spec/13-jobs-and-tickets.md#filing-a-ticket`
 */
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

/** A tracker title stays a line. The body carries everything worth reading. */
const TITLE_CHARS = 80;

/**
 * The goal a ticket is filed **against** — the first that hit it.
 *
 * The bug/story relation is one edge, so the first voice is the one it is drawn
 * to: it is the goal whose session paid for the discovery, and the one whose
 * reader most needs to know why it went the way it did. Null where no goal said
 * it, which is a harness voice, and then the ticket is related to nothing rather
 * than to whichever goal happened to be second.
 */
export function obstacleTicketGoal(row: ObstacleStanding): number | null {
  for (const ref of row.goalRefs) {
    const match = /^issue:(\d+)$/.exec(ref);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * The checks failing on a branch other open pull requests are **based on**.
 *
 * The base is what makes a red check the fleet's problem rather than one pull
 * request's: red on a leaf holds up the goal that owns it, and red on a base holds
 * up everything stacked on it — which is what *blocking the fleet now* names.
 * `basePrOf` is the harness's one reading of that relationship, the same one the
 * knowledge notices are raised off, so the desk and the rule cannot disagree about
 * which branch is a base.
 *
 * Advisory checks are excluded: a check the provider says does not block
 * completion is not in anybody's way, and an agent dispatched for one would be
 * spent on a reading that never stopped a thing.
 */
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
