// → docs/spec/39-app-errors.md#agent-triage

export function appErrorTriageOrigin(runId: string): string {
  return `app-errors:triage:${runId}`;
}

export function appErrorTriageRunId(originRef: string | null): string | null {
  const match = /^app-errors:triage:([A-Za-z0-9_-]+)$/.exec(originRef ?? '');
  return match ? match[1]! : null;
}

/** The read-only checkout's lease key: one per run, never a branch anybody pushes. */
export function appErrorTriageBranch(runId: string): string {
  return `triage/app-errors/${runId}`;
}
