export interface GoalLanding {
  prNumber: number;
  goalRef: string;
  sha: string;
  recordedAt: string;
  onIntegration: boolean | null;
  /** When the provider said it merged; null where it did not, which `recordedAt` then stands in for. */
  mergedAt: string | null;
}

export type EnvironmentReachStatus = 'reached' | 'absent' | 'unknown';

export interface EnvironmentReading {
  sha: string;
  environment: string;
  status: EnvironmentReachStatus;
  detail: string | null;
  observedAt: string;
}

export type EnvironmentHealthState = 'healthy' | 'unhealthy' | 'unknown';

export type EnvironmentHealthTier = 'red' | 'orange';

export interface EnvironmentHealthReading {
  environment: string;
  state: EnvironmentHealthState;
  tier: EnvironmentHealthTier | null;
  reasons: string[];
  detail: string | null;
  observedAt: string;
  changedAt: string;
}

/**
 * Where one environment's `at` probe last said it is. `changedAt` is when the harness noticed the
 * head move — null for the first head it ever read, which is no deploy. → docs/spec/24-environments.md#the-head
 */
export interface DeployedHead {
  environment: string;
  sha: string;
  previousSha: string | null;
  observedAt: string;
  changedAt: string | null;
}

export type GoalReachStatus = 'reached' | 'partial' | 'absent' | 'unknown';

export interface GoalEnvironmentReach {
  environment: string;
  status: GoalReachStatus;
  landed: number;
  total: number;
  unplaced: number;
  at: string | null;
  opens: EnvironmentGate[];
}

/**
 * One declared group's roll-up over the {@link GoalEnvironmentReach} rows of its members —
 * three regions of production read as the one place they are. The laggard governs, exactly as
 * several commits printed by one environment's `at` do: the group holds the goal's work only
 * when every environment in it does. Computed on the server off the same rows the per-environment
 * card draws, so the two cannot disagree. → docs/spec/24-environments.md#groups
 */
export interface GoalGroupReach {
  group: string;
  environments: string[];
  status: GoalReachStatus;
  /** The laggard's count — what the *group* holds, not what its furthest member does. */
  landed: number;
  total: number;
  /** When the last member of the group took it; null until every one of them holds the work. */
  at: string | null;
  opens: EnvironmentGate[];
}

/**
 * One landed pull request's reach, environment by environment — the rows the rollup in
 * {@link GoalEnvironmentReach} is computed from. A goal is checked as a whole or not at
 * all: `rollUpReach` answers `reached` only when every one of these reads `reached`, so
 * this is what says *which* landing is holding the goal short, and whether one of them
 * never can be.
 */
export interface GoalLandingReach {
  prNumber: number;
  sha: string;
  /** Environment name to what the probe said. A name absent means no reading was taken. */
  reach: Record<string, EnvironmentReachStatus>;
  /** The squash is on no integration branch, so no environment can ever hold it. */
  unplaced: boolean;
}

export type EnvironmentGate = 'validate' | 'close_out';

export interface GoalArrival {
  goalRef: string;
  environment: string;
  arrivedAt: string;
  announcedAt: string | null;
  watchedAt: string | null;
  sheetedAt: string | null;
}

export interface EnvironmentGateRelease {
  goalRef: string;
  note: string;
  releasedAt: string;
}
