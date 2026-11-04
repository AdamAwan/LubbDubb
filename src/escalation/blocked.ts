import type { Escalation, GoalBlock } from '../types.js';

// → docs/spec/06-issue-pickup.md#blocked-parks-the-goal-for-you

export function blockOf(escalation: Escalation): GoalBlock | null {
  const block = escalation.context.blocked;
  if (typeof block !== 'object' || block === null || typeof block.originRef !== 'string') return null;
  return block;
}

export function blockedGoals(escalations: readonly Escalation[]): ReadonlyMap<string, GoalBlock> {
  const out = new Map<string, GoalBlock>();
  for (const escalation of escalations) {
    if (escalation.status !== 'open') continue;
    const block = blockOf(escalation);
    if (block !== null && !out.has(block.originRef)) out.set(block.originRef, block);
  }
  return out;
}

export function blockPrompt(block: GoalBlock): string {
  return (
    `An agent stopped on ${block.originRef} and concluded it blocked — something that is not this goal kept ` +
    `it from finishing. In its words:\n\n> ${quoted(block.reason)}\n\nWhat it got as far as:\n\n> ` +
    `${quoted(block.note)}\n\nNothing is dispatched for the goal until you release it. Answer to release it ` +
    `back to pickup: what you write goes to the next agent as an instruction, beside the reason above. ` +
    `Dismissing releases it too, with the reason alone.`
  );
}

export function releaseInstruction(block: GoalBlock, response: string | null): string {
  const answer = response?.trim() ?? '';
  return (
    `I released this goal. The agent before you concluded it blocked, saying:\n\n${block.reason}\n\n` +
    `Check whether that still stands before you start, and if it does, conclude blocked again rather than ` +
    `working around it.` +
    (answer === '' ? '' : `\n\n${answer}`)
  );
}

function quoted(text: string): string {
  return text.replace(/\n/g, '\n> ');
}
