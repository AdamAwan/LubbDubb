import type { WhitelistRule } from '../config/config.js';
import type {
  AgentAsk,
  AgentFlag,
  AgentStatus,
  AgentUsage,
  ExtraMcpServer,
  HumanTask,
  IssueConclusion,
  PlanPart,
  ScratchEntry,
  Task,
} from '../types.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { AssessmentVerdict } from '../mcp/assessment.js';
import type { GoalAppraisalVerdictName } from '../mcp/goalAppraisal.js';
import type { PrReviewPolicy } from '../review/policy.js';
import type { FileEventsSpool } from './fileEvents.js';
import type { WatchDryRunner } from '../environments/watchDryRun.js';
import type { SessionFactory } from './session.js';

// → docs/spec/10-agent-runtimes.md

interface McpChannel {
  open(extra?: readonly ExtraMcpServer[]): { token: string; configPath: string | null };
  bind(token: string, agentId: string): void;
  release(token: string): void;
}

export interface AgentManagerOptions {
  command: string;
  buildArgs: (opts: {
    sessionId: string;
    resume: boolean;
    mcpConfigPath: string | null;
    extraAllowedTools: string[];
    model: string | null;
    effort: string | null;
    permissionMode: string | null;
    sealed: boolean;
  }) => string[];
  goalProfile?: {
    effective: (issueOrigin: string) => string | null;
  };
  featureStanding?: (featureOrigin: string) => string | null;
  featureSequenceStanding?: (featureOrigin: string) => { key: string; members: number[] } | null;
  whitelistedApprovals: WhitelistRule[];
  reviewPolicy?: PrReviewPolicy;
  createSession: SessionFactory;
  initialInput?: (task: Task) => string | null;
  resumeInput?: () => string | null;
  promptDelayMs?: number;
  waitingPatterns?: string[];
  stallNudges?: number;
  stallParkMs?: number;
  stallExtendMs?: number;
  silenceParkMs?: number;
  resumable?: boolean;
  resumeAttempts?: number;
  fileEvents?: FileEventsSpool;
  docsFolderPrefix?: string | string[];
  mcp?: McpChannel;
  watch?: WatchDryRunner;
  errors?: ErrorRecorder;
}

export type TerminalBy = 'agent' | 'operator' | 'expiry';

export interface AgentManagerEvents {
  output: [{ agentId: string; delta: string }];
  waiting: [{ agentId: string; taskId: string; reason: string; ask?: AgentAsk }];
  autoAnswered: [{ agentId: string; taskId: string; reason: string; response: string }];
  done: [{ agentId: string; taskId: string; status: AgentStatus; by: TerminalBy }];
  reaped: [{ agentId: string; taskId: string; status: 'done' | 'failed' | 'killed' }];
  status: [{ agentId: string; taskId: string; status: AgentStatus }];
  usage: [{ agentId: string; taskId: string; usage: AgentUsage }];
  flag: [{ agentId: string; taskId: string; flag: AgentFlag }];
  humanTask: [{ agentId: string; taskId: string; humanTask: HumanTask; created: boolean }];
  progress: [{ agentId: string; taskId: string; note: string; notedAt: string }];
  conclusion: [{ agentId: string; taskId: string; conclusion: IssueConclusion }];
  assessment: [{ agentId: string; taskId: string; issueOrigin: string; verdict: AssessmentVerdict }];
  appraisal: [{ agentId: string; taskId: string; issueOrigin: string; verdict: GoalAppraisalVerdictName }];
  goalMet: [{ agentId: string; taskId: string; issueOrigin: string }];
  partOutcome: [{ agentId: string; taskId: string; part: PlanPart }];
  scratch: [{ agentId: string; taskId: string; entry: ScratchEntry }];
  retrospective: [{ agentId: string; taskId: string; issueOrigin: string }];
  remedy: [{ agentId: string; taskId: string; originRef: string }];
  files: [{ agentId: string; taskId: string }];
  resumed: [{ agentId: string; taskId: string; resumedAt: string }];
  limited: [{ agentId: string; taskId: string; reason: string; resetsAt: string | null }];
}

export interface AgentEmitter {
  emit<K extends keyof AgentManagerEvents>(event: K, ...args: AgentManagerEvents[K]): boolean;
}
