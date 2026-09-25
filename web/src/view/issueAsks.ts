import type { AppState } from '../types.js';
import { watchBucket } from '../worldBuckets.js';
import { askLine, opensAt } from './needLines.js';
import type { NeedDraft } from './needsYou.js';

// → docs/spec/17-cockpit.md

export function intakeRows(state: AppState): NeedDraft[] {
  const rows: NeedDraft[] = [];
  for (const issue of state.world.issues) {
    if (issue.state !== 'open' || issue.appraisal?.verdict !== 'unclear') continue;
    if (watchBucket(issue.labels, state.config.watchLabel) !== 'watched') continue;
    const goalRef = `issue:${issue.number}`;
    rows.push({
      id: `intake:${goalRef}`,
      kind: 'intake',
      group: 'yours',
      title: askLine('Held at intake', goalRef, state),
      goalRef,
      originRef: goalRef,
      opens: opensAt(goalRef, state),
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: issue.appraisal.decidedAt,
    });
  }
  return rows;
}

// Planning waits on the operator here, so the ask blocks: nothing is planned for the goal
// until the sitting is closed. → docs/spec/08-planning.md#the-intake-sitting-stands-in-front-of-the-planner
export function sittingRows(state: AppState): NeedDraft[] {
  const rows: NeedDraft[] = [];
  for (const issue of state.world.issues) {
    if (issue.state !== 'open' || issue.pickup.status !== 'sitting') continue;
    const goalRef = `issue:${issue.number}`;
    rows.push({
      id: `sitting:${goalRef}`,
      kind: 'sitting',
      group: 'blocking',
      title: askLine('Planning waits on your prediction and criteria', goalRef, state),
      goalRef,
      originRef: goalRef,
      opens: opensAt(goalRef, state),
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: issue.appraisal?.decidedAt ?? state.world.takenAt,
    });
  }
  return rows;
}

export function profileRows(state: AppState): NeedDraft[] {
  const rows: NeedDraft[] = [];
  for (const issue of state.world.issues) {
    const appraisal = issue.appraisal;
    if (!appraisal?.awaitingProfileAnswer || appraisal.proposedProfile === null) continue;
    const goalRef = `issue:${issue.number}`;
    rows.push({
      id: `profile:${goalRef}`,
      kind: 'profile',
      group: 'yours',
      title: askLine(`Wants to run on “${appraisal.proposedProfile}”`, goalRef, state),
      goalRef,
      originRef: goalRef,
      opens: opensAt(goalRef, state),
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: appraisal.decidedAt,
    });
  }
  return rows;
}

export function placementRows(state: AppState): NeedDraft[] {
  const rows: NeedDraft[] = [];
  for (const issue of state.world.issues) {
    for (const ask of issue.appraisal?.placement ?? []) {
      const goalRef = `issue:${issue.number}`;
      rows.push({
        id: `placement:${ask.field}:${goalRef}`,
        kind: 'placement',
        group: 'yours',
        title: askLine(
          ask.field === 'parent'
            ? ask.proposedParent === null
              ? 'No parent Feature'
              : `No parent — #${ask.proposedParent} proposed`
            : `On no team's board — “${ask.proposedAreaPath}” proposed`,
          goalRef,
          state,
        ),
        goalRef,
        originRef: goalRef,
        opens: opensAt(goalRef, state),
        agentId: null,
        agentLabel: null,
        holding: 0,
        raisedAt: issue.appraisal?.decidedAt ?? '',
      });
    }
  }
  return rows;
}
