import type { OpenPullRequest, ViewerAssignment } from '../wire.js';
import type { AskDraft, AskInputs } from './queue.js';
import { askLine, goalOf, goalOfPr, oneLine, opensAt, prAddress } from './lines.js';
import { ciNeedsAttention, isConflicted } from '../pr/prHealth.js';

// → docs/spec/07-pull-requests.md

const REVIEWER_NOTE: Partial<Record<ViewerAssignment, string>> = {
  'reviewer-required': 'Required reviewer',
  'reviewer-optional': 'Optional reviewer',
};

const NOBODY = { group: 'yours', agentId: null, agentLabel: null, holding: 0 } as const;

function assignedLine(pr: OpenPullRequest): string {
  const lead = pr.attention?.reasons[0] ?? '';
  const sentence = lead === '' ? `PR #${pr.number} is yours` : `${lead[0]?.toUpperCase() ?? ''}${lead.slice(1)}`;
  const title = pr.title.trim();
  return oneLine(title === '' ? sentence : `${sentence} on “${title}”`);
}

/**
 * What is wrong with a bot's pull request the operator is on and the fleet is not.
 * → docs/spec/37-bot-prs.md#one-put-on-you-that-is-in-trouble
 */
export function botPrTroubles(pr: OpenPullRequest): string[] {
  if (pr.botAuthored !== true || pr.attention?.assignedToYou === undefined) return [];
  const troubles: string[] = [];
  if (ciNeedsAttention(pr)) troubles.push('CI is failing');
  if (isConflicted(pr)) troubles.push(`it conflicts with ${pr.baseBranch ?? 'its base'}`);
  return troubles;
}

export function assignedPrRows(state: AskInputs): AskDraft[] {
  const rows: AskDraft[] = [];
  for (const pr of state.world.pullRequests) {
    const assignment = pr.attention?.assignedToYou;
    if (assignment === undefined || botPrTroubles(pr).length > 0) continue;
    const goalRef = goalOfPr(state, pr.number);
    const note = REVIEWER_NOTE[assignment];
    rows.push({
      ...NOBODY,
      id: `assigned:pr:${pr.number}`,
      kind: 'assigned',
      subject: { type: 'pull_request', prNumber: pr.number },
      title: askLine(assignedLine(pr), goalRef, state),
      ...(note === undefined ? {} : { note }),
      goalRef,
      originRef: `pr:${pr.number}`,
      opens: prAddress(state, pr.number) === undefined ? opensAt(goalRef, state) : 'provider',
      details: opensAt(goalRef, state),
      raisedAt: pr.attention?.reviewWaitingSince ?? '',
    });
  }
  return rows;
}

/** → docs/spec/37-bot-prs.md#one-put-on-you-that-is-in-trouble */
export function botPrRows(state: AskInputs): AskDraft[] {
  const rows: AskDraft[] = [];
  for (const pr of state.world.pullRequests) {
    const troubles = botPrTroubles(pr);
    if (troubles.length === 0) continue;
    const said = troubles.join(' and ');
    const title = pr.title.trim();
    const goalRef = goalOfPr(state, pr.number);
    const author = pr.author?.trim() ?? '';
    rows.push({
      ...NOBODY,
      id: `bot_pr:pr:${pr.number}`,
      kind: 'bot_pr',
      subject: { type: 'pull_request', prNumber: pr.number },
      title: askLine(
        oneLine(
          `${said[0]?.toUpperCase() ?? ''}${said.slice(1)} on ${title === '' ? `PR #${pr.number}` : `“${title}”`}`,
        ),
        goalRef,
        state,
      ),
      ...(author === '' ? {} : { note: author }),
      goalRef,
      originRef: `pr:${pr.number}`,
      opens: opensAt(goalRef, state),
      prNumber: pr.number,
      raisedAt: '',
    });
  }
  return rows;
}

/** A pull request of the fleet's ready for a person with nobody on it. → docs/spec/07-pull-requests.md#asking-who-should-look-at-it */
export function assignAskRows(state: AskInputs): AskDraft[] {
  const rows: AskDraft[] = [];
  for (const pr of state.world.pullRequests) {
    if (pr.assignAsk === undefined) continue;
    const goalRef = goalOfPr(state, pr.number);
    rows.push({
      ...NOBODY,
      id: `assign:pr:${pr.number}`,
      kind: 'assign',
      subject: { type: 'pull_request', prNumber: pr.number },
      title: askLine(`PR #${pr.number} is ready — want to assign it to someone?`, goalRef, state),
      goalRef,
      originRef: `pr:${pr.number}`,
      opens: opensAt(goalRef, state),
      prNumber: pr.number,
      raisedAt: pr.attention?.reviewWaitingSince ?? '',
    });
  }
  return rows;
}

/** → docs/spec/07-pull-requests.md#the-rail-asks-for-it-and-nothing-waits-on-the-answer */
export function undescribedPartRows(state: AskInputs): AskDraft[] {
  const parts = state.planParts ?? [];
  const rows: AskDraft[] = [];
  for (const waiting of state.undescribedParts ?? []) {
    const slug = /^issue:\d+:part:(.+)$/.exec(waiting.originRef)?.[1] ?? null;
    const goalRef = goalOf(waiting.originRef, state);
    const title = parts.find((p) => p.slug === slug)?.title ?? '';
    rows.push({
      ...NOBODY,
      id: `describe:${waiting.originRef}`,
      kind: 'describe',
      subject: { type: 'part', originRef: waiting.originRef, prNumber: waiting.prNumber },
      title: askLine(
        title === ''
          ? `Nobody has said what PR #${waiting.prNumber} does`
          : `Nobody has said what PR #${waiting.prNumber} does — “${oneLine(title)}”`,
        goalRef,
        state,
      ),
      goalRef,
      originRef: waiting.originRef,
      opens: 'pr',
      prNumber: waiting.prNumber,
      raisedAt: waiting.openedAt,
    });
  }
  return rows;
}

/** → docs/spec/07-pull-requests.md#what-the-check-raises */
export function descriptionFeedbackRows(state: AskInputs): AskDraft[] {
  const rows: AskDraft[] = [];
  for (const feedback of state.descriptionFeedback ?? []) {
    const wrong = feedback.contradicted > 0;
    const count = wrong ? feedback.contradicted : feedback.gaps;
    const goalRef = goalOf(feedback.originRef, state);
    rows.push({
      ...NOBODY,
      id: `description:${feedback.versionId}`,
      kind: wrong ? 'description_wrong' : 'description_note',
      subject: { type: 'description_check', versionId: feedback.versionId, prNumber: feedback.prNumber },
      title: askLine(
        wrong
          ? `Your description of PR #${feedback.prNumber} says ${count === 1 ? 'something' : `${count} things`} the diff does not do`
          : `The diff of PR #${feedback.prNumber} raises ${count === 1 ? 'something' : `${count} things`} your description does not`,
        goalRef,
        state,
      ),
      goalRef,
      originRef: feedback.originRef,
      opens: 'pr',
      prNumber: feedback.prNumber,
      raisedAt: feedback.checkedAt,
    });
  }
  return rows;
}
