import type { AskDraft, AskInputs } from './queue.js';
import { askTitle, opensAt } from './lines.js';
import { issueSubtreeNumber } from '../issueOrigins.js';

// → docs/spec/17-cockpit.md#the-queue-rail--needs-you

function watched(labels: string[] | undefined, watchLabel: string): boolean {
  return !watchLabel || (labels ?? []).includes(watchLabel);
}

function issueRow(
  number: number,
): Pick<AskDraft, 'subject' | 'goalRef' | 'originRef' | 'agentId' | 'agentLabel' | 'holding'> {
  const goalRef = `issue:${number}`;
  return {
    subject: { type: 'issue', issueNumber: number },
    goalRef,
    originRef: goalRef,
    agentId: null,
    agentLabel: null,
    holding: 0,
  };
}

export function intakeRows(state: AskInputs): AskDraft[] {
  const rows: AskDraft[] = [];
  for (const issue of state.world.issues) {
    if (issue.state !== 'open' || issue.appraisal?.verdict !== 'unclear') continue;
    if (!watched(issue.labels, state.config.watchLabel)) continue;
    const base = issueRow(issue.number);
    rows.push({
      ...base,
      id: `intake:${base.goalRef}`,
      kind: 'intake',
      group: 'yours',
      ...askTitle('Held at intake', base.goalRef, state),
      opens: opensAt(base.goalRef, state),
      raisedAt: issue.appraisal.decidedAt,
    });
  }
  return rows;
}

// A story Up next holds on open discussion questions, one row per story however many of its dispatches
// wait. It stands exactly while the dispatcher holds it. → docs/spec/40-discussions.md#where-else-it-is-reached-from
export function questionRows(state: AskInputs): AskDraft[] {
  const held = new Map<number, string>();
  for (const item of state.upcoming?.items ?? []) {
    if (item.status !== 'questions') continue;
    const number = issueSubtreeNumber(item.origin);
    if (number !== null && !held.has(number)) held.set(number, item.reason);
  }
  return [...held].map(([number, reason]) => {
    const base = issueRow(number);
    return {
      ...base,
      id: `questions:${base.goalRef}`,
      kind: 'questions',
      group: 'yours',
      ...askTitle('Waiting on open questions', base.goalRef, state),
      opens: opensAt(base.goalRef, state),
      raisedAt: '',
      note: reason,
    };
  });
}

// The findings hold planning and pickup, so the ask blocks. It stands exactly while the findings
// are unanswered and hold the goal. → docs/spec/06-issue-pickup.md
export function findingsRows(state: AskInputs): AskDraft[] {
  const rows: AskDraft[] = [];
  for (const issue of state.world.issues) {
    const investigation = issue.investigation;
    if (issue.investigationHold === null || investigation?.resolution !== null) continue;
    const base = issueRow(issue.number);
    rows.push({
      ...base,
      id: `findings:${base.goalRef}`,
      kind: 'findings',
      group: 'blocking',
      ...askTitle('Investigated — the findings wait on your call', base.goalRef, state),
      opens: opensAt(base.goalRef, state),
      raisedAt: investigation.decidedAt,
    });
  }
  return rows;
}

export function profileRows(state: AskInputs): AskDraft[] {
  const rows: AskDraft[] = [];
  for (const issue of state.world.issues) {
    const appraisal = issue.appraisal;
    if (!appraisal || appraisal.awaitingProfileAnswer !== true || appraisal.proposedProfile === null) continue;
    const base = issueRow(issue.number);
    rows.push({
      ...base,
      id: `profile:${base.goalRef}`,
      kind: 'profile',
      group: 'yours',
      ...askTitle(`Wants to run on “${appraisal.proposedProfile}”`, base.goalRef, state),
      opens: opensAt(base.goalRef, state),
      raisedAt: appraisal.decidedAt,
    });
  }
  return rows;
}

export function placementRows(state: AskInputs): AskDraft[] {
  const rows: AskDraft[] = [];
  for (const issue of state.world.issues) {
    for (const ask of issue.appraisal?.placement ?? []) {
      const base = issueRow(issue.number);
      rows.push({
        ...base,
        id: `placement:${ask.field}:${base.goalRef}`,
        kind: 'placement',
        group: 'yours',
        ...askTitle(
          ask.field === 'parent'
            ? ask.proposedParent === null
              ? 'No parent Feature'
              : `No parent — #${ask.proposedParent} proposed`
            : `On no team's board — “${ask.proposedAreaPath}” proposed`,
          base.goalRef,
          state,
        ),
        opens: opensAt(base.goalRef, state),
        raisedAt: issue.appraisal?.decidedAt ?? '',
        placementField: ask.field,
        ...(ask.field === 'areaPath' ? { verb: 'Pick a board' } : {}),
      });
    }
  }
  return rows;
}
