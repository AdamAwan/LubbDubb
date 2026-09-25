import type { Config } from './config.js';

export function validatePool(merged: Config): void {
  const path = merged.pool?.path ?? '';
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes('..')) {
    throw new Error(
      `Refusing to start: pool.path ("${path}") escapes the pool's clone. It is a prefix *inside* the ` +
        `repository the pool is given — "engineering/fleet-pool", or empty for the repository root. ` +
        `An absolute, rooted or ".."-bearing path would have the harness writing outside the clone.`,
    );
  }
  if (merged.integrations.pool === 'fake') return;
  if (!merged.pool?.project) {
    throw new Error(
      `Refusing to start: integrations.pool is "${merged.integrations.pool}" but no pool.project is set. ` +
        `The project name is what decides whose claims are relevant to whom, and it is declared in the ` +
        `committed lubbdubb.project.json so every clone reads the same string. There is no derivation fallback.`,
    );
  }
  if (merged.integrations.pool === 'git' && (!merged.pool.remote || !merged.pool.branch)) {
    throw new Error(
      `Refusing to start: the git pool transport needs coordinates — set "pool.remote" and "pool.branch" ` +
        `in lubbdubb.project.json. No credential goes there: git authenticates the way it already does for that host.`,
    );
  }
}

export function validateReview(merged: Config): void {
  const named = merged.review.defaultMode;
  if (named === null) return;
  const modes = Object.keys(merged.review.modes);
  if (!modes.includes(named)) {
    throw new Error(
      `Refusing to start: review.defaultMode is "${named}", which is not one of review.modes ` +
        `(${modes.join(', ') || 'none declared'}). It names the mode a review falls back to when the triage ` +
        `cannot answer, so a name with nothing behind it is only reached on the day something else went wrong.`,
    );
  }
}

export function validateWorkItemStates(merged: Config): void {
  const pickup = merged.issuePickupStates ?? [];
  const named = [
    ['issueInProgressState', merged.issueInProgressState],
    ['issueInReviewState', merged.issueInReviewState],
  ].filter(([, state]) => state !== undefined && state !== '');
  if (named.length > 0 && pickup.length === 0) {
    throw new Error(
      `Refusing to start: ${named.map(([key]) => key).join(' and ')} ${named.length > 1 ? 'name states' : 'names a state'} ` +
        'to move work items to, but issuePickupStates is empty — the rules that move them are off, so the board ' +
        'never leaves the state its items are filed in. Name the states work starts in (e.g. ["New"]), or drop ' +
        'the transition keys.',
    );
  }
  for (const key of ['issueCompletedState', 'issueNotPlannedState'] as const) {
    const closed = merged[key];
    if (closed !== undefined && pickup.includes(closed)) {
      throw new Error(
        `Refusing to start: ${key} is "${closed}", which is also in issuePickupStates. An item the harness ` +
          'closed into that state still reads as pickup-eligible, so the fleet picks up the work it has just ' +
          'finished. Take it out of issuePickupStates.',
      );
    }
  }
  const inReview = merged.issueInReviewState;
  if (inReview !== undefined && pickup.includes(inReview)) {
    throw new Error(
      `Refusing to start: issueInReviewState is "${inReview}", which is also in issuePickupStates. An item parked ` +
        'there still reads as pickup-eligible, so the harness writes that same state to the tracker on every ' +
        'pulse for as long as its pull request is open. Take it out of issuePickupStates.',
    );
  }
}

export function validateAgentMode(merged: Config): void {
  const mode: string = merged.agentMode;
  if (mode === 'stream' || mode === 'raw') return;
  throw new Error(
    `Refusing to start: agentMode is "${mode}", and the only modes are "stream" (real Claude Code over ` +
      `headless stream-JSON, the only one that runs a model) and "raw" (the mock — your argv over a terminal). ` +
      `"pty" is gone: everything it alone could do, the stream transport now carries in structure. Set ` +
      `"agentMode": "stream".`,
  );
}
