import type { AgentUsage } from './usage.js';

export type LocalRunStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface LocalRun {
  id: string;
  originRef: string;
  ref: string;
  dir: string;
  commit: string | null;
  pid: number | null;
  status: LocalRunStatus;
  url: string | null;
  note: string | null;
  startedAt: string;
  endedAt: string | null;
  interruptedAt: string | null;
  lastSeenAt: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  numTurns: number | null;
}

export type LocalRunUsageDelta = AgentUsage;

export type LocalRunTurn = 'start' | 'stop' | 'refresh' | 'message';

export interface LocalRunPorts {
  checkedAt: string;
  declared: { url: string; host: string; port: number; answering: boolean } | null;
  listening: number[] | null;
}

export interface LocalRunFreshness {
  checkedAt: string;
  behindTip: number | null;
  base: { ref: string; behind: number | null } | null;
}

export interface LocalRunReadings {
  ports: LocalRunPorts | null;
  freshness: LocalRunFreshness | null;
}

export type LocalValidationStatus =
  'pending' | 'dispatched' | 'passed' | 'failed' | 'blocked' | 'skipped' | 'abandoned';

export type LocalValidationResult = Extract<LocalValidationStatus, 'passed' | 'failed' | 'blocked' | 'skipped'>;

export type LocalValidationRequester = 'operator' | 'auto';

export interface LocalValidationFinding {
  title: string;
  detail: string;
  severity: 'blocker' | 'defect' | 'nit';
  url: string | null;
  screenshot: string | null;
}

export type ValidationMediaKind = 'image' | 'video';

/**
 * What became of a settled run's video. `missing` is a browser that offered the recorder and a run
 * that wrote no video — on a machine without Playwright's ffmpeg, the usual cause.
 * → docs/spec/32-local-validation.md#the-recording
 */
export type RecordingStatus = 'kept' | 'not_offered' | 'missing';

export interface LocalValidation {
  id: string;
  originRef: string;
  runId: string;
  ref: string;
  commit: string | null;
  status: LocalValidationStatus;
  requestedBy: LocalValidationRequester;
  requestedAt: string;
  dispatchedAt: string | null;
  endedAt: string | null;
  taskId: string | null;
  fixTaskId: string | null;
  fixTicketRef: string | null;
  plan: string | null;
  summary: string | null;
  findings: LocalValidationFinding[];
  visited: string[];
  /** Every change the agent made to the environment's state to set its plan up. */
  setup: string[];
  screenshots: string[];
  note: string | null;
  /** Null until the agent reports, and on every row from before the column. */
  recordingStatus: RecordingStatus | null;
}
