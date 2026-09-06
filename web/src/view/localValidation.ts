import type { Issue, LocalRunTargetView, LocalRunView, LocalValidationStatus, LocalValidationView } from '../types.js';

// → docs/spec/17-cockpit.md

const IN_FLIGHT: ReadonlySet<LocalValidationStatus> = new Set<LocalValidationStatus>(['pending', 'dispatched']);

export function inFlight(validation: LocalValidationView | null): boolean {
  return validation !== null && IN_FLIGHT.has(validation.status);
}

export const STATUS_WORD: Record<LocalValidationStatus, string> = {
  pending: 'queued',
  dispatched: 'validating',
  passed: 'passed',
  failed: 'failed',
  blocked: 'blocked',
  abandoned: 'called off',
};

export function localValidationSaid(validation: LocalValidationView): string {
  switch (validation.phase) {
    case 'queued':
      return 'waiting for a slot';
    case 'planning':
      return 'writing the test plan';
    case 'environment':
      return 'waiting for the environment';
    case 'driving':
      return 'running the plan';
    default:
      return STATUS_WORD[validation.status];
  }
}

export type LocalValidationTone = 'up' | 'busy' | 'bad' | 'off';

export function localValidationTone(status: LocalValidationStatus): LocalValidationTone {
  switch (status) {
    case 'passed':
      return 'up';
    case 'pending':
    case 'dispatched':
      return 'busy';
    case 'failed':
      return 'bad';
    case 'blocked':
    case 'abandoned':
      return 'off';
  }
}

type LocalValidationOffer = { offered: true } | { offered: false; why: string };

export function localValidationOffer(
  issue: Pick<Issue, 'localValidation'>,
  target: LocalRunTargetView | undefined,
  localRunConfigured: boolean,
): LocalValidationOffer {
  if (!localRunConfigured)
    return {
      offered: false,
      why: 'Nothing is configured to start this project on your machine — set localRun.instruction on the Config page.',
    };
  if (target?.runnable !== true)
    return { offered: false, why: 'This goal has no branch of its own to run yet, so there is nothing to validate.' };
  if (inFlight(issue.localValidation)) return { offered: false, why: 'An agent is validating it now.' };
  return { offered: true };
}

export function validateLocallyQuestion(issueNumber: number, run: LocalRunView | null): 'swap' | 'refresh' | null {
  if (run === null || !run.live) return null;
  if (run.originRef !== `issue:${String(issueNumber)}`) return 'swap';
  const behind = run.freshness?.behindTip ?? 0;
  if (behind > 0 && run.status === 'running' && run.turn === null) return 'refresh';
  return null;
}
