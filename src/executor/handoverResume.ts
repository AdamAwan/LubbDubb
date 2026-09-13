import type { Store } from '../store/store.js';
import type { Agent, Issue } from '../types.js';
import { goalFingerprint } from '../intake/appraisal.js';
import { handoverSource, issueOriginRef } from '../issueOrigins.js';
import { agentsOnOrigin } from './retryResume.js';

// → docs/spec/09-execution.md#handing-a-conversation-on

export interface HandoverResume {
  previous: Agent;
  from: string;
}

export function handoverResumeFor(
  originRef: string | null | undefined,
  store: Store,
  issues: readonly Issue[],
): HandoverResume | null {
  const declared = handoverSource(originRef ?? null);
  if (declared === null || declared.from !== 'appraisal') return null;
  if (agentsOnOrigin(originRef, store).length > 0) return null;

  const { issueNumber } = declared;
  const appraisal = store.verdicts.getAppraisal(issueOriginRef('root', issueNumber));
  if (appraisal === null || appraisal.verdict !== 'workable' || appraisal.agentId === null) return null;

  const issue = issues.find((i) => i.number === issueNumber);
  if (issue === undefined || appraisal.goalRef !== goalFingerprint(issue.title, issue.body)) return null;

  const previous = store.agents.getAgent(appraisal.agentId);
  if (!previous || previous.status !== 'done' || !previous.sessionId) return null;
  return { previous, from: issueOriginRef('appraisal', issueNumber) };
}

export function handoverNote(): string {
  return (
    '## You appraised this goal — now plan it\n\n' +
    'Everything already in this conversation is your own read of this same ticket against this same ' +
    'repository, from the turn in which you judged whether there was a goal here at all. Use what you ' +
    'worked out; do not pay for it twice.\n\n' +
    'Two things are not as you left them:\n\n' +
    '- The goal is restated below **as the world reports it now**, and that restatement is what you plan ' +
    'against.\n' +
    '- **You are in the checkout you appraised from, and it has been swept.** It is the same detached ' +
    'read-only tree at the same default branch, so the repository is as you read it — but anything you ' +
    'wrote to disk yourself is gone. Read a file back before you build on what you remember of it.\n\n' +
    'You are being asked a different question from the one you just answered. Whether there is a goal here ' +
    'is settled; what is wanted now is the decomposition.'
  );
}
