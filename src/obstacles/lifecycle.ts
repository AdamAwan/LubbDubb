import type { ObstacleState } from '../types.js';

// → docs/spec/27-obstacles.md

export const OBSTACLE_STATES = ['sighted', 'standing', 'owned', 'resolved', 'dormant', 'muted'] as const;

interface ObstacleExit {
  readonly to: ObstacleState;
  readonly by: 'evidence' | 'clock' | 'harness' | 'person';
  readonly how: string;
}

export const OBSTACLE_STATES_A_PERSON_MUST_LEAVE: readonly ObstacleState[] = ['muted'];

export const OBSTACLE_EXITS: Record<ObstacleState, readonly ObstacleExit[]> = {
  sighted: [
    { to: 'standing', by: 'evidence', how: 'a second independent voice says it' },
    { to: 'resolved', by: 'clock', how: "the reporter's own until ran out on it" },
    { to: 'dormant', by: 'clock', how: 'nothing re-reports it inside obstacleDormantMs' },
    { to: 'muted', by: 'person', how: 'an operator says never tell the fleet this' },
  ],
  standing: [
    { to: 'owned', by: 'harness', how: 'the pulse files a ticket or a repair dispatch for it' },
    { to: 'resolved', by: 'evidence', how: 'the world was observed to clear it, on two consecutive readings' },
    { to: 'resolved', by: 'evidence', how: "a note's documentation change landed, off the work graph" },
    { to: 'resolved', by: 'clock', how: "the reporter's own until ran out on it" },
    { to: 'dormant', by: 'clock', how: 'nothing re-reports it inside obstacleDormantMs' },
    { to: 'muted', by: 'person', how: 'an operator says never tell the fleet this' },
  ],
  owned: [
    { to: 'resolved', by: 'evidence', how: 'the owner landed, off the landing sweep' },
    { to: 'resolved', by: 'evidence', how: 'the world was observed to clear it, on two consecutive readings' },
    { to: 'standing', by: 'harness', how: 'the owner went away without landing' },
    { to: 'muted', by: 'person', how: 'an operator says never tell the fleet this' },
  ],
  resolved: [{ to: 'standing', by: 'evidence', how: 'a matching report reopens it, with its whole history' }],
  dormant: [{ to: 'standing', by: 'evidence', how: 'a matching report reopens it, with its whole history' }],
  muted: [{ to: 'standing', by: 'person', how: 'an operator unmutes it' }],
};

export function hasAutomaticExit(state: ObstacleState): boolean {
  return OBSTACLE_EXITS[state].some((exit) => exit.by !== 'person');
}

const VOICES_TO_STAND = 2;

export function stateAfterSighting(state: ObstacleState, voices: number): ObstacleState {
  if (state === 'muted' || state === 'owned') return state;
  if (state === 'resolved' || state === 'dormant') return 'standing';
  return voices >= VOICES_TO_STAND ? 'standing' : 'sighted';
}

export function reachesAgents(state: ObstacleState): boolean {
  return state === 'standing' || state === 'owned';
}
