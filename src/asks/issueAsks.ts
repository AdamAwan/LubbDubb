import type { AskDraft, AskInputs } from './queue.js';
import { askLine, opensAt } from './lines.js';

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
      title: askLine('Held at intake', base.goalRef, state),
      opens: opensAt(base.goalRef, state),
      raisedAt: issue.appraisal.decidedAt,
    });
  }
  return rows;
}

// Planning waits on the operator here, so the ask blocks: nothing is planned for the goal
// until the sitting is closed. → docs/spec/08-planning.md#the-intake-sitting-stands-in-front-of-the-planner
export function sittingRows(state: AskInputs): AskDraft[] {
  const rows: AskDraft[] = [];
  for (const issue of state.world.issues) {
    if (issue.state !== 'open' || issue.pickup.status !== 'sitting') continue;
    const base = issueRow(issue.number);
    rows.push({
      ...base,
      id: `sitting:${base.goalRef}`,
      kind: 'sitting',
      group: 'blocking',
      title: askLine('Planning waits on your prediction and criteria', base.goalRef, state),
      opens: opensAt(base.goalRef, state),
      raisedAt: issue.appraisal?.decidedAt ?? state.world.takenAt,
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
      title: askLine(`Wants to run on “${appraisal.proposedProfile}”`, base.goalRef, state),
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
        title: askLine(
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
