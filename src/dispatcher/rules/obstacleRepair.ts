import { obstacleRepairBranch, obstacleRepairOrigin, ownershipDoor } from '../../obstacles/ownership.js';
import type { ObstacleStanding } from '../../types.js';
import type { Candidate, RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `obstacle-repair`)

const WORDS_SHOWN = 3;

export function obstacleRepair(s: StageContext): void {
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
        prompt: s.templates.render('obstacle-repair', { claim }) + repairBriefing(row),
        originRef: origin,
        originTitle: title,
        originSummary: claim,
        rule: 'obstacle-repair',
        reason,
      } satisfies RawAction,
    };
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
