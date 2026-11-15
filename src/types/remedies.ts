export type RemedyKind = 'ci' | 'review';

export type RemedyCause =
  | 'flake'
  | 'environment'
  | 'inherited'
  | 'stale_test'
  | 'missed_gate'
  | 'contract_drift'
  | 'missed_requirement'
  | 'convention'
  | 'approach'
  | 'scope'
  | 'docs'
  | 'clarity'
  | 'defect'
  | 'other';

export type RemedyGuard = 'local_check' | 'documented' | 'undocumented' | 'unpreventable';

export interface Remedy {
  id: string;
  kind: RemedyKind;
  originRef: string;
  prNumber: number;
  cause: RemedyCause;
  guard: RemedyGuard;
  summary: string;
  checks: string[];
  agentId: string;
  taskId: string;
  createdAt: string;
  updatedAt: string;
}

export type RemedyInput = Omit<Remedy, 'id' | 'createdAt' | 'updatedAt'>;
