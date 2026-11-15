import type { PrApproval } from './world.js';

export type HumanTaskStatus = 'open' | 'done' | 'declined';

export type HumanTaskKind =
  'ask' | 'close_out' | 'burn' | 'validate' | 'supply' | 'watch' | 'watch_reading' | 'unwatched' | 'outcome';

export interface HumanTask {
  id: string;
  title: string;
  detail: string | null;
  originRef: string | null;
  partId: string | null;
  kind: HumanTaskKind;
  agentId: string | null;
  taskId: string | null;
  status: HumanTaskStatus;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  dismissedAt: string | null;
}

export type HumanTaskInput = Pick<HumanTask, 'title' | 'detail'>;

export type EscalationType = 'approve_change' | 'answer_question' | 'resolve_ambiguity' | 'review_reply';

export interface AgentAsk {
  question: string;
  kind?: string;
  options?: string[];
  detail?: string;
  questions?: AgentAskQuestion[];
}

export interface AgentAskQuestion {
  question: string;
  detail?: string;
  options?: string[];
}

type EscalationStatus = 'open' | 'answered' | 'dismissed';

export interface EscalationContext {
  taskTitle?: string;
  originRef?: string | null;
  recentOutput?: string;
  questions?: AgentAskQuestion[];
  prNumber?: number;
  commentId?: string | null;
  draft?: string;
  method?: string;
  prTitle?: string;
  approvals?: PrApproval[];
  autoMergeFailed?: boolean;
  planId?: string;
  issueNumber?: number;
  permission?: PermissionRequest;
  blocked?: GoalBlock;
  [key: string]: unknown;
}

/**
 * A goal an agent concluded `blocked`: parked for the operator, who releases it.
 * Carried on the escalation that asks them, which is the block's only record.
 * → docs/spec/06-issue-pickup.md#blocked-parks-the-goal-for-you
 */
export interface GoalBlock {
  originRef: string;
  reason: string;
  note: string;
  agentId: string;
}

interface PermissionRequest {
  toolName: string;
  summary: string;
}

export interface EscalationSpan {
  createdAt: string;
  answeredAt: string | null;
  originRef: string | null;
  prNumber: number | null;
  open: boolean;
}

export interface Escalation {
  id: string;
  type: EscalationType;
  status: EscalationStatus;
  prompt: string;
  context: EscalationContext;
  agentId: string | null;
  taskId: string | null;
  response: string | null;
  createdAt: string;
  answeredAt: string | null;
}
