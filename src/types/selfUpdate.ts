export type UpgradeState = 'idle' | 'draining' | 'ready' | 'applying';

export interface UpgradeIntent {
  state: UpgradeState;
  targetSha: string | null;
  requestedAt: string | null;
  pausedByDrain: boolean;
}
