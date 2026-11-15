export type ProposalKind = 'reply_draft' | 'merge' | 'plan' | 'shortfall' | 'plan_amendment' | 'validation_plan';

type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'withdrawn';

export interface Proposal {
  id: string;
  kind: ProposalKind;
  ref: string;
  status: ProposalStatus;
  action: Action;
  note: string | null;
  decidedBy: 'human' | 'auto_send' | 'stack_landing' | null;
  decidedAt: string | null;
  escalationId: string | null;
  createdAt: string;
}

export type StackLandingStatus = 'standing' | 'landed' | 'stopped' | 'revoked';

export interface StackLanding {
  id: string;
  ref: string;
  rungs: number[];
  status: StackLandingStatus;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

type ActionType =
  | 'dispatch_code_agent'
  | 'dispatch_desk_agent'
  | 'escalate_to_human'
  | 'respond_to_agent'
  | 'reply_on_pr'
  | 'merge_pr'
  | 'propose_plan'
  | 'propose_plan_amendment'
  | 'propose_validation_plan'
  | 'propose_shortfall'
  | 'update_pr_branch'
  | 'requeue_ci_check'
  | 'set_work_item_state'
  | 'no_op';

export interface Action {
  type: ActionType;
  reason: string;
  rule?: string | null;
  admission?: string | null;
  [key: string]: unknown;
}

export type DecisionOutcome = 'executed' | 'deferred' | 'rejected' | 'skipped';

export interface Decision {
  id: string;
  cycleId: string;
  action: Action;
  outcome: DecisionOutcome;
  detail: string;
  rule: string | null;
  admission: string | null;
  createdAt: string;
}
