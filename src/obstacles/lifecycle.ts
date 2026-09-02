import type { ObstacleState } from '../types.js';

/**
 * The states an obstacle can be in, and — for each — the way out that is not a
 * person.
 *
 * **This is the invariant the store this replaces did not have.** Every durable
 * claim there waited on an operator's click, so its output when nobody visited
 * the page was exactly zero and neglect had no degraded mode
 * (`docs/spec/32-obstacles.md#what-went-wrong-last-time`). A queue only a human
 * empties is how that died, and a convention would not have caught it — so the
 * exits are a table a test walks rather than a rule a reviewer remembers.
 *
 * Pure — no I/O, no clock, no store. → `docs/spec/32-obstacles.md#states`
 */

/**
 * Every state, in the order the document lists them.
 *
 * The declaration `test/obstacleLifecycle.test.ts` enumerates: a state added here
 * without an entry in {@link OBSTACLE_EXITS} does not typecheck, and one added
 * with no automatic exit fails that test.
 */
export const OBSTACLE_STATES = ['sighted', 'standing', 'owned', 'resolved', 'dormant', 'muted'] as const;

/** How a row leaves a state, and whether anybody has to be watching for it to. */
interface ObstacleExit {
  /** Where it goes. */
  readonly to: ObstacleState;
  /**
   * What moves it. `evidence` is a report or a world reading, `clock` is time
   * passing, `harness` is a desk on the pulse — and `person` is an operator, which
   * is what makes an exit not count.
   */
  readonly by: 'evidence' | 'clock' | 'harness' | 'person';
  /** One line, for the test's failure message and for the page that draws it. */
  readonly how: string;
}

/**
 * The one state whose only exit is a person, carved out **by name**.
 *
 * Not by predicate, and that is the point: a rule loose enough to admit one
 * would have admitted every state the previous store filled up with. A second
 * entry here is the failure `test/obstacleLifecycle.test.ts` exists to catch, so
 * adding one means arguing for it in review rather than satisfying a condition.
 */
export const OBSTACLE_STATES_A_PERSON_MUST_LEAVE: readonly ObstacleState[] = ['muted'];

/**
 * Every exit each state has.
 *
 * `resolved` and `dormant` are terminal in the sense that matters — nothing
 * further is owed of anyone — but they are **not deletions**: a matching report
 * reopens the row at `standing` with its whole history, which is the only way a
 * fix that did not stick is visible as a recurrence rather than as a fresh
 * problem every time. That reopening is their automatic exit.
 */
export const OBSTACLE_EXITS: Record<ObstacleState, readonly ObstacleExit[]> = {
  sighted: [
    { to: 'standing', by: 'evidence', how: 'a second independent voice says it' },
    { to: 'dormant', by: 'clock', how: 'nothing re-reports it inside obstacleDormantMs' },
    { to: 'muted', by: 'person', how: 'an operator says never tell the fleet this' },
  ],
  standing: [
    { to: 'owned', by: 'harness', how: 'the pulse files a ticket or a repair dispatch for it' },
    { to: 'resolved', by: 'evidence', how: 'the world was observed to clear it' },
    { to: 'dormant', by: 'clock', how: 'nothing re-reports it inside obstacleDormantMs' },
    { to: 'muted', by: 'person', how: 'an operator says never tell the fleet this' },
  ],
  owned: [
    { to: 'resolved', by: 'evidence', how: 'the owner landed, off the landing sweep' },
    { to: 'standing', by: 'harness', how: 'the owner went away without landing' },
    { to: 'muted', by: 'person', how: 'an operator says never tell the fleet this' },
  ],
  resolved: [{ to: 'standing', by: 'evidence', how: 'a matching report reopens it, with its whole history' }],
  dormant: [{ to: 'standing', by: 'evidence', how: 'a matching report reopens it, with its whole history' }],
  muted: [{ to: 'standing', by: 'person', how: 'an operator unmutes it' }],
};

/** Whether a state has a way out that nobody has to be watching for. */
export function hasAutomaticExit(state: ObstacleState): boolean {
  return OBSTACLE_EXITS[state].some((exit) => exit.by !== 'person');
}

/**
 * How many independent voices carry a row to `standing`.
 *
 * Two, and the second must be independent — one goal saying a thing twice is one
 * voice, and the harness observing the same transition on ten pulses is one
 * voice. **One report is not evidence**: it is also the case the harness cannot
 * tell apart from an agent mis-diagnosing its own breakage, which is why
 * `sighted` reaches nobody.
 */
const VOICES_TO_STAND = 2;

/**
 * Where a row sits once `voices` independent voices have said it.
 *
 * Only ever moves a row **forward out of `sighted`**, or back to `standing` from
 * a terminal state. Everything else is somebody else's transition: `owned` is the
 * pulse's, `dormant` is the clock's, and `muted` is an operator's — and a
 * function that could undo any of them from a report would let an agent unmute a
 * row an operator silenced.
 */
export function stateAfterSighting(state: ObstacleState, voices: number): ObstacleState {
  if (state === 'muted' || state === 'owned') return state;
  if (state === 'resolved' || state === 'dormant') return 'standing';
  return voices >= VOICES_TO_STAND ? 'standing' : 'sighted';
}

/**
 * Whether a row in this state reaches an agent at all.
 *
 * `sighted` reaches nobody, which is what makes the withholding of
 * `what_others_saw` structural rather than polite: a second agent shown the
 * first's sentence and then counted as agreeing with it is not independent
 * evidence, and the count cannot see the difference.
 * → `docs/spec/32-obstacles.md#others-words-are-withheld-until-standing`
 */
export function reachesAgents(state: ObstacleState): boolean {
  return state === 'standing' || state === 'owned';
}
