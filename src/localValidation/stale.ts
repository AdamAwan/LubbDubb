import type { LocalRun, LocalValidation } from '../types.js';

// → docs/spec/32-local-validation.md

export function validationRunStale(row: LocalValidation, live: LocalRun | null): string | null {
  if (live === null) return 'the local environment was stopped';
  if (live.id !== row.runId)
    return live.originRef === row.originRef
      ? 'the local environment was restarted, so this reading would be of a different run'
      : `the local environment was swapped to ${live.originRef}`;
  if (live.status === 'stopping') return 'the local environment is being taken down';
  if (row.commit === null || live.commit === null)
    return 'which commit the local environment stands at was never recorded, so this reading cannot be pinned to it';
  if (live.commit !== row.commit)
    return `the local environment was refreshed onto ${live.commit.slice(0, 7)}, and this was planned against ${row.commit.slice(0, 7)}`;
  return null;
}

export function localValidationIsOpen(row: LocalValidation): boolean {
  return row.status === 'pending' || row.status === 'dispatched';
}
