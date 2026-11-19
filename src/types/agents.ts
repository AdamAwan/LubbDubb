export type AgentStatus = 'starting' | 'running' | 'waiting' | 'done' | 'killed' | 'interrupted' | 'failed' | 'crashed';

export type ReadyingStep = 'picked-up' | 'ci-evidence' | 'slot-handover' | 'authorizing';

export interface ReadyingStepTiming {
  step: ReadyingStep;
  ms: number;
}

export interface ReadyingAction {
  id: string;
  cycleId: string;
  title: string;
  originRef: string | null;
  branch: string | null;
  step: ReadyingStep;
  startedAt: string;
  stepStartedAt: string;
  elapsed: ReadyingStepTiming[];
}

export interface Agent {
  id: string;
  taskId: string;
  status: AgentStatus;
  cwd: string;
  pid: number | null;
  waitingReason: string | null;
  sessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  numTurns: number | null;
  steps: number | null;
  note: string | null;
  notedAt: string | null;
  resumedAt: string | null;
  resumeAttempts: number;
}

/**
 * How far along a live agent is, as the harness measures it — never a claim the agent makes.
 * `count` is work items handled out of those there are; `stage` is which of a fixed run of stages
 * it has reached. → docs/spec/11-mcp-tools.md#progress-the-harness-measures
 */
export interface AgentProgress {
  agentId: string;
  kind: 'count' | 'stage';
  label: string;
  done: number;
  total: number;
}

export interface AgentFlag {
  id: string;
  agentId: string;
  kind: string;
  label: string;
  ref: string;
  createdAt: string;
}

export type AgentFlagInput = Pick<AgentFlag, 'kind' | 'label' | 'ref'>;

export interface AgentFile {
  id: string;
  agentId: string;
  path: string;
  tool: string | null;
  promoted: boolean;
  createdAt: string;
}

export type AgentFileInput = Pick<AgentFile, 'path' | 'tool' | 'promoted'>;
