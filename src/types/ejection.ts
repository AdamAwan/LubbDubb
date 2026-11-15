// → docs/spec/35-ejection.md
export type EjectionOutcome = 'handed_back' | 'requeued' | 'delivered' | 'expired';

export interface Ejection {
  id: string;
  originRef: string;
  branch: string | null;
  worktreePath: string | null;
  agentId: string;
  taskId: string;
  sessionId: string | null;
  reason: string;
  ejectedAt: string;
  lastSeenAt: string | null;
  lastNote: string | null;
  settledAt: string | null;
  outcome: EjectionOutcome | null;
  settleNote: string | null;
}

export type EjectionInput = Omit<
  Ejection,
  'id' | 'ejectedAt' | 'lastSeenAt' | 'lastNote' | 'settledAt' | 'outcome' | 'settleNote'
>;
