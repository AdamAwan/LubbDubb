import type { Issue, LocalRunTargetView, LocalRunView, LocalValidationStatus, LocalValidationView } from '../types.js';

/**
 * How a local validation reads: whether one is in flight, what to call each state,
 * and which question pressing the button would raise.
 *
 * Pure, and in `view/` rather than in the console because both layers draw it — the
 * goal page's chip and card, and the local-run panel's own button. A copy in each
 * would be two vocabularies for one row, disagreeing first about what `dispatched`
 * is called.
 */

/** The two statuses that mean nobody has answered yet. */
const IN_FLIGHT: ReadonlySet<LocalValidationStatus> = new Set<LocalValidationStatus>(['pending', 'dispatched']);

export function inFlight(validation: LocalValidationView | null): boolean {
  return validation !== null && IN_FLIGHT.has(validation.status);
}

/**
 * One word per status, in the operator's vocabulary rather than the store's.
 *
 * `abandoned` reads "called off", which is what it is from the outside: the row was
 * settled by something other than an answer, and every one of those cases — the
 * environment went away, the agent died, they cancelled — is the run not happening
 * rather than the run saying something.
 */
export const STATUS_WORD: Record<LocalValidationStatus, string> = {
  pending: 'queued',
  dispatched: 'validating',
  passed: 'passed',
  failed: 'failed',
  blocked: 'blocked',
  abandoned: 'called off',
};

/**
 * What is happening right now, in words — the phase the server derived, said.
 *
 * The phase itself is folded on the server for `Issue.validation`'s reason, so this
 * only translates: a cockpit that worked out which stage a run was in would be a
 * second opinion drawn beside the row it describes.
 */
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

/** The tone vocabulary the local-run panel already uses, so one row cannot read two ways. */
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
    // `blocked` is muted rather than red, and that is the reading it earned: nothing
    // was found out about the goal, which is not the same news as the goal being
    // wrong. `abandoned` is the same shape of non-answer.
    case 'blocked':
    case 'abandoned':
      return 'off';
  }
}

/** Whether the control is drawn at all, and — when it is not — what to say instead. */
type LocalValidationOffer = { offered: true } | { offered: false; why: string };

/**
 * Is there anything to press?
 *
 * Three arms, each a different fact and each worth its own sentence: a control that
 * is simply absent teaches an operator that the feature does not work here, where
 * one that says why is a control they can go and satisfy. Nothing is ever drawn
 * disabled — the local-run panel's rule, and this is the same surface's question.
 */
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

/**
 * Which question pressing the button raises, or none.
 *
 * Both are the operator's to answer and neither can be answered afterwards: a swap
 * takes an environment away, and a refresh is a `reset --hard` under a running
 * server. `null` is the ordinary case — nothing running, or this goal already up
 * and current — and the post goes straight through.
 *
 * The server refuses on the same two conditions and the refusal is the backstop:
 * this decides what to *ask*, and being wrong about it costs a modal rather than a
 * lost environment.
 */
export function validateLocallyQuestion(issueNumber: number, run: LocalRunView | null): 'swap' | 'refresh' | null {
  if (run === null || !run.live) return null;
  if (run.originRef !== `issue:${String(issueNumber)}`) return 'swap';
  // Only worth asking when there is something to pick up, and only when the run is
  // idle enough to do it: a refresh during a turn is refused by the runner, and
  // offering it would be a question whose answer changes nothing.
  const behind = run.freshness?.behindTip ?? 0;
  if (behind > 0 && run.status === 'running' && run.turn === null) return 'refresh';
  return null;
}
