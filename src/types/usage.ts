export interface AgentUsage {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  numTurns: number | null;
}

export interface UsageEvent {
  agentId: string;
  costUsd: number;
  at: string;
}

export interface IssueSpend {
  originRef: string;
  issueNumber: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  agents: number;
  localRuns: number;
}

export interface StallPark {
  agentId: string;
  expiresAt: string;
}

export interface RateLimitWindow {
  usedPercentage: number;
  resetsAt: string | null;
}

export interface AccountRateLimits {
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
  capturedAt: string;
}

export interface CostDelta {
  costUsd: number;
  at: string;
}
