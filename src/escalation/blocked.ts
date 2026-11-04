import type { Escalation, GoalBlock } from '../types.js';
import type { Store } from '../store/store.js';
import type { AgentManager } from '../agents/agentManager.js';
import type { EscalationInbox } from './escalationInbox.js';

// → docs/spec/06-issue-pickup.md#blocked-parks-the-goal-for-you

export function blockOf(escalation: Escalation): GoalBlock | null {
  const block = escalation.context.blocked;
  if (typeof block !== 'object' || block === null) return null;
  if (typeof block.originRef !== 'string' || typeof block.reason !== 'string') return null;
  return block;
}

function joinBlocks(standing: GoalBlock, next: GoalBlock): GoalBlock {
  return {
    originRef: standing.originRef,
    reason: `${standing.reason}\n\nA later agent concluded blocked too:\n\n${next.reason}`,
    note: `${standing.note}\n\nThe later agent got as far as:\n\n${next.note}`,
    agentId: next.agentId,
  };
}

function settledByHarness(escalation: Escalation): boolean {
  const dismissal = escalation.context.dismissal;
  return typeof dismissal === 'object' && dismissal !== null && (dismissal as { by?: unknown }).by === 'harness';
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

function blockPrompt(block: GoalBlock): string {
  return (
    `An agent stopped on ${block.originRef} and concluded it blocked — something that is not this goal kept ` +
    `it from finishing. In its words:\n\n> ${quoted(block.reason)}\n\nWhat it got as far as:\n\n> ` +
    `${quoted(block.note)}\n\nNothing is dispatched for the goal until you release it. Answer to release it ` +
    `back to pickup: what you write goes to the next agent as an instruction, beside the reason above. ` +
    `Dismissing releases it too, with the reason alone.`
  );
}

function releaseInstruction(block: GoalBlock, response: string | null): string {
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

export function wireBlocks(store: Store, agents: AgentManager, escalations: EscalationInbox): void {
  agents.on('blocked', ({ taskId, block }) => {
    for (const standing of store.escalations.listOpenEscalations()) {
      const prior = blockOf(standing);
      if (prior?.originRef !== block.originRef) continue;
      const joined = joinBlocks(prior, block);
      escalations.restate(standing.id, blockPrompt(joined), { ...standing.context, blocked: joined });
      return;
    }
    escalations.create({
      type: 'resolve_ambiguity',
      prompt: blockPrompt(block),
      context: { taskTitle: store.tasks.getTask(taskId)?.title, originRef: block.originRef, blocked: block },
      taskId,
    });
  });
  const release = (escalation: Escalation): void => {
    const block = blockOf(escalation);
    if (block === null || settledByHarness(escalation)) return;
    store.instructions.addIssueInstruction({
      originRef: block.originRef,
      text: releaseInstruction(block, escalation.response),
    });
  };
  escalations.on('answered', ({ escalation }: { escalation: Escalation }) => release(escalation));
  escalations.on('dismissed', (escalation: Escalation) => release(escalation));
}
