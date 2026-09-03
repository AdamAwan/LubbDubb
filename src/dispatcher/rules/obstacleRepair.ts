import { obstacleRepairBranch, obstacleRepairOrigin, ownershipDoor } from '../../obstacles/ownership.js';
import type { ObstacleStanding } from '../../types.js';
import type { Candidate, RawAction, StageContext } from './context.js';

/** How many of the reporters' own sentences the briefing carries. The intake's number. */
const WORDS_SHOWN = 3;

/**
 * Put one agent on the thing standing in the fleet's way.
 *
 * This is the second of the two ownership doors, and it is a **capability**
 * rather than a convenience: a store that can queue work can put agents on the
 * fleet. So it is one rule, in the pipeline where it can be seen, taking the
 * headroom cut like every other candidate — never a general licence for this
 * subsystem to schedule things.
 *
 * ## What it may fire for
 *
 * Only what is blocking the fleet *now* — a base branch red, or three or more
 * independent voices — which is {@link ownershipDoor}'s `repair` answer and never
 * a second opinion here. Everything else standing goes through the other door: a
 * ticket, filed by the ownership desk, ranked and priced like any other goal.
 *
 * ## Bounded, and bounded here rather than by the cut
 *
 * **At most one repair in flight across the whole fleet.** The headroom cut bounds
 * how many agents run; it does not bound how many of them this rule may be. A
 * board that went to twenty standing rows on a bad afternoon would otherwise
 * propose twenty repairs, and a subsystem whose whole point is *not spending the
 * fleet twice on one thing* would be spending it on itself. One at a time is the
 * bound that cannot be argued with, and a second obstacle waits exactly as long as
 * the first takes.
 *
 * ## Where it sits
 *
 * Directly below rule `manual-job` and above every world-driven rule. What it
 * dispatches for is, by construction, in front of work the rules below it are
 * about to propose: an agent sent to a red base is an agent sent to the reason the
 * next four dispatches would have failed. It is above the PR concerns for the same
 * reason `pr-review-comment` is above `pr-ci-failing` — the earlier signal is the
 * one that invalidates the later work.
 *
 * ## The origin
 *
 * `obstacle:<id>`, classified in `src/issueOrigins.ts`. Left unclassified it reads
 * as `unrecognised`: it stops expanding under a goal's priority flag, and its
 * spend files under "other" — and neither is red.
 * → `docs/spec/32-obstacles.md#ownership`
 */
export function obstacleRepair(s: StageContext): void {
  // One at a time, counted off the origins the fleet is actually working rather
  // than off this cycle's proposals: a repair dispatched two pulses ago is still
  // a repair in flight, and a rule that only looked at its own candidates would
  // propose a second one on every pulse until the first finished.
  for (const origin of s.activeOrigins) if (origin.startsWith('obstacle:')) return;

  for (const row of s.obstacles) {
    if (ownershipDoor(row, s.redBaseChecks) !== 'repair') continue;
    const origin = obstacleRepairOrigin(row.obstacle.id);
    const branch = obstacleRepairBranch(row.obstacle.id);
    const claim = row.obstacle.what.replace(/\s+/g, ' ').trim();
    const title = `Repair: ${claim}`;
    const reason =
      `${row.voices} independent voices have hit "${claim}", or it is red on a branch other pull ` +
      `requests are based on — it is blocking the fleet now.`;
    const candidate: Candidate = {
      origin,
      rule: 'obstacle-repair',
      title,
      kind: 'code',
      branch,
      reason,
      action: {
        type: 'dispatch_code_agent',
        branch,
        title,
        // The claim, the keys and the words the reporters used are **appended**,
        // never interpolated: an operator override written before this rule
        // existed would silently drop a new token, and they are the whole of what
        // this agent has to go on.
        prompt: s.templates.render('obstacle-repair', { claim }) + repairBriefing(row),
        originRef: origin,
        originTitle: title,
        originSummary: claim,
        rule: 'obstacle-repair',
        reason,
      } satisfies RawAction,
    };
    // Through `consider` like every other candidate, so a repair that keeps
    // failing cools down and then asks a person rather than looping: an obstacle
    // three agents could not fix is exactly the thing an operator wants to be
    // told about, and the row itself says nothing to anybody who is not looking.
    s.consider(candidate, (attempts) => ({
      type: 'escalate_to_human',
      escalationType: 'resolve_ambiguity',
      prompt:
        `The fleet has hit "${claim}" ${row.voices} times and ${attempts} agents have failed to clear it. ` +
        `Nothing further will be dispatched for it. It is still on the board and still in front of every ` +
        `dispatch it matches, so the fleet is working around it rather than into it.`,
      context: { originRef: origin, taskTitle: title },
      rule: 'obstacle-repair',
      admission: 'cooldown-escalate',
      reason: `Origin ${origin} hit the ${s.cooldown.maxAttempts}-attempt cap without clearing the obstacle.`,
    }));
    return;
  }
}

/**
 * What the agent is told about the thing it is being sent at: the ways into it,
 * and what the agents that hit it said, in their own words.
 *
 * Their words rather than the claim restated, for the intake's reason — the claim
 * is one line with the reporter's own frame stripped out of it, and the sentences
 * behind it are what someone diagnosing the thing actually needs.
 */
function repairBriefing(row: ObstacleStanding): string {
  const keys = row.keys
    .filter((key) => key.binds)
    .map((key) => `\`${key.kind}:${key.value}\``)
    .join(', ');
  const words = row.words.slice(-WORDS_SHOWN);
  return (
    `\n\n---\n\n` +
    (keys === '' ? '' : `It identifies as: ${keys}.\n\n`) +
    `${row.voices} independent voices have hit it${row.goalRefs.length === 0 ? '' : ` (${row.goalRefs.join(', ')})`}.` +
    (words.length === 0 ? '' : ` In their own words:\n\n${words.map((w) => `> ${w}`).join('\n>\n')}`) +
    `\n\nFix **this** and nothing else. If what you find is that it is not one thing, or not fixable from ` +
    `here, say so in what you conclude rather than widening the change.\n`
  );
}
